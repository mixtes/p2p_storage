'use strict'
// Pear worker: opens a native folder browser dialog and writes the
// selected absolute path back to the parent (renderer) over pear-pipe.
// Supports Windows (PowerShell + COM) and macOS (osascript).

let process
try { process = require('bare-process') } catch {
  try {
    const os = require('bare-os')
    process = { platform: os.platform(), arch: os.arch(), cwd: os.cwd, exit: (c) => { throw new Error('exit ' + c) } }
  } catch {
    process = { platform: 'unknown', arch: 'unknown', cwd: () => '', exit: () => {} }
  }
}

let dbg = (msg) => {}
let dbgErr = null
try {
  let fs
  try { fs = require('bare-fs') } catch (e1) {
    try { fs = require('fs') } catch (e2) {
      dbgErr = 'fs load failed: bare=' + e1.message + ' node=' + e2.message
    }
  }
  if (fs) {
    const logPath = '/tmp/worker-debug.log'
    dbg = (msg) => {
      try { fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\n') } catch (e) { dbgErr = 'append: ' + e.message }
    }
    dbg('--- worker boot, platform=' + process.platform + ' arch=' + process.arch + ' cwd=' + (process.cwd && process.cwd()))
  }
} catch (err) {
  dbgErr = 'dbg setup threw: ' + err.message
}

function send (msg) {
  dbg('send: ' + msg)
  // pear-pipe expects Buffer chunks; pass data through end() so the
  // payload is flushed atomically before the worker process tears down.
  const buf = Buffer.from(String(msg), 'utf8')
  try { pipe.end(buf) } catch (err) {
    dbg('send: end(buf) threw: ' + err.message)
    try { pipe.write(buf) } catch (e) { dbg('send: write threw: ' + e.message) }
    try { pipe.end() } catch (e) { dbg('send: end() threw: ' + e.message) }
  }
}

let pipe
try {
  pipe = require('pear-pipe')()
} catch (err) {
  // last-resort: print to stderr so something shows up
  console.error('worker: pear-pipe failed: ' + err.message)
  process.exit(1)
}

let spawn
try {
  ;({ spawn } = require('bare-subprocess'))
} catch (err) {
  send('ERR:bare-subprocess load failed: ' + err.message)
  return
}

const platform = process.platform
dbg('dispatching for platform=' + platform + ' dbgErr=' + dbgErr)

if (platform === 'darwin') {
  pickMac()
} else if (platform === 'win32') {
  pickWindows()
} else {
  send('ERR:unsupported platform: ' + platform)
}

function pickMac () {
  // AppleScript: `choose folder` returns an alias; coerce to POSIX path.
  // On cancel, osascript exits non-zero with "User canceled. (-128)".
  const script =
    'try\n' +
    '  set f to choose folder with prompt "Choose download folder"\n' +
    '  POSIX path of f\n' +
    'on error errMsg number errNum\n' +
    '  if errNum is -128 then\n' +
    '    return ""\n' +
    '  else\n' +
    '    error errMsg number errNum\n' +
    '  end if\n' +
    'end try\n'

  dbg('pickMac: about to spawn osascript')
  let proc
  try {
    proc = spawn('/usr/bin/osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe']
    })
    dbg('pickMac: spawned, pid=' + proc.pid)
  } catch (err) {
    dbg('pickMac: spawn threw: ' + err.message)
    send('ERR:spawn osascript failed: ' + err.message)
    return
  }

  let out = ''
  let errBuf = ''
  proc.stdout.on('data', (d) => { out += d.toString(); dbg('osascript stdout chunk: ' + JSON.stringify(d.toString())) })
  proc.stderr.on('data', (d) => { errBuf += d.toString(); dbg('osascript stderr chunk: ' + JSON.stringify(d.toString())) })
  proc.on('error', (err) => { dbg('osascript proc error: ' + err.message); send('ERR:proc error: ' + err.message) })
  proc.on('exit', (code) => {
    dbg('osascript exit code=' + code + ' out=' + JSON.stringify(out) + ' err=' + JSON.stringify(errBuf))
    const trimmed = out.trim()
    if (trimmed) {
      // POSIX paths from `choose folder` end with a trailing slash; strip it
      // (except for root) so downstream path joins behave consistently.
      const path = trimmed.length > 1 && trimmed.endsWith('/')
        ? trimmed.slice(0, -1)
        : trimmed
      send('OK:' + path)
    } else if (code === 0) {
      send('CANCEL')
    } else if (errBuf) {
      send('ERR:' + errBuf.trim())
    } else {
      send('CANCEL')
    }
  })
}

function pickWindows () {
  const ps = `
$ErrorActionPreference = 'Stop'

$src = @"
using System;
using System.Runtime.InteropServices;

public static class FolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
  public class FileOpenDialog { }

  [ComImport, Guid("42F85136-DB7E-439C-85F1-E4075D135FC8"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex();
    void Advise(); void Unadvise();
    void SetOptions(uint fos);
    void GetOptions(out uint fos);
    void SetDefaultFolder();
    void SetFolder();
    void GetFolder(out IShellItem folder);
    void GetCurrentSelection();
    void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem item);
    void AddPlace(); void SetDefaultExtension(); void Close();
    void SetClientGuid(); void ClearClientData(); void SetFilter();
  }

  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),
   InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IShellItem {
    void BindToHandler();
    void GetParent();
    [PreserveSig] int GetDisplayName(uint sigdnName,
        [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
    void GetAttributes(); void Compare();
  }

  public static string Pick(string title) {
    var dlg = (IFileDialog)(new FileOpenDialog());
    dlg.SetOptions(0x00000020 /* FOS_PICKFOLDERS */
                 | 0x00000008 /* FOS_NOCHANGEDIR */
                 | 0x00001000 /* FOS_FORCEFILESYSTEM */);
    if (title != null) dlg.SetTitle(title);
    int hr = dlg.Show(IntPtr.Zero);
    if (hr != 0) return null;
    IShellItem item;
    dlg.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000u /* SIGDN_FILESYSPATH */, out path);
    return path;
  }
}
"@

Add-Type -TypeDefinition $src -Language CSharp | Out-Null
$path = [FolderPicker]::Pick('Choose download folder')
if ($path) { [Console]::Out.Write($path) }
`

let proc
try {
  proc = spawn('powershell.exe', ['-NoProfile', '-Sta', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
} catch (err) {
  send('ERR:spawn failed: ' + err.message)
  return
}

let out = ''
let errBuf = ''
proc.stdout.on('data', (d) => { out += d.toString() })
proc.stderr.on('data', (d) => { errBuf += d.toString() })
proc.on('error', (err) => send('ERR:proc error: ' + err.message))
  proc.on('exit', () => {
    const trimmed = out.trim()
    if (trimmed) send('OK:' + trimmed)
    else if (errBuf) send('ERR:' + errBuf.trim())
    else send('CANCEL')
  })
}
