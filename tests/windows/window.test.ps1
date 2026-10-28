# Tries scripts/window.ps1 for real, on a Windows desktop: it opens a throwaway document and a program in Notepad,
# and web pages in their own Edge profiles, then opens, places, minimizes and restores them and checks the result
# on the windows themselves. It cleans up after itself: the windows it opened are closed, the Edge processes of its
# throwaway profiles are ended and its temporary folder is deleted. It never touches a window it did not open: if a
# Notepad is already running, the Notepad checks are skipped.
#
#   powershell -ExecutionPolicy Bypass -File tests/windows/window.test.ps1
$ErrorActionPreference = 'Stop'
$script = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts\window.ps1'
$work = Join-Path ([IO.Path]::GetTempPath()) ('downtime-test-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force $work | Out-Null
$passed = 0; $failed = 0; $skipped = 0

# ---- a probe that reads the windows as they are --------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Probe {
  public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern IntPtr SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
}
'@
[void][Probe]::SetProcessDpiAwarenessContext([IntPtr](-4))
Add-Type -AssemblyName System.Windows.Forms
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea

# ---- the checks ------------------------------------------------------------------------------------------
function Check($label, $got, $want) {
  if ("$got" -eq "$want") { $script:passed++ } else { $script:failed++; "FAIL $label`n   want: $want`n   got:  $got" }
}
function Has($label, $text, $fragment) {
  if ("$text".Contains($fragment)) { $script:passed++ } else { $script:failed++; "FAIL $label`n   want it to contain: $fragment`n   got: $text" }
}
function Skip($label, $why) { $script:skipped++; "skip $label ($why)" }

# Runs the script like the plugin does: an argument vector for powershell, nothing read by a shell.
function Run([string[]]$Arguments) {
  $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $script) + $Arguments
  [string](& powershell @a)
}
# An empty argument can vanish on a command line, so none is ever passed: no text to match means no -Match.
function Doc([string]$Action, [string]$Path, [string]$Match, [string[]]$More = @()) { Run (@('-Action', $Action, '-Kind', 'file', '-Target', $Path) + $(if ($Match) { @('-Match', $Match) } else { @() }) + $More) }
function App([string]$Action, [string]$Exe, [string]$Match, [string[]]$More = @()) { Run (@('-Action', $Action, '-Kind', 'app', '-Target', $Exe) + $(if ($Match) { @('-Match', $Match) } else { @() }) + $More) }
function Page([string]$Action, [string]$Profile, [string[]]$More = @()) { Run (@('-Action', $Action, '-Kind', 'url', '-Target', 'https://example.com/', '-Profile', $Profile) + $More) }

# The window of a Notepad document, by its file name in the title (what the user sees, not the border Windows adds).
function NotepadWindow([string]$Name) { Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like "*$Name*" } | Select-Object -First 1 }
function Visible([string]$Name) {
  $p = NotepadWindow $Name
  if (-not $p) { return $null }
  $r = New-Object 'Probe+RECT'
  [void][Probe]::DwmGetWindowAttribute($p.MainWindowHandle, 9, [ref]$r, 16)
  "$($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top)"
}
function Iconic([string]$Name) { $p = NotepadWindow $Name; if ($p) { [Probe]::IsIconic($p.MainWindowHandle) } else { $null } }
function Near($label, $got, $want) { # "x,y WxH" within a pixel
  $g = [regex]::Match("$got", '(-?\d+),(-?\d+) (\d+)x(\d+)'); $w = [regex]::Match("$want", '(-?\d+),(-?\d+) (\d+)x(\d+)')
  $ok = $g.Success -and $w.Success
  if ($ok) { 1..4 | ForEach-Object { if ([Math]::Abs([int]$g.Groups[$_].Value - [int]$w.Groups[$_].Value) -gt 1) { $ok = $false } } }
  if ($ok) { $script:passed++ } else { $script:failed++; "FAIL $label`n   want: $want`n   got:  $got" }
}
function CloseNotepad {
  Get-Process -Name notepad -ErrorAction SilentlyContinue | ForEach-Object { [void]$_.CloseMainWindow() }
  for ($i = 0; $i -lt 20 -and (Get-Process -Name notepad -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 250 }
  Get-Process -Name notepad -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue   # they are the ones this test opened
}
function EndProfile([string]$Profile) {
  Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($work) } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}
function BrowserInstalled([string]$Exe) { Test-Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$Exe.exe" }

try {
  # ---- the sound -----------------------------------------------------------------------------------------
  Check 'chime' (Run @('-Action', 'chime')) 'ok:chime'

  # ---- a document in Notepad -----------------------------------------------------------------------------
  $notepadFree = -not (Get-Process -Name notepad -ErrorAction SilentlyContinue)
  if (-not $notepadFree) { Skip 'Notepad checks' 'a Notepad is already running: close it to run them' }
  else {
    $name = 'downtime-doc-' + [Guid]::NewGuid().ToString('N').Substring(0, 6)
    $doc = Join-Path $work "$name.txt"; Set-Content $doc 'test'
    Check 'doc: a wrong monitor is said before anything opens' (Doc 'open' $doc $name @('-Position', 'left', '-Monitor', '3')) 'error:there is no monitor 3 (found 1)'
    Check 'doc: and nothing was opened' ([bool](NotepadWindow $name)) $false
    Check 'doc: no such file' (Doc 'open' (Join-Path $work 'none.txt') 'none') "error:no such file: $(Join-Path $work 'none.txt')"
    Check 'doc: it needs text to be found by' (Doc 'minimize' $doc '') 'error:this document has no text to find its window by'
    Check 'doc: open, and place on the left' (Doc 'open' $doc $name @('-Position', 'left')) 'ok:opened and placed 1'
    Near 'doc: the left half of the work area' (Visible $name) "$($area.X),$($area.Y) $([int][Math]::Floor($area.Width / 2))x$($area.Height)"
    Check 'doc: open again finds it' (Doc 'open' $doc $name) 'ok:already open'
    Check 'doc: minimize' (Doc 'minimize' $doc $name) 'ok:minimized 1'
    Start-Sleep -Milliseconds 600
    Check 'doc: it is minimized' (Iconic $name) $true
    Check 'doc: restore' (Doc 'restore' $doc $name) 'ok:restored 1'
    Start-Sleep -Milliseconds 600
    Check 'doc: it is back' (Iconic $name) $false
    Near 'doc: back where it was' (Visible $name) "$($area.X),$($area.Y) $([int][Math]::Floor($area.Width / 2))x$($area.Height)"
    Check 'doc: place on the right' (Doc 'place' $doc $name @('-Position', 'right')) 'ok:placed 1'
    $half = [int][Math]::Floor($area.Width / 2)
    Near 'doc: the right half' (Visible $name) "$($area.X + $area.Width - $half),$($area.Y) ${half}x$($area.Height)"
    Check 'doc: place on a rectangle' (Doc 'place' $doc $name @('-Position', '100,80,520,420')) 'ok:placed 1'
    Near 'doc: the rectangle' (Visible $name) '100,80 520x420'
    Check 'doc: place needs a position' (Doc 'place' $doc $name) 'error:this activity has no position'
    Check 'doc: minimize, then place' (Doc 'minimize' $doc $name) 'ok:minimized 1'
    Start-Sleep -Milliseconds 600
    Check 'doc: a minimized window can be placed' (Doc 'place' $doc $name @('-Position', 'full')) 'ok:placed 1'
    Near 'doc: all of the work area' (Visible $name) "$($area.X),$($area.Y) $($area.Width)x$($area.Height)"
    Check 'doc: a title nobody has matches nothing' (Doc 'minimize' $doc 'a title nobody has') 'ok:minimized 0'
    CloseNotepad

    # ---- a program, with an argument that has a space ----------------------------------------------------
    $spaced = Join-Path $work "$name two words.txt"; Set-Content $spaced 'test'
    $exe = Join-Path $env:windir 'System32\notepad.exe'
    $json = [Uri]::EscapeDataString((ConvertTo-Json -InputObject @($spaced) -Compress))
    Check 'app: a terminal is refused' (App 'open' (Join-Path $env:windir 'System32\cmd.exe') '' @()) 'error:that program is the window you work in: refused'
    Check 'app: no such program' (App 'open' (Join-Path $work 'nothing.exe') '' @()) "error:no such program: $(Join-Path $work 'nothing.exe')"
    Check 'app: open with an argument that has a space' (App 'open' $exe "$name two words" @('-AppArgs', $json)) 'ok:opened'
    Start-Sleep -Seconds 2
    Check 'app: the argument reached the program whole' ([bool](NotepadWindow "$name two words")) $true
    Check 'app: open again finds its window by its process' (App 'open' $exe "$name two words") 'ok:already open'
    Check 'app: minimize' (App 'minimize' $exe "$name two words") 'ok:minimized 1'
    Check 'app: a title that matches nothing touches nothing' (App 'minimize' $exe 'a title nobody has') 'ok:minimized 0'
    CloseNotepad
  }

  # ---- web pages, each in its own browser profile -------------------------------------------------------
  if (-not (BrowserInstalled 'msedge')) { Skip 'web page checks' 'Edge is not installed' }
  else {
    $one = (Join-Path $work 'profiles\ig').Replace('\', '/')
    $two = (Join-Path $work 'profiles\ig2').Replace('\', '/')   # starts like the first: the two must not be mixed up
    Check 'page: open the first' (Page 'open' $one @('-Browser', 'edge')) 'ok:opened'
    Check 'page: open the second' (Page 'open' $two @('-Browser', 'edge')) 'ok:opened'
    Start-Sleep -Seconds 5
    Check 'page: the first is found, by its profile' (Page 'open' $one @('-Browser', 'edge')) 'ok:already open'
    Has 'page: minimize the first' (Page 'minimize' $one @('-Browser', 'edge')) 'ok:minimized'
    Start-Sleep -Seconds 1
    Check 'page: the second, whose name starts the same, still shows' (Page 'open' $two @('-Browser', 'edge')) 'ok:already open'
    Has 'page: restore the first' (Page 'restore' $one @('-Browser', 'edge')) 'ok:restored'
    Check 'page: another browser finds no window of it' (Page 'minimize' $one @('-Browser', 'brave')) 'ok:minimized 0'
    if (BrowserInstalled 'chrome') { Skip 'page: a browser that is not installed' 'Chrome is installed here' }
    else { Check 'page: a browser that is not installed' (Page 'open' (Join-Path $work 'profiles\x').Replace('\', '/') @('-Browser', 'chrome')) 'error:could not start chrome: is it installed?' }
  }
}
finally {
  CloseNotepad
  EndProfile $work
  Start-Sleep -Seconds 2
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

"$passed passed, $failed failed, $skipped skipped"
if ($failed -gt 0) { exit 1 }
