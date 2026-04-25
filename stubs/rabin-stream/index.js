// Local stub replacing the deprecated `rabin-stream` (and its `rabin-native`
// addon) which fails to load under Pear's bundled runtime. mirror-drive only
// instantiates RabinStream when constructed with { dedup: true }, which this
// app never does — so a throwing stub is safe.
module.exports = class RabinStream {
  constructor () {
    throw new Error('rabin-stream is stubbed in this project; dedup is not supported')
  }
}
