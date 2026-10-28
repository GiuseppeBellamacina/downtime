# Contributing

## Layout

- `hooks/register.tsx`: the hooks module: the events, the `/dt` command and pane, Claude's `window` tool, and the runner that calls the script.
- `hooks/activities.ts`: pure functions: what an activity may be, when the windows should be up, the script's command line. No engine in it, so it is tested alone.
- `scripts/window.ps1`: the Windows side. One entry point, `-Action open|minimize|restore|place|chime`.
- `scripts/window-macos.sh` and `scripts/window-macos.applescript`: the macOS side, the same contract with `--action` style options.
- `scripts/window-linux.sh`: the Linux side (X11 through `wmctrl` and `xdotool`; Wayland says what it cannot do).
- `tests/windows/window.test.ps1`: tries `window.ps1` on real windows (Notepad and Edge) and measures them; it cleans up after itself.
- `tests/unix/scripts.test.sh`: tries the macOS and Linux scripts against stand-ins for the system tools; runs anywhere with bash.
- `types/index.d.ts`: the contract of the plugin's state.
- `tests/`: `activities.test.ts` (the rules) and `hooks.test.tsx` (the events, with a mock engine).

## Ground rules

- **Only the plugin hooks of the mod API, never `classic.*`.** Some security setups (for example `cc-plugin-sec-default`) skip the classic hooks without a word. Check before you push: `grep -rn "classic\." hooks/` must print nothing.
- **Only what the user chose.** Windows are opened and minimized only for activities in the user's list *and* switched on. Claude's tool takes a name from that list, never an address, a path or a command.
- **No shell.** The script gets one argument per value, and `activities.ts` validates every value first (a web address is `http(s)`, a document is a full path that is not a program).
- **Never block a hook.** A hook that waits delays Claude's permission prompt. Window work starts from `later()` (a timer), and `serial()` keeps two actions from fighting over the same windows.
- **Do not take the keyboard.** Restoring a window must not steal the focus from whoever is typing.
- **Never the window the user works in.** The script skips VS Code, terminals and Claude.

## Develop

```bash
git clone https://github.com/GiuseppeBellamacina/downtime
claude plugin validate ./downtime
claude plugin test ./downtime
claude --plugin-dir ./downtime      # try it in a session
```

The tests cover the rules and the events. The scripts have their own: `bash tests/unix/scripts.test.sh` for macOS and Linux (against stand-ins for the system tools, anywhere with bash), and `powershell -ExecutionPolicy Bypass -File tests/windows/window.test.ps1` for Windows. The Windows one opens and closes real windows (a throwaway document and program in Notepad, two web pages in Edge profiles of their own), measures where they are, and leaves nothing running; it skips the Notepad checks if a Notepad is already open, so as never to touch a window it did not open. The window handling is tried by hand with a harmless activity:

```text
/dt add "Note" C:\path\to\a\note.txt
/dt open note
/dt minimize note
/dt restore note
```

## Adding another system

`systemOf()` and `exec()` in `hooks/register.tsx` choose the system (Windows says so in its environment, the others are told by `uname`), `SUPPORTED` says which have a script, and `SCRIPTS` and `launcher()` in `hooks/activities.ts` say which script and which options. A new system brings its own script with the same contract as `scripts/window.ps1`:

- the same actions, `open`, `minimize`, `restore`, `place` and `chime`, and the same arguments (`kind`, `target`, `match`, `profile`, `browser`, `position`, `monitor`, and for an application its arguments: one `--arg` each on macOS and Linux). An action it cannot do says so, in words;
- one line on standard output: `ok:<what happened>` or `error:<why>`;
- no files written, no network, never the window of the editor, a terminal or Claude;
- tested in `tests/unix/scripts.test.sh` with stand-ins for the system tools, and tried by hand on the real system before it is called supported. Until then it is marked experimental in the README.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request. On Windows (the supported system) it:

1. fails if a `classic.*` hook shows up in `hooks/`;
2. checks that `scripts/window.ps1` parses and runs `tests/windows/window.test.ps1` on the runner's desktop;
3. installs the Claude Code CLI (`npm install -g @anthropic-ai/claude-code`), runs `claude plugin validate .` and fails if it says a command name is one Claude Code ships (that is only a warning, but the command would never be registered), then runs `claude plugin test .`.

The same checks run on your machine with the commands under "Develop".

On Ubuntu and macOS a second job runs `shellcheck` on the scripts, `bash tests/unix/scripts.test.sh`, and (macOS) `osacompile` on the AppleScript.

## Pull requests

- One topic per PR, on its own branch (`feature/…` or `fix/…`), with a test for the behaviour it changes.
- Run the checks above and update `README.md` when behaviour changes.
