/**
 * Replication Protocol — Protomux channel for chunk-level replication.
 *
 * Sits alongside the existing 'p2p-fileshare-keys' channel on every
 * Hyperswarm connection. All messages are JSON-encoded for MVP simplicity
 * (can be migrated to compact-encoding later for performance).
 *
 * Usage:
 *   import { attachReplicationChannel } from './replication-protocol.js'
 *   swarm.on('connection', conn => {
 *     attachReplicationChannel(conn, handlers)
 *   })
 */

import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import { dev } from './logger.js'

/* ── message type constants ──────────────────────────────────────────── */

export const MSG = {
  ANNOUNCE_CAPACITY: 'ANNOUNCE_CAPACITY',
  REQUEST_AGREEMENT: 'REQUEST_AGREEMENT',
  ACCEPT_AGREEMENT: 'ACCEPT_AGREEMENT',
  REJECT_AGREEMENT: 'REJECT_AGREEMENT',
  PUSH_CHUNK: 'PUSH_CHUNK',
  CHUNK_STORED: 'CHUNK_STORED',
  CHALLENGE: 'CHALLENGE',
  CHALLENGE_RESP: 'CHALLENGE_RESP',
  RETRIEVE: 'RETRIEVE',
  RETRIEVE_RESP: 'RETRIEVE_RESP',
  HEARTBEAT: 'HEARTBEAT',
  REVOKE_CHUNK: 'REVOKE_CHUNK',
  // Friend storage (asymmetric: owner offloads file, friend holds it)
  FS_PUSH_FILE: 'FS_PUSH_FILE',
  FS_FILE_ACK: 'FS_FILE_ACK',
  FS_RETRIEVE_FILE: 'FS_RETRIEVE_FILE',
  FS_RETRIEVE_FILE_RESP: 'FS_RETRIEVE_FILE_RESP',
  // Friend requests
  FS_FRIEND_REQUEST: 'FS_FRIEND_REQUEST',
  FS_FRIEND_REQUEST_ACCEPT: 'FS_FRIEND_REQUEST_ACCEPT'
}

/* ── JSON envelope encoding ──────────────────────────────────────────── */

/**
 * Every message is a JSON envelope: { type, payload }.
 * For PUSH_CHUNK and RETRIEVE_RESP the binary chunk data is sent on
 * a separate raw message to avoid base64-encoding large buffers.
 */
function encodeEnvelope (type, payload) {
  return b4a.from(JSON.stringify({ type, payload }), 'utf-8')
}

function decodeEnvelope (buf) {
  try {
    return JSON.parse(b4a.toString(buf, 'utf-8'))
  } catch {
    return null
  }
}

/* ── channel attachment ──────────────────────────────────────────────── */

/**
 * Attach the replication protocol channel to a Hyperswarm connection.
 *
 * @param {NoiseStream} conn - Hyperswarm encrypted connection
 * @param {object} handlers  - callbacks keyed by MSG type
 * @param {string} peerId    - short hex of the remote peer (for logs)
 * @returns {{ send, sendBinary, channel }} control object
 */
export function attachReplicationChannel (conn, handlers, peerId) {
  const mux = Protomux.from(conn)

  let jsonMsg = null
  let binaryMsg = null

  const channel = mux.createChannel({
    protocol: 'p2p-replication',
    onopen () {
      dev.debug('[repl-proto] channel open with ' + peerId)
      if (handlers.onopen) handlers.onopen(peerId)
    },
    onclose () {
      dev.debug('[repl-proto] channel closed with ' + peerId)
      if (handlers.onclose) handlers.onclose(peerId)
    }
  })

  jsonMsg = channel.addMessage({
    encoding: c.raw,
    onmessage (buf) {
      const envelope = decodeEnvelope(buf)
      if (!envelope) {
        dev.error('[repl-proto] malformed message from ' + peerId + ' (bytes=' + buf.length + ')')
        return
      }
      const handler = handlers[envelope.type]
      if (handler) {
        try {
          handler(envelope.payload, peerId)
        } catch (err) {
          dev.error('[repl-proto] handler error type=' + envelope.type + ' peer=' + peerId + ': ' + (err?.stack || err?.message || err))
        }
      } else {
        dev.debug('[repl-proto] unhandled message type: ' + envelope.type + ' from ' + peerId)
      }
    }
  })

  binaryMsg = channel.addMessage({
    encoding: c.raw,
    onmessage (buf) {
      if (handlers.onbinary) {
        try {
          handlers.onbinary(buf, peerId)
        } catch (err) {
          dev.error('[repl-proto] binary handler error peer=' + peerId + ' bytes=' + buf.length + ': ' + (err?.stack || err?.message || err))
        }
      }
    }
  })

  channel.open()

  return {
    /**
     * Send a typed JSON message.
     * @param {string} type    - one of MSG.*
     * @param {object} payload - JSON-serializable data
     */
    send (type, payload) {
      if (!channel.opened) {
        dev.warn('[repl-proto] send dropped (channel closed) type=' + type + ' peer=' + peerId)
        return false
      }
      try {
        jsonMsg.send(encodeEnvelope(type, payload))
        return true
      } catch (err) {
        dev.error('[repl-proto] send failed type=' + type + ' peer=' + peerId + ': ' + (err?.message || err))
        return false
      }
    },

    /**
     * Send raw binary data (for chunk transfer).
     * Typically preceded by a JSON PUSH_CHUNK or RETRIEVE_RESP header.
     * @param {Buffer} buf
     */
    sendBinary (buf) {
      if (!channel.opened) {
        dev.warn('[repl-proto] sendBinary dropped (channel closed) peer=' + peerId + ' bytes=' + buf.length)
        return false
      }
      try {
        binaryMsg.send(buf)
        return true
      } catch (err) {
        dev.error('[repl-proto] sendBinary failed peer=' + peerId + ' bytes=' + buf.length + ': ' + (err?.message || err))
        return false
      }
    },

    channel,
    peerId
  }
}

/* ── convenience: message builders ───────────────────────────────────── */

export function announceCapacity (rpc, offeredBytes, usedBytes, replicationFactor) {
  return rpc.send(MSG.ANNOUNCE_CAPACITY, { offeredBytes, usedBytes, replicationFactor })
}

export function requestAgreement (rpc, ownerKey, neededBytes, replicationFactor) {
  return rpc.send(MSG.REQUEST_AGREEMENT, { ownerKey, neededBytes, replicationFactor })
}

export function acceptAgreement (rpc, keeperKey, grantedBytes) {
  return rpc.send(MSG.ACCEPT_AGREEMENT, { keeperKey, grantedBytes })
}

export function rejectAgreement (rpc, reason) {
  return rpc.send(MSG.REJECT_AGREEMENT, { reason })
}

/**
 * Push a chunk: send JSON header then binary payload.
 */
export function pushChunk (rpc, chunkId, chunkIndex, totalSize, encryptedData) {
  const ok = rpc.send(MSG.PUSH_CHUNK, { chunkId, chunkIndex, totalSize })
  if (ok) rpc.sendBinary(encryptedData)
  return ok
}

export function chunkStored (rpc, chunkId) {
  return rpc.send(MSG.CHUNK_STORED, { chunkId })
}

export function challenge (rpc, chunkId, nonce) {
  return rpc.send(MSG.CHALLENGE, { chunkId, nonce })
}

export function challengeResp (rpc, chunkId, proof) {
  return rpc.send(MSG.CHALLENGE_RESP, { chunkId, proof })
}

export function retrieve (rpc, chunkId) {
  return rpc.send(MSG.RETRIEVE, { chunkId })
}

/**
 * Respond to a retrieve: JSON header then binary payload.
 */
export function retrieveResp (rpc, chunkId, data) {
  const ok = rpc.send(MSG.RETRIEVE_RESP, { chunkId })
  if (ok) rpc.sendBinary(data)
  return ok
}

export function heartbeat (rpc, usedBytes, freeBytes) {
  return rpc.send(MSG.HEARTBEAT, { usedBytes, freeBytes, timestamp: Date.now() })
}

export function revokeChunk (rpc, chunkId) {
  return rpc.send(MSG.REVOKE_CHUNK, { chunkId })
}

/* ── friend storage helpers ──────────────────────────────────────────── */

export function fsPushFile (rpc, fileId, chunkIndex, chunkCount, totalSize, ownerKey, encryptedData) {
  const ok = rpc.send(MSG.FS_PUSH_FILE, { fileId, chunkIndex, chunkCount, totalSize, ownerKey })
  if (ok) rpc.sendBinary(encryptedData)
  return ok
}

export function fsFileAck (rpc, fileId, chunkIndex) {
  return rpc.send(MSG.FS_FILE_ACK, { fileId, chunkIndex })
}

export function fsRetrieveFile (rpc, fileId, chunkIndex, ownerKey) {
  return rpc.send(MSG.FS_RETRIEVE_FILE, { fileId, chunkIndex, ownerKey })
}

export function fsRetrieveFileResp (rpc, fileId, chunkIndex, data) {
  const ok = rpc.send(MSG.FS_RETRIEVE_FILE_RESP, { fileId, chunkIndex })
  if (ok) rpc.sendBinary(data)
  return ok
}

export function fsFriendRequest (rpc, fromKey, label, note) {
  return rpc.send(MSG.FS_FRIEND_REQUEST, { fromKey, label, note })
}

export function fsFriendRequestAccept (rpc, fromKey, label) {
  return rpc.send(MSG.FS_FRIEND_REQUEST_ACCEPT, { fromKey, label })
}
