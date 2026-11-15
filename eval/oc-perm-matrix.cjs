/**
 * opencode 权限事件通路自检 v2（诊断用）。
 *
 * 关键点：
 *   - 建会话要带 location:{directory}（不是 directory），否则落到 C:\Users\ASUS，项目/规则集都不同
 *   - 每个请求加超时，避免 ask 挂死把脚本拖死
 *   - 结果实时写文件，避免进程被杀时 stdout 丢失
 *
 * 用法：node eval/oc-perm-matrix.cjs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = 'http://127.0.0.1:28894';
const DIR = 'D:\\projects\\qihang-ai-desktop';
const svc = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.config/opencode/service.json'), 'utf8'),
);
const AUTH = 'Basic ' + Buffer.from('opencode:' + svc.password).toString('base64');
const logPath = path.join(os.homedir(), '.qihang-ai-desktop', 'approval', 'opencode-probe.log');
const outPath = path.join(os.homedir(), '.qihang-ai-desktop', 'approval', 'oc-perm-matrix.txt');

const out = [];
function say(line) {
  out.push(line);
  fs.writeFileSync(outPath, out.join('\n'), 'utf8');
  console.log(line);
}

async function api(method, url, body, timeoutMs = 8000) {
  const res = await fetch(BASE + url, {
    method,
    headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CASES = [
  { action: 'shell', resources: ['echo hello-qihang-matrix'] },
  { action: 'read', resources: ['package.json'] },
  { action: 'read', resources: ['never-matches-xyz-probe'] },
  { action: 'glob', resources: ['**/*.ts'] },
];

(async () => {
  const s = await api('POST', '/api/session', { location: { directory: DIR } });
  const sid = s.json?.data?.id || s.json?.id;
  say('会话: ' + sid + '  location=' + JSON.stringify(s.json?.data?.location || s.json?.location));

  const before = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;

  for (const c of CASES) {
    const id = 'per_m_' + Math.random().toString(36).slice(2, 10);
    let effect = '(超时挂起=可能进入 ask)';
    try {
      const r = await api('POST', `/api/session/${sid}/permission`, {
        id,
        action: c.action,
        resources: c.resources,
        save: [],
        metadata: {},
        source: { type: 'tool', messageID: 'msg_matrix', id: 'call_matrix' },
        agent: 'build',
      }, 6000);
      effect = r.json?.data ? JSON.stringify(r.json.data).slice(0, 200) : r.text.slice(0, 160);
    } catch (e) {
      effect = '(请求挂起/超时: ' + (e?.name || e?.message) + ')';
    }
    say(`  ${c.action.padEnd(7)} ${JSON.stringify(c.resources).padEnd(30)} → ${effect}`);
  }
  await sleep(1500);
  const p = await api('GET', `/api/session/${sid}/permission`);
  say('\n会话 pending: ' + p.text.slice(0, 400));

  const after = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const fresh = after > before ? fs.readFileSync(logPath, 'utf8').slice(before) : '(探针日志无新增)';
  say('\n--- 探针日志新增（找 permission.asked）---');
  say(fresh.slice(0, 1500) || '(空)');
})().catch((e) => {
  say('失败: ' + (e?.message || e));
});
