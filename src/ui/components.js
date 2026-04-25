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

export function displayPublicKey (keyHex) {
  const el = $('myPublicKey')
  if (el) el.textContent = keyHex
}

export function showRecoverySeed (seedHex) {
  const card = $('recovery-card')
  const seedEl = $('recoverySeed')
  const revealBtn = $('revealSeedBtn')
  const dismissBtn = $('dismissRecoveryBtn')
  if (!card || !seedEl) return

  seedEl.textContent = seedHex
  card.hidden = false

  revealBtn.addEventListener('click', () => {
    const isBlurred = seedEl.classList.toggle('blurred')
    revealBtn.textContent = isBlurred ? 'Reveal' : 'Hide'
  })

  dismissBtn.addEventListener('click', () => {
    card.hidden = true
  })
}
