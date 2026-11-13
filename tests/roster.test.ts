import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolveRoster, rosterKey, type RosterInput } from '../src/roster.ts'

const defaults = { toolCallTimeoutMs: 60_000, closeTimeoutMs: 5_000 }

/** Build an input with the parts each test cares about. */
function input(overrides: Partial<RosterInput> = {}): RosterInput {
  return { cwd: '/work/repo', home: '/home/me', defaults, ...overrides }
}

test('reads a stdio server and defaults its cwd to the Session directory', () => {
  const result = resolveRoster(input({
    user: { mcpServers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } },
  }))
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(result.servers, [{
    name: 'memory',
    transport: 'stdio',
    origin: 'user',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    env: {},
    cwd: '/work/repo',
    toolCallTimeoutMs: 60_000,
    closeTimeoutMs: 5_000,
  }])
})

test('reads a Streamable HTTP server', () => {
  const result = resolveRoster(input({
    project: { mcpServers: { docs: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer ${credential:DOCS}' } } } },
  }))
  assert.deepEqual(result.servers, [{
    name: 'docs',
    transport: 'streamable-http',
    origin: 'project',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${credential:DOCS}' },
    toolCallTimeoutMs: 60_000,
    closeTimeoutMs: 5_000,
  }])
})

test('a project entry with the same name replaces the user entry', () => {
  const result = resolveRoster(input({
    user: { mcpServers: { gh: { command: 'npx', args: ['old'], env: { TOKEN: 'user' } } } },
    project: { mcpServers: { gh: { command: 'npx', args: ['new'] } } },
  }))
  assert.deepEqual(result.warnings, [])
  assert.equal(result.servers.length, 1)
  assert.equal(result.servers[0]?.origin, 'project')
  assert.deepEqual((result.servers[0] as { args: string[] }).args, ['new'])
  assert.deepEqual((result.servers[0] as { env: Record<string, string> }).env, {})
})

test('a project entry that only disables drops the user server', () => {
  const result = resolveRoster(input({
    user: { mcpServers: { gh: { command: 'npx' } } },
    project: { mcpServers: { gh: { enabled: false } } },
  }))
  assert.deepEqual(result.servers, [])
  assert.deepEqual(result.warnings, [])
})

test('a project entry that only disables an unknown name warns instead of failing', () => {
  const result = resolveRoster(input({
    user: { mcpServers: {} },
    project: { mcpServers: { ghost: { enabled: false } } },
  }))
  assert.deepEqual(result.servers, [])
  assert.match(result.warnings.join('\n'), /ghost.*no user file defines/)
})

test('a project entry mixing enabled with transport fields replaces wholesale', () => {
  const result = resolveRoster(input({
    user: { mcpServers: { gh: { command: 'npx', args: ['old'] } } },
    project: { mcpServers: { gh: { command: 'npx', args: ['new'], enabled: true } } },
  }))
  assert.deepEqual(result.warnings, [])
  assert.deepEqual((result.servers[0] as { args: string[] }).args, ['new'])
})

test('rejects the legacy SSE transport by name', () => {
  const result = resolveRoster(input({ user: { mcpServers: { old: { type: 'sse', url: 'https://x/sse' } } } }))
  assert.deepEqual(result.servers, [])
  assert.match(result.warnings.join('\n'), /legacy SSE/)
})

test('rejects an entry that declares both transports', () => {
  const result = resolveRoster(input({ user: { mcpServers: { x: { command: 'npx', url: 'https://x' } } } }))
  assert.deepEqual(result.servers, [])
  assert.match(result.warnings.join('\n'), /not both/)
})

test('rejects an entry with neither transport', () => {
  const result = resolveRoster(input({ user: { mcpServers: { x: {} } } }))
  assert.deepEqual(result.servers, [])
  assert.match(result.warnings.join('\n'), /needs "command"/)
})

test('rejects a name the client cannot namespace', () => {
  const result = resolveRoster(input({ user: { mcpServers: { 'bad name!': { command: 'npx' } } } }))
  assert.match(result.warnings.join('\n'), /\[A-Za-z0-9_-\]\{1,32\}/)
})

test('resolves cwd forms: default, relative, home, absolute', () => {
  const result = resolveRoster(input({
    user: {
      mcpServers: {
        a: { command: 'x', cwd: 'pkg/tools' },
        b: { command: 'x', cwd: '~/tools' },
        c: { command: 'x', cwd: '/opt/tools' },
        d: { command: 'x' },
      },
    },
  }))
  const byName = Object.fromEntries(result.servers.map(server => [server.name, (server as { cwd: string }).cwd]))
  assert.deepEqual(byName, {
    a: '/work/repo/pkg/tools',
    b: '/home/me/tools',
    c: '/opt/tools',
    d: '/work/repo',
  })
})

test('refuses a cwd that climbs out of the Session directory', () => {
  const result = resolveRoster(input({ user: { mcpServers: { x: { command: 'npx', cwd: '../elsewhere' } } } }))
  assert.match(result.warnings.join('\n'), /must not climb out/)
  assert.equal((result.servers[0] as { cwd: string }).cwd, '/work/repo')
})

test('per-entry budgets win over the configured defaults', () => {
  const result = resolveRoster(input({
    defaults: { toolCallTimeoutMs: 10, closeTimeoutMs: 20, startupTimeoutMs: 30 },
    user: { mcpServers: { x: { command: 'npx', toolCallTimeoutMs: 111, startupTimeoutMs: 222, closeTimeoutMs: 333 } } },
  }))
  const server = result.servers[0] as { toolCallTimeoutMs: number; startupTimeoutMs: number; closeTimeoutMs: number }
  assert.equal(server.toolCallTimeoutMs, 111)
  assert.equal(server.startupTimeoutMs, 222)
  assert.equal(server.closeTimeoutMs, 333)
})

test('defaults apply when an entry is silent', () => {
  const result = resolveRoster(input({
    defaults: { toolCallTimeoutMs: 10, closeTimeoutMs: 20, startupTimeoutMs: 30 },
    user: { mcpServers: { x: { command: 'npx' } } },
  }))
  const server = result.servers[0] as { toolCallTimeoutMs: number; startupTimeoutMs: number; closeTimeoutMs: number }
  assert.deepEqual(
    [server.toolCallTimeoutMs, server.startupTimeoutMs, server.closeTimeoutMs],
    [10, 30, 20],
  )
})

test('a malformed document warns and contributes nothing', () => {
  const result = resolveRoster(input({ user: { servers: {} } }))
  assert.deepEqual(result.servers, [])
  assert.match(result.warnings.join('\n'), /unknown top-level key "servers"/)
})

test('a non-object mcpServers value warns', () => {
  const result = resolveRoster(input({ user: { mcpServers: [] } }))
  assert.match(result.warnings.join('\n'), /"mcpServers" must be an object/)
})

test('servers are ordered by name so the key is stable', () => {
  const one = resolveRoster(input({ user: { mcpServers: { b: { command: 'x' }, a: { command: 'y' } } } }))
  const two = resolveRoster(input({ user: { mcpServers: { a: { command: 'y' }, b: { command: 'x' } } } }))
  assert.deepEqual(one.servers.map(server => server.name), ['a', 'b'])
  assert.equal(rosterKey(one.servers), rosterKey(two.servers))
})

test('an unchanged document yields an unchanged key', () => {
  const document = { mcpServers: { a: { command: 'x', args: ['1'] } } }
  assert.equal(
    rosterKey(resolveRoster(input({ user: document })).servers),
    rosterKey(resolveRoster(input({ user: document })).servers),
  )
})
