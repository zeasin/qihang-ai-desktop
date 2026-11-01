import { ZcodeCollector } from './zcode';
import { QoderCollector } from './qoder';
import { OpenCodeCollector } from './opencode';
import { ClaudeCodeCollector } from './claude-code';
import { CodexCollector } from './codex';
import { PiCollector } from './pi';
import { TraeCollector } from './trae';
import { DshCollector } from './dsh';
import { ALL_TOOLS, type RadarConfig } from '../radar-config';
import type { HubCollector } from '../types';

/** 按配置实例化启用的采集器（单个构造失败不影响其余工具） */
export function defaultCollectors(cfg: RadarConfig): HubCollector[] {
  const enabled = new Set(cfg.tools.length ? cfg.tools : [...ALL_TOOLS]);
  const factories: [string, () => HubCollector][] = [
    ['zcode', () => new ZcodeCollector()],
    ['qoder', () => new QoderCollector()],
    ['opencode', () => new OpenCodeCollector()],
    ['claude-code', () => new ClaudeCodeCollector()],
    ['codex', () => new CodexCollector()],
    ['pi', () => new PiCollector()],
    ['trae', () => new TraeCollector()],
    ['dsh', () => new DshCollector()],
  ];
  const out: HubCollector[] = [];
  for (const [tool, factory] of factories) {
    if (!enabled.has(tool)) continue;
    try {
      out.push(factory());
    } catch (e: any) {
      console.log(`[RADAR-REGISTRY] ${tool} collector init failed: ${String(e?.message || e)}`);
    }
  }
  return out;
}
