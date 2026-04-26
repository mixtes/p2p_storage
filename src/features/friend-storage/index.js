import * as manager from './manager.js'
import * as ui from './ui.js'

export async function init () {
  await manager.init()
  ui.init()
}

export function refreshPeerList () {
  ui.refreshPeerList()
}

export { manager }
