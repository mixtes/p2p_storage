/**
 * Encryption utilities for P2P Storage.
 *
 * Currently a passthrough stub. Will be replaced with sodium-native
 * (available in the Pear/Holepunch runtime) to provide authenticated
 * symmetric encryption before features 2 (replication) and 3 (friend
 * storage) are implemented.
 */

export function encrypt (buf, _key) {
  return buf
}

export function decrypt (buf, _key) {
  return buf
}

export function generateKey () {
  return null
}
