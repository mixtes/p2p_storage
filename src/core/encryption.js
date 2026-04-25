import sodium from 'sodium-universal'
import b4a from 'b4a'

/* ── key conversion (ed25519 ↔ curve25519) ─────────────────────────── */

function edPkToCurve (ed25519Pk) {
  const pk = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  sodium.crypto_sign_ed25519_pk_to_curve25519(pk, ed25519Pk)
  return pk
}

function edSkToCurve (ed25519Sk) {
  const sk = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_sign_ed25519_sk_to_curve25519(sk, ed25519Sk)
  return sk
}

/* ── asymmetric (sealed box) ───────────────────────────────────────── */

/**
 * Encrypt so only the owner of recipientPk can decrypt.
 * Uses crypto_box_seal — anonymous sender, no sender authentication.
 *
 * @param {Buffer} message      - plaintext
 * @param {Buffer} recipientPk  - recipient's ed25519 public key (32 B)
 * @returns {Buffer} ciphertext  (message.length + SEALBYTES)
 */
export function encryptForPublicKey (message, recipientPk) {
  const curvePk = edPkToCurve(recipientPk)
  const ciphertext = b4a.alloc(message.length + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(ciphertext, message, curvePk)
  return ciphertext
}

/**
 * Decrypt a sealed-box ciphertext with the recipient's full keypair.
 *
 * @param {Buffer} ciphertext
 * @param {Buffer} pk - recipient's ed25519 public key  (32 B)
 * @param {Buffer} sk - recipient's ed25519 secret key  (64 B)
 * @returns {Buffer|null} plaintext, or null on failure
 */
export function decryptWithKeyPair (ciphertext, pk, sk) {
  const curvePk = edPkToCurve(pk)
  const curveSk = edSkToCurve(sk)
  const message = b4a.alloc(ciphertext.length - sodium.crypto_box_SEALBYTES)
  const ok = sodium.crypto_box_seal_open(message, ciphertext, curvePk, curveSk)
  return ok ? message : null
}

/* ── symmetric (secretbox) ─────────────────────────────────────────── */

/**
 * Encrypt with a shared symmetric key.
 * Returns nonce (24 B) ‖ ciphertext.
 *
 * @param {Buffer} message
 * @param {Buffer} key - 32-byte symmetric key
 * @returns {Buffer}
 */
export function encryptSymmetric (message, key) {
  const nonce = b4a.alloc(sodium.crypto_secretbox_NONCEBYTES)
  sodium.randombytes_buf(nonce)

  const ciphertext = b4a.alloc(message.length + sodium.crypto_secretbox_MACBYTES)
  sodium.crypto_secretbox_easy(ciphertext, message, nonce, key)

  const sealed = b4a.alloc(nonce.length + ciphertext.length)
  b4a.copy(nonce, sealed, 0)
  b4a.copy(ciphertext, sealed, nonce.length)
  return sealed
}

/**
 * Decrypt output of encryptSymmetric.
 *
 * @param {Buffer} sealed - nonce ‖ ciphertext
 * @param {Buffer} key    - 32-byte symmetric key
 * @returns {Buffer|null} plaintext, or null on failure
 */
export function decryptSymmetric (sealed, key) {
  const nonceLen = sodium.crypto_secretbox_NONCEBYTES
  if (sealed.length < nonceLen + sodium.crypto_secretbox_MACBYTES) return null

  const nonce = sealed.subarray(0, nonceLen)
  const ciphertext = sealed.subarray(nonceLen)
  const message = b4a.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
  const ok = sodium.crypto_secretbox_open_easy(message, ciphertext, nonce, key)
  return ok ? message : null
}

/**
 * Generate a random 32-byte symmetric key.
 */
export function generateSymmetricKey () {
  const key = b4a.alloc(sodium.crypto_secretbox_KEYBYTES)
  sodium.randombytes_buf(key)
  return key
}
