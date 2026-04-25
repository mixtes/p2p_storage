/* global Pear */
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import Hyperswarm from 'hyperswarm'
import Localdrive from 'localdrive'
import MirrorDrive from 'mirror-drive'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

const { teardown, config } = Pear

// --- Corestore + our writable Hyperdrive ----------------------------------
// Corestore lives in Pear's per-app storage so the same drive key persists
// across restarts. namespace('local') keeps room for future drives.
const store = new Corestore(config.storage)
await store.ready()

const localDrive = new Hyperdrive(store.namespace('local'))
await localDrive.ready()

// --- Hyperswarm (peer discovery + transport) ------------------------------
const swarm = new Hyperswarm()
teardown(() => swarm.destroy())

// State
const peers = new Map()        // remoteKey hex -> { drive, watcher }
let receiveFolder = null
let sendFolder = null
let joined = false

// --- DOM helpers ----------------------------------------------------------
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

// --- Wire each new connection --------------------------------------------
swarm.on('connection', (conn, info) => {
  const peerId = b4a.toString(info.publicKey, 'hex').slice(0, 12)
  log('peer connected: ' + peerId)

  // Replicate the corestore over this socket. Once we know each other's
  // drive keys, both sides can read each other's drives through this stream.
  store.replicate(conn)

  // Send our drive key first thing.
  conn.write(localDrive.key)

  // Read the first 32 bytes from the peer = their drive key.
  let buf = b4a.alloc(0)
  let gotKey = false
  conn.on('data', (data) => {
    if (gotKey) return
    buf = b4a.concat([buf, data])
    if (buf.length >= 32) {
      gotKey = true
      onRemoteKey(buf.subarray(0, 32)).catch((err) =>
        log('peer setup error: ' + err.message)
      )
    }
  })
  conn.on('error', (err) => log('conn error: ' + err.message))
  conn.on('close', () => log('peer disconnected: ' + peerId))
})

async function onRemoteKey(key) {
  const hex = b4a.toString(key, 'hex')
  if (peers.has(hex)) return

  const drive = new Hyperdrive(store, key)
  await drive.ready()

  const peer = { drive, watcher: null }
  peers.set(hex, peer)
  log('remote drive: ' + hex.slice(0, 16) + '…')
  renderPeers()

  if (receiveFolder) startReceiving(peer)
}

function renderPeers() {
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
  log(`pushed ${sendFolder} -> drive (${mirror.count.add} added, ${mirror.count.change} changed, ${mirror.count.remove} removed)`)
}

// --- Receive: a peer's Hyperdrive -> local folder, with live updates -----
async function startReceiving(peer) {
  if (peer.watcher) return
  const local = new Localdrive(receiveFolder)

  const sync = async () => {
    const mirror = new MirrorDrive(peer.drive, local)
    await mirror.done()
    if (mirror.count.add || mirror.count.change || mirror.count.remove) {
      log(`synced from peer (${mirror.count.add} added, ${mirror.count.change} changed, ${mirror.count.remove} removed)`)
    }
  }

  await sync()

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
  const discovery = swarm.join(topic, { client: true, server: true })
  joined = true
  $('joinBtn').disabled = true
  setStatus('joining…')
  await discovery.flushed()
  setStatus('listening on topic ' + b4a.toString(topic, 'hex').slice(0, 12), true)
  log('joined topic ' + b4a.toString(topic, 'hex').slice(0, 16) + '…')
})

$('sendBtn').addEventListener('click', async () => {
  const v = $('sendFolder').value.trim()
  if (!v) return alert('Enter an absolute folder path to share')
  sendFolder = v
  try {
    await pushSendFolder()
  } catch (err) {
    log('send error: ' + err.message)
  }
})

$('recvBtn').addEventListener('click', async () => {
  const v = $('recvFolder').value.trim()
  if (!v) return alert('Enter an absolute folder path to download into')
  receiveFolder = v
  log('receive folder set: ' + receiveFolder)
  for (const peer of peers.values()) {
    try { await startReceiving(peer) } catch (err) { log('recv error: ' + err.message) }
  }
})
