import Localdrive from 'localdrive'
import MirrorDrive from 'mirror-drive'
import b4a from 'b4a'
import { activity, dev } from '../../core/logger.js'
import { getLocalDrive } from '../../core/store.js'

export async function pushSendFile (sendFile) {
  if (!sendFile) return
  const localDrive = getLocalDrive()
  const name = '/' + sendFile.name
  const buf = b4a.from(await sendFile.file.arrayBuffer())
  await localDrive.put(name, buf)
  activity.info(`sent ${sendFile.name} (${buf.length} bytes) -> drive v${localDrive.version}`)
}

export async function startReceiving (peer, receiveFolder) {
  if (peer.watcher) return
  const peerHex = b4a.toString(peer.drive.key, 'hex').slice(0, 16)
  const local = new Localdrive(receiveFolder)

  const sync = async () => {
    const mirror = new MirrorDrive(peer.drive, local)
    await mirror.done()
    activity.info(`synced ${peerHex}… v${peer.drive.version} -> ${receiveFolder} (+${mirror.count.add} ~${mirror.count.change} -${mirror.count.remove})`)
  }

  try {
    await sync()
  } catch (err) {
    activity.error('initial sync failed from ' + peerHex + '… → ' + receiveFolder + ': ' + err.message)
  }

  peer.watcher = peer.drive.watch('/')
  ;(async () => {
    for await (const _ of peer.watcher) {
      try { await sync() } catch (err) {
        activity.error('live sync failed from ' + peerHex + '… → ' + receiveFolder + ': ' + err.message)
      }
    }
  })().catch((err) => dev.error('[sync] watcher loop crashed for ' + peerHex + ':', err))
}
