/**
 * Replication UI
 *
 * DOM bindings for the replication dashboard:
 *  - Multi-file / folder picker with per-item replication factor (N)
 *  - Auto-calculated space commitment
 *  - Health indicators (per keeper, per file)
 *  - Retrieve selector for previously replicated files
 *  - Storage peers list (auto-managed agreements)
 *  - Hosted-for-others stats
 */

import { activity } from '../../core/logger.js'
import * as manager from './manager.js'
import { pushFileFromBuffer, pushFolderFromFiles, pullFileToBuffer } from './sync.js'
import * as healthMonitor from '../../core/health-monitor.js'

const $ = (id) => document.getElementById(id)

const replQueue = []

export function init () {
  $('replPickBtn').addEventListener('click', () => $('replFileInput').click())
  $('replPickFolderBtn').addEventListener('click', () => $('replFolderInput').click())
  $('replFileInput').addEventListener('change', handleFilePick)
  $('replFolderInput').addEventListener('change', handleFolderPick)
  $('replClearBtn').addEventListener('click', handleClear)
  $('replSendBtn').addEventListener('click', handleReplicate)
  $('replRetrieveBtn').addEventListener('click', handleRetrieve)

  $('replRetrieveSelect').addEventListener('change', () => {
    $('replRetrieveBtn').disabled = !$('replRetrieveSelect').value
  })

  manager.on('configChanged', refreshSpaceInfo)
  manager.on('agreementChanged', refreshAgreements)
  manager.on('chunkProgress', refreshHealth)
  manager.on('healthChanged', refreshHealth)

  healthMonitor.on('statusUpdate', refreshHealth)
  healthMonitor.on('degraded', refreshHealth)
  healthMonitor.on('recovered', refreshHealth)

  refreshAll()
}

/* ── file / folder picking ───────────────────────────────────────────── */

function handleFilePick (e) {
  const files = e.target.files
  if (!files || files.length === 0) return

  for (const file of files) {
    replQueue.push({ name: file.name, size: file.size, file, n: 2 })
  }

  renderQueue()
  e.target.value = ''
}

function handleFolderPick (e) {
  const files = e.target.files
  if (!files || files.length === 0) return

  let folderName = ''
  for (const file of files) {
    if (!folderName && file.webkitRelativePath) {
      folderName = file.webkitRelativePath.split('/')[0]
    }
    const path = file.webkitRelativePath || file.name
    replQueue.push({ name: path, size: file.size, file, n: 2 })
  }

  if (folderName) {
    activity.info('added folder: ' + folderName + ' (' + files.length + ' files)')
  }

  renderQueue()
  e.target.value = ''
}

function handleClear () {
  replQueue.length = 0
  renderQueue()
}

function renderQueue () {
  const container = $('repl-queue')
  const hasItems = replQueue.length > 0

  $('replSendBtn').disabled = !hasItems
  $('replClearBtn').disabled = !hasItems

  if (!hasItems) {
    container.innerHTML = '<div class="placeholder">No files selected</div>'
    $('repl-space-info').hidden = true
    return
  }

  container.innerHTML = replQueue.map((item, idx) =>
    '<div class="repl-queue-item">' +
      '<span class="repl-queue-name" title="' + escHtml(item.name) + '">' +
        truncatePath(item.name) +
      '</span>' +
      '<span class="repl-queue-size">' + formatBytes(item.size) + '</span>' +
      '<label class="repl-queue-n-label">N:</label>' +
      '<input type="number" class="repl-queue-n" min="1" max="10" value="' + item.n + '" data-idx="' + idx + '" />' +
      '<button class="repl-queue-remove" data-idx="' + idx + '">&times;</button>' +
    '</div>'
  ).join('')

  container.querySelectorAll('.repl-queue-n').forEach(input => {
    input.addEventListener('change', (e) => {
      const i = parseInt(e.target.dataset.idx, 10)
      const val = parseInt(e.target.value, 10)
      if (val >= 1 && val <= 10) {
        replQueue[i].n = val
      } else {
        e.target.value = replQueue[i].n
      }
      updateSpaceCalc()
    })
  })

  container.querySelectorAll('.repl-queue-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const i = parseInt(e.target.dataset.idx, 10)
      replQueue.splice(i, 1)
      renderQueue()
    })
  })

  updateSpaceCalc()
}

function updateSpaceCalc () {
  let total = 0
  for (const item of replQueue) {
    total += item.size * item.n
  }
  $('repl-space-info').hidden = replQueue.length === 0
  $('replSpaceCalc').textContent = formatBytes(total)
}

/* ── file replication ────────────────────────────────────────────────── */

async function handleReplicate () {
  if (replQueue.length === 0) {
    activity.warn('pick files first')
    return
  }

  $('replSendBtn').disabled = true
  $('replSendBtn').textContent = 'Replicating…'
  $('replPickBtn').disabled = true
  $('replPickFolderBtn').disabled = true

  try {
    let totalDistributed = 0
    let totalShards = 0

    for (const item of replQueue) {
      const buf = await readFileAsBuffer(item.file)
      const result = await pushFileFromBuffer(item.name, buf, item.n)
      totalDistributed += result.distributed
      totalShards += result.total
    }

    activity.info('replication complete: ' + totalDistributed + '/' + totalShards + ' shards across ' + replQueue.length + ' file(s)')
    replQueue.length = 0
    renderQueue()
    refreshFileList()
    refreshHealth()
    refreshSpaceInfo()
  } catch (err) {
    activity.error('replication error: ' + err.message)
  } finally {
    $('replSendBtn').disabled = replQueue.length === 0
    $('replSendBtn').textContent = 'Replicate All'
    $('replPickBtn').disabled = false
    $('replPickFolderBtn').disabled = false
  }
}

/* ── file retrieval ──────────────────────────────────────────────────── */

async function handleRetrieve () {
  const filePath = $('replRetrieveSelect').value
  if (!filePath) return

  $('replRetrieveBtn').disabled = true
  $('replRetrieveBtn').textContent = 'Retrieving…'

  try {
    const data = await pullFileToBuffer(filePath)
    downloadToUser(data, filePath)
    activity.info('file retrieved: ' + filePath + ' (' + formatBytes(data.length) + ')')
  } catch (err) {
    activity.error('retrieval error: ' + err.message)
  } finally {
    $('replRetrieveBtn').disabled = false
    $('replRetrieveBtn').textContent = 'Retrieve'
  }
}

/* ── agreements (read-only display) ──────────────────────────────────── */

async function refreshAgreements () {
  const container = $('repl-agreements')
  try {
    const agreements = await manager.getOwnerAgreements()
    if (agreements.length === 0) {
      container.innerHTML = '<div class="placeholder">No storage peers yet</div>'
      return
    }

    container.innerHTML = agreements.map(a => {
      const statusClass = a.status === 'active' ? 'health-green' : 'health-yellow'
      return '<div class="agreement-card">' +
        '<span class="health-dot ' + statusClass + '"></span>' +
        '<span class="agreement-peer">' + a.peerId.slice(0, 12) + '</span>' +
        '<span class="agreement-detail">' + formatBytes(a.grantedBytes) + '</span>' +
        '<span class="agreement-status">' + a.status + '</span>' +
        '</div>'
    }).join('')
  } catch (err) {
    container.innerHTML = '<div class="placeholder">Error loading peers</div>'
  }
}

/* ── health display ──────────────────────────────────────────────────── */

async function refreshHealth () {
  const summary = healthMonitor.getHealthSummary()
  $('healthOnline').textContent = summary.online
  $('healthDegraded').textContent = summary.degraded
  $('healthOffline').textContent = summary.offline

  try {
    const fileHealth = await healthMonitor.getFileHealth()
    const container = $('repl-file-health')

    if (fileHealth.length === 0) {
      container.innerHTML = ''
      return
    }

    container.innerHTML = fileHealth.map(f => {
      const pct = f.totalChunks > 0 ? Math.round((f.healthy / f.totalChunks) * 100) : 0
      const barClass =
        f.status === 'healthy' ? 'bar-green' :
        f.status === 'degraded' ? 'bar-yellow' : 'bar-red'

      return '<div class="file-health-row">' +
        '<span class="file-health-name" title="' + f.path + '">' + truncatePath(f.path) + '</span>' +
        '<div class="health-bar"><div class="health-bar-fill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
        '<span class="file-health-pct">' + pct + '%</span>' +
        '</div>'
    }).join('')
  } catch {}
}

/* ── space info display ──────────────────────────────────────────────── */

async function refreshSpaceInfo () {
  try {
    const offered = await manager.computeOfferedBytes()
    if (offered > 0) {
      $('repl-space-info').hidden = false
      $('replSpaceCalc').textContent = formatBytes(offered)
    }
  } catch {}
}

/* ── hosted stats ────────────────────────────────────────────────────── */

async function refreshHosted () {
  try {
    const chunks = await manager.getHostedChunks()
    let totalBytes = 0
    for (const c of chunks) totalBytes += c.size || 0

    $('replHostedCount').textContent = chunks.length
    $('replHostedBytes').textContent = formatBytes(totalBytes)
  } catch {}
}

/* ── file list for retrieval ─────────────────────────────────────────── */

async function refreshFileList () {
  try {
    const files = await manager.getReplicatedFiles()
    const select = $('replRetrieveSelect')
    const current = select.value

    select.innerHTML = '<option value="">-- select a file --</option>'
    for (const f of files) {
      const opt = document.createElement('option')
      opt.value = f.path
      opt.textContent = f.path + ' (' + formatBytes(f.size) + ', N=' + (f.replicationFactor || '?') + ')'
      select.appendChild(opt)
    }

    if (current) select.value = current
    $('replRetrieveBtn').disabled = !select.value
  } catch {}
}

/* ── refresh all ─────────────────────────────────────────────────────── */

async function refreshAll () {
  refreshHealth()
  refreshAgreements()
  refreshFileList()
  refreshHosted()
  refreshSpaceInfo()
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
  const name = filename.split('/').pop() || 'retrieved-file'
  const blob = new Blob([data])
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  setTimeout(() => { URL.revokeObjectURL(url); a.remove() }, 1000)
}

function truncatePath (p) {
  if (p.length <= 28) return p
  return '…' + p.slice(-27)
}

function escHtml (s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatBytes (bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}
