/**
 * Friend Storage UI
 *
 * Manages three sections inside #view-friend-storage:
 *   1. Friends Network card  — add/remove trusted peers
 *   2. Request Memory view   — store files on a friend's drive
 *   3. Give Memory view      — offer your space, accept/decline requests
 */

import Localdrive from 'localdrive'
import { activity } from '../../core/logger.js'
import { pickFolderNative } from '../../ui/folder-picker.js'
import { retryChannel } from './index.js'

const $ = (id) => document.getElementById(id)

let _manager   = null
let _getPeers  = null
let _selectedFile = null

// ── Public init ───────────────────────────────────────────────────────────────

export function init (manager, getPeers) {
  _manager  = manager
  _getPeers = getPeers

  _bindSubTabs()
  _bindFriendNetwork()
  _bindRequestMemory()
  _bindGiveMemory()

  _refreshAll()
}

// Called by index.js when the swarm peer map changes
export function onPeerChange (peers) {
  _refreshOnlineState(peers)
}

// Called by index.js when the friends list changes
export function onFriendsChanged (friends, peers) {
  _renderPeerList(peers)
  renderFriendList(friends, peers)
  _renderRequestDropdown(friends, peers)
}

// Called by index.js on ledger-changed (incoming requests, accept/decline)
export function onLedgerChanged (manager) {
  renderActiveRequests(manager.getOutgoing(), manager.getFriends())
  _renderPendingRequests(manager.getPendingRequests())
  _renderHosting(manager.getIncoming(), manager.getFriends())
}

// ── Sub-tab router ────────────────────────────────────────────────────────────

function _bindSubTabs () {
  const nav = document.querySelector('.fs-sub-tabs')
  if (!nav) return
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-fs-tab]')
    if (!btn) return
    const tab = btn.dataset.fsTab
    document.querySelectorAll('.fs-sub-tabs [data-fs-tab]').forEach(b => {
      b.classList.toggle('active', b.dataset.fsTab === tab)
    })
    document.querySelectorAll('.fs-view').forEach(v => {
      v.classList.toggle('hidden', v.id !== 'fs-view-' + tab)
    })
  })
}

// ── Friends Network ───────────────────────────────────────────────────────────

function _bindFriendNetwork () {
  // "Add as Friend" delegation on the connected-peers list
  $('fs-peer-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-add-key]')
    if (!btn) return
    const keyHex = btn.dataset.addKey
    const nick   = btn.dataset.addNick || ''
    try { _manager.addFriend(keyHex, nick) } catch (_) {}
  })

  // Remove-button delegation on the friends list
  $('fs-friend-list').addEventListener('click', (e) => {
    const removeBtn = e.target.closest('[data-remove-key]')
    if (removeBtn) {
      _manager.removeFriend(removeBtn.dataset.removeKey)
      return
    }
    const retryBtn = e.target.closest('[data-retry-key]')
    if (retryBtn) {
      retryChannel(retryBtn.dataset.retryKey)
    }
  })
}

// Render the live connected-peers list (with "Add as Friend" if not already one)
function _renderPeerList (peers) {
  const ul = $('fs-peer-list')
  if (!ul) return
  ul.innerHTML = ''

  if (!peers || peers.size === 0) {
    ul.innerHTML = '<li class="empty">No peers connected yet — join a topic first</li>'
    return
  }

  for (const hex of peers.keys()) {
    const isFriend = _manager.isFriend(hex)
    const li = document.createElement('li')
    li.className = 'friend-card'
    li.innerHTML = `
      <span class="fs-dot on"></span>
      <code class="fs-short-key">${hex.slice(0, 8)}…${hex.slice(-4)}</code>
      ${isFriend
        ? '<span class="fs-status-text" style="color:#4ade80">friend</span>'
        : `<button class="fs-add-btn" data-add-key="${hex}">Add as Friend</button>`
      }
    `
    ul.appendChild(li)
  }
}

export function renderFriendList (friends, peers) {
  const ul = $('fs-friend-list')
  if (!ul) return
  const onlineSet = _onlineSet(peers)
  ul.innerHTML = ''

  if (friends.length === 0) {
    ul.innerHTML = '<li class="empty">No friends added yet</li>'
    return
  }

  for (const { keyHex, nick } of friends) {
    const isConnected = onlineSet.has(keyHex)
    const liveness = isConnected
      ? (typeof _manager.livenessFor === 'function' ? _manager.livenessFor(keyHex) : 'live')
      : 'offline'
    // Connected on swarm but no friend-storage channel paired -> let the user retry.
    const showRetry = isConnected && liveness === 'offline'
    const display = nick || (keyHex.slice(0, 8) + '…' + keyHex.slice(-4))
    const li = document.createElement('li')
    li.className = 'friend-card'
    li.innerHTML = `
      <span class="fs-dot fs-dot-${liveness}"></span>
      <span class="fs-nick">${_esc(display)}</span>
      <code class="fs-short-key">${keyHex.slice(0, 8)}…${keyHex.slice(-4)}</code>
      <span class="fs-status-text">${liveness}</span>
      ${showRetry ? `<button class="fs-retry-btn" data-retry-key="${keyHex}" title="Re-open friend-storage channel">Retry</button>` : ''}
      <button class="fs-remove-btn" data-remove-key="${keyHex}">Remove</button>
    `
    ul.appendChild(li)
  }
}

// ── Request Memory ────────────────────────────────────────────────────────────

function _bindRequestMemory () {
  const pickBtn = $('fs-req-pick-btn')
  const fileInput = $('fs-req-file-input')
  const sendBtn = $('fs-req-send-btn')
  if (!pickBtn) return

  pickBtn.addEventListener('click', () => fileInput.click())

  fileInput.addEventListener('change', () => {
    _selectedFile = fileInput.files[0] || null
    $('fs-req-file-label').textContent = _selectedFile ? _selectedFile.name : '(none selected)'
    _updateSendBtn()
  })

  $('fs-req-peer').addEventListener('change', _updateSendBtn)

  // Cancel-button delegation on the active requests list (queued rows only).
  $('fs-req-list').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cancel-key]')
    if (!btn) return
    _manager.cancelOutgoing(btn.dataset.cancelKey, btn.dataset.cancelFile)
  })

  // Retrieve-button delegation on the active requests list.
  $('fs-req-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-retrieve-key]')
    if (!btn) return
    const keyHex = btn.dataset.retrieveKey
    const fileName = btn.dataset.retrieveFile
    btn.disabled = true
    btn.textContent = 'Picking folder…'
    try {
      const folder = await pickFolderNative()
      if (!folder) { btn.disabled = false; btn.textContent = 'Retrieve'; return }
      btn.textContent = 'Retrieving…'
      const buf = await _manager.fetchStorage(keyHex, fileName)
      const drive = new Localdrive(folder)
      await drive.put('/' + fileName, buf)
      activity.info('friend-storage: saved "' + fileName + '" -> ' + folder)
    } catch (err) {
      activity.error('friend-storage: retrieve failed: ' + err.message)
    } finally {
      btn.disabled = false
      btn.textContent = 'Retrieve'
    }
  })

  sendBtn.addEventListener('click', async () => {
    const keyHex = $('fs-req-peer').value
    const limitMB = Number($('fs-req-size-limit').value) || 0
    if (!keyHex || !_selectedFile) return
    sendBtn.disabled = true
    sendBtn.textContent = 'Requesting…'
    try {
      await _manager.requestStorage(keyHex, _selectedFile, limitMB * 1024 * 1024)
    } catch (err) {
      activity.error('friend-storage: request failed: ' + err.message)
    }
    sendBtn.textContent = 'Request Storage'
    _selectedFile = null
    fileInput.value = ''
    $('fs-req-file-label').textContent = '(none selected)'
    _updateSendBtn()
    renderActiveRequests(_manager.getOutgoing(), _manager.getFriends())
  })
}

function _updateSendBtn () {
  const btn = $('fs-req-send-btn')
  if (!btn) return
  const hasPeer = !!$('fs-req-peer').value
  btn.disabled = !(_selectedFile && hasPeer)
}

export function renderActiveRequests (outgoing, friends) {
  const ul = $('fs-req-list')
  if (!ul) return
  ul.innerHTML = ''

  const nickMap = {}
  for (const { keyHex, nick } of friends) nickMap[keyHex] = nick

  let any = false
  for (const [keyHex, files] of outgoing) {
    for (const f of files) {
      any = true
      const display = nickMap[keyHex] || (keyHex.slice(0, 8) + '…')
      const li = document.createElement('li')
      li.className = 'fs-ledger-row'
      const retrieveBtn = f.status === 'hosted'
        ? `<button class="fs-retrieve-btn" data-retrieve-key="${keyHex}" data-retrieve-file="${_esc(f.fileName)}">Retrieve</button>`
        : ''
      const cancelBtn = (f.status === 'queued' || f.status === 'pending')
        ? `<button class="fs-cancel-btn" data-cancel-key="${keyHex}" data-cancel-file="${_esc(f.fileName)}">Cancel</button>`
        : ''
      li.innerHTML = `
        <span class="fs-file-name">${_esc(f.fileName)}</span>
        <span class="fs-ledger-peer">${_esc(display)}</span>
        <span class="badge badge-${f.status}">${f.status}</span>
        ${retrieveBtn}
        ${cancelBtn}
      `
      ul.appendChild(li)
    }
  }
  if (!any) {
    ul.innerHTML = '<li class="empty">No files stored with friends yet</li>'
  }
}

function _renderRequestDropdown (friends, peers) {
  const sel = $('fs-req-peer')
  if (!sel) return
  const onlineSet = _onlineSet(peers)
  const onlineFriends = friends.filter(f => onlineSet.has(f.keyHex))

  sel.innerHTML = ''
  if (onlineFriends.length === 0) {
    const opt = document.createElement('option')
    opt.value = ''
    opt.textContent = '— no online friends —'
    opt.disabled = true
    opt.selected = true
    sel.appendChild(opt)
  } else {
    const placeholder = document.createElement('option')
    placeholder.value = ''
    placeholder.textContent = 'Select a friend…'
    placeholder.disabled = true
    placeholder.selected = true
    sel.appendChild(placeholder)
    for (const { keyHex, nick } of onlineFriends) {
      const opt = document.createElement('option')
      opt.value = keyHex
      opt.textContent = nick || (keyHex.slice(0, 8) + '…' + keyHex.slice(-4))
      sel.appendChild(opt)
    }
  }
  _updateSendBtn()
}

// ── Give Memory ───────────────────────────────────────────────────────────────

function _bindGiveMemory () {
  // The Give-Memory page is purely reactive: it only shows requests that
  // friends have sent. There is no voluntary "offer storage" control.

  // Accept/Decline delegation
  const pending = $('fs-give-pending')
  if (pending) {
    pending.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]')
      if (!btn) return
      const { action, fromKey, fileName } = btn.dataset
      if (action === 'accept') await _manager.acceptRequest(fromKey, fileName)
      if (action === 'decline') await _manager.declineRequest(fromKey, fileName)
      _renderGiveLedger()
    })
  }

  // Evict delegation
  const hosting = $('fs-give-hosting')
  if (hosting) {
    hosting.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-evict-key]')
      if (!btn) return
      await _manager.evictFile(btn.dataset.evictKey, btn.dataset.evictFile)
      _renderGiveLedger()
    })
  }
}

function _renderGiveLedger () {
  _renderPendingRequests(_manager.getPendingRequests())
  _renderHosting(_manager.getIncoming(), _manager.getFriends())
}

function _renderPendingRequests (pending) {
  const ul = $('fs-give-pending')
  if (!ul) return
  ul.innerHTML = ''

  if (pending.length === 0) {
    ul.innerHTML = '<li class="empty">No pending requests</li>'
    return
  }
  for (const req of pending) {
    const display = req.fromKeyHex.slice(0, 8) + '…'
    const li = document.createElement('li')
    li.className = 'fs-ledger-row'
    li.innerHTML = `
      <span class="fs-file-name">${_esc(req.fileName)}</span>
      <span class="fs-ledger-peer">${_esc(display)}</span>
      <span class="fs-size">${_fmtBytes(req.sizeBytes)}</span>
      <button class="fs-accept-btn"
        data-action="accept" data-from-key="${req.fromKeyHex}" data-file-name="${_esc(req.fileName)}">Accept</button>
      <button class="fs-decline-btn"
        data-action="decline" data-from-key="${req.fromKeyHex}" data-file-name="${_esc(req.fileName)}">Decline</button>
    `
    ul.appendChild(li)
  }
}

function _renderHosting (incoming, friends) {
  const ul = $('fs-give-hosting')
  if (!ul) return
  ul.innerHTML = ''

  const nickMap = {}
  for (const { keyHex, nick } of friends) nickMap[keyHex] = nick

  let any = false
  for (const [keyHex, files] of incoming) {
    for (const f of files) {
      any = true
      const display = nickMap[keyHex] || (keyHex.slice(0, 8) + '…')
      const li = document.createElement('li')
      li.className = 'fs-ledger-row'
      li.innerHTML = `
        <span class="fs-nick">${_esc(display)}</span>
        <span class="fs-file-name">${_esc(f.fileName)}</span>
        <span class="fs-size">${_fmtBytes(f.sizeBytes)}</span>
        <button class="fs-evict-btn"
          data-evict-key="${keyHex}" data-evict-file="${_esc(f.fileName)}">Evict</button>
      `
      ul.appendChild(li)
    }
  }
  if (!any) {
    ul.innerHTML = '<li class="empty">Not hosting any files yet</li>'
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _onlineSet (peers) {
  const set = new Set()
  if (!peers) return set
  const map = typeof peers === 'function' ? peers() : peers
  for (const hex of map.keys()) set.add(hex)
  return set
}

function _refreshAll () {
  const friends = _manager.getFriends()
  const peers   = typeof _getPeers === 'function' ? _getPeers() : new Map()
  _renderPeerList(peers)
  renderFriendList(friends, peers)
  _renderRequestDropdown(friends, peers)
  renderActiveRequests(_manager.getOutgoing(), friends)
  _renderGiveLedger()
}

function _refreshOnlineState (peers) {
  const friends = _manager.getFriends()
  _renderPeerList(peers)
  renderFriendList(friends, peers)
  _renderRequestDropdown(friends, peers)
}

function _esc (str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function _fmtBytes (bytes) {
  if (!bytes) return '—'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
