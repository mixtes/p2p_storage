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

const ackBuffer = new Map()       // `${fileId}:${chunkIndex}` -> true
const retrievalBuffer = new Map() // `${fileId}:${chunkIndex}` -> Buffer

let offeredBytes = 0              // how much space this peer is offering to friends

const listeners = { progress: [], stored: [], retrieved: [], offerChanged: [] }
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

  const pendingAcks = new Set(chunks.map(c => fileId + ':' + c.index))

  activity.info('friend-store: sending ' + filePath + ' → ' + friendPeerId.slice(0, 12) +
    ' (' + chunks.length + ' chunk' + (chunks.length !== 1 ? 's' : '') + ')')

  for (const chunk of chunks) {
    const encrypted = encryptSymmetric(chunk.data, encKey)
    fsPushFile(rpc, fileId, chunk.index, chunks.length, totalSize, ownerKey, encrypted)
    emit('progress', { filePath, sent: chunk.index + 1, total: chunks.length })
  }

  await waitForAcks(pendingAcks, 30000)

  const manifest = getFriendStorageManifest()
  await manifest.put('fs-file:' + fileId, {
    filePath,
    size: totalSize,
    chunkCount: chunks.length,
    chunkSize: CHUNK_SIZE,
    friendPeerId,
    encKeyHex: b4a.toString(encKey, 'hex'),
    storedAt: Date.now()
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
  try {
    const drive = await getVaultDrive(ownerKey || peerId)
    await drive.put('/friend-storage/' + fileId + '/' + chunkIndex + '.enc', buf)

    const manifest = getFriendStorageManifest()
    await manifest.put('fs-hosted:' + (ownerKey || peerId) + ':' + fileId + ':' + chunkIndex, {
      size: buf.length,
      storedAt: Date.now()
    })

    const rpc = getConnectedPeers().get(peerId)
    if (rpc) fsFileAck(rpc, fileId, chunkIndex)

    dev.info('[friend-store] stored chunk ' + chunkIndex + '/' + (chunkCount - 1) +
      ' for file ' + fileId.slice(0, 12))
  } catch (err) {
    dev.error('[friend-store] store chunk error:', err)
  }
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

function waitForAcks (pendingAcks, timeoutMs) {
  return new Promise((resolve, reject) => {
    const check = () => {
      for (const key of [...pendingAcks]) {
        if (ackBuffer.has(key)) {
          ackBuffer.delete(key)
          pendingAcks.delete(key)
        }
      }
      if (pendingAcks.size === 0) {
        clearInterval(timer)
        resolve()
      }
    }
    const timer = setInterval(check, 200)
    check()
    setTimeout(() => {
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
