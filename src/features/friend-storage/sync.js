/**
 * Friend Storage Sync
 *
 * Opens a 'p2p-friend-storage' Protomux channel on every peer connection.
 * Messages:
 *   0 — REQUEST  { fileName: string, data: Buffer }  requester → host
 *   1 — ACCEPT   fileName: string                    host → requester
 *   2 — DECLINE  fileName: string                    host → requester
 */

import c from 'compact-encoding'

// Encodes { fileName, data } as [string][buffer]
const requestEncoding = {
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

export function setupChannel (peer, hex, manager) {
  const { mux } = peer
  if (!mux) return

  let msgRequest, msgAccept, msgDecline
  let open = false

  const channel = mux.createChannel({
    protocol: 'p2p-friend-storage',
    onopen  () { open = true },
    onclose () { open = false; manager.unregisterChannel(hex) }
  })

  msgRequest = channel.addMessage({
    encoding: requestEncoding,
    onmessage ({ fileName, data }) {
      manager._onIncomingRequest(hex, fileName, data)
    }
  })

  msgAccept = channel.addMessage({
    encoding: c.string,
    onmessage (fileName) {
      manager._onRequestAccepted(hex, fileName)
    }
  })

  msgDecline = channel.addMessage({
    encoding: c.string,
    onmessage (fileName) {
      manager._onRequestDeclined(hex, fileName)
    }
  })

  channel.open()

  manager.registerChannel(hex, {
    sendRequest (fileName, data) {
      if (open) msgRequest.send({ fileName, data })
    },
    sendAccept (fileName) {
      if (open) msgAccept.send(fileName)
    },
    sendDecline (fileName) {
      if (open) msgDecline.send(fileName)
    }
  })
}
