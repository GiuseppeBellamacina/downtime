#!/usr/bin/env bash
# Tries scripts/window-macos.sh (and window-linux.sh, when it exists) against stand-ins for the system tools:
# each stand-in records its name and arguments in a log, and answers like the real one would.
# It tests the script's own logic (what it asks the system, in what order, with what arguments); whether
# System Events or the window manager do what they are asked is for a real Mac and a real desktop to say.
# Runs anywhere with bash:  bash tests/unix/scripts.test.sh
# shellcheck disable=SC2016  # the stand-ins are written in single quotes on purpose: their $ must reach the stand-in's own shell
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STUBS=$WORK/bin
mkdir -p "$STUBS" "$WORK/apps"
export STUB_LOG=$WORK/calls.log
: > "$STUB_LOG"
passed=0
failed=0

# ---- stand-ins for the system tools --------------------------------------------------------------------
LOGGER='{ printf "%s" "$(basename "$0")"; for a in "$@"; do printf " [%s]" "$a"; done; echo; } >> "$STUB_LOG"'
stub() { printf '#!/bin/sh\n%s\n%s\n' "$LOGGER" "$2" > "$STUBS/$1"; chmod +x "$STUBS/$1"; }

stub osascript 'if [ -n "${STUB_OSA_FAIL-}" ]; then echo "$STUB_OSA_FAIL" >&2; exit 1; fi; echo "${STUB_OSA_COUNT-1}"'
stub open ':'
stub afplay ':'
stub defaults 'echo Player'
stub nohup 'exec "$@"'
# ps answers with the process table, or (ps -o comm= -p PID) with the name of one process.
cat > "$STUBS/ps" << 'EOF'
#!/bin/sh
if [ "$1" = -o ]; then
  eval "printf '%s\n' \"\${STUB_COMM_$4-unknown}\""
else
  printf '%s\n' "${STUB_PS-}"
fi
EOF
cat > "$STUBS/pgrep" << 'EOF'
#!/bin/sh
printf '%s\n' "${STUB_PGREP-}"
EOF
chmod +x "$STUBS/ps" "$STUBS/pgrep"

# The Linux tools, and the browsers kept apart so that a test can leave them out.
stub wmctrl 'printf "%s\n" "${STUB_WMCTRL-}"'
stub xdotool ':'
stub xdg-open ':'
stub canberra-gtk-play ':'
mkdir -p "$WORK/browsers"
for b in microsoft-edge google-chrome brave-browser; do
  printf '#!/bin/sh\n%s\n' "$LOGGER" > "$WORK/browsers/$b"
  chmod +x "$WORK/browsers/$b"
done

# A program the script may start: it records the arguments it receives, one by one.
printf '#!/bin/sh\n%s\n' "$LOGGER" > "$WORK/Player"; chmod +x "$WORK/Player"

# ---- the checks -----------------------------------------------------------------------------------------
check() { # check <label> <got> <want>
  if [ "$2" = "$3" ]; then passed=$((passed + 1)); else failed=$((failed + 1)); printf 'FAIL %s\n   want: %s\n   got:  %s\n' "$1" "$3" "$2"; fi
}
has() { # has <label> <text> <fragment>
  case "$2" in *"$3"*) passed=$((passed + 1)) ;; *) failed=$((failed + 1)); printf 'FAIL %s\n   want it to contain: %s\n   got: %s\n' "$1" "$3" "$2" ;; esac
}
lacks() { # lacks <label> <text> <fragment>
  case "$2" in *"$3"*) failed=$((failed + 1)); printf 'FAIL %s\n   want it not to contain: %s\n   got: %s\n' "$1" "$3" "$2" ;; *) passed=$((passed + 1)) ;; esac
}
calls() { cat "$STUB_LOG"; }
fresh() {
  : > "$STUB_LOG"
  unset STUB_OSA_FAIL STUB_PS STUB_PGREP STUB_WMCTRL
  export STUB_OSA_COUNT=1 DOWNTIME_APP_DIRS="$WORK/apps" DISPLAY=:0 XDG_SESSION_TYPE=x11
  export DOWNTIME_BIN_DIRS="$STUBS:$WORK/browsers"
}
mac() { PATH="$STUBS:$PATH" bash "$ROOT/scripts/window-macos.sh" "$@"; }
linux() { PATH="$STUBS:$PATH" bash "$ROOT/scripts/window-linux.sh" "$@"; }

PROFILE=/p/profiles/instagram
EDGE_MAIN="  4242 /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --app=https://x.test --user-data-dir=$PROFILE --no-first-run"
EDGE_HELPER="  4243 /Applications/Microsoft Edge.app/Contents/Frameworks/Helper --type=renderer --user-data-dir=$PROFILE"
OTHER_PROFILE="  4300 /Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge --app=https://y.test --user-data-dir=${PROFILE}-2 --no-first-run"

# ---- macOS ----------------------------------------------------------------------------------------------
fresh
check 'mac: chime' "$(mac --action chime)" 'ok:chime'
has 'mac: chime plays a system sound' "$(calls)" 'afplay [/System/Library/Sounds/Glass.aiff]'

fresh
check 'mac: no browser installed' "$(mac --action open --kind url --target https://x.test --profile $PROFILE)" 'error:could not start Edge or Chrome: is it installed?'
check 'mac: nothing started' "$(calls | grep -c '^open ' )" '0'

fresh
mkdir -p "$WORK/apps/Microsoft Edge.app"
check 'mac: open a page' "$(mac --action open --kind url --target https://x.test --profile $PROFILE)" 'ok:opened'
has 'mac: its own profile, in a new instance' "$(calls)" 'open [-n] [-a] [Microsoft Edge] [--args] [--app=https://x.test] [--user-data-dir=/p/profiles/instagram] [--no-first-run] [--no-default-browser-check]'

fresh
rmdir "$WORK/apps/Microsoft Edge.app"; mkdir -p "$WORK/apps/Google Chrome.app"
mac --action open --kind url --target https://x.test --profile $PROFILE > /dev/null
has 'mac: Chrome when Edge is missing' "$(calls)" 'open [-n] [-a] [Google Chrome]'
fresh
check 'mac: a browser that is named is the only one tried' "$(mac --action open --kind url --target https://x.test --profile $PROFILE --browser brave)" 'error:could not start brave: is it installed?'
mkdir -p "$WORK/apps/Brave Browser.app"
fresh
mac --action open --kind url --target https://x.test --profile $PROFILE --browser brave > /dev/null
has 'mac: Brave when named' "$(calls)" 'open [-n] [-a] [Brave Browser]'

fresh
export STUB_PS="$EDGE_MAIN
$EDGE_HELPER
$OTHER_PROFILE"
check 'mac: already open' "$(mac --action open --kind url --target https://x.test --profile $PROFILE)" 'ok:already open'
log=$(calls)
has 'mac: only the main process of this profile' "$log" 'osascript [/'
has 'mac: the main process is asked to restore' "$log" '[pid] [restore] [4242]'
lacks 'mac: a helper process is left out' "$log" '4243'
lacks 'mac: another profile with the same start is left out' "$log" '4300'
lacks 'mac: nothing is started' "$log" 'open '

fresh
export STUB_PS="$EDGE_MAIN
$OTHER_PROFILE"
check 'mac: minimize' "$(mac --action minimize --kind url --target https://x.test --profile $PROFILE)" 'ok:minimized 1'
has 'mac: minimize asked of its process only' "$(calls)" '[pid] [minimize] [4242]'
lacks 'mac: not of the other profile' "$(calls)" '4300'
check 'mac: restore' "$(mac --action restore --kind url --target https://x.test --profile $PROFILE)" 'ok:restored 1'

fresh
check 'mac: minimize with nothing open' "$(mac --action minimize --kind url --target https://x.test --profile $PROFILE)" 'ok:minimized 0'

# A document
fresh
export STUB_OSA_COUNT=0   # no window of it yet
DOC=$WORK/contract.pdf; : > "$DOC"
check 'mac: open a document' "$(mac --action open --kind file --target "$DOC" --match contract)" 'ok:opened'
log=$(calls)
has 'mac: found by its title first' "$log" '[title] [restore] [contract]'
has 'mac: then opened' "$log" "open [$DOC]"
fresh
check 'mac: minimize a document by its title' "$(mac --action minimize --kind file --target "$DOC" --match contract)" 'ok:minimized 1'
has 'mac: the working windows are never touched' "$(calls)" '[,Code,Code - Insiders,Cursor,Terminal,iTerm,iTerm2,claude,]'
check 'mac: a document needs a title to be found by' "$(mac --action minimize --kind file --target "$DOC")" 'error:this document has no text to find its window by'
export STUB_OSA_COUNT=0
check 'mac: no such file' "$(mac --action open --kind file --target "$WORK/none.pdf" --match none)" "error:no such file: $WORK/none.pdf"
printf '#!/bin/sh\n' > "$WORK/runme"; chmod +x "$WORK/runme"   # an executable file (with a shebang, so that Git Bash on Windows agrees)
check 'mac: a program is no document' "$(mac --action open --kind file --target "$WORK/runme" --match runme)" 'error:that is a program or a folder, not a document: use an application'
check 'mac: a folder is no document' "$(mac --action open --kind file --target "$WORK" --match x)" 'error:that is a program or a folder, not a document: use an application'

# An application
fresh
mkdir -p "$WORK/Music.app"
check 'mac: open an app bundle' "$(mac --action open --kind app --target "$WORK/Music.app")" 'ok:opened'
has 'mac: opened by name' "$(calls)" "open [-a] [$WORK/Music.app]"
fresh
mac --action open --kind app --target "$WORK/Music.app" --arg --minimized --arg 'my list' > /dev/null
has 'mac: arguments reach the app one by one' "$(calls)" "open [-n] [-a] [$WORK/Music.app] [--args] [--minimized] [my list]"
fresh
check 'mac: open a program' "$(mac --action open --kind app --target "$WORK/Player" --arg --flag --arg 'a b' --arg '$(whoami)' --arg '; rm -rf /')" 'ok:opened'
sleep 1
has 'mac: arguments reach a program as written, nothing is read as a command' "$(calls)" 'Player [--flag] [a b] [$(whoami)] [; rm -rf /]'
check 'mac: no such program' "$(mac --action open --kind app --target "$WORK/nothing")" "error:no such program: $WORK/nothing"
mkdir -p "$WORK/Terminal.app"
check 'mac: the terminal is refused' "$(mac --action open --kind app --target "$WORK/Terminal.app")" 'error:that program is the window you work in: refused'
check 'mac: VS Code is refused' "$(mac --action open --kind app --target '/Applications/Code.app')" 'error:that program is the window you work in: refused'
fresh
export STUB_PGREP=5150
mac --action minimize --kind app --target "$WORK/Music.app" > /dev/null
has 'mac: an app is found by the name its bundle gives' "$(calls)" '[pid] [minimize] [5150]'

# Permissions and bad input
fresh
export STUB_OSA_FAIL='execution error: osascript is not allowed assistive access. (-25211)'
export STUB_PS="$EDGE_MAIN"
has 'mac: a missing permission is explained' "$(mac --action minimize --kind url --target https://x.test --profile $PROFILE)" 'error:macOS has not allowed this: System Settings > Privacy & Security > Accessibility'
fresh
export STUB_OSA_FAIL='something else broke'
export STUB_PS="$EDGE_MAIN"
check 'mac: any other failure is quoted' "$(mac --action minimize --kind url --target https://x.test --profile $PROFILE)" 'error:System Events said: something else broke'
fresh
has 'mac: a position is said not to be supported' "$(mac --action open --kind app --target "$WORK/Music.app" --position left)" 'ok:opened (a position is not supported on macOS yet)'
check 'mac: place' "$(mac --action place --kind app --target "$WORK/Music.app")" 'error:placing a window is not supported on macOS yet'
check 'mac: unknown option' "$(mac --nope x)" 'error:unknown option --nope'
check 'mac: an option without its value' "$(mac --action)" 'error:--action needs a value'
check 'mac: unknown action' "$(mac --action dance --kind url)" 'error:unknown action: dance'

# ---- Linux ----------------------------------------------------------------------------------------------
only_tools() { # only_tools <dirs>: where the script may look for programs (a test leaves some out)
  export DOWNTIME_BIN_DIRS="$1"
}
settle() { sleep 1; }   # a program started in the background has logged its arguments by then

fresh
check 'linux: chime' "$(linux --action chime)" 'ok:chime'
has 'linux: chime plays the bell' "$(calls)" 'canberra-gtk-play [-i] [bell]'

# Starting a web page
fresh
only_tools "$STUBS"
check 'linux: no browser installed' "$(linux --action open --kind url --target https://x.test --profile $PROFILE)" 'error:could not start Edge or Chrome: is it installed?'
fresh
check 'linux: open a page' "$(linux --action open --kind url --target https://x.test --profile $PROFILE)" 'ok:opened'
settle
has 'linux: Edge, its own profile' "$(calls)" 'microsoft-edge [--app=https://x.test] [--user-data-dir=/p/profiles/instagram] [--no-first-run] [--no-default-browser-check]'
fresh
rm "$WORK/browsers/microsoft-edge"
linux --action open --kind url --target https://x.test --profile $PROFILE > /dev/null
settle
has 'linux: Chrome when Edge is missing' "$(calls)" 'google-chrome [--app=https://x.test]'
fresh
check 'linux: a browser that is named is the only one tried' "$(linux --action open --kind url --target https://x.test --profile $PROFILE --browser edge)" 'error:could not start edge: is it installed?'
linux --action open --kind url --target https://x.test --profile $PROFILE --browser brave > /dev/null
settle
has 'linux: Brave when named' "$(calls)" 'brave-browser [--app=https://x.test]'

# Windows on X11
fresh
export STUB_PS="$EDGE_MAIN
$EDGE_HELPER
$OTHER_PROFILE"
export STUB_WMCTRL="0x01c00003  0 4242 host Instagram
0x01c00004  0 4243 host Helper of the same profile
0x01c00005  0 4300 host Another activity"
check 'linux: already open' "$(linux --action open --kind url --target https://x.test --profile $PROFILE)" 'ok:already open'
log=$(calls)
has 'linux: its window is brought back' "$log" 'xdotool [windowactivate] [0x01c00003]'
lacks 'linux: a helper process is left out' "$log" '0x01c00004'
lacks 'linux: another profile with the same start is left out' "$log" '0x01c00005'
lacks 'linux: nothing is started' "$log" 'microsoft-edge'
check 'linux: minimize' "$(linux --action minimize --kind url --target https://x.test --profile $PROFILE)" 'ok:minimized 1'
has 'linux: only its window goes down' "$(calls)" 'xdotool [windowminimize] [0x01c00003]'
check 'linux: restore' "$(linux --action restore --kind url --target https://x.test --profile $PROFILE)" 'ok:restored 1'
fresh
check 'linux: minimize with nothing open' "$(linux --action minimize --kind url --target https://x.test --profile $PROFILE)" 'ok:minimized 0'

# A document: found by its title, never in the editor or a terminal
fresh
DOC=$WORK/contract.pdf
export STUB_WMCTRL="0x02000001  0 7000 host contract.pdf - Document Viewer
0x02000002  0 7100 host contract.pdf - Visual Studio Code
0x02000003  0 7200 host Something else"
export STUB_COMM_7000=evince STUB_COMM_7100=code STUB_COMM_7200=evince
check 'linux: minimize a document' "$(linux --action minimize --kind file --target "$DOC" --match contract)" 'ok:minimized 1'
log=$(calls)
has 'linux: the viewer goes down' "$log" 'xdotool [windowminimize] [0x02000001]'
lacks 'linux: the editor is never touched' "$log" '0x02000002'
lacks 'linux: other windows are not touched' "$log" '0x02000003'
check 'linux: a document needs a title to be found by' "$(linux --action minimize --kind file --target "$DOC")" 'error:this document has no text to find its window by'
fresh
: > "$DOC"
check 'linux: open a document' "$(linux --action open --kind file --target "$DOC" --match contract)" 'ok:opened'
settle
has 'linux: opened by the system' "$(calls)" "xdg-open [$DOC]"
check 'linux: no such file' "$(linux --action open --kind file --target "$WORK/none.pdf" --match none)" "error:no such file: $WORK/none.pdf"
check 'linux: a folder is no document' "$(linux --action open --kind file --target "$WORK" --match x)" 'error:that is a program or a folder, not a document: use an application'
check 'linux: a program is no document' "$(linux --action open --kind file --target "$WORK/runme" --match runme)" 'error:that is a program or a folder, not a document: use an application'
only_tools "$WORK/browsers"
check 'linux: a document needs xdg-open' "$(linux --action open --kind file --target "$DOC" --match contract)" 'error:opening a document needs xdg-open: install xdg-utils'

# An application
fresh
check 'linux: open a program' "$(linux --action open --kind app --target "$WORK/Player" --arg --flag --arg 'a b' --arg '$(whoami)' --arg '; rm -rf /')" 'ok:opened'
settle
has 'linux: arguments reach a program as written, nothing is read as a command' "$(calls)" 'Player [--flag] [a b] [$(whoami)] [; rm -rf /]'
check 'linux: no such program' "$(linux --action open --kind app --target "$WORK/nothing")" "error:no such program: $WORK/nothing"
check 'linux: a terminal is refused' "$(linux --action open --kind app --target /usr/bin/gnome-terminal)" 'error:that program is the window you work in: refused'
check 'linux: a shell is refused' "$(linux --action open --kind app --target /bin/bash)" 'error:that program is the window you work in: refused'
fresh
export STUB_PGREP=5150
export STUB_WMCTRL="0x03000001  0 5150 host Music Library
0x03000002  0 5150 host Music Mini"
check 'linux: an app is found by its process' "$(linux --action minimize --kind app --target "$WORK/Music")" 'ok:minimized 2'
check 'linux: and narrowed by title' "$(linux --action minimize --kind app --target "$WORK/Music" --match Library)" 'ok:minimized 1'

# Where windows cannot be reached
fresh
export XDG_SESSION_TYPE=wayland STUB_PS="$EDGE_MAIN"
check 'linux: Wayland cannot minimize' "$(linux --action minimize --kind url --target https://x.test --profile $PROFILE)" "error:Wayland does not let a program minimize or restore another program's window (opening works)"
check 'linux: on Wayland a running program counts as open' "$(linux --action open --kind url --target https://x.test --profile $PROFILE)" "ok:already open (Wayland does not let a program minimize or restore another program's window (opening works))"
unset STUB_PS
check 'linux: on Wayland a program that is not running is started' "$(linux --action open --kind url --target https://x.test --profile $PROFILE)" 'ok:opened'
fresh
unset DISPLAY
check 'linux: no desktop session' "$(linux --action minimize --kind url --target https://x.test --profile $PROFILE)" 'error:there is no desktop session to talk to (DISPLAY is not set)'
fresh
only_tools "$WORK/browsers"
has 'linux: missing tools are named' "$(linux --action minimize --kind url --target https://x.test --profile $PROFILE)" 'error:it needs wmctrl and xdotool: install them (for example: sudo apt install wmctrl xdotool)'

fresh
has 'linux: a position is said not to be supported' "$(linux --action open --kind app --target "$WORK/Player" --position left)" 'ok:opened (a position is not supported on Linux yet)'
check 'linux: place' "$(linux --action place --kind app --target "$WORK/Player")" 'error:placing a window is not supported on Linux yet'
check 'linux: unknown option' "$(linux --nope x)" 'error:unknown option --nope'
check 'linux: an option without its value' "$(linux --action)" 'error:--action needs a value'
check 'linux: unknown action' "$(linux --action dance --kind url)" 'error:unknown action: dance'

printf '%s passed, %s failed\n' "$passed" "$failed"
[ "$failed" -eq 0 ]
