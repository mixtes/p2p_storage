/* global Pear */

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
  return Pear.Window?.self || Pear.app
}

async function onMinimize () {
  try { await getWindow().minimize() } catch (err) { console.error('minimize failed', err) }
}

async function onMaxOrFullscreen () {
  try { await getWindow().maximize() } catch (err) { console.error('maximize failed', err) }
}

async function onClose () {
  clearPersistedSelections()
  try { await getWindow().close() } catch {}
  try { Pear.exit(0) } catch (err) { console.error('exit failed', err) }
}

function makeButton (cls, label, handler) {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = 'wc-btn ' + cls
  btn.setAttribute('aria-label', label)
  btn.title = label
  btn.addEventListener('click', handler)
  return btn
}

export function mountWindowControls (container) {
  if (!container) return
  const group = document.createElement('div')
  group.className = 'window-controls ' + (isMac ? 'wc-mac' : 'wc-win')

  if (isMac) {
    group.appendChild(makeButton('wc-close', 'Close', onClose))
    group.appendChild(makeButton('wc-min', 'Minimize', onMinimize))
    group.appendChild(makeButton('wc-zoom', 'Zoom', onMaxOrFullscreen))
  } else {
    group.appendChild(makeButton('wc-min', 'Minimize', onMinimize))
    group.appendChild(makeButton('wc-max', 'Maximize', onMaxOrFullscreen))
    group.appendChild(makeButton('wc-close', 'Close', onClose))
  }

  if (isMac) container.prepend(group)
  else container.appendChild(group)

  return group
}

Pear.teardown(() => { clearPersistedSelections() })
