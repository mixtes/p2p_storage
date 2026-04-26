/* global Pear */
import * as store from './core/store.js'
import * as identity from './core/identity.js'
import * as network from './core/network.js'
import { activity, dev } from './core/logger.js'
import { renderPeers, displayDriveKey, displayPublicKey, showRecoverySeed } from './ui/components.js'
import * as router from './ui/router.js'
import * as fileSharing from './features/file-sharing/index.js'
import * as replication from './features/replication/index.js'
import * as friendStorage from './features/friend-storage/index.js'

const { store: corestore, localDrive } = await store.init()
dev.info('[boot] storage=' + (Pear?.app?.storage ?? '<unknown>'))
activity.info('drive ready: ' + store.getLocalKeyHex().slice(0, 16) + '…')
displayDriveKey(store.getLocalKeyHex())

const { isNew } = await identity.init(corestore)
const pubHex = identity.getPublicKeyHex()
activity.info('identity ready: ' + pubHex.slice(0, 16) + '…')
displayPublicKey(pubHex)
if (isNew) showRecoverySeed(identity.getRecoverySeedHex())

await network.init()

network.on('peerAdd', () => renderPeers(network.getPeers()))
network.on('peerRemove', () => renderPeers(network.getPeers()))

fileSharing.init()
await replication.init()
await friendStorage.init()

network.on('replicationPeer', () => friendStorage.refreshPeerList())
network.on('replicationPeerRemove', () => friendStorage.refreshPeerList())

router.init()
