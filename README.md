# P2P Storage

A decentralized peer-to-peer storage desktop app. No servers, no cloud -- peers
discover each other through the Hyperswarm DHT, exchange Hyperdrive keys, and
replicate data end-to-end with optional encryption.

## Features

### 1. File Sharing (implemented)

Basic group file sharing. Peers join a shared topic, then send and receive
files directly. Files are written into a Hyperdrive and automatically
replicated to every connected peer.

### 2. Storage Replication (planned)

Symmetric encrypted backup between peers. Each peer selects files/folders to
replicate. The data is encrypted locally, then stored on other peers' machines
inside a `.p2p-vault/` directory. In return, the peer provides disk space for
others to do the same. Both sides benefit: redundant off-site copies of
important data without trusting a third party.

### 3. Friend Storage (planned)

Altruistic storage favours within a friend group. A user who is short on local
space can ask a friend to hold encrypted files. The friend stores opaque blobs
they cannot read. Only the original owner can decrypt and retrieve the files.

## Tech Stack

| Library         | Role                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `pear-electron` | Desktop window + renderer (UI lives in `index.html`)                  |
| `corestore`     | Manages the underlying Hypercores for drives                          |
| `hyperdrive`    | Shared filesystem each peer publishes                                 |
| `hyperswarm`    | Peer discovery via a shared 32-byte topic (derived from a room code)  |
| `localdrive`    | Read/write the real filesystem as if it were a drive                  |
| `mirror-drive`  | One-shot diff/copy between any two drives (local <-> hyper)           |

## Project Structure

```
p2p_storage/
  app.js                          Root entry -- thin shim, imports src/app.js
  index.html                      HTML shell with tab navigation
  index.js                        Pear runtime bootstrap
  style.css                       Global styles
  worker-pick-folder.cjs          Native folder picker (Win/macOS)
  package.json

  src/
    app.js                        App entry: initializes core, mounts features

    core/
      store.js                    Corestore + local Hyperdrive initialization
      network.js                  Hyperswarm lifecycle, Protomux key exchange, peer map
      encryption.js               Encrypt/decrypt helpers (stub -- passthrough for now)
      logger.js                   Shared logging utility (writes to #log panel)

    features/
      file-sharing/
        index.js                  Feature entry point
        sync.js                   MirrorDrive push/pull + watcher logic
        ui.js                     DOM bindings for send/receive cards

      replication/
        index.js                  Feature entry point (stub)
        manager.js                Quota tracking, subfolder allocation per peer (stub)
        sync.js                   Bidirectional encrypted replication loop (stub)
        ui.js                     Dashboard DOM bindings (stub)

      friend-storage/
        index.js                  Feature entry point (stub)
        manager.js                Favour ledger, space accounting (stub)
        sync.js                   Encrypted upload/download for favours (stub)
        ui.js                     Favour cards DOM bindings (stub)

    ui/
      router.js                   Tab/view switcher between features
      components.js               Shared renderers: peer list, drive key display
      folder-picker.js            Native folder picker + path resolution helpers
```

## Architecture

### Core Layer (`src/core/`)

Shared infrastructure used by all features.

- **store.js** -- creates a Corestore in `Pear.config.storage` and a writable
  Hyperdrive. Every feature imports this to get the shared store/drive.
- **network.js** -- owns the Hyperswarm instance, handles `join(topic)`, and
  manages the Protomux `p2p-fileshare-keys` channel. Emits events
  (`peerAdd`, `peerRemove`, `join`) that features subscribe to.
- **encryption.js** -- stub exporting `encrypt(buf, key)` / `decrypt(buf, key)`.
  Passthrough for now; will use `sodium-native` for authenticated symmetric
  encryption when features 2 and 3 are implemented.
- **logger.js** -- centralized `log()` and `setStatus()` functions.

### Feature Modules (`src/features/`)

Each feature follows the same pattern:

```
feature/
  index.js    -- init() wires sync + ui together
  sync.js     -- data replication / transfer logic
  ui.js       -- DOM event listeners and rendering
  manager.js  -- state management (features 2 & 3 only)
```

Features are independent of each other. They share the core layer and the
shared UI components, but never import from one another.

### Shared UI (`src/ui/`)

- **router.js** -- reads `data-tab` attributes on nav buttons, toggles
  `.feature-view` visibility.
- **components.js** -- reusable DOM renderers (peer list, drive key display).
- **folder-picker.js** -- `pickFolderNative()` (Pear worker) and
  `folderPathFromInput()` (webkitdirectory input).

## Data Flow (File Sharing)

1. On boot, `src/core/store.js` opens a Corestore and creates a writable
   Hyperdrive (`localDrive`). Its public key is shown in the UI.
2. The user enters a topic string. `src/core/network.js` hashes it into a
   32-byte topic and calls `swarm.join(topic)`.
3. On each new connection, `network.js`:
   - Pipes `store.replicate(conn)` so Hypercores replicate over the stream.
   - Opens a Protomux channel to exchange drive keys.
   - Creates a read-only `Hyperdrive(store, remoteKey)` for the peer.
   - Emits `peerAdd` so features can react.
4. **Send**: the file-sharing feature writes the selected file into `localDrive`.
   Peers replicate it automatically.
5. **Receive**: for each peer drive, `MirrorDrive(peerDrive, Localdrive(folder))`
   syncs files to disk, then a `drive.watch('/')` re-mirrors on every change.

## Setup

```sh
# 1. Install Pear runtime (once per machine)
npm i -g pear

# 2. Install dependencies
cd p2p_storage
npm install

# 3. Run in dev mode (opens desktop window with devtools)
npm run dev
```

## Quick Test (single machine)

Run two instances with separate storage directories:

```sh
# Terminal 1
pear run -d --store ./.pear-a .

# Terminal 2
pear run -d --store ./.pear-b .
```

Use the same topic string in both windows. Send a file from one; the other
receives it.

## Multi-Device Test

1. Launch the app on both devices (both need internet for DHT bootstrap).
2. Enter the same topic string on both sides, click **Join**.
3. On the sender: pick a file, click **Send**.
4. On the receiver: pick a download folder, click **Receive**.
5. The file appears in the receiver's folder. Subsequent sends auto-sync.

## Troubleshooting

- **No peer appears**: check that both machines have outbound UDP and the
  topic strings match exactly.
- **Drive key doesn't change between runs**: expected -- the drive persists
  in `Pear.config.storage`. Delete the storage directory to start fresh.
- **Files don't arrive on receiver**: ensure the receive folder path is
  absolute and writable, and that **Receive** was clicked.
