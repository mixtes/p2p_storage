import { activity } from '../../core/logger.js'
import { getConnectedPeers } from '../replication/manager.js'
import * as manager from './manager.js'
import { uploadToFriend, downloadFromFriend } from './sync.js'

const $ = (id) => document.getElementById(id)

let fsFile = null

export function init () {
  // Offer side
  $('fsOfferBtn').addEventListener('click', handleSaveOffer)

  // Request side
  $('fsPickBtn').addEventListener('click', () => $('fsFileInput').click())
  $('fsFileInput').addEventListener('change', handleFilePick)
  $('fsPeerSelect').addEventListener('change', updateStoreBtn)
  $('fsStoreBtn').addEventListener('click', handleStore)
  $('fsRetrieveBtn').addEventListener('click', handleRetrieve)
  $('fsRetrieveSelect').addEventListener('change', () => {
    $('fsRetrieveBtn').disabled = !$('fsRetrieveSelect').value
  })

  manager.on('offerChanged', refreshOfferStats)
  manager.on('stored', () => { refreshStoredFiles(); refreshPeerList() })
  manager.on('retrieved', refreshStoredFiles)

  refreshOfferStats()
  refreshPeerList()
  refreshStoredFiles()
}

/* ── offer side ──────────────────────────────────────────────────────── */

async function handleSaveOffer () {
  const mb = parseInt($('fsOfferMb').value, 10)
  if (!mb || mb < 0) { activity.warn('enter a valid number of MB to offer'); return }
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

/* ── request side: peer list ─────────────────────────────────────────── */

export function refreshPeerList () {
  const select = $('fsPeerSelect')
  const current = select.value
  const peers = getConnectedPeers()

  if (peers.size === 0) {
    select.innerHTML = '<option value="">-- no peers connected --</option>'
    $('fsStoreBtn').disabled = true
    return
  }

  select.innerHTML = '<option value="">-- select a friend --</option>'
  for (const [peerId] of peers) {
    const opt = document.createElement('option')
    opt.value = peerId
    opt.textContent = 'peer ' + peerId.slice(0, 12)
    select.appendChild(opt)
  }

  if (current) select.value = current
  updateStoreBtn()
}

/* ── request side: store ─────────────────────────────────────────────── */

function updateStoreBtn () {
  $('fsStoreBtn').disabled = !(fsFile && $('fsPeerSelect').value)
}

function handleFilePick (e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  fsFile = file
  $('fsFileLabel').textContent = file.name + ' (' + formatBytes(file.size) + ')'
  updateStoreBtn()
}

async function handleStore () {
  const peerId = $('fsPeerSelect').value
  if (!peerId) { activity.warn('select a friend peer first'); return }
  if (!fsFile) { activity.warn('pick a file first'); return }

  $('fsStoreBtn').disabled = true
  $('fsStoreBtn').textContent = 'Storing…'

  try {
    const buf = await readFileAsBuffer(fsFile)
    await uploadToFriend(peerId, fsFile.name, buf)
    fsFile = null
    $('fsFileLabel').textContent = '(none selected)'
    $('fsFileInput').value = ''
    await refreshStoredFiles()
  } catch (err) {
    activity.error('friend-store error: ' + err.message)
  } finally {
    $('fsStoreBtn').textContent = 'Store with Friend'
    $('fsStoreBtn').disabled = true
  }
}

/* ── request side: retrieve ──────────────────────────────────────────── */

async function handleRetrieve () {
  const fileId = $('fsRetrieveSelect').value
  if (!fileId) return

  $('fsRetrieveBtn').disabled = true
  $('fsRetrieveBtn').textContent = 'Retrieving…'

  try {
    const { data, filePath } = await downloadFromFriend(fileId)
    downloadToUser(data, filePath)
  } catch (err) {
    activity.error('friend-retrieve error: ' + err.message)
  } finally {
    $('fsRetrieveBtn').disabled = false
    $('fsRetrieveBtn').textContent = 'Retrieve'
  }
}

/* ── request side: stored files list ─────────────────────────────────── */

async function refreshStoredFiles () {
  const select = $('fsRetrieveSelect')
  const list = $('fs-stored-list')
  const current = select.value

  try {
    const files = await manager.getStoredFiles()
    const peers = getConnectedPeers()

    select.innerHTML = '<option value="">-- select a file --</option>'

    if (files.length === 0) {
      list.innerHTML = '<div class="placeholder">No files stored with friends yet</div>'
      $('fsRetrieveBtn').disabled = true
      return
    }

    list.innerHTML = files.map(f => {
      const online = peers.has(f.friendPeerId)
      const dot = online ? 'health-green' : 'health-red'
      return '<div class="agreement-card">' +
        '<span class="health-dot ' + dot + '"></span>' +
        '<span class="agreement-peer">' + (f.filePath || f.fileId.slice(0, 12)) + '</span>' +
        '<span class="agreement-detail">' + formatBytes(f.size) + '</span>' +
        '<span class="agreement-status">' + f.friendPeerId.slice(0, 12) +
          ' · ' + (online ? 'online' : 'offline') + '</span>' +
        '</div>'
    }).join('')

    for (const f of files) {
      const opt = document.createElement('option')
      opt.value = f.fileId
      opt.textContent = (f.filePath || f.fileId.slice(0, 12)) + ' (' + formatBytes(f.size) + ')'
      select.appendChild(opt)
    }

    if (current) select.value = current
    $('fsRetrieveBtn').disabled = !select.value
  } catch {
    list.innerHTML = '<div class="placeholder">Error loading files</div>'
  }
}

/* ── helpers ─────────────────────────────────────────────────────────── */

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
