import { log, setStatus } from '../../core/logger.js'
import * as network from '../../core/network.js'
import { pushSendFile, startReceiving } from './sync.js'
import { pickFolderNative } from '../../ui/folder-picker.js'

const $ = (id) => document.getElementById(id)

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
      startReceiving(peer, receiveFolder).catch((err) => log('auto-recv error: ' + err.message))
    }
  })
}

async function handleJoin () {
  if (network.isJoined()) return
  const code = $('topic').value.trim()
  if (!code) return alert('Enter a topic')

  const topicHex = network.joinTopic(code)
  if (topicHex) {
    $('joinBtn').disabled = true
    setStatus('listening on topic ' + topicHex.slice(0, 12), true)
  }
}

async function handleSend () {
  if (!sendFile) return alert('Pick a file to send first')
  try {
    await pushSendFile(sendFile)
  } catch (err) {
    log('send error: ' + err.message)
  }
}

async function handleReceive () {
  if (!receiveFolder) return alert('Pick a download folder first')
  const peers = network.getPeers()
  if (peers.size === 0) log('no peers yet; downloads will begin as peers arrive')
  for (const peer of peers.values()) {
    try {
      await startReceiving(peer, receiveFolder)
    } catch (err) {
      log('recv error: ' + err.message)
    }
  }
}

function handleFileSelect (e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  sendFile = { file, name: file.name, path: file.path || null, size: file.size }
  $('sendFileLabel').textContent = file.name + ' (' + file.size + ' bytes)'
  $('sendBtn').disabled = false
  log('file selected: ' + file.name + ' (' + file.size + ' bytes)')
}

async function handleFolderPick () {
  try {
    const folder = await pickFolderNative()
    if (!folder) return
    setReceiveFolder(folder)
  } catch (err) {
    log('folder picker error: ' + err.message)
    alert('Could not open folder picker: ' + err.message)
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
  log('download folder set: ' + folder)
}

function restoreReceiveFolder () {
  try {
    const saved = localStorage.getItem('p2p.receiveFolder')
    if (saved) setReceiveFolder(saved)
  } catch {}
}
