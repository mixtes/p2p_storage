import b4a from 'b4a'
import sodium from 'sodium-universal'
import { activity, dev } from '../../core/logger.js'
import { getFriendStorageManifest, getVaultDrive } from '../../core/store.js'
import { getPublicKey, getPublicKeyHex } from '../../core/identity.js'
import { chunkBuffer, reassemble, CHUNK_SIZE } from '../../core/chunker.js'
import { encryptSymmetric, decryptSymmetric, generateSymmetricKey } from '../../core/encryption.js'
import {
  fsPushFile, fsFileAck, fsRetrieveFile, fsRetrieveFileResp
} from '../../core/replication-protocol.js'
import {
  getConnectedPeers, setFriendStorageHandlers
} from '../replication/manager.js'
import { recordRentFile } from '../../core/observe-folders.js'

const ackBuffer = new Map()       // `${fileId}:${chunkIndex}` -> true
const retrievalBuffer = new Map() // `${fileId}:${chunkIndex}` -> Buffer

let offeredBytes = 0              // how much space this peer is offering to friends

const listeners = {
  progress: [], stored: [], retrieved: [], offerChanged: []
}
export function on (event, fn) { if (listeners[event]) listeners[event].push(fn) }
function emit (event, ...args) { for (const fn of listeners[event] || []) fn(...args) }

export async function init () {
  setFriendStorageHandlers({
    onChunkData: handleIncomingChunk,
    onFileAck: handleFileAck,
    onRetrieveRequest: handleRetrieveRequest,
    onRetrieveData: handleRetrieveData
  })
  const manifest = getFriendStorageManifest()
  const offerNode = await manifest.get('fs-offer')
  if (offerNode) offeredBytes = offerNode.value.bytes
}

/* ── offer side ──────────────────────────────────────────────────────── */

export async function setOffer (bytes) {
  offeredBytes = Math.max(0, bytes)
  const manifest = getFriendStorageManifest()
  await manifest.put('fs-offer', { bytes: offeredBytes })
  activity.info('friend-storage: offering ' + formatBytes(offeredBytes) + ' to friends')
  emit('offerChanged', offeredBytes)
}

export function getOffer () {
  return offeredBytes
}

export async function getHostedByFriend () {
  const manifest = getFriendStorageManifest()
  const byFriend = new Map() // ownerId -> { bytes, files:Set }
  for await (const node of manifest.createReadStream({ gte: 'fs-hosted:', lt: 'fs-hosted;' })) {
    const parts = node.key.split(':')
    const ownerId = parts[1]
    const fileId = parts[2]
    if (!byFriend.has(ownerId)) byFriend.set(ownerId, { bytes: 0, files: new Set() })
    const entry = byFriend.get(ownerId)
    entry.bytes += node.value.size || 0
    entry.files.add(fileId)
  }
  return [...byFriend.entries()].map(([ownerId, e]) => ({
    ownerId, bytes: e.bytes, fileCount: e.files.size
  }))
}

export async function getHostedStats () {
  const manifest = getFriendStorageManifest()
  let fileCount = 0
  let totalBytes = 0
  const seen = new Set()
  for await (const node of manifest.createReadStream({ gte: 'fs-hosted:', lt: 'fs-hosted;' })) {
    const parts = node.key.split(':')
    const fileId = parts[2]
    if (!seen.has(fileId)) { seen.add(fileId); fileCount++ }
    totalBytes += node.value.size || 0
  }
  return { fileCount, totalBytes, offeredBytes }
}

function generateFileId () {
  const buf = b4a.alloc(16)
  sodium.randombytes_buf(buf)
  return b4a.toString(buf, 'hex')
}

/* ── owner side: send to friend ──────────────────────────────────────── */

export async function storeWithFriend (friendPeerId, filePath, fileData) {
  const rpc = getConnectedPeers().get(friendPeerId)
  if (!rpc) throw new Error('Peer not connected: ' + friendPeerId)

  const ownerKey = getPublicKeyHex()
  const ownerPk = getPublicKey()
  const encKey = generateSymmetricKey()
  const fileId = generateFileId()
  const buf = b4a.from(fileData)
  const { chunks, totalSize } = chunkBuffer(buf, filePath, ownerPk)

  // Encrypt up front so resends during the ACK wait don't redo the work.
  const encryptedChunks = chunks.map(c => ({
    index: c.index,
    data: encryptSymmetric(c.data, encKey)
  }))

  const manifest = getFriendStorageManifest()
  const manifestKey = 'fs-file:' + fileId
  const manifestBase = {
    filePath,
    size: totalSize,
    chunkCount: chunks.length,
    chunkSize: CHUNK_SIZE,
    friendPeerId,
    encKeyHex: b4a.toString(encKey, 'hex'),
    storedAt: Date.now()
  }

  // Persist BEFORE awaiting ACKs. If ACKs are lost the data is still
  // hosted on the friend; the manifest entry preserves the encryption key
  // and chunk layout so retrieval can recover it later.
  await manifest.put(manifestKey, {
    ...manifestBase,
    status: 'pending',
    pendingChunks: chunks.map(c => c.index)
  })

  activity.info('friend-store: sending ' + filePath + ' → ' + friendPeerId.slice(0, 12) +
    ' (' + chunks.length + ' chunk' + (chunks.length !== 1 ? 's' : '') + ')')

  const sendChunk = (chunk) => {
    fsPushFile(rpc, fileId, chunk.index, chunks.length, totalSize, ownerKey, chunk.data)
  }

  for (const chunk of encryptedChunks) {
    sendChunk(chunk)
    emit('progress', { filePath, sent: chunk.index + 1, total: chunks.length })
  }

  const pendingAcks = new Set(encryptedChunks.map(c => fileId + ':' + c.index))

  try {
    await waitForAcks(pendingAcks, encryptedChunks, sendChunk, 30000)
  } catch (err) {
    const remainingIndexes = [...pendingAcks].map(k => Number(k.split(':')[1]))
    await manifest.put(manifestKey, {
      ...manifestBase,
      status: 'incomplete',
      pendingChunks: remainingIndexes
    })
    activity.warn('friend-store: ' + filePath + ' incomplete (' + remainingIndexes.length +
      '/' + chunks.length + ' chunks unacknowledged) — entry kept for recovery')
    throw err
  }

  await manifest.put(manifestKey, {
    ...manifestBase,
    status: 'stored',
    pendingChunks: []
  })

  activity.info('friend-store: ' + filePath + ' stored at ' + friendPeerId.slice(0, 12) +
    ' (' + formatBytes(totalSize) + ')')
  emit('stored', { fileId, filePath, friendPeerId, size: totalSize })
  return { fileId, chunkCount: chunks.length, size: totalSize }
}

/* ── owner side: retrieve from friend ───────────────────────────────── */

export async function retrieveFromFriend (fileId) {
  const manifest = getFriendStorageManifest()
  const node = await manifest.get('fs-file:' + fileId)
  if (!node) throw new Error('File not in manifest: ' + fileId)

  const { filePath, size, chunkCount, friendPeerId, encKeyHex } = node.value
  const rpc = getConnectedPeers().get(friendPeerId)
  if (!rpc) throw new Error('Friend not connected: ' + friendPeerId)

  const encKey = b4a.from(encKeyHex, 'hex')
  const ownerKey = getPublicKeyHex()

  activity.info('friend-retrieve: requesting ' + filePath +
    ' from ' + friendPeerId.slice(0, 12) + ' (' + chunkCount + ' chunks)')

  for (let i = 0; i < chunkCount; i++) {
    fsRetrieveFile(rpc, fileId, i, ownerKey)
  }

  const collectedChunks = await collectChunks(fileId, chunkCount, 30000)

  const decrypted = collectedChunks.map(c => ({
    index: c.index,
    data: decryptSymmetric(c.data, encKey)
  }))

  for (const c of decrypted) {
    if (!c.data) throw new Error('Decryption failed for chunk ' + c.index)
  }

  const result = reassemble(decrypted, size)
  activity.info('friend-retrieve: ' + filePath + ' retrieved (' + formatBytes(result.length) + ')')
  emit('retrieved', { fileId, filePath, size: result.length })
  return { data: result, filePath }
}

/* ── owner side: list ────────────────────────────────────────────────── */

export async function getStoredFiles () {
  const manifest = getFriendStorageManifest()
  const files = []
  for await (const node of manifest.createReadStream({ gte: 'fs-file:', lt: 'fs-file;' })) {
    files.push({ fileId: node.key.replace('fs-file:', ''), ...node.value })
  }
  return files
}

/* ── keeper side: store incoming chunks ──────────────────────────────── */

async function handleIncomingChunk ({ fileId, chunkIndex, chunkCount, totalSize, ownerKey }, buf, peerId) {
  const ownerId = ownerKey || peerId
  const hostedKey = 'fs-hosted:' + ownerId + ':' + fileId + ':' + chunkIndex
  let stored = false
  try {
    const manifest = getFriendStorageManifest()
    const existing = await manifest.get(hostedKey)

    if (!existing) {
      const drive = await getVaultDrive(ownerId)
      await drive.put('/friend-storage/' + fileId + '/' + chunkIndex + '.enc', buf)
      await manifest.put(hostedKey, {
        size: buf.length,
        storedAt: Date.now()
      })
      await recordRentFile(fileId, chunkIndex, buf, {
        fromPeer: peerId,
        ownerKey: ownerId,
        chunkCount,
        totalSize
      })
      dev.info('[friend-store] stored chunk ' + chunkIndex + '/' + (chunkCount - 1) +
        ' for file ' + fileId.slice(0, 12))
    } else {
      dev.info('[friend-store] re-ack for already-stored chunk ' + chunkIndex +
        ' of ' + fileId.slice(0, 12))
    }
    stored = true
  } catch (err) {
    dev.error('[friend-store] store chunk error:', err)
  }

  // Only ACK once the chunk is durably stored. If we failed, stay silent —
  // the owner's resend loop will deliver the chunk again.
  if (stored) sendAckWithRetry(peerId, fileId, chunkIndex)
}

function sendAckWithRetry (peerId, fileId, chunkIndex, attempt = 0) {
  const rpc = getConnectedPeers().get(peerId)
  if (rpc && fsFileAck(rpc, fileId, chunkIndex)) return
  if (attempt >= 5) {
    dev.error('[friend-store] gave up sending ack for chunk ' + chunkIndex +
      ' of ' + fileId.slice(0, 12))
    return
  }
  setTimeout(() => sendAckWithRetry(peerId, fileId, chunkIndex, attempt + 1), 500)
}

/* ── keeper side: serve retrieval requests ───────────────────────────── */

async function handleRetrieveRequest ({ fileId, chunkIndex, ownerKey }, peerId) {
  try {
    const drive = await getVaultDrive(ownerKey || peerId)
    const data = await drive.get('/friend-storage/' + fileId + '/' + chunkIndex + '.enc')
    if (!data) {
      dev.error('[friend-store] chunk not found: ' + fileId.slice(0, 12) + ':' + chunkIndex)
      return
    }
    const rpc = getConnectedPeers().get(peerId)
    if (rpc) fsRetrieveFileResp(rpc, fileId, chunkIndex, data)
  } catch (err) {
    dev.error('[friend-store] retrieve error:', err)
  }
}

/* ── owner side: collect responses ──────────────────────────────────── */

function handleFileAck ({ fileId, chunkIndex }) {
  ackBuffer.set(fileId + ':' + chunkIndex, true)
}

function handleRetrieveData ({ fileId, chunkIndex }, buf) {
  retrievalBuffer.set(fileId + ':' + chunkIndex, buf)
}

function waitForAcks (pendingAcks, encryptedChunks, sendChunk, timeoutMs) {
  return new Promise((resolve, reject) => {
    const fileId = pendingAcks.size ? [...pendingAcks][0].split(':')[0] : null
    const chunksByIndex = new Map(encryptedChunks.map(c => [c.index, c]))
    const RESEND_INTERVAL = 3000
    let lastResend = Date.now()

    const check = () => {
      for (const key of [...pendingAcks]) {
        if (ackBuffer.has(key)) {
          ackBuffer.delete(key)
          pendingAcks.delete(key)
        }
      }
      if (pendingAcks.size === 0) {
        clearInterval(timer)
        clearTimeout(deadline)
        resolve()
        return
      }
      if (Date.now() - lastResend >= RESEND_INTERVAL) {
        lastResend = Date.now()
        for (const key of pendingAcks) {
          const idx = Number(key.split(':')[1])
          const chunk = chunksByIndex.get(idx)
          if (chunk) sendChunk(chunk)
        }
        dev.info('[friend-store] resending ' + pendingAcks.size + ' unacked chunk(s) of ' +
          (fileId ? fileId.slice(0, 12) : '?'))
      }
    }
    const timer = setInterval(check, 200)
    check()
    const deadline = setTimeout(() => {
      clearInterval(timer)
      if (pendingAcks.size === 0) resolve()
      else reject(new Error('ACK timeout: ' + pendingAcks.size + ' chunk(s) unacknowledged'))
    }, timeoutMs)
  })
}

function collectChunks (fileId, chunkCount, timeoutMs) {
  return new Promise((resolve, reject) => {
    const result = new Map()
    const check = () => {
      for (let i = 0; i < chunkCount; i++) {
        const key = fileId + ':' + i
        if (!result.has(i) && retrievalBuffer.has(key)) {
          result.set(i, retrievalBuffer.get(key))
          retrievalBuffer.delete(key)
        }
      }
      if (result.size >= chunkCount) {
        clearInterval(timer)
        resolve([...result.entries()].map(([index, data]) => ({ index, data })))
      }
    }
    const timer = setInterval(check, 200)
    check()
    setTimeout(() => {
      clearInterval(timer)
      if (result.size >= chunkCount) {
        resolve([...result.entries()].map(([index, data]) => ({ index, data })))
      } else {
        reject(new Error('Retrieve timeout: got ' + result.size + '/' + chunkCount + ' chunks'))
      }
    }, timeoutMs)
  })
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function formatBytes (bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}

export { formatBytes }
