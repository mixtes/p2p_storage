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

const swarm = new Hyperswarm()
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
    log('store.replicate attached for ' + peerId)

    // Exchange drive keys over a dedicated Protomux channel.
    // Raw conn.write / conn.on('data') won't work after store.replicate
    // because Protomux owns the stream.
    const mux = Protomux.from(conn)

    let keyMessage = null

    const channel = mux.createChannel({
      protocol: 'p2p-fileshare-keys',
      onopen () {
        log('key channel open, sending key to ' + peerId)
        keyMessage.send(localDrive.key)
      },
      onclose () {
        log('key channel closed: ' + peerId)
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
    log('key channel opened (local) for ' + peerId)

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
  if (peers.has(hex)) {
    log('onRemoteKey: already known ' + hex.slice(0, 16) + '…')
    return
  }

  const drive = new Hyperdrive(store, key)
  await drive.ready()
  log('remote drive ready: ' + hex.slice(0, 16) + '… (version=' + drive.version + ')')

  const peer = { drive, watcher: null, connPeerId }
  peers.set(hex, peer)
  renderPeers()

  if (receiveFolder) {
    log('receiveFolder already set, starting receive for ' + hex.slice(0, 16) + '…')
    startReceiving(peer)
  } else {
    log('receiveFolder not set yet; waiting for user to press start receiving')
  }
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
  log('pushSendFolder: opening localdrive at ' + sendFolder)
  const local = new Localdrive(sendFolder)
  const mirror = new MirrorDrive(local, localDrive)
  await mirror.done()
  log(`pushed ${sendFolder} -> drive (${mirror.count.add} added, ${mirror.count.change} changed, ${mirror.count.remove} removed)`)
  log('localDrive version after push: ' + localDrive.version)
}

// --- Receive: a peer's Hyperdrive -> local folder, with live updates -----
async function startReceiving(peer) {
  if (peer.watcher) {
    log('startReceiving: already watching this peer')
    return
  }
  const peerHex = b4a.toString(peer.drive.key, 'hex').slice(0, 16)
  log('startReceiving: peer=' + peerHex + '… version=' + peer.drive.version + ' -> ' + receiveFolder)
  const local = new Localdrive(receiveFolder)

  const sync = async () => {
    log('sync: starting (peer drive version=' + peer.drive.version + ')')
    const mirror = new MirrorDrive(peer.drive, local)
    await mirror.done()
    log(`sync: done (${mirror.count.add} added, ${mirror.count.change} changed, ${mirror.count.remove} removed)`)
  }

  try {
    await sync()
  } catch (err) {
    log('initial sync error: ' + err.message)
  }

  // Hyperdrive.watch() yields whenever the remote drive's tree changes.
  log('starting watcher on peer ' + peerHex + '…')
  peer.watcher = peer.drive.watch('/')
  ;(async () => {
    for await (const _ of peer.watcher) {
      log('watcher: change detected on peer ' + peerHex + '… new version=' + peer.drive.version)
      try { await sync() } catch (err) { log('sync error: ' + err.message) }
    }
    log('watcher: ended for peer ' + peerHex + '…')
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
  log('joined topic ' + b4a.toString(topic, 'hex').slice(0, 16) + '…')

  // Ensure all pending peer connections are attempted
  await swarm.flush()
  setStatus('listening on topic ' + b4a.toString(topic, 'hex').slice(0, 12), true)
  log('swarm flushed – ready for peers')
})

$('sendBtn').addEventListener('click', async () => {
  const v = $('sendFolder').value.trim()
  if (!v) return alert('Enter an absolute folder path to share')
  sendFolder = v
  log('mirror->drive clicked, sendFolder=' + sendFolder + ', peers=' + peers.size)
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
  log('start receiving clicked, receiveFolder=' + receiveFolder + ', known peers=' + peers.size)
  if (peers.size === 0) log('no peers known yet; will start receiving as soon as a peer key arrives')
  for (const peer of peers.values()) {
    try { await startReceiving(peer) } catch (err) { log('recv error: ' + err.message) }
  }
})
