# PEAR.md — Canonical Pear Runtime usage

> Read this file before changing anything that touches Pear APIs, workers,
> windows, lifecycle, or the `pear` field in `package.json`.

Targets: **Pear runtime ≥ 2.x**, `pear-electron` ≥ 1.7, Bare ≥ 1.x. Anything tagged `(inferred)` is not directly shown in a surveyed source.

---

## 1. App lifecycle (`Pear.teardown`, exit, reload)

The canonical lifecycle hook is `Pear.teardown(fn)`. Handlers run in registration order when the app begins to unload; promises returned from a handler are awaited before the next runs. Use `Pear.exit(code)` to terminate following the teardown flow — never `Bare.exit()` from app code, since `Bare.exit()` skips teardown. `Pear.reload()`, `Pear.restart()`, `Pear.config`, `Pear.versions()` and the old `Pear.updates`/`Pear.messages`/`Pear.worker` globals are **deprecated** in favor of `location.reload()` (UI), `pear-restart`, `Pear.app`, `pear-updates`, `pear-messages`/`pear-message`, `pear-run`+`pear-pipe`.

```js
// (source: holepunchto/pear/examples/desktop/index.js)
import Runtime from 'pear-electron'
import Bridge from 'pear-bridge'
import updates from 'pear-updates'

updates((update) => { console.log('Application update available:', update) })

const bridge = new Bridge()
await bridge.ready()

const runtime = new Runtime()
const pipe = await runtime.start({ bridge })
pipe.on('close', () => Pear.exit())

Pear.teardown(() => pipe.end())
```

Gotchas:
- `Pear.teardown` may be called multiple times; each call registers a new handler. Don't rely on a single global handler.
- A handler that throws or never resolves stalls shutdown. Wrap async work and add a timeout if it talks to the swarm.
- In a renderer (HTML), to reload the page use `location.reload()` — `Pear.reload()` is deprecated.
- In terminal apps there is no reload.

References: [Pear API → `Pear.teardown`, `Pear.exit`, deprecations](https://docs.pears.com/reference/api.html), [pear/examples/desktop/index.js](https://github.com/holepunchto/pear/blob/main/examples/desktop/index.js).

---

## 2. Window controls (minimize / maximize / close buttons)

`pear.gui.frame: false` removes the native chrome, then the renderer mounts custom buttons that call the `pear-electron` UI API. `Pear.Window`, `Pear.View`, `Pear.media`, `Pear.badge`, `Pear.tray`, and the legacy `{ self }` accessor on `Pear.Window`/`Pear.View` are **deprecated** — use `import ui from 'pear-electron'` and call `ui.app.minimize() / .maximize() / .restore() / .close()` for the current window. Use `ui.app.isMaximized()` to toggle between maximize and restore.

```js
// (source: holepunchto/pear-electron README → User-Interface API)
import ui from 'pear-electron'

document.getElementById('btn-min').onclick   = () => ui.app.minimize()
document.getElementById('btn-max').onclick   = async () => {
  if (await ui.app.isMaximized()) await ui.app.restore()
  else await ui.app.maximize()
}
document.getElementById('btn-close').onclick = () => ui.app.close()
```

Per-window controls also exist on instances created with `new ui.Window(entry, options)`: `win.minimize()`, `win.maximize()`, `win.restore()`, `win.close()`, `win.isMaximized()`, `win.isMinimized()`. From inside a child view/window, `const { parent } = ui.Window` (or `ui.View`) gives access to the parent's window controls; calling `parent.minimize()`/`.maximize()`/`.restore()` on a `parent` that is a `View` throws `TypeError`.

Gotchas:
- Don't fall back to `Pear.Window?.self` — that path is deprecated and will be removed.
- Don't follow `ui.app.close()` with `Pear.exit()` — `close()` already triggers the teardown flow; calling `Pear.exit()` afterward double-tears down.
- For "minimize to tray" set `pear.gui.closeHides: true` in `package.json` and add `ui.app.tray(...)`. On Linux this can hide the app with no way back; gate with `pear.gui.linux.closeHide: false` or skip tray on Linux.
- All `ui.app.*` and `win.*` methods are async and return `Promise<Boolean>`.

References: [pear-electron `ui.app`](https://github.com/holepunchto/pear-electron#ui-app), [pear-electron `ui.Window` / `parent`](https://github.com/holepunchto/pear-electron#parent).

---

## 3. Pear Workers (spawn, IPC, lifecycle)

A "worker" in Pear is a child Pear process spawned with [`pear-run`](https://github.com/holepunchto/pear-run); the child reaches its parent via [`pear-pipe`](https://github.com/holepunchto/pear-pipe). The two ends are a `bare-pipe` `Duplex`. The legacy `Pear.worker` API is deprecated.

Parent (spawn + read result):

```js
// (source: pear-run README + pear-pipe README; pattern matches holepunchto/pear/examples/desktop/index.js)
import run from 'pear-run'

const pipe = run('./worker.js')        // also accepts a pear:// link
pipe.on('data', (chunk) => { /* receive */ })
pipe.on('end',  () => { /* worker finished */ })
pipe.on('crash', ({ exitCode }) => { /* worker crashed */ })
pipe.write(Buffer.from('hello from parent'))
```

Child (`worker.js`, runs as its own Pear app):

```js
// (source: pear-pipe README)
import pipe from 'pear-pipe'
const p = pipe()
if (p === null) {
  // running standalone, not as a child
} else {
  p.on('data', (chunk) => { p.write(Buffer.from('ack')) })
  // p.autoexit defaults to true — when the parent ends, the child exits
}
```

Gotchas:
- `pear-pipe()` returns `null` when the file is run directly (not as a child of `pear-run`). Always guard.
- `pipe.autoexit = true` (default) causes the child to exit on `end`. Set to `false` only if you want a graceful close, and then you MUST do `pipe.on('end', () => pipe.end())` to flush writes.
- Both ends speak Buffers; if you want strings/JSON, encode/decode explicitly. `pipe.end(buffer)` flushes payload + closes the writable side atomically — useful for "single reply" workers.
- The child is a full Pear app: it needs its own `package.json` `pear` config when run from a `pear://` link, but a relative path runs the file directly with the parent's runtime (inferred from `pear-run` README).
- Any `pear://` link the parent passes to `run(...)` must be listed in the parent's `pear.links` (otherwise the sidecar refuses to load it).

References: [pear-run](https://github.com/holepunchto/pear-run), [pear-pipe](https://github.com/holepunchto/pear-pipe), [pear.links](https://docs.pears.com/reference/configuration.html#pear-links).

---

## 4. Events (`Pear.updates`, `Pear.messages`, `Pear.config`)

These three globals are **all deprecated**. Use the installable replacements:

| Deprecated | Use instead |
|---|---|
| `Pear.config` (object) | `Pear.app` (object, [docs](https://docs.pears.com/reference/api.html#pear-app)) |
| `Pear.updates(listener)` | `pear-updates` |
| `Pear.messages(pattern)` / `Pear.message(obj)` | `pear-messages` / `pear-message` |
| `Pear.wakeups(listener)` | `pear-wakeups` |
| `Pear.versions()` | read `Pear.app.*` and `Bare.versions` |

`pear-updates` returns a streamx `Readable` of update events; you can also pass a listener directly. Pattern objects filter the stream:

```js
// (source: pear-updates README)
import updates from 'pear-updates'

updates({ app: true, updated: true }, (u) => {
  // u: { app, version, info, updating, updated }
  // app:true → application updated; app:false → platform updated
})
```

`pear-message` / `pear-messages` form a pattern-matched object bus across an app's processes/threads (parent ⇄ workers, etc.):

```js
// (source: pear-messages README)
import messages from 'pear-messages'
import message  from 'pear-message'

messages({ type: 'my-app/cta-click' }).on('data', (msg) => { /* ... */ })

await message({ type: 'my-app/cta-click', x: 1 })
```

Gotchas:
- `messages()` with no/empty pattern is a catch-all — useful as a debug bus, noisy in production.
- The messages stream is auto-ended during `Pear.teardown`; do not also call `.destroy()` from teardown.
- Run with `pear run --updates-diff` (or `-d`) during development to get diff data on update events. `--no-updates` disables firing entirely.
- `Pear.app.checkpoint` + `Pear.checkpoint(any)` is the canonical way to persist small state across restarts; do not roll your own file-based equivalent for that purpose.

References: [pear-updates](https://github.com/holepunchto/pear-updates), [pear-messages](https://github.com/holepunchto/pear-messages), [pear-message](https://github.com/holepunchto/pear-message), [Pear API → deprecations](https://docs.pears.com/reference/api.html#deprecated-pear.config-object).

---

## 5. `Pear.worker` vs `Pear.applet` vs `Pear.terminal`

**There is no `Pear.worker`, `Pear.applet`, or `Pear.terminal` API on the current `global.Pear`.** These names refer to *kinds of Pear apps* and to *integration libraries*:

- **Desktop app** — `package.json` `pear.pre = "pear-electron/pre"` and `pear.gui` block. Entry is JS that boots `pear-electron` Runtime + `pear-bridge`. (source: `holepunchto/pear/examples/desktop/package.json`)
- **Terminal app** — no `pear.pre`, no `pear.gui`; `pear.bin: "<name>"` exposes it as a CLI. The entry is plain JS run on Bare. (source: `holepunchto/pear/examples/terminal/package.json`)
- **Worker (child app)** — any Pear app that is launched by another Pear app via `pear-run`. The child detects this via `pear-pipe()` returning a non-null pipe. There is no separate "worker type" in the config; it is a runtime relationship.
- **Bare thread** — for in-process parallelism use `Bare.Thread` (not a Pear concept). Workers are heavier (separate process); threads are lighter (same process). (source: `docs.pears.com/reference/api.html#bare-thread`)
- **"Applet"** — the awesome-pears README, the official examples, and `docs.pears.com` do not define `Pear.applet`. **Not covered by surveyed sources.**

Minimal terminal `package.json`:

```json
// (source: holepunchto/pear/examples/terminal/package.json)
{
  "name": "termex",
  "main": "index.js",
  "type": "module",
  "pear": { "name": "termex", "bin": "termex" },
  "dependencies": { "pear-updates": "^1.0.1" }
}
```

Minimal desktop `package.json`:

```json
// (source: holepunchto/pear/examples/desktop/package.json)
{
  "name": "deskex",
  "main": "index.js",
  "type": "module",
  "pear": {
    "pre": "pear-electron/pre",
    "name": "deskex",
    "gui": { "main": "index.html", "width": 900, "height": 500, "minWidth": 500 }
  },
  "dependencies": {
    "pear-bridge": "^1.2.1",
    "pear-electron": "^1.7.25",
    "pear-messages": "^1.0.3",
    "pear-pipe": "^1.0.1",
    "pear-updates": "^1.0.1",
    "pear-wakeups": "^1.0.0"
  }
}
```

---

## 6. `package.json` `pear` field configuration

Authoritative schema is at [docs.pears.com → Configuration](https://docs.pears.com/reference/configuration.html). The fields actually defined on `pear` are: `name`, `stage` (`entrypoints`, `ignore`, `includes`, `defer`), `pre`, `routes`, `unrouted`, `assets`, `links`, and `gui`. UI-specific fields under `pear.gui` are defined by the UI integration library — for `pear-electron` they include `width`, `height`, `x`, `y`, `min/maxWidth/Height`, `center`, `resizable`, `movable`, `minimizable`, `maximizable`, `closable`, `focusable`, `closeHides`, `alwaysOnTop`, `fullscreen`, `kiosk`, `autoHideMenuBar`, `hasShadow`, `opacity`, `transparent`, `backgroundColor`, `userAgent`, and per-platform overrides via `pear.gui.darwin|linux|win32`.

```json
// (source: holepunchto/pear-electron README → Graphical User Interface Options)
{
  "pear": {
    "pre": "pear-electron/pre",
    "name": "my-app",
    "gui": {
      "main": "index.html",
      "width": 900,
      "height": 500,
      "minWidth": 500,
      "darwin": { "resizable": false }
    },
    "links": {
      "myWorker": "pear://somePearKey",
      "host": "https://example.com"
    }
  }
}
```

Gotchas:
- `package.json` `version` is **ignored** — Pear versioning is automatic (key + length + fork). Don't gate logic on it.
- `pear.name` overrides top-level `name`. Names must be lowercase.
- `pear.gui.frame: false` — there is no documented `frame` key in `pear.gui` for `pear-electron`. To go frameless without a chrome titlebar, use `pear.gui.autoHideMenuBar: true` plus a CSS-drawn titlebar; full removal of the system frame is **(inferred)** not explicitly documented.
- `pear.links` is **required** for any `pear://` link or external HTTP host the app contacts at runtime, including child-app links passed to `pear-run`. Defaults block everything except the local sidecar.
- `pear.pre` runs only on `pear run <dir>` and `pear stage <dir>`, **not** on `pear run pear://<link>` — pre output is baked into the staged drive.
- `pear.routes: "."` enables single-page-app routing in combination with `pear-bridge` waypoints.

References: [Configuration](https://docs.pears.com/reference/configuration.html), [pear-electron pear.gui](https://github.com/holepunchto/pear-electron#pear-gui).

---

## 7. Hyperswarm / Hypercore / Corestore in a Pear app

Pear ships nothing swarm-related on `global.Pear`; you import the standard P2P building blocks. Storage path comes from `Pear.app.storage` (the per-app storage directory the runtime hands you).

```js
// (source: docs.pears.com/howto/work-with-many-hypercores-using-corestore + replicate-and-persist-with-hypercore)
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import b4a from 'b4a'

const store  = new Corestore(Pear.app.storage)        // per-app storage path
const core   = store.get({ name: 'main' })
await core.ready()

const swarm = new Hyperswarm()
swarm.on('connection', (conn) => store.replicate(conn))
swarm.join(core.discoveryKey, { server: true, client: true })
await swarm.flush()

Pear.teardown(async () => {
  await swarm.destroy()
  await store.close()
})
```

For a Hyperdrive-backed app (matches this repo's domain):

```js
// (source: docs.pears.com/howto/create-a-full-peer-to-peer-filesystem-with-hyperdrive)
import Hyperdrive from 'hyperdrive'
const drive = new Hyperdrive(store.namespace('drive'))
await drive.ready()
swarm.join(drive.discoveryKey, { server: true, client: true })
```

Gotchas:
- Always pass `Pear.app.storage` to `Corestore` — never a hard-coded path. `pear run -s <path>` and `pear run -t` rely on this for storage isolation.
- Register a `Pear.teardown` that calls `swarm.destroy()` then `store.close()`. Skipping this leaves DHT connections holding the process open.
- Topics are 32-byte buffers. To use a string topic, hash it: `crypto.discoveryKey(b4a.from(topic))` (inferred mechanism; `hypercore-crypto.discoveryKey` is canonical).
- Do not call `swarm.join` on an unready core/drive — `discoveryKey` is undefined until `ready()` resolves.
- `mirror-drive` and `localdrive` are the canonical bridge between the OS filesystem and a Hyperdrive; do not hand-roll file copies.

References: [building-blocks](https://docs.pears.com/), [how-tos](https://docs.pears.com/) (Hypercore, Corestore, Hyperdrive, Hyperswarm).

---

## 8. Building, running, staging, releasing

| Command | Purpose |
|---|---|
| `pear run -d .` | Run from disk in dev mode (devtools + updates-diff). |
| `pear run .` | Run from disk in production mode. |
| `pear run pear://<key>` | Run a peer-to-peer link. |
| `pear run -s <path> .` | Run with a custom storage path. |
| `pear run -t .` | Run with a fresh tmp storage path (great for tests). |
| `pear stage <channel> .` | Snapshot the current dir into the channel's drive (first stage mints the key). |
| `pear stage --dry-run -d <channel> .` | Preview the diff without writing. |
| `pear seed <channel\|link>` | Seed the drive so peers can fetch it. |
| `pear release <channel\|link>` | Mark current length as the production release. |
| `pear info <link>` | Inspect a drive (length, fork, manifest). |
| `pear dump <link> <dir>` | Materialize a drive to a directory. |
| `pear init <template> [dir]` | Scaffold a new project (`default`, `ui`, `node-compat`, or `pear://...` template). |

Lifecycle is **stage → release → seed**. `pear release` only sets a pointer; rolling back is `pear release --checkout <length>` or a `pear dump` + restage.

```sh
# (source: docs.pears.com/reference/cli.html)
pear init -y default my-app
cd my-app
pear run -d .                       # dev loop
pear stage production .              # mints key on first run
pear seed production
pear release production              # mark current length as released
```

Gotchas:
- `pear run -d` **only** affects local-disk runs; running a `pear://` link ignores `-d`.
- `pear stage --compact` does static analysis; anything you `require()` dynamically must be listed in `pear.stage.includes` or `pear.stage.defer`.
- `pear info <link>` length will keep growing while peers seed even after release; the *released* length is what `pear run pear://...` loads.
- Don't commit the auto-generated `.pear` cache — it's per-machine.
- Production-distributable installers should call `pear run --preflight <link>` so `pear.assets` are warm before first launch.

References: [Pear CLI](https://docs.pears.com/reference/cli.html), [Sharing a Pear Application](https://docs.pears.com/), [Releasing a Pear Application](https://docs.pears.com/).

---

## 9. Repo deviations (`p2p_storage`)

Audit performed 2026-04-25 against [package.json](package.json), [index.js](index.js), [app.js](app.js), [index.html](index.html), [window-controls.js](window-controls.js), [worker-pick-folder.cjs](worker-pick-folder.cjs), [src/ui/folder-picker.js](src/ui/folder-picker.js), and `src/**`.

| Where | What it does now | Canonical pattern | Recommended fix |
|---|---|---|---|
| [window-controls.js#L25](window-controls.js#L25) | `getWindow()` returns `Pear.Window?.self ?? Pear.app` | `import ui from 'pear-electron'` and use `ui.app.*` | Replace `getWindow()` calls with `ui.app.minimize()`, `ui.app.maximize()`, `ui.app.close()`. Drop the Pear.Window fallback. |
| [window-controls.js#L33](window-controls.js#L33) | Maximize handler always calls `maximize()` | Toggle: `if (await ui.app.isMaximized()) ui.app.restore(); else ui.app.maximize()` | Implement the toggle so the same button restores when already maximized. |
| [window-controls.js#L37-L40](window-controls.js#L37) | `onClose` calls `getWindow().close()` then `Pear.exit(0)` | `await ui.app.close()` only — `close()` already follows the teardown flow | Remove the `Pear.exit(0)` line; rely on `ui.app.close()`. |
| [index.js#L1-L10](index.js#L1) | Boots runtime but never subscribes to `pear-updates`, never wires `pipe.on('close', () => Pear.exit())` | Canonical desktop entry adds both | Add `import updates from 'pear-updates'; updates(u => log)` and `pipe.on('close', () => Pear.exit())`. |
| [index.js#L9](index.js#L9) | `const pipe = runtime.start({ bridge })` — not awaited | `const pipe = await runtime.start({ bridge })` per the official desktop example | Add `await`. |
| [package.json#L8](package.json#L8) | `pear.type: "desktop"` | `pear.type` is **not** in the documented schema | Remove `pear.type`. The presence of `pear.gui` + `pear.pre = pear-electron/pre` already identifies it as a desktop app. |
| [package.json#L13](package.json#L13) | `pear.gui.frame: false` | `frame` is not a documented `pear.gui` key for `pear-electron` | Either drop the field (rely on default chrome plus your custom controls inside the document) or treat as `(inferred)` and verify against the running build. Track via an issue. |
| [package.json](package.json) | Missing direct deps `pear-run`, `pear-pipe`, `pear-updates`, `pear-messages` even though [src/ui/folder-picker.js#L12](src/ui/folder-picker.js#L12) and [worker-pick-folder.cjs#L51](worker-pick-folder.cjs#L51) import them | Each Pear runtime module the app uses directly should be a direct dependency | Add `pear-run`, `pear-pipe`, `pear-updates`, `pear-messages` to `dependencies`. |
| [worker-pick-folder.cjs#L24](worker-pick-folder.cjs#L24) | Hardcodes `/tmp/worker-debug.log` (POSIX-only path) on a worker that runs on Windows too | Use `bare-os.tmpdir()` joined with a filename, or `Pear.app.storage` (parent only) | Replace with `path.join(require('bare-os').tmpdir(), 'worker-debug.log')` and gate behind a `DEBUG` env. |
| [worker-pick-folder.cjs#L40](worker-pick-folder.cjs#L40) | `send()` does `pipe.end(buf)` and on failure falls back to `write` then `end` | `pear-pipe` README pattern is `pipe.write(buf); pipe.end()` for normal flow; `pipe.end(buf)` only when the result is truly final | Keep `pipe.end(buf)` for the single-shot reply, but log/handle the `crash` event in [src/ui/folder-picker.js#L18](src/ui/folder-picker.js#L18) — currently the `'crash'` event from `pear-run` is not subscribed to. |
| [src/ui/folder-picker.js#L26-L34](src/ui/folder-picker.js#L26) | Listens to `data`, `error`, `end` only | `pear-run` returns a pipe with an extra `'crash'` event (`{ exitCode }`) | Add `pipe.on('crash', ({ exitCode }) => reject(new Error('worker crashed: ' + exitCode)))`. |
| [src/ui/folder-picker.js#L18](src/ui/folder-picker.js#L18) | Passes a relative path `'./worker-pick-folder.cjs'` to `run()` | Documented signatures are `pear://` link, `file://` link, or relative path | OK for dev; for staged builds confirm the worker file is included in `pear.stage.entrypoints` (it is not currently listed). Add it to ensure the worker is shipped. |
| [package.json#L4](package.json#L4) | `"main": "index.js"` while `pear.gui.main: "index.html"` is also set | Both fields are documented; `pear.gui.main` is the renderer entry, top-level `main` is the JS entry | OK as-is; mentioned for clarity. No change required. |

---

## 10. Sources

Curated from [gasolin/awesome-pears](https://github.com/gasolin/awesome-pears) and the canonical Holepunch docs/examples. Capability tags: `gui`, `worker`, `terminal`, `swarm`, `lifecycle`, `events`.

- [docs.pears.com → Pear API reference](https://docs.pears.com/reference/api.html) — authoritative `global.Pear` surface, deprecations. *tags:* lifecycle, events.
- [docs.pears.com → CLI reference](https://docs.pears.com/reference/cli.html) — `pear run/stage/seed/release/info/dump`. *tags:* lifecycle.
- [docs.pears.com → Configuration](https://docs.pears.com/reference/configuration.html) — `package.json` `pear` field schema. *tags:* gui, worker, lifecycle.
- [holepunchto/pear-electron](https://github.com/holepunchto/pear-electron) — `Runtime`, `ui.app`, `ui.Window`, `ui.View`, `pear.gui` schema. *tags:* gui, lifecycle.
- [holepunchto/pear-bridge](https://github.com/holepunchto/pear-bridge) — local HTTP bridge for `pear-electron` apps. *tags:* gui.
- [holepunchto/pear-run](https://github.com/holepunchto/pear-run) — spawn a child Pear app, returns a pipe. *tags:* worker.
- [holepunchto/pear-pipe](https://github.com/holepunchto/pear-pipe) — child-side pipe to the parent app. *tags:* worker.
- [holepunchto/pear-updates](https://github.com/holepunchto/pear-updates) — platform/app update events. *tags:* events, lifecycle.
- [holepunchto/pear-messages](https://github.com/holepunchto/pear-messages) + [pear-message](https://github.com/holepunchto/pear-message) — pattern-matched IPC bus. *tags:* events, worker.
- [holepunchto/pear/examples/desktop](https://github.com/holepunchto/pear/tree/main/examples/desktop) — reference desktop app: `Runtime` + `Bridge` + `pear-updates` + `Pear.teardown`. *tags:* gui, lifecycle, events.
- [holepunchto/pear/examples/terminal](https://github.com/holepunchto/pear/tree/main/examples/terminal) — reference terminal app: `pear.bin`, `pear-updates`, `Pear.versions()`. *tags:* terminal, events.
- [holepunchto/pear-radio](https://github.com/holepunchto/pear-radio) — full P2P desktop app using Hyperswarm/Hypercore. *tags:* gui, swarm.
- [holepunchto/filesharing-react-app-example](https://github.com/holepunchto/filesharing-react-app-example) — Hyperdrive + Hyperswarm + React in a Pear desktop app (closest analogue to this repo). *tags:* gui, swarm, lifecycle.

<!-- manual edits below -->
