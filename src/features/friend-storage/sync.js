/**
 * Friend Storage Sync
 *
 * Handles encrypted file transfer for storage favours.
 *
 * Flow (to be implemented):
 *  1. Owner encrypts file with their personal key
 *  2. Encrypted blob is sent to the friend's dedicated Hyperdrive
 *  3. Friend stores it locally (cannot decrypt, only holds)
 *  4. On retrieval: owner requests blob, friend serves it,
 *     owner decrypts locally
 */

export async function uploadEncrypted (file, drive, encryptionKey) {
  // TODO: encrypt file, write encrypted blob to friend's drive
}

export async function downloadAndDecrypt (drive, fileName, decryptionKey) {
  // TODO: read encrypted blob from friend's drive, decrypt locally
}

export async function serveStoredFiles (vaultPath, peerDrive) {
  // TODO: mirror locally-stored blobs to the requesting peer
}
