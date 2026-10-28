import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__downtime__window'
const IG = 'https://www.instagram.com/reels/'

// The engine beneath the plugin: every window action lands in `runs`, and answers like the script would.
function engine(on: On, system: 'Windows_NT' | 'Darwin' | 'Linux' | 'FreeBSD' = 'Windows_NT') {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  // Windows says so in its environment; the others are told by `uname`.
  mock.env(on, system === 'Windows_NT' ? { USERPROFILE: 'C:/Users/test', OS: 'Windows_NT' } : { HOME: '/home/test' })
  const files: Record<string, string> = {}
  const runs: string[][] = []
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__downtime__${e.name}` } }))
  const registered: string[] = []
  on('command.register', (_, e) => (registered.push(e.name), { value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.notify', () => ({ value: { isSent: true, channel: 'test' } }) as never)
  on('ui.toast', () => ({ value: undefined }))
  on('process.run', (_, e) => {
    if (e.argv[0] === 'uname') return { value: { exitCode: 0, stdout: `${system}\n`, stderr: '' } } as never
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'ok:done\n', stderr: '' } } as never
  })
  on('tool.call', () => ({ result: { ok: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path]! } : Promise.reject(new Error('missing'))))
  on('fs.write', (_, e) => ((files[e.path] = e.text), { value: undefined }))
  // What each run was asked, whatever the system's option style (-Action or --action).
  const flag = (argv: string[], name: string) => {
    const i = argv.findIndex(x => x.toLowerCase().replace(/^-+/, '') === name)
    return i < 0 ? undefined : argv[i + 1]
  }
  const seen = () => runs.map(argv => `${flag(argv, 'action')}` + (flag(argv, 'target') ? `:${flag(argv, 'target')}` : ''))
  return { files, runs, clock, seen, registered, flag }
}

const cmd = async ($: Engine, args: string) =>
  ((await $.command.run({ command: 'dt', args, origin: { kind: 'composer' } } as never)) as { text?: string }).text ?? ''
const win = ($: Engine, input: Record<string, unknown>) => $.tool.call({ tool: TOOL, ...input } as never) as Promise<{ result?: unknown }>
const done = ($: Engine) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })

// Instagram added and switched on, the master switch on.
async function ready($: Engine) {
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  expect(await cmd($, `add "Instagram Reels" ${IG}`)).toMatch(/Added "Instagram Reels" \(instagram-reels\)/)
  await cmd($, 'on')
}

// Claude Code ships a command called "downtime": registering that name fails and the whole session.start hook is skipped.
test('the command is registered as dt, never as downtime, and the settings and list are loaded after it', async ($, on) => {
  const { registered, files } = engine(on)
  files['C:\\Users\\test\\.claude\\downtime\\activities.json'] = JSON.stringify([{ id: 'ig', name: 'Instagram Reels', kind: 'url', target: IG }])
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  expect(registered).toEqual(['dt'])
  expect(await cmd($, 'list')).toMatch(/ig: Instagram Reels/)
})

test('the windows open once Claude has worked for the delay, and go down with a chime when it is done', async ($, on) => {
  const { runs, clock, seen } = engine(on)
  await ready($)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(19_000)
  expect(runs.length).toBe(0)
  await clock.advance(2_000)
  expect(seen()).toEqual([`open:${IG}`])
  expect(runs[0]!.at(-1)).toBe('C:/Users/test/.claude/downtime/profiles/instagram-reels')

  await done($)
  await clock.advance(100)
  expect(seen()).toEqual([`open:${IG}`, `minimize:${IG}`, 'chime'])
})

test('a short answer opens nothing and says nothing', async ($, on) => {
  const { runs, clock } = engine(on)
  await ready($)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(5_000)
  await done($)
  await clock.advance(30_000)
  expect(runs.length).toBe(0)
})

test('a subagent still running keeps the windows up until it ends', async ($, on) => {
  const { clock, seen } = engine(on)
  await ready($)
  await $.agent.spawn({ tool_use_id: 'tu1', prompt: 'look', description: 'Look around', subagentType: 'Explore', parentModel: 'opus', background: true, fork: false } as never)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(21_000)
  expect(seen()).toEqual([`open:${IG}`])
  await done($)
  await clock.advance(100)
  expect(seen()).toEqual([`open:${IG}`])
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer', agentId: 'agent-1' } as never)
  await clock.advance(100)
  expect(seen()).toEqual([`open:${IG}`, `minimize:${IG}`, 'chime'])
})

test('nothing happens while the master switch is off, or nothing is chosen', async ($, on) => {
  const { runs, clock } = engine(on)
  await ready($)
  await cmd($, 'off')
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(30_000)
  expect(runs.length).toBe(0)
  await done($)
  await cmd($, 'on')
  await cmd($, 'use none')
  await $.turn.start({ text: 'y', turnId: 't2' })
  await clock.advance(30_000)
  expect(runs.length).toBe(0)
})

test("Claude's tool opens and minimizes only what the user switched on, by name", async ($, on) => {
  const { seen } = engine(on)
  await ready($)
  expect(String((await win($, { action: 'list' })).result)).toBe('Switched on: instagram-reels (Instagram Reels)')
  expect(String((await win($, { action: 'open', activity: 'instagram' })).result)).toBe('Instagram Reels: done')
  expect(String((await win($, { action: 'minimize', activity: 'Instagram Reels' })).result)).toBe('Instagram Reels: done')
  expect(seen()).toEqual([`open:${IG}`, `minimize:${IG}`])

  // An address or a path is never taken: only names from the list.
  const refused = String((await win($, { action: 'open', activity: 'https://evil.example/' })).result)
  expect(refused).toMatch(/^Not done: no switched-on activity/)
  expect(seen().length).toBe(2)

  await cmd($, 'use none')
  expect(String((await win($, { action: 'open', activity: 'instagram' })).result)).toMatch(/^Not done: no switched-on activity/)
  expect(String((await win($, { action: 'list' })).result)).toMatch(/No activity is switched on/)
  expect(seen().length).toBe(2)
})

test('the command checks what it adds: a program, a script or a relative path is refused', async ($, on) => {
  const { files } = engine(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  expect(await cmd($, 'add "Run" C:\\tools\\run.exe')).toMatch(/Not added: .*program/)
  expect(await cmd($, 'add "Js" javascript:alert(1)')).toMatch(/Not added: .*full path/)
  expect(await cmd($, 'add "Rel" docs\\a.pdf')).toMatch(/Not added/)
  expect(await cmd($, 'add "Contratto" C:\\Users\\me\\Documents\\contratto.pdf')).toMatch(/Added "Contratto"/)
  const saved = JSON.parse(Object.entries(files).find(([p]) => p.endsWith('activities.json'))![1])
  expect(saved.map((a: { id: string }) => a.id)).toEqual(['contratto'])
  expect(await cmd($, 'list')).toMatch(/\[x\] contratto: Contratto \(file C:\\Users\\me\\Documents\\contratto\.pdf\)/)
})

test('a web page opens in the browser the user chose, and goes back to the default on request', async ($, on) => {
  const { runs } = engine(on)
  await ready($)
  const browserArg = () => { const argv = runs.at(-1)!; return argv.includes('-Browser') ? argv[argv.indexOf('-Browser') + 1] : undefined }
  await cmd($, 'open instagram')
  expect(browserArg()).toBeUndefined()
  expect(await cmd($, 'browser instagram brave')).toBe('Instagram Reels opens in brave.')
  await cmd($, 'open instagram')
  expect(browserArg()).toBe('brave')
  expect(await cmd($, 'list')).toMatch(/\(url https:\/\/www\.instagram\.com\/reels\/, brave\)/)
  expect(await cmd($, 'browser instagram firefox')).toMatch(/^Usage: \/dt browser <id> edge \| chrome \| brave \| default/)
  expect(await cmd($, 'browser instagram default')).toMatch(/Edge, or Chrome if Edge is missing/)
  await cmd($, 'open instagram')
  expect(browserArg()).toBeUndefined()

  await cmd($, 'add "Note" C:\\Users\\me\\note.txt')
  expect(await cmd($, 'browser note chrome')).toBe('Note is not a web page: a browser applies to web pages only.')
})

const PLAYER = 'C:\\Program Files\\Player\\player.exe'
const ADD_PLAYER = `add-app "Music Player" "${PLAYER}" --minimized "my list"`

test('an application cannot run until the user confirmed it, and a changed command cancels the confirmation', async ($, on) => {
  const { runs, files } = engine(on)
  await ready($)
  expect(await cmd($, ADD_PLAYER)).toBe(`Added "Music Player" (music-player), but it cannot run yet. It would run exactly:\n  "${PLAYER}" --minimized "my list"\nIf that is what you want: /dt confirm music-player`)

  // Stored, but not usable: not by hand, not selected, not for Claude.
  expect(await cmd($, 'open music-player')).toBe('Not done: Music Player is an application you have not confirmed: /dt confirm music-player')
  expect(await cmd($, 'list')).toMatch(/\[ \] music-player: Music Player \(app "C:\\Program Files\\Player\\player\.exe" --minimized "my list", NOT CONFIRMED\)/)
  await cmd($, 'use all')
  expect(String((await win($, { action: 'list' })).result)).toBe('Switched on: instagram-reels (Instagram Reels)')
  expect(runs.length).toBe(0)

  expect(await cmd($, 'confirm music-player')).toBe(`Confirmed and switched on: Music Player may run exactly\n  "${PLAYER}" --minimized "my list"`)
  expect(String((await win($, { action: 'list' })).result)).toBe('Switched on: instagram-reels (Instagram Reels), music-player (Music Player)')
  expect(await cmd($, 'open music-player')).toBe('Music Player: done')
  const argv = runs.at(-1)!
  expect(argv[argv.indexOf('-Kind') + 1]).toBe('app')
  expect(argv[argv.indexOf('-Target') + 1]).toBe(PLAYER)
  expect(JSON.parse(decodeURIComponent(argv[argv.indexOf('-AppArgs') + 1]!))).toEqual(['--minimized', 'my list'])

  // Somebody edits the file: the arguments change, and the confirmation no longer fits.
  const path = Object.keys(files).find(p => p.endsWith('activities.json'))!
  const edited = JSON.parse(files[path]!)
  edited.find((a: { id: string }) => a.id === 'music-player').args = ['--something-else']
  files[path] = JSON.stringify(edited)
  await cmd($, 'reload')
  expect(await cmd($, 'list')).toMatch(/NOT CONFIRMED/)
  expect(await cmd($, 'open music-player')).toMatch(/^Not done: .* not confirmed/)
  expect(String((await win($, { action: 'list' })).result)).toBe('Switched on: instagram-reels (Instagram Reels)')

  // Removing it forgets the confirmation: adding the same command again starts unconfirmed.
  await cmd($, 'remove music-player')
  await cmd($, ADD_PLAYER)
  expect(await cmd($, 'open music-player')).toMatch(/^Not done: .* not confirmed/)
})

test('an application is a program the user listed: a wrong path, the editor or a terminal are refused', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  expect(await cmd($, 'add-app "Code" C:\\Users\\me\\AppData\\Local\\Code.exe')).toMatch(/Not added: .*window you work in/)
  expect(await cmd($, 'add-app "Shell" C:\\Windows\\System32\\cmd.exe /c calc')).toMatch(/Not added: .*window you work in/)
  expect(await cmd($, 'add-app "Rel" player.exe')).toMatch(/Not added: .*full path/)
  expect(await cmd($, 'add-app "Doc" C:\\Docs\\a.pdf')).toMatch(/Not added: .*\.exe/)
  expect(await cmd($, 'add-app "Only a name"')).toMatch(/^Usage: \/dt add-app/)
  expect(await cmd($, 'confirm nothing')).toBe('no activity "nothing"')
  expect(await cmd($, 'list')).toMatch(/No activities yet/)
  // The plain add is still for documents and pages: a program there is refused.
  expect(await cmd($, `add "Sneaky" "${PLAYER}"`)).toMatch(/Not added: .*program, not a document/)
})

test('opening an application asks the user every time, while the rest of the tool stays free', async ($, on) => {
  const { seen } = engine(on)
  await ready($)
  await cmd($, ADD_PLAYER)
  await cmd($, 'confirm music-player')
  const check = (input: Record<string, unknown>) => $.tool.check({ tool: TOOL, input } as never)

  const open = await check({ action: 'open', activity: 'music' })
  expect(open.decision).toBe('ask')
  expect(open.reason).toMatch(/start the application "Music Player": "C:\\Program Files\\Player\\player\.exe" --minimized "my list"/)
  for (const input of [{ action: 'minimize', activity: 'music' }, { action: 'restore', activity: 'music' }, { action: 'list' }, { action: 'open', activity: 'instagram' }, { action: 'open', activity: 'nothing' }]) {
    expect((await check(input)).decision).toBe('allow')
  }
  // Not confirmed, not listed for Claude at all: nothing to ask about.
  await cmd($, 'add-app "Other" C:\\Other\\other.exe')
  expect((await check({ action: 'open', activity: 'other' })).decision).toBe('allow')
  expect(String((await win($, { action: 'open', activity: 'other' })).result)).toMatch(/^Not done: no switched-on activity/)
  expect(seen().filter(s => s.startsWith('open')).length).toBe(0)
})

test('a confirmed application opens by itself like the others, and goes down when Claude needs the user', async ($, on) => {
  const { clock, seen } = engine(on)
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  await cmd($, ADD_PLAYER)
  await cmd($, 'confirm music-player')
  await cmd($, 'on')
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(21_000)
  expect(seen()).toEqual([`open:${PLAYER}`])
  await done($)
  await clock.advance(100)
  expect(seen()).toEqual([`open:${PLAYER}`, `minimize:${PLAYER}`, 'chime'])
})

test('a position is set by command, goes to the script, and can be reapplied or removed', async ($, on) => {
  const { runs } = engine(on)
  await ready($)
  const last = () => runs.at(-1)!
  const arg = (name: string) => (last().includes(name) ? last()[last().indexOf(name) + 1] : undefined)

  expect(await cmd($, 'place instagram')).toMatch(/has no position: \/dt position instagram-reels left/)
  expect(await cmd($, 'position instagram right 2')).toBe('Instagram Reels opens right on monitor 2.')
  await cmd($, 'open instagram')
  expect([arg('-Action'), arg('-Position'), arg('-Monitor')]).toEqual(['open', 'right', '2'])
  expect(await cmd($, 'place instagram')).toBe('Instagram Reels: done')
  expect(arg('-Action')).toBe('place')
  expect(await cmd($, 'list')).toMatch(/, right on monitor 2\)/)

  expect(await cmd($, 'position instagram 100,50,800,600')).toBe('Instagram Reels opens 100,50 800x600.')
  await cmd($, 'open instagram')
  expect([arg('-Position'), arg('-Monitor')]).toEqual(['100,50,800,600', undefined])

  for (const bad of ['middle', 'left 0', 'left 9', '5,5,20,20']) expect(await cmd($, `position instagram ${bad}`)).toMatch(/^Not changed: /)
  expect(await cmd($, 'position instagram')).toMatch(/^Usage: \/dt position/)

  expect(await cmd($, 'position instagram none')).toBe('Instagram Reels opens where the system puts it.')
  await cmd($, 'open instagram')
  expect(arg('-Position')).toBeUndefined()
})

test('a snooze holds the automatic opening back, leaves open windows alone, and ends when asked or when it runs out', async ($, on) => {
  const { runs, clock, seen } = engine(on)
  await ready($)
  expect(await cmd($, 'snooze')).toBe('Not snoozed.')
  expect(await cmd($, 'snooze 30')).toMatch(/^Nothing opens by itself until \d\d:\d\d\.$/)
  expect(await cmd($, 'snooze')).toMatch(/^Snoozed until \d\d:\d\d\.$/)

  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(25_000)
  expect(runs.length).toBe(0)

  // Ended by hand: Claude is still at work, so they open after the delay.
  expect(await cmd($, 'snooze off')).toBe('Snooze ended.')
  await clock.advance(21_000)
  expect(seen()).toEqual([`open:${IG}`])

  // Windows already open stay as they are when a snooze starts.
  await cmd($, 'snooze 10')
  await clock.advance(60_000)
  expect(seen()).toEqual([`open:${IG}`])
})

test('a snooze that runs out lets the windows open if Claude is still at work', async ($, on) => {
  const { clock, seen } = engine(on)
  await ready($)
  await cmd($, 'snooze 5')
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(5 * 60_000 - 1_000)
  expect(seen()).toEqual([])
  await clock.advance(22_000)
  expect(seen()).toEqual([`open:${IG}`])
})

test('a snooze needs minutes between 1 and 720', async ($, on) => {
  const { clock } = engine(on)
  await ready($)
  for (const bad of ['0', '-3', '721', 'abc']) expect(await cmd($, `snooze ${bad}`)).toMatch(/^Usage: \/dt snooze/)
  expect(await cmd($, 'snooze off')).toBe('Not snoozed.')
  await clock.advance(1_000)
})

for (const [system, script] of [['Darwin', 'window-macos.sh'], ['Linux', 'window-linux.sh']] as const) {
test(`${system}: the actions go to ${script}, in its option style, one --arg for each argument`, async ($, on) => {
  const { runs, flag, seen, clock } = engine(on, system)
  await ready($)
  expect(await cmd($, 'open instagram')).toBe('Instagram Reels: done')
  const argv = runs.at(-1)!
  expect(argv[0]).toBe('bash')
  expect(argv[1]!.endsWith(`/scripts/${script}`)).toBe(true)
  expect([flag(argv, 'action'), flag(argv, 'kind'), flag(argv, 'target'), flag(argv, 'profile')]).toEqual(['open', 'url', IG, '/home/test/.claude/downtime/profiles/instagram-reels'])
  expect(argv.some(x => x.startsWith('-') && !x.startsWith('--'))).toBe(false)
  expect(argv).not.toContain('powershell')

  await cmd($, 'add-app "Music" /Applications/Music.app --minimized "my list"')
  await cmd($, 'confirm music')
  await cmd($, 'open music')
  const app = runs.at(-1)!
  expect(app.slice(app.indexOf('--arg'))).toEqual(['--arg', '--minimized', '--arg', 'my list'])
  expect(app.some(x => x === '--app-args')).toBe(false)

  // The automatic opening and the going down work the same.
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(21_000)
  await done($)
  await clock.advance(100)
  expect(seen()).toContain(`minimize:${IG}`)
  expect(seen()).toContain('minimize:/Applications/Music.app')
})
}

test('a system with no script says so instead of failing silently', async ($, on) => {
  const { runs } = engine(on, 'FreeBSD')
  await ready($)
  expect(await cmd($, 'open instagram')).toMatch(/Not done: .*Windows, macOS and Linux only/)
  expect(runs.length).toBe(0)
})

test('a permission asked of the user takes the windows down', async ($, on) => {
  const { clock, seen } = engine(on)
  on('tool.check', () => ({ decision: 'ask' as const }))
  await ready($)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(21_000)
  expect(seen()).toEqual([`open:${IG}`])
  await $.tool.call({ tool: 'Bash', command: 'rm x' } as never)
  await clock.advance(100)
  expect(seen()).toEqual([`open:${IG}`, `minimize:${IG}`, 'chime'])
})

test('after a permission the windows come back on their own, and after a question only when Claude goes on', async ($, on) => {
  const { clock, seen } = engine(on)
  on('tool.check', (_, e) => ({ decision: JSON.stringify(e).includes('ask me') || e.tool === 'AskUserQuestion' ? ('ask' as const) : ('allow' as const) }))
  await ready($)
  await $.turn.start({ text: 'x', turnId: 't1' })
  await clock.advance(21_000)
  // The engine says nothing when the user answers: the windows return after the usual delay.
  await $.tool.call({ tool: 'Bash', command: 'ask me' } as never)
  await clock.advance(100)
  expect(seen()).toEqual([`open:${IG}`, `minimize:${IG}`, 'chime'])
  await clock.advance(19_000)
  expect(seen().length).toBe(3)
  await clock.advance(2_000)
  expect(seen()).toEqual([`open:${IG}`, `minimize:${IG}`, 'chime', `open:${IG}`])
  // A question waits for the user as long as it takes.
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  await clock.advance(100)
  expect(seen().slice(4)).toEqual([`minimize:${IG}`, 'chime'])
  await clock.advance(60_000)
  expect(seen().length).toBe(6)
})
