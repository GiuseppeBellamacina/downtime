import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Busy, DowntimeSettings } from '../types'
import { BROWSERS, DEFAULTS, EMPTY_BUSY, PRESETS, check, clockTime, commandLine, describePosition, find, isBusy, isUsable, launcher, parseActivities, parsePosition, SCRIPTS, shouldShow, showCommand, slug, words } from './activities'
import type { Action, System } from './activities'

const PANE = 'downtime'
const TOOL = 'mcp__downtime__window'

const activitiesA = atom({ plugin: 'downtime', key: 'activities' } as const, [])
const settingsA = atom({ plugin: 'downtime', key: 'settings' } as const, DEFAULTS)
// The tag changes with the fields: a value an earlier version stored (it outlives a reload) is declined.
const busyA = atom({ plugin: 'downtime', key: 'busy' } as const, EMPTY_BUSY, { shape: 'busy-2' })
const messageA = atom({ plugin: 'downtime', key: 'message' } as const, null)
const confirmedA = atom({ plugin: 'downtime', key: 'confirmed' } as const, {})

// The guidance lives in the tool's description: it reaches the model whatever other plugins do to the prompt.
const TOOL_SPEC = {
  name: 'window',
  description: `Opens, minimizes or restores the windows the user chose in /dt (a feed, a video, a document), only the ones they switched on. Use it only when the user asks ("open Instagram", "minimize the PDF"): the plugin already opens them while you work and minimizes them when you need the user. Actions: "list" (the switched-on activities), "open" (opens one, or brings it back if it is minimized), "minimize", "restore" (only if it is already open). "activity" is an id or a name from that list: nothing else is accepted, never an address or a path.`,
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'open', 'minimize', 'restore'] },
      activity: { type: 'string', description: 'An id or a name from the list.' },
    },
    required: ['action'],
  },
  isDeferred: false,
}

let openTimer: { cancel: () => void } | undefined
let snoozeTimer: { cancel: () => void } | undefined
let returnTimer: { cancel: () => void } | undefined
let queue: Promise<unknown> = Promise.resolve()

const home = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
const dirOf = async ($: EngineInterface) => `${await home($)}/.claude/downtime`

/** Window actions one at a time: two at once would fight over the same windows. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** What the plugin saw lately, for `/dt log`: a failed opening or a timer that never ran leaves no other trace. */
const trace: string[] = []
const note = (text: string) => {
  trace.push(`${new Date().toTimeString().slice(0, 8)} ${text}`)
  if (trace.length > 60) trace.shift()
}

/** Work that must not hold up a hook (a permission prompt waits for hooks): started from a timer, it outlives the dispatch. */
const later = ($: EngineInterface, ms: number, fn: () => Promise<unknown>) => $.clock.after(ms, () => void fn().catch(err => note(`timer failed: ${String(err)}`)))

const setBusy = ($: EngineInterface, fn: (b: Busy) => Busy) => update($, busyA, fn)
const say = ($: EngineInterface, text: string | null) => update($, messageA, () => text)

// ---- the list and the settings ------------------------------------------------------------------

async function loadAll($: EngineInterface) {
  const stored = await $.store.get('settings')
  await update($, settingsA, () => ({ ...DEFAULTS, ...(stored && typeof stored === 'object' ? (stored as Partial<DowntimeSettings>) : {}) }))
  const confirmed = await $.store.get('confirmed')
  await update($, confirmedA, () => (confirmed && typeof confirmed === 'object' ? (confirmed as Record<string, string>) : {}))
  const text = await $.fs.read(`${await dirOf($)}/activities.json`).catch(() => '')
  const { list, problems } = text ? parseActivities(text) : { list: [] as Activity[], problems: [] as string[] }
  await update($, activitiesA, () => list)
  await say($, problems.length ? `activities.json: ${problems.join('; ')}` : null)
}

async function changeSettings($: EngineInterface, fn: (s: DowntimeSettings) => DowntimeSettings) {
  const next = fn(await read($, settingsA))
  await update($, settingsA, () => next)
  await $.store.set('settings', next)
}

async function saveActivities($: EngineInterface, list: Activity[]) {
  await update($, activitiesA, () => list)
  await $.fs.write(`${await dirOf($)}/activities.json`, JSON.stringify(list, null, 2))
}

/** The confirmation of an application is kept against the exact command: a changed path or argument cancels it. */
async function setConfirmed($: EngineInterface, id: string, line: string | null) {
  const next = { ...(await read($, confirmedA)) }
  if (line === null) delete next[id]
  else next[id] = line
  await update($, confirmedA, () => next)
  await $.store.set('confirmed', next)
}

/** The activities the user switched on: the only ones that open by themselves and that Claude may use. An application counts once confirmed. */
async function chosen($: EngineInterface): Promise<Activity[]> {
  const { selected } = await read($, settingsA)
  const confirmed = await read($, confirmedA)
  return (await read($, activitiesA)).filter(a => selected.includes(a.id) && isUsable(a, confirmed))
}

/** An application the user lists: stored, but it cannot run until they have seen the command and confirmed it. */
async function addApplication($: EngineInterface, name: string, path: string, args: string[]): Promise<string> {
  const list = await read($, activitiesA)
  let id = slug(name) || 'app'
  for (let n = 2; list.some(a => a.id === id); n++) id = `${slug(name).slice(0, 28)}-${n}`
  const made = check({ id, name, kind: 'app', target: path, ...(args.length ? { args } : {}) })
  if (typeof made === 'string') return `Not added: ${made}`
  await saveActivities($, [...list, made])
  return `Added "${made.name}" (${made.id}), but it cannot run yet. It would run exactly:\n  ${showCommand(made)}\nIf that is what you want: /dt confirm ${made.id}`
}

/** Adds an activity the user wrote and switches it on: writing it is the consent. */
async function addActivity($: EngineInterface, name: string, target: string, match?: string): Promise<string> {
  const list = await read($, activitiesA)
  let id = slug(name) || 'activity'
  for (let n = 2; list.some(a => a.id === id); n++) id = `${slug(name).slice(0, 28)}-${n}`
  const made = check({ id, name, kind: /^https?:\/\//i.test(target) ? 'url' : 'file', target, ...(match ? { match } : {}) })
  if (typeof made === 'string') return `Not added: ${made}`
  await saveActivities($, [...list, made])
  await changeSettings($, s => ({ ...s, selected: [...s.selected, made.id] }))
  return `Added "${made.name}" (${made.id}) and switched it on.`
}

// ---- start again ----------------------------------------------------------------------------------

/** What `/dt reset` would remove, said before it does anything. */
async function resetPreview($: EngineInterface): Promise<string> {
  const n = (await read($, activitiesA)).length
  return [
    'This puts downtime back as just installed. It removes:',
    `  - the list of activities (${n})`,
    '  - the settings (switches, delay, sound, browser and position choices) and the confirmed applications',
    `  - the browser profiles in ${await dirOf($)}/profiles (the logins you made in those windows, such as Instagram)`,
    '  - the log and any snooze',
    'Windows that are open now stay open. To go on: /dt reset yes',
  ].join('\n')
}

/** Everything the plugin keeps, back to a fresh install. The browser profiles are the only thing on disk besides the list. */
async function resetAll($: EngineInterface): Promise<string> {
  for (const t of [openTimer, snoozeTimer, returnTimer]) t?.cancel()
  openTimer = snoozeTimer = returnTimer = undefined
  await saveActivities($, [])
  await $.store.delete('settings')
  await $.store.delete('confirmed')
  await update($, settingsA, () => DEFAULTS)
  await update($, confirmedA, () => ({}))
  await update($, busyA, () => EMPTY_BUSY)
  await say($, null)
  trace.length = 0
  const profiles = `${await dirOf($)}/profiles`
  const system = await systemOf($)
  // Only our own folder, and only a path a command line cannot misread.
  if (!/\/\.claude\/downtime\/profiles$/.test(profiles.replaceAll('\\', '/')) || /[&|<>^%"]/.test(profiles)) return `Back as new, except the browser profiles: delete the folder ${profiles} yourself.`
  if (!(await $.fs.exists(profiles).catch(() => false))) return 'Back as new.'
  const argv = system === 'windows' ? ['cmd', '/c', 'rmdir', '/s', '/q', profiles.replaceAll('/', '\\')] : ['rm', '-rf', profiles]
  const run = await serial(() => $.process.run(argv, { timeoutMs: 25_000 })).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (run.exitCode !== 0 || (await $.fs.exists(profiles).catch(() => false))) return `Back as new, except the browser profiles in ${profiles}: something still uses them. Close those windows and delete the folder.`
  return 'Back as new.'
}

// ---- windows --------------------------------------------------------------------------------------

type Result = { ok: boolean; text: string }

/** Windows says so in its environment; the others are told by `uname`. */
async function systemOf($: EngineInterface): Promise<System | 'other'> {
  if ((await $.env.get('OS')) === 'Windows_NT') return 'windows'
  const uname = (await $.process.run(['uname']).catch(() => ({ stdout: '' }))).stdout.trim()
  return uname === 'Darwin' ? 'macos' : uname === 'Linux' ? 'linux' : 'other'
}

// A system whose script is not here yet says so, instead of failing without a word.
const SUPPORTED: Record<System | 'other', boolean> = { windows: true, macos: true, linux: true, other: false }

async function exec($: EngineInterface, action: Action, a?: Activity): Promise<Result> {
  const system = await systemOf($)
  if (!SUPPORTED[system] || system === 'other') return { ok: false, text: 'downtime works on Windows, macOS and Linux only' }
  const argv = launcher(action, a, `${$.plugin.root}/scripts/${SCRIPTS[system]}`, `${await dirOf($)}/profiles/${a?.id ?? ''}`, system)
  const run = await serial(() => $.process.run(argv, { timeoutMs: 25_000 })).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const line = run.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  note(`${action}${a ? ` ${a.id}` : ''}: ${line || run.stderr.trim().slice(0, 120) || 'no answer'}`)
  if (line.startsWith('ok:')) return { ok: true, text: line.slice(3) }
  return { ok: false, text: line.startsWith('error:') ? line.slice(6) : run.stderr.trim().slice(0, 200) || 'the script gave no answer' }
}

async function showNow($: EngineInterface) {
  if (!shouldShow(await read($, settingsA), await read($, busyA), await $.clock.now())) return note('open timer: not wanted any more')
  const list = await chosen($)
  for (const a of list) {
    const r = await exec($, 'open', a)
    if (!r.ok) await say($, `${a.name}: ${r.text}`)
  }
  await setBusy($, b => ({ ...b, shown: list.length > 0 }))
}

/** Opens the windows once Claude has been busy for the delay (a short answer opens nothing). */
async function scheduleShow($: EngineInterface) {
  openTimer?.cancel()
  openTimer = undefined
  const s = await read($, settingsA)
  const b = await read($, busyA)
  if (b.shown || !shouldShow(s, b, await $.clock.now())) return note(`not scheduled: ${b.shown ? 'a window is already up' : 'not wanted'} (turn ${b.turn}, needs user ${b.needsUser}, ${s.selected.length} on)`)
  note(`opens in ${s.delaySec} s`)
  openTimer = later($, s.delaySec * 1000, () => showNow($))
}

/** Puts the windows down and tells the user why, but only if they were up: nothing to say about what they never saw. */
async function hide($: EngineInterface, why: string) {
  openTimer?.cancel()
  openTimer = undefined
  const s = await read($, settingsA)
  if (!(await read($, busyA)).shown) return note(`${why}: nothing was up`)
  note(why)
  if (s.minimizeOnAsk) {
    await setBusy($, b => ({ ...b, shown: false }))
    for (const a of await chosen($)) await exec($, 'minimize', a)
  }
  if (s.chime) {
    void exec($, 'chime')
    const sent = await $.ui.notify(why, { title: 'downtime' }).catch(() => ({ isSent: false }))
    if (!sent.isSent) $.ui.toast(why)
  }
}

async function askUser($: EngineInterface, tool: string, permission: boolean) {
  returnTimer?.cancel()
  returnTimer = undefined
  // Work that asks at every command would open and close the windows at every one: they stay, and do not take the keyboard.
  if (permission && !(await read($, settingsA)).hideOnPermission) return note(`${tool} asks (permission): windows stay, /dt permission on takes them down`)
  if ((await read($, busyA)).needsUser) return note(`${tool} asks: already waiting for the user`)
  note(`${tool} asks (${permission ? 'permission' : 'question'})`)
  await setBusy($, b => ({ ...b, needsUser: true }))
  await hide($, `Claude needs you (${tool})`)
  // The engine keeps a permission prompt and the command it allows in one call and says nothing when the user answers: the windows come back after the usual delay, not when the command ends. A question waits for the user as long as it takes.
  const s = await read($, settingsA)
  if (permission && s.reopen) {
    returnTimer = later($, s.delaySec * 1000, async () => {
      await setBusy($, b => ({ ...b, needsUser: false }))
      await showNow($)
    })
  }
}

/** A turn or a subagent ended: if nothing is left running, Claude is done and the user is wanted. */
async function settle($: EngineInterface) {
  if (isBusy(await read($, busyA), await $.clock.now())) return
  await hide($, 'Claude has finished')
}

// ---- Claude's tool and the /dt command ----------------------------------------------------

async function act($: EngineInterface, action: 'open' | 'minimize' | 'restore' | 'place', a: Activity): Promise<string> {
  if (!isUsable(a, await read($, confirmedA))) return `Not done: ${a.name} is an application you have not confirmed: /dt confirm ${a.id}`
  const r = await exec($, action, a)
  if (!r.ok) return `Not done: ${a.name}: ${r.text}`
  if (action === 'open' || action === 'restore') await setBusy($, b => ({ ...b, shown: true }))
  return `${a.name}: ${r.text}`
}

async function answerTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const action = String(input.action ?? 'list')
  const on = await chosen($)
  const names = on.map(a => `${a.id} (${a.name})`).join(', ')
  if (action === 'list') return on.length ? `Switched on: ${names}` : 'No activity is switched on: the user chooses them with /dt.'
  if (action !== 'open' && action !== 'minimize' && action !== 'restore') return `Not done: unknown action "${action}".`
  const found = find(on, String(input.activity ?? ''))
  if (found === 'ambiguous') return `Not done: "${String(input.activity)}" fits several. Switched on: ${names}.`
  if (!found) return `Not done: no switched-on activity named "${String(input.activity ?? '')}". ${on.length ? `Switched on: ${names}.` : 'None is switched on: the user chooses them with /dt.'}`
  return act($, action, found)
}

/** Nothing opens by itself for a while. Windows already open are left alone; the snooze does not outlive the session. */
async function snooze($: EngineInterface, arg: string | undefined): Promise<string> {
  const now = await $.clock.now()
  const until = (await read($, busyA)).snoozeUntil
  if (arg === undefined) return until > now ? `Snoozed until ${clockTime(until)}.` : 'Not snoozed.'
  snoozeTimer?.cancel()
  snoozeTimer = undefined
  if (arg === 'off') {
    await setBusy($, b => ({ ...b, snoozeUntil: 0 }))
    await scheduleShow($)
    return until > now ? 'Snooze ended.' : 'Not snoozed.'
  }
  const minutes = Math.round(Number(arg))
  if (!(minutes >= 1 && minutes <= 720)) return 'Usage: /dt snooze <1 to 720 minutes> | off'
  const end = now + minutes * 60_000
  await setBusy($, b => ({ ...b, snoozeUntil: end }))
  openTimer?.cancel()
  openTimer = undefined
  // When it runs out, Claude may still be at work: the windows then open as they would have.
  snoozeTimer = later($, minutes * 60_000, () => scheduleShow($))
  return `Nothing opens by itself until ${clockTime(end)}.`
}

const HELP = [
  '/dt                         the pane',
  '/dt on | off               the master switch',
  '/dt list                   the activities and which are on',
  '/dt add "Name" <address or C:\\path\\file> ["window title"]',
  '/dt add-app "Name" C:\\path\\app.exe [arguments...]   an application (it runs only once you confirm it)',
  '/dt confirm <id>                 allow an application to run exactly as shown',
  '/dt remove <id>',
  '/dt use <id>... | all | none   which are on',
  '/dt delay <seconds>        how long Claude works before they open',
  '/dt permission on | off    whether a permission prompt takes the windows down (off: only a question, a plan and the end do)',
  '/dt sound on | off         the sound and the notification when Claude needs you',
  '/dt snooze <minutes> | off   nothing opens by itself for a while',
  '/dt browser <id> edge | chrome | brave | default   which browser a web page uses',
  '/dt position <id> left | right | top | bottom | full [monitor] | x,y,width,height | none   where its window opens',
  '/dt place <id>                   put its open window there now',
  '/dt open | minimize | restore <id>   try one by hand',
  '/dt reset | reset yes      put everything back as just installed (it says what goes before it does)',
  '/dt log                    what the plugin saw lately (when something does not open)',
  '/dt reload                 read activities.json again',
].join('\n')

async function command($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = words(args)
  const list = await read($, activitiesA)
  const s = await read($, settingsA)
  const confirmed = await read($, confirmedA)
  const one = (q: string | undefined) => {
    const found = find(list, q ?? '')
    return found === 'ambiguous' ? 'several fit that' : found ?? `no activity "${q ?? ''}"`
  }
  switch (verb.toLowerCase()) {
    case '':
      await $.ui.open({ id: PANE, title: 'Downtime', focus: true })
      return 'downtime: pane opened (/dt help lists the commands).'
    case 'on':
    case 'off':
      await changeSettings($, x => ({ ...x, enabled: verb.toLowerCase() === 'on' }))
      return `downtime is ${verb.toLowerCase()}.`
    case 'list':
      return `downtime is ${s.enabled ? 'on' : 'off'}; opens after ${s.delaySec} s of work.\n` + (list.map(a => `${s.selected.includes(a.id) ? '[x]' : '[ ]'} ${a.id}: ${a.name} (${a.kind} ${a.kind === 'app' ? showCommand(a) : a.target}${a.browser ? `, ${a.browser}` : ''}${a.position ? `, ${describePosition(a)}` : ''}${isUsable(a, confirmed) ? '' : ', NOT CONFIRMED'})`).join('\n') || 'No activities yet: /dt add "Name" <address or path>.')
    case 'add':
      return rest.length < 2 ? 'Usage: /dt add "Name" <address or full path> ["window title"]' : addActivity($, rest[0]!, rest[1]!, rest[2])
    case 'add-app':
      return rest.length < 2 ? 'Usage: /dt add-app "Name" C:\\path\\app.exe [arguments...]' : addApplication($, rest[0]!, rest[1]!, rest.slice(2))
    case 'confirm': {
      const a = one(rest[0])
      if (typeof a === 'string') return a
      if (a.kind !== 'app') return `${a.name} is not an application: there is nothing to confirm.`
      await setConfirmed($, a.id, commandLine(a))
      await changeSettings($, x => ({ ...x, selected: x.selected.includes(a.id) ? x.selected : [...x.selected, a.id] }))
      return `Confirmed and switched on: ${a.name} may run exactly\n  ${showCommand(a)}`
    }
    case 'remove': {
      const a = one(rest[0])
      if (typeof a === 'string') return a
      await saveActivities($, list.filter(x => x.id !== a.id))
      await changeSettings($, x => ({ ...x, selected: x.selected.filter(id => id !== a.id) }))
      await setConfirmed($, a.id, null)
      return `Removed ${a.name}.`
    }
    case 'use': {
      const ids = rest[0] === 'all' ? list.map(a => a.id) : rest[0] === 'none' || rest.length === 0 ? [] : rest.map(q => find(list, q)).filter((x): x is Activity => typeof x === 'object').map(a => a.id)
      await changeSettings($, x => ({ ...x, selected: ids }))
      return ids.length ? `On: ${ids.join(', ')}.` : 'None is on.'
    }
    case 'delay': {
      const n = Math.round(Number(rest[0]))
      if (!(n >= 0 && n <= 600)) return 'Usage: /dt delay <0 to 600 seconds>'
      await changeSettings($, x => ({ ...x, delaySec: n }))
      return `They open after ${n} s of work.`
    }
    case 'permission': {
      const v = rest[0]?.toLowerCase()
      if (v !== 'on' && v !== 'off') return `A permission prompt ${s.hideOnPermission ? 'takes the windows down' : 'leaves the windows up'}: /dt permission on | off`
      await changeSettings($, x => ({ ...x, hideOnPermission: v === 'on' }))
      return v === 'on' ? 'A permission prompt takes the windows down, and they come back after the delay.' : 'A permission prompt leaves the windows up. A question, a plan and the end of the work still take them down.'
    }
    case 'sound': {
      const v = rest[0]?.toLowerCase()
      if (v !== 'on' && v !== 'off') return `Sound and notification are ${s.chime ? 'on' : 'off'}: /dt sound on | off`
      await changeSettings($, x => ({ ...x, chime: v === 'on' }))
      return `Sound and notification ${v}.`
    }
    case 'browser': {
      const a = one(rest[0])
      if (typeof a === 'string') return a
      const choice = rest[1]?.toLowerCase() ?? ''
      if (a.kind !== 'url') return `${a.name} is not a web page: a browser applies to web pages only.`
      if (choice !== 'default' && !(BROWSERS as readonly string[]).includes(choice)) return `Usage: /dt browser <id> ${[...BROWSERS, 'default'].join(' | ')}`
      const { browser: _was, ...plain } = a
      const made = check(choice === 'default' ? plain : { ...plain, browser: choice })
      if (typeof made === 'string') return `Not changed: ${made}`
      await saveActivities($, list.map(x => (x.id === a.id ? made : x)))
      return choice === 'default' ? `${a.name} opens in Edge, or Chrome if Edge is missing.` : `${a.name} opens in ${choice}.`
    }
    case 'position': {
      const a = one(rest[0])
      if (typeof a === 'string') return a
      if (rest.length < 2) return 'Usage: /dt position <id> left | right | top | bottom | full [monitor] | x,y,width,height | none'
      const { position: _p, monitor: _m, ...plain } = a
      const made = check(rest[1]!.toLowerCase() === 'none' ? plain : { ...plain, ...parsePosition(rest.slice(1)) })
      if (typeof made === 'string') return `Not changed: ${made}`
      await saveActivities($, list.map(x => (x.id === a.id ? made : x)))
      return made.position ? `${a.name} opens ${describePosition(made)}.` : `${a.name} opens where the system puts it.`
    }
    case 'place': {
      const a = one(rest[0])
      return typeof a === 'string' ? a : a.position ? act($, 'place', a) : `${a.name} has no position: /dt position ${a.id} left, for example.`
    }
    case 'snooze':
      return snooze($, rest[0]?.toLowerCase())
    case 'open':
    case 'minimize':
    case 'restore': {
      const a = one(rest[0])
      return typeof a === 'string' ? a : act($, verb.toLowerCase() as 'open' | 'minimize' | 'restore', a)
    }
    case 'reset':
      return rest[0]?.toLowerCase() === 'yes' ? resetAll($) : resetPreview($)
    case 'log':
      return trace.join('\n') || 'Nothing yet.'
    case 'reload':
      await loadAll($)
      return `${(await read($, activitiesA)).length} activities read.`
    default:
      return HELP
  }
}

// ---- the module -------------------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register(TOOL_SPEC)
    await $.command.register({ name: 'dt', description: 'Downtime: windows to keep at hand while Claude works: choose them, switch them on' })
    await loadAll($)
    return next(e)
  })

  on('command.run', { command: 'dt' }, async ($, e) => ({ text: await command($, e.args) }))

  // A permission or a question waits for the user: the windows go down. Only a real call counts, not a query.
  on('tool.check', async ($, e, next) => {
    if (e.tool === TOOL) {
      // Opening an application starts a program: Claude Code asks the user every time. Anything else of the tool is bounded by their list.
      const input = e.input as { action?: unknown; activity?: unknown } | null
      const app = input?.action === 'open' ? find(await chosen($), String(input.activity ?? '')) : undefined
      if (typeof app === 'object' && app.kind === 'app') return { decision: 'ask' as const, reason: `downtime: Claude wants to start the application "${app.name}": ${showCommand(app)}` }
      return { decision: 'allow' as const }
    }
    const out = await next(e)
    if (e.tool_use_id !== undefined && (out.decision === 'ask' || e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode')) later($, 0, () => askUser($, e.tool, out.decision === 'ask' && e.tool !== 'AskUserQuestion' && e.tool !== 'ExitPlanMode'))
    return out
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL) return { result: await answerTool($, e as unknown as Record<string, unknown>) }
    // A call that starts after the user was asked means they answered: Claude goes on, so the windows come back now, not when a long command ends.
    if ((await read($, busyA)).needsUser) {
      returnTimer?.cancel()
      returnTimer = undefined
      await setBusy($, b => ({ ...b, needsUser: false }))
      if ((await read($, settingsA)).reopen) await scheduleShow($)
    }
    const ran = await next(e)
    // A question or a plan to approve holds its call open until the user answers: when it ends Claude goes on, and the windows come back.
    if ((e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode') && ran.deny === undefined && (await read($, busyA)).needsUser) {
      returnTimer?.cancel()
      returnTimer = undefined
      await setBusy($, b => ({ ...b, needsUser: false }))
      if ((await read($, settingsA)).reopen) await scheduleShow($)
    }
    const result = (ran as { result?: Record<string, unknown> }).result
    const task = typeof result?.backgroundTaskId === 'string' ? result.backgroundTaskId : e.tool === 'Monitor' && typeof result?.taskId === 'string' ? result.taskId : ''
    if (task) {
      const at = await $.clock.now()
      await setBusy($, b => ({ ...b, tasks: [...b.tasks.filter(t => t.id !== task), { id: task, at }].slice(-20) }))
    }
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'task-notification') {
      const id = /<task-id>([^<]+)<\/task-id>/.exec(e.text)?.[1]?.trim()
      if (id) await setBusy($, b => ({ ...b, tasks: b.tasks.filter(t => t.id !== id) }))
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    note(`turn starts${e.agentId === undefined ? '' : ` (agent ${e.agentId}, ignored)`}`)
    if (e.agentId === undefined) {
      await setBusy($, b => ({ ...b, turn: true, needsUser: false }))
      await scheduleShow($)
    }
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const out = await next(e)
    if (out.agentId) {
      const id = out.agentId
      await setBusy($, b => ({ ...b, agents: [...b.agents.filter(x => x !== id), id] }))
      await scheduleShow($)
    }
    return out
  })

  on('turn.complete', async ($, e, next) => {
    note(`turn ends${e.agentId === undefined ? '' : ` (agent ${e.agentId})`}`)
    await setBusy($, b => (e.agentId === undefined ? { ...b, turn: false } : { ...b, agents: b.agents.filter(id => id !== e.agentId) }))
    later($, 0, () => settle($))
    return next(e)
  })

  // ---- the pane ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Input = 'Input' in table ? table.Input : undefined
    const s = await read($, settingsA)
    const list = await read($, activitiesA)
    const message = await read($, messageA)
    const snoozedUntil = (await read($, busyA)).snoozeUntil
    const snoozed = snoozedUntil > (await $.clock.now())
    const confirmed = await read($, confirmedA)
    const toggle = (id: string) => changeSettings($, x => ({ ...x, selected: x.selected.includes(id) ? x.selected.filter(i => i !== id) : [...x.selected, id] }))
    const flag = (key: 'minimizeOnAsk' | 'reopen' | 'chime' | 'hideOnPermission', label: string) => (
      <Button key={`flag-${key}`} plain label={`${s[key] ? '[x]' : '[ ]'} ${label}`} onPress={() => changeSettings($, x => ({ ...x, [key]: !x[key] }))} />
    )
    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Text bold>downtime</Text>
          <Text color={s.enabled ? 'success' : undefined} dimColor={!s.enabled}>
            {s.enabled ? 'on' : 'off'}
          </Text>
          <Button key="power" plain label={s.enabled ? 'turn off' : 'turn on'} onPress={() => changeSettings($, x => ({ ...x, enabled: !x.enabled }))} />
        </Box>
        <Text dimColor>While Claude works, the activities ticked here open; when it needs you or is done, they minimize.</Text>
        {list.length === 0 && <Text dimColor>No activities yet: add one below, or press an example.</Text>}
        {list.map(a => (
          <Box key={`row-${a.id}`} flexDirection="row" gap={1}>
            <Button
              key={`use-${a.id}`}
              plain
              label={`${s.selected.includes(a.id) ? '[x]' : '[ ]'} ${a.name}${isUsable(a, confirmed) ? '' : ' (not confirmed)'}`}
              onPress={async () => (isUsable(a, confirmed) ? toggle(a.id) : say($, `${a.name} runs a program: /dt confirm ${a.id} first, after reading the command.`))}
            />
            <Button key={`open-${a.id}`} plain label="open" onPress={async () => say($, await act($, 'open', a))} />
            <Button key={`min-${a.id}`} plain label="minimize" onPress={async () => say($, await act($, 'minimize', a))} />
            <Button key={`rm-${a.id}`} plain label="remove" onPress={async () => say($, await command($, `remove ${a.id}`))} />
          </Box>
        ))}
        <Box flexDirection="row" gap={1}>
          {PRESETS.filter(p => !list.some(a => a.id === p.id)).map(p => (
            <Button key={`preset-${p.id}`} plain label={`+ ${p.name}`} onPress={async () => say($, await addActivity($, p.name, p.target))} />
          ))}
        </Box>
        <Box flexDirection="row" gap={1}>
          <Button key="less" plain label="-5 s" onPress={() => changeSettings($, x => ({ ...x, delaySec: Math.max(0, x.delaySec - 5) }))} />
          <Text>open after {s.delaySec} s of work</Text>
          <Button key="more" plain label="+5 s" onPress={() => changeSettings($, x => ({ ...x, delaySec: Math.min(600, x.delaySec + 5) }))} />
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text>{snoozed ? `snoozed until ${clockTime(snoozedUntil)}` : 'not snoozed'}</Text>
          <Button key="snooze-15" plain label="snooze 15 min" onPress={async () => say($, await snooze($, '15'))} />
          <Button key="snooze-60" plain label="snooze 1 h" onPress={async () => say($, await snooze($, '60'))} />
          {snoozed && <Button key="snooze-off" plain label="end snooze" onPress={async () => say($, await snooze($, 'off'))} />}
        </Box>
        {flag('minimizeOnAsk', 'minimize when Claude needs me or is done')}
        {flag('reopen', 'bring them back when Claude goes on')}
        {flag('chime', 'sound and notification when Claude needs me')}
        {flag('hideOnPermission', 'minimize at a permission prompt too')}
        {Input && (
          <Input
            key="add"
            label="Add:"
            placeholder="Name = https://... or C:\path\file.pdf"
            submitLabel="add"
            onSubmit={async value => {
              const at = value.indexOf('=')
              say($, at < 1 ? 'Write it as: Name = address or full path' : await addActivity($, value.slice(0, at).trim(), value.slice(at + 1).trim()))
            }}
          />
        )}
        {message && <Text>{message}</Text>}
      </Box>
    )
  })
}
