# @colinagent/dsh-mcp

Directory-scoped MCP servers for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a workspace only gets the servers it declares, and switching a Session's directory switches its servers.

DSH alone scopes MCP by Cordis scope — a profile row or an agent preset, both machine-wide. This plugin adds the layer users of other agents already expect: `~/.agents/mcp.json` for personal servers, `<cwd>/.agents/mcp.json` for one repository's servers.

## Install

```sh
dsh plugin --profile <name> add @colinagent/dsh-mcp
```

The package is a DSH bundle: it installs one Host-level row and mounts `@deepseek-ai/dsh-mcp-client` per Agent. `@deepseek-ai/dsh-*` packages are peers, so the profile keeps a single copy of the harness services.

## Configure

`~/.agents/mcp.json` — for every Session on the machine:

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }
  }
}
```

`<cwd>/.agents/mcp.json` — only for Sessions working in that directory:

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
| `command` / `args` / `env` / `cwd` | stdio server. `cwd` defaults to the Session directory; relative values resolve against it and may not use `..`. |
| `url` / `headers` | Streamable HTTP server. |
| `enabled` | `false` keeps the entry but mounts nothing. |
| `type` | Optional: `stdio`, `http`, `streamable-http`. The legacy `sse` transport is refused. |
| `toolCallTimeoutMs` / `startupTimeoutMs` / `closeTimeoutMs` | Per-server overrides of the plugin defaults. |

The entry key becomes the tool namespace: `mcp__<name>__<tool>`, so it must match `[A-Za-z0-9_-]{1,32}`.

`${credential:REF}` is resolved through the profile's credentials provider (`dsh-credentials-local` in the shipped bundles). Never commit a literal token to the project file.

### Merge rules

- A project entry that declares `command`, `url`, or `type` **replaces** the user entry with the same name.
- A project entry that declares only `enabled` toggles the inherited entry — that is how one repository turns a global server off.
- Both files are re-read when they change, when a Session is created, and when a Session changes directory. A resolved list that did not change is not remounted.

## How the scoping works

`@deepseek-ai/dsh-mcp-client` files its tool and prompt registrations under `scopeOf(ctx)`, the scope of the context it was mounted in. This plugin mounts one client instance per Agent through `agent.ctx`, so:

- a Session sees only its own directory's servers, even when other Sessions run elsewhere at the same time;
- `/cwd` (or `working_directory`) unmounts the old directory's servers and mounts the new ones;
- the Agent's disposal closes its MCP transports, including `npx` wrappers.

A preset row cannot do this: a preset composition is mounted once per generation and shared by every Agent that selects it.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `userFile` | `~/.agents/mcp.json` | User-level document. |
| `projectDir` | `.agents` | Project-level directory, relative to the Session directory. |
| `projectFile` | `mcp.json` | Project-level file name. |
| `scanProject` | `true` | Set `false` to ignore every repository's file. |
| `watch` | `true` | Re-resolve on file changes. |
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

A repository's `.agents/mcp.json` starts processes. Treat it like a `Makefile` in a fresh clone: read it before you run a Session there, or install with `scanProject: false`. There is no per-directory trust prompt; the switch is the boundary. Servers run with the Host user's permissions, and their tool calls pass through the ordinary DSH tool pipeline, including permission rules.

## Limits

- Only the Host's local filesystem is read. A remote workspace whose directory holds `.agents/mcp.json` will not see it.
- Each live Agent owns its own connections, so ten concurrent Sessions with the same user-level server spawn ten processes. Sessions without servers of their own stay empty.
- The Session directory is used as-is; there is no `.git`-root or monorepo-subproject walk.

## Development

```sh
node --test "tests/*.test.ts"   # merge, validation, and per-Agent sync rules
bun run typecheck
bun run build                   # dist/plugin.mjs
```

## License

GPL-3.0-only.
