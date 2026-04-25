/* global Pear */
//
// Single-sink logger (everything goes to the in-app <div id="log"> panel).
//
//   activity.{info,warn,error}        -> always shown in the activity panel.
//   dev.{info,warn,error,debug}(...)  -> shown in the activity panel ONLY when
//                                        the `devLogs` flag in /config.json
//                                        is true. Otherwise no-op.
//
// Toggle developer logs by editing /config.json:
//   { "devLogs": true }   // show [dev] lines
//   { "devLogs": false }  // hide them (default)

const $ = (id) => document.getElementById(id)

let devLogs = false
const pending = []

function appendActivity (msg, level) {
  const el = $('log')
  if (!el) {
    pending.push({ msg, level })
    return
  }
  if (pending.length) {
    const queued = pending.splice(0, pending.length)
    for (const p of queued) appendActivity(p.msg, p.level)
  }
  const line = document.createElement('div')
  line.dataset.level = level
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  el.prepend(line)
}

function fmt (args) {
  return args.map((a) => {
    if (a instanceof Error) return a.stack || a.message
    if (typeof a === 'string') return a
    try { return JSON.stringify(a) } catch { return String(a) }
  }).join(' ')
}

export const activity = {
  info  (msg) { appendActivity(String(msg), 'info') },
  warn  (msg) { appendActivity(String(msg), 'warn') },
  error (msg) { appendActivity(String(msg), 'error') }
}

export const dev = {
  info  (...args) { if (devLogs) appendActivity('[dev info] '  + fmt(args), 'dev-info') },
  warn  (...args) { if (devLogs) appendActivity('[dev warn] '  + fmt(args), 'dev-warn') },
  error (...args) { if (devLogs) appendActivity('[dev error] ' + fmt(args), 'dev-error') },
  debug (...args) { if (devLogs) appendActivity('[dev debug] ' + fmt(args), 'dev-debug') }
}

export function setStatus (text, on) {
  const statusText = $('statusText')
  const statusDot = $('statusDot')
  if (statusText) statusText.textContent = text
  if (statusDot) statusDot.classList.toggle('on', !!on)
}

// Back-compat shim for callers that still import { log } (file-sharing,
// network.js, app.js). New code should use activity.* / dev.* directly.
export function log (msg) { activity.info(msg) }

// Load the flag from /config.json (served by pear-bridge). Async; safe to
// fire-and-forget — calls before it resolves just no-op for dev.*.
;(async () => {
  try {
    const res = await fetch('./config.json', { cache: 'no-store' })
    if (!res.ok) return
    const cfg = await res.json()
    devLogs = !!cfg.devLogs
    if (devLogs) appendActivity('[dev info] devLogs enabled (config.json)', 'dev-info')
  } catch {
    // config.json missing or invalid -> keep devLogs = false
  }
})()

// Quiet "Pear referenced but not imported" lint hint.
void Pear

