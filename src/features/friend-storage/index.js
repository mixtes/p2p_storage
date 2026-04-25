/**
 * Friend Storage Feature — entry point
 *
 * Wires the manager, sync channel, network events, and UI together.
 */

import { FriendStorageManager } from './manager.js'
import { setupChannel } from './sync.js'
import * as ui from './ui.js'
import { activity, dev } from '../../core/logger.js'

let manager = null
let _network = null

// Auto-reopen state per peer hex.
const MAX_AUTO_ATTEMPTS = 5
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]
const _attempts = new Map()    // hex -> attempt count
const _retryTimers = new Map() // hex -> timeout id

function _clearRetry (hex) {
  const id = _retryTimers.get(hex)
  if (id) { clearTimeout(id); _retryTimers.delete(hex) }
}

export function init (networkRef) {
  manager = new FriendStorageManager()
  _network = networkRef

  // Allow the manager to ask us to (re)open a channel on demand.
  manager.setEnsureChannel((hex) => ensureChannel(hex))

  ui.init(manager, networkRef.getPeers)

  // Cover peers that connected before this module finished init().
  const existing = networkRef.getPeers()
  if (existing.size > 0) {
    activity.info('friend-storage: walking ' + existing.size + ' already-connected peer(s)')
  }
  for (const [hex, peer] of existing) setupChannel(peer, hex, manager)

  networkRef.on('peerAdd', (peer, hex) => {
    // Fresh swarm-level connection: reset any backoff state.
    _attempts.delete(hex)
    _clearRetry(hex)
    setupChannel(peer, hex, manager)
    ui.onPeerChange(networkRef.getPeers())
  })

  networkRef.on('peerRemove', (hex) => {
    // Safety net in case Protomux didn't fire channel.onclose before the
    // underlying connection went away.
    if (hex) {
      _attempts.delete(hex)
      _clearRetry(hex)
      if (manager._channelExists(hex)) manager.unregisterChannel(hex)
    }
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
  // Manual retry resets the auto-attempt counter.
  _attempts.delete(hex)
  _clearRetry(hex)
  ensureChannel(hex, { force: true, manual: true })
}

// Internal: open a friend-storage channel for `hex` if the swarm peer is
// connected. Returns true if a setupChannel call was made.
function ensureChannel (hex, { force = false, manual = false } = {}) {
  if (!_network) return false
  const peer = _network.getPeers().get(hex)
  if (!peer) {
    if (manual) activity.warn('friend-storage: cannot retry \u2014 peer ' + hex.slice(0, 12) + '\u2026 not connected')
    return false
  }
  // Clear any stale entry so setupChannel will re-create.
  if (force && manager._channelExists(hex)) manager.unregisterChannel(hex)
  if (manager._channelExists(hex)) return false
  setupChannel(peer, hex, manager)
  return true
}

// Called by sync.js channel.onclose to schedule an auto-reopen with backoff.
// If MAX_AUTO_ATTEMPTS is reached we give up until the swarm conn drops or
// the user clicks Retry.
export function scheduleAutoReopen (hex) {
  if (!_network) return
  // Don't auto-reopen if the swarm peer is already gone.
  if (!_network.getPeers().has(hex)) return
  // Already a retry queued for this peer.
  if (_retryTimers.has(hex)) return

  const n = _attempts.get(hex) || 0
  if (n >= MAX_AUTO_ATTEMPTS) {
    activity.error('friend-storage: giving up auto-reopen for ' + hex.slice(0, 12) + '\u2026 after ' + n + ' attempts \u2014 click Retry to try again')
    return
  }
  const delay = BACKOFF_MS[Math.min(n, BACKOFF_MS.length - 1)]
  _attempts.set(hex, n + 1)
  const id = setTimeout(() => {
    _retryTimers.delete(hex)
    try { ensureChannel(hex) } catch (err) { dev.error('[fs] auto-reopen failed:', err) }
  }, delay)
  _retryTimers.set(hex, id)
}

// Called by sync.js channel.onopen so a successful pair clears the backoff.
export function resetAutoAttempts (hex) {
  _attempts.delete(hex)
  _clearRetry(hex)
}

export function getManager () {
  return manager
}
