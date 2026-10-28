# Changelog

## 0.5.0

- **A permission prompt no longer takes the windows down.** Work that asks at every command opened and closed them at every one. Now only a question, a plan to approve and the end of the work do. `/dt permission on` brings the old behaviour back (the windows then return after the delay).

## 0.4.0

- **`/dt reset`**: says what it would remove; `/dt reset yes` puts downtime back as just installed (the list, the settings, the confirmed applications, the browser profiles with their logins, the log and any snooze). Windows that are open stay open.

## 0.3.3

- **Fixed**: after a permission prompt the windows waited at least 15 seconds. They now come back after the delay you chose (`/dt delay`, 5 by default). If you take longer than that to answer a prompt, they come up anyway: raise the delay, or `/dt snooze`.

## 0.3.2

- **`/dt log`**: the last things the plugin saw (turns, the opening timer, each action and its answer, permissions and questions). For when a window does not open by itself and nothing says why.

## 0.3.1

- **Fixed**: a window already open but hidden behind others (a PDF behind the editor) was left there. `open` and `restore` now raise it above the others, without taking the keyboard.

## 0.3.0

- **The default delay is 5 seconds** (it was 20). A delay you already chose stays: change it with `/dt delay`.
- **After a question** (`AskUserQuestion`, a plan to approve) the windows come back as soon as the user has answered and Claude goes on.
- **`/dt sound on | off`**: the sound and the notification ("Claude needs you") that come with it.
- After a permission prompt the windows return after the delay, at least 15 seconds, so they do not come up over a prompt still open.

## 0.2.2

- **Fixed**: after a permission prompt the windows now come back after the usual delay (`/dt delay`), even while the command that asked is still running. 0.2.1 did not do it: the engine keeps the prompt and the command in one call and says nothing when the user answers. A question (`AskUserQuestion`, a plan to approve) still keeps them down until Claude goes on.

## 0.2.1

- **Fixed**: after a permission prompt took the windows down, they came back only when the command that asked had finished. They now return, after the usual delay, as soon as the command starts.

## 0.2.0

- **The command is `/dt`.** Claude Code ships a command called `/downtime`, so 0.1.0 could not register its command at all (the validator only warned). The plugin and the tool keep the name `downtime`.
- **`/dt snooze`**: nothing opens by itself for a while.
- **A browser for each web page**: `edge`, `chrome` or `brave`, with `/dt browser`.
- **Position**: a side of a monitor or a rectangle, with `/dt position` and `/dt place`.
- **Applications** (`/dt add-app`, `/dt confirm`): a program you list yourself, never run until you confirmed that exact command, and Claude Code asks every time Claude wants to open one.
- **macOS and Linux**, experimental: written and tested against stand-ins for the system tools, not yet tried on real machines.
- **Fixed**: a web activity could minimize the windows of another whose id starts the same (`instagram` and `instagram-2`); an empty argument could vanish from the command line.
- **Checks**: CI on Windows, Ubuntu and macOS, including tests that open and measure real windows.

## 0.1.0

The first version: activities that open while Claude works and go down when it needs you, Claude's `window` tool, Windows only.
