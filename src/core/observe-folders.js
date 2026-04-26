/* global Pear */
/**
 * Observable folders.
 *
 * Mirrors replication events to on-disk folders so the user can
 * verify communication is working without inspecting Hyperbee state.
 *
 * Encrypted payloads ("_files") are kept separate from JSON metadata
 * sidecars ("_stubs") so the distinction is visible at a glance:
 *
 *   agreements/        one JSON file per active agreement (both sides)
 *   stashed_files/     encrypted chunks I'm holding for other peers (replication keeper)
 *   stashed_stubs/     JSON metadata for the entries in stashed_files/
 *   retrieved_files/   files I've pulled back from keepers (replication owner)
 *   retrieved_stubs/   JSON metadata for the entries in retrieved_files/
 *   rent_files/        encrypted chunks I'm hosting for friends (friend-storage host)
 *   rent_stubs/        JSON metadata for the entries in rent_files/
 *
 * Uses Localdrive (already a project dependency) so the writes work in
 * the Electron renderer — bare-fs is unavailable here because it needs
 * the `Bare` global runtime.
 */

import Localdrive from 'localdrive'
import b4a from 'b4a'
import { dev } from './logger.js'

const projectDir = resolveProjectDir()

const agreementsDrive = projectDir ? new Localdrive(projectDir + '/agreements') : null
const stashedDrive = projectDir ? new Localdrive(projectDir + '/stashed_files') : null
const stashedStubs = projectDir ? new Localdrive(projectDir + '/stashed_stubs') : null
const retrievedDrive = projectDir ? new Localdrive(projectDir + '/retrieved_files') : null
const retrievedStubs = projectDir ? new Localdrive(projectDir + '/retrieved_stubs') : null
const rentDrive = projectDir ? new Localdrive(projectDir + '/rent_files') : null
const rentStubs = projectDir ? new Localdrive(projectDir + '/rent_stubs') : null

if (!projectDir) {
  const link = Pear?.app?.applink ?? Pear?.config?.applink ?? '<none>'
  dev.warn('[observe] project dir not resolved (applink=' + link + ') — observable folders will not be written')
} else {
  dev.info('[observe] writing observable folders under ' + projectDir)
}

function resolveProjectDir () {
  // Pear.config is deprecated in Pear 2.x; Pear.app is the replacement. Fall
  // back so we still work on older runtimes.
  const link = Pear?.app?.applink ?? Pear?.config?.applink
  if (!link) return null
  try {
    const u = new URL(link)
    if (u.protocol === 'file:') {
      let p = decodeURIComponent(u.pathname)
      // On Windows, file:// URL pathnames are like "/C:/Users/...". The leading
      // slash makes Node's path resolver treat it as an absolute path on the
      // current drive, producing "C:\C:\Users\...". Strip it.
      if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1)
      if (p.endsWith('/')) p = p.slice(0, -1)
      return p
    }
  } catch {}
  return null
}

function safeName (s) {
  return String(s).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120)
}

function timestamp () {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function jsonBuf (obj) {
  return b4a.from(JSON.stringify(obj, null, 2))
}

/**
 * Record an agreement transition. Called on both owner and keeper sides
 * when an agreement becomes active.
 */
export async function recordAgreement (info) {
  if (!agreementsDrive) return
  try {
    const peer = safeName(info.peerId || 'unknown')
    const role = info.role || 'peer'
    const name = '/' + role + '_' + peer + '.json'
    const body = { ...info, recordedAt: new Date().toISOString() }
    await agreementsDrive.put(name, jsonBuf(body))
  } catch (err) {
    dev.error('[observe] recordAgreement failed:', err.message)
  }
}

/**
 * Save a copy of an incoming chunk (keeper side). The encrypted payload
 * lands in stashed_files/ and any JSON metadata in stashed_stubs/.
 */
export async function stashIncomingFile (filename, data, meta = {}) {
  if (!stashedDrive) return
  try {
    const name = '/' + safeName(filename)
    await stashedDrive.put(name, b4a.from(data))
    if (stashedStubs && meta && Object.keys(meta).length) {
      await stashedStubs.put(name + '.json', jsonBuf({
        ...meta,
        receivedAt: new Date().toISOString(),
        size: data.length
      }))
    }
  } catch (err) {
    dev.error('[observe] stashIncomingFile failed:', err.message)
  }
}

/**
 * Save an encrypted chunk received from a friend (friend-storage host side).
 * The encrypted payload lands in rent_files/, the JSON sidecar in rent_stubs/.
 */
export async function recordRentFile (fileId, chunkIndex, data, meta = {}) {
  if (!rentDrive) return
  try {
    const base = safeName(fileId.slice(0, 16)) + '_' + chunkIndex
    await rentDrive.put('/' + base + '.enc', b4a.from(data))
    if (rentStubs) {
      await rentStubs.put('/' + base + '.json', jsonBuf({
        ...meta,
        fileId,
        chunkIndex,
        receivedAt: new Date().toISOString(),
        size: data.length
      }))
    }
  } catch (err) {
    dev.error('[observe] recordRentFile failed:', err.message)
  }
}

/**
 * Save a retrieved file (owner side, after pulling chunks back). The
 * decrypted payload lands in retrieved_files/, JSON metadata in
 * retrieved_stubs/.
 */
export async function recordRetrievedFile (filename, data, meta = {}) {
  if (!retrievedDrive) return
  try {
    const base = safeName(filename.split('/').pop() || 'retrieved')
    const stamped = timestamp() + '_' + base
    const name = '/' + stamped
    await retrievedDrive.put(name, b4a.from(data))
    if (retrievedStubs && meta && Object.keys(meta).length) {
      await retrievedStubs.put(name + '.json', jsonBuf({
        ...meta,
        retrievedAt: new Date().toISOString(),
        size: data.length
      }))
    }
  } catch (err) {
    dev.error('[observe] recordRetrievedFile failed:', err.message)
  }
}
