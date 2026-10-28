# Contributing

## Layout

- `hooks/register.tsx`: the hooks module: the events, the `/downtime` command and pane, Claude's `window` tool, and the runner that calls the script.
- `hooks/activities.ts`: pure functions: what an activity may be, when the windows should be up, the script's command line. No engine in it, so it is tested alone.
- `scripts/window.ps1`: the Windows side. One entry point, `-Action open|minimize|restore|chime`.
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
claude --plugin-dir ./downtime        # try it in a session
```

The tests cover the rules and the events. The window handling is tried by hand with a harmless activity:

```text
/downtime add "Note" C:\path\to\a\note.txt
/downtime open note
/downtime minimize note
/downtime restore note
```

## Adding another system

`exec()` in `hooks/register.tsx` is where the system is chosen. A new system brings its own script with the same contract as `scripts/window.ps1`:

- the same actions, `open`, `minimize`, `restore` and `chime`, and the same arguments (`kind`, `target`, `match`, `profile`);
- one line on standard output: `ok:<what happened>` or `error:<why>`;
- no files written, no network, never the window of the editor, a terminal or Claude.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and on every pull request, on Windows (the supported system today). It:

1. fails if a `classic.*` hook shows up in `hooks/`;
2. checks that `scripts/window.ps1` parses;
3. installs the Claude Code CLI (`npm install -g @anthropic-ai/claude-code`) and runs `claude plugin validate .` and `claude plugin test .`.

The same checks run on your machine with the commands under "Develop".

## Pull requests

- One topic per PR, on its own branch (`feature/…` or `fix/…`), with a test for the behaviour it changes.
- Run the checks above and update `README.md` when behaviour changes.
