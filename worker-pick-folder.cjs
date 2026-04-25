'use strict'
// Pear worker: opens a Windows folder browser dialog and writes the
// selected absolute path back to the parent (renderer) over pear-pipe.

function send (msg) {
  try { pipe.write(msg) } catch {}
  try { pipe.end() } catch {}
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
