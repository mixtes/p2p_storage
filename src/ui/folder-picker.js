import { log } from '../core/logger.js'

/**
 * Derive the absolute folder path from an <input webkitdirectory> selection.
 * Pear/Electron exposes `file.path` on each File object.
 */
export function folderPathFromInput (input) {
  const files = input.files
  log('folderPathFromInput: files.length=' + (files ? files.length : 0))
  if (!files || files.length === 0) {
    log('folderPathFromInput: no files selected (empty folder or cancel?)')
    return null
  }
  const file = files[0]
  log('folderPathFromInput: first file name=' + file.name + ' rel=' + (file.webkitRelativePath || '(none)') + ' path=' + (file.path || '(missing)'))
  if (!file.path) {
    log('folderPathFromInput: file.path is empty (Electron may have stripped it)')
    return null
  }
  const rel = file.webkitRelativePath || file.name
  const rootName = rel.split('/')[0]
  const abs = file.path
  const idx = abs.lastIndexOf(rootName)
  const resolved = idx === -1
    ? abs.replace(/[\\\/][^\\\/]*$/, '')
    : abs.slice(0, idx + rootName.length)
  log('folderPathFromInput: resolved=' + resolved)
  return resolved
}

/**
 * Open a native OS folder picker dialog via a Pear worker process.
 * Returns the selected folder path, or null on cancel.
 */
export async function pickFolderNative () {
  log('pickFolderNative: importing pear-run…')
  const mod = await import('pear-run')
  const run = mod.default || mod
  log('pickFolderNative: pear-run loaded, type=' + typeof run)
  return new Promise((resolve, reject) => {
    let pipe
    try {
      log('pickFolderNative: spawning worker ./worker-pick-folder.cjs')
      pipe = run('./worker-pick-folder.cjs')
    } catch (err) {
      log('pickFolderNative: run() threw: ' + err.message)
      return reject(err)
    }
    log('pickFolderNative: worker pipe obtained, waiting for data…')
    const decoder = new TextDecoder('utf-8')
    let buf = ''
    pipe.on('data', (d) => {
      const chunk = decoder.decode(d, { stream: true })
      buf += chunk
      log('worker data chunk: ' + JSON.stringify(chunk))
    })
    pipe.on('error', (err) => {
      log('worker pipe error: ' + err.message)
      reject(err)
    })
    pipe.on('crash', (info) => log('worker crash: exitCode=' + (info && info.exitCode)))
    pipe.on('end', () => {
      const msg = buf.trim()
      log('worker pipe end. total buf=' + JSON.stringify(msg))
      if (msg.startsWith('OK:')) resolve(msg.slice(3))
      else if (msg === 'CANCEL') resolve(null)
      else if (msg.startsWith('ERR:')) reject(new Error(msg.slice(4)))
      else resolve(null)
    })
  })
}
