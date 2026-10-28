# downtime — something to do while Claude works

> While Claude works, `downtime` opens the windows you chose (a feed, a film, a PDF you have to read) and puts them down the moment Claude needs you or is done. Claude can open and minimize them too, when you ask.

[![ci](https://github.com/GiuseppeBellamacina/downtime/actions/workflows/ci.yml/badge.svg)](https://github.com/GiuseppeBellamacina/downtime/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://code.claude.com/docs/en/plugins)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078d4.svg)

Claude's longer tasks leave you waiting. `downtime` fills that time with whatever you pick, and gets out of the way when it is your turn again. It opens **real windows of your system**, because Claude Code's own screen cannot play video: so it works the same for Instagram, Netflix, a document or any web page, and nothing of the page passes through the plugin.

**Windows only for now.** macOS and Linux are planned: see the [open issues](https://github.com/GiuseppeBellamacina/downtime/issues).

## Install

At the prompt of a terminal session:

```text
/plugin install downtime --marketplace GiuseppeBellamacina/downtime
```

(answer `y` to add the marketplace, then pick a scope). From a shell:

```bash
claude plugin install downtime --marketplace GiuseppeBellamacina/downtime
```

Where `/plugin` is not available (for example the VS Code extension), run the shell line, then `/reload-plugins` in the session.

**Requirements:** a Claude Code build with plugin function hooks (mods); Windows 10 or 11 with Microsoft Edge (included) or Google Chrome. No Node.js, nothing to `npm install`.

## Quick start

**1. Add something to do:**

```text
/dt add "Instagram Reels" https://www.instagram.com/reels/
/dt add "Contract" C:\Users\me\Documents\contract.pdf
```

**2. Try it by hand**, and log in to the site the first time (the window has a browser profile of its own, so it remembers you):

```text
/dt open instagram-reels
/dt minimize instagram-reels
```

**3. Switch it on:**

```text
/dt on
```

From now on, a task that keeps Claude busy for 20 seconds opens what you ticked. When Claude asks you something or is done, it goes down.

## Commands

The command is **`/dt`**, short for downtime: Claude Code reserves the name `/downtime` for itself, so a plugin cannot register it.

| Command | What it does |
| --- | --- |
| `/dt` | Opens the pane: tick the activities, try them, add and remove them, change the settings. |
| `/dt on` · `/dt off` | The master switch. While it is off nothing opens or minimizes by itself. It starts **off**. |
| `/dt add "Name" <address or full path> ["window title"]` | Adds an activity and switches it on. The optional third word is the text a document's window title contains, when it is not the file's name. |
| `/dt list` | The activities, which are on, and the delay. |
| `/dt use <id>… \| all \| none` | Which activities are on: the only ones that open by themselves and that Claude may use. |
| `/dt delay <seconds>` | How long Claude must have worked before the windows open (0–600, default 20). |
| `/dt open <id>` · `minimize <id>` · `restore <id>` | Try one by hand. They work whether or not it is switched on. `restore` only brings back a window that is already open. |
| `/dt remove <id>` | Removes an activity. |
| `/dt reload` | Reads `activities.json` again after you edited it. |
| `/dt help` | Lists these commands. |

An `<id>` can be abbreviated: the id or the name, or the start of one of them when only one fits. Names with spaces go in double quotes.

## Activities

They live in `~/.claude/downtime/activities.json`, which you can edit by hand (then `/dt reload`). The switches (which are on, the delay, the options) are kept between sessions.

```json
[
  { "id": "instagram-reels", "name": "Instagram Reels", "kind": "url", "target": "https://www.instagram.com/reels/" },
  { "id": "contract", "name": "Contract", "kind": "file", "target": "C:/Users/me/Documents/contract.pdf", "match": "contract" }
]
```

| Field | |
| --- | --- |
| `id` | Short and stable: `a-z`, `0-9` and dashes, up to 32 characters. |
| `name` | What you see, up to 60 characters. |
| `kind` | `url`: a web page, in its own Edge (or Chrome) window. `file`: a document, in its default app. |
| `target` | An `http(s)` address, or the full path of a document. |
| `match` | Optional, for a `file`: text its window title contains (default: the file's name without the extension). |

- A **web page** gets a browser profile of its own in `~/.claude/downtime/profiles/<id>`. Log in once, in that window: the browser keeps it. No password or cookie ever passes through the plugin.
- A **document** opens in the app Windows associates with it. Its window is found by its title.
- **Programs and scripts are refused** (`.exe`, `.bat`, `.cmd`, `.ps1`, `.lnk`, `.msi`, `.js`, …): `downtime` opens documents, it never runs anything. Entries that fail a check are dropped, with the reason.

## When it acts

Only with the master switch on and at least one activity ticked.

| Claude… | The windows… |
| --- | --- |
| has worked for the delay: a turn, a subagent or a background task | open, or come back if minimized (without taking the keyboard from you) |
| asks for a permission, asks a question or presents a plan | minimize, with a sound and a notification |
| finishes, with nothing left running | minimize, with a sound and a notification |
| goes on after you answered | come back |

A short answer opens nothing and says nothing. A background task whose end is never reported stops counting after 30 minutes. In the pane you can switch off the minimizing, the coming back and the sound.

## Claude's tool

`mcp__downtime__window` takes `list`, `open`, `minimize` or `restore` and an activity **by name** from your list. It only works on activities you switched on, never takes an address or a path of its own, and is told to act only when you ask ("open Instagram", "minimize the contract"). It needs no permission prompt: it cannot reach anything you did not choose.

## What it does to your computer

All the window handling is [`scripts/window.ps1`](scripts/window.ps1), about a hundred readable lines. It:

- reads window titles and the command lines of Edge and Chrome processes, to find the windows of an activity;
- minimizes and restores those windows, and starts the browser or the document's app;
- plays a system sound.

It writes no file, opens no network connection, never touches the window of VS Code, a terminal or Claude, and every value reaches it as a separate argument (no shell ever interprets any text). The plugin itself writes `activities.json` and nothing else outside Claude Code's own plugin store.

## Limits

- **Windows only.** On other systems the commands say so instead of failing silently.
- A verification a site asks for (2FA, captcha) is yours to do in its window.
- A document's window is found by its title: a viewer that does not show the file name there is not found; use the `match` field.
- Closing the window of a web activity leaves the browser's own background processes running: normal for Edge and Chrome.
- The plugin uses only the plugin hooks of Claude Code's mod API, never the `classic.*` ones. Some security setups skip those hooks, and a plugin that depended on one would stop working without a word.

## Troubleshooting

| Symptom | Try |
| --- | --- |
| `/dt` does nothing | The plugin is not loaded: `/reload-plugins`, or check `claude plugin list`. |
| The window does not open | `/dt open <id>` shows the reason. For a document, the file must exist and its path be absolute. |
| It opens but is not minimized | A document's window is found by title: set `match` to text its title really contains. |
| A site asks to log in every time | Use `/dt open <id>` and log in once in that window, not in your usual browser. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Ideas and bugs: the [issues](https://github.com/GiuseppeBellamacina/downtime/issues).

## License

[MIT](LICENSE) © Giuseppe Bellamacina
