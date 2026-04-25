/**
 * Replication Manager
 *
 * Handles symmetric storage replication agreements between peers.
 * Each peer reserves a portion of local disk for the other, and in
 * return gets redundant encrypted copies of their own important files.
 *
 * Responsibilities (to be implemented):
 *  - Negotiate replication agreements (space quotas) with peers
 *  - Allocate subfolder structure under .p2p-vault/<peerKeyHex>/
 *  - Track used vs. available space per peer
 *  - Monitor replication health (all chunks present, peer online, etc.)
 */

export class ReplicationManager {
  constructor () {
    this.agreements = new Map()
  }

  async addAgreement (peerKeyHex, quotaBytes) {
    // TODO: negotiate with peer, create local vault subfolder
    this.agreements.set(peerKeyHex, { quotaBytes, usedBytes: 0 })
  }

  async removeAgreement (peerKeyHex) {
    this.agreements.delete(peerKeyHex)
  }

  getAgreements () {
    return this.agreements
  }
}
