/**
 * Replication Sync
 *
 * High-level operations that bridge the file system with the
 * replication manager. Handles reading files from disk/drive,
 * feeding them into the chunking + encryption pipeline, and
 * writing retrieved files back to disk.
 */

import b4a from 'b4a'
import { activity, dev } from '../../core/logger.js'
import { getLocalDrive } from '../../core/store.js'
import { replicateFile, retrieveFile, getReplicatedFiles } from './manager.js'

/**
 * Replicate a file from the local Hyperdrive.
 *
 * @param {string} drivePath - path inside the local Hyperdrive (e.g. '/photos/cat.jpg')
 * @param {number} replicationFactor - per-file N
 */
export async function pushFileFromDrive (drivePath, replicationFactor) {
  const drive = getLocalDrive()
  const data = await drive.get(drivePath)

  if (!data) {
    throw new Error('File not found in local drive: ' + drivePath)
  }

  activity.info('replicating from drive: ' + drivePath + ' (' + formatSize(data.length) + ')')
  return replicateFile(drivePath, data, replicationFactor)
}

/**
 * Replicate a raw buffer (e.g. from a file input element).
 *
 * @param {string} fileName - logical name for tracking
 * @param {Buffer|ArrayBuffer|Uint8Array} rawData
 * @param {number} replicationFactor - per-file N
 */
export async function pushFileFromBuffer (fileName, rawData, replicationFactor) {
  const buf = b4a.from(rawData)
  activity.info('replicating file: ' + fileName + ' (' + formatSize(buf.length) + ')')
  return replicateFile(fileName, buf, replicationFactor)
}

/**
 * Retrieve a previously replicated file and write it to the local drive.
 *
 * @param {string} filePath - the path used when the file was replicated
 * @returns {Buffer} decrypted file content
 */
export async function pullFileToBuffer (filePath) {
  activity.info('retrieving replicated file: ' + filePath)
  const data = await retrieveFile(filePath)
  activity.info('retrieved: ' + filePath + ' (' + formatSize(data.length) + ')')
  return data
}

/**
 * Retrieve a file and write it back into the local Hyperdrive.
 *
 * @param {string} filePath - path used during replication
 * @param {string} [destPath] - optional different destination path in drive
 */
export async function pullFileToDrive (filePath, destPath) {
  const data = await retrieveFile(filePath)
  const drive = getLocalDrive()
  const dest = destPath || filePath
  await drive.put(dest, data)
  activity.info('restored to drive: ' + dest + ' (' + formatSize(data.length) + ')')
  return data
}

/**
 * Replicate multiple raw files (e.g. from a folder input or multi-file picker).
 *
 * @param {Array<{ name: string, data: Buffer|Uint8Array }>} files
 * @param {number} replicationFactor - N for all files in this batch
 * @returns {{ total: number, distributed: number, fileCount: number }}
 */
export async function pushFolderFromFiles (files, replicationFactor) {
  let totalDistributed = 0
  let totalShards = 0

  for (const file of files) {
    const buf = b4a.from(file.data)
    activity.info('replicating: ' + file.name + ' (' + formatSize(buf.length) + ')')
    const result = await replicateFile(file.name, buf, replicationFactor)
    totalDistributed += result.distributed
    totalShards += result.total
  }

  return { distributed: totalDistributed, total: totalShards, fileCount: files.length }
}

/**
 * Re-sync all replicated files: re-read from drive, re-chunk any that
 * changed, push updated chunks to keepers.
 */
export async function resyncAll () {
  const files = await getReplicatedFiles()
  const drive = getLocalDrive()
  let updated = 0

  for (const file of files) {
    try {
      const current = await drive.get(file.path)
      if (!current) {
        dev.info('[repl-sync] file removed from drive, skipping: ' + file.path)
        continue
      }

      if (current.length !== file.size) {
        activity.info('re-syncing changed file: ' + file.path)
        await replicateFile(file.path, current, file.replicationFactor || 1)
        updated++
      }
    } catch (err) {
      dev.error('[repl-sync] resync error for ' + file.path + ':', err)
    }
  }

  if (updated > 0) {
    activity.info('re-synced ' + updated + ' changed file(s)')
  }
  return updated
}

function formatSize (bytes) {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i]
}
