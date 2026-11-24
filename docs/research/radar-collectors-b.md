# 雷达采集器调研 B 组：trae / dsh / pi / mcode

> 调研日期：2026-11-24。方法：逐个通读 4 个采集器全文（trae.ts + trae-db-worker.ts / dsh.ts / pi.ts / mcode.ts），并核对支撑件 types.ts、sqlite-open.ts、registry.ts、radar-monitor.ts 与 package.json 打包配置。所有引用均为 文件:行号 实际核verified；行号基于当前工作区快照，后续编辑会漂移。

## 0. 公共契约（四个采集器共用）

| 事实 | 证据 |
|---|---|
| `HubCollector` 接口：`tool` / `listAll()` / `loadMessages(s)` / `probe()` / `dispose()`；probe 只读元数据、绝不解析正文，是「毫秒级、每 3s 一次」的实时监控通道成本保障 | electron/radar/types.ts:38-46 |
| `SessionInfo` 字段：`id`、`label`、`file`（源存储定位：sqlite 会话 id 或 jsonl 文件路径）、`messageCount`、`createdAt`、`updatedAt`（源库最后更新，增量检测依据）、`projectDir`、`archived` | electron/radar/types.ts:6-20 |
| `SerializedMessage`：`role`('user'\|'assistant') / `content` / `thinking?` / `tools?{name,args?,result?,status?}` / `timestamp`(ms) | electron/radar/types.ts:22-28 |
| `ProbeSignal`：`ts`(ms 心跳) + `running?`（true=回合进行中，false=已收口，缺省=退回时间窗推断）；**实报 true 的 collector 必须保证僵死回合在有限时间内翻转为 false** | electron/radar/types.ts:30-35 |
| 工具注册表（tool 键名在此实例化）：zcode/qoder/opencode/claude-code/codex/pi/**trae/dsh/mcode**，单实例构造失败不影响其余 | electron/radar/collectors/registry.ts:16-28 |
| 监控侧兜底：`EXACT_BACKSTOP_MS = 45 * 60_000`（注释：collector 30 分钟翻转，这里 45 分钟纯保险，防探针持续报错滞留）；exact 会话超时归位 idle 的判定 `deadline = max(lastWrite, startedAt) + EXACT_BACKSTOP_MS` | electron/radar/radar-monitor.ts:24-25、153-158；exact 信任探针在 radar-monitor.ts:121-124 |
| 只读打开外部 SQLite（多为 WAL）：先 `readOnly:true`，失败（WAL 需恢复且无写入方持 -shm）退回普通打开让 SQLite 完成恢复；库不存在返回 null | electron/radar/sqlite-open.ts:9-17（mcode 用它，见 §4）；`sameDir` 大小写/分隔符归一化比较 sqlite-open.ts:19-23（trae 用它，见 §1②） |

四个采集器的监控对象路径与形态一览：

| tool | 本机数据源 | 形态 |
|---|---|---|
| trae | `~/Library/Application Support/Trae{CN,\ }/ModularData/ai-agent/database.db`（macOS）或 `%APPDATA%\Trae{CN,\ }/...`（Windows） | SQLCipher 加密 SQLite |
| dsh | `~/.dsh/sessions/<cwd-slug>/<会话目录>/session.v{4,3}.jsonl.zstd`（`~` = `os.homedir()`） | 多帧 zstd 压缩 JSONL |
| pi | `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` | 明文 JSONL |
| mcode | 元数据 `~/.minimax/v2/sqlite/runtime-state.sqlite` + 正文 `~/.minimax/v2/sessions/<history_relative_dir>/messages.jsonl` | SQLite + JSONL 双源 |

---

## 1. trae（electron/radar/collectors/trae.ts + trae-db-worker.ts）

### ① tool 键名与数据源路径

- tool 键名：`readonly tool = 'trae'`（trae.ts:40；注册于 registry.ts:24）。
- 源库候选路径 `traeDbCandidates()`（trae.ts:10-18）：
  - macOS 基目录 `path.join(os.homedir(), 'Library', 'Application Support')`（trae.ts:11）；Windows `process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')`（trae.ts:12）。
  - 候选字面量（trae.ts:15-16）：
    - `<base>/Trae CN/ModularData/ai-agent/database.db`（CN 版优先）
    - `<base>/Trae/ModularData/ai-agent/database.db`（国际版）
  - `init()` 里 `traeDbCandidates().find((p) => existsSync(p))` 取第一个存在的（trae.ts:54）；全不存在则日志「database.db 未找到，会话列表将为空」并保持 `srcPath=null`（trae.ts:55-57），listAll/probe/loadMessages 全部返回空（trae.ts:98-100、109-110、121-122）。
- 解密缓存路径 `traeCacheBasePath()`（trae.ts:20-24）：`path.join(os.tmpdir(), 'qihang-radar-trae-plain-<base64url(srcPath) 前 12 字符>.sqlite')`，即**系统临时目录**；源库变了缓存名不同自动重解（trae.ts:21 注释）。
- 缓存伴随 meta 文件：`state.cachePath + '.meta.json'`（trae-db-worker.ts:458），记录 `{cache, srcMtime, srcSize, walMtime, walSize}`（CacheMeta，trae-db-worker.ts:160-166）。
- worker 文件：`path.join(__dirname, 'trae-db-worker.js')` 经 `app.asar → app.asar.unpacked` 路径替换（trae.ts:30-32，详见 ⑥）。

### ② listAll() 元数据来源

主进程 `listAll()`（trae.ts:96-105）只做 `init()` + RPC `'list'`（`projectDir:''` 即不过滤项目）；真正读数在 worker `listSessions()`（trae-db-worker.ts:299-328）：

- 表与 SQL（trae-db-worker.ts:302-307）：
  ```sql
  SELECT s.session_id, s.session_title, s.created_at, s.updated_at, p.absolute_path
  FROM chat_session s
  LEFT JOIN session_project sp ON sp.session_id = s.session_id
  LEFT JOIN project p ON p.project_id = sp.project_id
  WHERE s.deleted_at = 0
  ORDER BY s.updated_at DESC
  ```
  即主表 `chat_session`，左联 `session_project` → `project` 取项目绝对路径。
- messageCount 用第二条聚合 SQL：`SELECT session_id, count(*) AS c FROM chat_message WHERE deleted_at = 0 GROUP BY session_id`（trae-db-worker.ts:310-311）。
- 字段映射（trae-db-worker.ts:314-325）：`id=session_id`、`label=session_title||''`、`file=session_id`（源存储定位就是会话 id）、`messageCount=countMap`、`createdAt/updatedAt = Number(ts)*1000 → ISO`（**Trae 时间戳是秒**，注释 trae-db-worker.ts:320）、`projectDir=absolute_path||''`。`sameDir` 项目过滤仅当传入 projectDir 才生效（trae-db-worker.ts:314）。

### ③ probe() 轻探针读什么

- 主进程 probe（trae.ts:118-131）：`cutoffSec = Math.floor((Date.now() - 10*60_000)/1000)`（**10 分钟窗口，秒级**，trae.ts:122）→ RPC `'probe'` → worker `probeSessions()`（trae-db-worker.ts:330-337）：`SELECT session_id, updated_at FROM chat_session WHERE deleted_at = 0 AND updated_at > ?`，`ts = updated_at*1000`。
- 成本路径：worker 每次 RPC 先过 `ensurePlainDb()`（trae-db-worker.ts:247-296）——**源库 mtime/size 与 WAL mtime/size 四元组都没变时直接返回内存中已打开的明文缓存 db，只花 2 次 statSync**（trae-db-worker.ts:251-254）；变了则先查 meta 文件判断磁盘缓存是否仍新鲜（`cacheUpToDate`，trae-db-worker.ts:177-190：src mtime/size + wal mtime/size 四元组 + 缓存文件大小 ≥ `floor(srcSize/4096)*4096`），新鲜则复用磁盘缓存，否则重解（受 8s 节流约束，见 ⑥）。注释明说：「探针复用明文缓存查 chat_session.updated_at（源库没动时只是一次 stat + 小查询）」（trae.ts:36-37）与「源库没变时 ensurePlainDb 只是 stat + 小查询」（trae-db-worker.ts:328-329）。

### ④ running 判定

**纯时间窗推断，无精确回合信号。** probe 只回 `{ts}`，不回 `running`（trae.ts:124-126）；类注释明说「运行状态走时间窗口推断」（trae.ts:37-38）。窗口 10 分钟（trae.ts:122）；监控侧拿到无 `running` 的信号走 `activeWindowMs/idleTimeoutMs` 时间窗推断（radar-monitor.ts:139-148）。

### ⑤ loadMessages() 正文格式与解析要点

主进程 loadMessages（trae.ts:107-116）→ worker `loadSessionMessages()`（trae-db-worker.ts:377-448）。双表模型（注释 trae-db-worker.ts:379-381）：

- **骨架表 `chat_message`**：`SELECT message_id, message_role, reply_to_message_id, created_at ... WHERE session_id=? AND deleted_at=0 ORDER BY message_index`（trae-db-worker.ts:383-385）。
- **快照表 `history_v2`**：`SELECT message_id, content_source, messages ... ORDER BY id`（trae-db-worker.ts:387-389）；`messages` 列是 JSON，取 `JSON.parse(row.messages)?.raw_messages`（trae-db-worker.ts:395），元素结构 `{role, content:[{type,text?}]}`（`TraeRawMessage`，trae-db-worker.ts:341-344）。
- **关键关联坑**：`history_v2.message_id` 记录的是「触发该轮的用户消息 ID」，assistant task 消息自身 ID 查不到，必须用骨架 `reply_to_message_id` 关联——`historyKey = role==='assistant' ? (reply_to_message_id || message_id) : message_id`（trae-db-worker.ts:380-381、407-409）。
- **user 正文**：`extractUserText()`（trae-db-worker.ts:346-365）——正则 `matchAll(/<user_input>([\s\S]*?)<\/user_input>/g)` 提取真实输入（355）；无标签时取未包含 `<system-reminder>` 的 plain 文本（358-360）；有标签则只合并标签内容（361-363）。取数 `rows[0]?.raw || rows[1]?.raw`（413）。空文本丢弃（415）。
- **assistant 拼装**（trae-db-worker.ts:419-443）：`content_source !== 'user_input' && !== 'llm_default'` 的快照行视为工具步，`tools.push({name: source, args:'', result: collectToolResult(...), status:'done'})`（423-426）——工具名即 `content_source`，args 恒空；`collectToolResult()`（367-373）取快照里第一个 `role==='tool'` 的 `part.text`。叙述文本跨快照去重（`last !== part.text` 才 push，注释「连续快照会重复同一段叙述」，trae-db-worker.ts:430-433）；最终 `content = texts.join('\n\n')`（435）；content 与 tools 全空则丢弃（437）。

### ⑥ 特殊处理（SQLCipher 解密链路 + worker 为何在 asar 外）

**为什么 worker 打包到 asar 外**：`workerJsPath()` 注释（trae.ts:27-29）：「打包后主进程代码在 app.asar 内，而 worker 文件已配置 asarUnpack 落在 app.asar.unpacked（**Node 的 worker 线程读 asar 内文件不可靠**），这里做路径替换」——`replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')`（trae.ts:31）。打包配置依据：package.json:122-126 `"asarUnpack": ["**/node_modules/better-sqlite3/**", "**/node_modules/fzstd/**", "**/dist-electron/electron/radar/**"]`——**整个 radar 编译目录都被解包**（package.json:125），worker.js 天然落在 asar 外；同模式先例 electron/services/agent-radar.ts:48-52。此外 worker 承担解密 CPU 重活也必须独立线程：「SQLCipher 页级解密 + 查询都是 CPU 重活，必须在独立线程跑」（trae-db-worker.ts:10），重活不堵主线程（trae.ts:35）。

**SQLCipher 解密参数**（trae-db-worker.ts）：
- 库规格：SQLCipher 4，AES-256-CBC，页 4096，reserve 80（页尾 = IV(16)+HMAC-SHA512(64)），HMAC-SHA512（头注释 trae-db-worker.ts:12、常量 21-22）。
- 密钥：`TRAE_DB_KEY_HEX = '3605f6691095a993f03d5009c918352ef5be31ae31e8f000212b81ff058da773'`（trae-db-worker.ts:20），注释「算法逆向自 ai_agent.dll；版本升级失效时需更新」（19）——密钥写死在 ai_agent.dll、全用户一致，社区已逆向（trae-db-worker.ts:13）。
- `decryptPage()`（58-66）：IV 取每页 reserved 区前 16 字节（60），`createDecipheriv('aes-256-cbc', key, iv)` + `setAutoPadding(false)`（SQLCipher 不用 PKCS 填充，62）；首页密文从偏移 16 开始（首页明文同样少 16 字节 salt，99、129）。
- **WAL 叠加** `applyWal()`（68-109）：SQLCipher 只加密页体，WAL 头与帧头是明文；帧校验和复现不出来（SQLCipher 加密前算的），改用「帧 salt 与 WAL 头一致 + 提交帧 size_after>0」取边界（69-71）；salt 不符的旧代帧跳过（79），未到提交帧的页留在 pending（74、101）；WAL 可能带主库还没有的新页，按 size_after 扩容（85-90）。效果：Trae 未 checkpoint 的最新写入也能看到（trae-db-worker.ts:15-16）。
- **整体流程** `decryptToFile()`（119-157）：整库按页解密成明文 Buffer（120-129）→ 用「首页 SQLite 头合法性」代替逐页验 HMAC 判断密钥是否失效（快得多，130-133；报错文案「密钥可能已随 Trae 版本更新而失效」132）→ 叠加 WAL → 自洽性校验（`isSelfConsistent` 111-117：首页声明页数 ≤ 镜像实际长度，防 checkpoint 中途读到坏镜像，134-137）→ 写 `<cache>.<实例id>-<时间戳>.sqlite`，**文件名带实例+时间戳后缀，绝不覆盖别人正打开着的缓存**（118、138）→ Windows 上 Defender 可能短暂锁新文件致 rename EPERM，重试 5 次 × `Atomics.wait` 200ms（142-152）→ 清理 tmp（155）。
- **缓存治理**：并发 worker 共享 pid 需各自随机后缀 `INSTANCE_ID`（55-56）；缓存新鲜度靠 meta 精确判断——「Trae 只写 WAL 时主库可以长时间不动」（177-190）；8 秒重解节流 `MIN_REFRESH_MS`（24-25、271-277），节流窗口内允许用略旧缓存（实测一次重解约 3s CPU + 270MB 落盘，24）；陈旧缓存清理 `sweepStaleCaches` 每 10 分钟一轮，tmp 5 分钟、正式缓存 30 分钟过期（215-233），init 时强制清一次（trae-db-worker.ts:461）。头注释的性能口径「~0.6s/270MB」（trae-db-worker.ts:14）与 24 行「3s CPU」出自两处注释，口径不一（待证，见 §6）。
- RPC 通道：主进程 `rpc()` 请求-响应封装（trae.ts:67-94），worker exit 时 reject 全部 pending（trae.ts:82-85）；dispose 终止线程并重置 initPromise（trae.ts:133-139）。

---

## 2. dsh（electron/radar/collectors/dsh.ts）

### ① tool 键名与数据源路径

- tool 键名：`readonly tool = 'dsh'`（dsh.ts:35；registry.ts:25）。
- 会话根：`path.join(os.homedir(), '.dsh', 'sessions')`（dsh.ts:38-40）。布局注释：`~/.dsh/sessions/<cwd-slug>/session-xxx/session.vN.jsonl.zstd`（dsh.ts:32）。
- 遍历两层（`sessionLogPaths()`，dsh.ts:42-66）：第一层是 cwd-slug 目录（`readdirSync` 过滤 `isDirectory`，44-53），第二层会话目录名两种：老版 `session-<uuid>`、新版裸 UUID，正则 `/^(session-)?[0-9a-f-]{36}$/`（**两种都收——日志内容里的 id 才是权威值，目录名只用来定位文件**，dsh.ts:57-60）。
- 日志文件名 `SESSION_LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']`（dsh.ts:46），同一会话可能同时留 v3/v4，按此序取第一个存在的（取最新版本，dsh.ts:62-63）。

### ② listAll() 元数据来源

- 不读任何表/旁路文件，**元数据全部来自日志事件本身**。`parseLogMeta()`（dsh.ts:70-114）整文件解压后逐行 `JSON.parse`：
  - `type:'session'` 事件顶层（`evt.data || evt`）：`{id, cwd, createdAt}`（dsh.ts:83-90；createdAt 缺省用 `stat.birthtimeMs`，89）。
  - 标题：`type:'session/title'` 事件的 `data.title`（91-92）；没有则取第一条 `user/message` 的首个 `type:'text'` 块截 200 字（93-99）。
  - `messageCount` 只数 `user/message` 事件（94）。
  - 读到 meta.id 且 title 就提前 break（100）——只解到能拿到 meta/title 为止（注释 dsh.ts:69）。
- 映射（dsh.ts:117-135）：`id=meta.id`、`label=title`、`file=日志路径`、`messageCount`、`createdAt=meta.createdAt`、**`updatedAt=文件 mtime`**（124）、`projectDir=meta.cwd`；**`messageCount===0` 的空会话（开了没说话）不进列表**（122）。按 createdAt 倒序（135）。
- 性能：`metaCache` 以文件 mtime 为键缓存解析结果（36、72-73、113），mtime 未变的文件不重解。

### ③ probe() 轻探针读什么

- `cutoff = Date.now() - 10*60_000`（**10 分钟窗口**，dsh.ts:202）；对每个日志文件先 `statSync`，`mtime <= cutoff` 直接跳过——探针稳态成本就是每文件一次 stat（dsh.ts:203-210）。
- mtime 命中窗口才 `parseLogMeta`（首次要解压整文件，之后走 mtime 缓存）；id 来自 meta 缓存（211-212）。
- 信号：`ts = stat.mtimeMs`；`turnOpen===true → sig.running=true`；`===false → sig.running=false`；`null →` 只报 ts（214-217）。

### ④ running 判定（精确回合信号）

**精确信号：日志尾部回扫 turn/start vs turn/end，谁在后谁是权威状态。** 回扫实现（dsh.ts:102-109）：从最后一行倒序找第一个 `turn/start`（→ `turnOpen=true`）或 `turn/end`（→ `turnOpen=false`）。依据注释：「DSH 显式发这两个事件，比 mtime 时间窗精确——turn/end 落盘即回合格已收口」（dsh.ts:102-103）。probe 注释补充：「崩掉的回合（只有 start 没有 end）由监控侧 45 分钟兜底」（dsh.ts:199-201）——落点即 radar-monitor.ts:25 `EXACT_BACKSTOP_MS = 45*60_000` 与 radar-monitor.ts:153-158 的超时归位逻辑（dsh 的 turnOpen 永远停在 true 时，由监控侧在最后一次写入 45 分钟后翻转 idle）。`ParsedLog.turnOpen` 类型 `boolean|null`（dsh.ts:242-243）。

### ⑤ loadMessages() 正文格式与解析要点

整文件解压（`getZstd()`）→ 按行 JSON.parse（dsh.ts:149-152），事件 `type` 分派（ts 取 `evt.time`，154）：

| 事件 | 处理 | 行号 |
|---|---|---|
| `user/message` | `data.content` 过滤 `type==='text'` 拼 `'\n'` → user 消息 | 156-159 |
| `assistant/message` | `data.message.content`：text 拼 `content`，reasoning 拼 `thinking`；挂上 `pendingTools`（本轮已发生、尚未落到 assistant 消息上的工具调用）后清空 | 160-171 |
| `tool/call` | `pendingTools.push({name: data.name, args: data.arguments, status:'running', callId: data.callId})` | 172-178 |
| `tool/result` | `callId = data.message.source.callId \|\| data.message.toolCallId`；`result = textOf(data.message.content)`（textOf 只收 text/reasoning 文本块，246-251）；`isError → 'error'` 否则 `'done'`；配对**优先 callId 精确匹配，兜底取最后一个 status='running' 的工具** | 179-189 |

- 配对容器 `pendingTools` 在函数顶部声明（147）；工具调用先于 assistant/message 事件出现时按序挂到下一条 assistant 消息上（168）。
- **噪声剥离：无**——dsh 日志没有系统提示注入块，不做任何白名单剥除（全文无 stripNoise/白名单逻辑）。
- 文件丢失时按 id 重新 `listAll()` 定位（139-144）。

### ⑥ 特殊处理（zstd 多帧 + fzstd 兜底）

- **多帧 zstd 是核心坑**：「dsh 的日志是逐条 flush 的多帧 zstd，Node 内置 zlib 只解第一帧」（dsh.ts:31）。因此不用 zlib，统一走 `getZstd()`（15-28）：优先动态 `import('@mongodb-js/zstd')` 原生解压（可选加速 ~100MB/s+；**用变量 specifier 让 tsc 跳过模块解析**，未安装不影响编译，19-22）；catch 后 `nativeZstd=null`，回退纯 JS `fzstd.decompress`（**慢但可用**，14、23-27）；最终 `(buf) => nativeZstd ? nativeZstd(buf) : fzstd.decompress(buf)`（27）。fzstd 为直接依赖（dsh.ts:4）且被 asarUnpack（package.json:124）。
- 解压结果 `Buffer.from(raw).toString('utf8').split('\n').filter(Boolean)`（79-80、150-151）。
- 无解密需求（明文压缩日志）；无 SQL；会话 id 以日志内容为权威（59）。

---

## 3. pi（electron/radar/collectors/pi.ts）

### ① tool 键名与数据源路径

- tool 键名：`readonly tool = 'pi'`（pi.ts:22；registry.ts:23）。
- 会话根：`path.join(os.homedir(), '.pi', 'agent', 'sessions')`（pi.ts:25-27）；其下一层是 encoded-cwd 目录（`listAll` `readdirSync(root, {withFileTypes:true})` 取目录，pi.ts:39-47），文件为 `*.jsonl`（pi.ts:32）。
- **排除自身**：`!f.startsWith('assistant-v2-')`（pi.ts:32）——注释：「assistant-v2- 前缀是启航工作台自己的会话文件，雷达里已有原生对话页，不重复采集」（pi.ts:19）。

### ② listAll() 元数据来源

- 扫两级目录（pi.ts:38-83），每文件一次 `statSync`（49-53）；元数据来自 `probeFile()` 头部探针 + 内存缓存 `cache`（键 `mtimeMs+size` 双匹配，pi.ts:23、61-67）。
- `probeFile()`（pi.ts:85-119）：**只读文件头 `min(128*1024, size)` 字节**（90-93）；首行 `JSON.parse`，`type==='session'` 时取 `id / cwd / createdAtMs=Date.parse(timestamp)`（98-104）；id 有效则继续在头部行里扫首个 `type==='message' && message.role==='user'` 事件，text 块拼接截 80 字作 label（106-116）。
- 映射（pi.ts:69-78）：`id=meta.id`、`file=完整路径`、`label=meta.label`、**`messageCount: 0`（恒 0，不数）**、`createdAt=meta.createdAtMs || stat.birthtimeMs || mtimeMs`（73-75）、`updatedAt=stat.mtimeMs`（76）、`projectDir=meta.cwd`（77）。

### ③ probe() 轻探针读什么

- `cutoff = Date.now() - 10*60_000`（**10 分钟窗口**，pi.ts:180）；两级目录遍历 + 每文件 `statSync`，`mtime <= cutoff` 跳过（197）——稳态成本 = 目录遍历 + N 次 stat。
- 命中窗口的文件：缓存（mtime+size 相同）命中用缓存 meta，否则做一次 128KB 头部探针（199-205）；`out.set(meta.id, {ts: stat.mtimeMs})`（206-207）。

### ④ running 判定

**纯时间窗推断，无精确信号**——probe 只回 `{ts: mtimeMs}`（pi.ts:207），pi 的 jsonl 没有 turn 状态事件可回扫；监控侧按无 `running` 信号的时间窗逻辑处理（radar-monitor.ts:139-148）。

### ⑤ loadMessages() 正文格式与解析要点

整个文件 utf-8 读入按行 JSON.parse（pi.ts:126-129）；只处理 `evt.type === 'message' && evt.message`（132）；`ts = typeof evt.timestamp === 'number' ? evt.timestamp : Date.parse(evt.timestamp) || Date.now()`（134）：

- **user**：`message.content` 过滤 `c.type==='text'` 取 `c.text` 拼 `'\n'`（135-140）；无文本不落。
- **assistant**（141-166）：同一条消息的 `content` 块数组内：`text` 块拼 content；`thinking` 块取 `c.thinking` 拼 thinking；**`toolCall` 块直接内嵌工具结果**——`tools.push({name: c.name, args: JSON.stringify(c.arguments||{}), status:'done', result: c.result||''})`（148-153）。**无需跨行配对**（pi 的 toolCall 块自带 result，与 mcode 的分离式 toolResult 行不同）。
- 空消息（无 text/thinking/tools）丢弃（156-159）。
- **噪声剥离：无**（全文无白名单/剥除逻辑，明文 jsonl、无解压解密）。

### ⑥ 特殊处理

- 自身会话排除（assistant-v2- 前缀，pi.ts:19、32）。
- 头部探针成本控制：`probeFile` 只读 128KB（pi.ts:90），label 截 80 字（115）。
- 缓存键 mtime+size（比 dsh 的 mtime 单键多一个 size 维度，防同秒重写漏检）。
- 与 mcode 的 jsonl 同构关系见 §4⑥。

---

## 4. mcode（electron/radar/collectors/mcode.ts，MiniMax Code）

### ① tool 键名与数据源路径

- tool 键名：`readonly tool = 'mcode'`（mcode.ts:100；registry.ts:26）。
- 双源（头注释 mcode.ts:14-17）：
  - **状态库**（元数据+运行态）：`path.join(os.homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')`（`mcodeRoot()` 28-30 + `stateDbPath()` 33-35）。
  - **正文文件**：`path.join(mcodeRoot(), 'v2', 'sessions', <history_relative_dir>, 'messages.jsonl')`（`sessionsRoot()` 38-40 + `sessionDir()` 176-187）。v2 dated 布局注释：`YYYY/MM/DD/<时间戳>-session_<base64(sessionId)>`（mcode.ts:37）。
- 会话目录定位 `sessionDir()`（176-187）：优先库字段 `history_relative_dir` 拼 sessionsRoot（178-181）；miss 则查 `ensureDirIndex()`——递归扫 sessions 根（深度 ≤5），凡含 `manifest.json` 的目录读 `manifest.sessionId` 建 `Map<sid, dir>`（147-174）；索引可能是旧的（会话刚建），清空重建一次再查（184-186）。
- 状态库打开 `openStateDb()`（108-118）：`existsSync` 检查 + `openSqliteReadonly(dbPath, 'RADAR-MCODE')`（sqlite-open.ts:9-17，readOnly 失败退回读写做 WAL 恢复）；表不存在/打开失败一律返回 null 降级到文件层（mcode.ts:121-131）。

### ② listAll() 元数据来源

- 主路径 `readSessionRows()`（120-144）：先 `sqlite_master` 验表 `local_runtime_sessions` 存在（124-129），再查（130-137）：
  ```sql
  SELECT session_id, title, project_workspace_dir, workspace_dir,
         created_at_ms, updated_at_ms, status, history_relative_dir
  FROM local_runtime_sessions
  WHERE IFNULL(archived, 0) = 0 AND IFNULL(visibility, 'visible') = 'visible'
  ORDER BY updated_at_ms DESC LIMIT 5000
  ```
- 映射 `rowToSession()`（189-203）：`id=session_id`、`label=title`、`file=<sessionDir>/messages.jsonl`、`messageCount: 0`（恒 0）、`createdAt/updatedAt = *_ms → ISO`（缺省落 `new Date()`，194-200）、`projectDir = project_workspace_dir || workspace_dir`（201）。
- **降级路径** `listFromFiles()`（206-225）：库不可用/表缺失时从 `ensureDirIndex()` 枚举，元数据取 `manifest.json` 的 `createdAtMs/updatedAtMs`（213-214），`label:''`、`projectDir:''`（**只有时间戳，没有标题与项目目录**，注释 205）。listAll 分派：`rows = readSessionRows(); if (!rows) return this.listFromFiles(); return rows.map(rowToSession)`（228-231）。

### ③ probe() 轻探针读什么

- 主路径（349-378）：**只读 sqlite，不碰正文文件**——验表后 `SELECT session_id, updated_at_ms, status FROM local_runtime_sessions WHERE IFNULL(archived,0)=0 AND IFNULL(visibility,'visible')='visible'`（358-361）。成本 = 一次打开 + 一条全表查询（上限即会话总数，无 LIMIT）。
- 兜底路径（379-389）：表缺失/打开失败时 `ensureDirIndex()` + 对每个 `messages.jsonl` `statSync`，`mtime > now-10min` 的报 `{ts: mtimeMs}`（**10 分钟 mtime 窗口，无 running**，381-387）。注释「文件可能正被写或已删」（388）。

### ④ running 判定（精确信号 + 僵死兜底）

**精确信号 = mcode 自己的回合状态机 `status` 字段，外加 20 分钟僵死兜底**：

- `running = (status === 'started') && (now - updated_at_ms <= RUNNING_STALE_MS)`（mcode.ts:366-369）；`RUNNING_STALE_MS = 20 * 60_000`（mcode.ts:43）。
- 依据注释（mcode.ts:344-347）：「mcode 的 status 是源工具自己的回合状态机 → 可精确报 running/idle；但进程崩溃时 status 会残留为 started，用写入时间超时兜底翻转」；常量注释（41-43）：「status='started' 且长时间没有写入 → 视为回合已死（进程崩溃残留），不再报运行中」。
- 监控侧另有 45 分钟保险（radar-monitor.ts:24-25、153-158）；types.ts:32 的「实报 true 必须有限时间内翻转」契约由 collector 的 20 分钟窗口满足。
- status 残留风险在头注释里被列为两点必须注意之一（mcode.ts:24-27）。

### ⑤ loadMessages() 正文格式与解析要点

读 `messages.jsonl` 全文（236-243）按行 JSON.parse，取 `evt.message`（251-256）；`ts = Number(m.timestamp) || Date.now()`（258）。角色分派（比 pi 多三种）：

| role | 处理 | 行号 |
|---|---|---|
| `user` | `stripNoise(textOf(m.content))`，剥完为空则丢 | 260-265 |
| `assistant` | `blocksOf` 统一块数组；`text`→content、`thinking`→thinking、`toolCall`→tools（初始 `status:'running'`，result 空待回填）；`toolCall.id` 写入 `pending` Map（`id → {msg 下标, tool 下标}`，**工具结果可能出现在后续消息里**，248-249） | 267-299 |
| `toolResult` | 按 `m.toolCallId` 查 pending 回填 `result = textOf(m.content)`、`status = m.isError ? 'error' : 'done'`，回填后删除 pending | 301-313 |
| `compactionSummary` | 上下文压缩摘要 `m.summary` 作为 assistant 消息收录——「模型当时看到的真实内容，值得进雷达」 | 315-321 |
| `custom` | 运行时自定义提醒（todo 节奏提醒等），剥噪后仍有内容才收录为 assistant 消息 | 323-329 |

- 收尾（332-337）：pending 里始终没等到结果的工具调用，`status:'running'` 会误导，统一翻成 `'done'`。
- `textOf`（81-95）：content 可能是字符串或块数组，只收 `type==='text'` 的文本块；`blocksOf`（97-100）字符串包装成 `[{type:'text'}]`。
- **噪声剥离白名单（不搞通用 XML 正则）**：
  - `NOISE_TAGS` 11 个标签（mcode.ts:51-63）：`system-reminder`、`agent-context`、`async-audit`、`media-output-reminder`、`mcode-tools-master-reminder`、`ask-user-guidance`、`background-task-finished`、`bootstrap_check`、`available_skills`、`permissions`、`env`。
  - 成对剥除正则 `NOISE_PAIR_RE = <(tag)>[\s\S]*?</\1>`（mcode.ts:65）；`stripNoise()`（68-79）：成对剥除 → 未闭合噪声块「起点在文首则截断到文末」（71-76）→ `\n{3,}` 压成 `\n\n`（78）。
  - 为什么不做通用 XML 正则：「用户正文里可能合法包含 `<svg>/<path>` 等标签」（mcode.ts:22-23）——只剥已知标签白名单（21）。

### ⑥ 特殊处理（同构 jsonl + 噪声实测数据 + 双源降级）

- **与 pi 的 jsonl 同构**：头注释明说「（messages.jsonl）与 pi 的 jsonl 同构：thinking / text / toolCall / toolResult」（mcode.ts:16-17）。实测差异（由两文件解析代码对比得出）：① pi 的工具结果内嵌在 toolCall 块（`c.result`，pi.ts:148-153），mcode 的结果在独立的 `toolResult` 行需按 `toolCallId` 跨行配对（mcode.ts:301-313）；② mcode 多 `compactionSummary`/`custom` 两种 role（mcode.ts:315-329），pi 只处理 user/assistant（pi.ts:131-166）；③ mcode 有噪声剥除（260），pi 无。
- **噪声剥离实测数据**（写在注释里，出处即本仓库注释本身）：
  - 「mcode 把运行时提示（system-reminder 等）塞进 user 消息，实测占 user 文本 **79.7%**，不过滤会污染关键词检索，也会让简报复读提示词」（mcode.ts:20-22）。
  - 「实测分布：system-reminder 107 / background-task-finished 58 / agent-context 46 / mcode-tools-master-reminder 46 / async-audit 20 / media-output-reminder 14 / ask-user-guidance 11。全部为成对闭合标签（实测 **246 对、0 个未闭合**）」（mcode.ts:46-50）。
- **双源降级链**：sqlite（元数据+运行态）→ manifest 文件层（仅时间戳）→ 全空。probe 与 listAll 各自独立降级（349-391、228-231）。
- 目录索引 `ensureDirIndex` 有深度上限 5（150）与一次性缓存（`dispose` 清空，393-395）；`sessionDir` miss 时重建一次索引再试（184-186）。

---

## 5. 横向对照（①-④ 关键差异）

| 维度 | trae | dsh | pi | mcode |
|---|---|---|---|---|
| 元数据源 | 明文缓存 SQLite：`chat_session`⋈`session_project`⋈`project` | 日志事件 `session`/`session/title`/`user/message` | 文件首行 `session` 事件（头部 128KB） | SQLite `local_runtime_sessions`（降级 manifest.json） |
| 探针稳态成本 | 2 次 stat + 小 SQL | 每文件 1 次 stat（命中窗口才解压） | 目录遍历 + 每文件 1 次 stat | 1 次 sqlite 查询（兜底才 stat） |
| mtime 窗口 | 10 分钟（秒级 cutoff） | 10 分钟 | 10 分钟 | 10 分钟（仅兜底路径） |
| running 判定 | **时间窗推断** | **精确**：尾部回扫 `turn/start|turn/end`，崩溃回合由监控侧 45 分钟兜底 | **时间窗推断** | **精确**：`status==='started'` + collector 20 分钟僵死兜底（监控侧 45 分钟保险） |
| 正文格式 | SQLCipher 双表（骨架+快照） | 多帧 zstd JSONL 事件流 | 明文 JSONL（首行 session） | 明文 JSONL（与 pi 同构，多 2 种 role） |
| 工具配对 | content_source 判定，无 args | callId 精确 + 最后 running 兜底 | 内嵌 result 无需配对 | toolCallId 跨行配对 + 未回填翻 done |
| 噪声剥离 | `<user_input>` 提取 / `<system-reminder>` 整段弃 | 无 | 无 | 11 标签白名单 + 未闭合截断 |
| 解密/解压 | AES-256-CBC 页解密 + WAL 叠加 | zstd（原生可选 + fzstd 纯 JS 兜底） | 无 | 无 |
| messageCount | 聚合 SQL 实数 | user/message 事件计数 | 恒 0 | 恒 0 |

## 6. 待证项（未定位到一手证据的线索）

1. **trae 解密耗时口径矛盾**：trae-db-worker.ts:14 写「~0.6s/270MB」，trae-db-worker.ts:24 写「实测一次重解约 3s CPU + 270MB 落盘」。两个数字可能分别指纯页解密与含落盘+WAL 叠加的端到端耗时，但仓库内没有测量脚本佐证。查法：在 git log 中检索这两条注释的提交信息（`git log -S "0.6s/270MB" -- electron/radar/collectors/trae-db-worker.ts`）。
2. **mcode 实测数据（79.7%、246 对）无脚本**：数据只存在于 mcode.ts:20、46-50 的注释，测量脚本不在本仓库四文件内。查法：`git log -S "79.7"` 定位引入提交，看同提交是否带分析脚本或文档。
3. **trae 密钥时效**：TRAE_DB_KEY_HEX（trae-db-worker.ts:20）自注「版本升级失效时需更新」，当前 Trae 版本可用性只能真机验证（代码有失败检测与明确报错，trae-db-worker.ts:130-133）。
4. **dsh 会话目录正则放宽**：`/^(session-)?[0-9a-f-]{36}$/`（dsh.ts:60）里 `[0-9a-f-]` 允许非标准 UUID 形态（如全数字或非法连字符组合），是否误收其他目录未验证。查法：真机列 `~/.dsh/sessions` 对比正则匹配集合。
5. **mcode probe 无 LIMIT**：probe 的全表查询（mcode.ts:358-361）不像 readSessionRows 有 `LIMIT 5000`，会话极多时探针成本未量化。

## 7. 建议的下一步

- 若继续深入 B 组之外的采集器（claude-code/codex/qoder/zcode/opencode），zcode 的 running 判定最复杂（硬运行 running part + 30 分钟僵死兜底 + 90 秒模糊窗，zcode.ts:9-13），可与本文 ④ 列对照成完整矩阵。
- 监控侧（radar-monitor.ts 状态机、radar-config.ts 窗口参数）与采集侧的耦合点（EXACT_BACKSTOP_MS、activeWindowMs）值得单独一篇：`activeWindowMs` 的默认值与各采集器 10 分钟窗口的关系（radar-monitor.ts:115、132-134 已出现两处使用）。
