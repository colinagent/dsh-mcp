/**
 * Directory-scoped MCP servers for DeepSeek Harness.
 *
 * One `@deepseek-ai/dsh-mcp-client` instance per Agent, resolved from
 * `~/.agents/mcp.json` plus `<cwd>/.agents/mcp.json`. Mounting through
 * `agent.ctx` is what keeps the tools of one directory out of another Session:
 * `mcp-client` files its registrations under `scopeOf(ctx)`, and `agent.ctx` is
 * that Agent's scope. A preset row cannot do this — a preset composition is
 * mounted once per generation and shared by every Agent that selects it.
 *
 * @module @colinagent/dsh-mcp
 */

import { watch as watchPath } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Context, Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-working-directory'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { resolveRoster, type ResolvedServer } from './roster.ts'
import { AgentRoster, type MountedServers } from './sync.ts'

export { resolveRoster, rosterKey, SERVER_NAME_PATTERN } from './roster.ts'
export type { HttpServer, ResolvedServer, RosterInput, RosterResult, StdioServer } from './roster.ts'
export { AgentRoster } from './sync.ts'

/** Plugin name used by Cordis diagnostics. */
export const name = 'dsh-mcp'

/** Services this plugin cannot run without. */
export const inject = ['agents', 'workingDirectory']

/** Plugin configuration. */
export interface Config {
  /** User-level document; `~` is allowed. Defaults to `~/.agents/mcp.json`. */
  userFile?: string
  /** Project-level directory name, relative to the Session directory. Defaults to `.agents`. */
  projectDir?: string
  /** File name inside {@link Config.projectDir}. Defaults to `mcp.json`. */
  projectFile?: string
  /** Read the project-level document at all. Defaults to `true`; a repository's file runs commands. */
  scanProject?: boolean
  /** Re-resolve when a document changes. Defaults to `true`. */
  watch?: boolean
  /** Default per-call timeout for one server. Defaults to 60 000 ms. */
  toolCallTimeoutMs?: number
  /** Default budget for a server's first connection, in milliseconds. Unset waits indefinitely. */
  startupTimeoutMs?: number
  /** Default budget for closing one server's transport. Defaults to 5 000 ms. */
  closeTimeoutMs?: number
}

/** Configuration schema; the Loader validates a row's `config` against it. */
export const Config: z<Config> = z.object({
  userFile: z.string().description('User-level MCP document; `~` is allowed (default `~/.agents/mcp.json`).'),
  projectDir: z.string().default('.agents').description('Project-level directory name, relative to the Session directory.'),
  projectFile: z.string().default('mcp.json').description('File name inside the project directory.'),
  scanProject: z.boolean().default(true).description('Read the project-level document; a repository can run commands through it.'),
  watch: z.boolean().default(true).description('Re-resolve when either document changes.'),
  toolCallTimeoutMs: z.number().step(1).min(1).default(60_000).description('Default per-call timeout for one server.'),
  startupTimeoutMs: z.number().step(1).min(1).description('Default budget for a server\'s first connection.'),
  closeTimeoutMs: z.number().step(1).min(1).default(5_000).description('Default budget for closing one server\'s transport.'),
})

/** Resolved defaults, so `apply` also works for a direct (non-Loader) mount. */
interface Settings {
  userFile: string
  projectDir: string
  projectFile: string
  scanProject: boolean
  watch: boolean
  toolCallTimeoutMs: number
  startupTimeoutMs?: number
  closeTimeoutMs: number
}

/**
 * Mount the plugin: one roster per Host, one mount per Agent.
 * @param ctx - Host context; `agents` and `workingDirectory` come from `inject`.
 * @param config - the row's configuration, validated by {@link Config}.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const settings = resolveSettings(config)
  const home = homedir()

  const roster = new AgentRoster<Agent>({
    cwd: agent => ctx.workingDirectory.get(agent.session),
    watchDir: cwd => resolve(cwd, settings.projectDir),
    resolve: async (cwd) => {
      const [user, project] = await Promise.all([
        readDocument(settings.userFile, message => ctx.logger.warn(`dsh-mcp: ${message}`)),
        settings.scanProject
          ? readDocument(join(cwd, settings.projectDir, settings.projectFile), message => ctx.logger.warn(`dsh-mcp: ${message}`))
          : Promise.resolve(undefined),
      ])
      return resolveRoster({
        user,
        project,
        cwd,
        home,
        defaults: {
          toolCallTimeoutMs: settings.toolCallTimeoutMs,
          closeTimeoutMs: settings.closeTimeoutMs,
          ...(settings.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: settings.startupTimeoutMs }),
        },
      })
    },
    mount: (agent, servers) => mountAgent(ctx, agent, servers),
    watch: settings.watch
      ? (directory, onChange) => watchForChange(directory, onChange)
      : () => () => {},
    warn: message => ctx.logger.warn(`dsh-mcp: ${message}`),
    info: message => ctx.logger.info(`dsh-mcp: ${message}`),
  })

  for (const agent of ctx.agents.list()) void roster.attach(agent)
  ctx.on('agent/created', async ({ agent }) => { await roster.attach(agent) })
  ctx.on('agent/disposed', ({ agent }) => { void roster.release(agent) })
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'working-directory/change') return
    const agent = ctx.agents.get(session.id)
    if (agent !== undefined) void roster.sync(agent)
  })
  ctx.effect(() => async () => { await roster.close() }, 'dsh-mcp: roster')
}

/**
 * Mount one Agent's resolved servers as child plugins of its scope.
 * @param ctx - Host context, for diagnostics.
 * @param agent - the Agent whose scope owns the mount.
 * @param servers - resolved servers to mount.
 * @returns the teardown that unloads every child fiber.
 */
function mountAgent(ctx: Context, agent: Agent, servers: readonly ResolvedServer[]): MountedServers {
  const fibers: Fiber[] = []
  for (const server of servers) {
    const fiber = agent.ctx.plugin(McpClient, toClientConfig(server))
    fibers.push(fiber)
    // `mcp-client` blocks activation on the first connection, so awaiting here
    // would hold Agent creation hostage to a slow server. Its default policy
    // logs startup failures and keeps reconnecting instead of rejecting.
    void Promise.resolve(fiber).then(
      () => { ctx.logger.debug(`dsh-mcp: ${server.name} ready`) },
      (error: unknown) => { ctx.logger.warn(`dsh-mcp: ${server.name} failed: ${describe(error)}`) },
    )
  }
  return {
    dispose: async () => {
      for (const fiber of fibers.reverse()) {
        try {
          await fiber.dispose()
        } catch (error) {
          ctx.logger.warn(`dsh-mcp: disposing a server failed: ${describe(error)}`)
        }
      }
    },
  }
}

/**
 * Project one resolved server onto the `dsh-mcp-client` configuration.
 * @param server - the resolved server.
 * @returns the client configuration for one mount.
 */
function toClientConfig(server: ResolvedServer): McpClient.Config {
  const common = {
    serverName: server.name,
    toolCallTimeoutMs: server.toolCallTimeoutMs,
    closeTimeoutMs: server.closeTimeoutMs,
    expandTemplates: true,
    failOnStartupError: false,
    ...(server.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: server.startupTimeoutMs }),
  }
  if (server.transport === 'stdio') {
    return { ...common, transport: 'stdio', command: server.command, args: [...server.args], env: { ...server.env }, cwd: server.cwd }
  }
  return { ...common, transport: 'streamable-http', url: server.url, headers: { ...server.headers } }
}

/**
 * Fill in every default, so a direct mount behaves like a Loader row.
 * @param config - the caller's configuration.
 * @returns normalized settings.
 */
function resolveSettings(config: Config): Settings {
  return {
    userFile: expandHome(config.userFile ?? join(homedir(), '.agents', 'mcp.json')),
    projectDir: config.projectDir ?? '.agents',
    projectFile: config.projectFile ?? 'mcp.json',
    scanProject: config.scanProject ?? true,
    watch: config.watch ?? true,
    toolCallTimeoutMs: config.toolCallTimeoutMs ?? 60_000,
    closeTimeoutMs: config.closeTimeoutMs ?? 5_000,
    ...(config.startupTimeoutMs === undefined ? {} : { startupTimeoutMs: config.startupTimeoutMs }),
  }
}

/**
 * Expand a leading `~` and resolve to an absolute path.
 * @param path - configured path.
 * @returns an absolute path.
 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2))
  return resolve(path)
}

/**
 * Read and parse one JSON document.
 * @param path - absolute document path.
 * @param warn - diagnostic sink.
 * @returns the parsed value, or `undefined` when absent or unreadable.
 */
async function readDocument(path: string, warn: (message: string) => void): Promise<unknown> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') warn(`${path}: ${describe(error)}`)
    return undefined
  }
  try {
    return JSON.parse(text) as unknown
  } catch (error) {
    warn(`${path}: invalid JSON (${describe(error)})`)
    return undefined
  }
}

/**
 * Watch one directory for changes, coalescing bursts.
 * @param directory - directory to watch; must exist.
 * @param onChange - called after a quiet period.
 * @returns the disposer.
 */
function watchForChange(directory: string, onChange: () => void): () => void {
  let timer: NodeJS.Timeout | undefined
  const watcher = watchPath(directory, { persistent: false }, () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      onChange()
    }, 200)
    timer.unref()
  })
  watcher.on('error', () => { /* a directory that vanished is re-resolved on the next sync */ })
  watcher.unref()
  return () => {
    if (timer !== undefined) clearTimeout(timer)
    watcher.close()
  }
}

/** One-line error message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
