# downtime: opens, places, minimizes and restores the windows of the activities the user chose in /dt.
#
# What it touches: window titles and process command lines (read), the windows (place / minimize / restore), and it
# starts the browser or the document's own app. It writes no file, opens no connection and runs nothing it was not
# given a name for. It prints one line: "ok:<what happened>" or "error:<why>".
param(
  [Parameter(Mandatory = $true)][ValidateSet('open', 'minimize', 'restore', 'place', 'chime')][string]$Action,
  [ValidateSet('url', 'file', 'app')][string]$Kind,
  [string]$Target,
  # An application's arguments: a JSON list of texts, percent-encoded, so no command line can read any of it.
  [string]$AppArgs,
  [string]$Match,
  [string]$Profile,
  [ValidateSet('edge', 'chrome', 'brave')][string]$Browser,
  # A side of a monitor's work area, or "x,y,width,height" in screen pixels.
  [ValidatePattern('^(left|right|top|bottom|full|-?\d+,-?\d+,\d+,\d+)$')][string]$Position,
  [ValidateRange(1, 8)][int]$Monitor
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
  public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr context);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attribute, out RECT r, int size);
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

  # Pixels must be real pixels, whatever the display scaling: ask for per-monitor awareness (-4) before any screen is read.
  try { [void][Win]::SetProcessDpiAwarenessContext([IntPtr](-4)) } catch { }

  # The browsers a web activity may name: the program each one starts and runs as.
  $exeNames = @{ edge = 'msedge'; chrome = 'chrome'; brave = 'brave' }

  # Never the window the user is working in, whatever its title says.
  $neverThese = @('Code', 'Code - Insiders', 'WindowsTerminal', 'powershell', 'pwsh', 'cmd', 'conhost', 'devenv', 'claude')

  function Find-Windows {
    $all = [Win]::All()
    if ($Kind -eq 'url') {
      # The activity's own browser profile is the key: every window of that profile, and no other.
      $dir = $Profile.Replace('/', '\')
      $names = if ($Browser) { @($exeNames[$Browser] + '.exe') } else { @('msedge.exe', 'chrome.exe') }
      # The profile must end where the path ends: ...\instagram is not ...\instagram-2.
      $sameProfile = New-Object System.Text.RegularExpressions.Regex ([regex]::Escape($dir) + '(?![A-Za-z0-9._-])')
      $pids = @(Get-CimInstance Win32_Process |
          Where-Object { ($names -contains $_.Name) -and $_.CommandLine -and $sameProfile.IsMatch($_.CommandLine) } |
          ForEach-Object { [uint32]$_.ProcessId })
      return @($all | Where-Object { $pids -contains $_.Pid })
    }
    if ($Kind -eq 'app') {
      # Every window of the program's processes, narrowed by the title when one was given.
      $program = [IO.Path]::GetFileNameWithoutExtension($Target)
      if ($neverThese -contains $program) { throw 'that program is the window you work in: refused' }
      $pids = @(Get-Process -Name $program -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
      $mine = @($all | Where-Object { $pids -contains $_.Pid })
      if ($Match) { $mine = @($mine | Where-Object { $_.Title.IndexOf($Match, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
      return $mine
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

  # Where the window goes, in screen pixels: a side of a monitor's work area (the taskbar left out), or the rectangle given.
  function Get-Rect {
    if ($Position -match '^(-?\d+),(-?\d+),(\d+),(\d+)$') {
      return @{ X = [int]$Matches[1]; Y = [int]$Matches[2]; W = [int]$Matches[3]; H = [int]$Matches[4] }
    }
    Add-Type -AssemblyName System.Windows.Forms
    # Monitor 1 is the main one; the others follow from left to right.
    $screens = @([System.Windows.Forms.Screen]::AllScreens | Sort-Object { if ($_.Primary) { 0 } else { 1 } }, { $_.Bounds.X })
    $n = if ($Monitor) { $Monitor } else { 1 }
    if ($n -gt $screens.Count) { throw ('there is no monitor ' + $n + ' (found ' + $screens.Count + ')') }
    $a = $screens[$n - 1].WorkingArea
    $halfW = [int][Math]::Floor($a.Width / 2)
    $halfH = [int][Math]::Floor($a.Height / 2)
    switch ($Position) {
      'left' { return @{ X = $a.X; Y = $a.Y; W = $halfW; H = $a.Height } }
      'right' { return @{ X = $a.X + $a.Width - $halfW; Y = $a.Y; W = $halfW; H = $a.Height } }
      'top' { return @{ X = $a.X; Y = $a.Y; W = $a.Width; H = $halfH } }
      'bottom' { return @{ X = $a.X; Y = $a.Y + $a.Height - $halfH; W = $a.Width; H = $halfH } }
      default { return @{ X = $a.X; Y = $a.Y; W = $a.Width; H = $a.Height } }
    }
  }

  # Puts each real window of the activity on the rectangle, without activating it; returns how many it moved.
  function Place-Windows($Windows, $Rect) {
    $placed = 0
    foreach ($w in $Windows) {
      $h = [IntPtr]$w.Handle
      if ([Win]::IsZoomed($h)) { [void][Win]::ShowWindowAsync($h, 1); Start-Sleep -Milliseconds 150 }
      Restore-Window $w
      $r = New-Object 'Win+RECT'
      [void][Win]::GetWindowRect($h, [ref]$r)
      # A browser has small helper windows besides the one the user sees.
      if ((($r.Right - $r.Left) -lt 200) -or (($r.Bottom - $r.Top) -lt 150)) { continue }
      # Windows 10 and 11 add an invisible border to a window: ask for the rectangle of what is seen.
      $f = New-Object 'Win+RECT'
      if ([Win]::DwmGetWindowAttribute($h, 9, [ref]$f, 16) -ne 0) { $f = $r }
      $left = $f.Left - $r.Left
      $top = $f.Top - $r.Top
      $right = $r.Right - $f.Right
      $bottom = $r.Bottom - $f.Bottom
      # SWP_NOZORDER | SWP_NOACTIVATE
      [void][Win]::SetWindowPos($h, [IntPtr]::Zero, $Rect.X - $left, $Rect.Y - $top, $Rect.W + $left + $right, $Rect.H + $top + $bottom, 0x14)
      $placed++
    }
    return $placed
  }

  # A wrong monitor or position is said before anything opens.
  $rect = if ($Position) { Get-Rect } else { $null }
  if ($Action -eq 'place' -and -not $rect) { throw 'this activity has no position' }

  $found = @(Find-Windows)

  if ($Action -eq 'minimize') {
    foreach ($w in $found) { [void][Win]::ShowWindowAsync([IntPtr]$w.Handle, 6) }
    Write-Output ('ok:minimized ' + $found.Count)
  }
  elseif ($Action -eq 'restore') {
    foreach ($w in $found) { Restore-Window $w }
    Write-Output ('ok:restored ' + $found.Count)
  }
  elseif ($Action -eq 'place') {
    Write-Output ('ok:placed ' + (Place-Windows -Windows $found -Rect $rect))
  }
  elseif ($found.Count -gt 0) {
    # Already open: it comes back where it was, wherever the user has put it since.
    foreach ($w in $found) { Restore-Window $w }
    Write-Output 'ok:already open'
  }
  else {
    if ($Kind -eq 'url') {
      $dir = $Profile.Replace('/', '\')
      $browserArgs = @(('--app=' + $Target), ('--user-data-dir="' + $dir + '"'), '--no-first-run', '--no-default-browser-check')
      # A browser the user named is the only one tried; without one, Edge and then Chrome.
      $candidates = if ($Browser) { @($exeNames[$Browser]) } else { @('msedge', 'chrome') }
      $started = $false
      foreach ($exe in $candidates) {
        try { Start-Process -FilePath $exe -ArgumentList $browserArgs; $started = $true; break } catch { }
      }
      if (-not $started) { throw ('could not start ' + ($candidates -join ' or ') + ': is it installed?') }
    }
    elseif ($Kind -eq 'app') {
      $path = $Target.Replace('/', '\')
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw ('no such program: ' + $path) }
      # The arguments come as written: each one reaches the program whole, quoted only so that it stays one argument.
      $argList = @()
      if ($AppArgs) { $argList = @(ConvertFrom-Json -InputObject ([Uri]::UnescapeDataString($AppArgs))) }
      $quoted = @($argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { [string]$_ } })
      if ($quoted.Count -gt 0) { Start-Process -FilePath $path -ArgumentList $quoted } else { Start-Process -FilePath $path }
    }
    else {
      $path = $Target.Replace('/', '\')
      if (-not (Test-Path -LiteralPath $path)) { throw ('no such file: ' + $path) }
      Start-Process -FilePath $path
    }
    if (-not $rect) { Write-Output 'ok:opened'; exit 0 }
    # Placed as soon as its window shows, and once more a moment later: a window can settle after its first show.
    $placed = 0
    for ($i = 0; $i -lt 40 -and $placed -eq 0; $i++) {
      Start-Sleep -Milliseconds 250
      $placed = Place-Windows -Windows @(Find-Windows) -Rect $rect
    }
    if ($placed -gt 0) {
      Start-Sleep -Milliseconds 500
      [void](Place-Windows -Windows @(Find-Windows) -Rect $rect)
      Write-Output ('ok:opened and placed ' + $placed)
    }
    else { Write-Output 'ok:opened, not placed: its window did not show up in time' }
  }
}
catch {
  Write-Output ('error:' + $_.Exception.Message)
}
