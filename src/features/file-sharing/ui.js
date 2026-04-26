import { activity, setStatus } from '../../core/logger.js'
import * as network from '../../core/network.js'
import { pushSendFile, startReceiving } from './sync.js'
import { pickFolderNative } from '../../ui/folder-picker.js'
import b4a from 'b4a'

const $ = (id) => document.getElementById(id)

const shortPeer = (peer) =>
  peer?.drive?.key ? b4a.toString(peer.drive.key, 'hex').slice(0, 12) : 'peer'

let receiveFolder = null
let sendFile = null

export function init () {
  $('joinBtn').addEventListener('click', handleJoin)
  $('sendBtn').addEventListener('click', handleSend)
  $('recvBtn').addEventListener('click', handleReceive)
  $('sendPickBtn').addEventListener('click', () => $('sendFileInput').click())
  $('sendFileInput').addEventListener('change', handleFileSelect)
  $('recvPickBtn').addEventListener('click', handleFolderPick)

  restoreReceiveFolder()

  network.on('peerAdd', (peer) => {
    if (receiveFolder) {
      startReceiving(peer, receiveFolder).catch((err) =>
        activity.error('auto-receive failed from ' + shortPeer(peer) + '… → ' + receiveFolder + ': ' + err.message)
      )
    }
  })
}

async function handleJoin () {
  if (network.isJoined()) return
  const code = $('topic').value.trim()
  if (!code) {
    activity.warn('enter a topic before joining')
    $('topic').focus()
    return
  }

  const topicHex = network.joinTopic(code)
  if (topicHex) {
    $('joinBtn').disabled = true
    setStatus('listening on topic ' + topicHex.slice(0, 12), true)
  }
}

async function handleSend () {
  if (!sendFile) {
    activity.warn('pick a file to send first')
    return
  }
  try {
    await pushSendFile(sendFile)
  } catch (err) {
    activity.error('send failed for ' + sendFile.name + ' (' + sendFile.size + ' B): ' + err.message)
  }
}

async function handleReceive () {
  if (!receiveFolder) {
    activity.warn('pick a download folder first')
    return
  }
  const peers = network.getPeers()
  if (peers.size === 0) activity.info('no peers yet; downloads will begin as peers arrive')
  else activity.info('starting receive from ' + peers.size + ' peer(s) into ' + receiveFolder)
  for (const peer of peers.values()) {
    try {
      await startReceiving(peer, receiveFolder)
    } catch (err) {
      activity.error('receive failed from ' + shortPeer(peer) + '… → ' + receiveFolder + ': ' + err.message)
    }
  }
}

function handleFileSelect (e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  sendFile = { file, name: file.name, path: file.path || null, size: file.size }
  $('sendFileLabel').textContent = file.name + ' (' + file.size + ' bytes)'
  $('sendBtn').disabled = false
  activity.info('file selected: ' + file.name + ' (' + file.size + ' bytes)')
}

async function handleFolderPick () {
  try {
    const folder = await pickFolderNative()
    if (!folder) return
    setReceiveFolder(folder)
  } catch (err) {
    activity.error('folder picker failed (download folder unchanged): ' + err.message)
  }
}

function setReceiveFolder (folder) {
  folder = (folder || '').trim()
  if (!folder) {
    receiveFolder = null
    $('recvFolderLabel').textContent = '(none selected)'
    $('recvBtn').disabled = true
    return
  }
  receiveFolder = folder
  $('recvFolderLabel').textContent = folder
  $('recvBtn').disabled = false
  try { localStorage.setItem('p2p.receiveFolder', folder) } catch {}
  activity.info('download folder set: ' + folder)
}

function restoreReceiveFolder () {
  try {
    const saved = localStorage.getItem('p2p.receiveFolder')
    if (saved) setReceiveFolder(saved)
  } catch {}
}
