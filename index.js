/* global Pear */
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'

const runtime = new Runtime()
const bridge = new Bridge()
await bridge.ready()

const pipe = await runtime.start({ bridge })

let shuttingDown = false
async function shutdown (code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  try { pipe.end?.() } catch {}
  try { await bridge.close?.() } catch {}
  setTimeout(() => process.exit(code), 500).unref()
}

pipe.on('close', () => shutdown(Pear.exitCode ?? 0))
pipe.on('end', () => shutdown(Pear.exitCode ?? 0))
pipe.on('error', () => shutdown(Pear.exitCode ?? 0))

Pear.teardown(() => shutdown(Pear.exitCode ?? 0))
