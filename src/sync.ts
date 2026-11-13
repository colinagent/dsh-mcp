/**
 * Per-Agent mounting bookkeeping.
 *
 * `src/index.ts` owns Cordis wiring and the filesystem; this module owns the only
 * interesting invariant: one Agent mounts one resolved list, remounted when that
 * list changes or the Session's working directory moves, and released with the
 * Agent. Dependencies are injected so the invariant is testable without a Host.
 *
 * @module sync
 */

import { rosterKey, type ResolvedServer } from './roster.ts'

/** A live mount's teardown. */
export interface MountedServers {
  dispose(): Promise<void>
}

/** One resolved document read. */
export interface Resolution {
  servers: ResolvedServer[]
  warnings: string[]
}

/** Everything {@link AgentRoster} needs from its host. */
export interface AgentRosterDeps<Agent extends object> {
  /** Resolve both documents for one Session directory. */
  resolve(cwd: string): Promise<Resolution>
  /** Read the Session's effective working directory. */
  cwd(agent: Agent): string
  /** Mount one resolved list under the Agent's scope. */
  mount(agent: Agent, servers: readonly ResolvedServer[]): MountedServers
  /** Directory to watch for this Session; a change re-resolves the roster. */
  watchDir(cwd: string): string
  /** Watch one directory, returning its disposer. Failures are the caller's to swallow. */
  watch(dir: string, onChange: () => void): () => void
  /** Diagnostics; never fatal. */
  warn(message: string): void
  /** Mount outcome worth seeing in a log. */
  info(message: string): void
}

interface Entry {
  cwd: string
  key: string
  mounted: MountedServers
  unwatch?: () => void
}

/**
 * Keep one mount per Agent in step with its resolved roster.
 * @typeParam Agent - the host's Agent handle, opaque here.
 */
export class AgentRoster<Agent extends object> {
  private readonly entries = new Map<Agent, Entry>()
  private readonly queues = new Map<Agent, Promise<void>>()
  private closed = false
  private readonly deps: AgentRosterDeps<Agent>

  constructor(deps: AgentRosterDeps<Agent>) {
    this.deps = deps
  }

  /**
   * Mount an Agent for the first time, or re-resolve it.
   * @param agent - the Agent whose roster to settle.
   */
  async attach(agent: Agent): Promise<void> {
    await this.sync(agent)
  }

  /**
   * Re-resolve one Agent, serialized behind any in-flight work for it, and remount
   * only when the resolved list or the directory changed.
   * @param agent - the Agent to settle.
   */
  sync(agent: Agent): Promise<void> {
    const previous = this.queues.get(agent) ?? Promise.resolve()
    const next = previous.then(() => this.run(agent)).catch((error: unknown) => {
      this.deps.warn(`sync failed: ${describe(error)}`)
    })
    this.queues.set(agent, next)
    return next
  }

  /**
   * Unmount one Agent and forget it.
   * @param agent - the Agent being disposed.
   */
  async release(agent: Agent): Promise<void> {
    const pending = this.queues.get(agent)
    this.queues.delete(agent)
    if (pending !== undefined) await pending
    await this.teardown(agent)
  }

  /** Release every Agent; used when the plugin unloads. */
  async close(): Promise<void> {
    this.closed = true
    const agents = [...this.entries.keys()]
    await Promise.all(agents.map(agent => this.release(agent)))
  }

  /**
   * Resolve and reconcile one Agent.
   * @param agent - the Agent to settle.
   */
  private async run(agent: Agent): Promise<void> {
    if (this.closed) return
    const cwd = this.deps.cwd(agent)
    const resolution = await this.deps.resolve(cwd)
    for (const warning of resolution.warnings) this.deps.warn(warning)
    const key = rosterKey(resolution.servers)
    const current = this.entries.get(agent)
    if (current !== undefined && current.key === key && current.cwd === cwd) return
    await this.teardown(agent)
    if (this.closed) return

    const mounted = this.deps.mount(agent, resolution.servers)
    const entry: Entry = { cwd, key, mounted }
    try {
      entry.unwatch = this.deps.watch(this.deps.watchDir(cwd), () => {
        void this.sync(agent)
      })
    } catch (error) {
      this.deps.warn(`cannot watch ${this.deps.watchDir(cwd)}: ${describe(error)}`)
    }
    this.entries.set(agent, entry)
    if (resolution.servers.length > 0) {
      this.deps.info(`mounted ${resolution.servers.map(server => server.name).join(', ')} in ${cwd}`)
    }
  }

  /**
   * Dispose one Agent's mount and watcher.
   * @param agent - the Agent to unmount.
   */
  private async teardown(agent: Agent): Promise<void> {
    const entry = this.entries.get(agent)
    if (entry === undefined) return
    this.entries.delete(agent)
    try {
      entry.unwatch?.()
    } catch {
      // A watcher that refuses to close must not strand the servers.
    }
    try {
      await entry.mounted.dispose()
    } catch (error) {
      this.deps.warn(`unmount failed: ${describe(error)}`)
    }
  }
}

/** One-line error message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
