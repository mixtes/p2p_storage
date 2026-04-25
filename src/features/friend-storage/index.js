/**
 * Friend Storage Feature — entry point
 *
 * Wires the manager, sync channel, network events, and UI together.
 */

import { FriendStorageManager } from './manager.js'
import { setupChannel } from './sync.js'
import * as ui from './ui.js'

let manager = null

export function init (networkRef) {
  manager = new FriendStorageManager()

  ui.init(manager, networkRef.getPeers)

  networkRef.on('peerAdd', (peer, hex) => {
    setupChannel(peer, hex, manager)
    ui.onPeerChange(networkRef.getPeers())
  })

  networkRef.on('peerRemove', () => ui.onPeerChange(networkRef.getPeers()))

  manager.on('friends-changed', () =>
    ui.onFriendsChanged(manager.getFriends(), networkRef.getPeers())
  )

  manager.on('ledger-changed', () => ui.onLedgerChanged(manager))
}

export function getManager () {
  return manager
}
