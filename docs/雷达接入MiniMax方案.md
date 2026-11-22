# 雷达接入 MiniMax 方案（研究结论）

> 日期：2026-11-22 · 范围：`qihang-ai-desktop`（启航AI工作台）
> 结论来源：本机数据实测 + MiniMax 开放平台官方文档（中国区）+ pi SDK 本地文档

## 实施状态（2026-11-22 更新）

- **路线 A（采集侧）已实现**：`electron/radar/collectors/mcode.ts` 新增 `McodeCollector`，并完成注册与前端标签。
  改动清单：`collectors/mcode.ts`（新增）、`collectors/registry.ts`、`radar-config.ts`（ALL_TOOLS）、
  `types.ts`（注释）、`src/views/{AgentRadarView,RadarAskView,RadarAllView,RadarSummaryView,RadarSessionView}.vue`、
  `src/main.ts`（mock）。
  `config.json` 的 `agentRadarTools` 为空即表示全开，无需改动。
  实测：真实 worker 跑通入库，20 个会话全部写入（`written:20, error:""`），第二轮 `written:0`（增量判定正常），
  `radar_message` 落 1647 行，工具调用结果 100% 配对，噪声残留 0。
- **路线 B（推理侧）未实施**：纯配置项，见第三节，10 分钟可自行完成。

## 结论摘要

「雷达接入 MiniMax」在本项目里对应两件**互相独立**的事：

| 路线 | 含义 | 改动量 | 可行性 |
|---|---|---|---|
| **A. 采集侧** | 把 MiniMax Code（mcode）的会话纳入雷达，与 claude-code / codex / opencode 并列 | 新增 1 个 collector + 注册 2 处 + 配置 1 项 | **高**：本机数据结构已实测摸清，transcript 覆盖率 100% |
| **B. 推理侧** | 雷达的 AI 功能（问雷达 / 昨日简报 / 会话摘要）改用 MiniMax 模型 | **零代码**，设置页加一条接入 | **高**：pi SDK 已支持 OpenAI 兼容端点 |

建议两条都做：A 解决「看不到 mcode 的对话」，B 解决「雷达的总结/问答用谁的模型」。

---

## 一、现状盘点

### 1.1 雷达的分层

```
采集器 HubCollector → ingest（指纹增量）→ 本地正本库 ~/.qihang-ai-desktop/radar/
                                      → 检索 / 问雷达 / 昨日简报 / 会话摘要
```

关键文件：

| 位置 | 作用 |
|---|---|
| `electron/radar/types.ts:42` | 采集器契约 `HubCollector { listAll, loadMessages, probe, dispose }` |
| `electron/radar/collectors/registry.ts:15` | 8 个采集器注册表 |
| `electron/radar/radar-config.ts:27` | `ALL_TOOLS = [zcode, claude-code, codex, opencode, qoder, trae, dsh, pi]` |
| `electron/services/agent-radar.ts:32` | 读 `config.json` 的 `agentRadarTools`（逗号分隔，**只认 ALL_TOOLS 内的值**） |
| `electron/radar/fingerprint-store.ts:12` | 指纹 `Fingerprint { sourceUpdatedAt, messageCount, lastSyncedSeq }`，增量依据 |
| `electron/radar/radar-db.ts:82` | 正本库表：`radar_session` / `radar_message` / `radar_state_event` / `radar_message_fts`(trigram) |
| `electron/radar/radar-monitor.ts:33` | 实时通道，每 3s 跑 `probe()`，状态跃迁 running/idle |
| `electron/radar/radar-ingest.ts:39` | 同步通道，默认 60s 一轮：列举 → 元数据 upsert → 指纹变更的按 seq 增量写 |

### 1.2 雷达的 AI 调用链

全部走 `generateWithPi` → `runPi` → pi SDK（in-process，`electron/services/pi-agent.ts:367`）：

| 调用点 | 文件 | 是否显式指定模型 |
|---|---|---|
| 问雷达 | `electron/radar/radar-ask.ts:194` | 可选 `modelPattern`，前端有模型下拉（`RadarAskView.vue:39`，pattern 形如 `provider/modelId`） |
| 昨日简报 | `electron/radar/radar-brief.ts` | 否 → 走 pi 默认模型 |
| 会话摘要 | `electron/radar/radar-digest.ts:196` | 否 → 走 pi 默认模型 |

模型运行时读 `~/.pi/agent/models.json` + `auth.json`（`pi-agent.ts:67-81`）；
默认模型由 `syncDefaultModelSettings()` 同步到 `settings.json` 的 `defaultProvider/defaultModel`（`pi-agent.ts:771`）。

### 1.3 当前缺口

全仓检索（排除 node_modules）`minimax|MiniMax` **零命中**：雷达既不采集 mcode 会话，也没有 MiniMax 模型接入点。

---

## 二、路线 A：新增 mcode 采集器

### 2.1 本机实测的数据源

#### （1）元数据与运行状态：SQLite

路径 `~/.minimax/v2/sqlite/runtime-state.sqlite`（本机 63 MB / 20 个会话）。

`local_runtime_sessions` 表关键字段：

| 字段 | 实测样例 | 用途 |
|---|---|---|
| `session_id` | `mvs_3c7103c101c145399f4be24655f85eef` | 雷达主键之一 |
| `title` | `研究雷达如何接入 MiniMax` | 会话标题 |
| `project_workspace_dir` | `D:\projects\qihang-ai-desktop` | 项目目录 → 雷达的目录排除过滤靠它 |
| `workspace_dir` | 同上（可为 `~/.minimax/sessions/<id>/workspace`） | 兜底 |
| `created_at_ms` / `updated_at_ms` | 1795313748201 / 1795313751028 | 增量指纹 |
| `status` | `started` / `idle` / `error` | **精确运行态**（本机分布：idle 15、error 4、started 1） |
| `archived` / `visibility` / `session_kind` / `agent_name` / `runtime` | 0 / visible / conversation / mavis / pi-agent | 过滤与展示 |
| `history_relative_dir` | `2026/11/22/02-15-48-201-session_…` | 指向文件层 transcript |
| `error_message` | `insufficient balance (1008)` | 失败原因 |

相关表：`local_runtime_message_rows`（2779 行）、`local_runtime_messages`（`display_messages_json` / `pi_history_json`）、`local_runtime_sessions_fts`、`local_runtime_projects`。

#### （2）正文：文件层

路径 `~/.minimax/v2/sessions/YYYY/MM/DD/HH-mm-ss-mmm-session_<base64(sessionId)>/`

| 文件 | 必现 | 内容 |
|---|---|---|
| `messages.jsonl` | **是（实测 20/20 全覆盖，合计 3844 行）** | 完整对话（user/assistant/thinking/toolCall/toolResult） |
| `manifest.json` | 是 | `sessionId` / `createdAtMs` / `updatedAtMs` / `layout: "v2-final-dated-session"` / 各文件路径 |
| `llm-call.json` | 是 | 本次 LLM 调用的 `provider` / `model` / `api` / `maxTokens` / systemPrompt |
| `history-catalog.json`、`user-message-locators.jsonl`、`reports/`、`snapshots/` | 否 | 索引与产物，采集用不到 |

`messages.jsonl` 行格式（与 pi 同构，仅顶层键名不同）：

```json
{"message_id":"…","turn_id":"…","message":{"role":"assistant",
 "content":[{"type":"thinking","thinking":"…"},{"type":"text","text":"…"},
            {"type":"toolCall","id":"call_x","name":"bash","arguments":{…}}],
 "api":"anthropic-messages","provider":"minimax","model":"MiniMax-M3.1-Flash",
 "usage":{…},"stopReason":"toolUse","timestamp":1795313749541}}

{"message_id":"…","turn_id":"…","message":{"role":"toolResult","toolCallId":"…",
 "toolName":"bash","content":[{"type":"text","text":"…"}],"isError":false,
 "timestamp":1795313755816}}
```

> 注：`~/.minimax/sessions/<sessionId>/` 是 **workspace 目录**（只有 `workspace/` 与 `permission.json`），**不是** transcript，别扫错目录。

### 2.2 字段映射表

| 雷达字段（`electron/radar/types.ts`） | 来源 |
|---|---|
| `SessionInfo.id` | sqlite `session_id` |
| `SessionInfo.label` | sqlite `title`；缺失时回退首条用户消息前 80 字（同 `PiCollector` 做法） |
| `SessionInfo.file` | `messages.jsonl` 绝对路径（`loadMessages` 直接读它） |
| `SessionInfo.messageCount` | `messages.jsonl` 行数（进指纹，决定是否需要重解析） |
| `SessionInfo.createdAt` | sqlite `created_at_ms` → ISO |
| `SessionInfo.updatedAt` | sqlite `updated_at_ms` → ISO |
| `SessionInfo.projectDir` | sqlite `project_workspace_dir`（回退 `workspace_dir`） |
| `SerializedMessage.role` | `message.role` ∈ {user, assistant, toolResult} |
| `SerializedMessage.content` | `content[type=text].text` 拼接 |
| `SerializedMessage.thinking` | `content[type=thinking].thinking` |
| `SerializedMessage.tools` | `content[type=toolCall]` → `{name, args: JSON.stringify(arguments), result: 对应 toolResult 文本, status}` |
| `SerializedMessage.timestamp` | `message.timestamp` |
| `ProbeSignal.ts` | sqlite `updated_at_ms` |
| `ProbeSignal.running` | sqlite `status === 'started'` |

### 2.3 关键设计决策（踩坑点）

1. **元数据取 SQLite、正文取 JSONL** —— 两者互补：SQLite 有 `title` / `status` / `project_workspace_dir`，JSONL 有完整工具调用与 thinking。任何单取一方都会丢信息。

2. **探针报精确 running，但要防僵死** —— mcode 的 `status` 是源工具自己的回合状态机，比其他工具「时间窗口推断」准得多（对比 `radar-monitor.ts:18-25` 对 collector 的要求：实报 true 必须保证僵死回合在有限时间内翻转为 false）。mcode 崩溃时 `status` 可能永远停在 `started` → **必须加兜底**：`status='started'` 且 `updated_at_ms` 超过 N 分钟（建议 10 分钟）即视为 false，否则雷达会长期显示「运行中」。

3. **增量天然对齐** —— `messages.jsonl` 只追加，`seq` 递增；指纹用 `updated_at_ms` + 消息行数，与 `FingerprintStore` 的 `{sourceUpdatedAt, messageCount, lastSyncedSeq}` 一一对应，无需改任何入库逻辑。

4. **必须剥离系统提示噪声**（最容易踩的坑）—— mcode 的**用户消息里塞了** `<system-reminder>`、`<agent-context>`、`<media-output-reminder>`、`<async-audit>` 等 XML 包裹块。实测首条 user 消息就有约 1.5 KB 此类噪声。若不过滤：
   - 关键词检索会被 `system-reminder`、`agent-context` 之类词污染，问雷达会召回大量空结果；
   - 昨日简报/会话摘要会把提示词复读进正文。
   → 建议只剥离**已知标签白名单**（保守策略），保留用户真实输入；不要用贪婪的通用 XML 正则（用户可能正当地引用 XML）。

5. **只认 v2 dated 布局** —— 按 `history_relative_dir` 定位或按 `YYYY/MM/DD` 目录结构遍历；`~/.minimax/sessions/<id>/` 是 workspace，不是 transcript。

6. **schema 容错** —— 表名/列名都带 `local_runtime_` 前缀，MiniMax 后续改 schema 会漂移。照 `OpenCodeCollector` 的做法（`opencode.ts:29-39` 判表是否存在、字段缺失即跳过），**绝不能让一个工具的 schema 变化打挂整轮采集**。

7. **只读打开 63MB 的 WAL 库** —— 复用 `openSqliteReadonly`（`electron/radar/sqlite-open.ts:9`），它已处理「WAL 需恢复且无写入方持有 -shm」的回退逻辑。

### 2.4 改动清单

| 文件 | 改动 |
|---|---|
| `electron/radar/collectors/mcode.ts` | **新增**，实现 `HubCollector` |
| `electron/radar/collectors/registry.ts:1,15-24` | import + `factories` 加 `['mcode', () => new McodeCollector()]` |
| `electron/radar/radar-config.ts:27` | `ALL_TOOLS` 加 `'mcode'`（**必须**，否则 `agent-radar.ts:34` 的过滤会把它剔掉） |
| `config.json` | `agentRadarTools` 加 `mcode`（留空 = 全开） |
| `electron/radar/types.ts:1` | 注释里的 tool 枚举同步 |
| `src/views/ConfigView.vue` | 可选：雷达采集工具多选加「MiniMax Code」 |
| `src/views/HelpView.vue` | 可选：帮助文案与排查表补充 |

### 2.5 工作量

单文件 ~300–400 行（含噪声剥离、状态兜底、schema 容错），体量参照现有 `opencode.ts`(207 行) / `pi.ts`(216 行)。**风险低，收益直接**（mcode 会话立刻进入雷达视野、可被问雷达检索）。

---

## 三、路线 B：雷达 AI 改用 MiniMax 模型

### 3.1 现状

雷达 AI 全部经 pi SDK，provider 定义在 `~/.pi/agent/models.json`，由应用内「设置 → 💬 对话模型配置」读写（`main.ts:1528-1541`、`pi-agent.ts:664/681`）。provider 结构：

```json
{ "providers": { "<接入名>": { "baseUrl", "apiKey", "api", "models": [ {id,name,reasoning,input,contextWindow,maxTokens,compat} ] } } }
```

### 3.2 零代码配置

「设置 → 💬 对话模型配置 → ⚙️ 自定义」新增一条接入：

| 字段 | 值 |
|---|---|
| 接入名称 | `minimax` |
| 服务地址 | `https://api.minimax.cn/v1` |
| API 类型 | Chat Completions（`openai-completions`） |
| API Key | 开放平台 API Key |
| 模型 | `MiniMax-M3.1-Flash`：上下文 1000000 / 最大输出 128000 / 推理模型 ✓ / 支持图片 ✓ |
| | `MiniMax-M3`：同上 |

保存后写入 models.json 并热重载 ModelRegistry（`pi-agent.ts:732`）；再把它设为默认模型，`syncDefaultModelSettings()` 会同步 `settings.json` 的 `defaultProvider/defaultModel` → **昨日简报、会话摘要立刻改走 MiniMax**（这两处不传 modelPattern）。问雷达页的模型下拉会出现 `MiniMax · M3.1-Flash`（pattern `minimax/MiniMax-M3.1-Flash`），也可直接手选。

官方另有两条捷径：
- `npx -y mmx-cli@latest agent setup` —— 向导把 MiniMax 模型写进 Pi 的 models.json；
- `export MINIMAX_CN_API_KEY=sk-cp-…` 后 `pi --provider minimax-cn --model MiniMax-M3.1-Flash` —— pi 内置 provider `minimax-cn`（`MINIMAX_CN_API_KEY`）/ `minimax`（`MINIMAX_API_KEY`）。

### 3.3 注意事项（实测 + 官方文档核对）

1. **M3.1-Flash 强制 thinking** —— 传 `thinking: disabled` 直接 400（错误码 2013）。雷达的摘要/简报是纯文本任务，不需要深度思考 → **默认建议用 `MiniMax-M3`**（可关 thinking），把 M3.1-Flash 留给问雷达。

2. **temperature / top_p / top_k 被服务端忽略**（固定 temperature=1、top_p=0.95）→ 在雷达侧做温度实验没有意义。

3. **连接测试按钮会「假通过」** —— 它发 `POST {baseUrl}/chat/completions`、body 里 `max_tokens:1`，**只判 HTTP 状态码**（`pi-agent.ts:812-837`）。M3.1-Flash 强制 thinking 时 `max_tokens:1` 必然命中 `stop_reason: length` 且正文为空，但 HTTP 仍是 200 → **测试显示通过 ≠ 能出字**。务必真跑一次问雷达验证。

4. **max_tokens 要给足** —— thinking token 计入 `max_tokens` 上限。雷达的昨日简报 prompt 很长（分片并发 3、单次 120s 超时），`maxTokens` 建议 128000，否则容易「只有思考、没有正文」。

5. **雷达的 AI 回合带工具** —— `generateWithPi` 走的是完整 pi 会话（内置 bash/read 等工具在 cwd 下），不是裸 chat 请求。换 MiniMax 后单次成本结构会变（多轮工具调用 + 强制 thinking 会显著放大 token）。问雷达其实不需要工具，后续可考虑给雷达会话 `excludeTools`。

6. **pi 对 `reasoning_content` 的兼容已核对** —— MiniMax 的 OpenAI 兼容接口把思考放在 `reasoning_content`，pi 的 `openai-completions` 实现支持该字段回传（`dist/bundle/chunks/openai-completions-*.js`），多轮工具调用不会因思维链断裂而失败。**不构成阻塞**。

7. **Anthropic 兼容端点（`https://api.minimax.cn/anthropic`）当前 UI 选不到** —— 「API 类型」下拉只有 Chat Completions / Responses / Ollama。要用需手改 models.json 的 `api: "anthropic-messages"`（`saveBuiltinModelConfigs` 会保留 `api` 字段，`pi-agent.ts:726`）。一般不必，OpenAI 兼容够用。

8. **注意区分两套 MiniMax 端点** —— 开放平台 API（`api.minimax.cn`，用开放平台 API Key / M Plan 订阅 Key）≠ MiniMax Code 自身运行时端点（`~/.minimax/config.yaml` 里的 `agent.minimax.cn/mavis/api/v1/llm/v1`，用 Code 的登录凭据）。工作台接的是**前者**。

### 3.4 工作量

配置 0 代码，10 分钟见效。建议后续给设置页加一个「MiniMax」快捷模板（参照 `ConfigView.vue:827` 的 `PROVIDER_PRESETS`），省去手工填 baseUrl。

---

## 四、可选扩展：给雷达补联网能力

雷达的 AI 调用**没有注入任何工具**（`generateWithPi` 不传 `customTools`）→ 问雷达只能基于本地检索到的片段作答，无法联网核实。

MiniMax 开放平台提供：
- **M Plan MCP**：网络搜索 + 图片理解两个专属工具；
- **MiniMax MCP**：图片生成、语音合成、音色克隆、视频生成等多模态能力。

若要接，**不需要新建机制**——走工作台已有的 MCP 管理（`electron/services/mcp-manager.ts`），雷达会话可传 `mcpServerIds` 限定作用域（`pi-agent.ts:122`）。

---

## 五、建议落地顺序

1. **先做 B（零代码）**：把雷达的 AI 后端切到 MiniMax，跑一次问雷达 + 一次昨日简报，验证质量与成本。
2. **再做 A（新增 collector）**：让 mcode 会话进入雷达视野，重点验证「噪声剥离」与「running 状态兜底」两处。
3. **有余力再做**：M Plan MCP 接入雷达问答。

---

## 六、待确认事项

- **噪声剥离策略**：只剥离已知标签白名单（`<system-reminder>` / `<agent-context>` / `<media-output-reminder>` / `<async-audit>`，保守）还是用通用 XML 标签正则（激进）。建议保守。
- **会话类型过滤**：本机 20 个会话 `session_type` 全是 `branch`；是否需要按 `session_kind` / `parent_session_id` 过滤掉子会话与隐藏会话。
- **是否同时采集 v1 旧布局**：`~/.minimax/sessions/<id>/` 下未见 transcript，暂按「只有 v2 有正文」处理即可。

---

## 七、参考来源

- MiniMax 开放平台（中国区）文档索引：https://platform.minimax.cn/docs/llms.txt
- Anthropic SDK 兼容接口：https://platform.minimaxi.com/docs/api-reference/text-anthropic-api.md
- OpenAI SDK 兼容接口：https://platform.minimaxi.com/docs/api-reference/text-openai-api.md
- 在 Pi 中使用 MiniMax：https://platform.minimaxi.com/docs/m-plan/pi.md
- pi provider 与模型配置：`node_modules/@earendil-works/pi-coding-agent/docs/providers.md`、`schemas/models.schema.json`
- 本机实测：`~/.minimax/v2/sqlite/runtime-state.sqlite`、`~/.minimax/v2/sessions/**`、`~/.minimax/config.yaml`
