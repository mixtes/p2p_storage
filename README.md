# P2P FileShare

A direct peer-to-peer file sharing desktop app. No server: peers discover each
other through the Hyperswarm DHT, exchange Hyperdrive keys, and replicate
folders end-to-end.

## How the pieces fit

| Library         | Role                                                                  |
| --------------- | --------------------------------------------------------------------- |
| `pear-electron` | Desktop window + renderer (the UI lives in `index.html` / `app.js`)   |
| `corestore`     | Manages the underlying Hypercores for our drive(s)                    |
| `hyperdrive`    | The shared filesystem each peer publishes                             |
| `hyperswarm`    | Peer discovery via a shared 32-byte topic (derived from a room code)  |
| `localdrive`    | Read/write the user's real filesystem as if it were a drive           |
| `mirror-drive`  | One-shot diff/copy between any two drives (local↔hyper, hyper↔local)  |

### Flow per peer

1. On boot, open a Corestore in `Pear.config.storage` and create a writable
   `Hyperdrive` (`localDrive`). Its key is shown in the UI.
2. Hash the user's topic string → 32-byte topic, `swarm.join(topic)`.
3. Every new swarm connection:
   - Pipes `corestore.replicate(conn)` so cores replicate over it.
   - Writes our drive key, reads the peer's drive key (first 32 bytes).
   - Opens a read-only `Hyperdrive(store, remoteKey)` for that peer.
4. **Send**: `MirrorDrive(Localdrive(sendFolder), localDrive)` pushes local
   files into our drive. Peers replicate them automatically.
5. **Receive**: for every peer drive, run `MirrorDrive(peerDrive,
   Localdrive(recvFolder))`, then watch the peer drive and re-mirror on each
   change.

## Setup (do this on **both** devices)

```sh
# 1. Install Pear runtime once per machine (skip if already installed)
npm i -g pear

# 2. Install the app's dependencies
cd /path/to/p2p
npm install

# 3. Run in dev mode
npm run dev
```

`npm run dev` executes `pear run -d .` which opens the desktop window with
devtools enabled.

## Test: send a file from device A to device B (same LAN)

You need both devices on the internet (Hyperswarm bootstraps via the public
DHT) — same Wi-Fi is fine.

1. **Both devices**: launch the app.
2. **Both devices**: in the **Join a topic** card, type the *same* topic
   string, e.g. `demo-topic-123`, then click **Join**.
   Within a few seconds the status bar should turn green and the other peer's
   drive key appears under "connected peers" on each side.
3. **Device A (sender)**: in **Send a folder**, paste the absolute path of a
   folder containing the file you want to send (e.g. `/Users/uros/share`),
   then click **Mirror → drive**.
   The Activity log prints `pushed … -> drive (1 added, 0 changed, 0 removed)`.
4. **Device B (receiver)**: in **Receive into a folder**, paste an absolute
   path for an empty folder (e.g. `/Users/bob/downloads/from-uros`), then
   click **Start receiving**.
   The Activity log prints `synced from peer (1 added, …)` and the file
   appears in that folder on disk.
5. **Add another file on Device A** to the same `share` folder, click
   **Mirror → drive** again. Device B receives it automatically (via
   `drive.watch()`), no button press needed.

### Quick smoke test on a single machine

If you want to verify before deploying to a second device:

```sh
# Terminal 1
pear run -d --store ./.pear-a .

# Terminal 2
pear run -d --store ./.pear-b .
```

Two windows open, each with its own storage → behave like two separate
peers. Use the same topic string in both.

### Troubleshooting

- **No peer ever appears**: confirm both machines have outbound UDP/internet
  (DHT bootstrap requires it) and the topic strings match exactly.
- **"Drive ready" key doesn't change between runs**: that's expected — the
  drive is persisted in `Pear.config.storage`. Delete that directory to start
  fresh.
- **Files don't appear on the receiver**: make sure the receive folder path
  is *absolute* and writable, and that you clicked **Start receiving**
  *before* expecting auto-sync (you can click it after sending too — the
  mirror runs immediately the first time).
