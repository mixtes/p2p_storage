/* global Pear */
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'

let store = null
let localDrive = null
let ownerManifest = null
let keeperManifest = null

const vaultDrives = new Map()

export async function init () {
  const { config, teardown } = Pear

  store = new Corestore(config.storage)
  await store.ready()

  localDrive = new Hyperdrive(store.namespace('local'))
  await localDrive.ready()

  const ownerCore = store.get({ name: 'replication-manifest' })
  ownerManifest = new Hyperbee(ownerCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await ownerManifest.ready()

  const keeperCore = store.get({ name: 'keeper-manifest' })
  keeperManifest = new Hyperbee(keeperCore, {
    keyEncoding: 'utf-8',
    valueEncoding: 'json'
  })
  await keeperManifest.ready()

  teardown(async () => {
    for (const drive of vaultDrives.values()) {
      try { await drive.close() } catch {}
    }
    vaultDrives.clear()
    try { await localDrive.close() } catch {}
    try { await store.close() } catch {}
  })

  return { store, localDrive }
}

export function getStore () {
  return store
}

export function getLocalDrive () {
  return localDrive
}

export function getLocalKeyHex () {
  return b4a.toString(localDrive.key, 'hex')
}

/* ── replication manifests ───────────────────────────────────────────── */

/**
 * Owner manifest: tracks this peer's replicated files, chunks, and
 * agreements with keepers. Keys:
 *   config              -> { replicationFactor, offeredBytes, replicationKeyHex }
 *   file:<path>         -> { size, chunkCount, chunkSize, lastModified }
 *   chunk:<chunkId>     -> { filePath, chunkIndex, size, keepers: [...], status }
 *   agreement:<peerHex> -> { grantedBytes, usedBytes, lastSeen, status }
 */
export function getOwnerManifest () {
  return ownerManifest
}

/**
 * Keeper manifest: tracks encrypted chunks this peer stores for others.
 *   hosted:<ownerHex>:<chunkId> -> { size, storedAt }
 *   quota:<ownerHex>            -> { grantedBytes, usedBytes }
 */
export function getKeeperManifest () {
  return keeperManifest
}

/* ── vault drives (one per hosted owner) ─────────────────────────────── */

/**
 * Get or create a namespaced Hyperdrive for storing a specific owner's
 * encrypted chunks. The drive lives inside the Corestore and is fully
 * automatic — no user-visible folder.
 */
export async function getVaultDrive (ownerKeyHex) {
  if (vaultDrives.has(ownerKeyHex)) return vaultDrives.get(ownerKeyHex)

  const ns = store.namespace('vault-' + ownerKeyHex)
  const drive = new Hyperdrive(ns)
  await drive.ready()
  vaultDrives.set(ownerKeyHex, drive)
  return drive
}

/**
 * Close and remove a vault drive (called when an agreement is revoked).
 */
export async function removeVaultDrive (ownerKeyHex) {
  const drive = vaultDrives.get(ownerKeyHex)
  if (!drive) return
  try { await drive.close() } catch {}
  vaultDrives.delete(ownerKeyHex)
}
