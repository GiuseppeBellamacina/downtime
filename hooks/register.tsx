import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, Busy, DowntimeSettings } from '../types'
import { DEFAULTS, EMPTY_BUSY, PRESETS, check, find, isBusy, launcher, parseActivities, shouldShow, slug, words } from './activities'
import type { Action } from './activities'

const PANE = 'downtime'
const TOOL = 'mcp__downtime__window'

const activitiesA = atom({ plugin: 'downtime', key: 'activities' } as const, [])
const settingsA = atom({ plugin: 'downtime', key: 'settings' } as const, DEFAULTS)
const busyA = atom({ plugin: 'downtime', key: 'busy' } as const, EMPTY_BUSY)
const messageA = atom({ plugin: 'downtime', key: 'message' } as const, null)

// The guidance lives in the tool's description: it reaches the model whatever other plugins do to the prompt.
const TOOL_SPEC = {
  name: 'window',
  description: `Opens, minimizes or restores the windows the user chose in /downtime (a feed, a video, a document), only the ones they switched on. Use it only when the user asks ("open Instagram", "minimize the PDF"): the plugin already opens them while you work and minimizes them when you need the user. Actions: "list" (the switched-on activities), "open" (opens one, or brings it back if it is minimized), "minimize", "restore" (only if it is already open). "activity" is an id or a name from that list: nothing else is accepted, never an address or a path.`,
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
let queue: Promise<unknown> = Promise.resolve()

const home = async ($: EngineInterface) => (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
const dirOf = async ($: EngineInterface) => `${await home($)}/.claude/downtime`

/** Window actions one at a time: two at once would fight over the same windows. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn)
  queue = run.catch(() => undefined)
  return run
}

/** Work that must not hold up a hook (a permission prompt waits for hooks): started from a timer, it outlives the dispatch. */
const later = ($: EngineInterface, ms: number, fn: () => Promise<unknown>) => $.clock.after(ms, () => void fn().catch(() => undefined))

const setBusy = ($: EngineInterface, fn: (b: Busy) => Busy) => update($, busyA, fn)
const say = ($: EngineInterface, text: string | null) => update($, messageA, () => text)

// ---- the list and the settings ------------------------------------------------------------------

async function loadAll($: EngineInterface) {
  const stored = await $.store.get('settings')
  await update($, settingsA, () => ({ ...DEFAULTS, ...(stored && typeof stored === 'object' ? (stored as Partial<DowntimeSettings>) : {}) }))
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

/** The activities the user switched on: the only ones that open by themselves and that Claude may use. */
async function chosen($: EngineInterface): Promise<Activity[]> {
  const { selected } = await read($, settingsA)
  return (await read($, activitiesA)).filter(a => selected.includes(a.id))
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

// ---- windows --------------------------------------------------------------------------------------

type Result = { ok: boolean; text: string }

async function exec($: EngineInterface, action: Action, a?: Activity): Promise<Result> {
  if ((await $.env.get('OS')) !== 'Windows_NT') return { ok: false, text: 'downtime works on Windows only, for now' }
  const argv = launcher(action, a, `${$.plugin.root}/scripts/window.ps1`, `${await dirOf($)}/profiles/${a?.id ?? ''}`)
  const run = await serial(() => $.process.run(argv, { timeoutMs: 25_000 })).catch(err => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  const line = run.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? ''
  if (line.startsWith('ok:')) return { ok: true, text: line.slice(3) }
  return { ok: false, text: line.startsWith('error:') ? line.slice(6) : run.stderr.trim().slice(0, 200) || 'the script gave no answer' }
}

async function showNow($: EngineInterface) {
  if (!shouldShow(await read($, settingsA), await read($, busyA), await $.clock.now())) return
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
  if (b.shown || !shouldShow(s, b, await $.clock.now())) return
  openTimer = later($, s.delaySec * 1000, () => showNow($))
}

/** Puts the windows down and tells the user why, but only if they were up: nothing to say about what they never saw. */
async function hide($: EngineInterface, why: string) {
  openTimer?.cancel()
  openTimer = undefined
  const s = await read($, settingsA)
  if (!(await read($, busyA)).shown) return
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

async function askUser($: EngineInterface, tool: string) {
  if ((await read($, busyA)).needsUser) return
  await setBusy($, b => ({ ...b, needsUser: true }))
  await hide($, `Claude needs you (${tool})`)
}

/** A turn or a subagent ended: if nothing is left running, Claude is done and the user is wanted. */
async function settle($: EngineInterface) {
  if (isBusy(await read($, busyA), await $.clock.now())) return
  await hide($, 'Claude has finished')
}

// ---- Claude's tool and the /downtime command ----------------------------------------------------

async function act($: EngineInterface, action: 'open' | 'minimize' | 'restore', a: Activity): Promise<string> {
  const r = await exec($, action, a)
  if (!r.ok) return `Not done: ${a.name}: ${r.text}`
  if (action !== 'minimize') await setBusy($, b => ({ ...b, shown: true }))
  return `${a.name}: ${r.text}`
}

async function answerTool($: EngineInterface, input: Record<string, unknown>): Promise<string> {
  const action = String(input.action ?? 'list')
  const on = await chosen($)
  const names = on.map(a => `${a.id} (${a.name})`).join(', ')
  if (action === 'list') return on.length ? `Switched on: ${names}` : 'No activity is switched on: the user chooses them with /downtime.'
  if (action !== 'open' && action !== 'minimize' && action !== 'restore') return `Not done: unknown action "${action}".`
  const found = find(on, String(input.activity ?? ''))
  if (found === 'ambiguous') return `Not done: "${String(input.activity)}" fits several. Switched on: ${names}.`
  if (!found) return `Not done: no switched-on activity named "${String(input.activity ?? '')}". ${on.length ? `Switched on: ${names}.` : 'None is switched on: the user chooses them with /downtime.'}`
  return act($, action, found)
}

const HELP = [
  '/downtime                         the pane',
  '/downtime on | off               the master switch',
  '/downtime list                   the activities and which are on',
  '/downtime add "Name" <address or C:\\path\\file> ["window title"]',
  '/downtime remove <id>',
  '/downtime use <id>... | all | none   which are on',
  '/downtime delay <seconds>        how long Claude works before they open',
  '/downtime open | minimize | restore <id>   try one by hand',
  '/downtime reload                 read activities.json again',
].join('\n')

async function command($: EngineInterface, args: string): Promise<string> {
  const [verb = '', ...rest] = words(args)
  const list = await read($, activitiesA)
  const s = await read($, settingsA)
  const one = (q: string | undefined) => {
    const found = find(list, q ?? '')
    return found === 'ambiguous' ? 'several fit that' : found ?? `no activity "${q ?? ''}"`
  }
  switch (verb.toLowerCase()) {
    case '':
      await $.ui.open({ id: PANE, title: 'Downtime', focus: true })
      return 'downtime: pane opened (/downtime help lists the commands).'
    case 'on':
    case 'off':
      await changeSettings($, x => ({ ...x, enabled: verb.toLowerCase() === 'on' }))
      return `downtime is ${verb.toLowerCase()}.`
    case 'list':
      return `downtime is ${s.enabled ? 'on' : 'off'}; opens after ${s.delaySec} s of work.\n` + (list.map(a => `${s.selected.includes(a.id) ? '[x]' : '[ ]'} ${a.id}: ${a.name} (${a.kind} ${a.target})`).join('\n') || 'No activities yet: /downtime add "Name" <address or path>.')
    case 'add':
      return rest.length < 2 ? 'Usage: /downtime add "Name" <address or full path> ["window title"]' : addActivity($, rest[0]!, rest[1]!, rest[2])
    case 'remove': {
      const a = one(rest[0])
      if (typeof a === 'string') return a
      await saveActivities($, list.filter(x => x.id !== a.id))
      await changeSettings($, x => ({ ...x, selected: x.selected.filter(id => id !== a.id) }))
      return `Removed ${a.name}.`
    }
    case 'use': {
      const ids = rest[0] === 'all' ? list.map(a => a.id) : rest[0] === 'none' || rest.length === 0 ? [] : rest.map(q => find(list, q)).filter((x): x is Activity => typeof x === 'object').map(a => a.id)
      await changeSettings($, x => ({ ...x, selected: ids }))
      return ids.length ? `On: ${ids.join(', ')}.` : 'None is on.'
    }
    case 'delay': {
      const n = Math.round(Number(rest[0]))
      if (!(n >= 0 && n <= 600)) return 'Usage: /downtime delay <0 to 600 seconds>'
      await changeSettings($, x => ({ ...x, delaySec: n }))
      return `They open after ${n} s of work.`
    }
    case 'open':
    case 'minimize':
    case 'restore': {
      const a = one(rest[0])
      return typeof a === 'string' ? a : act($, verb.toLowerCase() as 'open' | 'minimize' | 'restore', a)
    }
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
    await $.command.register({ name: 'downtime', description: 'Windows to keep at hand while Claude works: choose them, switch them on' })
    await loadAll($)
    return next(e)
  })

  on('command.run', { command: 'downtime' }, async ($, e) => ({ text: await command($, e.args) }))

  // A permission or a question waits for the user: the windows go down. Only a real call counts, not a query.
  on('tool.check', async ($, e, next) => {
    if (e.tool === TOOL) return { decision: 'allow' as const }
    const out = await next(e)
    if (e.tool_use_id !== undefined && (out.decision === 'ask' || e.tool === 'AskUserQuestion' || e.tool === 'ExitPlanMode')) later($, 0, () => askUser($, e.tool))
    return out
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === TOOL) return { result: await answerTool($, e as unknown as Record<string, unknown>) }
    const ran = await next(e)
    const result = (ran as { result?: Record<string, unknown> }).result
    const task = typeof result?.backgroundTaskId === 'string' ? result.backgroundTaskId : e.tool === 'Monitor' && typeof result?.taskId === 'string' ? result.taskId : ''
    if (task) {
      const at = await $.clock.now()
      await setBusy($, b => ({ ...b, tasks: [...b.tasks.filter(t => t.id !== task), { id: task, at }].slice(-20) }))
    }
    // A tool that runs after the user was asked means they answered: Claude goes on.
    if (ran.deny === undefined && (await read($, busyA)).needsUser) {
      await setBusy($, b => ({ ...b, needsUser: false }))
      if ((await read($, settingsA)).reopen) await scheduleShow($)
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
    const toggle = (id: string) => changeSettings($, x => ({ ...x, selected: x.selected.includes(id) ? x.selected.filter(i => i !== id) : [...x.selected, id] }))
    const flag = (key: 'minimizeOnAsk' | 'reopen' | 'chime', label: string) => (
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
            <Button key={`use-${a.id}`} plain label={`${s.selected.includes(a.id) ? '[x]' : '[ ]'} ${a.name}`} onPress={() => toggle(a.id)} />
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
        {flag('minimizeOnAsk', 'minimize when Claude needs me or is done')}
        {flag('reopen', 'bring them back when Claude goes on')}
        {flag('chime', 'sound and notification when Claude needs me')}
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
