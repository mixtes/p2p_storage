/* global Pear */
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import Localdrive from 'localdrive'
import MirrorDrive from 'mirror-drive'
import Protomux from 'protomux'
import c from 'compact-encoding'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

const { teardown, config } = Pear

const store = new Corestore(config.storage)
await store.ready()

const localDrive = new Hyperdrive(store.namespace('local'))
await localDrive.ready()

const swarm = new Hyperswarm({
  maxPeers: 8,           // total peers we'll keep in the swarm
  maxParallel: 4,        // simultaneous connection attempts
  maxClientConnections: 4,
  maxServerConnections: 4
})
teardown(() => swarm.destroy())

// remoteKeyHex -> { drive, watcher, connPeerId }
const peers = new Map()
let receiveFolder = null
let sendFolder = null
let joined = false

const $ = (id) => document.getElementById(id)
const log = (msg) => {
  const el = $('log')
  const line = document.createElement('div')
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  el.prepend(line)
}
const setStatus = (text, on) => {
  $('statusText').textContent = text
  $('statusDot').classList.toggle('on', !!on)
}

$('myKey').textContent = b4a.toString(localDrive.key, 'hex')
log('drive ready: ' + b4a.toString(localDrive.key, 'hex').slice(0, 16) + '…')

swarm.on('error', (err) => log('swarm error: ' + err.message))

swarm.on('connection', (conn, info) => {
  try {
    const peerId = b4a.toString(conn.remotePublicKey, 'hex').slice(0, 12)
    log('peer connected: ' + peerId + ' (client=' + !!(info && info.client) + ')')

    // Replicate the corestore — this creates a Protomux on the stream.
    // New cores added to the store later (via onRemoteKey) are synced automatically.
    store.replicate(conn)

    // Exchange drive keys over a dedicated Protomux channel.
    // Raw conn.write / conn.on('data') won't work after store.replicate
    // because Protomux owns the stream.
    const mux = Protomux.from(conn)

    let keyMessage = null

    const channel = mux.createChannel({
      protocol: 'p2p-fileshare-keys',
      onopen () {
        keyMessage.send(localDrive.key)
      }
    })

    keyMessage = channel.addMessage({
      encoding: c.raw,
      async onmessage (remoteKey) {
        log('received remote key from ' + peerId + ': ' + b4a.toString(remoteKey, 'hex').slice(0, 16) + '…')
        try {
          await onRemoteKey(remoteKey, peerId)
        } catch (err) {
          log('peer setup error: ' + err.message)
        }
      }
    })

    channel.open()

    conn.on('error', (err) => log('conn error (' + peerId + '): ' + err.message))
    conn.on('close', () => {
      log('peer disconnected: ' + peerId)
      removePeerByConn(peerId)
    })
  } catch (err) {
    log('connection handler error: ' + err.message)
  }
})

async function onRemoteKey (key, connPeerId) {
  const hex = b4a.toString(key, 'hex')
  if (peers.has(hex)) return

  const drive = new Hyperdrive(store, key)
  await drive.ready()
  log('remote drive ready: ' + hex.slice(0, 16) + '… (v' + drive.version + ')')

  // Eagerly prefetch the entire drive in the background so blocks are
  // already cached locally by the time MirrorDrive asks for them.
  try {
    drive.download('/')
    log('prefetch started for ' + hex.slice(0, 16) + '…')
  } catch (err) {
    log('prefetch error: ' + err.message)
  }

  const peer = { drive, watcher: null, connPeerId }
  peers.set(hex, peer)
  renderPeers()

  if (receiveFolder) startReceiving(peer)
}

function removePeerByConn (connPeerId) {
  for (const [hex, peer] of peers) {
    if (peer.connPeerId === connPeerId) {
      if (peer.watcher) peer.watcher.destroy()
      peers.delete(hex)
      break
    }
  }
  renderPeers()
}

function renderPeers () {
  const el = $('peers')
  el.innerHTML = ''
  if (peers.size === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'none yet'
    el.appendChild(li)
    return
  }
  for (const hex of peers.keys()) {
    const li = document.createElement('li')
    li.textContent = hex
    el.appendChild(li)
  }
}

// --- Send: local folder -> our Hyperdrive --------------------------------
async function pushSendFolder() {
  if (!sendFolder) return
  const local = new Localdrive(sendFolder)
  const mirror = new MirrorDrive(local, localDrive)
  await mirror.done()
  log(`pushed ${sendFolder} -> drive v${localDrive.version} (+${mirror.count.add} ~${mirror.count.change} -${mirror.count.remove})`)
}

// --- Receive: a peer's Hyperdrive -> local folder, with live updates -----
async function startReceiving(peer) {
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

  // Hyperdrive.watch() yields whenever the remote drive's tree changes.
  peer.watcher = peer.drive.watch('/')
  ;(async () => {
    for await (const _ of peer.watcher) {
      try { await sync() } catch (err) { log('sync error: ' + err.message) }
    }
  })().catch((err) => log('watcher error: ' + err.message))
}

// --- UI handlers ----------------------------------------------------------
$('joinBtn').addEventListener('click', async () => {
  if (joined) return
  const code = $('topic').value.trim()
  if (!code) return alert('Enter a topic')

  const topic = crypto.hash(b4a.from('p2p-fileshare:' + code))
  log('joining topic ' + b4a.toString(topic, 'hex').slice(0, 16) + '… (code="' + code + '")')
  swarm.join(topic, { client: true, server: true })
  joined = true
  $('joinBtn').disabled = true
  setStatus('listening on topic ' + b4a.toString(topic, 'hex').slice(0, 12), true)
  log('joined – peers will connect as they are discovered')
})

$('sendBtn').addEventListener('click', async () => {
  if (!sendFolder) return alert('Pick a folder to share first')
  log('mirror->drive clicked, sendFolder=' + sendFolder + ', peers=' + peers.size)
  try {
    await pushSendFolder()
  } catch (err) {
    log('send error: ' + err.message)
  }
})

$('recvBtn').addEventListener('click', async () => {
  if (!receiveFolder) return alert('Pick a folder to receive into first')
  log('start receiving clicked, receiveFolder=' + receiveFolder + ', known peers=' + peers.size)
  if (peers.size === 0) log('no peers known yet; will start receiving as soon as a peer key arrives')
  for (const peer of peers.values()) {
    try { await startReceiving(peer) } catch (err) { log('recv error: ' + err.message) }
  }
})

// --- Folder pickers (Electron exposes file.path on <input webkitdirectory>) -
function folderPathFromInput (input) {
  const file = input.files && input.files[0]
  if (!file || !file.path) return null
  // file.path is the absolute path of the selected file inside the folder.
  // Strip the file name to get the folder path; for nested files inside the
  // chosen folder, also strip any subdirectory segments after the chosen root.
  const rel = file.webkitRelativePath || file.name
  const rootName = rel.split('/')[0]
  const abs = file.path
  const idx = abs.lastIndexOf(rootName)
  if (idx === -1) return abs.replace(/[\\\/][^\\\/]*$/, '')
  return abs.slice(0, idx + rootName.length)
}

$('sendPickBtn').addEventListener('click', () => $('sendFolderInput').click())
$('sendFolderInput').addEventListener('change', (e) => {
  const folder = folderPathFromInput(e.target)
  if (!folder) return
  sendFolder = folder
  $('sendFolderLabel').textContent = folder
  $('sendBtn').disabled = false
  log('send folder selected: ' + folder)
})

$('recvPickBtn').addEventListener('click', () => $('recvFolderInput').click())
$('recvFolderInput').addEventListener('change', (e) => {
  const folder = folderPathFromInput(e.target)
  if (!folder) return
  receiveFolder = folder
  $('recvFolderLabel').textContent = folder
  $('recvBtn').disabled = false
  log('receive folder selected: ' + folder)
})
