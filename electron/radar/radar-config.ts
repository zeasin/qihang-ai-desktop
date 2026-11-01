import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 智能体雷达配置：数值来自应用 config.json（agentRadar* 键，由 agent-radar 服务组装），
 * 这里只放类型、工具枚举与目录/过滤工具函数。数据全部在本地 ~/.qihang-ai-desktop/radar/。
 */

export interface RadarConfig {
  /** 启用的工具（空 = 全部 8 个） */
  tools: string[];
  /** 排除的项目目录（不采集这些目录下的会话），大小写不敏感 */
  excludeProjects: string[];
  /** 活跃会话超过 N 天无动静自动冻结，0 = 关闭 */
  autoFreezeDays: number;
  /** 同步轮间隔（对话入库通道） */
  syncIntervalMs: number;
  /** 探针间隔（实时监控通道） */
  monitorIntervalMs: number;
  /** 探针活跃窗口：活动时间在窗口内的会话算"正在运行" */
  activeWindowMs: number;
  /** running 超过该时长无新活动 → idle */
  idleTimeoutMs: number;
}

export const ALL_TOOLS = ['zcode', 'claude-code', 'codex', 'opencode', 'qoder', 'trae', 'dsh', 'pi'] as const;

/** 雷达数据目录（正本库/指纹库/状态文件），全部本地、不出机器 */
export function radarDataDir(): string {
  return path.join(os.homedir(), '.qihang-ai-desktop', 'radar');
}

export function radarStatusFile(): string {
  return path.join(radarDataDir(), 'status.json');
}

/** 目录归一化：反斜杠统一、去尾斜杠、小写 */
export function normalizeDir(dir: string): string {
  return String(dir || '').replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
}

export function isExcluded(dir: string, excludeProjects: string[]): boolean {
  if (!dir) return false;
  const norm = normalizeDir(dir);
  return excludeProjects.some((e) => {
    const ex = normalizeDir(e);
    return norm === ex || norm.startsWith(ex + '\\');
  });
}

/** 确保数据目录存在（服务启动时调用一次） */
export function ensureDataDir(): string {
  const dir = radarDataDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
