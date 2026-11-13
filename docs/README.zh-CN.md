# @colinagent/dsh-mcp

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 用的**按目录生效**的 MCP server 加载器：一个工作目录只拿到它自己声明的 server，`/cwd` 换目录就换一批。

[English](https://github.com/colinagent/dsh-mcp/blob/main/README.md) | 简体中文

---

## 为什么需要它

DSH 的 MCP 作用域是 Cordis scope：profile 里一行对**整个 Host** 可见，agent preset 里一行对该 preset 的**所有 Agent** 可见，`@deepseek-ai/dsh-mcp-manager` 管的也是同一个全局平面。没有任何一层去读"你当前所在的工作目录"，所以一个仓库专属的 MCP server，要么塞进全局配置，要么根本不存在。

这个插件补上那一层：

- `~/.agents/mcp.json` —— 全机每个 Session 都能用的 server；
- `<cwd>/.agents/mcp.json` —— 只在该目录下的 Session 生效的 server。

条目形状就是其他 MCP 客户端用的 `mcpServers`，现有 Claude Code / pi 条目可以原样搬过来。

## 安装

```sh
dsh plugin --profile <name> add @colinagent/dsh-mcp
```

这个包是 DSH bundle：装一行 Host 顶层 row，并按 Agent 分发挂载 `@deepseek-ai/dsh-mcp-client`。`@deepseek-ai/dsh-*` 都是 peerDependencies，profile 里不会出现第二份 harness 服务。卸载：`dsh plugin --profile <name> remove @colinagent/dsh-mcp`。

装完要重启 Host——插件安装不热重载。但两份 JSON 是热的：改动、新建 Session、`/cwd` 都会重新读。

## 配置

`~/.agents/mcp.json` —— 个人常备，任何目录：

```json
{
  "mcpServers": {
    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] }
  }
}
```

`<cwd>/.agents/mcp.json` —— 只给这个仓库：

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

| 字段 | 含义 |
|---|---|
| `command` / `args` / `env` / `cwd` | stdio server。`cwd` 默认是 Session 目录；相对路径按它解析，且不允许用 `..` 爬出去。 |
| `url` / `headers` | Streamable HTTP server。 |
| `enabled` | `false` 保留条目但不挂载。 |
| `type` | 可选：`stdio`、`http`、`streamable-http`。旧的 `sse` 传输直接拒绝——这类服务通常在 `/mcp` 上同时提供 Streamable HTTP。 |
| `toolCallTimeoutMs` / `startupTimeoutMs` / `closeTimeoutMs` | 单条目覆盖插件默认值。 |

条目 key 就是工具命名空间——工具名是 `mcp__<name>__<tool>`——所以必须匹配 `[A-Za-z0-9_-]{1,32}`。

`${credential:REF}` 走 profile 的 credentials provider（随发行版交付的 `dsh-credentials-local`），token 存在 `$DSH_HOME/.credentials.yaml`，不进你提交的文件。把明文 token 写进项目文件，等于已经泄露。

### 合并规则

- 项目条目只要声明了 `command`、`url` 或 `type`，就**整体替换**同名用户条目。
- 项目条目只声明 `enabled`，就是给继承来的条目拨开关——这是"这个仓库别用那个全局 server"的写法。
- 坏条目报一行 warning 后跳过，不会挡住 Session，同文件里其他条目照常挂载。

## 作用域是怎么做到的

`@deepseek-ai/dsh-mcp-client` 把工具与 prompt 注册在 `scopeOf(ctx)`——也就是它被挂载的那个 context 的 scope。这个插件对每个 Agent 用 `agent.ctx` 挂一份 client，于是：

- 一个 Session 只看见自己目录的 server，哪怕同一时刻别的 Session 在别的目录；
- `/cwd`（或 `working_directory` 工具）会卸载旧目录的 server、挂上新目录的；
- Agent 释放时关闭传输，包括 `npx` 包装出来的子进程。

挂在 preset 里做不到这件事：preset 的组合按 generation 只挂一次，被选用该 preset 的所有 Agent 共用。

## 插件配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `userFile` | `~/.agents/mcp.json` | 用户级文档。 |
| `projectDir` | `.agents` | 项目级目录，相对 Session 目录。 |
| `projectFile` | `mcp.json` | 项目级文件名。 |
| `scanProject` | `true` | 设为 `false` 就完全忽略仓库里的那份文件。 |
| `watch` | `true` | 文件变化时重新解析。 |
| `toolCallTimeoutMs` | `60000` | 默认单次调用超时。 |
| `startupTimeoutMs` | 未设 | 默认首次连接预算；不设则一直等。 |
| `closeTimeoutMs` | `5000` | 默认传输关闭预算。 |

```yaml
- id: dsh-mcp
  name: '@colinagent/dsh-mcp'
  config:
    scanProject: false
```

## 安全

仓库里的 `.agents/mcp.json` 会启动进程。把它当成陌生 clone 里的 `Makefile`：先读，再在这个目录开 Session；或者装的时候就设 `scanProject: false`。这里没有 per-directory 的信任确认——那个开关就是边界。Server 以 Host 用户的权限运行，它的工具调用走 DSH 普通的工具管线，权限规则与审批照常生效。

## 限制

- 只读 Host 本地文件系统。远程 workspace 目录里的 `.agents/mcp.json` 不会被读到，也不会报错。
- 每个活着的 Agent 各持一份连接：十个并发 Session 用同一个用户级 server，就是十个进程。自己没有任何 server 的 Session 不会多出进程。
- Session 目录就是答案，不做 `.git` 祖先回溯，也不挑 monorepo 子项目。`/cwd` 是精确值。
- `serverName` 允许在不同 Agent 间复用，而工具名只带这个 name：同一个 key 在两个目录指向不同服务时，历史记录里看起来一模一样。

## 开发

```sh
node --test "tests/*.test.ts"   # 合并、校验、每 Agent 同步的规则
bun run typecheck
bun run build                   # dist/plugin.mjs
```

需要 Node ≥ 22.6。测试全部跑在注入的假实现上：不需要 Host、不需要网络、不需要真的 MCP server。

## 许可

MIT。
