import { expect, test } from 'claude-code/testing'

import { DEFAULTS, EMPTY_BUSY, STALE_TASK_MS, check, describePosition, find, isBusy, launcher, matchOf, parseActivities, parsePosition, shouldShow, slug, words } from '../hooks/activities'

const ig = { id: 'ig', name: 'Instagram Reels', kind: 'url', target: 'https://www.instagram.com/reels/' } as const
const pdf = { id: 'pdf', name: 'Contratto', kind: 'file', target: 'C:\\Users\\me\\Documents\\contratto.pdf' } as const

test('only an address and a document are accepted, never a program or a script', async () => {
  expect(check(ig)).toEqual(ig)
  expect(check(pdf)).toEqual(pdf)
  for (const bad of ['javascript:alert(1)', 'file:///C:/x', 'ftp://x.org/a', 'https://a b.com', 'https://a.com/"x']) {
    expect(typeof check({ ...ig, target: bad })).toBe('string')
  }
  for (const bad of ['C:\\tools\\run.exe', 'C:\\x\\a.BAT', 'C:\\x\\a.ps1', 'C:\\x\\a.lnk', 'relative\\a.pdf', 'C:\\x\\*.pdf']) {
    expect(typeof check({ ...pdf, target: bad })).toBe('string')
  }
  expect(typeof check({ ...pdf, match: '-Action' })).toBe('string')
  expect(typeof check({ ...ig, id: 'Has Space' })).toBe('string')
  expect(typeof check({ ...ig, kind: 'app' })).toBe('string')
})

test('a browser is one of a fixed list and only for web pages', async () => {
  expect(check({ ...ig, browser: 'chrome' })).toEqual({ ...ig, browser: 'chrome' })
  expect(check({ ...ig, browser: 'brave' })).toEqual({ ...ig, browser: 'brave' })
  for (const bad of ['firefox', 'C:\\x\\evil.exe', '', 'EDGE', 7]) expect(typeof check({ ...ig, browser: bad })).toBe('string')
  expect(typeof check({ ...pdf, browser: 'edge' })).toBe('string')
  // The command line carries it only when it is set.
  expect(launcher('open', { ...ig, browser: 'brave' }, 'S.ps1', 'P').slice(-2)).toEqual(['-Browser', 'brave'])
  expect(launcher('open', ig, 'S.ps1', 'P')).not.toContain('-Browser')
})

test('a position is a side of a monitor or a rectangle on screen, and a monitor goes with a side', async () => {
  expect(check({ ...ig, position: 'left' })).toEqual({ ...ig, position: 'left' })
  expect(check({ ...ig, position: 'right', monitor: 2 })).toEqual({ ...ig, position: 'right', monitor: 2 })
  const rect = { x: -1200, y: 40, width: 800, height: 600 }
  expect(check({ ...pdf, position: rect })).toEqual({ ...pdf, position: rect })
  for (const bad of ['middle', 'LEFT', 5, { x: 1, y: 2, width: 800 }, { x: 1.5, y: 2, width: 800, height: 600 }, { x: 0, y: 0, width: 50, height: 600 }, { x: 99999, y: 0, width: 800, height: 600 }]) {
    expect(typeof check({ ...ig, position: bad })).toBe('string')
  }
  for (const bad of [0, 9, 1.5, '2']) expect(typeof check({ ...ig, position: 'left', monitor: bad })).toBe('string')
  expect(typeof check({ ...ig, monitor: 2 })).toBe('string')
  expect(typeof check({ ...ig, position: rect, monitor: 2 })).toBe('string')
  expect(parsePosition(['LEFT', '2'])).toEqual({ position: 'left', monitor: 2 })
  expect(parsePosition(['100,50,800,600'])).toEqual({ position: { x: 100, y: 50, width: 800, height: 600 } })
  expect(describePosition({ ...ig, position: 'right', monitor: 2 })).toBe('right on monitor 2')
  expect(describePosition({ ...ig, position: rect })).toBe('-1200,40 800x600')
  const argv = launcher('open', { ...ig, position: 'right', monitor: 2 }, 'S.ps1', 'P')
  expect(argv.slice(-4)).toEqual(['-Position', 'right', '-Monitor', '2'])
  expect(launcher('open', { ...ig, position: rect }, 'S.ps1', 'P').slice(-2)).toEqual(['-Position', '-1200,40,800,600'])
  expect(launcher('open', ig, 'S.ps1', 'P')).not.toContain('-Position')
})

test('a bad entry of the file is dropped with its reason, the others stay', async () => {
  const { list, problems } = parseActivities(JSON.stringify([ig, { ...pdf, target: 'C:\\x\\a.exe' }, ig, pdf]))
  expect(list.map(a => a.id)).toEqual(['ig', 'pdf'])
  expect(problems.length).toBe(2)
  expect(parseActivities('not json').problems).toEqual(['activities.json is not valid JSON'])
  expect(parseActivities('{}').list).toEqual([])
})

test('an activity is found by id, name or the start of either, and a doubt is said', async () => {
  const list = [ig, pdf, { id: 'insta2', name: 'Instagram Stories', kind: 'url', target: 'https://www.instagram.com/stories/' } as const]
  expect(find(list, 'ig')).toBe(ig)
  expect(find(list, 'instagram reels')).toBe(ig)
  expect(find(list, 'contr')).toBe(pdf)
  expect(find(list, 'insta')).toBe('ambiguous')
  expect(find(list, 'netflix')).toBeUndefined()
  expect(find(list, '')).toBeUndefined()
})

test('the windows are wanted only while Claude is busy and does not wait for the user', async () => {
  const on = { ...DEFAULTS, enabled: true, selected: ['ig'] }
  expect(shouldShow(on, EMPTY_BUSY, 0)).toBe(false)
  expect(shouldShow(on, { ...EMPTY_BUSY, turn: true }, 0)).toBe(true)
  expect(shouldShow(on, { ...EMPTY_BUSY, agents: ['a'] }, 0)).toBe(true)
  expect(shouldShow(on, { ...EMPTY_BUSY, turn: true, needsUser: true }, 0)).toBe(false)
  expect(shouldShow({ ...on, enabled: false }, { ...EMPTY_BUSY, turn: true }, 0)).toBe(false)
  expect(shouldShow({ ...on, selected: [] }, { ...EMPTY_BUSY, turn: true }, 0)).toBe(false)
  // A snooze holds it back until its time.
  const snoozed = { ...EMPTY_BUSY, turn: true, snoozeUntil: 5000 }
  expect(shouldShow(on, snoozed, 4999)).toBe(false)
  expect(shouldShow(on, snoozed, 5000)).toBe(true)
  // A background task counts, until its end notice is overdue.
  const task = { ...EMPTY_BUSY, tasks: [{ id: 't', at: 1000 }] }
  expect(isBusy(task, 1000 + STALE_TASK_MS - 1)).toBe(true)
  expect(isBusy(task, 1000 + STALE_TASK_MS)).toBe(false)
})

test('words keep a quoted name whole; names become short ids; the command line is an argument vector', async () => {
  expect(words('add "Instagram Reels" https://x.org "a b"')).toEqual(['add', 'Instagram Reels', 'https://x.org', 'a b'])
  expect(slug('Instagram Reels!')).toBe('instagram-reels')
  expect(slug('Città – Più')).toBe('citta-piu')
  expect(matchOf(pdf)).toBe('contratto')
  expect(matchOf({ ...pdf, match: 'Contract' })).toBe('Contract')
  expect(launcher('open', ig, 'S.ps1', 'P')).toEqual([
    'powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', 'S.ps1',
    '-Action', 'open', '-Kind', 'url', '-Target', 'https://www.instagram.com/reels/', '-Match', '', '-Profile', 'P',
  ])
  expect(launcher('chime', undefined, 'S.ps1', 'P').slice(-2)).toEqual(['-Action', 'chime'])
})
