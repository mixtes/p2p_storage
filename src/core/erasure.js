/**
 * Erasure / replication strategy abstraction.
 *
 * MVP: simple N-copy replication — each chunk is stored verbatim N times.
 *
 * Future improvement: swap in Reed-Solomon erasure coding so that a file
 * is split into K data shards + M parity shards (K+M total). Any K shards
 * are sufficient to reconstruct the original. Storage overhead becomes
 * (K+M)/K instead of N, which is far more efficient at high replication
 * factors.  For example K=4, M=2 gives 1.5x overhead and tolerates 2
 * shard losses, whereas N=6 full-copy gives 6x overhead for the same
 * tolerance.
 *
 * To implement RS later:
 *   1. Add a dependency like `reed-solomon-erasure` (or a WASM port).
 *   2. Replace `encode()` to produce K+M shards from K input blocks.
 *   3. Replace `decode()` to reconstruct from any K of K+M shards.
 *   4. Update the manifest schema: store shard type (data vs parity) and
 *      the K/M parameters alongside each chunk record.
 */

/**
 * Encode a list of chunks into shards for distribution.
 *
 * With simple replication each "shard" is just a verbatim copy, so we
 * return N identical references per chunk.
 *
 * @param {Array<{ id: string, index: number, data: Buffer }>} chunks
 * @param {number} replicationFactor - N (number of copies per chunk)
 * @returns {Array<{ chunkId: string, replicaIndex: number, data: Buffer }>}
 */
export function encode (chunks, replicationFactor) {
  const shards = []
  for (const chunk of chunks) {
    for (let r = 0; r < replicationFactor; r++) {
      shards.push({
        chunkId: chunk.id,
        chunkIndex: chunk.index,
        replicaIndex: r,
        data: chunk.data
      })
    }
  }
  return shards
}

/**
 * Decode shards back into chunks for reassembly.
 *
 * With simple replication we only need one copy of each chunk.
 * We deduplicate by chunkId, picking the first available replica.
 *
 * @param {Array<{ chunkId: string, chunkIndex: number, data: Buffer }>} shards
 * @returns {Array<{ id: string, index: number, data: Buffer }>}
 */
export function decode (shards) {
  const seen = new Map()
  for (const shard of shards) {
    if (!seen.has(shard.chunkId)) {
      seen.set(shard.chunkId, {
        id: shard.chunkId,
        index: shard.chunkIndex,
        data: shard.data
      })
    }
  }
  return [...seen.values()]
}

/**
 * Calculate total storage cost for a given data size and replication factor.
 *
 * @param {number} dataBytes
 * @param {number} replicationFactor
 * @returns {number} total bytes required across the network
 */
export function storageCost (dataBytes, replicationFactor) {
  return dataBytes * replicationFactor
}

/**
 * Minimum storage a peer must offer to replicate `dataBytes` with factor N.
 */
export function minOffer (dataBytes, replicationFactor) {
  return storageCost(dataBytes, replicationFactor)
}
