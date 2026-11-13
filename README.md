# @colinagent/dsh-mcp

Directory-scoped MCP servers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A workspace only gets the servers it declares, and switching a Session's directory switches its servers.

English | [简体中文](https://github.com/colinagent/dsh-mcp/blob/main/docs/README.zh-CN.md)

---

## Why

DSH scopes MCP by Cordis scope: one profile row is visible to the whole Host, one agent-preset row is visible to every Agent that selects that preset, and `@deepseek-ai/dsh-mcp-manager` governs the same global plane. Nothing reads a configuration from the directory you are actually working in, so a repository's own MCP server either lives in the global config or does not exist.

This plugin adds that layer:

- `~/.agents/mcp.json` — servers for every Session on the machine;
- `<cwd>/.agents/mcp.json` — servers for Sessions working in that directory.

The entry shape is the `mcpServers` map other MCP clients already use, so an existing Claude Code or pi entry moves over unchanged.

## Install

```sh
dsh plugin --profile <name> add @colinagent/dsh-mcp
```

The package is a DSH bundle: it installs one Host-level row and mounts `@deepseek-ai/dsh-mcp-client` once per Agent. `@deepseek-ai/dsh-*` packages are peers, so the profile keeps a single copy of the harness services. Remove it with `dsh plugin --profile <name> remove @colinagent/dsh-mcp`.

Restart the Host after installing — plugin installation is not hot-reloaded. Editing the two JSON documents is: they are re-read on change, on Session creation, and on `/cwd`.

## Configure

`~/.agents/mcp.json` — personal servers, any directory:

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }
  }
}
```

`<cwd>/.agents/mcp.json` — this repository only:

```json
{
  "mcpServers": {
    "repo-graph": { "command": "npx", "args": ["-y", "some-code-graph-mcp", "--root", "."] },
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer ${credential:DOCS_TOKEN}" }
    },
    "memory": { "enabled": false }
  }
}
```

| Field | Meaning |
|---|---|
| `command` / `args` / `env` / `cwd` | stdio server. `cwd` defaults to the Session directory; a relative value resolves against it and may not climb out with `..`. |
| `url` / `headers` | Streamable HTTP server. |
| `enabled` | `false` keeps the entry but mounts nothing. |
| `type` | Optional: `stdio`, `http`, `streamable-http`. The legacy `sse` transport is refused; most such servers also serve `/mcp`. |
| `toolCallTimeoutMs` / `startupTimeoutMs` / `closeTimeoutMs` | Per-server overrides of the plugin defaults. |

The entry key is the tool namespace — tools appear as `mcp__<name>__<tool>` — so it must match `[A-Za-z0-9_-]{1,32}`.

`${credential:REF}` resolves through the profile's credentials provider (`dsh-credentials-local` in the shipped bundles), so a token lives in `$DSH_HOME/.credentials.yaml`, not in the file you commit. A literal token in a project file is a token you will leak.

### Merge rules

- A project entry that declares `command`, `url`, or `type` **replaces** the user entry with the same name.
- A project entry that declares only `enabled` toggles the inherited entry — that is how one repository turns a global server off.
- A malformed entry is reported and skipped; it never blocks a Session, and every other entry in the same file still mounts.

## How the scoping works

`@deepseek-ai/dsh-mcp-client` files its tool and prompt registrations under `scopeOf(ctx)`, the scope of the context it was mounted in. This plugin mounts one client instance per Agent through `agent.ctx`, so:

- a Session sees only its own directory's servers, even while other Sessions run elsewhere;
- `/cwd` (or the `working_directory` tool) unmounts the old directory's servers and mounts the new ones;
- the Agent's disposal closes its transports, including `npx` wrappers.

A preset row cannot do this: a preset composition is mounted once per generation and shared by every Agent that selects it.

## Plugin configuration

| Field | Default | Meaning |
|---|---|---|
| `userFile` | `~/.agents/mcp.json` | User-level document. |
| `projectDir` | `.agents` | Project-level directory, relative to the Session directory. |
| `projectFile` | `mcp.json` | Project-level file name. |
| `scanProject` | `true` | Set `false` to ignore every repository's file. |
| `watch` | `true` | Re-resolve when either document changes. |
| `toolCallTimeoutMs` | `60000` | Default per-call timeout. |
| `startupTimeoutMs` | unset | Default first-connection budget; unset waits indefinitely. |
| `closeTimeoutMs` | `5000` | Default transport close budget. |

```yaml
- id: dsh-mcp
  name: '@colinagent/dsh-mcp'
  config:
    scanProject: false
```

## Security

A repository's `.agents/mcp.json` starts processes. Treat it like a `Makefile` in a fresh clone: read it before you open a Session there, or install with `scanProject: false`. There is no per-directory trust prompt — that switch is the boundary. Servers run with the Host user's permissions, and their tool calls pass through the ordinary DSH tool pipeline, including permission rules and approvals.

## Limits

- Only the Host's local filesystem is read. A remote workspace whose directory holds `.agents/mcp.json` will not see it, and nothing is reported when that happens.
- Each live Agent owns its own connections: ten concurrent Sessions using the same user-level server spawn ten processes. A Session with no servers of its own stays empty.
- The Session directory is used as-is; there is no `.git`-root or monorepo-subproject walk. `/cwd` is the exact answer to "which directory".
- `serverName` may be reused across Agents, and tool names carry only that name: the same key pointed at two different servers across directories looks identical in history.

## Development

```sh
node --test "tests/*.test.ts"   # merge, validation, and per-Agent sync rules
bun run typecheck
bun run build                   # dist/plugin.mjs
```

Requires Node ≥ 22.6. Tests run against injected fakes — no Host, no network, no MCP server.

## License

MIT.
