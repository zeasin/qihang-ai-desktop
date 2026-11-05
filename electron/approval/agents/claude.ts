import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentAdapter, AgentDeps } from "./base";
import type { AgentKind, AgentSession, Decision } from "../types";
import logger from "../../services/logger";

/**
 * Claude Code 适配器（从 SDK query() 移植为裸 CLI spawn，去掉 @anthropic-ai/claude-agent-sdk 依赖）：
 * - 每轮一个进程：claude -p --input-format stream-json --output-format stream-json --verbose
 *   --include-partial-messages --permission-prompt-tool=stdio --settings <disableAllHooks 文件>
 *   [--resume <会话id>]，cwd = 会话目录；
 * - 权限：CLI 经 stdout 发 control_request(can_use_tool) → 本进程桥到飞书审批 → stdin 写
 *   control_response（allow/deny/allow_session）；
 * - disableAllHooks：托管会话不走用户 hook——权限由 control 协议承接（避免双审批），
 *   回合结束由 result 消息收口（避免 Stop hook 双报任务 + 30s 挂起）；
 * - Windows：npm 装的 claude 是 .cmd shim，Node 无法直接 spawn（ENOENT/EINVAL）→ shell:true
 *   交给 cmd 解析；杀进程用 taskkill /T /F 清整棵树防孤儿；
 * - 看门狗 5 分钟：长命令空窗正常，挂起中的审批只续期不强杀；挂死则杀进程按失败收口。
 */

const IDLE_TIMEOUT_MS = 5 * 60_000;

interface PendingPermission {
  resolve: (result: any) => void;
  input: any;
  suggestions?: any[];
  toolUseID: string;
}

interface ClaudeSession {
  s: AgentSession;
  sdkSessionId: string | null;
  proc: ChildProcessWithoutNullStreams | null;
  aborted: boolean;
  /** 看门狗硬中止标记：按失败收口而非用户中止 */
  hardKilled: boolean;
  pending: Map<string, PendingPermission>;
  idleTimer: NodeJS.Timeout | null;
}

function summarizeClaudeInput(toolName: string, input: any): { summary: string; detail: string } {
  let json = "";
  try { json = JSON.stringify(input) ?? ""; } catch { json = String(input); }
  let detail = json;
  if (toolName === "Bash" && typeof input?.command === "string") {
    detail = input.command;
  } else if (toolName === "Write" && typeof input?.file_path === "string") {
    detail = `${input.file_path}\n${String(input.content ?? "").slice(0, 1500)}`;
  } else if (toolName === "Edit" && typeof input?.file_path === "string") {
    detail = `${input.file_path}\n- ${String(input.old_string ?? "").slice(0, 600)}\n+ ${String(input.new_string ?? "").slice(0, 1200)}`;
  }
  return { summary: json.slice(0, 200), detail: detail.slice(0, 2000) };
}

export class ClaudeAdapter implements AgentAdapter {
  readonly kind: AgentKind = "claude";
  private sessions = new Map<string, ClaudeSession>();
  /** disableAllHooks settings 文件（静态内容，首次用时落盘） */
  private settingsFile: string | null = null;

  constructor(private deps: AgentDeps, private opts?: { claudePath?: string }) {}

  async createSession(opts: { cwd: string; title?: string; resume?: string }): Promise<AgentSession> {
    if (!fs.existsSync(opts.cwd)) throw new Error(`项目目录不存在: ${opts.cwd}`);
    const s: AgentSession = {
      id: `claude-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      agent: this.kind,
      cwd: opts.cwd,
      title: opts.title || "Claude 会话",
      status: "starting",
      createdAt: new Date().toISOString(),
      externalId: opts.resume || undefined,
    };
    const cs: ClaudeSession = {
      s,
      sdkSessionId: opts.resume || null,
      proc: null,
      aborted: false,
      hardKilled: false,
      pending: new Map(),
      idleTimer: null,
    };
    this.sessions.set(s.id, cs);
    s.status = "idle";
    this.deps.onSessionUpdate(s);
    return s;
  }

  private entry(sessionId: string): ClaudeSession {
    const cs = this.sessions.get(sessionId);
    if (!cs) throw new Error(`claude 会话不存在: ${sessionId}`);
    return cs;
  }

  private transcribe(cs: ClaudeSession, kind: "text" | "thinking" | "tool" | "system", text: string): void {
    if (!text) return;
    this.deps.onTranscript(cs.s.id, { ts: new Date().toISOString(), kind, text });
  }

  /** disableAllHooks settings 文件（与 approver.ts 的 approvalDataDir 同目录） */
  private managedSettingsFile(): string {
    if (this.settingsFile) return this.settingsFile;
    const dir = path.join(os.homedir(), ".qihang-ai-desktop", "approval");
    fs.mkdirSync(dir, { recursive: true });
    this.settingsFile = path.join(dir, "claude-managed-settings.json");
    fs.writeFileSync(this.settingsFile, JSON.stringify({ disableAllHooks: true }));
    return this.settingsFile;
  }

  /** spawn claude CLI（shell:true 解析 npm 的 .cmd shim；settings 走文件避开 shell 引号） */
  private spawnClaude(cs: ClaudeSession): ChildProcessWithoutNullStreams {
    const args = [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-prompt-tool=stdio",
      "--settings", this.managedSettingsFile(),
    ];
    if (cs.sdkSessionId) args.push("--resume", cs.sdkSessionId);
    const cmd = this.opts?.claudePath || "claude";
    logger.info("[Approver][claude] %s spawn: %s %s", cs.s.id, cmd, JSON.stringify(args));
    return spawn(cmd, args, {
      cwd: cs.s.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    }) as ChildProcessWithoutNullStreams;
  }

  /** 杀进程：Windows 用 taskkill /T /F 清整棵树（shell:true 下 pid 是 cmd 的，claude 是子进程） */
  private killProc(cs: ClaudeSession): void {
    const proc = cs.proc;
    if (!proc || proc.killed || proc.exitCode !== null) return;
    cs.proc = null;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        proc.kill("SIGKILL");
      }
    } catch { /* ignore */ }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const cs = this.entry(sessionId);
    if (cs.proc) throw new Error("该会话已有任务在跑，先等完成或中止");

    cs.aborted = false;
    cs.hardKilled = false;
    cs.s.status = "running";
    cs.s.lastError = undefined;
    this.deps.onSessionUpdate(cs.s);

    let idleTimedOut = false;
    let turnComplete = false;
    let exitCode: number | null = null;
    let stderrText = "";

    try {
      const proc = this.spawnClaude(cs);
      cs.proc = proc;

      // 看门狗（同 SDK 版：挂起审批续期，挂死杀进程按失败收口）
      const armIdleTimer = (): void => {
        if (cs.idleTimer) clearTimeout(cs.idleTimer);
        cs.idleTimer = setTimeout(() => {
          // 等手机审批是合法长空窗：续期而不是杀会话
          if (cs.pending.size > 0) { armIdleTimer(); return; }
          logger.warn("[Approver][claude] %s 超过 5 分钟无消息，判定卡死并中断", cs.s.id);
          idleTimedOut = true;
          cs.hardKilled = true;
          this.rejectPending(cs, "Claude 空闲超时");
          this.killProc(cs);
        }, IDLE_TIMEOUT_MS);
      };
      armIdleTimer();

      // 发起本轮（CLI 就绪前写入由管道缓冲，CLI 启动后即读）
      try {
        proc.stdin.write(JSON.stringify({
          type: "user",
          session_id: "",
          message: { role: "user", content: [{ type: "text", text }] },
          parent_tool_use_id: null,
        }) + "\n");
      } catch { /* 进程可能已退出，exit 事件收口 */ }

      // stdout 行解析：队列 + 串行泵（permission 桥是异步的，不能并发处理行）
      let buf = "";
      const queue: string[] = [];
      let pumping = false;
      let finished = false;
      let sawStreamEvent = false;
      let seenEndTurn = false;
      let toolAccu: { name: string; args: string } | null = null;
      let textAccu = "";
      let thinkAccu = "";

      const handleLine = async (line: string): Promise<void> => {
        let msg: any;
        try { msg = JSON.parse(line); } catch { return; }
        armIdleTimer();
        if (cs.aborted || finished) return;

        // session id 捕获（init/assistant/user/result 等消息带 session_id）
        if (msg.session_id && typeof msg.session_id === "string") {
          cs.sdkSessionId = msg.session_id;
          cs.s.externalId = msg.session_id;
        }

        if (msg.type === "control_request") {
          if (msg.request?.subtype === "can_use_tool") {
            const resp = await this.handleCanUseTool(cs, msg);
            if (finished || cs.aborted) return;
            try {
              proc.stdin.write(JSON.stringify({
                type: "control_response",
                response: { subtype: "success", request_id: msg.request_id, response: resp },
              }) + "\n");
            } catch { /* EPIPE */ }
          }
          return;
        }
        if (msg.type === "control_cancel_request") {
          // CLI 取消了权限请求：挂起的审批按拒绝收口，避免 promise 悬挂
          const p = cs.pending.get(msg.request_id);
          if (p) {
            cs.pending.delete(msg.request_id);
            p.resolve({ behavior: "deny", message: "请求已取消", interrupt: false, toolUseID: p.toolUseID });
          }
          return;
        }

        // ---- 转录（与 SDK 版一致：stream_event 流式 / assistant 补发 / result 权威收口） ----
        switch (msg.type) {
          case "stream_event": {
            sawStreamEvent = true;
            const ev = msg.event || {};
            switch (ev.type) {
              case "message_delta":
                if (ev.delta?.stop_reason === "end_turn") seenEndTurn = true;
                break;
              case "content_block_start": {
                const block = ev.content_block || ev.contentBlock || {};
                if (block.type === "text") textAccu = "";
                else if (block.type === "thinking") thinkAccu = block.thinking || "";
                if (block.type === "tool_use") {
                  toolAccu = { name: block.name || "", args: JSON.stringify(block.input ?? {}) };
                  this.transcribe(cs, "tool", `▶ ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 300)}`);
                }
                break;
              }
              case "content_block_delta": {
                const delta = ev.delta || {};
                if (delta.type === "text_delta" && delta.text) textAccu += delta.text;
                else if (delta.type === "thinking_delta" && delta.thinking) thinkAccu += delta.thinking;
                else if (delta.type === "input_json_delta" && toolAccu && delta.partial_json) {
                  try { toolAccu.args = JSON.stringify(JSON.parse(delta.partial_json)); } catch { /* 分片 JSON 不完整 */ }
                }
                break;
              }
              case "content_block_stop":
                if (textAccu) { this.transcribe(cs, "text", textAccu); textAccu = ""; }
                if (thinkAccu) { this.transcribe(cs, "thinking", thinkAccu); thinkAccu = ""; }
                if (toolAccu) { this.transcribe(cs, "tool", `✔ ${toolAccu.name}`); toolAccu = null; }
                break;
              case "message_stop":
                if (seenEndTurn) { turnComplete = true; seenEndTurn = false; }
                break;
            }
            break;
          }

          case "assistant": {
            if (!sawStreamEvent) {
              // 有的 CLI 构建不吐流式事件，文本/工具只在完整消息里，补发防丢
              const content: any = msg.message?.content;
              const blocks = typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content : [];
              for (const block of blocks) {
                if (block.type === "text" && block.text) this.transcribe(cs, "text", block.text);
                else if (block.type === "thinking" && block.thinking) this.transcribe(cs, "thinking", block.thinking);
                else if (block.type === "tool_use") this.transcribe(cs, "tool", `▶ ${block.name} ${JSON.stringify(block.input ?? {}).slice(0, 300)}`);
              }
            }
            break;
          }

          case "result":
            // CLI 一轮对话的权威结束信号；一轮可能多条 assistant，不能提前退
            turnComplete = true;
            break;

          case "user":
            break;
        }
      };

      const done = new Promise<void>((resolve) => {
        const finish = (): void => { if (!finished) { finished = true; resolve(); } };

        proc.stdout.setEncoding("utf8");
        proc.stdout.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            queue.push(buf.slice(0, idx).trim());
            buf = buf.slice(idx + 1);
          }
          void pump();
        });

        proc.stderr.setEncoding("utf8");
        proc.stderr.on("data", (d: string) => { stderrText += d; });

        proc.on("exit", (code) => { exitCode = code; finish(); });
        proc.on("error", () => finish());
        proc.stdin.on("error", () => { /* EPIPE：进程已退，exit 收口 */ });

        const pump = async (): Promise<void> => {
          if (pumping || finished) return;
          pumping = true;
          try {
            while (queue.length && !finished) {
              const line = queue.shift() as string;
              if (!line) continue;
              await handleLine(line);
              if (turnComplete) { finish(); return; }
            }
          } finally {
            pumping = false;
          }
        };
      });

      await done;

      if (idleTimedOut) {
        cs.s.status = "failed";
        cs.s.lastError = "超过 5 分钟无响应，已自动中断";
      } else if (cs.aborted) {
        cs.s.status = "aborted";
      } else if (!turnComplete) {
        // 进程退出但没有 result：非正常收口（认证失败/命令不存在等）
        cs.s.status = "failed";
        cs.s.lastError = `进程退出（code=${exitCode ?? "?"}）${stderrText ? ": " + stderrText.trim().slice(-300) : ""}`;
        this.transcribe(cs, "system", `出错: ${cs.s.lastError}`);
      } else {
        cs.s.status = "idle";
      }
    } catch (err: any) {
      if (cs.hardKilled) {
        cs.s.status = "failed";
        cs.s.lastError = "超过 5 分钟无响应，已强制中断";
      } else if (cs.aborted || err?.name === "AbortError" || String(err?.message || "").includes("abort")) {
        cs.s.status = "aborted";
      } else {
        logger.error("[Approver][claude] prompt error: %s", err?.message || err);
        cs.s.status = "failed";
        cs.s.lastError = String(err?.message || err).slice(0, 500);
        this.transcribe(cs, "system", `出错: ${cs.s.lastError}`);
      }
    } finally {
      this.killProc(cs);
      if (cs.idleTimer) { clearTimeout(cs.idleTimer); cs.idleTimer = null; }
      this.rejectPending(cs, "回合已结束");
      this.deps.cancelApprovals(cs.s.id);
      this.deps.onSessionUpdate(cs.s);
    }
  }

  async abort(sessionId: string): Promise<void> {
    const cs = this.entry(sessionId);
    cs.aborted = true;
    this.killProc(cs);
    this.rejectPending(cs, "任务被中止");
  }

  async disposeAll(): Promise<void> {
    for (const cs of this.sessions.values()) {
      cs.aborted = true;
      this.killProc(cs);
      if (cs.idleTimer) clearTimeout(cs.idleTimer);
    }
    this.sessions.clear();
  }

  private rejectPending(cs: ClaudeSession, message: string): void {
    for (const p of cs.pending.values()) {
      p.resolve({ behavior: "deny", message, interrupt: true, toolUseID: p.toolUseID });
    }
    cs.pending.clear();
  }

  private async handleCanUseTool(cs: ClaudeSession, msg: any): Promise<any> {
    const r = msg.request || {};
    const toolName = String(r.tool_name || "");
    const input = r.input ?? {};
    const toolUseID = String(r.tool_use_id || "");
    const { summary, detail } = summarizeClaudeInput(toolName, input);
    return new Promise((resolve) => {
      // 注册挂起句柄：看门狗看 pending 续期；abort/超时由 rejectPending 统一 deny 收口
      cs.pending.set(toolUseID, { resolve, input, suggestions: r.permission_suggestions, toolUseID });
      this.deps.requestApproval({
        agent: "claude",
        sessionId: cs.s.id,
        cwd: cs.s.cwd,
        tool: toolName,
        inputSummary: summary,
        detail,
      }).then((decision: Decision) => {
        if (!cs.pending.has(toolUseID)) return; // 已被 rejectPending 收口
        cs.pending.delete(toolUseID);
        if (decision === "deny") {
          resolve({
            behavior: "deny",
            message: "已在启航AI工作台（飞书）拒绝",
            interrupt: false,
            toolUseID,
          });
          return;
        }
        resolve({
          behavior: "allow",
          updatedInput: input,
          // allow_session 用 CLI 的 permission_suggestions 落成会话级规则
          updatedPermissions: decision === "allow_session" ? r.permission_suggestions : undefined,
          toolUseID,
        });
      }).catch(() => {
        // 审批通道异常：默认拒绝，别让 promise 悬挂拖死整轮
        if (!cs.pending.has(toolUseID)) return;
        cs.pending.delete(toolUseID);
        resolve({ behavior: "deny", message: "审批通道异常，默认拒绝", interrupt: false, toolUseID });
      });
    });
  }
}

