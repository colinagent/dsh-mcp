import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentRoster, type AgentRosterDeps, type Resolution } from '../src/sync.ts'
import type { ResolvedServer } from '../src/roster.ts'

interface FakeAgent {
  id: string
  cwd: string
}

/** One server that names itself; enough to key a mount. */
function server(name: string, cwd = '/'): ResolvedServer {
  return {
    name,
    transport: 'stdio',
    origin: 'project',
    command: 'npx',
    args: [],
    env: {},
    cwd,
    toolCallTimeoutMs: 60_000,
    closeTimeoutMs: 5_000,
  }
}

/** A host whose documents, clocks, and mounts are all observable. */
function harness() {
  const records = new Map<FakeAgent, { mounts: string[][]; disposed: number }>()
  const watchers = new Map<string, { onChange: () => void; closed: number }>()
  const resolutions: string[] = []
  let roster: Resolution = { servers: [], warnings: [] }
  let watched = 0

  const deps: AgentRosterDeps<FakeAgent> = {
    cwd: agent => agent.cwd,
    watchDir: cwd => `${cwd}/.agents`,
    resolve: async (cwd) => {
      resolutions.push(cwd)
      return roster
    },
    mount: (agent, servers) => {
      const record = records.get(agent) ?? { mounts: [], disposed: 0 }
      record.mounts.push(servers.map(item => item.name))
      records.set(agent, record)
      return {
        dispose: async () => {
          const current = records.get(agent)
          if (current !== undefined) current.disposed += 1
        },
      }
    },
    watch: (directory, onChange) => {
      watched += 1
      watchers.set(directory, { onChange, closed: 0 })
      return () => {
        const watcher = watchers.get(directory)
        if (watcher !== undefined) watcher.closed += 1
      }
    },
    warn: () => {},
    info: () => {},
  }

  return {
    deps,
    records,
    watchers,
    resolutions,
    watched: () => watched,
    roster: (next: Resolution) => { roster = next },
    record: (agent: FakeAgent) => records.get(agent),
  }
}

test('attaching an Agent mounts its resolved servers', async () => {
  const host = harness()
  host.roster({ servers: [server('a'), server('b')], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const agent: FakeAgent = { id: 'one', cwd: '/repo' }
  await agents.attach(agent)
  assert.deepEqual(host.record(agent)?.mounts, [['a', 'b']])
  assert.equal(host.resolutions.length, 1)
  await agents.close()
})

test('an unchanged roster does not remount', async () => {
  const host = harness()
  host.roster({ servers: [server('a')], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const agent: FakeAgent = { id: 'one', cwd: '/repo' }
  await agents.attach(agent)
  await agents.sync(agent)
  assert.equal(host.record(agent)?.mounts.length, 1)
  assert.equal(host.record(agent)?.disposed, 0)
  await agents.close()
})

test('a changed roster remounts and disposes the previous mount', async () => {
  const host = harness()
  host.roster({ servers: [server('a')], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const agent: FakeAgent = { id: 'one', cwd: '/repo' }
  await agents.attach(agent)
  host.roster({ servers: [server('a'), server('b')], warnings: [] })
  await agents.sync(agent)
  assert.deepEqual(host.record(agent)?.mounts, [['a'], ['a', 'b']])
  assert.equal(host.record(agent)?.disposed, 1)
  await agents.close()
})

test('a working-directory change re-resolves for the new directory', async () => {
  const host = harness()
  host.roster({ servers: [server('repo-one')], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const agent: FakeAgent = { id: 'one', cwd: '/repo-one' }
  await agents.attach(agent)
  agent.cwd = '/repo-two'
  host.roster({ servers: [server('repo-two')], warnings: [] })
  await agents.sync(agent)
  assert.deepEqual(host.resolutions, ['/repo-one', '/repo-two'])
  assert.deepEqual(host.record(agent)?.mounts, [['repo-one'], ['repo-two']])
  await agents.close()
})

test('an empty roster still watches, so adding servers later takes effect', async () => {
  const host = harness()
  host.roster({ servers: [], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const agent: FakeAgent = { id: 'one', cwd: '/repo' }
  await agents.attach(agent)
  const watcher = host.watchers.get('/repo/.agents')
  assert.ok(watcher !== undefined)
  host.roster({ servers: [server('a')], warnings: [] })
  watcher.onChange()
  await agents.sync(agent)
  assert.deepEqual(host.record(agent)?.mounts, [[], ['a']])
  await agents.close()
})

test('concurrent syncs of one Agent serialize', async () => {
  const host = harness()
  host.roster({ servers: [server('a')], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const agent: FakeAgent = { id: 'one', cwd: '/repo' }
  await Promise.all([agents.attach(agent), agents.sync(agent), agents.sync(agent)])
  assert.equal(host.record(agent)?.mounts.length, 1)
  await agents.close()
})

test('releasing an Agent disposes its mount and closes its watcher', async () => {
  const host = harness()
  host.roster({ servers: [server('a')], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const agent: FakeAgent = { id: 'one', cwd: '/repo' }
  await agents.attach(agent)
  await agents.release(agent)
  assert.equal(host.record(agent)?.disposed, 1)
  assert.equal(host.watchers.get('/repo/.agents')?.closed, 1)
})

test('closing releases every Agent', async () => {
  const host = harness()
  host.roster({ servers: [server('a')], warnings: [] })
  const agents = new AgentRoster(host.deps)
  const first: FakeAgent = { id: 'one', cwd: '/one' }
  const second: FakeAgent = { id: 'two', cwd: '/two' }
  await agents.attach(first)
  await agents.attach(second)
  await agents.close()
  assert.equal(host.record(first)?.disposed, 1)
  assert.equal(host.record(second)?.disposed, 1)
})

test('a failing mount is contained and reported', async () => {
  const warnings: string[] = []
  const deps: AgentRosterDeps<FakeAgent> = {
    cwd: () => '/repo',
    watchDir: cwd => cwd,
    resolve: async () => ({ servers: [server('a')], warnings: ['bad entry'] }),
    mount: () => { throw new Error('boom') },
    watch: () => () => {},
    warn: message => { warnings.push(message) },
    info: () => {},
  }
  const agents = new AgentRoster(deps)
  await agents.attach({ id: 'one', cwd: '/repo' })
  assert.deepEqual(warnings, ['bad entry', 'sync failed: boom'])
  await agents.close()
})
