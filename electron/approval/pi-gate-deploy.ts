/**
 * pi-approver-gate 扩展自动部署（开工作台即装，用户零操作）。
 *
 * 背景：pi CLI 终端审批依赖全局扩展 ~/.pi/agent/extensions/pi-approver-gate.ts，
 * 之前要手动复制安装，漏装时外部 pi 会话的拦截是"空转"的（不报错、不审批、静默放行）。
 * 现在每次启动审批通道时自动比对部署：不存在 / 内容有更新就写入，与 DSH 插件的做法对齐。
 *
 * 设计：
 *   - 扩展源文件随包分发：开发模式取 <repo>/pi-approver-gate/pi-approver-gate.ts，
 *     打包模式取 resources/pi-approver-gate.ts（electron-builder extraResources）。
 *   - 内容比对部署：逐字一致则跳过（不动用户文件）；不一致则覆盖为新版（扩展是我们
 *     托管的文件，用户手改属例外，以工作台内置版为准——与 Claude hook 同策略）。
 *   - 端口注入：扩展默认写死 8790，部署时按当前 approverPort 生成 PI_APPROVER_URL
 *     覆盖行，端口变化也触发重新部署。
 *   - 失败不阻断启动：写不进去（权限/磁盘）只记日志，下次启动再试。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import logger from '../services/logger';

/** 扩展在 pi 全局扩展目录下的文件名（固定，别改：改了旧文件会残留） */
export const PI_GATE_FILENAME = 'pi-approver-gate.ts';

/** 部署目标：~/.pi/agent/extensions/（pi 官方全局扩展目录） */
export function piGateTargetDir(): string {
  return path.join(os.homedir(), '.pi', 'agent', 'extensions');
}

/** 打包判定：纯 node 环境（单测/脚本）下 electron 导入拿不到 app，退化为开发模式 */
function isPackaged(): boolean {
  try { return app.isPackaged; } catch { return false; }
}

/** 内置扩展源文件路径：打包版 resources/（extraResources），开发版仓库目录 */
function builtinSourcePath(): string {
  if (isPackaged()) {
    const packaged = path.join(process.resourcesPath || '', 'pi-approver-gate.ts');
    if (fs.existsSync(packaged)) return packaged;
    logger.warn('[Approver] 打包版未找到内置扩展 %s（检查 electron-builder extraResources）', packaged);
  }
  // 开发模式：dist-electron/electron/approval/pi-gate-deploy.js → <repo>/pi-approver-gate/
  return path.resolve(__dirname, '..', '..', '..', 'pi-approver-gate', PI_GATE_FILENAME);
}

/** 读内置扩展源码；读不到返回 null（如打包漏带 resources，属打包配置问题） */
function readBuiltinSource(): string | null {
  try {
    const src = fs.readFileSync(builtinSourcePath(), 'utf8');
    return src.includes('pi-approver-gate') ? src : null; // 防 COPY 打包后坏文件
  } catch {
    return null;
  }
}

/** 源码尾部追加端口覆盖行（源文件默认 8790，非默认端口时必须注入） */
function injectPort(source: string, port: number): string {
  // 已含注入块：先剥掉旧块再追加新块（端口变化重新注入）
  const base = source.replace(/\n\/\/ ---- auto-deploy port override.*\n/s, '');
  return `${base}\n// ---- auto-deploy port override (by qihang-ai-desktop, do not edit) ----\nprocess.env.PI_APPROVER_URL = 'http://127.0.0.1:${port}/api/hooks/pi-approval';\n`;
}

export interface PiGateDeployResult {
  ok: boolean;
  action: 'skipped' | 'installed' | 'updated' | 'failed';
  target: string;
  error?: string;
}

/**
 * 部署 pi-approver-gate 扩展到 ~/.pi/agent/extensions/。
 * @param port 审批通道端口（与 approver.ts 启动端口一致）
 */
export function deployPiGate(port: number): PiGateDeployResult {
  const targetDir = piGateTargetDir();
  const target = path.join(targetDir, PI_GATE_FILENAME);
  try {
    const source = readBuiltinSource();
    if (!source) {
      return { ok: false, action: 'failed', target, error: '内置扩展源文件缺失（检查打包 extraResources / 开发仓库目录）' };
    }
    const content = injectPort(source, port);
    let action: PiGateDeployResult['action'] = 'installed';
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
    logger.info('[Approver] pi-approver-gate 扩展已%s：%s（port=%s）', action === 'installed' ? '安装' : '更新', target, port);
    return { ok: true, action, target };
  } catch (e: any) {
    // 部署失败不阻断启动：外部 pi 会话暂时走不拦截，下次启动重试
    const error = String(e?.message || e);
    logger.warn('[Approver] pi-approver-gate 扩展部署失败（下次启动重试）：%s', error);
    return { ok: false, action: 'failed', target, error };
  }
}
