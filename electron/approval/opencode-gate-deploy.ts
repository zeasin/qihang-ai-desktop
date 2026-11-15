/**
 * qihang-gate（OpenCode 插件）自动部署（开工作台即装，用户零操作）。
 *
 * 背景：OpenCode v2 的外部会话审批/回合通知依赖全局插件 ~/.config/opencode/plugins/qihang-gate.ts，
 * 漏装时外部 opencode 会话既不通知也不审批（静默失联）。现在每次启动审批通道时自动比对部署：
 * 不存在 / 内容有更新就写入，与 pi-approver-gate 的做法对齐。
 *
 * 设计：
 *   - 插件源文件随包分发：开发模式取 <repo>/opencode-qihang-gate/qihang-gate.ts，
 *     打包模式取 resources/qihang-gate.ts（electron-builder extraResources）。
 *   - 内容比对部署：逐字一致则跳过（不动用户文件）；不一致则覆盖为新版（插件是我们托管的文件，
 *     用户手改属例外，以工作台内置版为准——与 pi 扩展、Claude hook 同策略）。
 *   - 端口注入：插件默认写死 8790，部署时按当前 approverPort 生成工作台地址覆盖行，
 *     端口变化也触发重新部署（opencode 插件文件变更会自动热重载，无需重启 opencode）。
 *   - 失败不阻断启动：写不进去（权限/磁盘）只记日志，下次启动再试。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import logger from '../services/logger';

/** 插件在 opencode 全局插件目录下的文件名（固定，别改：改了旧文件会残留） */
export const OPENCODE_GATE_FILENAME = 'qihang-gate.ts';

/** 部署目标：~/.config/opencode/plugins/（opencode v2 全局插件目录，XDG 优先） */
export function openCodeGateTargetDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'opencode', 'plugins');
}

/** 打包判定：纯 node 环境（单测/脚本）下 electron 导入拿不到 app，退化为开发模式 */
function isPackaged(): boolean {
  try { return app.isPackaged; } catch { return false; }
}

/** 内置插件源文件路径：打包版 resources/（extraResources），开发版仓库目录 */
function builtinSourcePath(): string {
  if (isPackaged()) {
    const packaged = path.join(process.resourcesPath || '', 'qihang-gate.ts');
    if (fs.existsSync(packaged)) return packaged;
    logger.warn('[Approver] 打包版未找到内置插件 %s（检查 electron-builder extraResources）', packaged);
  }
  // 开发模式：dist-electron/electron/approval/opencode-gate-deploy.js → <repo>/opencode-qihang-gate/
  return path.resolve(__dirname, '..', '..', '..', 'opencode-qihang-gate', OPENCODE_GATE_FILENAME);
}

/** 读内置插件源码；读不到返回 null（如打包漏带 resources，属打包配置问题） */
function readBuiltinSource(): string | null {
  try {
    const src = fs.readFileSync(builtinSourcePath(), 'utf8');
    return src.includes('qihang-gate') ? src : null; // 防 COPY 打包后坏文件
  } catch {
    return null;
  }
}

/** 注入块标记（与插件源码里的注释一一对应） */
const BLOCK_RE =
  /\/\/ ---- auto-deploy endpoint \(by qihang-ai-desktop, do not edit\) ----\nconst BASE_URL = "http:\/\/127\.0\.0\.1:\d+";\n\/\/ ---- end auto-deploy endpoint ----/;

/**
 * 端口注入：替换插件里的工作台地址常量行。
 * 标记块存在就地替换（配置变化重新注入）；缺失时插到最后一条 import 之后（兼容旧块名/手工改过的插件）。
 */
function injectEndpoint(source: string, port: number): string {
  const block = [
    '// ---- auto-deploy endpoint (by qihang-ai-desktop, do not edit) ----',
    `const BASE_URL = "http://127.0.0.1:${port}";`,
    '// ---- end auto-deploy endpoint ----',
  ].join('\n');
  if (BLOCK_RE.test(source)) return source.replace(BLOCK_RE, block);
  // 旧块（pi 扩展历史命名）先剥掉，避免两份端点常量并存
  const stripped = source.replace(/\n\/\/ ---- auto-deploy (?:port override|env overrides)[\s\S]*$/, '\n');
  const lines = stripped.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^import\s/.test(lines[i]) || /^import\s*\{/.test(lines[i])) lastImport = i;
  }
  const at = lastImport >= 0 ? lastImport + 1 : 0;
  lines.splice(at, 0, block, '');
  return lines.join('\n');
}

export interface OpenCodeGateDeployResult {
  ok: boolean;
  action: 'skipped' | 'installed' | 'updated' | 'failed';
  target: string;
  error?: string;
}

/**
 * 部署 qihang-gate 插件到 ~/.config/opencode/plugins/。
 * @param port 审批通道端口（与 approver.ts 启动端口一致）
 */
export function deployOpenCodeGate(port: number): OpenCodeGateDeployResult {
  const targetDir = openCodeGateTargetDir();
  const target = path.join(targetDir, OPENCODE_GATE_FILENAME);
  try {
    const source = readBuiltinSource();
    if (!source) {
      return { ok: false, action: 'failed', target, error: '内置插件源文件缺失（检查打包 extraResources / 开发仓库目录）' };
    }
    const content = injectEndpoint(source, port);
    let action: OpenCodeGateDeployResult['action'] = 'installed';
    try {
      const existing = fs.readFileSync(target, 'utf8');
      if (existing === content) {
        return { ok: true, action: 'skipped', target }; // 已是最新：不动用户文件
      }
      action = 'updated';
    } catch {
      /* 目标不存在 → 全新安装 */
    }
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(target, content, 'utf8');
    logger.info('[Approver] qihang-gate 插件已%s：%s（port=%s）', action === 'installed' ? '安装' : '更新', target, port);
    return { ok: true, action, target };
  } catch (e: any) {
    // 部署失败不阻断启动：外部 opencode 会话暂时不通，下次启动重试
    const error = String(e?.message || e);
    logger.warn('[Approver] qihang-gate 插件部署失败（下次启动重试）：%s', error);
    return { ok: false, action: 'failed', target, error };
  }
}
