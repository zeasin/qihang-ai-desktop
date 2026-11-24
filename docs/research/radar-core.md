# 雷达引擎侧调研（radar-core）

> 范围：`electron/radar/` 引擎内核（不含各工具采集器内部实现）+ `electron/services/agent-radar.ts` + `electron/main.ts` / `electron/preload.ts` 接线。
> 所有行号基于当前工作区快照（2026-11-24），路径相对项目根 `D:\projects\qihang-ai-desktop`。
> 结论置信：以下事实均直接取自当前仓库源码（一手代码），标注「确定」；少量注释-代码不一致单独列在第 10 节。

---

## 1. 总体架构：一写一读、一线程承载引擎

数据全部落在本地 `~/.qihang-ai-desktop/radar/`（radar-config.ts:30-33 `radarDataDir()`），包含三件东西：

| 文件 | 作用 | 代码 |
|---|---|---|
| `radar.db` | 会话/消息/状态事件正本库（WAL） | radar-db.ts:47-49 `dbPath()`；建库 radar-db.ts:71-78 |
| `fingerprints.sqlite` | 同步指纹库（游标，非聊天数据） | fingerprint-store.ts:21-24 |
| `status.json` | 最近一轮 ingest 的统计快照 | radar-config.ts:34-36；写入 radar-ingest.ts:193-200 |

进程/线程分工（agent-radar.ts:1-13 头注释有完整表述）：

- **worker 线程**（唯一一个 `Worker`，agent-radar.ts:88 创建）：承载全部采集内核——collectors + ingest + monitor + `radar.db` 写入连接 + 指纹库。重 IO/CPU（整文件解析、zstd 解压、SQLCipher 解密、批量入库）都在这里，不堵主进程。
- **主进程**：只持 `radar.db` 的**只读连接**做 UI 查询（agent-radar.ts:312-327 `queryDb()`，库文件出现后才建；radar-db.ts:60-70 只读打开失败时退回普通打开让 SQLite 完成 WAL 恢复）。所有写操作（摘要/标题写回、解冻）经 postMessage 转回 worker 写入端（agent-radar.ts:193-211，radar-worker.ts:111-119）。
- **渲染层**：只收 `radar:event` 推送 + 发起 `radar:*` invoke，不碰数据库。

两端并发安全靠 WAL + `busy_timeout=5000`（radar-db.ts:73-75 写端、:67 只读端）。

---

## 2. 双通道架构：监控通道（3s 探针）与同步通道（60s ingest）

两个通道各自独立起搏（radar-ingest.ts:1-6：「与实时监控通道完全独立（monitor loop 不依赖本引擎节奏）」），唯一交点是 `onDirty` 单向通知。

### 2.1 监控通道 RadarMonitorLoop

- 起搏：`setInterval(cfg.monitorIntervalMs)`，默认 3s（radar-monitor.ts:72；默认值来自 agent-radar.ts:42）；启动时立即 tick 一次（radar-monitor.ts:73）。
- 重入保护：`ticking` 标志，上一轮没跑完就跳过本轮（radar-monitor.ts:88-89）。
- 每轮 tick 对每个 collector 调 `probe()`，只读元数据（mtime/回合状态），**不解析消息正文**（radar-monitor.ts:27-30 注释；types.ts:37-40 HubCollector 契约）。probe 返回 `Map<sessionId, ProbeSignal>`（types.ts:26-39：`ts` 毫秒 + 可选 `running` 精确信号）。
- 三分支处理（radar-monitor.ts:109-147）：
  1. `sig.running === false`：精确空闲，立即归位 idle，不等超时（:109-118）；
  2. `sig.running === true`：直接信任探针，新会话发 running 事件、旧会话刷新 lastActivity/lastWrite（:121-130）；僵死回合由 collector 保证在有限时间内翻转为 false（types.ts:33-35 契约），监控侧另有 45 分钟兜底（`EXACT_BACKSTOP_MS`，radar-monitor.ts:25、:153-158）；
  3. 无精确信号：时间窗口推断——活动时间在 `activeWindowMs`（默认 3 分钟）内视为 running，否则忽略（:139-147）。
- 超时归位：精确会话 deadline = `max(lastWrite, startedAt) + 45min`；推断会话 = `max(lastActivity, startedAt) + idleTimeoutMs(3min)`（radar-monitor.ts:154-158）。
- 跃迁落库 + 扇出：`db.applyStateEvents(events)`（radar-monitor.ts:166；radar-db.ts:331-348 事务内写 `radar_state_event` 并 upsert `radar_session.state/state_changed_at/synced_at` 投影），随后通知全部订阅者（:167）。
- 启动自愈：先 `sweepStaleRunning(idleTimeoutMs)` 清扫上次运行残留的僵尸 running（radar-monitor.ts:55-60；radar-db.ts:322-328，心跳 = `MAX(state_changed_at, synced_at)`），再把库里仍是 running 的会话**预置**进内存 map，避免重启后重复发「开始运行」事件（radar-monitor.ts:63-70；radar-db.ts:310-319）。
- 读路径防僵尸：`stateExpr()` 在所有查询里把「running 且 `MAX(state_changed_at, synced_at)` < now-15min（`ZOMBIE_MS`）」投影为 idle，不落库（radar-db.ts:52、:301-307）。

### 2.2 同步通道 RadarIngestLoop

- 起搏：`start()` 里 15s 首轮 + `setInterval(cfg.syncIntervalMs)`（默认 60s）（radar-ingest.ts:58-63）；单飞锁 `running` 防重入（:40、:89-91）；每轮结束记录 `lastRoundEnd`（:96-99）。
- 每轮 `runRound()` 四步（radar-ingest.ts:107-186）：
  1. 取冻结集 `db.frozenIds()`（:112）；
  2. 逐 collector `listAll()` → 每个会话打 `excluded` 标（`isExcluded`，:124）→ **元数据 upsert 只取非排除会话**（:130-141）；
  3. 变更检测逐会话 `syncSession()`（跳过 excluded/冻结，:146-147），会话之间 `setImmediate` 让出事件循环，避免长同步饿死同线程的探针（:156）；
  4. 源库消失检测（指纹里有、本轮没列到 → `markMissing` 打 `missing_since` 标，:160-166）+ 自动老化冻结（见 §7.3）。
- 收尾 `finishRound()`：写 `status.json` + 回调 `onRound`（:193-200）；worker 把它 postMessage 成 `{type:'round'}`（radar-worker.ts:59-60），主进程存进 `lastRound`（agent-radar.ts:103-104）供 `radar:status` / `radar:dashboard` 透出。

### 2.3 协作点：onDirty 防抖（监控 → 同步的单向提速）

monitor tick 末尾，若本工具在 `activeWindowMs` 窗口内确有新写入（`maxActivity`），调 `onDirty(tool)`（radar-monitor.ts:132-134 精确分支、:141-142 推断分支、:172-176 触发处）。worker 把它接成 `ingest.markDirty`（radar-worker.ts:61）。

`markDirty` 的四重防抖（radar-ingest.ts:77-86）：

```ts
markDirty(tool: string): void {
  if (!this.started || this.running) return;      // ① 引擎未启动 / 正在跑一轮 → 忽略
  if (Date.now() - this.lastRoundEnd < 15_000) return;  // ② 刚跑完一轮 15s 内 → 节流
  if (this.dirtyTimer) return;                    // ③ 已有挂起的 dirty 定时器 → 合并
  this.dirtyTimer = setTimeout(() => {
    this.dirtyTimer = null;
    void this.syncNow(`dirty:${tool}`);           // ④ 再等 2s 执行（去抖）
  }, 2_000);
}
```

效果：3s 探针的高频 dirty 信号被压成「最快每 15s 提前触发一轮」，且多个工具的 dirty 合并进同一个 2s 定时器（单 `dirtyTimer` 字段，:46——后到者只覆盖触发原因 `dirty:${tool}`，不叠加轮次）。markDirty 只 set 定时器，**永不阻塞监控 tick**（radar-monitor.ts:28-30 注释「防抖在 ingest 侧，不阻塞监控」）。

---

## 3. 工作线程模型与渲染层状态跃迁链路

### 3.1 worker 内组装（radar-worker.ts:41-75）

`start(payload)` 依次：

1. `new RadarDb(root)`（写端，建表/迁移）+ `new FingerprintStore(root)`（:43-44）；
2. 价值分校准：`db.refreshValueScores()` 启动一次 + 每 10 分钟滚动重算（:46-57；radar-db.ts:393-406）；
3. `collectors = defaultCollectors(cfg)`（:58；registry.ts:14）；
4. `ingest = new RadarIngestLoop(...)`，`ingest.onRound = stat => post({type:'round', stat})`（:59-60）；
5. `monitor = new RadarMonitorLoop(db, collectors, cfg, tool => ingest?.markDirty(tool))`（:61）——**onDirty 在这里接线**；
6. `monitor.onStateEvents(events => ...)`：先对 idle 收口会话落规则价值分 `saveValueScore(computeValueScore(...))`，再 `post({type:'state', events})`（:62-70；打分逻辑 radar-db.ts:354-384）；
7. `ingest.start(); monitor.start();`（:71-72），最后 `post({type:'ready', collectors})`（:74）。

消息协议（radar-worker.ts:5-6、:20-28）：

- 主 → 线程：`start` / `scan-now` / `stop` / `unfreeze` / `save-summary` / `save-title`；
- 线程 → 主：`ready` / `state` / `round` / `error`。

另有 `workerData` 兜底：Worker 构造参数直接带 `{cfg, root}`，线程起来即自动 start，避免主进程错过 start 消息窗口（radar-worker.ts:128-131；agent-radar.ts:88 同时传了 `workerData`）。

### 3.2 状态跃迁到渲染层的完整链路

```
collector.probe()                       （worker 线程内，3s 一次）
  → RadarMonitorLoop.tick() diff 出 StateEvent[]（radar-monitor.ts:87-180）
  → db.applyStateEvents(events)         （radar_state_event 落库 + session.state 投影，radar-monitor.ts:166）
  → monitor 订阅者（radar-worker.ts:62-70）：
      idle 会话先算价值分落库，再 postMessage {type:'state', events}
  → 主进程 worker.on('message')          （agent-radar.ts:92-99）
  → AgentRadarService.subs 扇出          （agent-radar.ts:65-68）
  → main.ts:2161 订阅：
      agentRadar.onStateEvents(events => sendToRenderer('radar:event', {type:'state', events}))
  → sendToRenderer → webContents.send   （main.ts:287-289）
  → preload VALID_CHANNELS 白名单含 'radar:event'（preload.ts:3-9，第 8 行）
      window.electronAPI.on(channel, cb) 校验白名单后 ipcRenderer.on（preload.ts:332-336）
```

主进程的另一个订阅者是提炼层：`startRadarDigest()` → `agentRadar.onStateEvents`，只取 `idle` 事件入队做 AI 摘要（radar-digest.ts:34-42；门槛 `MIN_SCORE=3`、`MIN_NEW_MSGS=4`、收口后延迟 20s 等 ingest 采完尾消息，radar-digest.ts:17-19）。

`state` 之外，渲染层还拿 `round`（agent-radar.ts:103-104 存 `lastRound`，随 `radar:status`/`dashboard` 透出）和 `ready`（:92-97：记录 collector 清单、`runningFlag=true`、重启计数清零）。

---

## 4. 指纹增量机制：Fingerprint + delta/full + seq 幂等写入

### 4.1 指纹库

```ts
export interface Fingerprint {
  sourceUpdatedAt: number;   // 上次同步时源库 updated_at（毫秒）
  messageCount: number;      // 上次同步时的有效消息条数
  lastSyncedSeq: number;     // 已同步到的最大 seq
}
```
（fingerprint-store.ts:12-16）

- 存储：`fingerprints.sqlite` 表 `fp`，列 `source_updated_at/message_count/last_synced_seq`，PK `(tool, session_id)`（fingerprint-store.ts:29-43）。
- 语义注释明确（fingerprint-store.ts:2-7）：这是**同步游标而非聊天数据**；删掉后下一轮凭本地库 `last_synced_seq` 续传或全量重建；**只有本地写入成功后才前进**。
- `ids(tool)` 返回该工具全部已采集会话 id，供消失检测用（:67-70）。

### 4.2 单会话增量决策（radar-ingest.ts:204-274 `syncSession`）

1. **指纹丢失回退**：指纹不在时，用本地库权威游标 `db.sessionState()` 重建 fp（:213-218；radar-db.ts:240-244）——崩溃安全的关键：库和游标同事务前进，指纹文件丢了也不重头采。
2. **跳过判定**：有指纹且 `updatedAtMs === fp.sourceUpdatedAt` → `skipped`；唯一例外是「源里有标题而本地标题为空」时补写一次（标题提取规则升级后回填，:234-237）。
3. **模式决策**（:239-257）：
   - 无指纹 → `full`；
   - 有指纹且 `lastSyncedSeq>0 && messageCount>0`：把全部消息解析出来算 `normalizedCount`（过滤空消息后的条数，:278-280）：
     - `totalCount < fp.messageCount` → `full`（源缩水，重采覆盖）；
     - `totalCount > max(fp.messageCount, localSeq)` → `delta`，`fromSeq = localSeq`；
     - 其余（条数未增长）→ `full`（幂等重写一遍）。
4. **组装写库包 `buildPack`**（:283-320）：
   - `seq = i + 1` **先按解析序号编号、再过滤空消息**（:296-306）——空消息占号被滤掉，seq 存在空位；注释「与全部解析结果一致，delta 靠它对齐」（:282）；
   - 截断：正文/思考 `MAX_CONTENT=200KB`、工具字段 `MAX_TOOL_FIELD=2KB`（:15-16、:299-304）；
   - delta 只取 `seq > fromSeq`（:307）；`lastSyncedSeq = maxSeq`（最后一条的 seq，:308、:317）；`messageCount = all.length`（过滤后条数，:311）。
   - 注意口径：`messageCount` 是**过滤后**条数，`lastSyncedSeq` 是**原始解析序号**上限，二者不必相等；delta 判据 `totalCount > max(fp.messageCount, localSeq)` 把两种口径取 max 比较，是保守方向（拿不准就 full）。
5. **事务写入 `db.applyMessages`**（radar-db.ts:199-238，全程 `withTx` BEGIN/COMMIT/ROLLBACK，:748-753）：
   - `full` 先 `DELETE FROM radar_message WHERE tool=? AND session_id=?`（:205-207）再整段 upsert；
   - 消息 upsert `ON CONFLICT(tool, session_id, seq) DO UPDATE SET ...`（:209-218）——**seq 幂等**：同一批消息重放不产生重复行，重复写等价覆盖；
   - 会话游标同一事务内前进：full 模式 `message_count/last_synced_seq` 直接取新值、delta 模式取 `MAX(旧值, 新值)` 只前进（:220-236，模板里按 `mode` 插入 `1/0` 选择分支）；
6. **写库成功后才 `advance()` 指纹**（radar-ingest.ts:273）：指纹前进独立于库事务、且严格在库提交之后——中途崩溃最多是「下轮重写一遍幂等数据」，不会出现指纹超前于数据。

### 4.3 源缩水与解冻重建

- 源缩水（totalCount < messageCount）或 `unfreeze`（清冻结 + 指纹归零 `fps.set(tool, sid, {0,0,0})` + 立即 `syncNow('unfreeze')`，radar-worker.ts:101-110）都会走 full 全量重建，`DELETE` + 重插保证与源一致。

---

## 5. radar-config 配置全景

### 5.1 RadarConfig 接口（radar-config.ts:10-25）

| 键 | 含义 | 默认值 | 组装处 | 主要消费处 |
|---|---|---|---|---|
| `tools: string[]` | 启用的工具；空 = 全部 | `[]`（全启用） | agent-radar.ts:32-34 读 `agentRadarTools`，按逗号拆分并过滤进 ALL_TOOLS | registry.ts:15 |
| `excludeProjects: string[]` | 排除的项目目录（大小写不敏感，含子目录） | `[]` | agent-radar.ts:35-37 读 `agentRadarExclude`，按 `[,;\n]` 拆分 | radar-ingest.ts:124（唯一消费点） |
| `autoFreezeDays` | 活跃会话超 N 天无动静自动冻结，0=关 | **硬编码 30** | agent-radar.ts:40 | radar-ingest.ts:168-181 |
| `syncIntervalMs` | 同步轮间隔（对话入库通道） | `numCfg('agentRadarIntervalMs', 60_000)` | agent-radar.ts:41 | radar-ingest.ts:61 |
| `monitorIntervalMs` | 探针间隔（实时监控通道） | `numCfg('agentRadarMonitorMs', 3_000)` | agent-radar.ts:42 | radar-monitor.ts:72 |
| `activeWindowMs` | 探针活跃窗口（窗口内有写入算运行/才触发 dirty） | **硬编码 3 分钟** | agent-radar.ts:43 | radar-monitor.ts:115、:132、:140 |
| `idleTimeoutMs` | running 超时无新活动 → idle | **硬编码 3 分钟** | agent-radar.ts:44 | radar-monitor.ts:57、:157；radar-db.ts:322 |

`numCfg`（agent-radar.ts:19-23）：配置值必须是有限正数才采纳，否则用默认；`boolOn`（:24-26）：字符串 `'1'` 为真。

### 5.2 config.json 键清单与读取处

配置唯一组装入口是 `buildConfig()`（agent-radar.ts:31-45），worker 起线程时整体带过去（agent-radar.ts:88，radar-worker.ts:43）。应用侧键：

| config.json 键 | 读取处 | 设置页透出处（main.ts） |
|---|---|---|
| `agentRadarEnabled` | agent-radar.ts:74-76 `isEnabled()`；main.ts:1247-1248 保存；main.ts:2164 判断自启 | main.ts:1872（默认 `'0'`，即默认关） |
| `agentRadarIntervalMs` | agent-radar.ts:41 | main.ts:1873（默认 `'60000'`） |
| `agentRadarMonitorMs` | agent-radar.ts:42 | main.ts:1874（默认 `'3000'`） |
| `agentRadarExclude` | agent-radar.ts:35 | main.ts:1875（默认 `''`） |
| `agentRadarTools` | agent-radar.ts:32（**main.ts 设置块未透出**，全仓库仅此一处读取） | —（grep 证实） |

### 5.3 ALL_TOOLS 清单（radar-config.ts:27）

```ts
export const ALL_TOOLS = ['zcode', 'claude-code', 'codex', 'opencode', 'qoder', 'trae', 'dsh', 'pi', 'mcode'] as const;
```

共 **9 个**。注意 radar-config.ts:11 注释写「空 = 全部 8 个」——**注释过时**（见 §10.1）。

### 5.4 其他工具函数

- `radarDataDir()` / `radarStatusFile()` / `ensureDataDir()`（radar-config.ts:30-36、:53-58）；
- `normalizeDir`（:39-41）：分隔符统一成 `\`、去尾、小写；
- `isExcluded`（:43-51）：目录等于排除项或以 `排除项\` 为前缀（子目录递归排除）即命中——见 §8.4。

---

## 6. collectors/registry 注册表：新增一个 collector 要改几处

### 6.1 注册表结构（registry.ts:14-35）

```ts
export function defaultCollectors(cfg: RadarConfig): HubCollector[] {
  const enabled = new Set(cfg.tools.length ? cfg.tools : [...ALL_TOOLS]);   // :15 空=全启
  const factories: [string, () => HubCollector][] = [                        // :16-27 有序工厂表
    ['zcode', () => new ZcodeCollector()],
    ['qoder', () => new QoderCollector()],
    ['opencode', () => new OpenCodeCollector()],
    ['claude-code', () => new ClaudeCodeCollector()],
    ['codex', () => new CodexCollector()],
    ['pi', () => new PiCollector()],
    ['trae', () => new TraeCollector()],
    ['dsh', () => new DshCollector()],
    ['mcode', () => new McodeCollector()],
  ];
  for (const [tool, factory] of factories) {
    if (!enabled.has(tool)) continue;             // :29 配置未启用 → 跳过
    try { out.push(factory()); }                  // :31
    catch (e) { console.log(`[RADAR-REGISTRY] ${tool} collector init failed: ...`); }  // :32-34 单个失败不影响其余
  }
}
```

契约接口 `HubCollector`（types.ts:42-48）：`readonly tool: string` + 四个方法 `listAll(): Promise<SessionInfo[]>` / `loadMessages(s): Promise<SerializedMessage[]>` / `probe(): Promise<Map<string, ProbeSignal>>` / `dispose(): Promise<void>`。数据结构见 types.ts:3-14（SessionInfo）、:17-24（SerializedMessage）、:26-39（ProbeSignal）。

### 6.2 新增 collector 的必改清单

1. **实现文件**：新建 `electron/radar/collectors/<tool>.ts`，实现 `HubCollector`（types.ts:42-48）；
2. **registry.ts**：顶部 import + `factories` 数组加一项（registry.ts:16-27 之间，顺序即 ingest/monitor 的遍历顺序）；
3. **radar-config.ts:27**：`ALL_TOOLS` 加入新工具 id——否则 (a) `buildConfig` 的白名单过滤会把 `agentRadarTools` 里的新 id 直接丢掉（agent-radar.ts:32-34），(b) 空配置回退 `[...ALL_TOOLS]` 时也不会启用它（registry.ts:15）。

做完这三步，引擎侧（ingest/monitor/指纹/落库/UI 透出 `status().allTools`，agent-radar.ts:217-219）自动生效；数据库无枚举约束（`tool` 是自由 TEXT，radar-db.ts:83-84）。另：radar-db.ts:1-8 头注释的 tool 枚举还停在 8 个（缺 mcode），新工具不必改它，但该注释已过时（§10.2）。

外部工具 SQLite 的只读打开约定在 sqlite-open.ts:12-21 `openSqliteReadonly`：先 `readOnly` 打开，失败（WAL 需恢复且无写入方持 -shm）退回普通打开让 SQLite 完成恢复；库不存在返回 null（工具未安装按空列表处理）。

---

## 7. radar-db 表结构、FTS 与冻结机制

### 7.1 三张业务表 + FTS（migrate，radar-db.ts:80-156）

**`radar_session`**（:82-99，PK `(tool, session_id)`）：

| 列 | 说明 |
|---|---|
| `project_dir` | 项目目录，入库前统一小写（`normProject`，:160-168——SQLite 默认区分大小写，Windows 路径 `D:\x`/`d:\x` 会分裂成两行） |
| `title` / `message_count` | 元数据；upsert 时 `message_count` 取 `MAX` 只增（:185） |
| `source_updated_at` / `source_created_at` | 源侧时间戳（毫秒 epoch；updated 取 MAX，created 只在为 0 时补） |
| `captured_at` / `synced_at` | 本地采集/最近一轮同步心跳时间 |
| `last_synced_seq` | 本地权威游标（指纹丢失时的续传依据，:240-244） |
| `state` / `state_changed_at` | running/idle 投影 |
| `frozen` / `frozen_reason` | 冻结标记（见 §7.3） |
| `missing_since` | 源库消失打标时间（`markMissing`，:254-261；只在为 0 时写入） |
| `value_score` / `summary` / `summary_msg_count` / `summary_at` | 提炼层字段，增量迁移补列（:147-156，node:sqlite 无 `ALTER IF NOT EXISTS`，按 `PRAGMA table_info` 判断） |

索引：`source_updated_at` / `state` / `frozen` / `project_dir`（:100-103）。

**`radar_message`**（:105-115，PK `(tool, session_id, seq)`）：`role/content/thinking/tools_json/ts`；索引 `ts`（:116）。

**`radar_state_event`**（:118-124）：自增 id + `tool/session_id/state/ts`，状态时间线；索引 `ts` 与 `(tool, session_id)`（:125-126）。

**FTS5**（:129-143）：`radar_message_fts` 外部内容表（`content='radar_message', content_rowid='rowid'`），`tokenize='trigram'`——中文按三字 gram 可全文检索；三个触发器 `radar_message_ai/ad/au` 在消息 INSERT/DELETE/UPDATE 时同步维护 FTS（:132-143）。检索侧：≥3 连续字符走 FTS MATCH（多词 OR + BM25 排序），2 字中文词回退 LIKE（`ftsTerm`/`searchMessages`，:474-521 附近）；BM25 只能出现在最外层 MATCH 查询，CTE 里用 `rank` 列（`findSessions` 内注释）。

### 7.2 PRAGMA 与事务

写端：`journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`、`foreign_keys=ON`（radar-db.ts:71-78）。事务封装 `withTx`（:748-753）：BEGIN → fn → COMMIT，异常 ROLLBACK 重抛。元数据 upsert（:172-193）、消息写入（:199-238）、状态事件（:331-348）、missing 打标（:254-261）、冻结（:263-268）全部走事务。

### 7.3 冻结（frozen）机制

**冻结的三个入口：**

1. **自动老化**（唯一自动入口）：`cfg.autoFreezeDays(30) > 0` 时，每轮对「已采集（有指纹）、非冻结、非排除、`source_updated_at < now - N天`」的会话 `setFrozen(tool, ids, true, 'auto-age')`（radar-ingest.ts:168-181；`autoFrozen` 计数进轮统计）。
2. **手动解冻 → 强制重采**：IPC `radar:unfreeze`（main.ts:1314-1320）→ `agentRadar.unfreeze` postMessage（agent-radar.ts:182-189）→ worker 端 `db.setFrozen(false,'')` + 指纹归零 + `syncNow('unfreeze')`（radar-worker.ts:101-110），下一轮按 full 重建。
3. `setFrozen` 本身只是 UPDATE `frozen/frozen_reason`（radar-db.ts:263-268）。

**冻结的语义边界（只停采集，不停展示）：**

- ingest 每轮开头取 `frozenIds()`（radar-ingest.ts:112），写消息前跳过冻结会话（:147）；
- 但冻结会话**仍参与**元数据 upsert（metas 只按排除过滤，:130-141）、消失判定（listedIds 含全部会话，:161）、检索与摘要：`sessionsNeedingSummary` 明示含冻结会话（radar-db.ts:421-438「冻结只停采集，已采数据摘要照常」）、`searchSessionsByText` 同理（radar-db.ts:544-549 注释）；
- 冻结不删数据：`radar_message` 原样保留，FTS 同步维护。

---

## 8. agent-radar 服务：启停、自愈、排除目录过滤

### 8.1 start（agent-radar.ts:78-123）

1. 幂等 guard：`runningFlag || worker` 已在跑则直接返回（:79-81）；
2. `stopping=false`、清重启定时器（:82-83）；
3. `buildConfig()` + `ensureDataDir()`（:83-84）；
4. worker 脚本定位 `workerJsPath()`（:49-52）：`__dirname/../radar/radar-worker.js` 并把 `app.asar` 替换成 `app.asar.unpacked`（打包后 worker 在 asar 外）；文件不存在直接抛错（:84-87）；
5. `new Worker(jsPath, { workerData: { cfg, root } })`（:88）——`workerData` 兜底启动见 §3.1；
6. 三个监听：`message`（:90-109：ready→runningFlag+清零重启计数；state→subs 扇出；round→lastRound；error→log）、`error`（:106-110 崩溃日志+runningFlag=false）、`exit`（:111-120：清理引用并调 `scheduleRestart()`）。

### 8.2 自动重启（自愈，agent-radar.ts:125-141）

- 条件：非主动 stop（`stopping`）、当前无 worker、无挂起定时器、且 `isEnabled()`；
- 延迟：`min(5000 * 2^(attempts-1), 60000)`——5s 起步指数退避、60s 封顶；worker `ready` 后 `restartAttempts=0`（:94-97）。

### 8.3 stop（agent-radar.ts:148-167）

`stopping=true` → 清重启定时器 → `postMessage({type:'stop'})` → 等 `exit` 最多 **2.5s**，超时 `worker.terminate()`（:159-166）。注释明示：强杀由 WAL 保证不脏库。worker 端收到 stop 会先 `stop()`（monitor/ingest/collectors/fps/db 依次收尾，radar-worker.ts:77-93）再 `process.exit(0)`（:121）。

**生命周期接线（main.ts）：**

- 启动：`app ready` 后 `agentRadar.onStateEvents(...)` 注册推送（main.ts:2161）、`startRadarDigest()`（:2163）、`isEnabled()` 才 `agentRadar.start()`（:2164-2166）——**默认关，用户在设置页显式开启**（:2160 注释）；
- 开关：`radar:set-enabled`（main.ts:1245-1256）保存 `agentRadarEnabled` 并 start/stop + 刷新托盘；
- 手动扫描：`radar:scan-now`（:1257-1266）——未运行但已启用会先补启动；
- 退出：托盘退出菜单（:180-182）与窗口关闭流程（:2200-2202）都调 `stopAllServices()`（:251-259，其中 :255 `agentRadar.stop()`）；
- 服务状态上报：`getServicesStatus()` 里 `radar: agentRadar.isRunning()`（:265）。

### 8.4 排除目录过滤（agentRadarExclude）

过滤只发生在 **ingest 通道**，且只有一处判定函数 `isExcluded`（radar-config.ts:43-51；全仓库 grep 证实唯一调用点 radar-ingest.ts:124）：

1. 归一化（radar-config.ts:39-41）：`/` 与 `\` 统一为 `\`、去尾分隔符、转小写——**大小写不敏感、盘符大小写不敏感**；
2. 匹配规则（:46-50）：目录**等于**排除项，或以 `排除项 + '\'` 为前缀（**子目录递归排除**）；空目录不排除（:44）；
3. 配置切分（agent-radar.ts:35-37）：支持逗号/分号/换行多种分隔。

生效的三处（radar-ingest.ts runRound 内）：

- 元数据 upsert 只收非排除会话（:130-141）；
- 增量写库跳过排除会话（:146-147 `if (s.excluded || frozenSet.has(...)) continue`）;
- 消失判定**包含**排除会话（:160-166——排除会话若曾被采集过，本轮列到了就不会误标 missing）。

重要边界：**monitor 探针不做排除过滤**——引擎侧 `probe()` 结果不经 `isExcluded`（grep 证实），排除目录下的会话仍会出现在 running/idle 状态监控里，只是对话不采集。另监控通道的过滤（如有）属各 collector 内部行为，超出本次范围。

---

## 9. main.ts / preload.ts 接线清单

### 9.1 IPC handlers（main.ts:1243-1377）

| 通道 | 行号 | 作用 |
|---|---|---|
| `radar:status` | :1244 | enabled/running/dataDir/collectors/allTools/lastRound/stats（agent-radar.ts:213-224） |
| `radar:set-enabled` | :1245-1256 | 保存 `agentRadarEnabled` + start/stop + 托盘刷新 |
| `radar:scan-now` | :1257-1266 | 手动触发一轮（enabled 未运行先启动） |
| `radar:tool-stats` | :1267 | 各工具会话/运行统计（radar-db.ts toolStats） |
| `radar:brief` | :1268 | getBrief（radar-brief） |
| `radar:dashboard` | :1269 | 工具卡片 + 最近跃迁 + 最近会话（agent-radar.ts:236-243） |
| `radar:sessions` | :1270-1280 | 列表/搜索分页 |
| `radar:messages` | :1281-1287 | 会话消息流 |
| `radar:state-events` | :1288-1294 | 状态时间线 |
| `radar:session-info` | :1295-1301 | 单会话元信息 |
| `radar:summaries` | :1302-1313 | 摘要分页（含关键词） |
| `radar:unfreeze` | :1314-1320 | 解冻重采 |
| `radar:search` | :1321-1327 | 消息级 FTS/LIKE 检索 |
| `radar:ask` | :1329-1335 | 问雷达（检索→AI 汇总） |
| `radar:digest-backfill` | :1337-1342 | 存量补摘要 |
| `radar:followup` | :1347-1377 | 追问注入（`claude-code`→`claude` 映射，:1349-1350 注释） |

所有查询 handler 都走主进程只读连接（agent-radar.ts:312-327 `queryDb()`：`radar.db` 文件出现后才建，只读打开失败降级普通打开）。

### 9.2 设置页配置透出（main.ts:1872-1875）

`agentRadarEnabled`（默认 `'0'`）/ `agentRadarIntervalMs`（`'60000'`）/ `agentRadarMonitorMs`（`'3000'`）/ `agentRadarExclude`（`''`）。`agentRadarTools` 不在此块中（渲染层经通用配置保存接口写，服务侧 agent-radar.ts:32 读取）。

### 9.3 preload（preload.ts）

- 推送白名单 `VALID_CHANNELS` 含 `'radar:event'`（:3-9，第 8 行）；通用 `on` 助手校验白名单后 `ipcRenderer.on`（:332-336）；
- `electronAPI.radar` 命名空间（:96-117）：status :98 / setEnabled :99 / scanNow :100 / toolStats :101 / brief :102 / dashboard :103 / sessions :104-105 / messages :106 / stateEvents :107 / sessionInfo :108 / summaries :109-110 / unfreeze :111 / search :112 / ask :113 / digestBackfill :114 / followup :115-116。

---

## 10. 发现的注释-代码不一致（按证据等级：一手代码为准）

1. **工具数量注释过时**：radar-config.ts:11「启用的工具（空 = 全部 8 个）」vs `ALL_TOOLS` 实际 9 个（radar-config.ts:27，含 mcode）。行为以代码为准：空配置启用全部 9 个（registry.ts:15）。确定。
2. **radar-db 头注释 tool 枚举缺 mcode**：radar-db.ts:1-8 列了 8 个工具；表结构无枚举约束（TEXT），mcode 会话照常入库。确定（注释过时，不影响行为）。
3. **buildPack 注释措辞含糊**：radar-ingest.ts:282「seq 在过滤空消息后按序编号」，实现实为**先按解析序号编号、后过滤空消息**（:296-306）——空消息占号被滤，seq 有空位；「与全部解析结果一致」指的是 delta/full 两种模式编号规则一致。后果：`messageCount`（过滤后条数）≤ `lastSyncedSeq`（最大 seq），delta 增长判据 `totalCount > max(fp.messageCount, localSeq)` 因此偏保守（拿不准走 full，安全方向）。行为确定，注释措辞不精确。
4. **部分参数不可配置**：`autoFreezeDays=30`、`activeWindowMs=3min`、`idleTimeoutMs=3min` 在 buildConfig 里硬编码（agent-radar.ts:40、:43-44），config.json 只能调 Enabled/IntervalMs/MonitorMs/Exclude/Tools 五个键。确定。

---

## 11. 待证项与建议下一步

- **渲染层消费端**：`window.electronAPI.on('radar:event', ...)` 的订阅组件在 `src/` 下（本次范围限引擎侧，未查）；建议 `grep -r "radar:event" src/`。
- **app-config 存储介质**：`appConfig.getConfig` 的具体实现（config.json 路径/写入时机）未读，radar-config.ts:6 注释称「数值来自应用 config.json」；建议查 `electron/services/app-config.ts`。
- **collector 侧 probe 是否各自做排除过滤**：引擎侧不过滤，若产品语义要求「排除目录不出现在监控里」，需逐 collector 核对（如 claude-code 的 probe 是否按 projectDir 过滤）。
- **worker 'error' 消息与 'error' 事件的差异路径**：agent-radar.ts:106-110 的 `worker.on('error')` 与 :104-105 的 `{type:'error'}` 消息分别对应线程异常与业务报错，崩溃重启只挂在 exit 事件上（:111-120）——两者触发顺序对自愈时序的影响可进一步验证（需复现崩溃场景）。
