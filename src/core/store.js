/* global Pear */
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import b4a from 'b4a'

let store = null
let localDrive = null

export async function init () {
  const { config } = Pear

  store = new Corestore(config.storage)
  await store.ready()

  localDrive = new Hyperdrive(store.namespace('local'))
  await localDrive.ready()

  return { store, localDrive }
}

export function getStore () {
  return store
}

export function getLocalDrive () {
  return localDrive
}

export function getLocalKeyHex () {
  return b4a.toString(localDrive.key, 'hex')
}
