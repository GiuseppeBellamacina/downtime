// Pure functions: the user's list of activities, what to open and when. No engine here, so they are tested alone.
import type { Activity, Busy, DowntimeSettings } from '../types'

export const DEFAULTS: DowntimeSettings = { enabled: false, selected: [], delaySec: 20, minimizeOnAsk: true, reopen: true, chime: true }
export const EMPTY_BUSY: Busy = { turn: false, agents: [], tasks: [], needsUser: false, snoozeUntil: 0, shown: false }

/** Ready to add with one press: the two the user named. */
export const PRESETS: Activity[] = [
  { id: 'instagram', name: 'Instagram Reels', kind: 'url', target: 'https://www.instagram.com/reels/' },
  { id: 'netflix', name: 'Netflix', kind: 'url', target: 'https://www.netflix.com/browse' },
]

/** A task whose end notice never came must not hold the windows open for ever. */
export const STALE_TASK_MS = 30 * 60_000

/** The browsers that take --app= and --user-data-dir=: a fixed list, never a path or a command. */
export const BROWSERS = ['edge', 'chrome', 'brave'] as const

/** The sides of a monitor's work area a window can take (`full` is all of it). */
export const SIDES = ['left', 'right', 'top', 'bottom', 'full'] as const

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/
const CONTROL = /[\u0000-\u001f]/
// A document, never a program: opening these would run them.
const PROGRAMS = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|msi|msc|scr|lnk|cpl|hta|reg|dll|jar|appx|url)$/i

export const slug = (name: string) =>
  name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)

/** The activity, or what is wrong with it. */
export function check(value: unknown): Activity | string {
  const a = value as Record<string, unknown> | null
  if (!a || typeof a !== 'object') return 'not an activity'
  const { id, name, kind, target, match, browser, position, monitor } = a
  if (typeof id !== 'string' || !ID.test(id)) return 'the id must be a-z, 0-9 and dashes (at most 32)'
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || CONTROL.test(name)) return `${id}: the name must be 1 to 60 characters`
  if (kind !== 'url' && kind !== 'file') return `${id}: kind must be "url" or "file"`
  if (typeof target !== 'string' || target.length > 2000 || CONTROL.test(target)) return `${id}: the target is missing or too long`
  if (kind === 'url' && !/^https?:\/\/[^\s"'<>`]+$/i.test(target)) return `${id}: an address must start with http:// or https://`
  if (kind === 'file') {
    if (!/^([A-Za-z]:[\\/]|\\\\)/.test(target) || /[*?<>|"]/.test(target)) return `${id}: a file needs its full path (C:\\...)`
    if (PROGRAMS.test(target)) return `${id}: that is a program, not a document: it would run, not open`
  }
  if (match !== undefined && (typeof match !== 'string' || match.length > 100 || match.startsWith('-') || CONTROL.test(match))) return `${id}: bad "match"`
  if (browser !== undefined && (kind !== 'url' || !(BROWSERS as readonly unknown[]).includes(browser))) {
    return `${id}: "browser" is for web pages and one of ${BROWSERS.join(', ')}`
  }
  let place: Activity['position']
  if (position !== undefined) {
    const rect = position as Record<string, unknown> | null
    if (typeof position === 'string' && (SIDES as readonly string[]).includes(position)) place = position as (typeof SIDES)[number]
    else if (rect && typeof rect === 'object' && Number.isInteger(rect.x) && Number.isInteger(rect.y) && Number.isInteger(rect.width) && Number.isInteger(rect.height)) {
      const [x, y, width, height] = [rect.x, rect.y, rect.width, rect.height] as number[]
      if (Math.abs(x!) > 32000 || Math.abs(y!) > 32000 || width! < 100 || width! > 16000 || height! < 100 || height! > 16000) return `${id}: the position is outside what a screen can be`
      place = { x: x!, y: y!, width: width!, height: height! }
    } else return `${id}: "position" is ${SIDES.join(', ')} or { x, y, width, height } in pixels`
  }
  if (monitor !== undefined && (typeof place !== 'string' || !Number.isInteger(monitor) || (monitor as number) < 1 || (monitor as number) > 8)) {
    return `${id}: "monitor" is a number from 1 to 8, and goes with a position that is a side`
  }
  return {
    id,
    name: name.trim(),
    kind,
    target,
    ...(typeof match === 'string' && match ? { match } : {}),
    ...(browser ? { browser: browser as (typeof BROWSERS)[number] } : {}),
    ...(place ? { position: place } : {}),
    ...(monitor ? { monitor: monitor as number } : {}),
  }
}

/** The file's text as a list: the good entries, and a line for each one that was dropped. */
export function parseActivities(text: string): { list: Activity[]; problems: string[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { list: [], problems: ['activities.json is not valid JSON'] }
  }
  if (!Array.isArray(raw)) return { list: [], problems: ['activities.json must hold a list'] }
  const list: Activity[] = []
  const problems: string[] = []
  for (const item of raw) {
    const out = check(item)
    if (typeof out === 'string') problems.push(out)
    else if (list.some(a => a.id === out.id)) problems.push(`${out.id}: listed twice`)
    else list.push(out)
  }
  return { list, problems }
}

/** By id, or by name; or by the start of either when only one fits. */
export function find(list: readonly Activity[], query: string): Activity | 'ambiguous' | undefined {
  const q = query.trim().toLowerCase()
  if (!q) return undefined
  const exact = list.find(a => a.id === q || a.name.toLowerCase() === q)
  if (exact) return exact
  const near = list.filter(a => a.id.startsWith(q) || a.name.toLowerCase().startsWith(q))
  return near.length === 1 ? near[0] : near.length > 1 ? 'ambiguous' : undefined
}

export const isBusy = (b: Busy, now: number) => b.turn || b.agents.length > 0 || b.tasks.some(t => now - t.at < STALE_TASK_MS)

/** Windows should be up: the switch is on, something is chosen, no snooze is running, Claude is busy and does not wait for the user. */
export const shouldShow = (s: DowntimeSettings, b: Busy, now: number) => s.enabled && s.selected.length > 0 && !b.needsUser && now >= b.snoozeUntil && isBusy(b, now)

const pad = (n: number) => String(n).padStart(2, '0')

/** HH:MM, for what the user reads. */
export function clockTime(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Words with "double quotes" keeping spaces: `add "Instagram Reels" https://...`. */
export function words(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/"([^"]*)"|(\S+)/g)) out.push(m[1] ?? m[2] ?? '')
  return out
}

/** What a file's window title must hold. */
export function matchOf(a: Activity): string {
  if (a.match) return a.match
  if (a.kind === 'url') return ''
  const file = a.target.split(/[\\/]/).pop() ?? ''
  const dot = file.lastIndexOf('.')
  return dot > 0 ? file.slice(0, dot) : file
}

export type Action = 'open' | 'minimize' | 'restore' | 'place' | 'chime'

/** The position as the script reads it: a side, or "x,y,width,height". */
export const positionArg = (p: NonNullable<Activity['position']>): string => (typeof p === 'string' ? p : `${p.x},${p.y},${p.width},${p.height}`)

/** For a list: "left", "right on monitor 2", "100,50 800x600". */
export function describePosition(a: Activity): string {
  const p = a.position
  if (!p) return ''
  return typeof p === 'string' ? (a.monitor ? `${p} on monitor ${a.monitor}` : p) : `${p.x},${p.y} ${p.width}x${p.height}`
}

/** "left", "right 2", "100,50,800,600": what the user types for a position, as the activity's fields (`check` judges them). */
export function parsePosition(args: string[]): Pick<Activity, 'position' | 'monitor'> {
  const [where = '', monitor] = args
  const rect = /^(-?\d+),(-?\d+),(\d+),(\d+)$/.exec(where)
  const position = rect ? { x: Number(rect[1]), y: Number(rect[2]), width: Number(rect[3]), height: Number(rect[4]) } : (where.toLowerCase() as Activity['position'])
  return monitor === undefined ? { position } : { position, monitor: Number(monitor) }
}

/** The whole command line for scripts/window.ps1: an argument vector, no shell reads any of it. */
export function launcher(action: Action, a: Activity | undefined, script: string, profileDir: string): string[] {
  const base = ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action]
  if (!a) return base
  return [
    ...base,
    '-Kind', a.kind, '-Target', a.target, '-Match', matchOf(a), '-Profile', profileDir,
    ...(a.browser ? ['-Browser', a.browser] : []),
    ...(a.position ? ['-Position', positionArg(a.position)] : []),
    ...(a.monitor ? ['-Monitor', String(a.monitor)] : []),
  ]
}
