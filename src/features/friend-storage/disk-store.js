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

export async function close () {
  if (!drive) return
  try { await drive.close() } catch {}
  drive = null
}
