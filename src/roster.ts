/**
 * Turn the two `.agents/mcp.json` documents into the server list one Agent mounts.
 *
 * This module is pure: no filesystem, no network, no Cordis. `src/index.ts` reads
 * the files and mounts what this returns; keeping the rules here is what makes
 * merge, override, and validation behavior testable without a Host.
 *
 * @module roster
 */

/** Transport-specific facts for one stdio server. */
export interface StdioServer {
  name: string
  transport: 'stdio'
  origin: 'user' | 'project'
  command: string
  args: string[]
  env: Record<string, string>
  /** Absolute working directory for the child process. */
  cwd: string
  toolCallTimeoutMs: number
  startupTimeoutMs?: number
  closeTimeoutMs: number
}

/** Transport-specific facts for one Streamable HTTP server. */
export interface HttpServer {
  name: string
  transport: 'streamable-http'
  origin: 'user' | 'project'
  url: string
  headers: Record<string, string>
  toolCallTimeoutMs: number
  startupTimeoutMs?: number
  closeTimeoutMs: number
}

/** One server a Session should mount. */
export type ResolvedServer = StdioServer | HttpServer

/** Resolution inputs. */
export interface RosterInput {
  /** Parsed `~/.agents/mcp.json`, or `undefined` when it does not exist. */
  user?: unknown
  /** Parsed `<cwd>/.agents/mcp.json`, or `undefined` when it does not exist. */
  project?: unknown
  /** The Session's effective working directory. */
  cwd: string
  /** Home directory used for `~` expansion. */
  home: string
  /** Per-server defaults applied when the entry omits the field. */
  defaults: {
    toolCallTimeoutMs: number
    closeTimeoutMs: number
    startupTimeoutMs?: number
  }
}

/** Resolution result: what to mount, and what to tell the user. */
export interface RosterResult {
  servers: ResolvedServer[]
  warnings: string[]
}

/** `serverName` accepted by `@deepseek-ai/dsh-mcp-client`. */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** Fields that declare a transport, so a same-name project entry replaces the user entry. */
const TRANSPORT_FIELDS = ['command', 'url', 'type'] as const

/**
 * Resolve the merged server list for one Session.
 * @param input - both documents, the Session directory, and the applied defaults.
 * @returns servers sorted by name, plus one warning per skipped or suspicious entry.
 */
export function resolveRoster(input: RosterInput): RosterResult {
  const warnings: string[] = []
  const user = collect(input.user, 'user', warnings)
  const project = collect(input.project, 'project', warnings)
  const merged = new Map(user)
  for (const [name, sourced] of project) {
    const raw = sourced.entry
    const base = merged.get(name)
    const declaresTransport = TRANSPORT_FIELDS.some(field => raw[field] !== undefined)
    if (declaresTransport) {
      merged.set(name, sourced)
      continue
    }
    const keys = Object.keys(raw)
    const onlyEnabled = keys.every(key => key === 'enabled')
    if (!onlyEnabled) {
      warnings.push(`"${name}": a project entry without command/url only overrides "enabled"; ignored keys: ${keys.filter(key => key !== 'enabled').join(', ')}`)
      continue
    }
    if (raw.enabled === undefined) {
      warnings.push(`"${name}": a project override needs "enabled"`)
      continue
    }
    if (base === undefined) {
      warnings.push(`"${name}": the project override disables a server no user file defines`)
      continue
    }
    if (raw.enabled) {
      warnings.push(`"${name}": the project override re-enables a server the user file already enables; removed it instead`)
    }
    // The override is an enable switch on the inherited definition, so origin
    // stays with the file that actually declared the transport.
    merged.set(name, { entry: { ...base.entry, enabled: raw.enabled }, origin: base.origin })
  }

  const servers: ResolvedServer[] = []
  for (const [name, sourced] of merged) {
    const resolved = resolveOne(name, sourced, input, warnings)
    if (resolved !== undefined) servers.push(resolved)
  }
  servers.sort((left, right) => left.name.localeCompare(right.name))
  return { servers, warnings }
}

/** Stable key for "the resolved list did not change"; used to skip needless remounts. */
export function rosterKey(servers: readonly ResolvedServer[]): string {
  return JSON.stringify(servers)
}

/**
 * Read one document's `mcpServers` map.
 * @param document - parsed JSON, or `undefined`.
 * @param origin - which file, for messages.
 * @param warnings - collected diagnostics.
 * @returns entries in document order.
 */
function collect(document: unknown, origin: 'user' | 'project', warnings: string[]): Map<string, Sourced> {
  const entries = new Map<string, Sourced>()
  if (document === undefined) return entries
  if (document === null || typeof document !== 'object') {
    warnings.push(`${origin} file: the document must be an object with "mcpServers"`)
    return entries
  }
  const record = document as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'mcpServers') warnings.push(`${origin} file: unknown top-level key "${key}"`)
  }
  const servers = record.mcpServers
  if (servers === undefined) return entries
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
    warnings.push(`${origin} file: "mcpServers" must be an object`)
    return entries
  }
  for (const [name, value] of Object.entries(servers as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      warnings.push(`${origin} file: "${name}" must be an object`)
      continue
    }
    entries.set(name, { entry: value as RawEntry, origin })
  }
  return entries
}

/** One entry as written in a document. */
type RawEntry = Record<string, unknown> & { enabled?: unknown }

/** One entry plus the file it came from. */
interface Sourced {
  entry: RawEntry
  origin: 'user' | 'project'
}

/**
 * Validate one merged entry.
 * @returns the resolved server, or `undefined` when it is disabled or invalid.
 */
function resolveOne(name: string, sourced: Sourced, input: RosterInput, warnings: string[]): ResolvedServer | undefined {
  const raw = sourced.entry
  if (!SERVER_NAME_PATTERN.test(name)) {
    warnings.push(`"${name}": the server name must match [A-Za-z0-9_-]{1,32}`)
    return undefined
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    warnings.push(`"${name}": "enabled" must be a boolean`)
    return undefined
  }
  if (raw.enabled === false) return undefined

  const declared = readString(name, raw, 'type', warnings)
  if (declared !== undefined && !['stdio', 'http', 'streamable-http'].includes(declared)) {
    warnings.push(declared === 'sse'
      ? `"${name}": the legacy SSE transport is unsupported; most servers also serve Streamable HTTP at "/mcp"`
      : `"${name}": "type" must be "stdio", "http", or "streamable-http"`)
    return undefined
  }
  const command = readString(name, raw, 'command', warnings)
  const url = readString(name, raw, 'url', warnings)
  if (command !== undefined && url !== undefined) {
    warnings.push(`"${name}": declare either "command" (stdio) or "url" (Streamable HTTP), not both`)
    return undefined
  }
  if (command === undefined && url === undefined) {
    warnings.push(`"${name}": needs "command" (stdio) or "url" (Streamable HTTP)`)
    return undefined
  }
  if (declared === 'stdio' && command === undefined) {
    warnings.push(`"${name}": "type: stdio" needs "command"`)
    return undefined
  }
  if ((declared === 'http' || declared === 'streamable-http') && url === undefined) {
    warnings.push(`"${name}": "type: ${declared}" needs "url"`)
    return undefined
  }

  const budget = {
    toolCallTimeoutMs: readTimeout(name, raw, 'toolCallTimeoutMs', warnings) ?? input.defaults.toolCallTimeoutMs,
    closeTimeoutMs: readTimeout(name, raw, 'closeTimeoutMs', warnings) ?? input.defaults.closeTimeoutMs,
    ...startupTimeout(name, raw, input, warnings),
  }

  if (command !== undefined) {
    const args = readStrings(name, raw, 'args', warnings) ?? []
    const env = readStringMap(name, raw, 'env', warnings) ?? {}
    const cwd = resolveCwd(name, readString(name, raw, 'cwd', warnings), input, warnings) ?? input.cwd
    return { name, transport: 'stdio', origin: sourced.origin, command, args, env, cwd, ...budget }
  }

  const headers = readStringMap(name, raw, 'headers', warnings) ?? {}
  return { name, transport: 'streamable-http', origin: sourced.origin, url: url as string, headers, ...budget }
}

/**
 * Resolve an entry's `cwd` to an absolute path.
 * @param name - entry name, for messages.
 * @param value - the declared `cwd`, if any.
 * @param input - Session directory and home directory.
 * @param warnings - collected diagnostics.
 * @returns an absolute path, or `undefined` when the value is invalid.
 */
function resolveCwd(name: string, value: string | undefined, input: RosterInput, warnings: string[]): string | undefined {
  if (value === undefined) return undefined
  if (value === '~') return input.home
  if (value.startsWith('~/')) return `${input.home}/${value.slice(2)}`
  if (value.startsWith('/')) return value
  const segments = value.split('/')
  if (segments.includes('..')) {
    warnings.push(`"${name}": "cwd" must not climb out of the Session directory; use an absolute path`)
    return undefined
  }
  return `${input.cwd}/${value === '.' ? '' : value}`.replace(/\/+$/u, '') || '/'
}

/** Read one optional string field. */
function readString(name: string, raw: RawEntry, field: string, warnings: string[]): string | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    warnings.push(`"${name}": "${field}" must be a non-empty string`)
    return undefined
  }
  return value
}

/** Read one optional string array field. */
function readStrings(name: string, raw: RawEntry, field: string, warnings: string[]): string[] | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    warnings.push(`"${name}": "${field}" must be an array of strings`)
    return undefined
  }
  return [...value] as string[]
}

/** Read one optional string map field. */
function readStringMap(name: string, raw: RawEntry, field: string, warnings: string[]): Record<string, string> | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    warnings.push(`"${name}": "${field}" must be an object of strings`)
    return undefined
  }
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item !== 'string') {
      warnings.push(`"${name}": "${field}.${key}" must be a string`)
      return undefined
    }
    result[key] = item
  }
  return result
}

/** Read one optional positive timeout in milliseconds. */
function readTimeout(name: string, raw: RawEntry, field: string, warnings: string[]): number | undefined {
  const value = raw[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    warnings.push(`"${name}": "${field}" must be a positive integer of milliseconds`)
    return undefined
  }
  return value
}

/** Per-entry `startupTimeoutMs` over the configured default, if either exists. */
function startupTimeout(
  name: string,
  raw: RawEntry,
  input: RosterInput,
  warnings: string[],
): { startupTimeoutMs?: number } {
  const declared = readTimeout(name, raw, 'startupTimeoutMs', warnings)
  const value = declared ?? input.defaults.startupTimeoutMs
  return value === undefined ? {} : { startupTimeoutMs: value }
}
