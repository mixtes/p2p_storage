import cryptoLib from 'hypercore-crypto'
import b4a from 'b4a'

export const CHUNK_SIZE = 256 * 1024 // 256 KB

/**
 * Split a buffer into fixed-size chunks with deterministic IDs.
 *
 * @param {Buffer} data        - file contents
 * @param {string} filePath    - logical path (used in chunk ID derivation)
 * @param {Buffer} ownerPubKey - owner's public key (32 bytes)
 * @returns {{ chunks: Array<{ id: string, index: number, data: Buffer }>, totalSize: number }}
 */
export function chunkBuffer (data, filePath, ownerPubKey) {
  const total = data.length
  const chunks = []
  let offset = 0
  let index = 0

  while (offset < total) {
    const end = Math.min(offset + CHUNK_SIZE, total)
    const slice = data.subarray(offset, end)
    const id = deriveChunkId(ownerPubKey, filePath, index)
    chunks.push({ id, index, data: slice })
    offset = end
    index++
  }

  return { chunks, totalSize: total }
}

/**
 * Reassemble a file from an ordered list of chunk buffers.
 *
 * @param {Array<{ index: number, data: Buffer }>} chunks - chunks in any order
 * @param {number} totalSize - original file size (for validation)
 * @returns {Buffer}
 */
export function reassemble (chunks, totalSize) {
  const sorted = chunks.slice().sort((a, b) => a.index - b.index)
  const out = b4a.alloc(totalSize)
  let offset = 0

  for (const chunk of sorted) {
    b4a.copy(chunk.data, out, offset)
    offset += chunk.data.length
  }

  if (offset !== totalSize) {
    throw new Error('Reassembly size mismatch: expected ' + totalSize + ', got ' + offset)
  }
  return out
}

/**
 * Deterministic chunk ID = hex(blake2b(ownerPubKey || utf8(filePath) || le32(index)))
 */
export function deriveChunkId (ownerPubKey, filePath, index) {
  const pathBuf = b4a.from(filePath, 'utf-8')
  const indexBuf = b4a.alloc(4)
  new DataView(indexBuf.buffer, indexBuf.byteOffset, 4).setUint32(0, index, true)

  const input = b4a.alloc(ownerPubKey.length + pathBuf.length + 4)
  b4a.copy(ownerPubKey, input, 0)
  b4a.copy(pathBuf, input, ownerPubKey.length)
  b4a.copy(indexBuf, input, ownerPubKey.length + pathBuf.length)

  return b4a.toString(cryptoLib.hash(input), 'hex')
}

/**
 * Compute how many chunks a file of `size` bytes will produce.
 */
export function chunkCount (size) {
  return Math.ceil(size / CHUNK_SIZE) || 1
}
