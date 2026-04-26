/**
 * Replication UI
 *
 * DOM bindings for the replication dashboard:
 *  - Space offering configuration
 *  - Multi-file / folder picker with per-item replication factor (N)
 *  - Folder grouping with collapse/expand
 *  - Auto-calculated minimum space commitment
 *  - Health indicators (per keeper, per file)
 *  - Retrieve selector for previously replicated files
 *  - Storage peers list (auto-managed agreements)
 *  - Hosted-for-others stats
 */

import { activity } from '../../core/logger.js'
import * as manager from './manager.js'
import { pushFileFromBuffer, pullFileToBuffer } from './sync.js'
import * as healthMonitor from '../../core/health-monitor.js'

const $ = (id) => document.getElementById(id)

/**
 * Queue is a flat list but entries can be grouped by folder.
 * Each entry: { name, size, file, n, folder: string|null }
 * When folder !== null, entries with the same folder value share one N.
 */
const replQueue = []

export function init () {
  $('replOfferBtn').addEventListener('click', handleSaveOffer)
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

  manager.on('configChanged', renderOfferStatus)
  manager.on('agreementChanged', refreshAgreements)
  manager.on('chunkProgress', refreshHealth)
  manager.on('healthChanged', refreshHealth)

  healthMonitor.on('statusUpdate', refreshHealth)
  healthMonitor.on('degraded', refreshHealth)
  healthMonitor.on('recovered', refreshHealth)

  renderOfferStatus()
  refreshAll()
}

/* ── space offering ──────────────────────────────────────────────────── */

async function handleSaveOffer () {
  const offerMb = parseInt($('replOffer').value, 10)
  if (!offerMb || offerMb < 0) {
    activity.warn('offered space must be 0 or more MB')
    return
  }

  const offeredBytes = offerMb * 1024 * 1024
  const minBytes = await manager.computeMinOfferedBytes()

  if (offeredBytes < minBytes) {
    activity.warn('offer must be at least ' + formatBytes(minBytes) +
      ' (your own replication needs)')
    return
  }

  try {
    await manager.configure(offeredBytes)
    activity.info('space offer saved: ' + formatBytes(offeredBytes))
  } catch (err) {
    activity.error('replication config failed (N=' + factor + ', offer=' + offerMb + ' MB): ' + err.message)
  }
}

async function renderOfferStatus () {
  const config = manager.getConfig()
  if (config) {
    $('replOfferStatus').textContent = formatBytes(config.offeredBytes)
    $('replOffer').value = Math.round(config.offeredBytes / (1024 * 1024))
  } else {
    $('replOfferStatus').textContent = 'not configured'
  }

  try {
    const minBytes = await manager.computeMinOfferedBytes()
    if (minBytes > 0) {
      $('repl-min-offer-row').hidden = false
      $('replMinOffer').textContent = formatBytes(minBytes)
    } else {
      $('repl-min-offer-row').hidden = true
    }
  } catch {}
}

/* ── file / folder picking ───────────────────────────────────────────── */

function handleFilePick (e) {
  const files = e.target.files
  if (!files || files.length === 0) return

  for (const file of files) {
    replQueue.push({ name: file.name, size: file.size, file, n: 2, folder: null })
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
    replQueue.push({ name: path, size: file.size, file, n: 2, folder: folderName || null })
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

/* ── queue rendering with folder grouping ────────────────────────────── */

const expandedFolders = new Set()

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

  const folders = new Map()
  const looseFiles = []

  for (let i = 0; i < replQueue.length; i++) {
    const item = replQueue[i]
    if (item.folder) {
      if (!folders.has(item.folder)) {
        folders.set(item.folder, { indices: [], totalSize: 0, n: item.n })
      }
      const g = folders.get(item.folder)
      g.indices.push(i)
      g.totalSize += item.size
    } else {
      looseFiles.push(i)
    }
  }

  let html = ''

  for (const [folderName, group] of folders) {
    const expanded = expandedFolders.has(folderName)
    const chevron = expanded ? '&#9662;' : '&#9656;'

    html +=
      '<div class="repl-queue-folder" data-folder="' + escHtml(folderName) + '">' +
        '<span class="repl-queue-folder-toggle">' + chevron + '</span>' +
        '<span class="repl-queue-folder-icon">&#128193;</span>' +
        '<span class="repl-queue-name">' + escHtml(folderName) + '/</span>' +
        '<span class="repl-queue-size">' + group.indices.length + ' files, ' + formatBytes(group.totalSize) + '</span>' +
        '<label class="repl-queue-n-label">N:</label>' +
        '<input type="number" class="repl-queue-n repl-folder-n" min="1" max="10" value="' + group.n + '" data-folder="' + escHtml(folderName) + '" />' +
        '<button class="repl-queue-remove repl-folder-remove" data-folder="' + escHtml(folderName) + '">&times;</button>' +
      '</div>'

    if (expanded) {
      html += '<div class="repl-queue-folder-children">'
      for (const idx of group.indices) {
        const item = replQueue[idx]
        const shortName = item.name.replace(folderName + '/', '')
        html +=
          '<div class="repl-queue-item repl-queue-child">' +
            '<span class="repl-queue-name" title="' + escHtml(item.name) + '">' + truncatePath(shortName) + '</span>' +
            '<span class="repl-queue-size">' + formatBytes(item.size) + '</span>' +
          '</div>'
      }
      html += '</div>'
    }
  }

  for (const idx of looseFiles) {
    const item = replQueue[idx]
    html +=
      '<div class="repl-queue-item">' +
        '<span class="repl-queue-name" title="' + escHtml(item.name) + '">' + truncatePath(item.name) + '</span>' +
        '<span class="repl-queue-size">' + formatBytes(item.size) + '</span>' +
        '<label class="repl-queue-n-label">N:</label>' +
        '<input type="number" class="repl-queue-n" min="1" max="10" value="' + item.n + '" data-idx="' + idx + '" />' +
        '<button class="repl-queue-remove" data-idx="' + idx + '">&times;</button>' +
      '</div>'
  }

  container.innerHTML = html

  container.querySelectorAll('.repl-queue-folder-toggle, .repl-queue-folder-icon, .repl-queue-folder > .repl-queue-name').forEach(el => {
    el.addEventListener('click', (e) => {
      const folder = e.target.closest('.repl-queue-folder').dataset.folder
      if (expandedFolders.has(folder)) {
        expandedFolders.delete(folder)
      } else {
        expandedFolders.add(folder)
      }
      renderQueue()
    })
  })

  container.querySelectorAll('.repl-folder-n').forEach(input => {
    input.addEventListener('change', (e) => {
      const folder = e.target.dataset.folder
      const val = parseInt(e.target.value, 10)
      if (val < 1 || val > 10) {
        e.target.value = replQueue.find(q => q.folder === folder)?.n || 2
        return
      }
      for (const item of replQueue) {
        if (item.folder === folder) item.n = val
      }
      updateSpaceCalc()
    })
  })

  container.querySelectorAll('.repl-folder-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const folder = e.target.dataset.folder
      for (let i = replQueue.length - 1; i >= 0; i--) {
        if (replQueue[i].folder === folder) replQueue.splice(i, 1)
      }
      expandedFolders.delete(folder)
      renderQueue()
    })
  })

  container.querySelectorAll('.repl-queue-n:not(.repl-folder-n)').forEach(input => {
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

  container.querySelectorAll('.repl-queue-remove:not(.repl-folder-remove)').forEach(btn => {
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

  if (!manager.isConfigured()) {
    activity.warn('set your space offering first')
    return
  }

  $('replSendBtn').disabled = true
  $('replSendBtn').textContent = 'Replicating…'
  $('replPickBtn').disabled = true
  $('replPickFolderBtn').disabled = true

  try {
    let totalDistributed = 0
    let totalShards = 0
    const failedItems = []

    for (let i = 0; i < replQueue.length; i++) {
      const item = replQueue[i]
      const buf = await readFileAsBuffer(item.file)
      const result = await pushFileFromBuffer(item.name, buf, item.n)
      totalDistributed += result.distributed
      totalShards += result.total
      if (result.distributed === 0) {
        failedItems.push(item)
      }
    }

    if (totalDistributed === 0) {
      activity.error('replication failed: no peers accepted storage agreements. ' +
        'Make sure at least one connected peer has configured their space offering. ' +
        'Files remain in queue — you can retry later.')
      refreshHealth()
      renderOfferStatus()
      return
    }

    if (failedItems.length > 0) {
      activity.warn(failedItems.length + ' file(s) could not be distributed — ' +
        'not enough keepers available. They remain in queue for retry.')
      replQueue.length = 0
      for (const item of failedItems) replQueue.push(item)
      renderQueue()
    } else {
      activity.info('replication complete: ' + totalDistributed + '/' + totalShards +
        ' shards across ' + (replQueue.length - failedItems.length) + ' file(s)')
      replQueue.length = 0
      renderQueue()
    }

    refreshFileList()
    refreshHealth()
    renderOfferStatus()
  } catch (err) {
    activity.error('replication failed for ' + replFile.name + ' (' + formatBytes(replFile.size) + '): ' + err.message)
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
    activity.info('retrieved ' + filePath + ' (' + formatBytes(data.length) + ') from keepers')
  } catch (err) {
    activity.error('retrieval failed for ' + filePath + ': ' + err.message)
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

    const grouped = groupHealthByFolder(fileHealth)
    container.innerHTML = grouped.map(renderHealthEntry).join('')

    container.querySelectorAll('.health-folder-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const folder = el.dataset.folder
        if (expandedHealthFolders.has(folder)) {
          expandedHealthFolders.delete(folder)
        } else {
          expandedHealthFolders.add(folder)
        }
        refreshHealth()
      })
    })
  } catch {}
}

const expandedHealthFolders = new Set()

/**
 * Group file health entries by folder prefix. Files whose path contains
 * a "/" are grouped under the first path segment; standalone files stay loose.
 */
function groupHealthByFolder (entries) {
  const folders = new Map()
  const loose = []

  for (const f of entries) {
    const slashIdx = f.path.indexOf('/')
    if (slashIdx > 0) {
      const folderName = f.path.slice(0, slashIdx)
      if (!folders.has(folderName)) {
        folders.set(folderName, { folder: folderName, files: [], totalChunks: 0, healthy: 0, degraded: 0, lost: 0 })
      }
      const g = folders.get(folderName)
      g.files.push(f)
      g.totalChunks += f.totalChunks
      g.healthy += f.healthy
      g.degraded += f.degraded
      g.lost += f.lost
    } else {
      loose.push({ type: 'file', ...f })
    }
  }

  const result = []
  for (const g of folders.values()) {
    g.status = g.lost > 0 ? 'critical' : g.degraded > 0 ? 'degraded' : 'healthy'
    g.type = 'folder'
    result.push(g)
  }
  for (const f of loose) result.push(f)
  return result
}

function renderHealthEntry (entry) {
  if (entry.type === 'folder') {
    const pct = entry.totalChunks > 0 ? Math.round((entry.healthy / entry.totalChunks) * 100) : 0
    const barClass = healthBarClass(entry.status)
    const expanded = expandedHealthFolders.has(entry.folder)
    const chevron = expanded ? '&#9662;' : '&#9656;'

    let html =
      '<div class="file-health-row health-folder-toggle" data-folder="' + escHtml(entry.folder) + '" style="cursor:pointer">' +
        '<span style="width:12px;text-align:center;font-size:10px;color:#8a93a6">' + chevron + '</span>' +
        '<span style="font-size:14px">&#128193;</span>' +
        '<span class="file-health-name" title="' + escHtml(entry.folder) + '/">' + escHtml(entry.folder) + '/ (' + entry.files.length + ' files)</span>' +
        '<div class="health-bar"><div class="health-bar-fill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
        '<span class="file-health-pct">' + pct + '%</span>' +
      '</div>'

    if (expanded) {
      for (const f of entry.files) {
        const fp = f.totalChunks > 0 ? Math.round((f.healthy / f.totalChunks) * 100) : 0
        const fbc = healthBarClass(f.status)
        const shortName = f.path.replace(entry.folder + '/', '')
        html +=
          '<div class="file-health-row" style="padding-left:36px;font-size:11px">' +
            '<span class="file-health-name" title="' + escHtml(f.path) + '">' + truncatePath(shortName) + '</span>' +
            '<div class="health-bar"><div class="health-bar-fill ' + fbc + '" style="width:' + fp + '%"></div></div>' +
            '<span class="file-health-pct">' + fp + '%</span>' +
          '</div>'
      }
    }

    return html
  }

  const pct = entry.totalChunks > 0 ? Math.round((entry.healthy / entry.totalChunks) * 100) : 0
  const barClass = healthBarClass(entry.status)

  return '<div class="file-health-row">' +
    '<span class="file-health-name" title="' + escHtml(entry.path) + '">' + truncatePath(entry.path) + '</span>' +
    '<div class="health-bar"><div class="health-bar-fill ' + barClass + '" style="width:' + pct + '%"></div></div>' +
    '<span class="file-health-pct">' + pct + '%</span>' +
    '</div>'
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
  if (p.length <= 32) return p
  return '…' + p.slice(-31)
}

function healthBarClass (status) {
  if (status === 'healthy') return 'bar-green'
  if (status === 'degraded' || status === 'partial') return 'bar-yellow'
  if (status === 'pending') return 'bar-gray'
  return 'bar-red'
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
