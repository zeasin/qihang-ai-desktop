/**
 * 移动网关图片链路端到端验证（Electron headless）
 *
 * 用临时 USERPROFILE 隔离数据库/设备文件，跑编译后的 dist-electron 真实代码：
 *   1. POST 文本+图片 → 202，runTurn 收到完整 images
 *   2. POST 纯图片（无文本） → 202，消息落库带 images
 *   3. GET 历史 → images 从库里完整读回
 *   4. 无凭证 → 401
 *
 * 运行：node_modules/.bin/electron scripts/test-mobile-image-e2e.js
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 必须在 require 业务模块之前重定向用户目录（database/logger/gateway 都在模块加载期取 homedir）。
// 注意：不能改 USERPROFILE 环境变量 —— 会破坏 Chromium 启动（exit 3）；monkey-patch os.homedir 即可。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qihang-e2e-'));
os.homedir = () => tmpHome;

const appRoot = path.join(__dirname, '..');
// Electron 主进程里 require('electron') 命中内置模块（npm 包只是路径桩，不能用绝对路径引）
const { app } = require('electron');
// headless 测试不需要 GPU；禁掉避免 Windows 环境下 V8/GPU 相关崩溃
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// 1x1 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'TESTTOKEN123';
const PORT = 18999;
const SID = 'e2e_img_session';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failed = true;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  try {
    const homeDir = path.join(tmpHome, '.qihang-ai-desktop');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, 'mobile-devices.json'),
      JSON.stringify({ devices: [{ id: 'e2e', name: 'e2e-test', hash: crypto.createHash('sha256').update(TOKEN).digest('hex'), createdAt: new Date().toISOString() }] }),
    );

    const db = require(path.join(appRoot, 'dist-electron', 'electron', 'services', 'database'));
    const gateway = require(path.join(appRoot, 'dist-electron', 'electron', 'mobile', 'gateway'));

    db.chat.createSession(SID, null, 'E2E图片测试', 'general', 'pi', 'mobile');

    const captured = [];
    const startResult = await gateway.startMobileGateway(PORT, {
      // 生产里 runTurn=runChatTurn，user 消息在其内部落库；测试桩按同一契约复现
      runTurn: async (payload) => {
        captured.push(payload);
        db.chat.addMessage(payload.sessionId, 'user', payload.question, 'pi', payload.images);
      },
      notifyDesktop: () => {},
    });
    check('网关启动', startResult.ok, JSON.stringify(startResult));

    const base = 'http://127.0.0.1:' + PORT;

    // 1. 文本 + 图片
    const r1 = await fetch(base + '/api/sessions/' + SID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '帮我看这张图', images: [{ data: PNG_B64, mimeType: 'image/png' }] }),
    });
    const j1 = await r1.json();
    check('文本+图片请求返回 202', r1.status === 202 && j1.ok, JSON.stringify(j1));
    await sleep(200);
    const turn1 = captured[0] || {};
    check('runTurn 收到图片', Array.isArray(turn1.images) && turn1.images.length === 1
      && turn1.images[0].data === PNG_B64 && turn1.images[0].mimeType === 'image/png',
      JSON.stringify(turn1.images ? turn1.images.map((i) => ({ mime: i.mimeType, len: i.data.length })) : null));
    check('runTurn 收到文本', turn1.question === '帮我看这张图', String(turn1.question));

    // 2. 纯图片（无文本）
    const r2 = await fetch(base + '/api/sessions/' + SID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '', images: [{ data: PNG_B64, mimeType: 'image/png' }] }),
    });
    check('纯图片请求返回 202', r2.status === 202, String(r2.status));
    await sleep(200);
    check('纯图片也进 runTurn', Array.isArray(captured[1] && captured[1].images) && captured[1].images.length === 1, '');

    // 3. data-URL 前缀自动剥离（旧客户端兼容）
    const r3 = await fetch(base + '/api/sessions/' + SID + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '带前缀', images: [{ data: 'data:image/jpeg;base64,' + PNG_B64, mimeType: 'image/jpeg' }] }),
    });
    check('dataURL 前缀剥离 202', r3.status === 202, String(r3.status));
    await sleep(200);
    check('前缀剥离后 data 干净', captured[2] && captured[2].images && captured[2].images[0].data === PNG_B64, '');

    // 4. 历史读回
    const r4 = await fetch(base + '/api/sessions/' + SID + '/messages', { headers: { Authorization: 'Bearer ' + TOKEN } });
    const j4 = await r4.json();
    const userMsgs = (j4.messages || []).filter((m) => m.role === 'user');
    check('历史共 3 条用户消息', userMsgs.length === 3, String(userMsgs.length));
    check('历史消息带 images', userMsgs.every((m) => Array.isArray(m.images) && m.images.length === 1 && m.images[0].data === PNG_B64),
      JSON.stringify(userMsgs.map((m) => (m.images || []).length)));

    // 5. 无凭证 401
    const r5 = await fetch(base + '/api/sessions/' + SID + '/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'x' }),
    });
    check('无凭证 401', r5.status === 401, String(r5.status));

    // 6. 会话不存在 404
    const r6 = await fetch(base + '/api/sessions/nope/messages', {
      method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'x' }),
    });
    check('会话不存在 404', r6.status === 404, String(r6.status));

    console.log(failed ? '--- E2E 结果：存在失败项 ---' : '--- E2E 结果：全部通过 ---');
  } catch (e) {
    failed = true;
    console.error('E2E 异常:', e && e.stack || e);
  } finally {
    try { require('child_process').execSync('rm -rf "' + tmpHome + '"', { shell: 'bash.exe' }); } catch { /* 留在临时目录无碍 */ }
    app.exit(failed ? 1 : 0);
  }
});
