#!/usr/bin/env bash
# downtime, Linux side: opens, minimizes and restores the windows of the activities the user chose in /dt.
#
# Same contract as window.ps1 (see CONTRIBUTING.md): it prints one line, "ok:<what happened>" or "error:<why>".
# It reads the process list and window titles, moves windows through wmctrl and xdotool (X11 only), and starts the
# browser, the document's app or a program the user confirmed. It writes no file and opens no connection.
#
# EXPERIMENTAL: written without a Linux desktop to hand and tried against stand-ins for the system tools (tests/unix).
# On Wayland no program may minimize or restore another's window: opening still works, and it says so.
# shellcheck disable=SC2086  # a few lists are split on purpose

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

# find_bin <name>: where to run a tool from, or nothing. DOWNTIME_BIN_DIRS (a colon list) replaces the search, for the tests.
find_bin() {
  local d dirs
  if [ -z "${DOWNTIME_BIN_DIRS-}" ]; then command -v "$1"; return; fi
  IFS=: read -ra dirs <<< "$DOWNTIME_BIN_DIRS"
  for d in "${dirs[@]}"; do [ -x "$d/$1" ] && { echo "$d/$1"; return 0; }; done
  return 1
}
have() { find_bin "$1" > /dev/null; }

# Never the window the user is working in, whatever its title says.
NEVER_NAMES=",code,cursor,claude,gnome-terminal,konsole,xterm,alacritty,kitty,wezterm,tilix,terminator,xfce4-terminal,lxterminal,tmux,bash,zsh,fish,sh,"
is_working_window() { # is_working_window <pid>: the editor, a terminal, a shell or Claude (the process name is cut at 15 characters)
  local c
  c=$(lower "$(ps -o comm= -p "$1" 2> /dev/null)")
  case "$c" in
    code* | cursor* | claude* | gnome-terminal* | konsole* | xterm* | alacritty* | kitty* | wezterm* | tilix* | terminator* | xfce4-terminal* | lxterminal* | tmux* | bash | zsh | fish | sh) return 0 ;;
  esac
  return 1
}

# ---- can windows be reached? --------------------------------------------------------------------------
x11_problem() { # what keeps minimize and restore from working here, in words; nothing when they can
  if [ "${XDG_SESSION_TYPE-}" = wayland ]; then echo "Wayland does not let a program minimize or restore another program's window (opening works)"; return; fi
  if [ -z "${DISPLAY-}" ]; then echo 'there is no desktop session to talk to (DISPLAY is not set)'; return; fi
  if ! have wmctrl || ! have xdotool; then echo 'it needs wmctrl and xdotool: install them (for example: sudo apt install wmctrl xdotool)'; return; fi
}

# ---- the processes and windows of an activity ----------------------------------------------------------
program_pids() {
  case "$kind" in
    # The profile must end where the path ends: .../instagram is not .../instagram-2.
    url) ps -axo pid=,command= | awk -v n="--user-data-dir=$profile" '
           !index($0, "--type=") { i = index($0, n); if (i) { c = substr($0, i + length(n), 1); if (c == "" || c == " " || c == "\"") print $1 } }' ;;
    app) pgrep -x "$(lower "${target##*/}" | cut -c1-15)" ;;
  esac
}
is_in() { local p; for p in $2; do [ "$p" = "$1" ] && return 0; done; return 1; }
title_has() { case "$(lower "$1")" in *"$(lower "$match")"*) return 0 ;; esac; return 1; }

x11_ids() { # the ids of the activity's windows, one per line
  local pids='' wm
  [ "$kind" = file ] || pids=$(program_pids)
  wm=$(find_bin wmctrl)
  "$wm" -lp | while read -r id _desktop wpid _host title; do
    case "$kind" in
      url) is_in "$wpid" "$pids" || continue ;;
      app) is_in "$wpid" "$pids" || continue; [ -z "$match" ] || title_has "$title" || continue ;;
      file) title_has "$title" || continue; ! is_working_window "$wpid" || continue ;;
    esac
    echo "$id"
  done
}

move() { # move <minimize|restore>: sets $moved to how many windows of the activity it went through
  local problem id xd
  problem=$(x11_problem)
  [ -z "$problem" ] || fail "$problem"
  [ "$kind" != file ] || [ -n "$match" ] || fail 'this document has no text to find its window by'
  moved=0
  xd=$(find_bin xdotool)
  for id in $(x11_ids); do
    # There is no standard way to restore a window without activating it: on X11 it comes to the front.
    if [ "$1" = minimize ]; then "$xd" windowminimize "$id"; else "$xd" windowactivate "$id"; fi
    moved=$((moved + 1))
  done
}

# ---- starting things ----------------------------------------------------------------------------------
browser_bins() { case "$1" in edge) echo 'microsoft-edge microsoft-edge-stable' ;; chrome) echo 'google-chrome google-chrome-stable chromium chromium-browser' ;; brave) echo 'brave-browser brave' ;; esac; }
pick_browser() { # a browser the user named is the only one tried; without one, Edge and then Chrome
  local list b
  if [ -n "$browser" ]; then list=$(browser_bins "$browser"); else list="$(browser_bins edge) $(browser_bins chrome)"; fi
  for b in $list; do have "$b" && { find_bin "$b"; return 0; }; done
  return 1
}

launch() {
  case "$kind" in
    url)
      local bin
      bin=$(pick_browser) || fail "could not start ${browser:-Edge or Chrome}: is it installed?"
      nohup "$bin" "--app=$target" "--user-data-dir=$profile" --no-first-run --no-default-browser-check > /dev/null 2>&1 & ;;
    file)
      [ -e "$target" ] || fail "no such file: $target"
      if [ -d "$target" ] || [ -x "$target" ]; then fail 'that is a program or a folder, not a document: use an application'; fi
      have xdg-open || fail 'opening a document needs xdg-open: install xdg-utils'
      nohup "$(find_bin xdg-open)" "$target" > /dev/null 2>&1 & ;;
    app)
      case "$NEVER_NAMES" in *",$(lower "${target##*/}"),"*) fail 'that program is the window you work in: refused' ;; esac
      [ -x "$target" ] && [ ! -d "$target" ] || fail "no such program: $target"
      # The arguments come as written: each one reaches the program whole.
      nohup "$target" ${args[@]+"${args[@]}"} > /dev/null 2>&1 & ;;
    *) fail "unknown kind: $kind" ;;
  esac
}

# ---- what was asked -----------------------------------------------------------------------------------
case "$action" in
  chime)
    if have canberra-gtk-play; then "$(find_bin canberra-gtk-play)" -i bell > /dev/null 2>&1
    elif have paplay && [ -r /usr/share/sounds/freedesktop/stereo/bell.oga ]; then "$(find_bin paplay)" /usr/share/sounds/freedesktop/stereo/bell.oga > /dev/null 2>&1
    else printf '\a'; fi
    say 'ok:chime' ;;
  minimize)
    move minimize
    say "ok:minimized $moved" ;;
  restore)
    move restore
    say "ok:restored $moved" ;;
  place)
    fail 'placing a window is not supported on Linux yet' ;;
  open)
    problem=$(x11_problem)
    if [ -z "$problem" ]; then
      move restore
      if [ "$moved" -gt 0 ]; then
        # Already open: it comes back, wherever the user has put it since.
        say 'ok:already open'
        exit 0
      fi
    elif [ "$kind" != file ] && [ -n "$(program_pids)" ]; then
      # Its windows cannot be listed here, but its program is running: it is open.
      say "ok:already open ($problem)"
      exit 0
    fi
    launch
    if [ -n "$position" ]; then say 'ok:opened (a position is not supported on Linux yet)'; else say 'ok:opened'; fi ;;
  *) fail "unknown action: $action" ;;
esac
