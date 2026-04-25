import Localdrive from 'localdrive'
import MirrorDrive from 'mirror-drive'
import b4a from 'b4a'
import { log } from '../../core/logger.js'
import { getLocalDrive } from '../../core/store.js'

export async function pushSendFile (sendFile) {
  if (!sendFile) return
  const localDrive = getLocalDrive()
  const name = '/' + sendFile.name
  const buf = b4a.from(await sendFile.file.arrayBuffer())
  await localDrive.put(name, buf)
  log(`sent ${sendFile.name} (${buf.length} bytes) -> drive v${localDrive.version}`)
}

export async function startReceiving (peer, receiveFolder) {
  if (peer.watcher) return
  const peerHex = b4a.toString(peer.drive.key, 'hex').slice(0, 16)
  const local = new Localdrive(receiveFolder)

  const sync = async () => {
    const mirror = new MirrorDrive(peer.drive, local)
    await mirror.done()
    log(`synced ${peerHex}… v${peer.drive.version} -> ${receiveFolder} (+${mirror.count.add} ~${mirror.count.change} -${mirror.count.remove})`)
  }

  try {
    await sync()
  } catch (err) {
    log('sync error: ' + err.message)
  }

  peer.watcher = peer.drive.watch('/')
  ;(async () => {
    for await (const _ of peer.watcher) {
      try { await sync() } catch (err) { log('sync error: ' + err.message) }
    }
  })().catch((err) => log('watcher error: ' + err.message))
}
