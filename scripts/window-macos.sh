#!/usr/bin/env bash
# downtime, macOS side: opens, minimizes and restores the windows of the activities the user chose in /dt.
#
# Same contract as window.ps1 (see CONTRIBUTING.md): it prints one line, "ok:<what happened>" or "error:<why>".
# It reads the process list and window titles, moves windows through System Events (macOS asks once for the
# Accessibility permission, for the app that runs Claude Code), and starts the browser, the document's app or a
# program the user confirmed. It writes no file and opens no connection.
#
# EXPERIMENTAL: written without a Mac to hand and tried against stand-ins for the system tools (tests/unix).
# macOS bash is 3.2: no `set -u`, no associative arrays.

DIR=$(cd "$(dirname "$0")" && pwd)
action='' kind='' target='' match='' profile='' browser='' position=''
args=()
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { echo "error:$1 needs a value"; exit 0; }
  case "$1" in
    --action) action=$2 ;;
    --kind) kind=$2 ;;
    --target) target=$2 ;;
    --match) match=$2 ;;
    --profile) profile=$2 ;;
    --browser) browser=$2 ;;
    --position) position=$2 ;;
    --monitor) ;;
    --arg) args+=("$2") ;;
    *) echo "error:unknown option $1"; exit 0 ;;
  esac
  shift 2
done

say() { printf '%s\n' "$1"; }
fail() { say "error:$1"; exit 0; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
num() { case "$1" in '' | *[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }

# Never the window the user is working in, whatever its title says.
NEVER_NAMES=",code,code - insiders,cursor,terminal,iterm,iterm2,claude,"
NEVER_AS=",Code,Code - Insiders,Cursor,Terminal,iTerm,iTerm2,claude,"

# The name a program is known by: its file name without the extension (.app too), in lower case.
base_of() { local b=${1##*/}; b=${b%.app}; lower "$b"; }

# ---- the window actions, through System Events --------------------------------------------------------
osa() { # osa <mode> <action> <key>: sets $osa_out to how many windows it went through
  osa_out=$(osascript "$DIR/window-macos.applescript" "$1" "$2" "$3" "$NEVER_AS" 2>&1) && return 0
  case "$osa_out" in
    *assistive* | *-25211* | *-1719* | *"not allowed"*)
      fail 'macOS has not allowed this: System Settings > Privacy & Security > Accessibility, then allow the app that runs Claude Code' ;;
    *) fail "System Events said: $(printf '%s' "$osa_out" | head -n 1)" ;;
  esac
}

# The processes of the activity. A web page is told by its own browser profile, an application by its name.
proc_name() {
  if [ "${target%.app}" != "$target" ] && [ -d "$target" ]; then
    defaults read "$target/Contents/Info" CFBundleExecutable 2>/dev/null || base_of "$target"
  else
    printf '%s' "${target##*/}"
  fi
}
program_pids() {
  case "$kind" in
    # The profile must end where the path ends: .../instagram is not .../instagram-2.
    url) ps -axo pid=,command= | awk -v n="--user-data-dir=$profile" '
           !index($0, "--type=") { i = index($0, n); if (i) { c = substr($0, i + length(n), 1); if (c == "" || c == " " || c == "\"") print $1 } }' ;;
    app) pgrep -x "$(proc_name)" ;;
  esac
}

move() { # move <minimize|restore>: sets $moved to how many windows of the activity it went through
  moved=0
  if [ "$kind" = file ] || { [ "$kind" = app ] && [ -n "$match" ]; }; then
    [ -n "$match" ] || fail 'this document has no text to find its window by'
    osa title "$1" "$match"
    moved=$(num "$osa_out")
  else
    local pid
    for pid in $(program_pids); do
      osa pid "$1" "$pid"
      moved=$((moved + $(num "$osa_out")))
    done
  fi
}

# ---- starting things ----------------------------------------------------------------------------------
app_of() { case "$1" in edge) echo 'Microsoft Edge' ;; chrome) echo 'Google Chrome' ;; brave) echo 'Brave Browser' ;; esac; }
installed() { # installed <app name>: it is in /Applications or ~/Applications (DOWNTIME_APP_DIRS overrides, for the tests)
  local d dirs
  IFS=: read -ra dirs <<< "${DOWNTIME_APP_DIRS:-/Applications:$HOME/Applications}"
  for d in "${dirs[@]}"; do [ -d "$d/$1.app" ] && return 0; done
  return 1
}
pick_browser() { # a browser the user named is the only one tried; without one, Edge and then Chrome
  local b
  if [ -n "$browser" ]; then
    b=$(app_of "$browser")
    installed "$b" && { echo "$b"; return 0; }
    return 1
  fi
  for b in 'Microsoft Edge' 'Google Chrome'; do
    installed "$b" && { echo "$b"; return 0; }
  done
  return 1
}

launch() {
  case "$kind" in
    url)
      local app
      app=$(pick_browser) || fail "could not start ${browser:-Edge or Chrome}: is it installed?"
      open -n -a "$app" --args "--app=$target" "--user-data-dir=$profile" --no-first-run --no-default-browser-check ;;
    file)
      [ -e "$target" ] || fail "no such file: $target"
      if [ -d "$target" ] || [ -x "$target" ]; then fail 'that is a program or a folder, not a document: use an application'; fi
      open "$target" ;;
    app)
      case "$NEVER_NAMES" in *",$(base_of "$target"),"*) fail 'that program is the window you work in: refused' ;; esac
      if [ "${target%.app}" != "$target" ] && [ -d "$target" ]; then
        # The arguments come as written: each one reaches the program whole.
        if [ ${#args[@]} -gt 0 ]; then open -n -a "$target" --args "${args[@]}"; else open -a "$target"; fi
      elif [ -x "$target" ] && [ ! -d "$target" ]; then
        nohup "$target" ${args[@]+"${args[@]}"} > /dev/null 2>&1 &
      else
        fail "no such program: $target"
      fi ;;
    *) fail "unknown kind: $kind" ;;
  esac
}

# ---- what was asked -----------------------------------------------------------------------------------
case "$action" in
  chime)
    afplay /System/Library/Sounds/Glass.aiff 2> /dev/null || printf '\a'
    say 'ok:chime'
    exit 0 ;;
  minimize)
    move minimize
    say "ok:minimized $moved" ;;
  restore)
    move restore
    say "ok:restored $moved" ;;
  place)
    fail 'placing a window is not supported on macOS yet' ;;
  open)
    move restore
    if [ "$moved" -gt 0 ]; then
      # Already open: it comes back where it was, wherever the user has put it since.
      say 'ok:already open'
      exit 0
    fi
    launch
    if [ -n "$position" ]; then say 'ok:opened (a position is not supported on macOS yet)'; else say 'ok:opened'; fi ;;
  *) fail "unknown action: $action" ;;
esac
