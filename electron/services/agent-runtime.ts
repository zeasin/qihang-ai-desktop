/**
 * agent 运行时选择器
 *
 * 每次应用启动主动检测 opencode 环境（捆绑二进制或本机已安装）：
 * - 检测到 → 本次会话默认 opencode；未检测到 → 默认 pi
 * - 用户在对话页手动切换仅对当前会话生效，重启后按环境重新判定
 * - pi 为回退引擎原样保留；切到 pi 时停掉 opencode serve
 */
import logger from './logger';
import { listOcModels, disposeOc, ocStatus } from './opencode-agent';
import { isOcAvailable } from './opencode-process';
import { listPiModels } from './pi-agent';

export type AgentRuntime = 'pi' | 'opencode';

/** 会话内手动切换的运行时（不持久化，重启后按环境重新检测） */
let sessionRuntime: AgentRuntime | null = null;

export function currentRuntime(): AgentRuntime {
  if (sessionRuntime) return sessionRuntime;
  return isOcAvailable() ? 'opencode' : 'pi';
}

export async function setAgentRuntime(runtime: string): Promise<void> {
  const next: AgentRuntime = runtime === 'opencode' ? 'opencode' : 'pi';
  const prev = currentRuntime();
  if (next === prev) return;
  sessionRuntime = next;
  logger.info('[AgentRuntime] %s -> %s (session only)', prev, next);
  if (next === 'pi') {
    disposeOc();
  }
  // 切到 opencode：懒启动，首次对话时 ensureOcServer 再拉起
}

export async function listAgentModels(): Promise<{ models: any[]; error?: string; runtime: string }> {
  if (currentRuntime() === 'opencode') {
    const res = await listOcModels();
    return { ...res, runtime: 'opencode' };
  }
  const res = await listPiModels();
  return { ...res, runtime: 'pi' };
}

export function agentStatus(): { runtime: string; oc: { running: boolean; baseUrl: string; sessions: number } } {
  return { runtime: currentRuntime(), oc: ocStatus() };
}
