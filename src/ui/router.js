const $ = (id) => document.getElementById(id)

let activeTab = 'file-sharing'

export function init () {
  const buttons = document.querySelectorAll('[data-tab]')
  for (const btn of buttons) {
    btn.addEventListener('click', () => switchTo(btn.dataset.tab))
  }
  switchTo(activeTab)
}

export function switchTo (tabId) {
  activeTab = tabId

  const views = document.querySelectorAll('.feature-view')
  for (const view of views) {
    view.classList.toggle('hidden', view.id !== 'view-' + tabId)
  }

  const buttons = document.querySelectorAll('[data-tab]')
  for (const btn of buttons) {
    btn.classList.toggle('active', btn.dataset.tab === tabId)
  }
}

export function getActiveTab () {
  return activeTab
}
