/**
 * Claude Code hooks 自愈部署（开工作台即修，用户零操作）。
 *
 * 背景：Claude Code 没有插件目录可托管，审批/通知依赖写在 ~/.claude/settings.json 里的
 * 两个 http hook——PermissionRequest → /api/hooks/permission-request（审批），
 * Stop → /api/hooks/claude-stop（完成/失败通知 + 「继续」快速通道）。
 * 而用户切换模型/供应商的惯用做法是整体替换 settings.json（~/.claude 下躺着一堆
 * settings.json-* 变体），hooks 段被一起抹掉，完成/错误/审批/继续对话四路通知静默消失
 * （2026-11-04 ~ 11-15 实测断档 11 天才发现）。现审批通道启动时自愈：缺什么补什么。
 *
 * 设计（与 pi-gate-deploy / opencode-gate-deploy 对齐，但有一处本质不同）：
 *   - settings.json 是用户的文件，不是托管文件——只合并/修正属于我们的 hook 条目
 *     （按 url 路径识别），其余字段与用户自配的其它 hook 原样保留，绝不整体覆盖。
 *   - 内容已一致则跳过不写（不动用户文件）；写入前留一份 .bak-qihang 滚动备份。
 *   - 端口注入：url 按当前 approverPort 生成，端口变化触发修正。
 *   - Stop hook 的 timeout（秒）必须大于「继续」快速通道窗口，否则窗口内 hook 先被掐断，
 *     追问送不回终端；部署按 quickWindowSec + 30s 余量生成（下限 60s）。
 *   - 失败不阻断启动：文件不可读/不可写/JSON 解析失败只记日志，下次启动重试。
 *   - 局限：只在审批通道启动时检查；运行期间 settings.json 被换掉要到下次启动才自愈。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import logger from '../services/logger';

/** hook url 路径（识别「我们的条目」的标志，与 server.ts 路由一致） */
const PERM_PATH = '/api/hooks/permission-request';
const STOP_PATH = '/api/hooks/claude-stop';
/** 回合异常终止（429/模型不可用等）专用事件：只做失败通知，不挂起不接管 */
const STOP_FAILURE_PATH = '/api/hooks/claude-stop-failure';

/** PermissionRequest hook 超时（秒）：审批挂起上限 540s，留余量 */
const PERM_TIMEOUT_SEC = 600;

export interface ClaudeHookDeployResult {
  ok: boolean;
  action: 'skipped' | 'installed' | 'updated' | 'failed';
  target: string;
  error?: string;
}

export function claudeSettingsPath(): string {
  // 测试/隔离用：QH_CLAUDE_SETTINGS 指向临时文件，避免验证时动到用户真实配置
  const override = process.env.QH_CLAUDE_SETTINGS;
  if (override) return override;
  return path.join(os.homedir(), '.claude', 'settings.json');
}

function hookUrl(port: number, p: string): string {
  return `http://127.0.0.1:${port}${p}`;
}

/** 在 hook 组列表里找到含我们 url 的条目（按路径识别，不看端口——端口可能待修正） */
function findOurs(groups: any[], p: string): { group: any; hook: any } | null {
  if (!Array.isArray(groups)) return null;
  for (const group of groups) {
    if (!Array.isArray(group?.hooks)) continue;
    for (const hook of group.hooks) {
      if (typeof hook?.url === 'string' && hook.url.includes(p)) return { group, hook };
    }
  }
  return null;
}

/**
 * 确保 settings.json 的 hooks 段带齐我们的两个 hook。
 * @param port 审批通道端口（与 approver.ts 启动端口一致）
 * @param quickWindowSec 「继续」快速通道窗口（秒），Stop hook timeout 据此 +30s 余量
 */
export function deployClaudeHooks(port: number, quickWindowSec: number): ClaudeHookDeployResult {
  const target = claudeSettingsPath();
  const stopTimeout = Math.max(60, Math.ceil(quickWindowSec) + 30);
  try {
    let settings: any = {};
    let existed = true;
    try {
      const raw = fs.readFileSync(target, 'utf8');
      settings = JSON.parse(raw);
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { ok: false, action: 'failed', target, error: 'settings.json 顶层不是对象，放弃写入（不动用户文件）' };
      }
    } catch (e: any) {
      if (e?.code === 'ENOENT') {
        existed = false; // 全新安装：只有 hooks 一个字段
      } else {
        // 解析失败：宁可不部署也不能毁掉用户配置
        return { ok: false, action: 'failed', target, error: `settings.json 解析失败，放弃写入：${e?.message || e}` };
      }
    }

    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    let changed = false;

    // PermissionRequest：审批入口
    const permUrl = hookUrl(port, PERM_PATH);
    const perm = findOurs(hooks.PermissionRequest, PERM_PATH);
    if (perm) {
      if (perm.hook.url !== permUrl || perm.hook.timeout !== PERM_TIMEOUT_SEC) {
        perm.hook.url = permUrl;
        perm.hook.timeout = PERM_TIMEOUT_SEC;
        changed = true;
      }
    } else {
      const groups = Array.isArray(hooks.PermissionRequest) ? hooks.PermissionRequest : [];
      groups.push({
        matcher: '*',
        hooks: [{ type: 'http', url: permUrl, timeout: PERM_TIMEOUT_SEC, onFailure: 'continue' }],
      });
      hooks.PermissionRequest = groups;
      changed = true;
    }

    // Stop：回合结束通知 + 「继续」快速通道（追问经 decision:block 注回原终端会话执行）
    // StopFailure：回合异常终止（429 等）通知。两个都配，参数化复用同一段合并逻辑。
    const ensureTurnEndHook = (event: 'Stop' | 'StopFailure', path: string): void => {
      const hookUrlValue = hookUrl(port, path);
      const found = findOurs(hooks[event], path);
      if (found) {
        if (found.hook.url !== hookUrlValue || found.hook.timeout !== stopTimeout) {
          found.hook.url = hookUrlValue;
          found.hook.timeout = stopTimeout;
          changed = true;
        }
        return;
      }
      const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
      groups.push({
        hooks: [{ type: 'http', url: hookUrlValue, timeout: stopTimeout, onFailure: 'continue' }],
      });
      hooks[event] = groups;
      changed = true;
    };
    ensureTurnEndHook('Stop', STOP_PATH);
    ensureTurnEndHook('StopFailure', STOP_FAILURE_PATH);

    if (!changed && existed) return { ok: true, action: 'skipped', target };

    settings.hooks = hooks;
    if (existed) {
      // 滚动备份：改动用户文件前留底（单份即可，多次启动不堆积）
      try { fs.copyFileSync(target, `${target}.bak-qihang`); } catch { /* 备份失败不阻断部署 */ }
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    const action = existed ? 'updated' : 'installed';
    logger.info('[Approver] Claude hooks 已%s：%s（port=%s，stopTimeout=%ss）', action === 'installed' ? '安装' : '修正', target, port, stopTimeout);
    return { ok: true, action, target };
  } catch (e: any) {
    const error = String(e?.message || e);
    logger.warn('[Approver] Claude hooks 部署失败（下次启动重试）：%s', error);
    return { ok: false, action: 'failed', target, error };
  }
}
