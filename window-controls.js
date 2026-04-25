/* global Pear */

import ui from 'pear-electron'
import { dev } from './src/core/logger.js'

const isMac = navigator.platform.toUpperCase().includes('MAC')

function clearPersistedSelections () {
  try {
    localStorage.removeItem('p2p.receiveFolder')
    localStorage.removeItem('p2p.sendFile')
  } catch {}

  const recvLabel = document.getElementById('recvFolderLabel')
  if (recvLabel) recvLabel.textContent = '(none selected)'
  const recvBtn = document.getElementById('recvBtn')
  if (recvBtn) recvBtn.disabled = true

  const sendLabel = document.getElementById('sendFileLabel')
  if (sendLabel) sendLabel.textContent = '(none selected)'
  const sendBtn = document.getElementById('sendBtn')
  if (sendBtn) sendBtn.disabled = true
  const sendInput = document.getElementById('sendFileInput')
  if (sendInput) sendInput.value = ''
}

function getWindow () {
  return ui.app
}

async function onMinimize () {
  try { await getWindow().minimize() } catch (err) { dev.error('[window-controls] minimize failed:', err) }
}

async function onToggleMaximize () {
  const win = getWindow()
  try {
    let maxed = false
    try { maxed = await win.isMaximized() } catch {}
    if (maxed) {
      if (typeof win.restore === 'function') await win.restore()
      else await win.maximize()
    } else {
      await win.maximize()
    }
  } catch (err) {
    console.error('maximize toggle failed', err)
  }
}

async function onClose () {
  clearPersistedSelections()
  const win = getWindow()
  try {
    if (typeof win.quit === 'function') await win.quit()
    else await win.close()
  } catch {}
  try { if (typeof Pear.exit === 'function') Pear.exit(0) } catch {}
  try { window.close() } catch {}
}

function makeButton (cls, label, handler, glyphHTML) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'wc-btn ' + cls
  btn.setAttribute('aria-label', label)
  btn.title = label
  if (glyphHTML) btn.innerHTML = glyphHTML
  btn.addEventListener('click', handler)
  return btn
}

const SVG_NS = 'http://www.w3.org/2000/svg'
const winGlyph = (paths) =>
  `<svg xmlns="${SVG_NS}" viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1" shape-rendering="crispEdges">${paths}</svg>`

const WIN_MIN     = winGlyph('<line x1="1" y1="5" x2="9" y2="5" />')
const WIN_MAX     = winGlyph('<rect x="1" y="1" width="8" height="8" />')
const WIN_RESTORE = winGlyph('<rect x="1" y="3" width="6" height="6" /><polyline points="3,3 3,1 9,1 9,7 7,7" />')
const WIN_CLOSE   = winGlyph('<line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />')

export function mountWindowControls (container) {
  if (!container) return
  const group = document.createElement('div')
  group.className = 'window-controls ' + (isMac ? 'wc-mac' : 'wc-win')

  if (isMac) {
    group.appendChild(makeButton('wc-close', 'Close', onClose))
    group.appendChild(makeButton('wc-min', 'Minimize', onMinimize))
    group.appendChild(makeButton('wc-zoom', 'Zoom', onToggleMaximize))
    container.prepend(group)
  } else {
    group.appendChild(makeButton('wc-min', 'Minimize', onMinimize, WIN_MIN))
    const maxBtn = makeButton('wc-max', 'Maximize', async () => {
      await onToggleMaximize()
      try {
        const m = await getWindow().isMaximized()
        maxBtn.innerHTML = m ? WIN_RESTORE : WIN_MAX
        maxBtn.title = m ? 'Restore' : 'Maximize'
      } catch {}
    }, WIN_MAX)
    group.appendChild(maxBtn)
    group.appendChild(makeButton('wc-close', 'Close', onClose, WIN_CLOSE))
    container.appendChild(group)
  }

  return group
}

Pear.teardown(() => { clearPersistedSelections() })
