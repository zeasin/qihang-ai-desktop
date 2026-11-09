/**
 * 移动网关笔记接口端到端验证（Electron headless）
 *
 * 用临时 USERPROFILE 隔离数据库/设备文件，跑编译后的 dist-electron 真实代码：
 *   1. 未注册目录 / 未授权访问 → 400 / 401
 *   2. /api/notes/tree：目录列全、隐藏文件与 node_modules 跳过、符号链接跳过
 *   3. /api/notes/file：正常读取、路径越权 403、不存在 404、二进制 400
 *   4. /api/notes/search：关键词命中、隐藏文件不参与
 *
 * 运行：node_modules/.bin/electron scripts/test-mobile-notes-e2e.js
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 必须在 require 业务模块之前重定向用户目录（database/logger/gateway 都在模块加载期取 homedir）。
// 与图片链路测试一致：monkey-patch os.homedir，不改 USERPROFILE（会破坏 Chromium 启动）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qihang-notes-e2e-'));
os.homedir = () => tmpHome;

const appRoot = path.join(__dirname, '..');
const { app } = require('electron');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

const TOKEN = 'TESTTOKEN123';
const PORT = 18998;
const KEYWORD = 'elasticsearch';

let failed = false;
function check(name, cond, detail) {
  const ok = !!cond;
  if (!ok) failed = true;
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}

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

    // 笔记库目录：正常文件 + 隐藏文件 + node_modules + 二进制 + 越界符号链接
    const notesDir = path.join(tmpHome, 'notes-e2e');
    fs.mkdirSync(path.join(notesDir, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(notesDir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(notesDir, '项目笔记.md'), '# 部署笔记\n\n今天研究 ' + KEYWORD + ' 集群部署。\n\n```js\nconsole.log(1)\n```\n');
    fs.writeFileSync(path.join(notesDir, '随手记.txt'), '今天看了 ' + KEYWORD + ' 文档。\n');
    fs.writeFileSync(path.join(notesDir, 'sub', '深藏.md'), '只有这里提到 ' + KEYWORD + ' 三次。\n');
    fs.writeFileSync(path.join(notesDir, '.hidden.md'), KEYWORD + ' 藏在隐藏文件里。\n');
    fs.writeFileSync(path.join(notesDir, 'node_modules', 'junk.js'), KEYWORD + ' in junk\n');
    fs.writeFileSync(path.join(notesDir, 'big.bin'), Buffer.from([0x42, 0x49, 0x4e, 0x00, 0xff, 0xfe]));
    let linkCreated = false;
    try {
      fs.symlinkSync(path.join(tmpHome, 'outside.md'), path.join(notesDir, 'link-out.md'), 'file');
      fs.writeFileSync(path.join(tmpHome, 'outside.md'), 'escaped\n');
      linkCreated = true;
    } catch {
      // Windows 无特权时创建符号链接会 EPERM，跳过该项断言
    }
    fs.writeFileSync(path.join(tmpHome, 'escape.md'), 'secret outside\n');

    const proj = db.project.add('笔记库E2E', 'note', notesDir, '', '');
    check('项目注册成功', !!proj.id, JSON.stringify(proj));

    const startResult = await gateway.startMobileGateway(PORT, {
      runTurn: async () => {},
      notifyDesktop: () => {},
    });
    check('网关启动', startResult.ok, JSON.stringify(startResult));

    const base = 'http://127.0.0.1:' + PORT;
    const auth = { Authorization: 'Bearer ' + TOKEN };

    // 1. 未授权 → 401
    const r0 = await fetch(base + '/api/notes/tree?dir=' + encodeURIComponent(notesDir));
    check('未授权访问笔记 401', r0.status === 401, String(r0.status));

    // 2. tree：列全 + 跳过隐藏/符号链接 + 目录在前
    const r1 = await fetch(base + '/api/notes/tree?dir=' + encodeURIComponent(notesDir), { headers: auth });
    const j1 = await r1.json();
    const names1 = (j1.entries || []).map((e) => e.name).filter((n) => n !== 'node_modules');
    check('tree 返回 200', r1.status === 200 && j1.ok === true, JSON.stringify(j1).slice(0, 120));
    check('tree 跳过隐藏文件', !names1.includes('.hidden.md'), names1.join(','));
    check('tree 跳过符号链接', !names1.includes('link-out.md') || !linkCreated, names1.join(','));
    check('tree 列出正常文件', ['项目笔记.md', '随手记.txt', 'big.bin', 'sub'].every((n) => names1.includes(n)), names1.join(','));
    check('tree 目录在前', (j1.entries || [])[0] && (j1.entries || [])[0].type === 'folder', JSON.stringify((j1.entries || [])[0] || {}));
    check('tree entries 带绝对路径', (j1.entries || []).every((e) => e.type === 'folder' ? fs.statSync(e.path).isDirectory() : fs.statSync(e.path).isFile()), '');

    // 2b. 子目录浏览（移动端点进 folder 依赖）：项目根下的子目录放行，越界仍拒
    const subDir = path.join(notesDir, 'sub');
    const r1b = await fetch(base + '/api/notes/tree?dir=' + encodeURIComponent(subDir), { headers: auth });
    const j1b = await r1b.json();
    check('tree 子目录 200', r1b.status === 200 && (j1b.entries || []).some((e) => e.name === '深藏.md'), r1b.status + ' | ' + JSON.stringify(j1b).slice(0, 100));
    const r1c = await fetch(base + '/api/notes/tree?dir=' + encodeURIComponent(path.resolve(notesDir, '..')), { headers: auth });
    check('tree 根上一层 400', r1c.status === 400, String(r1c.status));

    // 3. file 读取
    const r2 = await fetch(base + '/api/notes/file?dir=' + encodeURIComponent(notesDir) + '&path=' + encodeURIComponent('项目笔记.md'), { headers: auth });
    const j2 = await r2.json();
    check('file 读取 md 内容一致', r2.status === 200 && j2.content && j2.content.includes('```js'), r2.status + ' | ' + JSON.stringify(j2).slice(0, 80));
    check('file 返回 ext', j2.ext === '.md', String(j2.ext));

    const r3 = await fetch(base + '/api/notes/file?dir=' + encodeURIComponent(notesDir) + '&path=' + encodeURIComponent('sub/深藏.md'), { headers: auth });
    check('file 读取子目录 md', r3.status === 200 && (await r3.json()).content.includes('三次'), String(r3.status));

    // 4. 越权与异常
    const r4 = await fetch(base + '/api/notes/file?dir=' + encodeURIComponent(notesDir) + '&path=' + encodeURIComponent('../escape.md'), { headers: auth });
    check('file 目录外路径 403', r4.status === 403, String(r4.status));

    const r5 = await fetch(base + '/api/notes/file?dir=' + encodeURIComponent(notesDir) + '&path=' + encodeURIComponent('不存在.md'), { headers: auth });
    check('file 不存在 404', r5.status === 404, String(r5.status));

    const r6 = await fetch(base + '/api/notes/file?dir=' + encodeURIComponent(notesDir) + '&path=' + encodeURIComponent('big.bin'), { headers: auth });
    check('file 二进制 400', r6.status === 400, String(r6.status));

    if (linkCreated) {
      const r7 = await fetch(base + '/api/notes/file?dir=' + encodeURIComponent(notesDir) + '&path=' + encodeURIComponent('link-out.md'), { headers: auth });
      check('file 符号链接指向库外被拒 403', r7.status === 403, String(r7.status));
    } else {
      console.log('SKIP | 符号链接测试需要管理员权限，跳过');
    }

    // 5. 搜索
    const r8 = await fetch(base + '/api/notes/search?dir=' + encodeURIComponent(notesDir) + '&q=' + KEYWORD, { headers: auth });
    const j8 = await r8.json();
    const hitNames = (j8.results || []).map((x) => x.name);
    check('search 结果命中', r8.status === 200 && hitNames.includes('项目笔记.md') && hitNames.includes('深藏.md'), JSON.stringify(j8).slice(0, 200));
    check('search 隐藏文件不参与', !hitNames.includes('.hidden.md'), hitNames.join(','));
    check('search 命中带文本上下文', (j8.results || []).every((x) => x.text && x.text.includes(KEYWORD)), '');
    check('search 结果带相对路径', (j8.results || []).every((x) => !path.isAbsolute(x.path)), JSON.stringify((j8.results || []).map((x) => x.path)));

    // 6. 目录未注册
    const unreg = path.join(tmpHome, 'unregistered');
    fs.mkdirSync(unreg, { recursive: true });
    const r9 = await fetch(base + '/api/notes/tree?dir=' + encodeURIComponent(unreg), { headers: auth });
    check('tree 未注册目录 400', r9.status === 400, String(r9.status));
    const r10 = await fetch(base + '/api/notes/file?dir=' + encodeURIComponent(unreg) + '&path=' + encodeURIComponent('项目笔记.md'), { headers: auth });
    check('file 未注册目录 400', r10.status === 400, String(r10.status));

    await gateway.stopMobileGateway();
    fs.rmSync(tmpHome, { recursive: true, force: true });
    console.log(failed ? '\n== 笔记接口验证失败 ==' : '\n== 笔记接口验证全部通过 ==');
    app.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('异常:', e);
    app.exit(1);
  }
});
