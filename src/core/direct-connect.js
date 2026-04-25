/* global Pear */
import DHT from 'hyperdht'
import b4a from 'b4a'

let dht = null
let server = null

/**
 * Boot a HyperDHT node. Call once at app startup.
 */
export async function init () {
  dht = new DHT()
  Pear.teardown(() => destroy())
  return dht
}

/**
 * Start listening for direct connections on the user's identity keypair.
 *
 * The identity keypair from identity.js uses the same seed format as
 * DHT.keyPair(seed), so the user's public key doubles as their DHT
 * address — peers connect by knowing that one key.
 *
 * @param {{ publicKey: Buffer, secretKey: Buffer }} keyPair
 * @param {(conn: object) => void} onConnection
 */
export async function listen (keyPair, onConnection) {
  if (!dht) throw new Error('DHT not initialized — call init() first')

  server = dht.createServer(onConnection)
  await server.listen(keyPair)
  return server
}

/**
 * Open a direct connection to a peer by their public key.
 *
 * @param {string} publicKeyHex - 64-char hex public key
 * @returns {object} encrypted NoiseSocket stream
 */
export function connectToPeer (publicKeyHex) {
  if (!dht) throw new Error('DHT not initialized — call init() first')
  return dht.connect(b4a.from(publicKeyHex, 'hex'))
}

/**
 * Tear down server + DHT node.
 */
export async function destroy () {
  if (server) { await server.close(); server = null }
  if (dht) { await dht.destroy(); dht = null }
}

export function getServer () { return server }
export function getDHT () { return dht }
