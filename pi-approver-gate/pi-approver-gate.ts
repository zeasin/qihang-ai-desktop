// pi-approver-gate —— 启航 AI 工作台飞书审批网关（pi CLI 终端用）
//
// 安装：复制到 ~/.pi/agent/extensions/pi-approver-gate.ts（全局）或 .pi/extensions/（项目）。
// 作用：拦截 bash/edit/write 的 tool_call，挂起 POST 到工作台审批通道
//   http://127.0.0.1:<approverPort>/api/hooks/pi-approval，等飞书决策后放行/阻止。
//   决策经飞书卡片（允许一次 / 本会话放行 / 拒绝），与 Claude Code hook、DSH 插件同源。
//
// 契约：
//   - 请求体：{ sessionId, cwd, toolName, toolCallId, inputSummary, detail }
//   - 响应体：{ decision: 'allow_once' | 'allow_session' | 'deny' } 或 {}（无决策）
//   - allow_once  → 放行这一次（返回 undefined，工具照常执行）
//   - allow_session → 本会话放行该工具（写 allowlist，后续同工具不再问），本次放行
//   - deny        → { block: true, reason }（工具不执行，reason 回喂 agent）
//   - 空响应/服务不可达/超时 → fail-closed 阻止（设计铁律：不静默放行）
//
// 与托管会话隔离：
//   启航工作台 in-process SDK 会话（桌面对话/飞书/日报/定时任务）由 pi-agent.ts 设
//   PI_APPROVER_GATE=off（及 AGENTHUB_PI_TOOLS=__qihang_disabled__ 向后兼容），
//   本扩展据此跳过拦截、自由执行——无人值守场景没人点批准。用户单独开的 pi CLI 终端
//   不设此变量，按原策略走飞书审批。
//
// 环境变量：
//   PI_APPROVER_URL     端点，默认 http://127.0.0.1:8790/api/hooks/pi-approval
//   PI_APPROVER_TOOLS   拦截工具集（逗号分隔），默认 bash,edit,write；__disabled__=全关
//   PI_APPROVER_GATE    off=关闭本扩展（托管会话自动设）
//   AGENTHUB_PI_TOOLS   === __qihang_disabled__ 时也关闭（pi-agent.ts 既有哨兵，向后兼容）
//   PI_APPROVER_FETCH_MS 单次请求超时，默认 3660000（61 分钟，远超服务端 HOOK_WAIT_MS=540s，让服务端先超时）

import type { ExtensionAPI, ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

const DEFAULT_URL = "http://127.0.0.1:8790/api/hooks/pi-approval";
const DEFAULT_TOOLS = ["bash", "edit", "write"];
const DEFAULT_FETCH_MS = 3_660_000; // 61 分钟，远超服务端 540s，让服务端先返回空决策

/** 本扩展是否启用：托管会话里 pi-agent.ts 设了 off 哨兵 → 跳过拦截 */
function gateEnabled(): boolean {
  if (process.env.PI_APPROVER_GATE === "off") return false;
  // 向后兼容 pi-agent.ts 既有的 AGENTHUB_PI_TOOLS 哨兵（同一进程内已设）
  if (process.env.AGENTHUB_PI_TOOLS === "__qihang_disabled__") return false;
  return true;
}

/** 拦截的工具集 */
function gatedTools(): Set<string> {
  const raw = (process.env.PI_APPROVER_TOOLS || "").trim();
  if (!raw) return new Set(DEFAULT_TOOLS);
  if (raw === "__disabled__") return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/** pi 工具输入摘要（≤200 字符） */
function buildSummary(toolName: string, input: any): string {
  if (toolName === "bash" && typeof input?.command === "string") return input.command.slice(0, 200);
  try {
    return (JSON.stringify(input) ?? "").slice(0, 200);
  } catch {
    return String(input).slice(0, 200);
  }
}

/** pi 工具输入正文（pi 字段名：path 而非 file_path、oldText/newText 而非 old_string/new_string） */
function buildDetail(toolName: string, input: any): string {
  if (toolName === "bash" && typeof input?.command === "string") return input.command;
  if (toolName === "write" && typeof input?.path === "string") {
    return `${input.path}\n${String(input.content ?? "").slice(0, 1500)}`;
  }
  if (toolName === "edit" && typeof input?.path === "string") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const diff = edits
      .map((e: any) => `- ${String(e?.oldText ?? "").slice(0, 500)}\n+ ${String(e?.newText ?? "").slice(0, 1000)}`)
      .join("\n---\n");
    return `${input.path}\n${diff}`;
  }
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return String(input);
  }
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

function log(msg: string): void {
  // 写到 stderr：pi TUI 不污染，排查时可见
  console.error(`[pi-approver-gate] ${msg}`);
}

export default function (pi: ExtensionAPI): void {
  const url = (process.env.PI_APPROVER_URL || DEFAULT_URL).trim();
  const gated = gatedTools();
  const fetchMs = Number(process.env.PI_APPROVER_FETCH_MS) > 0
    ? Number(process.env.PI_APPROVER_FETCH_MS)
    : DEFAULT_FETCH_MS;
  /** sessionId -> 已放行的工具名集合（allow_session 落账，仅 allow_session 写，allow_once 不写） */
  const allowCache = new Map<string, Set<string>>();

  if (gated.size === 0) {
    log("拦截工具集为空（PI_APPROVER_TOOLS=__disabled__），扩展不生效");
  }

  pi.on("tool_call", async (event: ToolCallEvent, ctx): Promise<ToolCallEventResult | undefined> => {
    if (!gateEnabled()) return; // 托管会话：自由执行
    if (ctx?.signal?.aborted) return; // agent 已中止：不拦

    const toolName = String((event as any).toolName || "");
    if (!toolName || !gated.has(toolName)) return; // 非拦截工具：放行

    const sid = sessionKey(ctx);
    // 本会话已放行该工具：直接放行（不重复问）
    if (sid && allowCache.get(sid)?.has(toolName)) return;

    const input = (event as any).input ?? {};
    const summary = buildSummary(toolName, input);
    const detail = buildDetail(toolName, input);

    log(`拦截 ${toolName} session=${sid ? sid.slice(0, 24) : "?"} ${summary.slice(0, 80)}`);

    // 把 agent 中止信号链到 fetch：用户 Ctrl+C 时尽快退出等待
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    try {
      ctx?.signal?.addEventListener?.("abort", onAbort, { once: true });
    } catch { /* ignore */ }
    const timer = setTimeout(() => ac.abort(), fetchMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ac.signal,
        body: JSON.stringify({
          sessionId: sid,
          cwd: ctx?.cwd || "",
          toolName,
          toolCallId: (event as any).toolCallId || "",
          inputSummary: summary,
          detail,
        }),
      });
      const body = res.ok ? await res.json() : null;
      const decision = body?.decision;

      if (decision === "allow_once") {
        log(`放行(允许一次) ${toolName}`);
        return; // 执行这一次
      }
      if (decision === "allow_session") {
        if (sid) {
          if (!allowCache.has(sid)) allowCache.set(sid, new Set());
          allowCache.get(sid)!.add(toolName);
        }
        log(`放行(本会话放行) ${toolName}`);
        return; // 执行，后续同工具自动放行
      }
      if (decision === "deny") {
        log(`拒绝 ${toolName}`);
        return { block: true, reason: "已在启航AI工作台（飞书）拒绝" };
      }
      // 服务端超时返回空决策：fail-closed 阻止（不静默放行）
      log(`服务端未返回决策，阻止 ${toolName}`);
      return { block: true, reason: "启航AI工作台审批服务未返回决策，已阻止本次操作（可能超时未有人审批）。请在飞书处理或重启工作台。" };
    } catch (e: any) {
      // daemon 未起 / 网络错误 / 请求中止：fail-closed 阻止
      const reason = String(e?.message || e).slice(0, 120);
      log(`审批服务不可用，阻止 ${toolName}：${reason}`);
      return { block: true, reason: `启航AI工作台审批服务不可用，已阻止本次操作（${reason}）。请启动工作台后重试，或用 PI_APPROVER_GATE=off 关闭审批。` };
    } finally {
      clearTimeout(timer);
      try {
        ctx?.signal?.removeEventListener?.("abort", onAbort);
      } catch { /* ignore */ }
    }
  });
}
