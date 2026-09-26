/**
 * opencode 自管配置层
 *
 * - 自管配置目录：dev → <项目>/.qihang-oc/（不入库）；打包 → ~/.qihang-ai-desktop/opencode/
 * - opencode.json 由应用「对话模型配置」（~/.pi/agent/models.json）生成 provider 段，
 *   应用内配置的模型在 opencode 运行时下同样可用
 * - 固定 permission:"allow"（飞书/定时任务等无人值守场景不卡审批）、autoupdate:false
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { app } from 'electron';
import logger from './logger';
import { listBuiltinModelConfigs, QIHANG_SYSTEM_PROMPT } from './pi-agent';

export function ocConfigDir(): string {
  if (app.isPackaged) return path.join(os.homedir(), '.qihang-ai-desktop', 'opencode');
  return path.join(app.getAppPath(), '.qihang-oc');
}

export function ocWorkspaceDir(): string {
  return path.join(ocConfigDir(), 'workspace');
}

export function ocConfigFile(): string {
  return path.join(ocConfigDir(), 'opencode.json');
}

/** 生成 opencode.json（每次 serve 启动前调用，保证与应用内模型配置同步） */
export function writeOpencodeConfig(): void {
  const dir = ocConfigDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(ocWorkspaceDir(), { recursive: true });

  // 应用内对话模型配置 → opencode provider 段（OpenAI 兼容形态）
  const { providers } = listBuiltinModelConfigs();
  const ocProviders: Record<string, any> = {};
  for (const p of providers) {
    if (!p || !p.baseUrl || !p.apiKey || !Array.isArray(p.models) || !p.models.length) continue;
    const models: Record<string, any> = {};
    for (const m of p.models) {
      if (!m || !m.id) continue;
      models[m.id] = m.name ? { name: m.name } : {};
    }
    if (!Object.keys(models).length) continue;
    ocProviders[p.name] = {
      npm: '@ai-sdk/openai-compatible',
      name: p.displayName || p.name,
      options: { baseURL: p.baseUrl, apiKey: p.apiKey },
      models,
    };
  }

  // 系统提示词固化到 qihang.md，经 instructions 注入
  const qihangMd = path.join(dir, 'qihang.md');
  fs.writeFileSync(qihangMd, QIHANG_SYSTEM_PROMPT, 'utf-8');

  const config = {
    $schema: 'https://opencode.ai/config.json',
    permission: 'allow',
    autoupdate: false,
    instructions: [qihangMd],
    provider: ocProviders,
  };
  fs.writeFileSync(ocConfigFile(), JSON.stringify(config, null, 2), 'utf-8');
  logger.info('[OcConfig] opencode.json written: %s (providers=%d)', ocConfigFile(), Object.keys(ocProviders).length);
}
