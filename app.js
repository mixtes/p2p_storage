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
let sendFile = null   // { name, path, size }
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

// --- Send: a single local file -> our Hyperdrive -------------------------
async function pushSendFile () {
  if (!sendFile) return
  const name = '/' + sendFile.name
  const buf = b4a.from(await sendFile.file.arrayBuffer())
  await localDrive.put(name, buf)
  log(`sent ${sendFile.name} (${buf.length} bytes) -> drive v${localDrive.version}`)
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
  if (!sendFile) return alert('Pick a file to send first')
  log('send clicked: ' + sendFile.name + ' (' + sendFile.size + ' bytes), peers=' + peers.size)
  try {
    await pushSendFile()
  } catch (err) {
    log('send error: ' + err.message)
  }
})

$('recvBtn').addEventListener('click', async () => {
  if (!receiveFolder) return alert('Pick a download folder first')
  log('receive clicked, downloadFolder=' + receiveFolder + ', known peers=' + peers.size)
  if (peers.size === 0) log('no peers known yet; downloads will begin as peers arrive')
  for (const peer of peers.values()) {
    try { await startReceiving(peer) } catch (err) { log('recv error: ' + err.message) }
  }
})

// --- Folder pickers (Electron exposes file.path on <input webkitdirectory>) -
function folderPathFromInput (input) {
  const files = input.files
  log('folderPathFromInput: files.length=' + (files ? files.length : 0))
  if (!files || files.length === 0) {
    log('folderPathFromInput: no files selected (empty folder or cancel?)')
    return null
  }
  const file = files[0]
  log('folderPathFromInput: first file name=' + file.name + ' rel=' + (file.webkitRelativePath || '(none)') + ' path=' + (file.path || '(missing)'))
  if (!file.path) {
    log('folderPathFromInput: file.path is empty (Electron may have stripped it)')
    return null
  }
  const rel = file.webkitRelativePath || file.name
  const rootName = rel.split('/')[0]
  const abs = file.path
  const idx = abs.lastIndexOf(rootName)
  const resolved = idx === -1
    ? abs.replace(/[\\\/][^\\\/]*$/, '')
    : abs.slice(0, idx + rootName.length)
  log('folderPathFromInput: resolved=' + resolved)
  return resolved
}

$('sendPickBtn').addEventListener('click', () => {
  log('sendPickBtn click -> opening file picker')
  $('sendFileInput').click()
})
$('sendFileInput').addEventListener('change', (e) => {
  log('sendFileInput change: files=' + (e.target.files ? e.target.files.length : 0))
  const file = e.target.files && e.target.files[0]
  if (!file) {
    log('sendFileInput: no file selected (cancelled?)')
    return
  }
  log('sendFileInput: name=' + file.name + ' size=' + file.size + ' path=' + (file.path || '(missing)') + ' type=' + (file.type || '(none)'))
  sendFile = { file, name: file.name, path: file.path || null, size: file.size }
  $('sendFileLabel').textContent = file.name + ' (' + file.size + ' bytes)'
  $('sendBtn').disabled = false
  log('file selected: ' + file.name + ' (' + file.size + ' bytes)')
})

// --- Native folder picker via a Pear worker (pear-run) ------------------
async function pickFolderNative () {
  log('pickFolderNative: importing pear-run…')
  const mod = await import('pear-run')
  const run = mod.default || mod
  log('pickFolderNative: pear-run loaded, type=' + typeof run)
  return new Promise((resolve, reject) => {
    let pipe
    try {
      log('pickFolderNative: spawning worker ./worker-pick-folder.cjs')
      pipe = run('./worker-pick-folder.cjs')
    } catch (err) {
      log('pickFolderNative: run() threw: ' + err.message)
      return reject(err)
    }
    log('pickFolderNative: worker pipe obtained, waiting for data…')
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    pipe.on('data', (d) => {
      const chunk = decoder.decode(d, { stream: true })
      buf += chunk
      log('worker data chunk: ' + JSON.stringify(chunk))
    })
    pipe.on('error', (err) => {
      log('worker pipe error: ' + err.message)
      reject(err)
    })
    pipe.on('crash', (info) => log('worker crash: exitCode=' + (info && info.exitCode)))
    pipe.on('end', () => {
      const msg = buf.trim()
      log('worker pipe end. total buf=' + JSON.stringify(msg))
      if (msg.startsWith('OK:')) resolve(msg.slice(3))
      else if (msg === 'CANCEL') resolve(null)
      else if (msg.startsWith('ERR:')) reject(new Error(msg.slice(4)))
      else resolve(null)
    })
  })
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

$('recvPickBtn').addEventListener('click', async () => {
  log('opening native folder picker…')
  try {
    const folder = await pickFolderNative()
    if (!folder) {
      log('folder picker cancelled')
      return
    }
    setReceiveFolder(folder)
  } catch (err) {
    log('folder picker error: ' + err.message)
    alert('Could not open folder picker: ' + err.message)
  }
})

// Restore last folder, if any.
try {
  const saved = localStorage.getItem('p2p.receiveFolder')
  if (saved) {
    setReceiveFolder(saved)
    log('restored receive folder: ' + saved)
  }
} catch (err) {
  log('localStorage restore error: ' + err.message)
}
