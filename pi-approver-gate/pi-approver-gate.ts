// pi-approver-gate —— 启航 AI 工作台外部 pi 终端上报桥（回合通知 + 接着问）
//
// 安装：由启航工作台自动部署到 ~/.pi/agent/extensions/pi-approver-gate.ts，无需手动复制
// （文件名固定不改：改名会在用户扩展目录残留旧文件）。
// 作用（拍板 2026-11-15：审批拦截彻底删除，本扩展不再拦截任何工具调用，pi 终端全自动原生速度运行）：
//   - 回合上报：agent_settled 时 POST http://127.0.0.1:<approverPort>/api/hooks/task-done，
//     工作台/飞书收到任务完成、失败通知（雷达页/桌面系统通知同源）。
//   - 「接着问」：回合收口后长轮询 GET /api/hooks/pi-followup，取走工作台/飞书提交的追问，
//     pi.sendUserMessage() 注入终端原会话继续执行（与 DSH 插件同模式，不接管不 fork）。
//
// task-done 请求体：{ source:'pi', sessionId, cwd, task, result, ok, durationMs, [reason/errorMessage] }
//
// 与托管会话隔离：
//   启航工作台 in-process SDK 会话（桌面对话/飞书/日报/定时任务）由 pi-agent.ts 设
//   PI_APPROVER_GATE=off（及 AGENTHUB_PI_TOOLS=__qihang_disabled__ 向后兼容），
//   本扩展据此跳过——托管会话的回合通知走工作台内部通道，不需要终端上报。
//   用户单独开的 pi CLI 终端不设此变量，回合上报/接着问生效。
//
// 环境变量：
//   PI_APPROVER_URL     工作台端点，默认 http://127.0.0.1:8790/api/hooks/pi-approval；
//                       task-done / pi-followup 由它派生同端口路径（路径名保留为部署兼容，见 pi-gate-deploy.ts）
//   PI_APPROVER_GATE    off=关闭本扩展（托管会话自动设）
//   AGENTHUB_PI_TOOLS   === __qihang_disabled__ 时也关闭（pi-agent.ts 既有哨兵，向后兼容）

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_URL = "http://127.0.0.1:8790/api/hooks/pi-approval";

/** 本扩展是否启用：托管会话里 pi-agent.ts 设了 off 哨兵 → 跳过上报/追问 */
function gateEnabled(): boolean {
  if (process.env.PI_APPROVER_GATE === "off") return false;
  // 向后兼容 pi-agent.ts 既有的 AGENTHUB_PI_TOOLS 哨兵（同一进程内已设）
  if (process.env.AGENTHUB_PI_TOOLS === "__qihang_disabled__") return false;
  return true;
}

/** 会话 id：优先 sessionManager.getSessionId()，退回 cwd */
function sessionKey(ctx: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (id) return String(id);
  } catch { /* ignore */ }
  try {
    return String(ctx?.cwd || "");
  } catch {
    return "";
  }
}

/** 从一条消息里抽纯文本（user 的 content 是 string 或 text 块数组；assistant 同理） */
function messageText(m: any): string {
  if (!m) return "";
  const content = m.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c?.type === "text")
      .map((c: any) => c?.text ?? "")
      .join("");
  }
  return "";
}

function log(msg: string): void {
  // 写到 stderr：pi TUI 不污染，排查时可见
  console.error(`[pi-approver-gate] ${msg}`);
}

export default function (pi: ExtensionAPI): void {
  const url = (process.env.PI_APPROVER_URL || DEFAULT_URL).trim();
  // task-done / pi-followup 端点：从上报端点派生（同端口）
  const taskDoneUrl = url.replace(/\/api\/hooks\/pi-approval\/?$/, "/api/hooks/task-done");
  const followupUrl = url.replace(/\/api\/hooks\/pi-approval\/?$/, "/api/hooks/pi-followup");
  const POLL_WAIT_MS = 25_000; // 服务端长轮询挂起时长（与 DSH 插件一致）
  const POLL_TTL_MS = 10 * 60_000; // 与服务端暂存 TTL 对齐，超时停止轮询
  /** 回合进行中标记（agent_start 置位，agent_settled 收口复位） */
  let roundActive = false;
  let agentStartTs = 0;
  // 最后一次 agent_end 的消息快照（agent_settled 事件本身不带 messages，取这里判定成败）
  let lastMessages: any[] = [];
  // 「接着问」轮询：扩展生命周期内最多一个循环，deadline 每次回合收口续期，10 分钟无追问自动停。
  // 旧实现用 gen/pollActive 门控有致命 bug：第二次收口先 ++pollGen 再 return，旧循环退出后
  // pollActive 永久卡 true，之后所有收口都不再轮询——追问暂存后没人取走（2026-11-13 修复）。
  let pollDeadline = 0;
  let pollRunning = false;

  pi.on("agent_start", async (_event, _ctx) => {
    if (!gateEnabled()) return;
    agentStartTs = Date.now();
    roundActive = true;
  });

  pi.on("agent_end", async (event: any, _ctx) => {
    if (!gateEnabled()) return;
    if (Array.isArray(event?.messages) && event.messages.length) lastMessages = event.messages;
  });

  pi.on("agent_settled", async (event: any, ctx) => {
    if (!gateEnabled()) return;
    // 用户主动中止（Esc/Ctrl+C）：与 DSH/Claude 口径一致，不通知
    if (event?.aborted) { agentStartTs = 0; roundActive = false; return; }

    const sid = sessionKey(ctx);
    const messages: any[] = lastMessages;
    // 任务文本：最后一条 user 消息（触发本次 agent 的 prompt）
    let taskText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") { taskText = messageText(messages[i]); break; }
    }
    // 结果文本 / 成败：最后一条 assistant 消息（stopReason=error 即回合失败）
    let resultText = "";
    let ok = true;
    let errorText = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role === "assistant") {
        resultText = messageText(m);
        if (m.stopReason === "error") {
          ok = false;
          errorText = String(m.errorMessage || "pi 处理出错");
        }
        break;
      }
    }
    const durationMs = agentStartTs > 0 ? Date.now() - agentStartTs : 0;
    agentStartTs = 0;
    lastMessages = [];
    const body = JSON.stringify({
      source: "pi",
      sessionId: sid,
      cwd: ctx?.cwd || "",
      task: taskText,
      result: resultText,
      ok,
      ...(ok ? {} : { reason: "error", errorMessage: errorText }),
      durationMs,
    });
    // fire-and-forget：工作台没起就静默失败，不阻断 agent
    fetch(taskDoneUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .then((res) => { if (res.ok) log(`回合上报(${ok ? "完成" : "失败"}) session=${sid ? sid.slice(0, 24) : "?"} ${taskText.slice(0, 40)}`); })
      .catch((e: any) => log(`回合上报失败（工作台未起？）: ${String(e?.message || e).slice(0, 80)}`));

    // ---- 「接着问」长轮询：回合收口后取追问，注入终端原会话继续跑（与 DSH 插件同模式，不接管不 fork）----
    // 追问按 sessionId 暂存在工作台（TTL 10 分钟），这里轮询取走后 pi.sendUserMessage()
    // 在原会话触发新回合（上下文/工具全保留）；新回合收口会续期 deadline，多轮成环。
    if (!sid) { roundActive = false; return; }
    roundActive = false;
    pollDeadline = Date.now() + POLL_TTL_MS;
    if (pollRunning) return; // 循环已在跑：本次收口只续期，不重复开
    pollRunning = true;
    void (async () => {
      try {
        while (Date.now() < pollDeadline) {
          // 回合进行中不取：sendUserMessage 打断进行中的回合会乱序，等收口（agent_settled 已置 false）
          if (roundActive) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
          }
          const res = await fetch(`${followupUrl}?sessionId=${encodeURIComponent(sid)}&waitMs=${POLL_WAIT_MS}`)
            .catch(() => null);
          const body = res && res.ok ? await res.json().catch(() => null) : null;
          const text = typeof body?.text === "string" ? body.text : "";
          if (text) {
            try {
              log(`取走追问，注入原会话继续执行 ${text.slice(0, 40)}`);
              pi.sendUserMessage(text);
            } catch (e: any) {
              log(`注入失败: ${String(e?.message || e).slice(0, 80)}`);
            }
          }
        }
      } finally {
        pollRunning = false;
      }
    })();
  });
}
