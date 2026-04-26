import { activity } from '../../core/logger.js'
import { getConnectedPeers } from '../replication/manager.js'
import * as manager from './manager.js'
import { uploadToFriend, downloadFromFriend } from './sync.js'

const $ = (id) => document.getElementById(id)

let fsFile = null
let selectedPeer = null

export function init () {
  for (const btn of document.querySelectorAll('[data-fs-subtab]')) {
    btn.addEventListener('click', () => switchSubtab(btn.dataset.fsSubtab))
  }

  $('fsDeselectBtn').addEventListener('click', () => selectPeer(null))

  $('fsOfferBtn').addEventListener('click', handleSaveOffer)

  $('fsPickBtn').addEventListener('click', () => $('fsFileInput').click())
  $('fsFileInput').addEventListener('change', handleFilePick)
  $('fsStoreBtn').addEventListener('click', handleStore)

  manager.on('offerChanged', refreshOfferStats)
  manager.on('stored', () => {
    refreshOfferStats()
    refreshPeersList()
    if (selectedPeer) refreshPeerDetail()
  })
  manager.on('retrieved', () => {
    if (selectedPeer) refreshPeerDetail()
  })

  refreshOfferStats()
  refreshPeersList()
}

// Called by app.js on replicationPeer / replicationPeerRemove.
export function refreshPeerList () {
  refreshPeersList()
  if (selectedPeer) refreshPeerDetail()
}

/* ── connected peers list ────────────────────────────────────────────── */

async function refreshPeersList () {
  const list = $('fs-peers-list')
  if (!list) return
  const peers = getConnectedPeers()
  if (peers.size === 0) {
    list.innerHTML = '<div class="placeholder">No peers connected yet</div>'
    return
  }

  let hosted = []
  try { hosted = await manager.getHostedByFriend() } catch {}
  const hostedMap = new Map(hosted.map(h => [h.ownerId, h]))

  list.innerHTML = [...peers.keys()].map(peerId => {
    const isSelected = selectedPeer === peerId
    const stat = hostedMap.get(peerId)
    const usage = stat
      ? formatBytes(stat.bytes) + ' · ' + stat.fileCount + ' file' + (stat.fileCount !== 1 ? 's' : '')
      : 'no files hosted'
    return '<div class="agreement-card fs-friend-row' + (isSelected ? ' selected' : '') +
        '" data-fs-peer="' + escapeAttr(peerId) + '">' +
      '<span class="health-dot health-green"></span>' +
      '<span class="agreement-peer">peer ' + escapeHtml(peerId.slice(0, 12)) + '</span>' +
      '<span class="agreement-detail">' + usage + '</span>' +
      '<span class="agreement-status">online</span>' +
      '</div>'
  }).join('')

  for (const row of list.querySelectorAll('[data-fs-peer]')) {
    row.addEventListener('click', () => selectPeer(row.dataset.fsPeer))
  }
}

/* ── peer selection / detail ─────────────────────────────────────────── */

function selectPeer (peerId) {
  selectedPeer = peerId
  $('fs-peer-detail').classList.toggle('hidden', !peerId)
  refreshPeersList()
  if (peerId) {
    $('fs-detail-name').textContent = 'peer ' + peerId.slice(0, 12)
    $('fs-detail-key').textContent = peerId
    refreshPeerDetail()
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

async function refreshPeerDetail () {
  if (!selectedPeer) return
  const peers = getConnectedPeers()
  const online = peers.has(selectedPeer)
  $('fs-friend-conn-status').textContent = online ? 'online' : 'offline'
  updateStoreBtn()

  try {
    const lent = await manager.getHostedByFriend()
    const entry = lent.find(e => e.ownerId === selectedPeer)
    $('fs-friend-lent-bytes').textContent = formatBytes(entry ? entry.bytes : 0)
    $('fs-friend-lent-files').textContent = String(entry ? entry.fileCount : 0)
  } catch {}

  await refreshStoredAtPeer()
}

async function refreshStoredAtPeer () {
  const list = $('fs-stored-list')
  if (!list || !selectedPeer) return
  try {
    const files = (await manager.getStoredFiles())
      .filter(f => f.friendPeerId === selectedPeer)
    const peers = getConnectedPeers()
    const online = peers.has(selectedPeer)

    if (!files.length) {
      list.innerHTML = '<div class="placeholder">No files stored with this peer yet</div>'
      return
    }
    list.innerHTML = files.map(f => {
      const name = escapeHtml(f.filePath || f.fileId.slice(0, 12))
      return '<div class="agreement-card">' +
        '<span class="agreement-peer">' + name + '</span>' +
        '<span class="agreement-detail">' + formatBytes(f.size) + '</span>' +
        '<button class="btn-small" data-fs-retrieve="' + escapeAttr(f.fileId) + '"' +
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
  if (!Number.isFinite(mb) || mb < 0) { activity.warn('enter a valid number of MB to offer'); return }
  try {
    await manager.setOffer(mb * 1024 * 1024)
    refreshOfferStats()
  } catch (err) {
    activity.error('offer error: ' + err.message)
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
  const online = selectedPeer && peers.has(selectedPeer)
  $('fsStoreBtn').disabled = !(fsFile && selectedPeer && online)
}

function handleFilePick (e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  fsFile = file
  $('fsFileLabel').textContent = file.name + ' (' + formatBytes(file.size) + ')'
  updateStoreBtn()
}

async function handleStore () {
  if (!selectedPeer) { activity.warn('select a peer first'); return }
  if (!fsFile) { activity.warn('pick a file first'); return }

  $('fsStoreBtn').disabled = true
  $('fsStoreBtn').textContent = 'Storing…'

  try {
    const buf = await readFileAsBuffer(fsFile)
    await uploadToFriend(selectedPeer, fsFile.name, buf)
    fsFile = null
    $('fsFileLabel').textContent = '(none selected)'
    $('fsFileInput').value = ''
    await refreshPeerDetail()
  } catch (err) {
    activity.error('peer-store error: ' + err.message)
  } finally {
    $('fsStoreBtn').textContent = 'Store with Peer'
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
    activity.error('peer-retrieve error: ' + err.message)
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
function escapeAttr (s) { return escapeHtml(s) }

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
