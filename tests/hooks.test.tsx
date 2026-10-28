import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const TOOL = 'mcp__downtime__window'
const IG = 'https://www.instagram.com/reels/'

// The engine beneath the plugin: every window action lands in `runs`, and answers like the script would.
function engine(on: On, os = 'Windows_NT') {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  mock.env(on, { USERPROFILE: 'C:/Users/test', OS: os })
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
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: 'ok:done\n', stderr: '' } } as never
  })
  on('tool.call', () => ({ result: { ok: true } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
  on('fs.read', (_, e) => (e.path in files ? { value: files[e.path]! } : Promise.reject(new Error('missing'))))
  on('fs.write', (_, e) => ((files[e.path] = e.text), { value: undefined }))
  const seen = () => runs.map(argv => argv[argv.indexOf('-Action') + 1] + (argv.includes('-Target') ? `:${argv[argv.indexOf('-Target') + 1]}` : ''))
  return { files, runs, clock, seen, registered }
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

test('off Windows it says so instead of failing silently', async ($, on) => {
  const { runs } = engine(on, 'Linux')
  await ready($)
  expect(await cmd($, 'open instagram')).toMatch(/Not done: .*Windows only/)
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
