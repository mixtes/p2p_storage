/**
 * Friend Storage Feature
 *
 * Altruistic / group storage: friends store encrypted files for each
 * other when someone doesn't have enough local space. Files are
 * encrypted before upload -- only the owner can decrypt after retrieval.
 *
 * Entry point -- wires manager, sync, and UI together.
 */

import { FriendStorageManager } from './manager.js'
import * as ui from './ui.js'

let manager = null

export function init () {
  manager = new FriendStorageManager()
  ui.init()
}

export function getManager () {
  return manager
}
