/**
 * Friend Storage Sync
 *
 * Opens a 'p2p-friend-storage' Protomux channel on every peer connection.
 * Messages:
 *   0 — REQUEST     { fileName, data }   requester → host   "store this for me"
 *   1 — ACCEPT      fileName             host → requester   "stored"
 *   2 — DECLINE     fileName             host → requester   "no, won't store"
 *   3 — FETCH       fileName             requester → host   "give it back"
 *   4 — FETCH_DATA  { fileName, data }   host → requester   "here it is"
 *   5 — FETCH_ERR   { fileName, reason } host → requester   "can't give it"
 *   6 — PING        ts (uint)            either → either    keep-alive probe
 *   7 — PONG        ts (uint)            either → either    keep-alive reply
 */

import c from 'compact-encoding'
import { dev } from '../../core/logger.js'

// { fileName, data } → [string][buffer]
const fileEncoding = {
  preencode (state, msg) {
    c.string.preencode(state, msg.fileName)
    c.buffer.preencode(state, msg.data)
  },
  encode (state, msg) {
    c.string.encode(state, msg.fileName)
    c.buffer.encode(state, msg.data)
  },
  decode (state) {
    return {
      fileName: c.string.decode(state),
      data: c.buffer.decode(state)
    }
  }
}

// { fileName, reason } → [string][string]
const errorEncoding = {
  preencode (state, msg) {
    c.string.preencode(state, msg.fileName)
    c.string.preencode(state, msg.reason)
  },
  encode (state, msg) {
    c.string.encode(state, msg.fileName)
    c.string.encode(state, msg.reason)
  },
  decode (state) {
    return {
      fileName: c.string.decode(state),
      reason: c.string.decode(state)
    }
  }
}

export function setupChannel (peer, hex, manager) {
  const { mux } = peer
  if (!mux) {
    dev.error('[fs] peer has no mux; cannot open friend-storage channel', hex.slice(0, 12))
    return
  }

  // Avoid creating the same channel twice (e.g. peerAdd fires + init() also
  // walks already-connected peers). Protomux returns null on duplicate, but
  // an explicit guard keeps the dev log clean.
  if (manager._channelExists(hex)) {
    dev.debug('[fs] channel already set up for', hex.slice(0, 12))
    return
  }

  // The api object captured by message handlers below; only registered with
  // the manager once `channel.onopen` fires, so manager only ever sees
  // channels the remote actually answered.
  let api = null

  const channel = mux.createChannel({
    protocol: 'p2p-friend-storage',
    onopen () {
      dev.debug('[fs] channel open', hex.slice(0, 12))
      manager.registerChannel(hex, api)
    },
    onclose () {
      dev.debug('[fs] channel close', hex.slice(0, 12))
      manager.unregisterChannel(hex)
    }
  })

  if (!channel) {
    // Either the protocol clashed with an existing channel on this mux,
    // or the remote hasn't advertised this protocol (older peer).
    dev.warn('[fs] mux.createChannel returned null for', hex.slice(0, 12))
    return
  }

  const msgRequest = channel.addMessage({
    encoding: fileEncoding,
    onmessage ({ fileName, data }) { manager._onIncomingRequest(hex, fileName, data) }
  })

  const msgAccept = channel.addMessage({
    encoding: c.string,
    onmessage (fileName) { manager._onRequestAccepted(hex, fileName) }
  })

  const msgDecline = channel.addMessage({
    encoding: c.string,
    onmessage (fileName) { manager._onRequestDeclined(hex, fileName) }
  })

  const msgFetch = channel.addMessage({
    encoding: c.string,
    onmessage (fileName) { manager._onIncomingFetch(hex, fileName) }
  })

  const msgFetchData = channel.addMessage({
    encoding: fileEncoding,
    onmessage (payload) { manager._onFetchData(hex, payload) }
  })

  const msgFetchErr = channel.addMessage({
    encoding: errorEncoding,
    onmessage (payload) { manager._onFetchError(hex, payload) }
  })

  const msgPing = channel.addMessage({
    encoding: c.uint,
    onmessage (ts) { try { api.sendPong(ts) } catch {} }
  })

  const msgPong = channel.addMessage({
    encoding: c.uint,
    onmessage (ts) { manager._onPong(hex, ts) }
  })

  api = {
    sendRequest   (fileName, data)   { msgRequest.send({ fileName, data }) },
    sendAccept    (fileName)         { msgAccept.send(fileName) },
    sendDecline   (fileName)         { msgDecline.send(fileName) },
    sendFetch     (fileName)         { msgFetch.send(fileName) },
    sendFetchData (fileName, data)   { msgFetchData.send({ fileName, data }) },
    sendFetchErr  (fileName, reason) { msgFetchErr.send({ fileName, reason }) },
    sendPing      (ts = Date.now())  { msgPing.send(ts) },
    sendPong      (ts)               { msgPong.send(ts) }
  }

  channel.open()
  dev.debug('[fs] channel created', hex.slice(0, 12))
}
