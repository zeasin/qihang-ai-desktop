/**
 * opencode 审批双通道端到端回归（诊断用）。
 *
 * 流程：
 *   1. 建一个 D 盘项目的 opencode 会话，驱动它执行一条 shell 命令
 *   2. 插件把「加严名单」里的 shell 升级成 ask → opencode 发起权限请求
 *   3. 插件旁路镜像到工作台 → 工作台生成审批（= 飞书卡同一条审批记录）
 *   4. 通过工作台 REST 决策（等价于在飞书上点按钮）
 *   5. 校验：命令真的执行了、审批记录状态正确、插件日志有「决策已回灌终端」
 *
 * 用法：node eval/oc-approve-e2e.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const OC = 'http://127.0.0.1:28894';
const WB = 'http://127.0.0.1:8790';
const DIR = 'D:\\projects\\qihang-ai-desktop';
const svc = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config/opencode/service.json'), 'utf8'),
);
const OC_AUTH = 'Basic ' + Buffer.from('opencode:' + svc.password).toString('base64');
const gateLog = path.join(os.homedir(), '.qihang-ai-desktop', 'approval', 'opencode-gate.log');

const out = [];
function say(line) {
  out.push(line);
  console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oc(method, url, body, timeoutMs = 15000) {
  const res = await fetch(OC + url, {
    method,
    headers: { Authorization: OC_AUTH, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

async function wb(method, url, body, timeoutMs = 10000) {
  const res = await fetch(WB + url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, text };
}

(async () => {
  // 加严开关（--expect-none）：只验证「不该审批的没有弹审批」，不出审批就无需决策
  const expectNone = process.argv.includes('--expect-none');
  const logBefore = fs.existsSync(gateLog) ? fs.statSync(gateLog).size : 0;

  const s = await oc('POST', '/api/session', {
    location: { directory: DIR },
    model: { providerID: 'amd', id: 'GLM-5.3-Flash' },
  });
  const sid = s.json?.data?.id || s.json?.id;
  say('会话: ' + sid + '  建会话响应: ' + s.status + ' ' + s.text.slice(0, 300));
  if (!sid) return;

  // 驱动会话（可能长时间挂起：shell 扫描器 ~30s + 等审批），放后台不阻塞
  let turnDone = false;
  void oc(
    'POST',
    `/api/session/${sid}/prompt`,
    { text: '用 shell 工具执行这条命令：echo hello-qihang-approve' },
    300000,
  )
    .then((r) => {
      turnDone = true;
      say('回合返回: ' + r.status + ' ' + r.text.slice(0, 300));
    })
    .catch((e) => {
      turnDone = true;
      say('回合异常: ' + (e?.name || e?.message));
    });

  // 等审批出现（工作台侧）
  let approval = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    const list = await wb('GET', '/api/approvals');
    const pend = (list.json || []).filter((a) => a.agent === 'opencode' && a.status === 'pending');
    if (pend.length) {
      approval = pend[0];
      say(`\n[${i}s] 工作台出现 opencode 审批：${approval.id} tool=${approval.tool}`);
      say('  摘要: ' + approval.inputSummary);
      say('  正文: ' + String(approval.detail || '').replace(/\n/g, ' | ').slice(0, 300));
      break;
    }
  }
  if (!approval) {
    if (expectNone) {
      say('\n✅ 预期结果达成：整段会话没有产生任何 opencode 审批（不打扰用户）');
      dumpLog(logBefore);
      return;
    }
    say('\n❌ 120 秒内没有出现 opencode 审批');
    const p = await oc('GET', `/api/session/${sid}/permission`);
    say('opencode pending: ' + p.text.slice(0, 300));
    dumpLog(logBefore);
    return;
  }

  if (expectNone) {
    say('\n❌ 不该审批却弹出了审批：' + approval.id + ' ' + approval.inputSummary);
    dumpLog(logBefore);
    return;
  }

  // --terminal-first：模拟「终端自己先答了」→ 飞书镜像卡应自动作废
  if (process.argv.includes('--terminal-first')) {
    const pend = await oc('GET', `/api/session/${sid}/permission`);
    const reqId = pend.json?.data?.[0]?.id;
    say('\nopencode 侧待批请求: ' + (reqId || '(无)'));
    if (reqId) {
      const rep = await oc('POST', `/api/session/${sid}/permission/${reqId}/reply`, {
        decision: 'once',
      });
      say('终端直接答复: ' + rep.status + ' ' + rep.text.slice(0, 160));
    }
    await sleep(3000);
    const after = await wb('GET', '/api/approvals');
    const rec = (after.json || []).find((a) => a.id === approval.id);
    say('审批最终状态: ' + (rec ? `${rec.status} / ${rec.decision || '-'} / ${rec.decidedBy || '-'}` : '(未找到)'));
    say(
      rec && rec.status === 'expired' && rec.decidedBy === 'terminal-answered'
        ? '✅ 飞书镜像卡已被作废（终端先答），没有重复决策'
        : '❌ 镜像卡没有按预期作废',
    );
    dumpLog(logBefore);
    return;
  }

  // 通过工作台 REST 决策（等价于在飞书卡片上点「允许一次」）
  const dec = await wb('POST', `/api/approvals/${approval.id}/decision`, {
    decision: 'allow_once',
    by: 'e2e-test',
  });
  say('\n决策响应: ' + dec.status + ' ' + dec.text.slice(0, 200));

  // 等命令执行完（插件按 ≤25s 一轮轮询取决策，留足余量）
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    if (turnDone) break;
  }
  await sleep(2000);

  // 校验会话消息里命令是否真的执行了
  const msgs = await oc('GET', `/api/session/${sid}/message`);
  const text = msgs.text || '';
  say('\n命令是否执行: ' + (text.includes('hello-qihang-approve') ? '✅ 是' : '❌ 否'));
  const m = text.match(/hello-qihang-approve/g);
  say('出现次数: ' + (m ? m.length : 0));

  const after = await wb('GET', '/api/approvals');
  const rec = (after.json || []).find((a) => a.id === approval.id);
  say('审批最终状态: ' + (rec ? `${rec.status} / ${rec.decision} / ${rec.decidedBy}` : '(未找到)'));

  dumpLog(logBefore);
})().catch((e) => {
  say('失败: ' + (e?.message || e));
});

function dumpLog(before) {
  const after = fs.existsSync(gateLog) ? fs.statSync(gateLog).size : 0;
  const fresh = after > before ? fs.readFileSync(gateLog, 'utf8').slice(before) : '(插件日志无新增)';
  say('\n--- 插件日志新增 ---');
  say(fresh.slice(0, 2500));
}
