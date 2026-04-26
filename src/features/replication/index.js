/**
 * Storage Replication Feature
 *
 * Symmetric P2P backup: each peer encrypts important files and
 * stores redundant copies on other peers' machines, while providing
 * local disk space for others to do the same.
 *
 * Entry point — wires manager, protocol, health monitor, and UI.
 */

import * as manager from './manager.js'
import * as ui from './ui.js'
import { on as onNetwork, setReplicationHandlers, joinReplicationPool } from '../../core/network.js'
import * as healthMonitor from '../../core/health-monitor.js'
import { activity, dev } from '../../core/logger.js'

export async function init () {
  await manager.init()
  await manager.ensureConfigured()

  const handlers = manager.createProtocolHandlers()
  setReplicationHandlers(handlers)

  joinReplicationPool()

  onNetwork('replicationPeer', (peerId, rpc) => {
    manager.registerPeer(peerId, rpc)
    dev.info('[replication] peer registered: ' + peerId)
  })

  onNetwork('replicationPeerRemove', (peerId) => {
    manager.unregisterPeer(peerId)
    dev.info('[replication] peer unregistered: ' + peerId)
  })

  startHealthMonitor()

  manager.on('configChanged', () => {
    if (!healthMonitor.isRunning()) startHealthMonitor()
  })

  healthMonitor.on('degraded', (peerId) => {
    activity.info('keeper degraded — consider re-replication: ' + peerId)
  })

  healthMonitor.on('recovered', (peerId) => {
    activity.info('keeper recovered: ' + peerId)
  })

  ui.init()
}

function startHealthMonitor () {
  const config = manager.getConfig()
  healthMonitor.start({
    getConnectedPeers: () => manager.getConnectedPeers(),
    getKeeperUsedBytes: () => manager.getKeeperUsedBytesAsync(),
    getOfferedBytes: () => config ? config.offeredBytes : 0
  })
}

export { manager, healthMonitor }
