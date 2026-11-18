# 知识库 MCP（qihang-kb）设计方案

> 版本：v1 草案（2026-11-18）
> 状态：待评审，未开始实现
> 目标读者：维护者本人，供逐项研究后定稿

---

## 1. 背景与目标

### 1.1 背景

启航AI工作台已经积累了四类知识资产，但目前**只能在本应用内查看**，其他 AI 工具（Claude Code / Codex / opencode / Trae / ZCode 等）无法利用：

| 资产 | 存储位置 | 现状 |
|---|---|---|
| 智能体对话及摘要（雷达） | `~/.qihang-ai-desktop/radar/radar.db`（node:sqlite，WAL） | 持续采集外部 agent 会话；idle 收口后按价值分门槛生成摘要（`electron/radar/radar-digest.ts`）；消息级 FTS5 trigram 全文索引 `radar_message_fts` 已存在（`electron/radar/radar-db.ts:129-145`） |
| 日报 / 周报 / 模块分析 | 主库 `ai_analysis` 表（`electron/services/database.ts:116-127`） | 结构化入库，仅应用内展示 |
| 应用内对话消息 | 主库 `prj_messages` 表（`database.ts:45-56`） | 无索引、无摘要 |
| 笔记库 | 各 `prj_projects(type='note')` 项目指向的磁盘 .md 文件 | 无索引，`kb:search` 实时递归扫盘子串匹配（`electron/main.ts:855-904`） |

### 1.2 目标

1. 新建**本机知识库 MCP server**（`qihang-kb`），以上述语料为后端提供 5 个只读检索工具。
2. 外部 agent 通过注册该 MCP 即可检索"我笔记里写过什么 / 历史上 AI 们做过什么、结论是什么 / 日报周报说了什么"。
3. 本应用自己的 agent 会话也能消费同一套工具（经 `buildLoadedMcpConfig` 自动注入）。
4. 提供管理界面（SourcesView 内卡片）与接入文档。

### 1.3 非目标（明确不做）

- **不合并 mcp4j/ProjectMemory 共享记忆 MCP**。它是常驻云端服务（MySQL + Bearer token，11 个工具，读+写），把 always-on 服务包进按需启动的桌面应用是可用性倒挂。两者定位互补：共享记忆=写向的活跃上下文，知识库=读向的沉淀语料。组合发生在客户端侧（一个 agent 同时注册多个 MCP）。
- **不做公网暴露**。仅绑定 `127.0.0.1`，需要远程访问时未来走 frpc（仿 mobile 网关模式）。
- **第一版只读**。不提供任何写入工具，避免外部 agent 弄脏数据源。
- **不复活向量/embedding 路线**。`project-scan.ts:1` 注释已明确索引路线作废过一次；本方案只需全文检索，FTS5 trigram 足够（理由见 §4.1）。embedding（Ollama + bge-m3 遗留配置还在）留作后手。
- **不修改 pi agent 原生读写习惯**。本应用的笔记读写仍由 pi agent 用原生 read/bash 直接做，知识库工具是增量能力。

---

## 2. 总体架构

```
                      ┌──────────────────────────────────────────────┐
                      │        qihang-kb MCP server                  │
                      │        Electron 主进程内新模块 electron/kb/    │
   AI 客户端           │  node:http 监听 127.0.0.1:8792  仅路由 /mcp   │
                      │  官方 SDK McpServer + StreamableHTTP...      │
 Claude Code ──┐      │  Bearer token 鉴权（timingSafeEqual）         │
 Codex      ───┤      │                                              │
 opencode   ───┼──────┼─→ 5 个只读工具                                │
 Trae       ───┤      │      │                                       │
 ZCode      ───┘      │      ├─ search / get_note / list_notes        │
                      │      ├─ get_session / recent_activity        │
                      │      │                                       │
                      │  数据层（复用现有连接模式）                     │
                      │      ├─ kb_note_fts      主库 better-sqlite3  │
                      │      ├─ chat_message_fts 主库（触发器同步）    │
                      │      ├─ ai_analysis      主库 LIKE 检索       │
                      │      └─ RadarDb(readonly) radar.db（node:sqlite）│
                      └──────────────────────────────────────────────┘
                                     ↑
                      应用内 agent（pi SDK 会话）
                      经 buildLoadedMcpConfig 自动注入同一端点
```

### 2.1 传输层选型：官方 SDK + node:http 接线

- `@earendil-works/pi-mcp`（应用现有 MCP 客户端依赖）**只有 client 端**，无 server 实现（已核实 `node_modules/@earendil-works/pi-mcp/dist/index.d.ts` 全部导出）。
- `node_modules/@modelcontextprotocol/sdk@1.32.2` 已存在（`@google/genai` 的间接依赖），提供 `McpServer`（`dist/esm/server/mcp.d.ts:24`）与 `StreamableHTTPServerTransport`（`dist/esm/server/streamableHttp.d.ts:58`）。**方案：在 package.json 显式声明该依赖**后使用。
- SDK 是 ESM-only。主进程为 tsc 编译的 CJS，需沿用项目既有的动态 import 模式（`electron/services/mcp-manager.ts:56-70`、pi-agent loadSdk 同机制）：

```ts
const sdkMod = await new Function('s', 'return import(s)')('@modelcontextprotocol/sdk/server/mcp');
const trMod  = await new Function('s', 'return import(s)')('@modelcontextprotocol/sdk/server/streamableHttp');
```

- **stateless 模式**：`new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })`，每个 POST 请求新建 `McpServer + transport` pair，响应单个 JSON、无会话表、无悬挂 SSE 连接。工具注册是闭包工厂，per-request 创建成本低。若实测个别客户端不兼容，再切 per-session stateful 模式（SDK 文档标准模式，改动局部）。
- HTTP 骨架手写 `node:http`（与 approval/mobile 同风格）：只处理 `POST /mcp`（鉴权 → 解析 JSON body → `transport.handleRequest(req, res, body)`），`GET /mcp` 返回 405，`DELETE /mcp` 返回 200。

### 2.2 鉴权

仿 `electron/mobile/gateway.ts:108-114`：

- config 键 `kbMcpToken`；首次启动若为空，`crypto.randomBytes(32).toString('base64url')` 生成并 `saveConfig({ kbMcpToken })` 写回。
- 校验：`sha256(token)` 与配置值 sha256 做 `crypto.timingSafeEqual` 恒时比较；失败返回 401。
- token 在 UI 卡片中可查看/复制（与现有 MCP 数据源的 token 管理同级，存 config.json 明文是项目现状约定）。

### 2.3 配置键与生命周期

| 键 | 默认 | 说明 |
|---|---|---|
| `kbMcpEnabled` | `"1"` | `!== '0'` 即启用（模板写入 `"1"`，本功能即应用主打能力） |
| `kbMcpPort` | `"8792"` | 8790=审批、8791=移动网关之后顺延，已确认无占用 |
| `kbMcpToken` | `""`（自动生成） | Bearer token |

启动/停止完全仿 mobile gateway 模式（`electron/mobile/gateway.ts:720-797`）：

- `startKbMcpServer()` 返回结构化结果 `{ok, port, error?}` 而非 throw；`EADDRINUSE` 转中文提示"端口 xxx 已被占用"。
- `main.ts` `app.whenReady` 内 `getConfig('kbMcpEnabled') !== '0'` 时自启（仿 `main.ts:2383-2387` 的 mobile 自启写法）。
- `stopAllServices()`（`main.ts:248-255`）追加 `stopKbMcpServer()`（含 `server.close()` + `closeAllConnections()` + 关闭全部 fs.watch）；`before-quit`（`main.ts:2428-2433`）已调用 stopAllServices，无需另改。

---

## 3. 工具面定义

Server 名 `qihang-kb`，客户端侧工具全名形如 `mcp__qihang_kb__search`。共 5 个，全部只读。返回统一用 JSON 信封 `{ records: [...] }`（键名与 `mcp-manager.ts:320-342` 的 `parseToolResult` 识别的 `items|records|data|list|rows` 兼容，方便本应用直连消费）。

### 3.1 `search` —— 统一检索（核心工具）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `query` | string | 必填 | 检索词；中文/英文均可（trigram），<3 字符自动降级 LIKE |
| `scope` | `all`\|`notes`\|`sessions`\|`chat`\|`reports` | `all` | 数据源过滤 |
| `agent` | string | 可选 | 按 agent 工具过滤会话（radar 的 tool 列：claude/codex/zcode/…） |
| `days` | number | 可选 | 只搜最近 N 天 |
| `limit` | number | 10 | 每源返回上限 |

返回示例：

```json
{
  "records": [
    { "source": "note",    "ref": "richie_learning_notes/SQL/索引.md",
      "title": "索引", "snippet": "…trigram 索引对中文[友好]…", "updated_at": "2026-10-02", "score": -3.2 },
    { "source": "session", "ref": "radar:claude:<sessionId>",
      "title": "优化雷达摘要生成", "snippet": "…修改了 radar-digest.ts 的门槛逻辑…",
      "updated_at": "2026-11-17 21:04", "score": -5.1 },
    { "source": "chat",    "ref": "chat:<sessionId>:<rowid>", … },
    { "source": "report",  "ref": "analysis:<id>", "title": "日报 2026-11-17", … }
  ],
  "total": 12
}
```

数据源实现：

- **notes**：`kb_note_fts MATCH` + `snippet(kb_note_fts, 0, '', '…', …)` + `bm25` 排序（见 §4.2）；<3 字符时回退 `kb_note_docs.title` + 库内 LIKE。
- **sessions**：复用 `RadarDb.searchMessages(q, limit)`（`radar-db.ts:482-506`，FTS+bm25、<3 字符 LIKE 降级，返回已联好会话标题/工具/时间）与 `findSessions(q, limit)`（`:583-649`，会话级 FTS + 标题/路径 LIKE + 中文 2 字 shingle 兜底），按 sessionId 去重合并；`agent` 过滤映射到 radar 的 tool 列。
- **chat**：`chat_message_fts MATCH` 联 `prj_sessions.title`（§4.3）。
- **reports**：`ai_analysis` 按 `content LIKE` + `report_date` 排序，截断 200 字预览（个人量级无需索引）。

### 3.2 `get_note(path)`

读笔记全文。`path` 支持绝对路径或 `项目名/相对路径`（项目名匹配 `prj_projects(type='note')`）。复用 `notes:read` 的安全模式（`main.ts:837-851`）：resolve 后必须 `startsWith` 某笔记项目根，防越权；前 2048 字节含 `\0` 判二进制拒绝；>100k 字符截断并附说明。返回 `{ path, title, content }`。

### 3.3 `list_notes(project?, limit? = 200)`

- 无参：返回全部笔记项目 `{ name, dir, doc_count }`（doc_count 来自 `kb_note_docs` 计数）。
- 带参：返回该项目 md 文件相对路径列表（来自 `kb_note_docs`，非实时扫盘），超 limit 附 `hasMore`。

### 3.4 `get_session(session_id, messages? = 0)`

- 返回 radar 会话元信息 + 摘要：`{ tool, title, project_dir, state, msg_count, value_score, started_at, updated_at, summary }`。
- `messages > 0` 时附最近 N 条消息（复用 `RadarDb.getMessages`，`radar-db.ts:466`）。
- 需要 `radar-db.ts` 新增只读方法 `getSessionById(sessionId)`——现有 `getSession(tool, sessionId)`（`:282`）必须带 tool 参数，而 search 结果里 ref 已含 tool，但直接按 id 查更稳（radar_session 表 `session_id` 唯一性以 (tool, session_id) 为准，方法内做同 id 多 tool 行的处理）。

### 3.5 `recent_activity(days? = 7, limit? = 20)`

- radar 侧：`RadarDb.sessionsByRange(start, end, limit)`（`:447`，SessionRow 自带 summary），summary 截断 500 字。
- 侧栏附最近 `ai_analysis` 条目（type / module / report_date / 内容 200 字预览）。

### 3.6 工具描述语（写进 registerTool 的 description，供 agent 阅读）

工具描述会占每个接入 agent 的上下文，控制在 2-3 句，说清"什么时候调我"：例如 search —— "检索本地知识库：个人笔记、历史 AI 会话及摘要、应用内对话、日报周报。用户问'之前做过/研究过/记录过 X'时先调它。"

---

## 4. 索引设计

### 4.1 选型理由：FTS5 trigram

- 项目内已有成功先例：`radar_message_fts` 用 `tokenize='trigram'`（`radar-db.ts:129-131`），对**中文**（无分词需求）和代码标识符都友好。
- 主库 better-sqlite3 内置 SQLite **3.53.2**（已验证 `node_modules/better-sqlite3/deps/sqlite3/sqlite3.h`），远高于 trigram 所需的 3.34，FTS5 默认编译开启。
- 个人笔记 + 对话的量级（数千文件 / 数万消息）下 bm25 检索是毫秒级，无需 embedding。
- 吸取教训：上次索引路线作废（`project-scan.ts:1` 注释）的根因是**维护成本**，不是技术不可行。本方案的同步策略刻意保持极简（§4.4）。

### 4.2 表结构（主库 `database.ts` 的 `initSchema()` exec 块内新增）

```sql
-- 笔记元数据（防重复读盘、支持 list_notes/count）
CREATE TABLE IF NOT EXISTS kb_note_docs (
  id         INTEGER PRIMARY KEY,
  project_id INTEGER,            -- prj_projects.id
  rel_path   TEXT,               -- 相对项目根，如 'SQL/索引.md'
  abs_path   TEXT UNIQUE,        -- 绝对路径
  size       INTEGER,
  mtime_ms   INTEGER,
  title      TEXT,               -- 文件名去扩展名
  indexed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kb_note_docs_project ON kb_note_docs(project_id);

-- 笔记全文索引：整文件正文入库（个人量级可接受），单文件更新=删+插
CREATE VIRTUAL TABLE IF NOT EXISTS kb_note_fts USING fts5(
  content, abs_path UNINDEXED, tokenize='trigram'
);

-- 应用内对话：外部内容表 + 触发器自动同步（完全仿 radar_message_fts 模式）
CREATE VIRTUAL TABLE IF NOT EXISTS chat_message_fts USING fts5(
  content, content='prj_messages', content_rowid='rowid', tokenize='trigram'
);
CREATE TRIGGER IF NOT EXISTS prj_messages_ai AFTER INSERT ON prj_messages BEGIN
  INSERT INTO chat_message_fts(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS prj_messages_ad AFTER DELETE ON prj_messages BEGIN
  INSERT INTO chat_message_fts(chat_message_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
END;
CREATE TRIGGER IF NOT EXISTS prj_messages_au AFTER UPDATE ON prj_messages BEGIN
  INSERT INTO chat_message_fts(chat_message_fts, rowid, content)
  VALUES ('delete', old.rowid, old.content);
  INSERT INTO chat_message_fts(rowid, content) VALUES (new.rowid, new.content);
END;

-- 索引状态标记（回填是否完成、上次全量同步时间等）
CREATE TABLE IF NOT EXISTS kb_index_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
```

说明：`prj_messages` 的 FTS 只索引 `content` 列（不索引 images/thinking），只对 user/assistant 角色有意义的场景由查询侧按需联 role。radar 侧不加任何表，直接只读复用。

### 4.3 chat 回填

- 首次建表后一次性回填：`INSERT INTO chat_message_fts(rowid, content) SELECT rowid, content FROM prj_messages`，完成写 `kb_index_meta('chat_backfill_at', …)`。
- 回填放**启动后台异步**执行（不阻塞启动）；回填完成前 chat 范围的 search 返回部分结果或提示"索引构建中"。
- 新消息由触发器自动进索引，应用层零维护。

### 4.4 笔记同步策略（极简三保险）

新文件 `electron/kb/kb-index.ts`：

1. **启动差量同步** `syncNotes()`：遍历 `prj_projects(type='note')` 项目 → 复用 `project-scan.ts:43-60` 的 `walkMd`（已带 SYSTEM_IGNORED / 点目录跳过 / mtime）→ 与 `kb_note_docs` 按 `(abs_path, size, mtime_ms)` 比对：变化者读文件、`DELETE FROM kb_note_fts WHERE abs_path=?` + 重插；消失者清两表；项目被删则清该项目全部行。数千文件毫秒~秒级，启动后台执行。
2. **fs.watch 实时增量** `startWatchers()`：对每个笔记项目 `fs.watch(dir, {recursive: true})`，1.5s 防抖合并变更路径 → 只重索引受影响且扩展名为 .md 的文件。watcher 出错只记日志不重试风暴（启动扫描 + 手动按钮兜底）。全仓目前无任何 fs.watch 使用（已核实），这是第一处，保持无 chokidar 依赖。
3. **手动重建**：UI 按钮 → IPC `kbmcp:reindex` → `syncNotes(force=true)`，返回 `{notes_indexed, chat_indexed}` 计数。

摘要笔记说明：radar 摘要本身已落盘为笔记 `AI活动/会话/YYYY-MM-DD-<工具>-<标题>-<短id>.md`（`radar-note-save.ts:16,114`），因此笔记索引天然覆盖一份摘要文本，与 radar.db 的结构化 summary 是两份独立视图，不去重、互为兜底。

---

## 5. 文件改动清单

| # | 文件 | 动作 | 要点 |
|---|---|---|---|
| 1 | `package.json` | 改 | 显式声明 `@modelcontextprotocol/sdk: ^1.32.2`（当前为 @google/genai 间接依赖），`npm install` |
| 2 | `electron/kb/kb-server.ts` | 新 | node:http + SDK stateless 接线、Bearer 鉴权、`startKbMcpServer()/stopKbMcpServer()/kbServerStatus()`、token 自动生成 |
| 3 | `electron/kb/kb-tools.ts` | 新 | 5 个工具的 zod schema 与实现；deps 注入（仿 `approval/server.ts:27-61` 的依赖倒置，server 不直接 import 业务模块） |
| 4 | `electron/kb/kb-index.ts` | 新 | 笔记差量同步 + fs.watch + notes/chat/reports 检索辅助函数 |
| 5 | `electron/services/database.ts` | 改 | `initSchema()` 加 §4.2 的表/触发器；chat 回填任务入口 |
| 6 | `electron/radar/radar-db.ts` | 改 | 新增只读 `getSessionById(sessionId)` |
| 7 | `electron/main.ts` | 改 | whenReady 自启（仿 `:2383` mobile 模式）、`stopAllServices()`（`:248`）加 stop、注册 `kbmcp:status/setEnabled/regenToken/reindex` IPC |
| 8 | `electron/preload.ts` | 改 | `kbmcp` 命名空间 4 方法（仿现有 `notes:`/`kb:` 映射：`electronAPI.kbmcp.status()` ↔ `ipcMain.handle('kbmcp:status')`） |
| 9 | `electron/services/mcp-manager.ts` | 改 | `buildLoadedMcpConfig()`（`:265-280`）末尾：kb server 运行中时追加内置条目 `{ name:'qihang_kb', config:{ type:'http', url, headers:{Authorization}, exposure:'direct' }, source:'app-config', scope:'extension' }`；注意 kb-server 不 import mcp-manager，避免循环依赖 |
| 10 | `src/views/SourcesView.vue` | 改 | 顶部"本机知识库服务"卡片：状态灯 / 端口 / token 显示+复制 / 启停开关 / 重建索引按钮 / 已索引条数 |
| 11 | `config.json.template` | 改 | 加 `kbMcpEnabled:"1"`、`kbMcpPort:"8792"`、`kbMcpToken:""` |
| 12 | `docs/知识库MCP.md` | 新 | 使用向文档：接入配置示例（本文件 §附录可迁入）、工具说明 |
| 13 | `docs/更新日志.md` | 改 | 记录本次变更（仓库惯例） |

复用清单（不重写，直接引用）：

- `RadarDb.searchMessages / findSessions / sessionsByRange / getMessages / getSession`（`radar-db.ts:482/583/447/466/282`）
- `walkMd` + `SYSTEM_IGNORED`（`project-scan.ts:43/15`）
- 路径安全与二进制检测模式（`main.ts:837-851`）
- 恒时比较鉴权（`mobile/gateway.ts:99-114`）、EADDRINUSE 结构化返回（`gateway.ts:748-768`）
- 动态 ESM import（`mcp-manager.ts:56-70`）
- 只读 RadarDb 连接模式（`agent-radar.ts:317`）：kb 模块自建 `new RadarDb(radarDataDir(), { readonly: true })`（`radarDataDir` 在 `radar/radar-config.ts:30`）；radar.db 不存在时工具优雅降级（返回空 + 说明），不阻塞其余工具。

---

## 6. 分步实现顺序

1. **依赖**：package.json 加 SDK → `npm install`（确认 lock 变化、无 peer 冲突）。
2. **Schema**：database.ts 加表/触发器/回填入口（先用一条手插消息验证触发器生效）。
3. **kb-index.ts**：syncNotes（差量）+ 检索辅助 + 单元级自测（node 脚本直调）。
4. **kb-tools.ts**：5 个工具实现 + radar-db 补 `getSessionById`。
5. **kb-server.ts**：http server + SDK 接线 + 鉴权；curl 握手通过。
6. **接线**：main.ts 生命周期 + IPC + preload。
7. **mcp-manager 内置注入**：应用内 agent 获得 `mcp__qihang_kb__*`。
8. **UI**：SourcesView 卡片。
9. **文档**：docs/知识库MCP.md + 更新日志。

每步可独立编译验证（`npm run compile:electron`），降低联调风险。

---

## 7. 验证清单

- [ ] `npm run compile:electron` 类型检查通过。
- [ ] `npm run dev` 启动：日志出现监听行；config.json 自动生成 `kbMcpToken`。
- [ ] curl 握手：无 token → 401；带 token initialize → tools/list 见 5 个工具 → tools/call `search` 返回 JSON records。
- [ ] 索引链路：修改 notesDir 下一个 md → 防抖后 `search` 命中新内容；SourcesView 显示索引条数；重建按钮生效。
- [ ] chat 触发器：应用内新对话消息自动可被 `search(scope=chat)` 检索。
- [ ] 外部客户端实测：ZCode 注册 `qihang-kb` → `http://127.0.0.1:8792/mcp`（token），5 个工具各实调一次；再以 Claude Code `.mcp.json` 验证一遍。
- [ ] 应用内消费：新开对话，确认 `mcp__qihang_kb__search` 出现在工具面并可调用。
- [ ] UI：启停开关、token 复制、EADDRINUSE 提示（手工占住 8792 验证）。
- [ ] 关闭应用：`before-quit` 干净退出，无悬挂连接/句柄。

---

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| SDK ESM-only 与 CJS 主进程的兼容 | 沿用 `new Function` 动态 import（项目已验证模式）；打包产物在 asar 内同样适用 |
| electron-builder 打包 | files 未排除 `@modelcontextprotocol/**` 与 zod，默认会带上；release 后核对体积，异常再补排除规则 |
| stateless 模式个别客户端不兼容 | 以真实客户端实测为准（验证清单第 6 条）；不兼容则切 per-session stateful（SDK 标准模式，改动局部） |
| prj_messages 回填量大 | 后台异步 + kb_index_meta 标记；回填前 chat 检索降级提示 |
| trigram <3 字符查询无命中 | 逐源 LIKE 降级（radar 已有同款先例） |
| fs.watch 在 Windows 大目录的事件可靠性 | 三保险设计（watch + 启动差量 + 手动重建），watcher 仅是加速项，正确性不依赖它 |
| 敏感信息外泄（对话含密钥/内网路径） | 仅 127.0.0.1 + Bearer token；文档明确"不要把端口映射到公网"；后续可选加按 agent 工具屏蔽（不在 v1） |
| 应用未启动时 MCP 不可用 | 产品层面接受；文档写明。远期可抽 headless 常驻 worker 用 node:sqlite 只读直读库文件（数据层已天然支持） |

---

## 9. 决策记录（评审重点）

| 决策 | 选择 | 关键理由 | 被否选项 |
|---|---|---|---|
| MCP server 实现 | 官方 SDK @modelcontextprotocol/sdk + node:http 接线 | 多外部客户端的协议兼容最有保障；SDK 已在 node_modules | 手写 JSON-RPC 子集（与 approval/mobile 同风格，但 initialize/session/版本协商细节需自行维护并逐客户端实测） |
| 检索技术 | FTS5 trigram | 中文友好、有 radar 先例、SQLite 3.53.2 支持、零新增运行时依赖 | 向量/embedding（曾整体下线，维护成本高；FTS 不够再复活） |
| 传输模式 | stateless + JSON 响应 | 无会话表、无悬挂 SSE，Electron 内最简 | per-session stateful（SDK 亦支持，作为兼容性备胎） |
| 鉴权 | Bearer token（config.json） | 与现有 mcpServers token 管理一致 | 无鉴权（approval 先例，但知识库语料敏感性更高） |
| 与共享记忆 MCP 关系 | 编队不合并 | 可用性倒挂 + 读写职责不同 + 已有独立生态 | 在 kb 内代理/复刻 ProjectMemory |
| 数据范围 | 笔记 + radar 对话摘要 + 日报周报分析 + 应用内对话 | 用户确认全量收录 | 仅部分范围 |
| 写权限 | 第一版只读 | 防外部 agent 弄脏数据源 | 提供写入工具 |

---

## 附录 A：各客户端接入配置示例

token 与端口以应用 UI/`config.json` 实际值为准（下例用占位符）。

**Claude Code（项目根 `.mcp.json`）**

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

**Codex（`~/.codex/config.toml`）**

```toml
[mcp_servers.qihang-kb]
url = "http://127.0.0.1:8792/mcp"
http_headers = { "Authorization" = "Bearer <kbMcpToken>" }
```

**opencode（项目根 `opencode.json`）**

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

**Trae（项目根 `.trae/mcp.json`）**

```json
{
  "mcpServers": {
    "qihang-kb": { "url": "http://127.0.0.1:8792/mcp" }
  }
}
```

（若 Trae 不支持 headers，需在其配置界面填 token，或届时评估放宽为内网可信任环境免鉴权——评审时定。）

**ZCode / 其他 Streamable HTTP 客户端**

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

**应用内 agent**：无需配置。kb server 运行中时 `buildLoadedMcpConfig` 自动注入，工具以 `mcp__qihang_kb__*` 出现。

### curl 手工握手示例

```bash
TOKEN=$(node -e "console.log(require('D:/projects/qihang-ai-desktop/config.json').kbMcpToken)")

# 1) initialize
curl -s http://127.0.0.1:8792/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'

# 2) tools/list（stateless 模式无需 session id）
curl -s http://127.0.0.1:8792/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'

# 3) tools/call
curl -s http://127.0.0.1:8792/mcp \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"search","arguments":{"query":"FTS5 索引","scope":"notes","limit":5}}}'
```

---

## 附录 B：待评审开放问题

1. **笔记范围**：v1 只收 .md（与 walkMd 口径一致）。是否需要 .txt？（kb:search 现支持更多扩展名，但笔记库主体是 md。）
2. **get_session 是否覆盖应用内会话**：v1 仅 radar 会话；chat 会话靠 search 的 ref。是否需要统一？
3. **Trae 无 headers 能力时的鉴权策略**（见附录 A 注）。
4. **daily/weekly report 是否值得进 FTS**：v1 用 LIKE；若日报量增长明显再升级。
5. **工具命名**：server 内工具名不带 kb 前缀（全名已是 `mcp__qihang_kb__search`），确认无歧义。
