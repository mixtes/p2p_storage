/* global Pear */
import Hyperswarm from 'hyperswarm'
import Hyperdrive from 'hyperdrive'
import Protomux from 'protomux'
import c from 'compact-encoding'
import cryptoLib from 'hypercore-crypto'
import b4a from 'b4a'
import { activity, dev } from './logger.js'
import { getStore, getLocalDrive } from './store.js'
import { attachReplicationChannel } from './replication-protocol.js'

let swarm = null
let joined = false

// remoteKeyHex -> { drive, watcher, connPeerId }
const peers = new Map()

let replicationHandlers = null

const listeners = {
  peerAdd: [],
  peerRemove: [],
  join: [],
  replicationPeer: [],
  replicationPeerRemove: []
}

export function on (event, fn) {
  if (listeners[event]) listeners[event].push(fn)
}

function emit (event, ...args) {
  for (const fn of listeners[event] || []) fn(...args)
}

export async function init () {
  const { teardown } = Pear

  swarm = new Hyperswarm({
    maxPeers: 8,
    maxParallel: 4,
    maxClientConnections: 4,
    maxServerConnections: 4
  })
  teardown(async () => {
    for (const peer of peers.values()) {
      if (peer.watcher) { try { await peer.watcher.destroy() } catch {} }
    }
    peers.clear()
    try { await swarm.destroy() } catch {}
  })

  swarm.on('error', (err) => dev.error('[network] swarm error:', err))
  swarm.on('connection', handleConnection)
}

function handleConnection (conn, info) {
  const store = getStore()
  const localDrive = getLocalDrive()

  try {
    const peerId = b4a.toString(conn.remotePublicKey, 'hex').slice(0, 12)
    activity.info('peer connected: ' + peerId)
    dev.debug('[network] connection from', peerId, info)

    store.replicate(conn)

    /* ── file-sharing key exchange channel ──────────────────────────── */

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
        try {
          await onRemoteKey(remoteKey, peerId, mux)
        } catch (err) {
          dev.error('[network] peer setup error (' + peerId + '):', err)
        }
      }
    })

    channel.open()

    /* ── replication protocol channel ───────────────────────────────── */

    if (replicationHandlers) {
      const rpc = attachReplicationChannel(conn, replicationHandlers, peerId)
      emit('replicationPeer', peerId, rpc)
    }

    conn.on('error', (err) => dev.error('[network] conn error (' + peerId + '):', err))
    conn.on('close', () => {
      activity.info('peer disconnected: ' + peerId)
      removePeerByConn(peerId)
      emit('replicationPeerRemove', peerId)
    })
  } catch (err) {
    dev.error('[network] connection handler error:', err)
  }
}

async function onRemoteKey (key, connPeerId, mux) {
  const store = getStore()
  const hex = b4a.toString(key, 'hex')
  if (peers.has(hex)) return

  const drive = new Hyperdrive(store, key)
  await drive.ready()
  activity.info('remote drive ready: ' + hex.slice(0, 16) + '… (v' + drive.version + ')')

  try { drive.download('/') } catch (err) { dev.error('[network] prefetch error:', err) }

  const peer = { drive, watcher: null, connPeerId, mux }
  peers.set(hex, peer)
  emit('peerAdd', peer, hex)
}

function removePeerByConn (connPeerId) {
  for (const [hex, peer] of peers) {
    if (peer.connPeerId === connPeerId) {
      if (peer.watcher) peer.watcher.destroy()
      peers.delete(hex)
      emit('peerRemove', hex)
      break
    }
  }
}

export function joinTopic (code) {
  if (joined) return null
  const topic = cryptoLib.hash(b4a.from('p2p-fileshare:' + code))
  activity.info('joining topic ' + b4a.toString(topic, 'hex').slice(0, 16) + '… (code="' + code + '")')
  swarm.join(topic, { client: true, server: true })
  joined = true
  const topicHex = b4a.toString(topic, 'hex')
  emit('join', topicHex)
  activity.info('joined – peers will connect as they are discovered')
  return topicHex
}

export function isJoined () {
  return joined
}

export function getPeers () {
  return peers
}

export function getSwarm () {
  return swarm
}

/**
 * Register the replication protocol handlers. Called once during boot
 * by the replication feature's init(). All subsequent connections will
 * automatically open the p2p-replication Protomux channel.
 */
export function setReplicationHandlers (handlers) {
  replicationHandlers = handlers
}
