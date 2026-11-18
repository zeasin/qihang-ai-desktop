# 知识库 MCP（qihang-kb）使用说明

> 本机知识库 MCP 服务把「启航AI工作台」里沉淀的知识资产以标准 MCP 工具暴露给外部 AI 工具（Claude Code / Codex / Trae / opencode / ZCode 等），也自动注入应用内对话。
>
> 设计稿与决策记录见 [知识库MCP设计方案.md](./知识库MCP设计方案.md)。

## 1. 它能查什么

| 数据来源 | 内容 | 索引方式 |
|---|---|---|
| 笔记库 | 各「笔记」类型项目下的 `.md` 文件 | `kb_note_fts`（FTS5 trigram，中文免分词） |
| 外部 AI 会话 | 雷达已采集的 Claude Code / Codex / Trae / Qoder / opencode / DSH / pi 会话与 AI 摘要 | `radar.db` 只读（消息级 FTS + 会话标题/摘要） |
| 应用内对话 | 工作台自己的对话消息 | `chat_message_fts`（触发器自动同步） |
| 日报/周报/模块分析 | `ai_analysis` 表 | `LIKE` 检索 |

工具全部**只读**，不提供写入能力。

## 2. 启动与配置

- 默认随应用启动：`config.json` 中 `kbMcpEnabled !== "0"` 即启用。
- 监听地址固定 `127.0.0.1`，端口默认 `8792`（`kbMcpPort` 可改）。**不要做端口映射/公网暴露**。
- 鉴权：`Authorization: Bearer <kbMcpToken>`。首次启动自动生成 token，写入 `config.json` 的 `kbMcpToken`。
- 管理入口：MCP 页顶部「本机知识库服务」卡片，可查看状态/端口/已索引篇数、复制或重置 Token、启停服务、重建笔记索引。

相关配置键：

| 键 | 默认 | 说明 |
|---|---|---|
| `kbMcpEnabled` | `"1"` | `"0"` 关闭 |
| `kbMcpPort` | `"8792"` | 仅本机监听 |
| `kbMcpToken` | `""` | 为空时首次启动自动生成 |

## 3. 工具说明

### `search` —— 统一检索

| 参数 | 说明 |
|---|---|
| `query` | 检索词，中英文均可；少于 3 字符时笔记只匹配标题 |
| `scope` | `all`（默认）/ `notes` / `sessions` / `chat` / `reports` |
| `agent` | 仅 sessions：按工具过滤（`claude`、`codex`、`trae`、`qoder`、`opencode`、`dsh`、`pi`） |
| `days` | 只检索最近 N 天 |
| `limit` | 每个数据源返回上限，默认 10，最大 50 |

返回统一信封：

```json
{
  "scope": "all",
  "total": 2,
  "records": [
    { "source": "note", "ref": "D:/notes/SQL/索引.md", "title": "索引", "snippet": "…", "updated_at": "2026-11-17 21:04" },
    { "source": "session", "ref": "radar:claude-code:abc123", "tool": "claude-code", "title": "优化雷达摘要", "snippet": "…", "state": "idle", "updated_at": "2026-11-17 20:30" }
  ]
}
```

### `get_note(path)`

读笔记全文。`path` 传 `search` 返回的 `ref`（绝对路径），或「项目名/相对路径」。只允许读笔记项目根下的 `.md`；超过 100k 字符截断并标 `truncated`。

### `list_notes(project?, limit?)`

无参返回全部笔记项目及篇数；传 `project` 返回该项目 `.md` 清单（默认 200 条，`has_more` 标识是否截断）。推荐先 list 再 search/get_note。

### `get_session(session_id, messages?)`

读取外部 AI 会话元信息与 AI 摘要；`messages > 0` 时附最近 N 条消息（上限 200）。`session_id` 取 `search` 结果 `ref` 里 `radar:<tool>:<id>` 的 `<id>` 部分。

### `recent_activity(days?, limit?)`

最近 N 天（默认 7）活跃的外部 AI 会话（含摘要截断）与最近生成的日报周报。

## 4. 各客户端接入

地址均为 `http://127.0.0.1:8792/mcp`，token 从 MCP 页卡片复制。

**Claude Code**（项目根 `.mcp.json`）

```json
{
  "mcpServers": {
    "qihang-kb": {
      "type": "http",
      "url": "http://127.0.0.1:8792/mcp",
      "headers": { "Authorization": "Bearer <kbMcpToken>" }
    }
  }
}
```

或 CLI：`claude mcp add --transport http qihang-kb http://127.0.0.1:8792/mcp`

**Codex**（`~/.codex/config.toml`）

```toml
[mcp_servers.qihang-kb]
url = "http://127.0.0.1:8792/mcp"
http_headers = { "Authorization" = "Bearer <kbMcpToken>" }
```

**opencode**（项目根 `opencode.json`）

```json
{
  "mcp": {
    "qihang-kb": {
      "type": "remote",
      "url": "http://127.0.0.1:8792/mcp",
      "headers": { "Authorization": "Bearer <kbMcpToken>" },
      "enabled": true
    }
  }
}
```

**Trae**（项目根 `.trae/mcp.json`；若版本不支持 headers，在界面里填 token）

```json
{
  "mcpServers": {
    "qihang-kb": { "url": "http://127.0.0.1:8792/mcp" }
  }
}
```

**应用内对话**：无需配置。服务运行中时自动注入，工具以 `mcp__qihang_kb__search` 等名称出现。

## 5. 手工验证（curl）

```bash
# 开发模式在项目根 config.json；安装版在 ~/.qihang-ai-desktop/config.json
TOKEN=$(node -e "console.log(require('./config.json').kbMcpToken)")

# initialize
curl -s http://127.0.0.1:8792/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# tools/list
curl -s http://127.0.0.1:8792/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# tools/call
curl -s http://127.0.0.1:8792/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"FTS5 索引","scope":"notes","limit":5}}}'
```

注意：`Accept` 必须同时包含 `application/json` 和 `text/event-stream`，否则 SDK 返回 `Not Acceptable`。

## 6. 索引维护

- **笔记**：启动时差量同步（按文件 `size + mtime` 比对）；运行中 `fs.watch` 监听笔记项目目录，1.5s 防抖后只重索引变化的 `.md`；MCP 页「重建索引」可强制全量重建。watcher 失效不影响正确性，启动同步与手动重建兜底。
- **应用内对话**：建表后首次启动后台 `rebuild` 一次；之后新消息由 `prj_messages` 触发器自动进索引，应用层零维护。
- **外部会话**：直接只读复用雷达库，无需额外索引；雷达库不存在时会话类结果为空，其余工具正常。

## 7. 常见问题

**Q：MCP 连不上 / 返回 401？**
先看 MCP 页卡片是否「运行中」，再确认 Token 与客户端配置一致。重置 Token 后所有已接入客户端都要更新。

**Q：搜索不到刚写的笔记？**
确认该笔记属于 `prj_projects(type='note')` 的笔记项目且是 `.md`；等待 1.5s 防抖，或点「重建索引」。

**Q：应用关闭后外部 AI 还能用吗？**
不能。服务随应用进程启动/停止，这是当前产品的取舍。

**Q：会不会把对话里的密钥泄露出去？**
服务只绑 `127.0.0.1` 且有 Bearer token；不要把端口映射到公网。检索结果按条截断返回，不会整库导出。
