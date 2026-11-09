/**
 * 移动端笔记页面浏览器烟测用：临时网关服务
 *
 * 与 e2e 相同的隔离手法（monkey-patch os.homedir 到 tmp），另起一个端口（18997）：
 *   - 自建样例笔记项目（含 md/txt/子目录）
 *   - 设备文件写入本地测试 token（TESTTOKEN123）
 *   - 保持进程存活，供浏览器真实操作 index.html 的笔记页
 *
 * 不是性能/安全测试；仅用于 UI 烟测。用完 kill 即可。
 */
'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qihang-smoke-'));
os.homedir = () => tmpHome;

const appRoot = path.join(__dirname, '..');
const { app } = require('electron');
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

// gateway 用 app.getAppPath() 定位 resources/mobile/index.html；作为脚本启动时它
// 指向 scripts 目录，把静态页面路径指回仓库根
app.getAppPath = () => appRoot;

const TOKEN = 'TESTTOKEN123';
const PORT = 18997;

app.whenReady().then(async () => {
  const homeDir = path.join(tmpHome, '.qihang-ai-desktop');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(homeDir, 'mobile-devices.json'),
    JSON.stringify({ devices: [{ id: 'smoke', name: 'smoke-browser', hash: crypto.createHash('sha256').update(TOKEN).digest('hex'), createdAt: new Date().toISOString() }] }),
  );

  const db = require(path.join(appRoot, 'dist-electron', 'electron', 'services', 'database'));
  const gateway = require(path.join(appRoot, 'dist-electron', 'electron', 'mobile', 'gateway'));

  const notesDir = path.join(tmpHome, 'notes');
  fs.mkdirSync(path.join(notesDir, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(notesDir, '项目笔记.md'), '# 部署笔记\n\n今天研究 cluster 集群部署。\n\n```js\nconsole.log(1)\n```\n');
  fs.writeFileSync(path.join(notesDir, '随手记.txt'), '今天看了 elasticsearch 文档。\n');
  fs.writeFileSync(path.join(notesDir, 'sub', '深藏.md'), '只有这里提到 elasticsearch 三次。\n');
  db.project.add('笔记库E2E', 'note', notesDir, '', '');

  const startResult = await gateway.startMobileGateway(PORT, {
    runTurn: async () => {},
    notifyDesktop: () => {},
  });
  if (!startResult.ok) {
    console.log('SMOKE_GATEWAY_FAIL ' + JSON.stringify(startResult));
    app.exit(1);
    return;
  }
  // 生成一次性配对码供浏览器烟测走真实配对流程
  const pairCode = gateway.requestMobilePairCode();
  console.log('SMOKE_GATEWAY_UP port=' + PORT + ' pairCode=' + pairCode.code);
  // 保持存活，供浏览器交互
  app.on('window-all-closed', () => {});
});
