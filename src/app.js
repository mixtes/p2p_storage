import * as store from './core/store.js'
import * as network from './core/network.js'
import { activity, log } from './core/logger.js'
import { renderPeers, displayDriveKey } from './ui/components.js'
import * as router from './ui/router.js'
import * as fileSharing from './features/file-sharing/index.js'
import * as replication from './features/replication/index.js'
import * as friendStorage from './features/friend-storage/index.js'

// Surface unhandled errors so failures past this point are visible in the
// activity log instead of leaving the UI half-initialised (e.g. the drive-key
// placeholder never being replaced).
window.addEventListener('error', (e) => {
  try { activity.error('uncaught: ' + (e.error?.stack || e.message || e.error || 'unknown')) } catch {}
})
window.addEventListener('unhandledrejection', (e) => {
  try { activity.error('unhandled rejection: ' + (e.reason?.stack || e.reason?.message || e.reason || 'unknown')) } catch {}
})

try {
  await store.init()
  const keyHex = store.getLocalKeyHex()
  log('drive ready: ' + keyHex.slice(0, 16) + '…')
  displayDriveKey(keyHex)
} catch (err) {
  activity.error('store init failed: ' + (err?.message || err))
  throw err
}

try {
  await network.init()
  network.on('peerAdd', () => renderPeers(network.getPeers()))
  network.on('peerRemove', () => renderPeers(network.getPeers()))
} catch (err) {
  activity.error('network init failed: ' + (err?.message || err))
}

// Feature inits are independent — a failure in one shouldn't block the others.
try { fileSharing.init() }      catch (err) { activity.error('file-sharing init failed: ' + (err?.message || err)) }
try { replication.init() }      catch (err) { activity.error('replication init failed: ' + (err?.message || err)) }
try { friendStorage.init(network) } catch (err) { activity.error('friend-storage init failed: ' + (err?.message || err)) }

try { router.init() } catch (err) { activity.error('router init failed: ' + (err?.message || err)) }
