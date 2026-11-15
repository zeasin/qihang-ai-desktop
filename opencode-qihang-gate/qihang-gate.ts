// qihang-gate —— 启航 AI 工作台 ↔ OpenCode 桥（OpenCode v2 全局插件）
//
// 安装：由启航工作台自动部署到 ~/.config/opencode/plugins/qihang-gate.ts，无需手动复制
// （opencode 会自动发现全局插件目录下的 .ts/.js 文件；文件变更后 opencode 会热重载插件）。
// 作用（与 claude code 接入雷达同款效果）：
//   - 回合上报：session.execution.succeeded / failed → POST {base}/api/hooks/task-done，
//     工作台/飞书收到任务完成、失败通知（雷达页/桌面系统通知同源）。
//   - 审批（双通道，2026-11-15 修正）：
//       opencode 终端照常弹自己的原生权限提示（永不冻结、永不改变 opencode 判定）；
//       插件旁路监听 permission.asked 事件，把**真正的权限请求**镜像到工作台 → 飞书审批卡；
//       飞书点「允许一次/允许并记住/拒绝」后，插件用 ctx.permission.reply() 把决策回灌到
//       **同一扇窗口**，终端那侧的原生提示随之消解；终端先答的，飞书镜像卡自动作废。
//       工作台不可达只影响飞书镜像，不影响 opencode 自身流程。
//       取决策用「建卡 + 短轮询」而不是一条长连接：HTTP 客户端有响应体超时，
//       人在飞书上隔几分钟才点「允许」，长连接会先被掐断，决策就送不回终端。
//   - 「接着问」：回合收口后长轮询 GET {base}/api/hooks/opencode-followup，取走工作台/飞书提交的追问，
//     ctx.session.prompt() 注入**原会话**继续执行（不接管不 fork，输出回到用户开着的那扇 opencode 窗口）。
//
// 【为什么只镜像 permission.asked】
//   之前版本在 permission.hook("evaluate") 里对**每一次**工具权限求值都送审，
//   连 opencode 本来就放行的只读命令也会弹卡（用户投诉「审批过多、不该审批的也弹了」），
//   还把放行升级成询问，导致终端对 git diff 这类只读操作弹权限框。
//   现在口径：只有 opencode 自己判为 ask 的动作才进飞书审批；evaluate 钩子只用于
//   「可选加严」名单（工作台配置 opencodeEscalateActions，默认空），且只做 allow → ask 升级，
//   绝不反向降级、绝不拦路。
//
// task-done 请求体：{ source:'opencode', sessionId, cwd, task, result, ok, durationMs, [reason/errorMessage] }
// approval 请求体：{ source:'opencode', sessionId, requestId, tool, resources[], save[], cwd, summary, detail }
//   → 工作台登记飞书审批卡，立刻返回 { approvalId }
// decision 轮询：GET {base}/api/hooks/opencode-decision?sessionId=&requestId=&waitMs=
//   → { decision }（有人拍板）/ { cancelled:true }（终端先答）/ {}（还没人拍板，插件下一轮再来）
// approval-cancel 请求体：{ sessionId, requestId } → 把飞书镜像卡作废
// policy 请求体（工作台 → 插件）：{ escalate: ["shell","edit"] }

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---- auto-deploy endpoint (by qihang-ai-desktop, do not edit) ----
const BASE_URL = "http://127.0.0.1:8790";
// ---- end auto-deploy endpoint ----

const ENDPOINTS = {
  taskDone: `${BASE_URL}/api/hooks/task-done`,
  approval: `${BASE_URL}/api/hooks/opencode-approval`,
  approvalCancel: `${BASE_URL}/api/hooks/opencode-approval-cancel`,
  decision: `${BASE_URL}/api/hooks/opencode-decision`,
  followup: `${BASE_URL}/api/hooks/opencode-followup`,
  policy: `${BASE_URL}/api/hooks/opencode-policy`,
};

/** 取决策的单次等待时长（毫秒）：到点没拍板就返回，插件下一轮再来 */
const DECISION_WAIT_MS = 25_000;
/** 取决策的总等待上限：与工作台审批挂起 TTL（60 分钟）对齐，超时放弃回灌 */
const DECISION_TTL_MS = 60 * 60_000;

/** 追问轮询的服务端长挂起时长 */
const FOLLOWUP_WAIT_MS = 25_000;
/** 追问轮询存活上限：超过即停（与工作台暂存 TTL 对齐，超时没人取就过期） */
const FOLLOWUP_TTL_MS = 10 * 60_000;
/** 送审策略刷新间隔 */
const POLICY_REFRESH_MS = 60_000;
/**
 * 镜像前的确认延时：权限请求可能在我们镜像之前就被终端答掉，或在非交互模式下被自动拒绝。
 * 延时后用 ctx.permission.get() 探一次活，确认还在才发卡——避免刷出一张立刻作废的卡。
 */
const MIRROR_SETTLE_MS = 350;

interface SessionState {
  /** 本回合用户输入（任务文本） */
  task: string;
  /** 本回合助手输出（累计） */
  result: string;
  /** 回合开始时间戳 */
  startedAt: number;
  /** 目录 */
  cwd: string;
  /** 是否已收到用户输入（未收到说明是标题生成等内部执行，不通知） */
  armed: boolean;
}

/** 已镜像到工作台、等待飞书决策的权限请求 */
interface MirrorState {
  sessionID: string;
  requestID: string;
  /** 中断长轮询用（终端先答时立即放弃等待） */
  controller: AbortController;
  /**
   * 占位中：已通过去重检查、还没发出镜像请求（等 MIRROR_SETTLE_MS 探活）。
   * cancelMirror 遇到它只需摘掉占位，不能去工作台撤卡——卡还没发出去。
   */
  settling?: boolean;
}

function logDir(): string {
  return path.join(os.homedir(), ".qihang-ai-desktop", "approval");
}

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try {
    fs.mkdirSync(logDir(), { recursive: true });
    fs.appendFileSync(path.join(logDir(), "opencode-gate.log"), line);
  } catch {
    /* 写日志失败不影响主流程 */
  }
}

function str(v: any): string {
  return typeof v === "string" ? v : "";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 事件体里的 sessionID：v2 事件统一挂在 data.sessionID */
function sidOf(data: any): string {
  return str(data?.sessionID);
}

/** 事件里的目录（多会话场景下比 ctx.location 准） */
function dirOf(ev: any): string {
  return str((ev as any)?.location?.directory) || str((ev as any)?.data?.location?.directory);
}

function trim(text: string, max: number): string {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export default {
  id: "qihang-gate",
  async setup(ctx: any) {
    const states = new Map<string, SessionState>();
    /** 正在轮询追问的会话（每会话一个循环） */
    const pollers = new Map<string, { timer: NodeJS.Timeout | null; deadline: number }>();
    /** 已取到但还没投进会话的追问（会话正忙时先排队，收口后再投） */
    const pendingFollowups = new Map<string, string[]>();
    /** 会话是否正在跑（busy 时不投追问，避免打断进行中的回合） */
    const busy = new Map<string, boolean>();
    /** 强制送审的动作名（工作台配置 opencodeEscalateActions，默认空 = 不加严） */
    const policy = { escalate: [] as string[] };
    /** 已镜像到工作台、等待飞书决策的权限请求 */
    const mirrored = new Map<string, MirrorState>();
    const abort = new AbortController();

    log(`插件已加载（opencode ${ctx?.app?.version || "?"}，工作台 ${BASE_URL}）`);

    const stateOf = (sid: string): SessionState => {
      let s = states.get(sid);
      if (!s) {
        s = { task: "", result: "", startedAt: 0, cwd: str(ctx?.location?.directory), armed: false };
        states.set(sid, s);
      }
      return s;
    };

    // ---------- 送审策略（工作台 → 插件） ----------
    const refreshPolicy = async (): Promise<void> => {
      try {
        const res = await fetch(ENDPOINTS.policy);
        if (!res.ok) return;
        const data: any = await res.json().catch(() => null);
        const list: string[] = Array.isArray(data?.escalate)
          ? data.escalate.map((x: any) => String(x)).filter(Boolean)
          : [];
        if (list.join(",") !== policy.escalate.join(",")) {
          policy.escalate = list;
          log(
            `送审策略已更新：${list.join(", ") || "（不加严：只镜像 opencode 自己判 ask 的动作）"}`,
          );
        }
      } catch {
        /* 工作台未起：保持上一次策略 */
      }
    };
    void refreshPolicy();
    const policyTimer = setInterval(() => void refreshPolicy(), POLICY_REFRESH_MS);
    policyTimer.unref?.();

    // ---------- 回合上报 ----------
    const report = async (sid: string, ok: boolean, errorMessage: string): Promise<void> => {
      const s = states.get(sid);
      states.delete(sid);
      if (!s || !s.armed) return; // 标题生成等内部执行不打扰用户
      const body = JSON.stringify({
        source: "opencode",
        sessionId: sid,
        cwd: s.cwd,
        task: s.task,
        result: ok ? s.result : undefined,
        ok,
        ...(ok ? {} : { reason: "error", errorMessage: errorMessage || "opencode 处理出错" }),
        durationMs: s.startedAt > 0 ? Date.now() - s.startedAt : 0,
      });
      try {
        const res = await fetch(ENDPOINTS.taskDone, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        });
        log(`回合上报(${ok ? "完成" : "失败"}) session=${sid.slice(0, 24)} → HTTP ${res.status}`);
      } catch (e: any) {
        log(`回合上报失败（工作台未起？）: ${String(e?.message || e).slice(0, 120)}`);
      }
    };

    // ---------- 审批：镜像到工作台（不拦路） ----------
    // 关键原则：工作台不可达/超时**绝不能**改变 opencode 的判定。
    // 终端永远按 opencode 自己的规则弹原生提示；飞书只是镜像 + 可远程决策。

    /** 权限请求镜像到工作台：登记 → 长轮询等决策 → 有决策则回灌同一扇窗口 */
    const mirrorPermission = async (
      data: any,
      sessionID: string,
      requestID: string,
      ev?: any,
    ): Promise<void> => {
      if (!sessionID || !requestID) return;
      // 占位同步登记（先于任何 await）：事件订阅对同一请求可能重复投递，
      // 若去重检查与登记之间隔了下面的 350ms 延时，重复事件会同时穿过检查 → 弹两张卡。
      // 这里只登记「正在镜像」，真正的 AbortController 在延时后填入。
      if (mirrored.has(requestID)) return; // 去重：同一请求只镜像一次
      mirrored.set(requestID, { sessionID, requestID, controller: new AbortController(), settling: true });

      // 动作与资源：v2 是 action/resources，v1 兼容模式是 permission/patterns
      const action = str(data?.action) || str(data?.permission) || "unknown";
      const resources: string[] = Array.isArray(data?.resources)
        ? data.resources.map((r: any) => String(r))
        : Array.isArray(data?.patterns)
          ? data.patterns.map((r: any) => String(r))
          : [];
      const save: string[] = Array.isArray(data?.save) ? data.save.map((r: any) => String(r)) : [];
      const message = str(data?.message);

      // 先确认请求还活着：终端可能已答，或非交互模式已被自动拒绝
      await sleep(MIRROR_SETTLE_MS);
      try {
        await ctx.permission.get({ sessionID, requestID });
      } catch {
        log(`权限请求已失效（终端已处理/非交互自动拒绝），不镜像：${action} ${requestID.slice(0, 12)}`);
        mirrored.delete(requestID);
        return;
      }
      // 延时期间终端可能已经答复 → 占位被 cancelMirror 摘掉，这里就别再镜像了
      if (!mirrored.has(requestID)) return;

      const entry = mirrored.get(requestID)!;
      entry.settling = false;
      const controller = entry.controller;

      const detail = [
        `动作：${action}`,
        `资源：${resources.join(", ") || "-"}`,
        save.length ? `「允许并记住」将保存：${save.join(", ")}` : "",
        message ? `说明：${message}` : "",
        "来源：opencode 权限请求（终端同窗提示 + 飞书镜像，决策回灌到同一扇窗口）",
      ]
        .filter(Boolean)
        .join("\n")
        .slice(0, 2000);

      try {
        // 1) 登记飞书审批卡（工作台立刻返回，不挂起）
        const res = await fetch(ENDPOINTS.approval, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            source: "opencode",
            sessionId: sessionID,
            requestId: requestID,
            cwd: dirOf(ev) || str(ctx?.location?.directory),
            tool: action,
            resources,
            save,
            summary: trim(`${action} ${resources.join(" ")}`, 200),
            detail,
          }),
        });
        if (!res.ok) {
          log(`镜像请求被工作台拒绝（HTTP ${res.status}），不影响 opencode 自身流程：${action}`);
          return;
        }
        const created: any = await res.json().catch(() => null);
        if (!created?.approvalId) {
          log(`工作台没有登记审批卡，不镜像：${action}`);
          return;
        }
        log(`权限请求已镜像到工作台：${action} request=${requestID.slice(0, 12)}`);

        // 2) 轮询取决策。
        //    这里刻意用「短轮询」而不是一条长连接：Node 的 HTTP 客户端有 5 分钟响应体超时，
        //    人在飞书上隔几分钟才点「允许」的话，长连接会被掐断，决策就送不回终端了。
        const deadline = Date.now() + DECISION_TTL_MS;
        while (Date.now() < deadline) {
          if (!mirrored.has(requestID)) return; // 被取消（终端先答了）
          try {
            const dr = await fetch(
              `${ENDPOINTS.decision}?sessionId=${encodeURIComponent(sessionID)}` +
                `&requestId=${encodeURIComponent(requestID)}&waitMs=${DECISION_WAIT_MS}`,
              { signal: controller.signal },
            );
            const data2: any = dr.ok ? await dr.json().catch(() => null) : null;
            if (data2?.cancelled) {
              log(`飞书镜像卡已作废（终端先答）：${action} ${requestID.slice(0, 12)}`);
              return;
            }
            const decision = str(data2?.decision);
            if (!decision) continue; // 还没人拍板，继续等
            // 工作台决策 → opencode 的回复语义
            const reply =
              decision === "allow_once" ? "once" : decision === "allow_session" ? "always" : "reject";
            // 先摘掉登记，避免自己回灌触发的 permission.replied 又来作废自己
            mirrored.delete(requestID);
            try {
              await ctx.permission.reply({ sessionID, requestID, decision: reply });
              log(`飞书决策已回灌终端：${decision} → ${reply}（${action}）`);
            } catch (e: any) {
              log(`决策回灌失败（终端可能已自行处理）: ${String(e?.message || e).slice(0, 120)}`);
            }
            return;
          } catch (e: any) {
            if (controller.signal.aborted) {
              log(`镜像等待已中止（终端先答了）：${action} ${requestID.slice(0, 12)}`);
              return;
            }
            // 工作台不可达/网络抖动：退避后继续等（终端那边仍有原生提示，不受影响）
            await sleep(3000);
          }
        }
        log(`等待飞书决策超时，放弃回灌（终端仍可自行答复）：${action}`);
      } catch (e: any) {
        if (controller.signal.aborted) {
          log(`镜像等待已中止（终端先答了）：${action} ${requestID.slice(0, 12)}`);
        } else {
          log(`镜像失败（不影响 opencode 自身流程）: ${String(e?.message || e).slice(0, 120)}`);
        }
      } finally {
        mirrored.delete(requestID);
      }
    };

    /** 终端已自行答复：把飞书那张镜像卡作废，避免重复决策 */
    const cancelMirror = async (sessionID: string, requestID: string): Promise<void> => {
      const rec = mirrored.get(requestID);
      if (!rec) return;
      mirrored.delete(requestID);
      try {
        rec.controller.abort(); // 中断长轮询，别再等一个已经没有意义的决策
      } catch {
        /* ignore */
      }
      // 卡还没发出去（探活延时的占位阶段）：摘占位即可，别向工作台报作废
      if (rec.settling) return;
      try {
        await fetch(ENDPOINTS.approvalCancel, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sessionID, requestId: requestID }),
        });
        log(`终端已答复，飞书镜像卡作废：${requestID.slice(0, 12)}`);
      } catch {
        /* 作废失败：工作台侧那张卡会被 TTL 收口 */
      }
    };

    try {
      await ctx.permission.hook("evaluate", async (ev: any) => {
        // 这里只做一件事：把工作台「额外加严」名单里的动作从放行升级为询问。
        // 命中 ask 的动作原样保留（终端照常弹原生提示）；deny 不动；其余一律不碰。
        const action = str(ev?.action);
        const effect = str(ev?.effect);
        if (effect !== "allow" || !policy.escalate.includes(action)) return;
        ev.effect = "ask";
        log(`按工作台加严名单升级为待审批：${action}`);
      });
      log("权限钩子已注册（仅加严用，不拦路）");
    } catch (e: any) {
      log(`权限钩子注册失败: ${String(e?.message || e).slice(0, 160)}`);
    }

    // ---------- 接着问：长轮询取追问，注入原会话 ----------
    const stopPolling = (sid: string): void => {
      const p = pollers.get(sid);
      if (!p) return;
      if (p.timer) clearTimeout(p.timer);
      pollers.delete(sid);
    };

    /** 把排队的追问投进原会话（会话忙则继续排队，等收口后再投） */
    const deliverFollowups = async (sid: string): Promise<void> => {
      const queue = pendingFollowups.get(sid);
      if (!queue || !queue.length) return;
      if (busy.get(sid)) return; // 回合进行中：等收口再投
      const text = queue.shift() as string;
      if (!queue.length) pendingFollowups.delete(sid);
      try {
        await ctx.session.prompt({ sessionID: sid, text });
        log(`追问已注入原会话：${trim(text, 60)}`);
      } catch (e: any) {
        log(`注入失败（保留待投）: ${String(e?.message || e).slice(0, 120)}`);
        const q = pendingFollowups.get(sid) || [];
        q.unshift(text);
        pendingFollowups.set(sid, q);
      }
    };

    const startPolling = (sid: string): void => {
      if (!sid) return;
      const existing = pollers.get(sid);
      if (existing) {
        existing.deadline = Date.now() + FOLLOWUP_TTL_MS; // 续期
        return;
      }
      const entry = { timer: null as NodeJS.Timeout | null, deadline: Date.now() + FOLLOWUP_TTL_MS };
      pollers.set(sid, entry);
      const loop = async (): Promise<void> => {
        try {
          while (Date.now() < entry.deadline) {
            // 会话正忙时先不取：取走却投不进去等于丢消息
            if (busy.get(sid)) {
              await sleep(1000);
              continue;
            }
            try {
              const res = await fetch(
                `${ENDPOINTS.followup}?sessionId=${encodeURIComponent(sid)}&waitMs=${FOLLOWUP_WAIT_MS}`,
              );
              const data: any = res.ok ? await res.json().catch(() => null) : null;
              const text = str(data?.text);
              if (text) {
                const q = pendingFollowups.get(sid) || [];
                q.push(text);
                pendingFollowups.set(sid, q);
                log(`取走追问：${trim(text, 60)}`);
                await deliverFollowups(sid);
              }
            } catch (e: any) {
              // 工作台未起/网络抖动：退避后重试，不打断轮询
              await sleep(3000);
              continue;
            }
          }
        } finally {
          stopPolling(sid);
        }
      };
      void loop();
    };

    // ---------- 事件流 ----------
    try {
      void (async () => {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
          const type = str(ev?.type);
          const data = (ev as any)?.data || {};

          // 权限请求：镜像到飞书（这是唯一会产生审批卡的地方）
          if (type === "permission.asked") {
            void mirrorPermission(data, sidOf(data), str(data?.id), ev);
            continue;
          }
          // 权限已答复：终端先答则作废飞书镜像卡
          if (type === "permission.replied") {
            void cancelMirror(sidOf(data), str(data?.requestID));
            continue;
          }

          const sid = sidOf(data);
          if (!sid) continue;

          switch (type) {
            case "session.inbox.enqueued": {
              // 用户输入（也含工作台注入的追问）→ 记任务文本
              const item = data?.item || {};
              const text = str(item?.payload?.text);
              if (text) {
                const s = stateOf(sid);
                s.task = text;
                s.result = "";
                s.armed = true;
                s.startedAt = Date.now();
                const dir = dirOf(ev);
                if (dir) s.cwd = dir;
              }
              break;
            }
            case "session.execution.started": {
              const s = stateOf(sid);
              if (!s.startedAt) s.startedAt = Date.now();
              const dir = dirOf(ev);
              if (dir) s.cwd = dir;
              busy.set(sid, true);
              break;
            }
            case "session.text.ended": {
              const s = stateOf(sid);
              const text = str(data?.text);
              if (text) s.result = s.result ? `${s.result}\n${text}` : text;
              break;
            }
            case "session.execution.succeeded": {
              busy.set(sid, false);
              await report(sid, true, "");
              startPolling(sid);
              void deliverFollowups(sid);
              break;
            }
            case "session.execution.failed": {
              busy.set(sid, false);
              const err = data?.error || {};
              await report(sid, false, str(err?.message || err?.name) || "opencode 处理出错");
              startPolling(sid);
              void deliverFollowups(sid);
              break;
            }
            case "session.execution.interrupted": {
              // 用户主动中止：与 pi/DSH 口径一致，不通知
              busy.set(sid, false);
              states.delete(sid);
              break;
            }
            default:
              break;
          }
        }
      })();
      log("事件订阅已启动");
    } catch (e: any) {
      log(`事件订阅失败: ${String(e?.message || e).slice(0, 160)}`);
    }

    return () => {
      abort.abort();
      clearInterval(policyTimer);
      for (const sid of [...pollers.keys()]) stopPolling(sid);
      for (const rec of mirrored.values()) {
        try {
          rec.controller.abort();
        } catch {
          /* ignore */
        }
      }
      mirrored.clear();
      states.clear();
      pendingFollowups.clear();
      log("插件已卸载");
    };
  },
};
