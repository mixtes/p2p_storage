/**
 * Friend Storage Manager
 *
 * Tracks trusted friends (by drive key hex) and the favour ledger.
 * Friends list and quota are persisted in localStorage.
 * File data received from peers is held in-memory (_incomingData).
 */

import b4a from 'b4a'
import { log } from '../../core/logger.js'

const LS_FRIENDS = 'fs-friends'
const LS_QUOTA   = 'fs-quota'

const listeners = { 'friends-changed': [], 'ledger-changed': [] }

function emit (event, ...args) {
  for (const fn of listeners[event] || []) fn(...args)
}

export class FriendStorageManager {
  constructor () {
    this._friends      = new Map()  // keyHex → { nick, addedAt }
    this._quota        = 0          // bytes I'm willing to offer
    this._outgoing     = new Map()  // keyHex → [{ fileName, sizeBytes, status }]
    this._incoming     = new Map()  // keyHex → [{ fileName, sizeBytes, status }]
    this._incomingData = new Map()  // `${keyHex}:${fileName}` → Buffer
    this._pending      = []         // [{ fromKeyHex, fileName, sizeBytes }]
    this._channels     = new Map()  // keyHex → { sendRequest, sendAccept, sendDecline }
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
      keyHex,
      nick: meta.nick,
      addedAt: meta.addedAt
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

  getQuota () {
    return this._quota
  }

  // ── Channel registry (called by sync.js) ──────────────────────────

  registerChannel (keyHex, api) {
    this._channels.set(keyHex, api)
  }

  unregisterChannel (keyHex) {
    this._channels.delete(keyHex)
  }

  // ── Outgoing: request storage from a friend ───────────────────────

  async requestStorage (keyHex, file, sizeLimitBytes) {
    const ch = this._channels.get(keyHex)
    if (!ch) {
      log('friend-storage: no open channel to ' + keyHex.slice(0, 12) + '…')
      return
    }

    const data = b4a.from(await file.arrayBuffer())
    ch.sendRequest(file.name, data)

    const list = this._outgoing.get(keyHex) || []
    list.push({ fileName: file.name, sizeBytes: file.size, status: 'pending' })
    this._outgoing.set(keyHex, list)
    emit('ledger-changed')
    log('friend-storage: sent request for "' + file.name + '" to ' + keyHex.slice(0, 12) + '…')
  }

  // ── Incoming: receive a request from a friend (called by sync.js) ─

  _onIncomingRequest (fromKeyHex, fileName, data) {
    if (!this.isFriend(fromKeyHex)) return  // ignore non-friends

    const key = fromKeyHex + ':' + fileName
    this._incomingData.set(key, data)

    this._pending.push({ fromKeyHex, fileName, sizeBytes: data.byteLength })
    emit('ledger-changed')
    log('friend-storage: incoming request for "' + fileName + '" from ' + fromKeyHex.slice(0, 12) + '…')
  }

  async acceptRequest (fromKeyHex, fileName) {
    const ch = this._channels.get(fromKeyHex)
    if (ch) ch.sendAccept(fileName)

    this._pending = this._pending.filter(
      r => !(r.fromKeyHex === fromKeyHex && r.fileName === fileName)
    )

    const dataKey = fromKeyHex + ':' + fileName
    const sizeBytes = (this._incomingData.get(dataKey) || { byteLength: 0 }).byteLength

    const list = this._incoming.get(fromKeyHex) || []
    list.push({ fileName, sizeBytes, status: 'hosted' })
    this._incoming.set(fromKeyHex, list)
    emit('ledger-changed')
    log('friend-storage: accepted "' + fileName + '" from ' + fromKeyHex.slice(0, 12) + '…')
  }

  async declineRequest (fromKeyHex, fileName) {
    const ch = this._channels.get(fromKeyHex)
    if (ch) ch.sendDecline(fileName)

    this._pending = this._pending.filter(
      r => !(r.fromKeyHex === fromKeyHex && r.fileName === fileName)
    )
    this._incomingData.delete(fromKeyHex + ':' + fileName)
    emit('ledger-changed')
  }

  async evictFile (fromKeyHex, fileName) {
    this._incomingData.delete(fromKeyHex + ':' + fileName)
    const list = (this._incoming.get(fromKeyHex) || []).filter(f => f.fileName !== fileName)
    if (list.length === 0) this._incoming.delete(fromKeyHex)
    else this._incoming.set(fromKeyHex, list)
    emit('ledger-changed')
  }

  // ── Response callbacks (called by sync.js) ────────────────────────

  _onRequestAccepted (fromKeyHex, fileName) {
    this._updateOutgoingStatus(fromKeyHex, fileName, 'hosted')
    log('friend-storage: "' + fileName + '" accepted by ' + fromKeyHex.slice(0, 12) + '…')
    emit('ledger-changed')
  }

  _onRequestDeclined (fromKeyHex, fileName) {
    this._updateOutgoingStatus(fromKeyHex, fileName, 'declined')
    log('friend-storage: "' + fileName + '" declined by ' + fromKeyHex.slice(0, 12) + '…')
    emit('ledger-changed')
  }

  _updateOutgoingStatus (keyHex, fileName, status) {
    const list = this._outgoing.get(keyHex)
    if (!list) return
    const entry = list.find(f => f.fileName === fileName)
    if (entry) entry.status = status
  }

  // ── Accounting ────────────────────────────────────────────────────

  getOutgoing () { return this._outgoing }
  getIncoming () { return this._incoming }
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
      const obj = {}
      for (const [k, v] of this._friends) obj[k] = v
      localStorage.setItem(LS_FRIENDS, JSON.stringify(obj))
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
  }
}
