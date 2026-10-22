/**
 * 中继客户端冒烟测试（不依赖 Java 中继与真实手机）
 *
 * better-sqlite3 是按 Electron 的 ABI 编译的，普通 node 加载不了，
 * 因此整个脚本必须在 Electron 里跑：
 *   npx electron scripts/smoke-relay.cjs
 *
 * 做法：起一个内存里的假中继（health/register/password/clients + WS），
 * 把 HOME 指到临时目录（设备身份与 SQLite 都落在临时目录，不碰真实数据），
 * 灌几条测试数据，然后逐条核对桌面端发出的帧与收到的 RPC。
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qihang-relay-smoke-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { relayClient } = require('../dist-electron/electron/services/relay-client.js');
const db = require('../dist-electron/electron/services/database.js');
const deviceStore = require('../dist-electron/electron/services/relay-device.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ===== 假中继 =====
const registers = [];
const passwords = [];
const frames = [];
let deviceSocket = null;

const STALE = { projectId: '9999', sessionId: 'ghost_session' };

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const url = String(req.url || '');
    res.setHeader('Content-Type', 'application/json');
    if (url === '/relay/health') {
      res.end(JSON.stringify({ ok: true, service: 'relay-server', dbStatus: 'UP', devicesOnline: 0 }));
      return;
    }
    if (url === '/relay/device/register') {
      registers.push(JSON.parse(body || '{}'));
      res.end(JSON.stringify({ ok: true, deviceId: JSON.parse(body || '{}').deviceId }));
      return;
    }
    if (url === '/relay/device/password') {
      passwords.push(JSON.parse(body || '{}'));
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // 中继镜像里留着两条桌面端已经删掉的行，用来验证上线后的补删
    if (url.endsWith('/projects')) {
      res.end(JSON.stringify([{ projectId: '1', name: '有效' }, { projectId: STALE.projectId, name: '已删' }]));
      return;
    }
    if (url.endsWith('/sessions')) {
      res.end(JSON.stringify([{ sessionId: STALE.sessionId, title: '幽灵会话' }]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = String(req.url || '');
  if (!url.startsWith('/relay/ws/device')) { socket.destroy(); return; }
  const query = new URL('http://x' + url).searchParams;
  wss.handleUpgrade(req, socket, head, (ws) => {
    deviceSocket = ws;
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      frames.push(msg);
      if (msg.event === 'heartbeat') ws.send(JSON.stringify({ type: 'event', event: 'heartbeat:ack' }));
    });
  });
});

function waitFor(pred, ms = 4000, what = 'condition') {
  const deadline = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const hit = frames.filter(pred);
      if (hit.length) return resolve(hit);
      if (Date.now() > deadline) return reject(new Error(`等待超时：${what}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const relayUrl = `http://127.0.0.1:${String(port)}`;

  // ---- 灌测试数据 ----
  const proj = db.project.add('冒烟笔记库', 'note', path.join(TMP, 'notes'), '', '');
  const codeProj = db.project.add('冒烟代码库', 'code', path.join(TMP, 'repo'), '', '');
  const sid = 'smoke_session_1';
  db.chat.createSession(sid, proj.id, '冒烟会话', 'general', 'pi', 'ui');
  db.chat.addMessage(sid, 'user', '你好');
  db.chat.addMessage(sid, 'assistant', '你好，我在。');
  const taskId = db.task.add({ title: '冒烟任务', prompt: 'p', description: 'd', priority: 'mid', status: 'pending' }).id;

  // ---- 与主进程同款 RPC：本脚本用桩函数验证分发机制 ----
  relayClient.registerHandler('chat.send', (p) => { relayClient.pushEvent('chat.delta', { sessionId: p.sessionId, text: 'stub' }); return { ok: true }; });

  // ---- 连接 ----
  await relayClient.start(relayUrl);
  check('未设密码前不建 WS', !relayClient.isConnected());
  const device = await relayClient.enableWithPassword('smoke-pass-123');
  const conn = await relayClient.waitForConnected(5000);
  check('WS 握手成功', conn.connected, conn.error);
  check('设备信息回传渲染层（不含明文密码）', device.hasPassword === true && device.password === undefined);

  const reg = registers[registers.length - 1];
  check('register 上报了 deviceId/token/remoteEnabled',
    !!reg && !!reg.deviceId && !!reg.token && reg.remoteEnabled === true, JSON.stringify(reg));
  check('密码先经 /relay/device/password 校验', passwords.length > 0 && passwords[0].password === 'smoke-pass-123');

  // ---- 全量同步的帧形状对齐 SyncService.java ----
  const pFrame = await waitFor((f) => f.event === 'sync.project', 4000, 'sync.project');
  const projectIds = pFrame.map((f) => f.data.projectId);
  check('代码库也进镜像（project.list 会滤掉 code）',
    projectIds.includes(String(proj.id)) && projectIds.includes(String(codeProj.id)), projectIds.join(','));
  check('sync.project 字段齐', pFrame.every((f) => typeof f.data.projectId === 'string' && 'name' in f.data && f.data.status === 'active'));

  const sFrame = await waitFor((f) => f.event === 'sync.chatSession', 4000, 'sync.chatSession');
  const sPayload = sFrame.find((f) => f.data.sessionId === sid).data;
  check('sync.chatSession 用三端字段名 sessionId/adapterId', sPayload.sessionId === sid && sPayload.adapterId === 'pi', JSON.stringify(sPayload));
  check('lastActiveAt 是 epoch 毫秒', Number.isFinite(sPayload.lastActiveAt) && sPayload.lastActiveAt > 1e12, String(sPayload.lastActiveAt));

  const mFrame = await waitFor((f) => f.event === 'sync.full', 4000, 'sync.full');
  const pushed = mFrame[0].data.messages[sid] || [];
  check('两条消息随 sync.full 整段上送', pushed.length === 2, String(pushed.length));
  check('消息带幂等 messageUid = <sessionId>_<行 id>',
    pushed.every((m) => m.messageUid === `${sid}_${String(m.messageUid).split('_').pop()}`), pushed.map((m) => m.messageUid).join(','));
  check('消息 role/content/createdAt 齐',
    pushed.every((m) => m.role && typeof m.content === 'string' && m.createdAt > 1e12), JSON.stringify(pushed[0]));
  relayClient.syncRecentMessages(sid, 1);
  const inc = await waitFor((f) => f.event === 'sync.chatMessage', 3000, 'sync.chatMessage');
  check('增量单条消息走 sync.chatMessage', inc[0].data.sessionId === sid && !!inc[0].data.messageUid, JSON.stringify(inc[0].data));

  const tFrame = await waitFor((f) => f.event === 'sync.task', 4000, 'sync.task');
  check('任务镜像：priority mid→medium、taskId 字符串',
    tFrame[0].data.taskId === String(taskId) && tFrame[0].data.priority === 'medium', JSON.stringify(tFrame[0].data));

  const full = await waitFor((f) => f.event === 'sync.full', 4000, 'sync.full');
  check('sync.full 按会话整段给消息', !!full[0].data.messages[sid] && full[0].data.messages[sid].length === 2);

  // ---- 上线补删：中继镜像里的残留要被收敛掉 ----
  const delP = await waitFor((f) => f.event === 'sync.projectDeleted', 6000, 'sync.projectDeleted');
  check('补删中继里已不存在的项目', delP.some((f) => f.data.projectId === STALE.projectId), JSON.stringify(delP.map((f) => f.data)));
  const delS = await waitFor((f) => f.event === 'sync.chatSessionDeleted', 6000, 'sync.chatSessionDeleted');
  check('补删中继里的幽灵会话', delS.some((f) => f.data.sessionId === STALE.sessionId), JSON.stringify(delS.map((f) => f.data)));

  // ---- RPC 分发 ----
  function awaitFrame(pred, what) {
    return new Promise((resolve, reject) => {
      const onMsg = (raw) => {
        const m = JSON.parse(String(raw));
        if (!pred(m)) return;
        deviceSocket.off('message', onMsg);
        resolve(m);
      };
      deviceSocket.on('message', onMsg);
      setTimeout(() => { deviceSocket.off('message', onMsg); reject(new Error(`等待超时：${what}`)); }, 4000);
    });
  }
  const knownResp = awaitFrame((m) => m.id === 'rpc-known' && m.type === 'response', 'rpc response');
  const unknownResp = awaitFrame((m) => m.id === 'rpc-unknown' && m.type === 'error', 'unknown method error');
  deviceSocket.send(JSON.stringify({ id: 'rpc-known', type: 'request', method: 'chat.send', params: { sessionId: sid, text: 'hi', projectDir: 'C:/随便一个目录', projectId: String(proj.id) } }));
  deviceSocket.send(JSON.stringify({ id: 'rpc-unknown', type: 'request', method: 'collab.start', params: {} }));
  const known = await knownResp;
  check('已知方法回 response', known.id === 'rpc-known' && known.result && known.result.ok === true, JSON.stringify(known));
  const unknownHit = await unknownResp;
  check('未实现的方法回 error', !!unknownHit && /unknown method/.test(unknownHit.error || ''), JSON.stringify(unknownHit));
  const ev = await waitFor((f) => f.event === 'chat.delta', 3000, 'chat.delta');
  check('事件可主动推给移动端', ev[0].data.sessionId === sid);

  // ---- 心跳 ----
  const hb = await waitFor((f) => f.event === 'heartbeat', 30000, 'heartbeat');
  check('心跳帧发出且能收到 ack', !!hb.length && relayClient.isConnected());

  // ---- 增量钩子 ----
  frames.length = 0;
  db.project.update(proj.id, { name: '改名后的笔记库' });
  relayClient.syncProject(proj.id);
  const renamed = await waitFor((f) => f.event === 'sync.project' && f.data.name === '改名后的笔记库', 3000, 'sync.project rename');
  check('项目改名可增量上送', !!renamed.length);

  // 断开后不该把帧写飞
  // ---- 面板没点「保存并重连」就直接开密码：地址必须随请求落盘，不能拼出相对 URL ----
  deviceStore.patch({ relayUrl: '', remoteEnabled: false, password: undefined });
  relayClient.stop();
  let adoptErr = '';
  try { await relayClient.enableWithPassword('smoke-pass-123', relayUrl); } catch (e) { adoptErr = e.message; }
  const backAgain = await relayClient.waitForConnected(5000);
  check('地址未保存时开密码也能连上', !adoptErr && backAgain.connected, adoptErr || backAgain.error);

  relayClient.stop();
  check('stop() 后状态为未连接', !relayClient.isConnected());

  report(port);
}

function report(port) {
  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  [${r.detail}]` : ''}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed (relay on ${port})`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('SMOKE ABORT:', e && e.message ? e.message : String(e));
  for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  process.exit(1);
});
