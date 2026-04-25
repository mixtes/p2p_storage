/* global Pear */
import * as store from './core/store.js'
import * as network from './core/network.js'
import { activity, dev } from './core/logger.js'
import { renderPeers, displayDriveKey } from './ui/components.js'
import * as router from './ui/router.js'
import * as fileSharing from './features/file-sharing/index.js'
import * as replication from './features/replication/index.js'
import * as friendStorage from './features/friend-storage/index.js'

const { store: corestore, localDrive } = await store.init()
dev.info('[boot] storage=' + (Pear?.app?.storage ?? '<unknown>'))
activity.info('drive ready: ' + store.getLocalKeyHex().slice(0, 16) + '…')
displayDriveKey(store.getLocalKeyHex())

await network.init()

network.on('peerAdd', () => renderPeers(network.getPeers()))
network.on('peerRemove', () => renderPeers(network.getPeers()))

fileSharing.init()
replication.init()
friendStorage.init()

router.init()
