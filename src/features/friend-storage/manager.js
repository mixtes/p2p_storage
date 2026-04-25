/**
 * Friend Storage Manager
 *
 * Tracks trusted friends (by drive key hex) and the favour ledger:
 *   _outgoing   — files I parked with friends
 *   _incoming   — files I'm hosting for friends (mirror of disk-store layout)
 *   _pending    — incoming requests awaiting accept/decline
 *   _channels   — open Protomux channels per peer
 *   _outboundQueue — requests/fetches queued while a friend is offline
 *   _pendingFetches — outstanding fetchStorage() promises (with timers)
 *   _lastPong   — last ping/pong timestamp per peer (keep-alive)
 *
 * Friends list, quota, and the outgoing/incoming ledgers persist in
 * localStorage. Hosted file bytes persist via disk-store.js.
 */

import b4a from 'b4a'
import { activity, dev } from '../../core/logger.js'
import * as diskStore from './disk-store.js'

const LS_FRIENDS  = 'fs-friends'
const LS_QUOTA    = 'fs-quota'
const LS_OUTGOING = 'fs-outgoing'
const LS_INCOMING = 'fs-incoming'

const FETCH_TIMEOUT_MS  = 30_000
const PING_INTERVAL_MS  = 15_000
const STALE_AFTER_MS    = 30_000
const OFFLINE_AFTER_MS  = 90_000

const listeners = {
  'friends-changed': [],
  'ledger-changed': [],
  'liveness-changed': []
}

function emit (event, ...args) {
  for (const fn of listeners[event] || []) fn(...args)
}

export class FriendStorageManager {
  constructor () {
    this._friends         = new Map()  // keyHex → { nick, addedAt }
    this._quota           = 0          // bytes I'm willing to offer
    this._outgoing        = new Map()  // keyHex → [{ fileName, sizeBytes, status }]
    this._incoming        = new Map()  // keyHex → [{ fileName, sizeBytes, status }]
    this._incomingData    = new Map()  // `${hex}:${name}` → Buffer (until accept)
    this._pending         = []         // [{ fromKeyHex, fileName, sizeBytes }]
    this._channels        = new Map()  // keyHex → api
    this._outboundQueue   = new Map()  // keyHex → [{ kind, fileName, data? }]
    this._pendingFetches  = new Map()  // `${hex}:${name}` → { resolve, reject, timer }
    this._lastPong        = new Map()  // keyHex → timestamp
    this._pingTimers      = new Map()  // keyHex → interval id
    this._load()
  }

  on (event, fn) {
    if (listeners[event]) listeners[event].push(fn)
  }

  // ── Friends list ──────────────────────────────────────────────────

  addFriend (keyHex, nick) {
    keyHex = keyHex.trim().toLowerCase()
    if (keyHex.length !== 64 || !/^[0-9a-f]+$/.test(keyHex)) {
      throw new Error('Invalid key — must be a 64-character hex string.')
    }
    if (this._friends.has(keyHex)) {
      throw new Error('This key is already in your friends list.')
    }
    this._friends.set(keyHex, { nick: nick.trim() || null, addedAt: Date.now() })
    this._save()
    emit('friends-changed')
  }

  removeFriend (keyHex) {
    this._friends.delete(keyHex)
    this._save()
    emit('friends-changed')
  }

  getFriends () {
    return Array.from(this._friends.entries()).map(([keyHex, meta]) => ({
      keyHex, nick: meta.nick, addedAt: meta.addedAt
    }))
  }

  isFriend (keyHex) {
    return this._friends.has(keyHex.toLowerCase())
  }

  // ── Quota ─────────────────────────────────────────────────────────

  saveQuota (bytes) {
    this._quota = Math.max(0, bytes)
    try { localStorage.setItem(LS_QUOTA, String(this._quota)) } catch (_) {}
    emit('ledger-changed')
  }

  getQuota () { return this._quota }

  // ── Channel registry (called by sync.js on channel open/close) ────

  _channelExists (keyHex) {
    return this._channels.has(keyHex)
  }

  registerChannel (keyHex, api) {
    this._channels.set(keyHex, api)
    this._lastPong.set(keyHex, Date.now())  // assume live until proven otherwise
    this._startPing(keyHex)
    this._flushOutboundQueue(keyHex)
    emit('liveness-changed')
  }

  unregisterChannel (keyHex) {
    this._channels.delete(keyHex)
    this._stopPing(keyHex)
    this._lastPong.delete(keyHex)
    // Reject any in-flight fetches to/from this peer.
    for (const [k, p] of this._pendingFetches) {
      if (k.startsWith(keyHex + ':')) {
        clearTimeout(p.timer)
        this._pendingFetches.delete(k)
        p.reject(new Error('peer disconnected'))
      }
    }
    emit('liveness-changed')
  }

  // ── Outgoing: request a friend host a file for me ─────────────────

  async requestStorage (keyHex, file, _sizeLimitBytes) {
    keyHex = keyHex.toLowerCase()
    const data = b4a.from(await file.arrayBuffer())
    const fileName = file.name
    const sizeBytes = file.size

    const list = this._outgoing.get(keyHex) || []
    list.push({ fileName, sizeBytes, status: 'pending' })
    this._outgoing.set(keyHex, list)
    this._save()
    emit('ledger-changed')

    const ch = this._channels.get(keyHex)
    if (ch) {
      try {
        ch.sendRequest(fileName, data)
        activity.info('friend-storage: sent "' + fileName + '" to ' + keyHex.slice(0, 12) + '…')
      } catch (err) {
        dev.error('[fs] sendRequest failed:', err)
        this._enqueue(keyHex, { kind: 'request', fileName, data })
        this._updateOutgoingStatus(keyHex, fileName, 'queued')
        emit('ledger-changed')
      }
      return
    }

    // No channel yet → queue and let _flushOutboundQueue fire on registerChannel.
    this._enqueue(keyHex, { kind: 'request', fileName, data })
    this._updateOutgoingStatus(keyHex, fileName, 'queued')
    this._save()
    emit('ledger-changed')
    activity.warn('friend-storage: no open channel to ' + keyHex.slice(0, 12) + '\u2026 \u2014 "' + fileName + '" queued (will send when channel opens)')
  }

  _enqueue (keyHex, item) {
    const q = this._outboundQueue.get(keyHex) || []
    q.push(item)
    this._outboundQueue.set(keyHex, q)
  }

  _flushOutboundQueue (keyHex) {
    const q = this._outboundQueue.get(keyHex)
    if (!q || q.length === 0) return
    const ch = this._channels.get(keyHex)
    if (!ch) return
    this._outboundQueue.delete(keyHex)
    for (const item of q) {
      try {
        if (item.kind === 'request') {
          ch.sendRequest(item.fileName, item.data)
          this._updateOutgoingStatus(keyHex, item.fileName, 'pending')
          activity.info('friend-storage: sent queued "' + item.fileName + '" to ' + keyHex.slice(0, 12) + '…')
        } else if (item.kind === 'fetch') {
          ch.sendFetch(item.fileName)
          activity.info('friend-storage: requested "' + item.fileName + '" back from ' + keyHex.slice(0, 12) + '…')
        }
      } catch (err) {
        dev.error('[fs] flush failed:', err)
        // Re-queue the failed item.
        this._enqueue(keyHex, item)
      }
    }
    this._save()
    emit('ledger-changed')
  }

  // ── Incoming requests (giver side) ────────────────────────────────

  _onIncomingRequest (fromKeyHex, fileName, data) {
    if (!this.isFriend(fromKeyHex)) {
      dev.warn('[fs] ignoring request from non-friend', fromKeyHex.slice(0, 12))
      return
    }
    const key = fromKeyHex + ':' + fileName
    this._incomingData.set(key, data)
    this._pending.push({ fromKeyHex, fileName, sizeBytes: data.byteLength })
    emit('ledger-changed')
    activity.info('friend-storage: incoming "' + fileName + '" from ' + fromKeyHex.slice(0, 12) + '…')
  }

  async acceptRequest (fromKeyHex, fileName) {
    const dataKey = fromKeyHex + ':' + fileName
    const buf = this._incomingData.get(dataKey)
    if (!buf) {
      activity.error('friend-storage: data missing for "' + fileName + '"')
      return
    }

    try {
      await diskStore.putFile(fromKeyHex, fileName, buf)
    } catch (err) {
      activity.error('friend-storage: disk write failed for "' + fileName + '": ' + err.message)
      dev.error('[fs] disk write failed:', err)
      return
    }

    const ch = this._channels.get(fromKeyHex)
    if (ch) {
      try { ch.sendAccept(fileName) } catch (err) { dev.error('[fs] sendAccept failed:', err) }
    } else {
      dev.warn('[fs] accepted "' + fileName + '" but no channel to notify ' + fromKeyHex.slice(0, 12))
    }

    this._pending = this._pending.filter(
      r => !(r.fromKeyHex === fromKeyHex && r.fileName === fileName)
    )
    this._incomingData.delete(dataKey)

    const list = this._incoming.get(fromKeyHex) || []
    if (!list.find(f => f.fileName === fileName)) {
      list.push({ fileName, sizeBytes: buf.byteLength, status: 'hosted' })
      this._incoming.set(fromKeyHex, list)
    }
    this._save()
    emit('ledger-changed')
    activity.info('friend-storage: now hosting "' + fileName + '" for ' + fromKeyHex.slice(0, 12) + '…')
  }

  async declineRequest (fromKeyHex, fileName) {
    const ch = this._channels.get(fromKeyHex)
    if (ch) {
      try { ch.sendDecline(fileName) } catch (err) { dev.error('[fs] sendDecline failed:', err) }
    }
    this._pending = this._pending.filter(
      r => !(r.fromKeyHex === fromKeyHex && r.fileName === fileName)
    )
    this._incomingData.delete(fromKeyHex + ':' + fileName)
    emit('ledger-changed')
    activity.info('friend-storage: declined "' + fileName + '" from ' + fromKeyHex.slice(0, 12) + '…')
  }

  async evictFile (fromKeyHex, fileName) {
    await diskStore.deleteFile(fromKeyHex, fileName)
    this._incomingData.delete(fromKeyHex + ':' + fileName)
    const list = (this._incoming.get(fromKeyHex) || []).filter(f => f.fileName !== fileName)
    if (list.length === 0) this._incoming.delete(fromKeyHex)
    else this._incoming.set(fromKeyHex, list)
    this._save()
    emit('ledger-changed')
    activity.info('friend-storage: evicted "' + fileName + '"')
  }

  // ── Response callbacks (requester side) ───────────────────────────

  _onRequestAccepted (fromKeyHex, fileName) {
    this._updateOutgoingStatus(fromKeyHex, fileName, 'hosted')
    this._save()
    emit('ledger-changed')
    activity.info('friend-storage: "' + fileName + '" hosted by ' + fromKeyHex.slice(0, 12) + '…')
  }

  _onRequestDeclined (fromKeyHex, fileName) {
    this._updateOutgoingStatus(fromKeyHex, fileName, 'declined')
    this._save()
    emit('ledger-changed')
    activity.warn('friend-storage: "' + fileName + '" declined by ' + fromKeyHex.slice(0, 12) + '…')
  }

  _updateOutgoingStatus (keyHex, fileName, status) {
    const list = this._outgoing.get(keyHex)
    if (!list) return
    const entry = list.find(f => f.fileName === fileName)
    if (entry) entry.status = status
  }

  // Cancel an outgoing entry that hasn't been delivered yet (status: queued).
  // Drops the file bytes from the outbound queue and removes the ledger row.
  cancelOutgoing (keyHex, fileName) {
    keyHex = keyHex.toLowerCase()

    // Remove the matching item from the outbound queue (if any).
    const q = this._outboundQueue.get(keyHex)
    if (q) {
      const filtered = q.filter(item => !(item.fileName === fileName && item.kind === 'request'))
      if (filtered.length === 0) this._outboundQueue.delete(keyHex)
      else this._outboundQueue.set(keyHex, filtered)
    }

    // Remove the ledger row.
    const list = this._outgoing.get(keyHex)
    if (list) {
      const next = list.filter(f => f.fileName !== fileName)
      if (next.length === 0) this._outgoing.delete(keyHex)
      else this._outgoing.set(keyHex, next)
    }

    this._save()
    emit('ledger-changed')
    activity.info('friend-storage: cancelled "' + fileName + '"')
  }

  // ── Retrieve flow (Phase C) ───────────────────────────────────────

  // Requester: ask the host to send the file back. Returns a Promise that
  // resolves to a Buffer with the file bytes, or rejects on timeout/error.
  fetchStorage (friendHex, fileName) {
    friendHex = friendHex.toLowerCase()
    const key = friendHex + ':' + fileName
    if (this._pendingFetches.has(key)) {
      return Promise.reject(new Error('a fetch for this file is already in flight'))
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pendingFetches.has(key)) {
          this._pendingFetches.delete(key)
          reject(new Error('retrieve timed out — friend offline?'))
        }
      }, FETCH_TIMEOUT_MS)
      this._pendingFetches.set(key, { resolve, reject, timer })

      const ch = this._channels.get(friendHex)
      if (ch) {
        try {
          ch.sendFetch(fileName)
          activity.info('friend-storage: requested "' + fileName + '" back from ' + friendHex.slice(0, 12) + '…')
        } catch (err) {
          this._pendingFetches.delete(key)
          clearTimeout(timer)
          reject(err)
        }
      } else {
        this._enqueue(friendHex, { kind: 'fetch', fileName })
        activity.warn('friend-storage: friend offline — fetch queued')
      }
    })
  }

  // Host: peer asked for a file we host for them. Read & send back, or send
  // FETCH_ERR if not found / IO error.
  async _onIncomingFetch (fromKeyHex, fileName) {
    const ch = this._channels.get(fromKeyHex)
    if (!ch) return  // peer vanished

    if (!this.isFriend(fromKeyHex)) {
      dev.warn('[fs] fetch from non-friend ignored', fromKeyHex.slice(0, 12))
      try { ch.sendFetchErr(fileName, 'not a friend') } catch {}
      return
    }

    let buf = null
    try {
      buf = await diskStore.getFile(fromKeyHex, fileName)
    } catch (err) {
      dev.error('[fs] disk read failed:', err)
      try { ch.sendFetchErr(fileName, 'disk read failed') } catch {}
      return
    }

    if (!buf) {
      try { ch.sendFetchErr(fileName, 'not found') } catch {}
      return
    }

    try {
      ch.sendFetchData(fileName, buf)
      activity.info('friend-storage: sent "' + fileName + '" back to ' + fromKeyHex.slice(0, 12) + '…')
    } catch (err) {
      dev.error('[fs] sendFetchData failed:', err)
    }
  }

  _onFetchData (fromKeyHex, { fileName, data }) {
    const key = fromKeyHex + ':' + fileName
    const p = this._pendingFetches.get(key)
    if (!p) {
      dev.warn('[fs] received fetch-data for unknown request', key.slice(0, 24))
      return
    }
    clearTimeout(p.timer)
    this._pendingFetches.delete(key)
    p.resolve(b4a.from(data))
  }

  _onFetchError (fromKeyHex, { fileName, reason }) {
    const key = fromKeyHex + ':' + fileName
    const p = this._pendingFetches.get(key)
    if (!p) return
    clearTimeout(p.timer)
    this._pendingFetches.delete(key)
    p.reject(new Error(reason || 'fetch failed'))
  }

  // ── Keep-alive (Phase E) ──────────────────────────────────────────

  _startPing (keyHex) {
    this._stopPing(keyHex)
    const id = setInterval(() => {
      const ch = this._channels.get(keyHex)
      if (!ch) { this._stopPing(keyHex); return }
      try { ch.sendPing(Date.now()) } catch (err) { dev.error('[fs] ping failed:', err) }
      // Re-evaluate liveness so UI dot updates as time passes between pongs.
      emit('liveness-changed')
    }, PING_INTERVAL_MS)
    this._pingTimers.set(keyHex, id)
  }

  _stopPing (keyHex) {
    const id = this._pingTimers.get(keyHex)
    if (id) clearInterval(id)
    this._pingTimers.delete(keyHex)
  }

  _onPong (keyHex, _ts) {
    this._lastPong.set(keyHex, Date.now())
    emit('liveness-changed')
  }

  // 'live' | 'stale' | 'offline'
  livenessFor (keyHex) {
    if (!this._channels.has(keyHex)) return 'offline'
    const last = this._lastPong.get(keyHex) || 0
    const age = Date.now() - last
    if (age < STALE_AFTER_MS) return 'live'
    if (age < OFFLINE_AFTER_MS) return 'stale'
    return 'offline'
  }

  // ── Accounting ────────────────────────────────────────────────────

  getOutgoing ()        { return this._outgoing }
  getIncoming ()        { return this._incoming }
  getPendingRequests () { return this._pending }

  totalHostedBytes () {
    let total = 0
    for (const files of this._incoming.values()) {
      for (const f of files) total += f.sizeBytes || 0
    }
    return total
  }

  // ── Persistence ───────────────────────────────────────────────────

  _save () {
    try {
      const friends = {}
      for (const [k, v] of this._friends) friends[k] = v
      localStorage.setItem(LS_FRIENDS, JSON.stringify(friends))
    } catch (_) {}
    try {
      const out = {}
      for (const [k, v] of this._outgoing) out[k] = v
      localStorage.setItem(LS_OUTGOING, JSON.stringify(out))
    } catch (_) {}
    try {
      const inc = {}
      for (const [k, v] of this._incoming) inc[k] = v
      localStorage.setItem(LS_INCOMING, JSON.stringify(inc))
    } catch (_) {}
  }

  _load () {
    try {
      const raw = localStorage.getItem(LS_FRIENDS)
      if (raw) {
        const obj = JSON.parse(raw)
        for (const [k, v] of Object.entries(obj)) this._friends.set(k, v)
      }
    } catch (_) {}
    try {
      const q = Number(localStorage.getItem(LS_QUOTA))
      if (!isNaN(q) && q > 0) this._quota = q
    } catch (_) {}
    try {
      const raw = localStorage.getItem(LS_OUTGOING)
      if (raw) {
        const obj = JSON.parse(raw)
        for (const [k, v] of Object.entries(obj)) {
          // Anything left as 'pending' across a restart had no ack; treat as
          // 'queued' so a future Send will redo it explicitly via the UI.
          for (const f of v) if (f.status === 'pending') f.status = 'queued'
          this._outgoing.set(k, v)
        }
      }
    } catch (_) {}
    try {
      const raw = localStorage.getItem(LS_INCOMING)
      if (raw) {
        const obj = JSON.parse(raw)
        for (const [k, v] of Object.entries(obj)) this._incoming.set(k, v)
      }
    } catch (_) {}
  }
}
