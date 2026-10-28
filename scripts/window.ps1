# downtime: opens, minimizes and restores the windows of the activities the user chose in /downtime.
#
# What it touches: window titles and process command lines (read), the windows (minimize / restore), and it starts the
# browser or the document's own app. It writes no file, opens no connection and runs nothing it was not given a name for.
# It prints one line: "ok:<what happened>" or "error:<why>".
param(
  [Parameter(Mandatory = $true)][ValidateSet('open', 'minimize', 'restore', 'chime')][string]$Action,
  [ValidateSet('url', 'file')][string]$Kind,
  [string]$Target,
  [string]$Match,
  [string]$Profile
)
$ErrorActionPreference = 'Stop'

try {
  if ($Action -eq 'chime') {
    [System.Media.SystemSounds]::Asterisk.Play()
    Start-Sleep -Milliseconds 800
    Write-Output 'ok:chime'
    exit 0
  }

  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
public class WinInfo { public long Handle; public uint Pid; public string Title; }
public static class Win {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  public static List<WinInfo> All() {
    var list = new List<WinInfo>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      int n = GetWindowTextLength(h);
      if (n == 0) return true;
      var s = new StringBuilder(n + 1);
      GetWindowText(h, s, n + 1);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      var w = new WinInfo();
      w.Handle = h.ToInt64();
      w.Pid = pid;
      w.Title = s.ToString();
      list.Add(w);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
'@

  # Never the window the user is working in, whatever its title says.
  $neverThese = @('Code', 'Code - Insiders', 'WindowsTerminal', 'powershell', 'pwsh', 'cmd', 'conhost', 'devenv', 'claude')

  function Find-Windows {
    $all = [Win]::All()
    if ($Kind -eq 'url') {
      # The activity's own browser profile is the key: every window of that profile, and no other.
      $dir = $Profile.Replace('/', '\')
      $pids = @(Get-CimInstance Win32_Process -Filter "Name = 'msedge.exe' OR Name = 'chrome.exe'" |
          Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) } |
          ForEach-Object { [uint32]$_.ProcessId })
      return @($all | Where-Object { $pids -contains $_.Pid })
    }
    if (-not $Match) { throw 'this document has no text to find its window by' }
    $named = @($all | Where-Object { $_.Title.IndexOf($Match, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 })
    return @($named | Where-Object {
        $p = Get-Process -Id $_.Pid -ErrorAction SilentlyContinue
        $p -and ($neverThese -notcontains $p.ProcessName)
      })
  }

  function Restore-Window($w) {
    $h = [IntPtr]$w.Handle
    if (-not [Win]::IsIconic($h)) { return }
    # SW_SHOWNOACTIVATE: back on screen without taking the keyboard from whoever is typing; SW_RESTORE if it stayed down.
    [void][Win]::ShowWindowAsync($h, 4)
    Start-Sleep -Milliseconds 200
    if ([Win]::IsIconic($h)) { [void][Win]::ShowWindowAsync($h, 9) }
  }

  $found = @(Find-Windows)

  if ($Action -eq 'minimize') {
    foreach ($w in $found) { [void][Win]::ShowWindowAsync([IntPtr]$w.Handle, 6) }
    Write-Output ('ok:minimized ' + $found.Count)
  }
  elseif ($Action -eq 'restore') {
    foreach ($w in $found) { Restore-Window $w }
    Write-Output ('ok:restored ' + $found.Count)
  }
  elseif ($found.Count -gt 0) {
    foreach ($w in $found) { Restore-Window $w }
    Write-Output 'ok:already open'
  }
  elseif ($Kind -eq 'url') {
    $dir = $Profile.Replace('/', '\')
    $browserArgs = @(('--app=' + $Target), ('--user-data-dir="' + $dir + '"'), '--no-first-run', '--no-default-browser-check')
    try { Start-Process -FilePath 'msedge' -ArgumentList $browserArgs } catch { Start-Process -FilePath 'chrome' -ArgumentList $browserArgs }
    Write-Output 'ok:opened'
  }
  else {
    $path = $Target.Replace('/', '\')
    if (-not (Test-Path -LiteralPath $path)) { throw ('no such file: ' + $path) }
    Start-Process -FilePath $path
    Write-Output 'ok:opened'
  }
}
catch {
  Write-Output ('error:' + $_.Exception.Message)
}
