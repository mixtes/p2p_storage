const $ = (id) => document.getElementById(id)

export function renderPeers (peers) {
  const el = $('peers')
  if (!el) return
  el.innerHTML = ''
  if (peers.size === 0) {
    const li = document.createElement('li')
    li.className = 'empty'
    li.textContent = 'none yet'
    el.appendChild(li)
    return
  }
  for (const hex of peers.keys()) {
    const li = document.createElement('li')
    li.textContent = hex
    el.appendChild(li)
  }
}

export function displayDriveKey (keyHex) {
  const el = $('myKey')
  if (el) el.textContent = keyHex
}
