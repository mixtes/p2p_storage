import { activity } from '../../core/logger.js'
import { getConnectedPeers } from '../replication/manager.js'
import * as manager from './manager.js'
import { uploadToFriend, downloadFromFriend } from './sync.js'

const $ = (id) => document.getElementById(id)

let fsFile = null
let selectedFriend = null // { publicKey, label }

export function init () {
  // Sub-tabs
  for (const btn of document.querySelectorAll('[data-fs-subtab]')) {
    btn.addEventListener('click', () => switchSubtab(btn.dataset.fsSubtab))
  }

  // Add Friend / Send Request
  $('fsAddFriendBtn').addEventListener('click', () => {
    toggleRequestsPanel(false)
    toggleAddFriendForm(!$('fsAddFriendForm').classList.contains('hidden') ? false : true)
  })
  $('fsAddFriendCancelBtn').addEventListener('click', () => toggleAddFriendForm(false))
  $('fsAddFriendConfirmBtn').addEventListener('click', handleSendRequest)
  $('fsFriendKeyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendRequest()
    if (e.key === 'Escape') toggleAddFriendForm(false)
  })
  $('fsFriendNoteInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleSendRequest()
    if (e.key === 'Escape') toggleAddFriendForm(false)
  })

  // Friend Requests panel
  $('fsRequestsBtn').addEventListener('click', () => {
    toggleAddFriendForm(false)
    toggleRequestsPanel(!$('fsRequestsPanel').classList.contains('hidden') ? false : true)
  })

  // Detail panel back button
  $('fsDeselectBtn').addEventListener('click', () => selectFriend(null))

  // Offer (global)
  $('fsOfferBtn').addEventListener('click', handleSaveOffer)

  // Send / file pick
  $('fsPickBtn').addEventListener('click', () => $('fsFileInput').click())
  $('fsFileInput').addEventListener('change', handleFilePick)
  $('fsStoreBtn').addEventListener('click', handleStore)

  manager.on('offerChanged', refreshOfferStats)
  manager.on('requestsChanged', refreshRequests)
  manager.on('friendsChanged', () => {
    refreshFriendsList()
    refreshRequests()
    if (selectedFriend) refreshFriendDetail()
  })
  manager.on('stored', () => {
    refreshOfferStats()
    refreshFriendsList()
    if (selectedFriend) refreshFriendDetail()
  })
  manager.on('retrieved', () => {
    if (selectedFriend) refreshFriendDetail()
  })

  refreshOfferStats()
  refreshFriendsList()
  refreshRequests()
}

// Allow external callers (peer connect/disconnect) to refresh friend states.
export function refreshPeerList () {
  refreshFriendsList()
  refreshRequests()
  if (selectedFriend) refreshFriendDetail()
}

/* ── friends list ────────────────────────────────────────────────────── */

function toggleAddFriendForm (show) {
  $('fsAddFriendForm').classList.toggle('hidden', !show)
  if (show) {
    $('fsFriendKeyInput').value = ''
    $('fsFriendLabelInput').value = ''
    $('fsFriendNoteInput').value = ''
    $('fsFriendKeyInput').focus()
  }
}

function toggleRequestsPanel (show) {
  $('fsRequestsPanel').classList.toggle('hidden', !show)
  if (show) refreshRequests()
}

async function handleSendRequest () {
  const key = $('fsFriendKeyInput').value
  const label = $('fsFriendLabelInput').value
  const note = $('fsFriendNoteInput').value
  try {
    await manager.sendFriendRequest(key, label, note)
    toggleAddFriendForm(false)
  } catch (err) {
    activity.warn('friend-request failed for ' + (label || key.slice(0, 12)) + ': ' + err.message)
  }
}

async function refreshRequests () {
  try {
    const [incoming, outgoing] = await Promise.all([
      manager.listIncomingRequests(),
      manager.listOutgoingRequests()
    ])

    const badge = $('fsRequestsBadge')
    badge.textContent = String(incoming.length)
    badge.classList.toggle('hidden', incoming.length === 0)

    const inList = $('fs-incoming-list')
    if (!incoming.length) {
      inList.innerHTML = '<div class="placeholder">No incoming friend requests</div>'
    } else {
      inList.innerHTML = incoming.map(r => {
        const name = r.label ? escapeHtml(r.label) : 'peer ' + r.publicKey.slice(0, 12)
        const note = r.note ? '<div class="hint" style="margin:4px 0 0">' + escapeHtml(r.note) + '</div>' : ''
        return '<div class="agreement-card" style="flex-wrap:wrap">' +
          '<span class="agreement-peer">' + name + '</span>' +
          '<span class="agreement-detail" title="' + r.publicKey + '">' +
            r.publicKey.slice(0, 16) + '…</span>' +
          '<button class="btn-blue btn-small" data-fs-accept="' + r.publicKey + '">Accept</button>' +
          '<button class="btn-small" data-fs-decline="' + r.publicKey + '">Decline</button>' +
          note +
          '</div>'
      }).join('')
      for (const btn of inList.querySelectorAll('[data-fs-accept]')) {
        btn.addEventListener('click', async () => {
          const key = btn.dataset.fsAccept
          try { await manager.acceptRequest(key) }
          catch (err) { activity.warn('accept friend-request from ' + key.slice(0, 12) + ' failed: ' + err.message) }
        })
      }
      for (const btn of inList.querySelectorAll('[data-fs-decline]')) {
        btn.addEventListener('click', () => manager.declineRequest(btn.dataset.fsDecline))
      }
    }

    const outList = $('fs-outgoing-list')
    if (!outgoing.length) {
      outList.innerHTML = '<div class="placeholder">No pending sent requests</div>'
    } else {
      const peers = getConnectedPeers()
      outList.innerHTML = outgoing.map(r => {
        const name = r.label ? escapeHtml(r.label) : 'peer ' + r.publicKey.slice(0, 12)
        const status = r.delivered
          ? 'awaiting reply'
          : (peers.has(r.publicKey) ? 'sending…' : 'queued (offline)')
        return '<div class="agreement-card">' +
          '<span class="agreement-peer">' + name + '</span>' +
          '<span class="agreement-detail" title="' + r.publicKey + '">' +
            r.publicKey.slice(0, 16) + '…</span>' +
          '<span class="agreement-status">' + status + '</span>' +
          '<button class="btn-small" data-fs-cancel="' + r.publicKey + '">Cancel</button>' +
          '</div>'
      }).join('')
      for (const btn of outList.querySelectorAll('[data-fs-cancel]')) {
        btn.addEventListener('click', () => manager.cancelOutgoingRequest(btn.dataset.fsCancel))
      }
    }
  } catch {}
}

async function refreshFriendsList () {
  const list = $('fs-friends-list')
  if (!list) return
  try {
    const friends = await manager.listFriends()
    const peers = getConnectedPeers()
    if (!friends.length) {
      list.innerHTML = '<div class="placeholder">No trusted friends yet</div>'
      return
    }
    list.innerHTML = friends.map(f => {
      const online = peers.has(f.publicKey)
      const dot = online ? 'health-green' : 'health-red'
      const name = f.label ? escapeHtml(f.label) : 'peer ' + f.publicKey.slice(0, 12)
      const isSelected = selectedFriend && selectedFriend.publicKey === f.publicKey
      return '<div class="agreement-card fs-friend-row' + (isSelected ? ' selected' : '') +
          '" data-fs-friend="' + f.publicKey + '">' +
        '<span class="health-dot ' + dot + '"></span>' +
        '<span class="agreement-peer">' + name + '</span>' +
        '<span class="agreement-detail" title="' + f.publicKey + '">' +
          f.publicKey.slice(0, 16) + '…</span>' +
        '<span class="agreement-status">' + (online ? 'online' : 'offline') + '</span>' +
        '<button class="btn-small" data-fs-remove-friend="' + f.publicKey + '">Remove</button>' +
        '</div>'
    }).join('')

    for (const row of list.querySelectorAll('[data-fs-friend]')) {
      row.addEventListener('click', (e) => {
        if (e.target.closest('[data-fs-remove-friend]')) return
        const key = row.dataset.fsFriend
        const friend = friends.find(x => x.publicKey === key)
        if (friend) selectFriend(friend)
      })
    }
    for (const btn of list.querySelectorAll('[data-fs-remove-friend]')) {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation()
        const key = btn.dataset.fsRemoveFriend
        await manager.removeFriend(key)
        if (selectedFriend && selectedFriend.publicKey === key) selectFriend(null)
      })
    }
  } catch {
    list.innerHTML = '<div class="placeholder">Error loading friends</div>'
  }
}

/* ── friend selection / detail ───────────────────────────────────────── */

function selectFriend (friend) {
  selectedFriend = friend
  $('fs-friend-detail').classList.toggle('hidden', !friend)
  refreshFriendsList()
  if (friend) {
    const name = friend.label || ('peer ' + friend.publicKey.slice(0, 12))
    $('fs-detail-name').textContent = name
    $('fs-detail-key').textContent = friend.publicKey
    refreshFriendDetail()
  } else {
    fsFile = null
    $('fsFileLabel').textContent = '(none selected)'
    $('fsFileInput').value = ''
  }
}

function switchSubtab (subtab) {
  for (const btn of document.querySelectorAll('[data-fs-subtab]')) {
    btn.classList.toggle('active', btn.dataset.fsSubtab === subtab)
  }
  $('fs-pane-lend').classList.toggle('hidden', subtab !== 'lend')
  $('fs-pane-borrow').classList.toggle('hidden', subtab !== 'borrow')
}

async function refreshFriendDetail () {
  if (!selectedFriend) return
  const peers = getConnectedPeers()
  const online = peers.has(selectedFriend.publicKey)
  $('fs-friend-conn-status').textContent = online ? 'online' : 'offline'
  updateStoreBtn()

  // Lend side: how much this friend uses of MY space
  try {
    const lent = await manager.getHostedByFriend()
    const entry = lent.find(e => e.ownerId === selectedFriend.publicKey)
    $('fs-friend-lent-bytes').textContent = formatBytes(entry ? entry.bytes : 0)
    $('fs-friend-lent-files').textContent = String(entry ? entry.fileCount : 0)
  } catch {}

  // Borrow side: files I have at THIS friend
  await refreshStoredAtFriend()
}

async function refreshStoredAtFriend () {
  const list = $('fs-stored-list')
  if (!list || !selectedFriend) return
  try {
    const files = (await manager.getStoredFiles())
      .filter(f => f.friendPeerId === selectedFriend.publicKey)
    const peers = getConnectedPeers()
    const online = peers.has(selectedFriend.publicKey)

    if (!files.length) {
      list.innerHTML = '<div class="placeholder">No files stored with this friend yet</div>'
      return
    }
    list.innerHTML = files.map(f => {
      const name = escapeHtml(f.filePath || f.fileId.slice(0, 12))
      return '<div class="agreement-card">' +
        '<span class="agreement-peer">' + name + '</span>' +
        '<span class="agreement-detail">' + formatBytes(f.size) + '</span>' +
        '<button class="btn-small" data-fs-retrieve="' + f.fileId + '"' +
          (online ? '' : ' disabled') + '>Retrieve</button>' +
        '</div>'
    }).join('')
    for (const btn of list.querySelectorAll('[data-fs-retrieve]')) {
      btn.addEventListener('click', () => handleRetrieve(btn.dataset.fsRetrieve, btn))
    }
  } catch {
    list.innerHTML = '<div class="placeholder">Error loading files</div>'
  }
}

/* ── offer (global) ──────────────────────────────────────────────────── */

async function handleSaveOffer () {
  const mb = parseInt($('fsOfferMb').value, 10)
  if (!mb || mb < 0) { activity.warn('enter a valid number of MB to offer'); return }
  try {
    await manager.setOffer(mb * 1024 * 1024)
    refreshOfferStats()
  } catch (err) {
    activity.error('failed to set storage offer to ' + mb + ' MB: ' + err.message)
  }
}

async function refreshOfferStats () {
  try {
    const { fileCount, totalBytes, offeredBytes } = await manager.getHostedStats()
    const offerMb = Math.round(offeredBytes / (1024 * 1024))
    $('fsOfferMb').value = offerMb || ''
    $('fsOfferStatus').textContent = offeredBytes > 0
      ? 'Offering ' + formatBytes(offeredBytes) + ' · hosting ' + fileCount +
        ' file' + (fileCount !== 1 ? 's' : '') + ' (' + formatBytes(totalBytes) + ' used)'
      : 'Not offering any space yet'
  } catch {}
}

/* ── send / store ────────────────────────────────────────────────────── */

function updateStoreBtn () {
  const peers = getConnectedPeers()
  const online = selectedFriend && peers.has(selectedFriend.publicKey)
  $('fsStoreBtn').disabled = !(fsFile && selectedFriend && online)
}

function handleFilePick (e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  fsFile = file
  $('fsFileLabel').textContent = file.name + ' (' + formatBytes(file.size) + ')'
  updateStoreBtn()
}

async function handleStore () {
  if (!selectedFriend) { activity.warn('select a friend first'); return }
  if (!fsFile) { activity.warn('pick a file first'); return }

  $('fsStoreBtn').disabled = true
  $('fsStoreBtn').textContent = 'Storing…'

  const fileNameForLog = fsFile?.name || '?'
  const friendForLog = selectedFriend?.label || selectedFriend?.publicKey?.slice(0, 12) || 'friend'
  try {
    const buf = await readFileAsBuffer(fsFile)
    await uploadToFriend(selectedFriend.publicKey, fsFile.name, buf)
    fsFile = null
    $('fsFileLabel').textContent = '(none selected)'
    $('fsFileInput').value = ''
    await refreshFriendDetail()
  } catch (err) {
    activity.error('store-with-friend failed: ' + fileNameForLog + ' → ' + friendForLog + ': ' + err.message)
  } finally {
    $('fsStoreBtn').textContent = 'Store with Friend'
    updateStoreBtn()
  }
}

/* ── retrieve ────────────────────────────────────────────────────────── */

async function handleRetrieve (fileId, btn) {
  if (!fileId) return
  if (btn) { btn.disabled = true; btn.textContent = 'Retrieving…' }
  try {
    const { data, filePath } = await downloadFromFriend(fileId)
    downloadToUser(data, filePath)
  } catch (err) {
    activity.error('retrieve-from-friend failed (fileId=' + fileId.slice(0, 12) + '…): ' + err.message)
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Retrieve' }
  }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

function escapeHtml (s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function readFileAsBuffer (file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(new Uint8Array(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

function downloadToUser (data, filename) {
  const name = (filename || 'retrieved-file').split('/').pop()
  const blob = new Blob([data])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
}

function formatBytes (bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}
