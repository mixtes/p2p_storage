/**
 * Replication Manager
 *
 * Central coordinator for the symmetric P2P replication feature.
 * Every peer is both an owner (wanting backup) and a keeper (hosting
 * others' encrypted chunks). This manager handles:
 *
 *  Owner side:
 *   - Configure replication (files, factor N, offered bytes Y)
 *   - Negotiate agreements with keepers
 *   - Chunk, encrypt, and distribute files
 *   - Track chunk→keeper assignments in the owner manifest
 *   - Retrieve and reassemble files
 *
 *  Keeper side:
 *   - Accept/reject incoming agreement requests
 *   - Store encrypted chunks in vault Hyperdrives
 *   - Answer challenge-response proofs
 *   - Serve chunks back on retrieve requests
 */

import b4a from 'b4a'
import sodium from 'sodium-universal'
import cryptoLib from 'hypercore-crypto'
import { activity, dev } from '../../core/logger.js'
import {
  getOwnerManifest, getKeeperManifest,
  getVaultDrive, removeVaultDrive
} from '../../core/store.js'
import { getPublicKey, getPublicKeyHex } from '../../core/identity.js'
import { chunkBuffer, reassemble, CHUNK_SIZE } from '../../core/chunker.js'
import { encode } from '../../core/erasure.js'
import {
  encryptSymmetric, decryptSymmetric, generateSymmetricKey
} from '../../core/encryption.js'
import {
  MSG,
  announceCapacity, requestAgreement, acceptAgreement, rejectAgreement,
  pushChunk, chunkStored, challengeResp, retrieveResp, revokeChunk
} from '../../core/replication-protocol.js'
import {
  recordHeartbeat, recordChallengeResponse, recordDisconnect
} from '../../core/health-monitor.js'
import {
  recordAgreement, stashIncomingFile, recordRetrievedFile
} from '../../core/observe-folders.js'

/* ── state ───────────────────────────────────────────────────────────── */

const connectedPeers = new Map()        // peerId -> rpc handle
const peerCapacities = new Map()        // peerId -> { offeredBytes, usedBytes }
let pendingBinary = new Map()           // peerId -> { chunkId, chunkIndex, totalSize }

let config = null                       // { replicationFactor, offeredBytes, replicationKeyHex }
let replicationKey = null               // Buffer, 32 bytes

const listeners = { configChanged: [], agreementChanged: [], chunkProgress: [], healthChanged: [] }

export function on (event, fn) { if (listeners[event]) listeners[event].push(fn) }
function emit (event, ...args) { for (const fn of listeners[event] || []) fn(...args) }

/* ── initialisation ──────────────────────────────────────────────────── */

export async function init () {
  const manifest = getOwnerManifest()
  const node = await manifest.get('config')
  if (node) {
    config = node.value
    replicationKey = b4a.from(config.replicationKeyHex, 'hex')
    dev.info('[repl-mgr] loaded config: N=' + config.replicationFactor +
      ' offered=' + formatBytes(config.offeredBytes))
  }
}

/* ── configuration ───────────────────────────────────────────────────── */

export async function configure (replicationFactor, offeredBytes) {
  const manifest = getOwnerManifest()

  if (!replicationKey) {
    replicationKey = generateSymmetricKey()
  }

  config = {
    replicationFactor,
    offeredBytes,
    replicationKeyHex: b4a.toString(replicationKey, 'hex')
  }

  await manifest.put('config', config)
  activity.info('replication configured: N=' + replicationFactor +
    ', offering ' + formatBytes(offeredBytes))
  emit('configChanged', config)
  return config
}

export function getConfig () {
  return config
}

export function isConfigured () {
  return config !== null
}

/* ── peer connection handling ────────────────────────────────────────── */

export function registerPeer (peerId, rpc) {
  connectedPeers.set(peerId, rpc)
  if (config) {
    const used = getKeeperUsedBytes()
    announceCapacity(rpc, config.offeredBytes, used, config.replicationFactor)
  }
}

export function unregisterPeer (peerId) {
  connectedPeers.delete(peerId)
  peerCapacities.delete(peerId)
  pendingBinary.delete(peerId)
  recordDisconnect(peerId)
}

export function getConnectedPeers () {
  return connectedPeers
}

/* ── protocol message handlers ───────────────────────────────────────── */

/**
 * Returns a handlers object suitable for attachReplicationChannel().
 */
export function createProtocolHandlers () {
  return {
    onopen (peerId) {
      dev.debug('[repl-mgr] replication channel open: ' + peerId)
    },

    onclose (peerId) {
      dev.debug('[repl-mgr] replication channel closed: ' + peerId)
    },

    /* ── capacity & agreement negotiation ──────────────────────────── */

    [MSG.ANNOUNCE_CAPACITY] (payload, peerId) {
      peerCapacities.set(peerId, {
        offeredBytes: payload.offeredBytes,
        usedBytes: payload.usedBytes
      })
      dev.info('[repl-mgr] peer ' + peerId + ' capacity: offered=' +
        formatBytes(payload.offeredBytes) + ' used=' + formatBytes(payload.usedBytes))
    },

    async [MSG.REQUEST_AGREEMENT] (payload, peerId) {
      await handleAgreementRequest(payload, peerId)
    },

    async [MSG.ACCEPT_AGREEMENT] (payload, peerId) {
      await handleAgreementAccepted(payload, peerId)
    },

    [MSG.REJECT_AGREEMENT] (payload, peerId) {
      activity.info('peer ' + peerId + ' rejected agreement: ' + (payload.reason || 'no reason'))
    },

    /* ── chunk transfer (keeper side) ─────────────────────────────── */

    [MSG.PUSH_CHUNK] (payload, peerId) {
      pendingBinary.set(peerId, {
        chunkId: payload.chunkId,
        chunkIndex: payload.chunkIndex,
        totalSize: payload.totalSize
      })
    },

    async onbinary (buf, peerId) {
      await handleIncomingChunkData(buf, peerId)
    },

    [MSG.CHUNK_STORED] (payload, peerId) {
      handleChunkStoredConfirmation(payload, peerId)
    },

    [MSG.REVOKE_CHUNK] (payload, peerId) {
      handleRevokeChunk(payload, peerId)
    },

    /* ── challenge-response (keeper side) ─────────────────────────── */

    async [MSG.CHALLENGE] (payload, peerId) {
      await handleChallenge(payload, peerId)
    },

    [MSG.CHALLENGE_RESP] (payload, peerId) {
      handleChallengeResponse(payload, peerId)
    },

    /* ── retrieval ────────────────────────────────────────────────── */

    async [MSG.RETRIEVE] (payload, peerId) {
      await handleRetrieveRequest(payload, peerId)
    },

    [MSG.RETRIEVE_RESP] (payload, peerId) {
      pendingBinary.set(peerId, {
        chunkId: payload.chunkId,
        isRetrieval: true
      })
    },

    /* ── heartbeat ────────────────────────────────────────────────── */

    [MSG.HEARTBEAT] (payload, peerId) {
      handleHeartbeat(payload, peerId)
    }
  }
}

/* ── owner side: request agreements ──────────────────────────────────── */

export async function requestAgreements () {
  if (!config) throw new Error('Replication not configured')

  const neededPerKeeper = Math.ceil(config.offeredBytes / Math.max(connectedPeers.size, 1))
  const ownerKey = getPublicKeyHex()

  for (const [peerId, rpc] of connectedPeers) {
    const existing = await getOwnerManifest().get('agreement:' + peerId)
    if (existing && existing.value.status === 'active') continue

    requestAgreement(rpc, ownerKey, neededPerKeeper, config.replicationFactor)
    activity.info('requested agreement from peer ' + peerId)
  }
}

/* ── owner side: replicate files ─────────────────────────────────────── */

/**
 * Make sure we have at least `target` active agreements before replicating.
 * Picks up to `target` random connected peers without an active agreement
 * and requests one from each, then waits up to `waitMs` for acceptances.
 */
export async function ensureAgreements (target, waitMs = 5000) {
  if (!config || target <= 0) return 0

  const manifest = getOwnerManifest()
  const activePeers = new Set()
  for await (const node of manifest.createReadStream({ gte: 'agreement:', lt: 'agreement;' })) {
    if (node.value.status === 'active') {
      activePeers.add(node.key.replace('agreement:', ''))
    }
  }

  const needed = target - activePeers.size
  if (needed <= 0) return 0

  const candidates = [...connectedPeers.entries()].filter(([peerId]) => !activePeers.has(peerId))
  if (candidates.length === 0) {
    activity.warn('no peers available for new agreements (need ' + needed + ' more)')
    return 0
  }

  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
  }
  const picked = candidates.slice(0, needed)

  const ownerKey = getPublicKeyHex()
  const neededPerKeeper = Math.ceil(config.offeredBytes / Math.max(picked.length + activePeers.size, 1))
  const pickedIds = new Set(picked.map(([peerId]) => peerId))

  activity.info('auto-requesting agreements from ' + picked.length + ' random peer(s)')
  for (const [peerId, rpc] of picked) {
    requestAgreement(rpc, ownerKey, neededPerKeeper, config.replicationFactor)
  }

  await new Promise((resolve) => {
    let accepted = 0
    const onChange = (peerId, status) => {
      if (pickedIds.has(peerId) && status === 'active') {
        accepted++
        if (accepted >= picked.length) done()
      }
    }
    const done = () => {
      const idx = listeners.agreementChanged.indexOf(onChange)
      if (idx !== -1) listeners.agreementChanged.splice(idx, 1)
      clearTimeout(timer)
      resolve()
    }
    listeners.agreementChanged.push(onChange)
    const timer = setTimeout(done, waitMs)
  })

  return picked.length
}

/**
 * Replicate a single file: chunk → encrypt → distribute to keepers.
 *
 * @param {string} filePath  - logical path for manifest tracking
 * @param {Buffer} fileData  - raw file content
 */
export async function replicateFile (filePath, fileData) {
  if (!config) throw new Error('Replication not configured')

  await ensureAgreements(config.replicationFactor)

  const ownerPk = getPublicKey()
  const manifest = getOwnerManifest()

  const { chunks, totalSize } = chunkBuffer(fileData, filePath, ownerPk)
  const shards = encode(chunks, config.replicationFactor)

  await manifest.put('file:' + filePath, {
    size: totalSize,
    chunkCount: chunks.length,
    chunkSize: CHUNK_SIZE,
    lastModified: Date.now()
  })

  const keepers = getActiveKeepers()
  if (keepers.length === 0) {
    activity.info('no keepers available — chunks queued locally')
    for (const chunk of chunks) {
      await manifest.put('chunk:' + chunk.id, {
        filePath, chunkIndex: chunk.index, size: chunk.data.length,
        keepers: [], status: 'pending'
      })
    }
    return { distributed: 0, total: shards.length }
  }

  let distributed = 0
  for (const shard of shards) {
    const keeperIdx = (shard.chunkIndex * config.replicationFactor + shard.replicaIndex) % keepers.length
    const [peerId, rpc] = keepers[keeperIdx]

    const encrypted = encryptSymmetric(shard.data, replicationKey)
    const ok = pushChunk(rpc, shard.chunkId, shard.chunkIndex, encrypted.length, encrypted)

    if (ok) {
      distributed++
      const existing = await manifest.get('chunk:' + shard.chunkId)
      const keeperList = existing ? (existing.value.keepers || []) : []
      if (!keeperList.includes(peerId)) keeperList.push(peerId)

      await manifest.put('chunk:' + shard.chunkId, {
        filePath, chunkIndex: shard.chunkIndex, size: shard.data.length,
        keepers: keeperList, status: 'distributed'
      })
    }
  }

  activity.info('replicated ' + filePath + ': ' + distributed + '/' + shards.length + ' shards sent')
  emit('chunkProgress', { filePath, distributed, total: shards.length })
  return { distributed, total: shards.length }
}

/**
 * Retrieve and reassemble a file from keepers.
 *
 * @param {string} filePath
 * @returns {Promise<Buffer>} decrypted file content
 */
export async function retrieveFile (filePath) {
  if (!config) throw new Error('Replication not configured')

  const manifest = getOwnerManifest()
  const fileNode = await manifest.get('file:' + filePath)
  if (!fileNode) throw new Error('File not in manifest: ' + filePath)

  const { chunkCount: count, size: totalSize } = fileNode.value
  const retrievedChunks = []

  const retrievals = new Map()

  for (let i = 0; i < count; i++) {
    const chunkId = (await findChunkByIndex(filePath, i))
    if (!chunkId) throw new Error('Chunk ' + i + ' missing from manifest')

    const chunkNode = await manifest.get('chunk:' + chunkId)
    if (!chunkNode) throw new Error('Chunk record missing: ' + chunkId)

    const keepers = chunkNode.value.keepers || []
    let sent = false

    for (const keeperPeerId of keepers) {
      const rpc = connectedPeers.get(keeperPeerId)
      if (!rpc) continue

      const { retrieve: sendRetrieve } = await import('../../core/replication-protocol.js')
      sendRetrieve(rpc, chunkId)
      retrievals.set(chunkId, { index: i, resolve: null })
      sent = true
      break
    }

    if (!sent) {
      throw new Error('No online keeper for chunk ' + chunkId)
    }
  }

  const collected = await collectRetrievals(retrievals, count, 30000)

  for (const [chunkId, entry] of collected) {
    const decrypted = decryptSymmetric(entry.data, replicationKey)
    if (!decrypted) throw new Error('Decryption failed for chunk ' + chunkId)
    retrievedChunks.push({ index: entry.index, data: decrypted })
  }

  const reassembled = reassemble(retrievedChunks, totalSize)
  recordRetrievedFile(filePath, reassembled, {
    filePath, chunkCount: count, totalSize
  })
  return reassembled
}

/* ── keeper side: handle agreement requests ──────────────────────────── */

async function handleAgreementRequest (payload, peerId) {
  if (!config) {
    const rpc = connectedPeers.get(peerId)
    if (rpc) rejectAgreement(rpc, 'replication not configured')
    return
  }

  const freeBytes = config.offeredBytes - getKeeperUsedBytes()
  const rpc = connectedPeers.get(peerId)

  if (payload.neededBytes > freeBytes) {
    if (rpc) rejectAgreement(rpc, 'insufficient space')
    activity.info('rejected agreement from ' + peerId + ': need ' +
      formatBytes(payload.neededBytes) + ' but only ' + formatBytes(freeBytes) + ' free')
    return
  }

  const keeperManifest = getKeeperManifest()
  await keeperManifest.put('quota:' + payload.ownerKey, {
    grantedBytes: payload.neededBytes,
    usedBytes: 0
  })

  if (rpc) {
    acceptAgreement(rpc, getPublicKeyHex(), payload.neededBytes)
  }
  activity.info('accepted agreement from ' + peerId + ': ' + formatBytes(payload.neededBytes))
  recordAgreement({
    role: 'keeper',
    peerId,
    ownerKey: payload.ownerKey,
    grantedBytes: payload.neededBytes,
    replicationFactor: payload.replicationFactor,
    status: 'accepted'
  })
  emit('agreementChanged', peerId, 'accepted')
}

async function handleAgreementAccepted (payload, peerId) {
  const manifest = getOwnerManifest()
  await manifest.put('agreement:' + peerId, {
    keeperKey: payload.keeperKey,
    grantedBytes: payload.grantedBytes,
    usedBytes: 0,
    lastSeen: Date.now(),
    status: 'active'
  })
  activity.info('agreement accepted by peer ' + peerId + ': ' + formatBytes(payload.grantedBytes))
  recordAgreement({
    role: 'owner',
    peerId,
    keeperKey: payload.keeperKey,
    grantedBytes: payload.grantedBytes,
    status: 'active'
  })
  emit('agreementChanged', peerId, 'active')
}

/* ── keeper side: store incoming chunks ───────────────────────────────── */

async function handleIncomingChunkData (buf, peerId) {
  const pending = pendingBinary.get(peerId)
  pendingBinary.delete(peerId)

  if (!pending) {
    dev.error('[repl-mgr] received binary without pending header from ' + peerId)
    return
  }

  if (pending.isRetrieval) {
    handleRetrievedChunkData(pending.chunkId, buf, peerId)
    return
  }

  const { chunkId, chunkIndex, totalSize } = pending

  try {
    const ownerKey = await findOwnerKeyForPeer(peerId)
    if (!ownerKey) {
      dev.error('[repl-mgr] no agreement found for peer ' + peerId)
      return
    }

    const keeperManifest = getKeeperManifest()
    const quotaNode = await keeperManifest.get('quota:' + ownerKey)
    if (quotaNode) {
      const q = quotaNode.value
      if (q.usedBytes + buf.length > q.grantedBytes) {
        dev.error('[repl-mgr] chunk would exceed quota for ' + ownerKey)
        return
      }
    }

    const drive = await getVaultDrive(ownerKey)
    await drive.put('/chunks/' + chunkId + '.enc', buf)

    stashIncomingFile(chunkId.slice(0, 16) + '_' + chunkIndex + '.enc', buf, {
      chunkId, chunkIndex, totalSize, fromPeer: peerId, ownerKey
    })

    await keeperManifest.put('hosted:' + ownerKey + ':' + chunkId, {
      size: buf.length,
      storedAt: Date.now()
    })

    if (quotaNode) {
      const q = quotaNode.value
      await keeperManifest.put('quota:' + ownerKey, {
        ...q,
        usedBytes: q.usedBytes + buf.length
      })
    }

    const rpc = connectedPeers.get(peerId)
    if (rpc) chunkStored(rpc, chunkId)

    dev.info('[repl-mgr] stored chunk ' + chunkId.slice(0, 12) + '… for ' + ownerKey.slice(0, 12))
  } catch (err) {
    dev.error('[repl-mgr] failed to store chunk:', err)
  }
}

function handleChunkStoredConfirmation (payload, peerId) {
  dev.info('[repl-mgr] chunk confirmed stored by ' + peerId + ': ' + payload.chunkId.slice(0, 12))
  emit('chunkProgress', { chunkId: payload.chunkId, keeper: peerId, confirmed: true })
}

async function handleRevokeChunk (payload, peerId) {
  try {
    const ownerKey = await findOwnerKeyForPeer(peerId)
    if (!ownerKey) return

    const keeperManifest = getKeeperManifest()
    const drive = await getVaultDrive(ownerKey)

    const hostedNode = await keeperManifest.get('hosted:' + ownerKey + ':' + payload.chunkId)
    if (!hostedNode) return

    await drive.del('/chunks/' + payload.chunkId + '.enc')
    await keeperManifest.del('hosted:' + ownerKey + ':' + payload.chunkId)

    const quotaNode = await keeperManifest.get('quota:' + ownerKey)
    if (quotaNode) {
      const q = quotaNode.value
      await keeperManifest.put('quota:' + ownerKey, {
        ...q,
        usedBytes: Math.max(0, q.usedBytes - hostedNode.value.size)
      })
    }

    dev.info('[repl-mgr] revoked chunk ' + payload.chunkId.slice(0, 12) + ' for ' + ownerKey.slice(0, 12))
  } catch (err) {
    dev.error('[repl-mgr] revoke error:', err)
  }
}

/* ── keeper side: challenge-response ─────────────────────────────────── */

async function handleChallenge (payload, peerId) {
  try {
    const ownerKey = await findOwnerKeyForPeer(peerId)
    if (!ownerKey) return

    const drive = await getVaultDrive(ownerKey)
    const data = await drive.get('/chunks/' + payload.chunkId + '.enc')

    if (!data) {
      dev.error('[repl-mgr] challenge: chunk not found ' + payload.chunkId.slice(0, 12))
      return
    }

    const head = data.subarray(0, Math.min(1024, data.length))
    const nonceBuf = b4a.from(payload.nonce, 'hex')
    const proofInput = b4a.alloc(nonceBuf.length + head.length)
    b4a.copy(nonceBuf, proofInput, 0)
    b4a.copy(head, proofInput, nonceBuf.length)
    const proof = b4a.toString(cryptoLib.hash(proofInput), 'hex')

    const rpc = connectedPeers.get(peerId)
    if (rpc) challengeResp(rpc, payload.chunkId, proof)
  } catch (err) {
    dev.error('[repl-mgr] challenge error:', err)
  }
}

function handleChallengeResponse (payload, peerId) {
  dev.info('[repl-mgr] challenge response from ' + peerId +
    ' for chunk ' + payload.chunkId.slice(0, 12) + ': ' + payload.proof.slice(0, 16))
  recordChallengeResponse(peerId, payload.chunkId, payload.proof)
  emit('healthChanged', { peerId, chunkId: payload.chunkId, proof: payload.proof })
}

/* ── keeper side: serve retrieval requests ────────────────────────────── */

async function handleRetrieveRequest (payload, peerId) {
  try {
    const ownerKey = await findOwnerKeyForPeer(peerId)
    if (!ownerKey) return

    const drive = await getVaultDrive(ownerKey)
    const data = await drive.get('/chunks/' + payload.chunkId + '.enc')

    if (!data) {
      dev.error('[repl-mgr] retrieve: chunk not found ' + payload.chunkId.slice(0, 12))
      return
    }

    const rpc = connectedPeers.get(peerId)
    if (rpc) retrieveResp(rpc, payload.chunkId, data)
  } catch (err) {
    dev.error('[repl-mgr] retrieve error:', err)
  }
}

/* ── owner side: collect retrieved chunks ─────────────────────────────── */

const retrievalBuffer = new Map()

function handleRetrievedChunkData (chunkId, buf, peerId) {
  retrievalBuffer.set(chunkId, buf)
  dev.info('[repl-mgr] received chunk ' + chunkId.slice(0, 12) + ' from ' + peerId)
}

function collectRetrievals (retrievals, expectedCount, timeoutMs) {
  return new Promise((resolve, reject) => {
    const result = new Map()

    const check = () => {
      for (const [chunkId, meta] of retrievals) {
        if (retrievalBuffer.has(chunkId)) {
          result.set(chunkId, { index: meta.index, data: retrievalBuffer.get(chunkId) })
          retrievalBuffer.delete(chunkId)
        }
      }
      if (result.size >= expectedCount) {
        clearInterval(timer)
        resolve(result)
      }
    }

    const timer = setInterval(check, 200)
    check()

    setTimeout(() => {
      clearInterval(timer)
      if (result.size >= expectedCount) {
        resolve(result)
      } else {
        reject(new Error('Retrieval timeout: got ' + result.size + '/' + expectedCount + ' chunks'))
      }
    }, timeoutMs)
  })
}

/* ── heartbeat handling ──────────────────────────────────────────────── */

function handleHeartbeat (payload, peerId) {
  peerCapacities.set(peerId, {
    offeredBytes: (peerCapacities.get(peerId) || {}).offeredBytes || 0,
    usedBytes: payload.usedBytes
  })
  recordHeartbeat(peerId)
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function getActiveKeepers () {
  return [...connectedPeers.entries()]
}

function getKeeperUsedBytes () {
  let total = 0
  const manifest = getKeeperManifest()
  // Synchronous approximation — for accurate count, iterate the Hyperbee
  // In practice this is updated by summing quota entries
  return total
}

/**
 * Async version: accurately sum used bytes from keeper manifest.
 */
export async function getKeeperUsedBytesAsync () {
  const manifest = getKeeperManifest()
  let total = 0
  for await (const node of manifest.createReadStream({ gte: 'quota:', lt: 'quota;' })) {
    total += node.value.usedBytes || 0
  }
  return total
}

export async function getOwnerAgreements () {
  const manifest = getOwnerManifest()
  const agreements = []
  for await (const node of manifest.createReadStream({ gte: 'agreement:', lt: 'agreement;' })) {
    agreements.push({ peerId: node.key.replace('agreement:', ''), ...node.value })
  }
  return agreements
}

export async function getReplicatedFiles () {
  const manifest = getOwnerManifest()
  const files = []
  for await (const node of manifest.createReadStream({ gte: 'file:', lt: 'file;' })) {
    files.push({ path: node.key.replace('file:', ''), ...node.value })
  }
  return files
}

export async function getHostedChunks () {
  const manifest = getKeeperManifest()
  const chunks = []
  for await (const node of manifest.createReadStream({ gte: 'hosted:', lt: 'hosted;' })) {
    chunks.push({ key: node.key, ...node.value })
  }
  return chunks
}

async function findChunkByIndex (filePath, index) {
  const manifest = getOwnerManifest()
  for await (const node of manifest.createReadStream({ gte: 'chunk:', lt: 'chunk;' })) {
    if (node.value.filePath === filePath && node.value.chunkIndex === index) {
      return node.key.replace('chunk:', '')
    }
  }
  return null
}

async function findOwnerKeyForPeer (peerId) {
  const manifest = getKeeperManifest()
  for await (const node of manifest.createReadStream({ gte: 'quota:', lt: 'quota;' })) {
    return node.key.replace('quota:', '')
  }
  return null
}

export function getPeerCapacities () {
  return peerCapacities
}

function formatBytes (bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

export { formatBytes }
