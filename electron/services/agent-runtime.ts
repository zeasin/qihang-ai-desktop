/**
 * agent 运行时选择器
 *
 * - 默认 pi：本地工具全量可用，飞书/定时任务固定走 pi
 * - 用户在对话页手动切到 opencode 仅对当前会话生效，重启后回到 pi
 * - 切回 pi 时停掉 opencode serve；切到 opencode 懒启动，首次对话再拉起
 */
import logger from './logger';
import { listOcModels, disposeOc, ocStatus } from './opencode-agent';
import { listPiModels } from './pi-agent';

export type AgentRuntime = 'pi' | 'opencode';

/** 会话内手动切换的运行时（不持久化） */
let sessionRuntime: AgentRuntime | null = null;

export function currentRuntime(): AgentRuntime {
  return sessionRuntime || 'pi';
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
