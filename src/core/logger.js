const $ = (id) => document.getElementById(id)

export function log (msg) {
  const el = $('log')
  if (!el) return
  const line = document.createElement('div')
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`
  el.prepend(line)
}

export function setStatus (text, on) {
  const statusText = $('statusText')
  const statusDot = $('statusDot')
  if (statusText) statusText.textContent = text
  if (statusDot) statusDot.classList.toggle('on', !!on)
}
