/* global Pear */
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import { dev } from './logger.js'

let store = null
let localDrive = null
let ownerManifest = null
let keeperManifest = null

const vaultDrives = new Map()

export async function init () {
  // Pear.config is deprecated in Pear 2.x; Pear.app is the canonical source
  // of the per-app storage path. Fall back to Pear.config for older runtimes.
  const teardown = Pear.teardown
  const storagePath = Pear?.app?.storage ?? Pear?.config?.storage

  dev.debug('[store] Pear.app.storage=' + JSON.stringify(Pear?.app?.storage) +
    ' Pear.config.storage=' + JSON.stringify(Pear?.config?.storage))

  if (!storagePath) {
    throw new Error('Pear storage path is unavailable (Pear.app.storage and Pear.config.storage are both empty)')
  }

  // IMPORTANT: do NOT pass `Pear.app.storage` directly to Corestore.
  // hypercore-storage has a startup migration (`tmpFixStorage`) that treats
  // anything at the storage root as legacy data and relocates it under `db/`.
  // If we share the root with other subsystems (friend-storage's Localdrive,
  // etc.), the migration races those directories and crashes with EPERM on
  // Windows once `db/<name>` already exists from a previous run. Give Corestore
  // its own subdirectory so it owns the layout exclusively.
  const corestorePath = String(storagePath).replace(/[/\\]+$/, '') + '/corestore'

  store = new Corestore(corestorePath)

  // Corestore uses exclusive file locks on its storage dir. If another Pear
  // instance is already running against the same Pear.app.storage, ready()
  // will hang forever and the user just sees an empty drive-key field with no
  // error. Race a timeout so we surface a clear, actionable message.
  await Promise.race([
    store.ready(),
    new Promise((_, reject) => setTimeout(() => reject(new Error(
      'Corestore did not become ready within 10s for storage path "' + corestorePath +
      '". Another instance is likely already running against the same storage. ' +
      'For a second peer on this machine use `pear run -t .` (fresh tmp storage) ' +
      'or `pear run -s <other-path> .` (note: the flag is `-s`/`--storage`, not `--store`).'
    )), 10_000))
  ])

  localDrive = new Hyperdrive(store.namespace('local'))
  await localDrive.ready()

  dev.debug('[store] localDrive ready: key=' +
    (localDrive.key ? b4a.toString(localDrive.key, 'hex').slice(0, 16) + '…' : '(null)') +
    ' writable=' + localDrive.writable +
    ' coreKey=' + (localDrive.core?.key ? 'present' : '(null)'))

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
  if (!localDrive) throw new Error('local drive not initialised — call store.init() first')
  if (!localDrive.key) throw new Error('local drive key not ready (drive not yet ready or no writable core)')
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
