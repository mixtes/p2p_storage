/**
 * Friend Storage Manager
 *
 * Tracks storage favours between friends in the group.
 * A user who is low on local space can ask a friend to hold
 * encrypted files for them. The friend stores opaque blobs they
 * cannot read; only the owner can decrypt on retrieval.
 *
 * Responsibilities (to be implemented):
 *  - Maintain a favour ledger: who stores what, how much space
 *  - Accept incoming storage requests (with space checks)
 *  - Track retrieval requests and fulfil them
 *  - Provide accounting info for the UI
 */

export class FriendStorageManager {
  constructor () {
    this.favours = new Map()
  }

  async offerStorage (peerKeyHex, maxBytes) {
    // TODO: register a storage offer for a friend
    this.favours.set(peerKeyHex, { maxBytes, usedBytes: 0, files: [] })
  }

  async requestStorage (peerKeyHex, file) {
    // TODO: send an encrypted file to a friend for safekeeping
  }

  async retrieveFile (peerKeyHex, fileName) {
    // TODO: download encrypted blob from friend, decrypt locally
  }

  getFavours () {
    return this.favours
  }
}
