/**
 * 知识库 MCP —— 工具定义层（kb-tools.ts）
 *
 * 5 个只读工具：search（多源统一检索）/ get_note / list_notes / get_session / recent_activity。
 * 数据源：个人笔记（FTS5）、外部 AI 会话（radar.db 只读）、应用内对话（chat_message_fts）、
 * 历史报告与模块分析（ai_analysis LIKE）。
 *
 * 返回统一 JSON 信封 { records | ... }，与 mcp-manager.ts parseToolResult 的识别键兼容，
 * 方便本应用主进程直连消费。
 */
import { z } from 'zod';
import {
  searchNotes, getNoteContent, listNoteProjects, listProjectFiles,
  searchSessions, searchChat, searchReports, radarAvailable,
  getSessionDetail, recentActivity,
} from './kb-index';
import logger from '../services/logger';

/** 统一的文本内容返回（MCP content block） */
function textResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], isError };
}

function errorResult(e: unknown, scope: string) {
  const msg = e && typeof e === 'object' && 'message' in e ? String((e as any).message) : String(e);
  logger.error('[KbTools] %s 失败: %s', scope, msg);
  return textResult({ error: `${scope}失败: ${msg}` }, true);
}

/** 毫秒 → 本地时间 'YYYY-MM-DD HH:mm'（工具结果给人/模型看，不用 UTC ISO） */
function fmtLocal(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把 5 个工具注册到 McpServer 实例上（server 层每请求新建实例后调用） */
export function registerKbTools(server: any): void {
  server.registerTool(
    'search',
    {
      title: '知识库统一检索',
      description:
        '检索本地知识库：个人笔记、历史 AI 会话及摘要、应用内对话、历史报告。' +
        '用户问「我之前做过/研究过/记录过 X」「以前的结论是什么」时先调它，' +
        '可用 scope 限定数据源；命中笔记后用 get_note 读全文，命中会话后用 get_session 看详情。',
      inputSchema: {
        query: z.string().min(1).describe('检索词，中英文均可；少于 3 个字符时笔记只匹配标题'),
        scope: z.enum(['all', 'notes', 'sessions', 'chat', 'reports']).optional()
          .describe('数据源：all(默认)/notes 笔记/sessions 外部 AI 会话/chat 应用内对话/reports 历史报告'),
        agent: z.string().optional().describe('仅 sessions：按 agent 工具过滤，如 claude、codex、trae、qoder、opencode、dsh、pi'),
        days: z.number().int().min(1).max(3650).optional().describe('仅检索最近 N 天'),
        limit: z.number().int().min(1).max(50).optional().describe('每个数据源返回条数上限，默认 10'),
      },
    },
    async (args: { query: string; scope?: string; agent?: string; days?: number; limit?: number }) => {
      try {
        const scope = args.scope || 'all';
        const limit = Math.min(args.limit || 10, 50);
        const records: any[] = [];
        const unavailable: string[] = [];
        let notesMode = '';

        if (scope === 'all' || scope === 'notes') {
          const { hits, mode } = searchNotes(args.query, limit);
          notesMode = mode;
          for (const h of hits) {
            records.push({
              source: 'note',
              ref: h.absPath,
              project: h.project,
              path: h.rel,
              title: h.title,
              snippet: h.snippet,
              updated_at: fmtLocal(h.mtimeMs),
              score: h.score,
            });
          }
        }

        if (scope === 'all' || scope === 'sessions') {
          if (!radarAvailable()) {
            unavailable.push('sessions（雷达库不存在，尚未采集外部 AI 会话）');
          } else {
            for (const h of searchSessions(args.query, limit, { agent: args.agent, days: args.days })) {
              records.push({
                source: 'session',
                ref: `radar:${h.tool}:${h.sessionId}`,
                tool: h.tool,
                title: h.title,
                project: h.projectDir,
                state: h.state,
                snippet: h.snippet,
                updated_at: fmtLocal(h.updatedAt),
              });
            }
          }
        }

        if (scope === 'all' || scope === 'chat') {
          for (const h of searchChat(args.query, limit, { days: args.days })) {
            records.push({
              source: 'chat',
              ref: `chat:${h.sessionId}:${h.rowid}`,
              session: h.sessionId,
              title: h.title,
              role: h.role,
              snippet: h.snippet,
              updated_at: h.createdAt,
              score: h.score,
            });
          }
        }

        if (scope === 'all' || scope === 'reports') {
          for (const h of searchReports(args.query, limit, { days: args.days })) {
            records.push({
              source: 'report',
              ref: `analysis:${h.id}`,
              type: h.type,
              module: h.moduleId,
              report_date: h.reportDate,
              snippet: h.snippet,
            });
          }
        }

        return textResult({
          scope,
          mode: notesMode || undefined,
          total: records.length,
          unavailable: unavailable.length ? unavailable : undefined,
          records,
        });
      } catch (e) {
        return errorResult(e, 'search');
      }
    },
  );

  server.registerTool(
    'get_note',
    {
      title: '读笔记全文',
      description: '读取一篇笔记的 Markdown 全文。path 支持 search 返回的 ref（绝对路径）或「项目名/相对路径」。笔记很长时会截断并标注 truncated。',
      inputSchema: {
        path: z.string().min(1).describe('笔记路径：绝对路径，或「项目名/相对路径」'),
      },
    },
    async (args: { path: string }) => {
      try {
        const r = getNoteContent(args.path);
        if (!r.ok) return textResult({ error: r.error }, true);
        return textResult({
          path: r.abs,
          project: r.project,
          rel: r.rel,
          title: r.title,
          truncated: r.truncated,
          content: r.content,
        });
      } catch (e) {
        return errorResult(e, 'get_note');
      }
    },
  );

  server.registerTool(
    'list_notes',
    {
      title: '笔记库浏览',
      description: '浏览笔记库：不带参数返回所有笔记项目及各自篇数；传 project（项目名）返回该项目下全部 .md 文件清单。先 list 再 search/get_note 是了解笔记库结构的推荐路径。',
      inputSchema: {
        project: z.string().optional().describe('项目名；不传则列出所有笔记项目'),
        limit: z.number().int().min(1).max(500).optional().describe('文件清单上限，默认 200'),
      },
    },
    async (args: { project?: string; limit?: number }) => {
      try {
        if (!args.project) {
          const projects = listNoteProjects();
          return textResult({ total: projects.length, records: projects.map((p) => ({ name: p.name, dir: p.dir, doc_count: p.docCount })) });
        }
        const proj = listNoteProjects().find((p) => p.name === args.project);
        if (!proj) return textResult({ error: `笔记项目不存在：${args.project}（先用无参 list_notes 查看项目列表）` }, true);
        const { files, hasMore } = listProjectFiles(proj.projectId, Math.min(args.limit || 200, 500));
        return textResult({ project: proj.name, total: files.length, has_more: hasMore, records: files.map((f) => ({ path: f.rel, title: f.title, updated_at: fmtLocal(f.mtimeMs) })) });
      } catch (e) {
        return errorResult(e, 'list_notes');
      }
    },
  );

  server.registerTool(
    'get_session',
    {
      title: '读外部 AI 会话详情',
      description:
        '读取一个已采集的外部 AI 会话（Claude Code / Codex / Trae / Qoder / opencode 等）的元信息与 AI 摘要；' +
        'messages>0 时附最近 N 条消息正文。session_id 来自 search 返回的 ref（radar:<tool>:<id>）末段。',
      inputSchema: {
        session_id: z.string().min(1).describe('会话 ID（search 结果 ref 中 radar:<tool>:<id> 的 id 部分）'),
        messages: z.number().int().min(0).max(200).optional().describe('附带的最近消息条数，默认 0（只返回摘要）'),
      },
    },
    async (args: { session_id: string; messages?: number }) => {
      try {
        const r = getSessionDetail(args.session_id, args.messages || 0);
        if (!r.ok) return textResult({ error: r.error }, true);
        return textResult(r);
      } catch (e) {
        return errorResult(e, 'get_session');
      }
    },
  );

  server.registerTool(
    'recent_activity',
    {
      title: '最近 AI 活动',
      description:
        '列出最近 N 天活跃的外部 AI 会话（含摘要）以及最近生成的历史报告/模块分析。' +
        '用户问「最近 AI 在做什么」「昨天/这周的进展」时用它。',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('回看天数，默认 7'),
        limit: z.number().int().min(1).max(100).optional().describe('每类条数上限，默认 20'),
      },
    },
    async (args: { days?: number; limit?: number }) => {
      try {
        const r = recentActivity(args.days || 7, args.limit || 20);
        return textResult({
          days: args.days || 7,
          total: r.sessions.length + r.reports.length,
          sessions: r.sessions.map((s) => ({ ...s, updated_at: fmtLocal(s.updatedAt), updatedAt: undefined })),
          reports: r.reports,
        });
      } catch (e) {
        return errorResult(e, 'recent_activity');
      }
    },
  );
}
