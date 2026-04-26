/**
 * Replication UI
 *
 * DOM bindings for the replication dashboard:
 *  - Configuration (N, offered bytes)
 *  - Health indicators (per keeper, per file)
 *  - File picker for replication
 *  - Retrieve selector for previously replicated files
 *  - Agreement list
 *  - Hosted-for-others stats
 */

import { activity } from '../../core/logger.js'
import * as manager from './manager.js'
import { pushFileFromBuffer, pullFileToBuffer } from './sync.js'
import * as healthMonitor from '../../core/health-monitor.js'

const $ = (id) => document.getElementById(id)

let replFile = null

export function init () {
  $('replConfigBtn').addEventListener('click', handleConfigure)
  $('replPickBtn').addEventListener('click', () => $('replFileInput').click())
  $('replFileInput').addEventListener('change', handleFilePick)
  $('replSendBtn').addEventListener('click', handleReplicate)
  $('replRetrieveBtn').addEventListener('click', handleRetrieve)
  $('replRequestBtn').addEventListener('click', handleRequestAgreements)

  $('replRetrieveSelect').addEventListener('change', () => {
    $('replRetrieveBtn').disabled = !$('replRetrieveSelect').value
  })

  manager.on('configChanged', renderConfig)
  manager.on('agreementChanged', refreshAgreements)
  manager.on('chunkProgress', refreshHealth)
  manager.on('healthChanged', refreshHealth)

  healthMonitor.on('statusUpdate', refreshHealth)
  healthMonitor.on('degraded', refreshHealth)
  healthMonitor.on('recovered', refreshHealth)

  if (manager.isConfigured()) {
    renderConfig(manager.getConfig())
    $('replRequestBtn').disabled = false
  }

  refreshAll()
}

/* ── configuration ───────────────────────────────────────────────────── */

async function handleConfigure () {
  const factor = parseInt($('replFactor').value, 10)
  const offerMb = parseInt($('replOffer').value, 10)

  if (!factor || factor < 1 || factor > 10) {
    activity.warn('replication factor must be 1–10')
    return
  }
  if (!offerMb || offerMb < 1) {
    activity.warn('offered space must be at least 1 MB')
    return
  }

  const offeredBytes = offerMb * 1024 * 1024
  try {
    await manager.configure(factor, offeredBytes)
    $('replRequestBtn').disabled = false
  } catch (err) {
    activity.error('replication config failed (N=' + factor + ', offer=' + offerMb + ' MB): ' + err.message)
  }
}

function renderConfig (config) {
  if (!config) return
  $('repl-config-status').hidden = false
  $('replConfigLabel').textContent =
    'N=' + config.replicationFactor +
    '  offering ' + formatBytes(config.offeredBytes)
  $('replFactor').value = config.replicationFactor
  $('replOffer').value = Math.round(config.offeredBytes / (1024 * 1024))
}

/* ── file replication ────────────────────────────────────────────────── */

function handleFilePick (e) {
  const file = e.target.files && e.target.files[0]
  if (!file) return
  replFile = file
  $('replFileLabel').textContent = file.name + ' (' + formatBytes(file.size) + ')'
  $('replSendBtn').disabled = false
}

async function handleReplicate () {
  if (!replFile) {
    activity.warn('pick a file first')
    return
  }
  if (!manager.isConfigured()) {
    activity.warn('configure replication first')
    return
  }

  $('replSendBtn').disabled = true
  $('replSendBtn').textContent = 'Replicating…'

  try {
    const buf = await readFileAsBuffer(replFile)
    const result = await pushFileFromBuffer(replFile.name, buf)
    activity.info('replication complete for ' + replFile.name + ' (' + formatBytes(buf.length) +
      '): ' + result.distributed + '/' + result.total + ' shards distributed')
    refreshFileList()
    refreshHealth()
  } catch (err) {
    activity.error('replication failed for ' + replFile.name + ' (' + formatBytes(replFile.size) + '): ' + err.message)
  } finally {
    $('replSendBtn').disabled = false
    $('replSendBtn').textContent = 'Replicate'
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

/* ── agreements ──────────────────────────────────────────────────────── */

async function handleRequestAgreements () {
  if (!manager.isConfigured()) {
    activity.warn('configure replication first')
    return
  }
  try {
    await manager.requestAgreements()
  } catch (err) {
    activity.error('agreement request failed: ' + err.message)
  }
}

async function refreshAgreements () {
  const container = $('repl-agreements')
  try {
    const agreements = await manager.getOwnerAgreements()
    if (agreements.length === 0) {
      container.innerHTML = '<div class="placeholder">No agreements yet</div>'
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
    container.innerHTML = '<div class="placeholder">Error loading agreements</div>'
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
      opt.textContent = f.path + ' (' + formatBytes(f.size) + ')'
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
  if (p.length <= 28) return p
  return '…' + p.slice(-27)
}

function formatBytes (bytes) {
  if (!bytes || bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}
