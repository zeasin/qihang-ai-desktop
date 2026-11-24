# 雷达采集器调研（A 组）：zcode / claude-code / codex / opencode / qoder

- 调研日期：2026-11-24
- 调研对象：`electron/radar/collectors/{zcode,claude-code,codex,opencode,qoder}.ts`（逐个全文通读），旁证 `electron/radar/types.ts`、`electron/radar/collectors/registry.ts`、`electron/radar/radar-monitor.ts`
- 证据等级：全部为**一手代码**（当前仓库快照），每条结论附 `文件:行号`；行号经 grep 定位与全文逐行计数双重核对，与当前文件内容一致
- 引用约定：首次出现给全路径，之后用短名（如 `zcode.ts:10` = `electron/radar/collectors/zcode.ts:10`）

---

## 0. 共同契约（五个采集器共享）

- 接口 `HubCollector`：`listAll()` 全量列举、`loadMessages()` 拉正文、`probe()` 轻探针、`dispose()`（`electron/radar/types.ts:33-45`）。接口注释明确：**probe 只读元数据（mtime/回合状态等），绝不解析消息正文——这是实时监控通道的成本保障（毫秒级、每 3s 一次），消息解析全部留给同步轮**（`types.ts:40-44`）。
- `SessionInfo` 字段：`id / label / file / messageCount / createdAt / updatedAt / projectDir / archived`（`types.ts:5-16`）；`updatedAt` 是增量检测依据（`types.ts:11`）。
- `ProbeSignal`：`ts`（源库最近写入毫秒）必填；`running?: boolean`——true=回合进行中，false=回合已结束，缺省=无精确信号退回时间窗口推断；**实报 true 的 collector 必须保证僵死回合在有限时间内翻转为 false**（`types.ts:24-33`）。
- 注册与 tool 键名：`registry.ts:16-26` 的 factories 表键为 `'zcode' / 'qoder' / 'opencode' / 'claude-code' / 'codex'`（另有 pi/trae/dsh/mcode，不在本篇范围）；与各采集器 `readonly tool` 字段一致（`zcode.ts:34`、`claude-code.ts:18`、`codex.ts:37`、`opencode.ts:21`、`qoder.ts:33`）。
- 探针的消费方：`radar-monitor.ts:98` 每 tick 调 `collector.probe()`，间隔 `cfg.monitorIntervalMs`（默认 3s，`radar-monitor.ts:28` 注释、`:72` setInterval）。`running===false` 立即归位 idle（`radar-monitor.ts:109-118`）；`running===true` 直接信任、僵死由 collector 兜底窗口翻转（`:121-128`）；监控侧另有 `EXACT_BACKSTOP_MS = 45 * 60_000` 纯保险（`radar-monitor.ts:24-25`，超期归位 `:154-161`）；无精确信号走 `activeWindowMs` 窗口推断（`:139-142`）。

---

## 1. zcode.ts — `ZcodeCollector`，tool = `'zcode'`

### ① tool 键名与数据源路径
- tool 键：`'zcode'`（`zcode.ts:34`）。
- 数据源：**单 SQLite 库** `~/.zcode/cli/db/db.sqlite`。路径拼接：`path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite')`（`zcode.ts:15-17`）。用 `node:sqlite` 的 `DatabaseSync` 经 `openSqliteReadonly()` 只读打开并**常驻缓存连接**（`zcode.ts:39-43`）。
- 库结构三层：`session / message / part`（`zcode.ts:32` 注释），另有回合表 `turn_usage`（`zcode.ts:160`）。

### ② listAll() 元数据来源
- `zcode.ts:45-70`。两查一映射：
  - 会话行：`SELECT id, directory, title, time_created, time_updated FROM session WHERE time_deleted IS NULL ORDER BY time_updated DESC`（`zcode.ts:50-51`）；
  - 消息计数：`SELECT session_id, count(*) AS c FROM message GROUP BY session_id`（`zcode.ts:53-55`）；
  - 映射（`zcode.ts:57-65`）：`id→id`、`title→label`、`file=id`（源存储定位即会话 id）、计数→`messageCount`、`time_created/time_updated`（毫秒数）→ ISO `createdAt/updatedAt`、`directory→projectDir`。无 `archived`。

### ③ probe() 轻探针
- `zcode.ts:151-214`。**一条 SQL**：`session` 表带两个标量子查询，从 `turn_usage` 取该会话最新回合的 `status` 与 `completed_at`（`ORDER BY started_at DESC, rowid DESC LIMIT 1`，`zcode.ts:159-164`）。
- mtime 窗口：`cutoff = now - 30 * 60_000`（**30 分钟**，比其他家的 10 分钟宽——注释：覆盖长工具静默期，配合僵死兜底，`zcode.ts:157`）。
- 成本特征：纯元数据单查询；只有"模糊态"会话才追加一次 `hasRunningPart` 的 `EXISTS` 子查询（`zcode.ts:192`调用，`216-231` 实现），后者用 `json_extract(p.data,'$.type')='tool'`、`json_extract(p.data,'$.state.status')='running'` 在 SQL 内判断，不拉正文。

### ④ running 判定：**精确回合信号**（五者中唯一）
- 信号源：`turn_usage` 表，ZCode 在**回合结束时**落库 `running/completed/error/cancelled`，是权威的"回合已结束"信号（`zcode.ts:145` 注释）。注：`turn_usage` 的 DDL 不在本仓库，其字段（`status/started_at/completed_at/rowid`）系由本查询语句反推。
- 状态机（`zcode.ts:166-204`）：
  1. `turn_status == null`（老版本库无回合行）→ 退回时间窗口推断：`ts > now-10min` 才报 `{ts}`（`zcode.ts:170-173`）；
  2. `turn_status === 'running'` → 实报 running，但受 `RUNNING_BACKSTOP_MS` 兜底：`now-ts > 30min` 翻 false（`zcode.ts:176-180`）；
  3. `ts ≤ turnEnd`（最新回合结束时间）→ 精确空闲 `running:false`，秒级生效（`zcode.ts:182-187`）；
  4. `ts > turnEnd`（有晚于回合结束的写入：新回合刚开始，或回合结束后的 title 异步写入）→ 三分支：
     - `now-ts > 30min` → false（**僵死兜底 1**，`zcode.ts:190-191`）；
     - `hasRunningPart`（存在晚于 turnEnd 创建、仍 running 的 tool part，长工具执行硬证据）→ true（`zcode.ts:192-194`）；
     - 否则模糊态：`probeMemo` 记忆写入冻结起点，写入冻结超 `AMBIGUOUS_STALE_MS = 90_000`（**僵死兜底 2：90 秒**）按空闲；写入在推进（tWrite 变化）则保持 running（`zcode.ts:195-203`；常量 `:13`，memo `:36-37`，防泄漏清理 `:206-209`）。
- 兜底汇总：硬运行（有 running part）**30 分钟**翻转（`zcode.ts:10`，注释：ZCode 硬崩来不及写 cancelled）；模糊运行 **90 秒**翻转（`zcode.ts:13`）；监控侧再加 **45 分钟**保险（`radar-monitor.ts:25`）。

### ⑤ loadMessages() 正文格式与解析
- `zcode.ts:72-142`。两查：`message` 表 `SELECT id, data, time_created ... ORDER BY COALESCE(sequence, time_created), id`（`:76-79`）；`part` 表 `SELECT message_id, data ... ORDER BY sequence, id`（`:80-82`）。两表 `data` 均为 JSON 文本列。
- 结构：`message.data` 含 `role / time.created / metadata.visibility`（`:26-30`）；`part.data` 含 `type / text / tool / state.{status,input,output}`（`:19-24`）。**工具调用无需配对启发式**——part 通过 `message_id` 天然挂到所属消息，state 内联 input/output。
- 噪声剥离：`visibility === 'model-only'` 的 user 消息跳过（todo 提醒等内部消息，`zcode.ts:97-99`）；part 类型白名单 `text→content`、`reasoning→thinking`（多段 `\n` 拼接，`:110-112`）、`tool→tools`（name=args=`state.input` JSON、result=`state.output`、status=`state.status||'done'`，`:113-123`）；default 显式不采 `step-start/step-finish/file/timeline`（`:124-125`）；三要素全空的消息跳过（`:128`）。
- `timestamp = data.time?.created ?? 行 time_created`（`:134`）。无正文缓存（每次实时查库，仅连接句柄常驻）。

### ⑥ 特殊处理
- 双兜底常量（30min/90s）+ `probeMemo` 模糊态记忆与防泄漏清理（见 ④）；
- `hasRunningPart` 用 SQL 内 `json_extract` 判断，避免拉取 part 正文（`:216-231`）；
- 未来兼容分支：若 ZCode 改为"回合开始即落库 running"，直接信任并同样受 30 分钟兜底（`zcode.ts:176-180` 注释）。

---

## 2. claude-code.ts — `ClaudeCodeCollector`，tool = `'claude-code'`

### ① tool 键名与数据源路径
- tool 键：`'claude-code'`（`claude-code.ts:18`）。
- 数据源：**JSONL 文件树** `~/.claude/projects/`，拼接：`path.join(os.homedir(), '.claude', 'projects')`（`claude-code.ts:23-25`）。其下每个编码目录 `<encoded-dir>`（项目路径编码而来）内扫 `*.jsonl`（`:14` 注释、`:41` `f.endsWith('.jsonl')`）；**文件名（去 `.jsonl` 后缀）即 sessionId**（`:62`）。无 sqlite、无日志文件。

### ② listAll() 元数据来源
- `claude-code.ts:27-76`。readdir 两层 + 对每个 jsonl `statSync`（`:47-52`）；正文元数据（cwd/标题）来自 256KB 头部探针 `probeFile`，以 **mtime+size 双键缓存**（`:19, 53-60`）——文件未变则直接用缓存。
- 映射（`:64-72`）：`id=sessionId`（文件名）、`file=sessionId`、`label=info.label`、`messageCount` **恒 0**（`:68`，不数消息）、`createdAt=stat.birthtimeMs||stat.mtimeMs`（`:69`）、`updatedAt=stat.mtimeMs`（`:70`）、`projectDir=info.cwd`（`:71`）。
- 空壳文件（提取不到 cwd，如 queue-operation 类）不采集（`:61`）。

### ③ probe() 轻探针
- `claude-code.ts:179-210`。readdir 两层 + `statSync` 每个 jsonl；**mtime 窗口 10 分钟**：`cutoff = Date.now() - 10 * 60_000`（`:183`），`stat.mtimeMs > cutoff` 才入结果（`:201`）。
- 成本特征：**纯 stat 级**（每 3s 一轮 readd+stat，不读任何文件内容；probe 只回 `{ts: stat.mtimeMs}`，不回 running，也就无需探头部）。

### ④ running 判定
- **无精确信号**：只报 `{ts}`（`claude-code.ts:202`），`running` 缺省 → 监控层退回 `activeWindowMs` 时间窗口推断（`radar-monitor.ts:139-142`）。不存在"僵死翻转"问题（本身不报 running）；空闲归位由监控层 `idleTimeoutMs` 兜底（`radar-monitor.ts:157`）。

### ⑤ loadMessages() 正文格式与解析
- `claude-code.ts:124-176`。整文件 `readFileSync`（`:128`）逐行 `JSON.parse`（`:130-133`）。
- 结构：每行一个自包含 JSON 对象；只认 `type==='user'|'assistant'` 行（`:134`）；`message.content` 为 string 直接收（`:144-145`），为数组时按块解析（`:146-160`）：`text→content`（`:149-151`）、`thinking→thinking`（`\n` 拼接，`:152-154`）、`tool_use→tools`（args=`JSON.stringify(block.input)`，**status 恒 'done'**，`:155-157`）。
- **工具结果不回填**：`tool_result` 块不采集，注释明言"结果挂在后续 user 行"（`:158`）——即工具执行结果以一条 user 角色消息出现在时间线里，而非填进工具项的 result。
- 噪声剥离：`isSidechain` 行跳过（`:135`，子代理转写是独立文件，主文件里的 sidechain 行丢弃）；标题探针里跳过 `<` 开头与 `Caveat:` 开头的注入文本（`:114-115`）、压缩空白截 60 字符（`:116`）。
- `timestamp = Date.parse(rawMsg.timestamp || entry.timestamp) || Date.now()`（`:139`）。
- 缓存：listAll 层有 mtime+size 头部缓存（`:19, 53-60`）与 `bySession` 的 sessionId→路径 Map（`:20-21, 63`）；loadMessages 本身**无缓存**，每次全量重读重解析。
- 兜底：`bySession` 未命中时 `findFile` 全盘重扫找 `<sessionId>.jsonl`（`:125, 212-222`）。

### ⑥ 特殊处理
- 头部探针只读前 `min(256KB, size)` 字节（`claude-code.ts:83-87`），正则提取 `"cwd"`（`:91-94`）与 `"type":"summary"` 行的 `summary` 字段（`:95-98`）；无 summary 时回退用第一条真人输入当标题（`:99-119`）。
- 空壳文件过滤（`:61`）。
- probe 与 listAll 完全解耦：probe 永不读正文，listAll 才探头部。

---

## 3. codex.ts — `CodexCollector`，tool = `'codex'`

### ① tool 键名与数据源路径
- tool 键：`'codex'`（`codex.ts:37`）。
- 数据源：**JSONL 文件树** `~/.codex/sessions/`，拼接：`path.join(os.homedir(), '.codex', 'sessions')`（`codex.ts:40-42`）；实际布局 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（`codex.ts:30` 注释）。`listRolloutFiles` 递归 walk，**深度上限 3**（年/月/日三层目录，目录结构变化时靠深度上限兜住；`:79-99`，文件过滤 `rollout-` 前缀 + `.jsonl` 后缀 `:92`，`walk(root, 3)` `:97`）。无 sqlite。

### ② listAll() 元数据来源
- `codex.ts:44-76`。对每个 rollout 文件 `statSync` + mtime+size 缓存命中或 `probeFile` 头部探（`:54-61`）。
- 映射（`:63-73`）：`id=meta.sessionId`（首行 `session_meta` 的 `session_id` 正则提取）、`file=完整路径`、`label=首个非注入 user 消息前 80 字符`、`messageCount` **恒 0**（`:67`）、`createdAt=meta.createdAtMs`（头部 `"timestamp"`，缺省回退 `stat.birthtimeMs||mtimeMs`，`:68-70`）、`updatedAt=stat.mtimeMs`（`:71`）、`projectDir=meta.cwd`（`:72`）。提取不到 sessionId 的文件跳过（`:62`）。

### ③ probe() 轻探针
- `codex.ts:260-282`。listRolloutFiles + statSync；**mtime 窗口 10 分钟**（`cutoff` `:262`，`stat.mtimeMs <= cutoff` 跳过 `:270`）。
- 成本特征：常规轮纯 stat；**特例——窗口内的新文件/已变更文件（缓存未命中）会做一次 1MB 头部探**以取 sessionId（`:271-278`），是五者探针中唯一可能读文件内容的；首见之后命中缓存，恢复纯 stat。

### ④ running 判定
- **无精确信号**：只报 `{ts: stat.mtimeMs}`（`codex.ts:279`），时间窗口推断（`radar-monitor.ts:139-142`）。无僵死翻转需求。

### ⑤ loadMessages() 正文格式与解析
- `codex.ts:154-229`。整文件 `readFileSync`（`:157`）逐行 `JSON.parse`（`:181-188`）。
- 结构：只认 `type==='response_item'` 行（`:189`）——`event_msg` 是 UI 事件、与 response_item 重复，不采（`:32` 注释）。payload 分型：
  - `message`：user → `messageText(p)`（`p.content[].text` 以 `\n` 拼接，`:298-303`）+ `isInjectedUserText` 注入过滤（`:196`）后 `flushGroup()` 独立成 user 消息（`:193-198`）；assistant → 追加进当前 `TurnGroup`（`:199-204`）；**developer/system 是注入的环境指令（含巨型权限/AGENTS 说明），不采**（`:205` 注释）。
  - `reasoning`：取 `p.summary[].text`（`:206-213`）——rollout 只留思考摘要，无原始思考链。
  - `function_call`：进 `group.tools`，记 `callId/name/args`（`:214-220`）。
  - `function_call_output`：result 取 `p.output`，status 由正则 `/^Exit code: [1-9]/` 判 error 否则 done（`:221-224`）；`attachOutput` 按 `call_id` 配对回填（`:224`，`:231-257`）：先在当前轮 group 内找未回填的工具，找不到**回溯已产出消息**（防御乱序文件）。
- **回合分组**：assistant 文本、reasoning、function_call 累积进同一 `TurnGroup`，遇下一条 user 或文件尾 `flushGroup` 合成一条 assistant 消息（`ensureGroup/flushGroup` `:165-179`，尾部 flush `:227`）；消息 timestamp 取组内最后一条的 ts（`groupTs` `:163, 175`）。
- 噪声剥离白名单（`isInjectedUserText`，`:290-296`）：`'# AGENTS.md instructions for'`、`'<environment_context>'`、`'<user_instructions>'`、`'<permissions'`、`'<turn_context'` 五种前缀。
- 缓存：仅 mtime+size 头部缓存（`:38`）；正文无缓存，每次全量重读。

### ⑥ 特殊处理（rollout 头部探针）
- 首行 `session_meta` 混着**巨型 base_instructions**，不能整行 `JSON.parse`，只能读头部正则提取（`codex.ts:31` 注释、`:104-111`，头部读 `min(1MB, size)`，`:108`）。
- `session_id/cwd/timestamp` 正则各取首个匹配（`:116-123`）——注释保证：session_meta 是首行且 cwd/session_id 排在 base_instructions 之前，首个匹配即安全（`:115`）。
- 标题双路径：快路径 `labelRe` 精确匹配序列化后的字段顺序（`:125-134`），失败时（字段顺序/格式敏感、或被巨型 meta 行挤出 1MB 头部）逐行 JSON 解析兜底（`:135-150`）。

---

## 4. opencode.ts — `OpenCodeCollector`，tool = `'opencode'`

### ① tool 键名与数据源路径
- tool 键：`'opencode'`（`opencode.ts:21`）。
- 数据源：**单 SQLite 库** `~/.local/share/opencode/opencode.db`，拼接：`path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db')`（`opencode.ts:10-13`）。
- 连接策略与其他家不同：**每次操作 `openDb()` 新开只读连接、finally 关闭**（`opencode.ts:23-27`；关闭点 `:70, :182, :201`），不常驻句柄（zcode/qoder 是常驻）。

### ② listAll() 元数据来源
- `opencode.ts:55-72`。先 `sessionTable()` 容错选表（见 ⑥），再查：`SELECT id, directory, title, time_created, time_updated, tokens_input FROM <table> WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 5000`（`:62-63`）——**五者中唯一有行数上限（5000）**，且 `parent_id IS NULL` 排除子会话。
- 映射 `rowToSession`（`:41-53`）：`id/title/file=id` 直取；`messageCount`：OpenCode 无消息计数列，用 `tokens_input > 0 ? 1 : 0` 充当"有无消息"标志（`:46-47`）；`createdAt/updatedAt` = `time_created/time_updated` ISO；`projectDir = directory` 的**正斜杠统一替换为反斜杠**（`:50-51`，Windows 风格目录过滤匹配）。

### ③ probe() 轻探针
- `opencode.ts:186-204`。同款表容错后一条 SQL：`SELECT id, time_updated FROM <table> WHERE parent_id IS NULL AND time_updated > ?`；**mtime（time_updated）窗口 10 分钟**（`cutoff` `:193`）。
- 成本特征：纯元数据单查询；每次探针都新开/关闭一次 sqlite 连接（多一次 open/close 开销）。

### ④ running 判定
- **无精确信号**：只报 `{ts: time_updated}`（`opencode.ts:197`），时间窗口推断（`radar-monitor.ts:139-142`）。

### ⑤ loadMessages() 正文格式与解析
- `opencode.ts:169-184`。**按表存在性路由两代解析器**：`message`+`part` 两表都在 → v1（`:173-174`）；否则有 `session_message` → v2（`:176-177`）；都没有 → `[]`。
- **v1**（`:75-126`）：`message` 表骨架 `SELECT id, data, time_created ... ORDER BY rowid ASC`（`:77-78`）+ `part` 表 `SELECT message_id, data ... ORDER BY rowid ASC`（`:80-81`），data 均为 JSON。text 块排除 `b.synthetic`（合成块不采，`:99`）；user 消息只收 text（`:100-104`）；assistant 的 `reasoning→thinking`（`:106`）、`tool` 块→tools（name=`b.tool`、args=`state.input`、result=`state.output`、**status 映射 completed→done / error→error / 其余→running**，`:107-115`）；`timestamp = d.time.created || 行 time_created`（`:97`）。
- **v2**（`:129-167`）：`session_message` 单表 `SELECT type, time_created, data WHERE session_id=? AND type IN ('user','assistant') ORDER BY seq ASC`（`:131-132`）；user 取 `d.text`（`:139-143`）；assistant 的 `d.content` 块数组（`:145`）同 v1 分型，但 **tool result 从 `st.content[]` 数组的 `c.text` 拼接**（`:153`）——两代库字段形状不同；status 映射同 v1（`:154`）。
- 工具调用无需配对（part/块内联 state）；无缓存。

### ⑥ 特殊处理（schema 容错）
- **两代库结构兼容**：v1（`session`+`message`/`part`）与 2.x（`session_v2`+`session_message`），不做 SDK/HTTP 兜底——库不存在说明未安装或太老，列表为空即可（`opencode.ts:14-19` 注释）。
- 表探测：`hasTable` 查 `sqlite_master`（`:29-32`）；会话表双候选 `session_v2` 优先、`session` 其次、都没有则不支持（`:35-39`）。
- `projectDir` 路径分隔符归一（`:50-51`）；`tokens_input` 伪装 messageCount（`:46-47`）；listAll LIMIT 5000（`:63`）。

---

## 5. qoder.ts — `QoderCollector`，tool = `'qoder'`

### ① tool 键名与数据源路径
- tool 键：`'qoder'`（`qoder.ts:33`）。
- 数据源：**单 SQLite 库 main.sqlite**，双候选（`qoderDbCandidates()`，`qoder.ts:10-18`）：
  - macOS：`~/Library/Application Support/com.qodercn.app.stable/main.sqlite`（CN 版优先，`:11,15`）→ `~/Library/Application Support/com.qoder.app.stable/main.sqlite`（国际版，`:16`）；
  - Windows/其他：`%APPDATA%`（缺省 `~/AppData/Roaming`，`:12`）下同两目录。
  - `ensureDb()` 按序尝试、取首个能只读打开的库并**常驻缓存连接**（`qoder.ts:36-49`）。

### ② listAll() 元数据来源
- `qoder.ts:51-84`。两表：`chat_sessions` + `chat_session_messages`。
- 主查询（`:57-65`）：`SELECT s.session_id, s.title, s.cwd, s.created_at, s.updated_at, s.archived, MAX(COALESCE(lm.last_msg_at, 0), s.updated_at) AS effective_at FROM chat_sessions s LEFT JOIN (SELECT session_id, MAX(updated_at) AS last_msg_at FROM chat_session_messages GROUP BY session_id) lm ... WHERE s.deleted_at IS NULL ORDER BY effective_at DESC`；
- 计数子查询：`SELECT session_id, count(*) FROM chat_session_messages GROUP BY session_id`（`:66-68`）；
- 映射（`:70-79`）：`id=session_id`、`label=title`、`file=session_id`、`messageCount=计数`、`createdAt=created_at`、**`updatedAt=effective_at`（修复后的时间，见 ⑥）**、`projectDir=cwd`、`archived=!!archived`（五者中唯一映射 `archived`，`types.ts:15`）。

### ③ probe() 轻探针
- `qoder.ts:140-159`。与 listAll 同构的 JOIN+MAX 查询（`:148-153`），**窗口 10 分钟**（`cutoff` `:145`，`MAX(COALESCE(lm.last_msg_at,0), s.updated_at) > cutoff`）；注释：与 listAll 同理，以消息行最大 updated_at 为准，**回合结束就能被探到**（`:146`）。
- 成本特征：一条带聚合 JOIN 的 SQL，纯元数据；连接常驻。

### ④ running 判定
- **无精确信号**：只报 `{ts: effective_at}`（`qoder.ts:154`），时间窗口推断（`radar-monitor.ts:139-142`）。

### ⑤ loadMessages() 正文格式与解析
- `qoder.ts:86-138`。`SELECT role, payload_json, created_at FROM chat_session_messages WHERE session_id=? ORDER BY sequence`（`:90-93`）。
- 结构：`payload_json` 为 JSON，核心是 `parts[]` 数组（`:27-29, :102`）；`role` 直接读行列（`:98`）。parts 分型（`:102-123`）：`text→content`（`:104-106`）、`thinking→thinking`（取 `part.thinking || part.text`，`:107-109`）、`tool→tools`（name=`part.tool.name`、args=`JSON.stringify(part.tool.input)`、result=`part.tool.response ?? part.tool.result ?? ''`、status=`part.tool.status || 'done'`，`:110-119`）；default 不采。
- 工具调用无需配对（tool part 内联 response/result）；`timestamp = Number(row.created_at)`（`:130`）；全空消息跳过（`:124`）；无缓存。

### ⑥ 特殊处理（updated_at 修复）
- **核心修复**：Qoder 的会话行 `updated_at` 只在用户提问时更新，助手回合完成时只写消息行——直接用 `s.updated_at` 会导致指纹永远不变、AI 回复采不到；因此 listAll 与 probe 都改取 `MAX(会话 updated_at, 消息最大 updated_at)`（`qoder.ts:55-56` 注释、`:59`、`:148-152`）。
- 双候选库路径（CN 优先）+ 常驻连接（`:10-18, :36-49`）；工具结果字段 `response ?? result` 双兼容（`:115`）。

---

## 6. 五器横向对照

| | zcode | claude-code | codex | opencode | qoder |
|---|---|---|---|---|---|
| tool 键 | `zcode` | `claude-code` | `codex` | `opencode` | `qoder` |
| 数据源 | `~/.zcode/cli/db/db.sqlite` | `~/.claude/projects/<encoded>/*.jsonl` | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | `~/.local/share/opencode/opencode.db` | `%APPDATA%`(mac: `~/Library/Application Support`)/`com.qoder[cn].app.stable/main.sqlite` |
| 存储 | SQLite 常驻连接 | JSONL 文件 | JSONL 文件 | SQLite 每次开关 | SQLite 常驻连接 |
| listAll 元数据 | `session` 表 + `message` 计数 | stat + 256KB 头部（mtime/size 缓存） | stat + 1MB 头部（缓存） | `session_v2`/`session` 表，LIMIT 5000 | `chat_sessions` JOIN 消息最大 updated_at |
| messageCount | 真实计数 | 恒 0 | 恒 0 | `tokens_input>0 ? 1:0` | 真实计数 |
| probe 窗口 | **30 分钟** | 10 分钟 | 10 分钟 | 10 分钟 | 10 分钟 |
| probe 成本 | 1 条 SQL（+可选 EXISTS） | 纯 stat | stat；新文件首见读 1MB 头 | 1 条 SQL（每轮开关连接） | 1 条 SQL（JOIN 聚合） |
| running | **精确**：`turn_usage` 状态机 | 无（窗口推断） | 无（窗口推断） | 无（窗口推断） | 无（窗口推断） |
| 僵死兜底 | 硬运行 **30min** + 模糊态 **90s**（监控侧 45min 保险） | —（不报 running） | — | — | — |
| 工具调用配对 | part 内联 state，无需配对 | 不回填（结果在后续 user 行） | `call_id` 配对 + 乱序回溯 | part/块内联 state | tool part 内联 response/result |
| 噪声剥离 | `visibility=model-only`；part 白名单；跳过 step-start 等 | `isSidechain`；标题跳 `<`/`Caveat:` | 只认 `response_item`；注入 5 前缀；跳 developer/system | v1 跳 `synthetic` 块；v2 SQL 层 type 过滤 | parts 类型白名单 |
| 正文缓存 | 无（连接常驻） | 头部 mtime+size 缓存；正文无 | 头部 mtime+size 缓存；正文无 | 无 | 无 |

---

## 7. 待证项与建议下一步

1. **`turn_usage` 表的 DDL 与写入时机**：本仓库只能从查询反推字段（`status/started_at/completed_at`，`zcode.ts:160-161`）；"回合结束时落库"出自代码注释（`zcode.ts:145`）。建议：对本机 `~/.zcode/cli/db/db.sqlite` 实测 `sqlite3 .schema turn_usage` 与一轮真实会话的写入时序，验证"running 状态是否真的只在未来兼容分支出现"。
2. **`radar-config.ts` 默认参数值**（`monitorIntervalMs/activeWindowMs/idleTimeoutMs` 的默认数值）本次未取到字面量，仅确认"探针默认 3s"来自 `radar-monitor.ts:28` 注释。建议：读 `radar-config.ts` 的默认值段（B 组或后续补查）。
3. **claude-code 的 `<encoded-dir>` 编码规则**（项目路径如何变成目录名）未在本文件中展开——采集器只做无脑 readdir，不依赖编码规则，故不影响本篇结论；若要写"接入指引"可实测一个目录名反推。
4. **`session_meta` 的 `"timestamp"` 字段是否恒为首条时间**（codex `createdAt` 来源，`codex.ts:122-123`）：注释未覆盖，建议用一个真实 rollout 文件头部验证。
