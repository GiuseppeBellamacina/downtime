import { expect, test } from 'claude-code/testing'

import { DEFAULTS, EMPTY_BUSY, STALE_TASK_MS, check, find, isBusy, launcher, matchOf, parseActivities, shouldShow, slug, words } from '../hooks/activities'

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
