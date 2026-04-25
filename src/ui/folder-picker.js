/**
 * Native folder picker via a Pear worker (pear-run).
 *
 * Spawns `worker-pick-folder.cjs` which opens the OS-native folder dialog
 * (osascript on macOS, IFileDialog COM on Windows) and returns the selected
 * absolute path over pear-pipe.
 *
 * Returns the selected folder path, or null on cancel.
 */

export async function pickFolderNative () {
  const mod = await import('pear-run')
  const run = mod.default || mod

  return new Promise((resolve, reject) => {
    let pipe
    try {
      pipe = run('./worker-pick-folder.cjs')
    } catch (err) {
      return reject(err)
    }

    const decoder = new TextDecoder('utf-8')
    let buf = ''

    pipe.on('data', (d) => { buf += decoder.decode(d, { stream: true }) })
    pipe.on('error', reject)
    pipe.on('end', () => {
      const msg = buf.trim()
      if (msg.startsWith('OK:')) resolve(msg.slice(3))
      else if (msg === 'CANCEL') resolve(null)
      else if (msg.startsWith('ERR:')) reject(new Error(msg.slice(4)))
      else resolve(null)
    })
  })
}
