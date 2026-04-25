/**
 * Storage Replication Feature
 *
 * Symmetric P2P backup: each peer encrypts important files and
 * stores redundant copies on other peers' machines, while providing
 * local disk space for others to do the same.
 *
 * Entry point -- wires manager, sync, and UI together.
 */

import { ReplicationManager } from './manager.js'
import * as ui from './ui.js'

let manager = null

export function init () {
  manager = new ReplicationManager()
  ui.init()
}

export function getManager () {
  return manager
}
