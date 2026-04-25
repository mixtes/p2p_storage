/**
 * Friend Storage Feature — entry point
 *
 * Wires the manager, sync channel, network events, and UI together.
 */

import { FriendStorageManager } from './manager.js'
import { setupChannel } from './sync.js'
import * as ui from './ui.js'
import { activity } from '../../core/logger.js'

let manager = null
let _network = null

export function init (networkRef) {
  manager = new FriendStorageManager()
  _network = networkRef

  ui.init(manager, networkRef.getPeers)

  // Cover peers that connected before this module finished init().
  const existing = networkRef.getPeers()
  if (existing.size > 0) {
    activity.info('friend-storage: walking ' + existing.size + ' already-connected peer(s)')
  }
  for (const [hex, peer] of existing) setupChannel(peer, hex, manager)

  networkRef.on('peerAdd', (peer, hex) => {
    setupChannel(peer, hex, manager)
    ui.onPeerChange(networkRef.getPeers())
  })

  networkRef.on('peerRemove', (hex) => {
    // Safety net in case Protomux didn't fire channel.onclose before the
    // underlying connection went away.
    if (hex && manager._channelExists(hex)) manager.unregisterChannel(hex)
    ui.onPeerChange(networkRef.getPeers())
  })

  manager.on('friends-changed', () =>
    ui.onFriendsChanged(manager.getFriends(), networkRef.getPeers())
  )

  manager.on('ledger-changed', () => ui.onLedgerChanged(manager))

  manager.on('liveness-changed', () =>
    ui.onFriendsChanged(manager.getFriends(), networkRef.getPeers())
  )
}

// Manual retry: re-attempt a Protomux channel handshake with a peer that's
// connected on the swarm but whose friend-storage channel never paired.
// Wired to the friend-list "Retry" button.
export function retryChannel (hex) {
  if (!_network) return
  const peer = _network.getPeers().get(hex)
  if (!peer) {
    activity.warn('friend-storage: cannot retry \u2014 peer ' + hex.slice(0, 12) + '\u2026 not connected')
    return
  }
  // If a stale entry exists, clear it so setupChannel will re-create.
  if (manager._channelExists(hex)) manager.unregisterChannel(hex)
  setupChannel(peer, hex, manager)
}

export function getManager () {
  return manager
}
