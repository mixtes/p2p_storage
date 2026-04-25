/* global Pear */
/**
 * Friend-storage on-disk store.
 *
 * Layout: <Pear.config.storage>/friend-storage/<requesterHex>/<fileName>
 *
 * One Localdrive instance is rooted at the friend-storage directory and each
 * requester's parked files live in a subdirectory named after their drive key.
 * Plain bytes for now; AEAD wrapping will be slotted into put/get when
 * encryption lands (see PEAR.md note).
 */

import Localdrive from 'localdrive'
import b4a from 'b4a'

let drive = null

function rootPath () {
  // Pear.config.storage is the absolute storage path Pear assigns to the app.
  // Strip a trailing separator and append our subfolder; Localdrive normalises
  // the rest, so a forward slash works on Windows too.
  const base = String(Pear.config.storage || '.').replace(/[/\\]+$/, '')
  return base + '/friend-storage'
}

function getDrive () {
  if (drive) return drive
  drive = new Localdrive(rootPath())
  return drive
}

// Sanitise a filename so peers can't traverse out of their subdirectory.
function safeName (fileName) {
  const s = String(fileName).replace(/[/\\]/g, '_').replace(/^\.+/, '_')
  return s.length > 0 ? s : '_unnamed'
}

function pathFor (requesterHex, fileName) {
  return '/' + requesterHex + '/' + safeName(fileName)
}

export async function putFile (requesterHex, fileName, data) {
  const d = getDrive()
  await d.put(pathFor(requesterHex, fileName), b4a.from(data))
}

export async function getFile (requesterHex, fileName) {
  const d = getDrive()
  return await d.get(pathFor(requesterHex, fileName))  // Buffer | null
}

export async function deleteFile (requesterHex, fileName) {
  const d = getDrive()
  try { await d.del(pathFor(requesterHex, fileName)) } catch {}
}

// ── Outbound queue (queued but not-yet-delivered files) ───────────────────────
//
// Layout: <root>/_outbound/<friendHex>/<safeName>
// Stored separately from accepted incoming files so the two can't collide.

function outboundPath (friendHex, fileName) {
  return '/_outbound/' + friendHex + '/' + safeName(fileName)
}

export async function putOutbound (friendHex, fileName, data) {
  const d = getDrive()
  await d.put(outboundPath(friendHex, fileName), b4a.from(data))
}

export async function getOutbound (friendHex, fileName) {
  const d = getDrive()
  return await d.get(outboundPath(friendHex, fileName))  // Buffer | null
}

export async function deleteOutbound (friendHex, fileName) {
  const d = getDrive()
  try { await d.del(outboundPath(friendHex, fileName)) } catch {}
}

// Returns [{ friendHex, fileName }, ...] for every file currently buffered in
// the outbound queue on disk. Used at startup to rehydrate _outboundQueue.
export async function listOutbound () {
  const d = getDrive()
  const out = []
  try {
    for await (const entry of d.list('/_outbound', { recursive: true })) {
      const parts = entry.key.split('/').filter(Boolean)
      if (parts.length < 3) continue
      const friendHex = parts[1]
      const fileName  = parts.slice(2).join('/')
      out.push({ friendHex, fileName })
    }
  } catch {}
  return out
}

// Returns [{ requesterHex, fileName }, ...] for every accepted incoming file
// on disk. Used at startup to reconcile _incoming with the disk.
export async function listIncoming () {
  const d = getDrive()
  const out = []
  try {
    for await (const entry of d.list('/', { recursive: true })) {
      const parts = entry.key.split('/').filter(Boolean)
      // Skip outbound queue entries.
      if (parts.length === 0 || parts[0] === '_outbound') continue
      if (parts.length < 2) continue
      const requesterHex = parts[0]
      const fileName     = parts.slice(1).join('/')
      out.push({ requesterHex, fileName })
    }
  } catch {}
  return out
}

export async function close () {
  if (!drive) return
  try { await drive.close() } catch {}
  drive = null
}
