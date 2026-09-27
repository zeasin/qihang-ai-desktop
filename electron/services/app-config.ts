/**
 * 应用级配置（config.json）
 * 开发模式保存在项目根目录 config.json；打包版保存在用户主目录
 * .qihang-ai-desktop 下（与数据库、日志同一目录），避免写入安装目录
 * /asar 内部导致无法保存。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { app } from 'electron';
import logger from './logger';

function resolveConfigPath(): string {
  if (process.env.QIHANG_CONFIG_PATH) return process.env.QIHANG_CONFIG_PATH;
  if (app.isPackaged) {
    // 与数据库（qihang-ai-desktop.db）、日志同一目录
    return path.join(os.homedir(), '.qihang-ai-desktop', 'config.json');
  }
  // 开发模式沿用项目根目录 config.json
  return path.join(__dirname, '..', '..', '..', 'config.json');
}

export const CONFIG_PATH = resolveConfigPath();

let cached: any | null = null;

export function loadConfig(): any {
  if (cached) return cached;
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      // 首次启动：config.json 不存在时从模板复制（含日报提示词等默认值）
      const templatePath = CONFIG_PATH + '.template';
      if (fs.existsSync(templatePath)) {
        try {
          fs.copyFileSync(templatePath, CONFIG_PATH);
          logger.info('[AppConfig] 首次启动，已从 %s 生成 config.json', path.basename(templatePath));
        } catch (e: any) {
          logger.warn('[AppConfig] 复制模板失败: %s', e && e.message ? e.message : e);
        }
      }
    }
    if (fs.existsSync(CONFIG_PATH)) {
      const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
      cached = raw ? JSON.parse(raw) : {};
    }
  } catch (e: any) {
    logger.warn('[AppConfig] 读取 config.json 失败: %s', e && e.message ? e.message : e);
  }
  cached = cached || {};
  return cached;
}

export function saveConfig(patch: Record<string, unknown>): void {
  const cfg = { ...loadConfig(), ...patch };
  cached = cfg;
  try {
    const dir = path.dirname(CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e: any) {
    logger.warn('[AppConfig] 写入 config.json 失败: %s', e && e.message ? e.message : e);
  }
}

/** 默认笔记库目录指针（多库：≡ 默认库 dir，由 main.ts syncDefaultNotesDir 维护） */
export function getNotesDir(): string {
  const dir = loadConfig().notesDir;
  return typeof dir === 'string' ? dir : '';
}

export function setNotesDir(dir: string): void {
  saveConfig({ notesDir: dir || null });
}

/** 读取任意配置键（不存在时返回空串） */
export function getConfig(key: string): string {
  const v = loadConfig()[key];
  return v === undefined || v === null ? '' : String(v);
}

/** 配置键是否已在 config.json 中显式存在 */
export function hasConfigKey(key: string): boolean {
  return loadConfig()[key] !== undefined;
}
