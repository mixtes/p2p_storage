import b4a from 'b4a'
import { storeWithFriend, retrieveFromFriend } from './manager.js'

export async function uploadToFriend (friendPeerId, fileName, rawData) {
  const buf = b4a.from(rawData)
  return storeWithFriend(friendPeerId, fileName, buf)
}

export async function downloadFromFriend (fileId) {
  return retrieveFromFriend(fileId)
}
