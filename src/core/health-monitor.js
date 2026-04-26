/**
 * Health Monitor
 *
 * Runs two periodic loops on the owner side:
 *
 *  1. Heartbeat (every 60s): sends HEARTBEAT to all connected peers,
 *     updates lastSeen timestamps, detects offline keepers.
 *
 *  2. Challenge (every 5 min): picks a random chunk assigned to a keeper,
 *     sends CHALLENGE { chunkId, nonce }, expects CHALLENGE_RESP with
 *     hash(nonce || first_1KB_of_chunk). Verifies proof locally using
 *     the owner's encrypted copy knowledge.
 *
 * When a keeper is offline longer than the degradation threshold, the
 * monitor marks affected chunks as degraded and emits an event so the
 * manager can re-replicate to another peer.
 */

import b4a from 'b4a'
import cryptoLib from 'hypercore-crypto'
import { dev, activity } from './logger.js'
import { getOwnerManifest } from './store.js'
import {
  heartbeat as sendHeartbeat,
  challenge as sendChallenge
} from './replication-protocol.js'

/* ── configuration ───────────────────────────────────────────────────── */

const HEARTBEAT_INTERVAL = 60 * 1000          // 60 seconds
const CHALLENGE_INTERVAL = 5 * 60 * 1000      // 5 minutes
const OFFLINE_THRESHOLD = 30 * 60 * 1000       // 30 minutes → degraded

/* ── state ───────────────────────────────────────────────────────────── */

let heartbeatTimer = null
let challengeTimer = null
let running = false

const keeperHealth = new Map()

/**
 * Per-keeper health record:
 *   {
 *     lastSeen: number,        // timestamp of last heartbeat or proof
 *     lastChallenge: number,   // timestamp of last challenge sent
 *     lastProof: string|null,  // last received proof hex
 *     status: 'online'|'degraded'|'offline',
 *     failedChallenges: number
 *   }
 */

let getConnectedPeersFn = null
let getKeeperUsedBytesFn = null
let offeredBytesFn = null

const listeners = { degraded: [], recovered: [], statusUpdate: [] }

export function on (event, fn) { if (listeners[event]) listeners[event].push(fn) }
function emit (event, ...args) { for (const fn of listeners[event] || []) fn(...args) }

/* ── lifecycle ───────────────────────────────────────────────────────── */

/**
 * Start the health monitor loops.
 *
 * @param {object} opts
 * @param {Function} opts.getConnectedPeers - () => Map<peerId, rpc>
 * @param {Function} opts.getKeeperUsedBytes - async () => number
 * @param {Function} opts.getOfferedBytes - () => number
 */
export function start (opts) {
  if (running) return

  getConnectedPeersFn = opts.getConnectedPeers
  getKeeperUsedBytesFn = opts.getKeeperUsedBytes
  offeredBytesFn = opts.getOfferedBytes

  heartbeatTimer = setInterval(heartbeatLoop, HEARTBEAT_INTERVAL)
  challengeTimer = setInterval(challengeLoop, CHALLENGE_INTERVAL)
  running = true

  dev.info('[health] monitor started (heartbeat=' + (HEARTBEAT_INTERVAL / 1000) +
    's, challenge=' + (CHALLENGE_INTERVAL / 1000) + 's)')
}

export function stop () {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  if (challengeTimer) clearInterval(challengeTimer)
  heartbeatTimer = null
  challengeTimer = null
  running = false
  dev.info('[health] monitor stopped')
}

export function isRunning () {
  return running
}

/* ── heartbeat loop ──────────────────────────────────────────────────── */

async function heartbeatLoop () {
  if (!getConnectedPeersFn) return
  const peers = getConnectedPeersFn()
  const usedBytes = getKeeperUsedBytesFn ? await getKeeperUsedBytesFn() : 0
  const offered = offeredBytesFn ? offeredBytesFn() : 0
  const freeBytes = Math.max(0, offered - usedBytes)

  for (const [peerId, rpc] of peers) {
    sendHeartbeat(rpc, usedBytes, freeBytes)
  }

  checkForDegradedKeepers()
}

/* ── challenge loop ──────────────────────────────────────────────────── */

async function challengeLoop () {
  if (!getConnectedPeersFn) return
  const peers = getConnectedPeersFn()
  if (peers.size === 0) return

  const manifest = getOwnerManifest()
  if (!manifest) return

  const chunks = []
  for await (const node of manifest.createReadStream({ gte: 'chunk:', lt: 'chunk;' })) {
    if (node.value.status === 'distributed' && node.value.keepers.length > 0) {
      chunks.push({ chunkId: node.key.replace('chunk:', ''), ...node.value })
    }
  }

  if (chunks.length === 0) return

  const picked = chunks[Math.floor(Math.random() * chunks.length)]
  const keeper = picked.keepers[Math.floor(Math.random() * picked.keepers.length)]
  const rpc = peers.get(keeper)

  if (!rpc) {
    dev.debug('[health] keeper ' + keeper + ' offline, skipping challenge')
    return
  }

  const nonce = b4a.toString(cryptoLib.randomBytes(16), 'hex')

  sendChallenge(rpc, picked.chunkId, nonce)

  const health = ensureHealth(keeper)
  health.lastChallenge = Date.now()
  health.pendingNonce = nonce
  health.pendingChunkId = picked.chunkId

  dev.debug('[health] challenged ' + keeper + ' for chunk ' + picked.chunkId.slice(0, 12))
}

/* ── incoming data handlers (called from manager) ────────────────────── */

/**
 * Call when a HEARTBEAT is received from a peer.
 */
export function recordHeartbeat (peerId) {
  const health = ensureHealth(peerId)
  const wasDegraded = health.status === 'degraded' || health.status === 'offline'
  health.lastSeen = Date.now()
  health.status = 'online'

  if (wasDegraded) {
    activity.info('keeper recovered: ' + peerId)
    emit('recovered', peerId)
  }
  emit('statusUpdate', peerId, health)
}

/**
 * Call when a CHALLENGE_RESP is received from a keeper.
 */
export function recordChallengeResponse (peerId, chunkId, proof) {
  const health = ensureHealth(peerId)
  health.lastSeen = Date.now()
  health.lastProof = proof
  health.status = 'online'
  health.failedChallenges = 0

  dev.info('[health] proof-of-storage OK from ' + peerId + ' chunk=' + chunkId.slice(0, 12))
  emit('statusUpdate', peerId, health)
}

/**
 * Call when a peer connection closes.
 */
export function recordDisconnect (peerId) {
  const health = ensureHealth(peerId)
  health.status = 'offline'
  emit('statusUpdate', peerId, health)
}

/* ── degradation detection ───────────────────────────────────────────── */

function checkForDegradedKeepers () {
  const now = Date.now()

  for (const [peerId, health] of keeperHealth) {
    if (health.status === 'online' && (now - health.lastSeen) > OFFLINE_THRESHOLD) {
      health.status = 'degraded'
      activity.info('keeper degraded (offline ' +
        Math.round((now - health.lastSeen) / 60000) + ' min): ' + peerId)
      emit('degraded', peerId)
    }
  }
}

/* ── queries ─────────────────────────────────────────────────────────── */

export function getKeeperHealth (peerId) {
  return keeperHealth.get(peerId) || null
}

export function getAllHealth () {
  return new Map(keeperHealth)
}

/**
 * Summary for UI: counts by status.
 */
export function getHealthSummary () {
  let online = 0
  let degraded = 0
  let offline = 0

  for (const health of keeperHealth.values()) {
    if (health.status === 'online') online++
    else if (health.status === 'degraded') degraded++
    else offline++
  }

  return { online, degraded, offline, total: keeperHealth.size }
}

/**
 * Get chunk-level health: for each replicated file, how many chunks
 * have all N keepers online vs degraded.
 */
export async function getChunkHealth () {
  const manifest = getOwnerManifest()
  if (!manifest) return []

  const results = []

  for await (const node of manifest.createReadStream({ gte: 'chunk:', lt: 'chunk;' })) {
    const chunk = node.value
    const chunkId = node.key.replace('chunk:', '')

    let onlineKeepers = 0
    let totalKeepers = (chunk.keepers || []).length

    for (const keeper of chunk.keepers || []) {
      const health = keeperHealth.get(keeper)
      if (health && health.status === 'online') onlineKeepers++
    }

    let status = 'healthy'
    if (totalKeepers === 0) status = 'pending'
    else if (onlineKeepers === 0) status = 'lost'
    else if (onlineKeepers < totalKeepers) status = 'degraded'

    results.push({
      chunkId,
      filePath: chunk.filePath,
      chunkIndex: chunk.chunkIndex,
      onlineKeepers,
      totalKeepers,
      status
    })
  }

  return results
}

/**
 * File-level health aggregation for UI display.
 */
export async function getFileHealth () {
  const chunkHealth = await getChunkHealth()
  const files = new Map()

  for (const ch of chunkHealth) {
    if (!files.has(ch.filePath)) {
      files.set(ch.filePath, { totalChunks: 0, healthy: 0, degraded: 0, lost: 0, pending: 0 })
    }
    const f = files.get(ch.filePath)
    f.totalChunks++
    if (ch.status === 'healthy') f.healthy++
    else if (ch.status === 'degraded') f.degraded++
    else if (ch.status === 'pending') f.pending++
    else f.lost++
  }

  const result = []
  for (const [path, counts] of files) {
    let status = 'healthy'
    if (counts.pending > 0 && counts.healthy === 0) status = 'pending'
    else if (counts.lost > 0) status = 'critical'
    else if (counts.degraded > 0) status = 'degraded'
    else if (counts.pending > 0) status = 'partial'
    result.push({ path, ...counts, status })
  }

  return result
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function ensureHealth (peerId) {
  if (!keeperHealth.has(peerId)) {
    keeperHealth.set(peerId, {
      lastSeen: Date.now(),
      lastChallenge: 0,
      lastProof: null,
      status: 'online',
      failedChallenges: 0,
      pendingNonce: null,
      pendingChunkId: null
    })
  }
  return keeperHealth.get(peerId)
}
