/* global Pear */
import sodium from 'sodium-universal'
import crypto from 'hypercore-crypto'
import b4a from 'b4a'

const SEED_BYTES = 32

let keyPair = null
let seed = null

/**
 * Initialize user identity. Loads an existing keypair from the Corestore,
 * or generates a new one on first run.
 *
 * @param {Corestore} store - initialized Corestore instance
 * @returns {{ publicKey: Buffer, isNew: boolean }}
 */
export async function init (store) {
  const core = store.get({ name: 'user-identity' })
  await core.ready()

  let isNew = false

  if (core.length === 0) {
    seed = b4a.alloc(SEED_BYTES)
    sodium.randombytes_buf(seed)
    await core.append(seed)
    isNew = true
  } else {
    seed = await core.get(0)
  }

  keyPair = crypto.keyPair(seed)
  return { publicKey: keyPair.publicKey, isNew }
}

/**
 * Recover identity from a previously saved seed (hex string).
 * Must be called on a fresh install before init().
 *
 * @param {string} seedHex - 64-char hex string (32 bytes)
 * @param {Corestore} store - initialized Corestore instance
 * @returns {{ publicKey: Buffer }}
 */
export async function recoverFromSeed (seedHex, store) {
  const recovered = b4a.from(seedHex, 'hex')
  if (recovered.length !== SEED_BYTES) {
    throw new Error('Invalid seed: expected ' + SEED_BYTES + ' bytes, got ' + recovered.length)
  }

  const core = store.get({ name: 'user-identity' })
  await core.ready()

  if (core.length > 0) {
    throw new Error('Identity already exists on this device. Recovery is only for fresh installs.')
  }

  await core.append(recovered)
  seed = recovered
  keyPair = crypto.keyPair(seed)

  return { publicKey: keyPair.publicKey }
}

export function getKeyPair () {
  return keyPair
}

export function getPublicKey () {
  return keyPair?.publicKey ?? null
}

export function getSecretKey () {
  return keyPair?.secretKey ?? null
}

export function getPublicKeyHex () {
  return keyPair ? b4a.toString(keyPair.publicKey, 'hex') : null
}

/**
 * Returns the 32-byte seed as hex. This is the user's recovery key —
 * they must store it securely. Anyone with this seed can derive the
 * full keypair and impersonate the user.
 */
export function getRecoverySeedHex () {
  return seed ? b4a.toString(seed, 'hex') : null
}
