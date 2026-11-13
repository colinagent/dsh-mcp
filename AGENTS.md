# dsh-mcp

按工作目录生效的 MCP server 加载器：`~/.agents/mcp.json` 给全机，`<cwd>/.agents/mcp.json` 给当前目录。装在 Host 顶层，按 Agent 分发挂载，`/cwd` 之后自动换一批。

## 它是什么，不是什么

- **一个 DSH bundle 插件**，`dsh plugin --profile <name> add @colinagent/dsh-mcp` 装上，一行 `dsh-mcp` 在 Host 顶层。
- **per-Agent 挂载**：每个 Agent 用 `agent.ctx.plugin(McpClient, config)` 挂自己的 `@deepseek-ai/dsh-mcp-client`。`mcp-client` 用 `scopeOf(ctx)` 决定注册归属，所以工具只进该 Agent 的层。preset 里挂不到这个效果：preset 组合按 generation 只挂一次，被该 generation 的所有 Agent 共用。
- **不重新实现 MCP**：连接、重连、工具发现、资源读取、审批全部是 DSH 的 `mcp-client`；这里只做文件扫描、合并、挂载与生命周期。
- 不改、不 patch DSH；`~/code/refs/deepseek-harness` 是只读参考。

## 命令

```bash
node --test "tests/*.test.ts"   # 27 个用例：合并/覆盖/校验/cwd 解析 + 每 Agent 同步
bun run typecheck
bun run build                   # dist/plugin.mjs（bun bundle，@deepseek-ai/* 保持 external）
```

需要 Node ≥ 22.6（测试用 `node --test` 直接跑 TS）。`dist/` 不进版本库。

## 目录

| 路径 | 职责 |
|---|---|
| `src/index.ts` | Cordis 接线：读文件、挂 `agent.ctx`、监听 `agent/created` / `agent/disposed` / `working-directory/change`、`fs.watch` |
| `src/roster.ts` | 纯函数：两份文档 → 每个 Session 要挂的 server 列表；合并、覆盖、校验、cwd 解析 |
| `src/sync.ts` | 每 Agent 的挂载账本：解析结果不变就不重挂、cwd 变了重建、Agent 释放就卸载 |
| `tests/` | 上述两个模块的用例，全部注入假实现，不碰真 Host |
| `examples/mcp.json` | 两份文件的示例内容 |

## 三个不显然的点

1. **用户级 server 也是 per-Agent 挂载**，不是挂一个全局实例。只有这样才能让项目文件里的 `{"enabled": false}` 在该目录下真的关掉一个全局 server；代价是每个活着的 Agent 各开一份连接。
2. **`mcp-client` 的连接在 `apply` 里 await**，所以这里 `ctx.plugin()` 之后**不 await**：等它会拖住 `agent/created`（serial 监听）和 Agent 的第一次提问。默认 `failOnStartupError: false`，启动失败只记日志并继续重连。
3. **scope 归属靠 `scopeOf(ctx)`**，所以必须挂在 `agent.ctx` 下；挂在 Host ctx 下就变成"所有会话可见"，挂在 preset 里就是"该 preset 全部 Agent 可见"。

## 约定

- 项目根就是 Session 的工作目录，不做 `.git` 祖先回溯：`/cwd` 是精确值，回溯会和"会话在哪个目录"打架。
- `cwd` 相对值按 Session 目录解析，拒绝 `..`；省略时用 Session 目录（MCP server 默认在仓库里跑）。
- 坏条目只 warn 并跳过，绝不让 Agent 创建失败。
- 项目文件是不可信输入：它启动进程。`scanProject: false` 是唯一的门，README 里写清楚了。
- 许可 MIT。呼啦啦私有仓不复制这里的源码，只引用 npm 包。
- 文档双语：`README.md` 是英文（也是 npm 页面），`docs/README.zh-CN.md` 是中文，两份同步改。
