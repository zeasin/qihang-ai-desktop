import * as cron from 'node-cron';
import * as path from 'path';
import * as db from './database';
import * as appConfig from './app-config';
import logger from './logger';
import { Notification } from 'electron';

function convertMarkdownForFeishu(md: string): string {
  const lines = md.trim().split('\n');
  const out: string[] = [];
  let lastBlank = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // 连续空行合并为一个
    if (line.trim() === '') {
      if (!lastBlank) { out.push(''); lastBlank = true; }
      i++;
      continue;
    }
    lastBlank = false;
    // 表格：转为 key: value 列表
    if (line.startsWith('|') && line.endsWith('|')) {
      const headerCells = line.split('|').slice(1, -1).map(c => c.trim());
      const isSeparator = headerCells.every(c => /^[-: ]+$/.test(c));
      if (isSeparator) {
        i++;
        continue;
      }
      const dataRows: string[][] = [];
      i++;
      while (i < lines.length && lines[i].startsWith('|') && lines[i].endsWith('|')) {
        const cells = lines[i].split('|').slice(1, -1).map(c => c.trim());
        if (!cells.every(c => /^[-: ]+$/.test(c))) {
          dataRows.push(cells);
        }
        i++;
      }
      if (dataRows.length > 0) {
        const maxCols = Math.max(headerCells.length, ...dataRows.map(r => r.length));
        for (const row of dataRows) {
          const parts: string[] = [];
          for (let c = 0; c < maxCols; c++) {
            const label = headerCells[c] || `字段${c + 1}`;
            const val = row[c] || '';
            parts.push(`**${label}**: ${val}`);
          }
          out.push('- ' + parts.join(' | '));
        }
      }
      continue;
    }
    // 标题：## xxx → **xxx**
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      out.push('**' + headingMatch[1].trim() + '**');
      i++;
      continue;
    }
    // 分割线：--- / *** → 空行
    if (/^[-*]{3,}\s*$/.test(line.trim())) {
      out.push('');
      i++;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join('\n');
}

let jobs = new Map();
let running = false;

// China timezone helper (UTC+8, no DST)
function getChinaDate(offsetDays = 0) {
  const d = new Date();
  // Shift to China time, then toISOString gives the correct date
  const china = new Date(d.getTime() + 8 * 3600 * 1000 + offsetDays * 86400 * 1000);
  return china.toISOString().slice(0, 10);
}
// China timezone midnight timestamp (ms since epoch)
function getChinaMidnight() {
  const chinaDate = getChinaDate();
  return new Date(chinaDate + 'T00:00:00+08:00').getTime();
}

let feishu: any = null;
function getFeishu() {
  if (!feishu) feishu = require('./feishu');
  return feishu;
}

function getWebhookUrl() {
  return appConfig.getConfig('feishuWebhookUrl') || '';
}

// ===== Report Template System =====
// Pre-renders each report section as a string, then fills them into a simple template.
// Users can rearrange or remove {{sectionName}} markers.

function buildReportSections(data) {
  const { today, yesterday, greeting, kbName, doneToday, pendingTodos, overdueTodos,
          reminders, chats, workLogs, recs, recCount, docs, docCountToday, doneWeek,
          chatCountToday, chatCountWeek, recCountWeek, todos, dsNameMap } = data;

  const weekTotal = doneWeek.length ? doneWeek.reduce((s, x) => s + x.c, 0) : 0;
  const inProgress = pendingTodos.filter(t => t.status === 'in_progress').length;
  const pendingNoDue = pendingTodos.filter(t => t.priority === 'high');

  const greetingLine = greeting + '，这是今天的综合日报';

  let overview = '';
  overview += '📊 今日数据总览\n';
  overview += '  ━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  overview += '  ✅  完成任务：' + doneToday.length + ' 项\n';
  overview += '  📋  待办事项：' + pendingTodos.length + ' 项（进行中 ' + inProgress + ' 项）\n';
  if (overdueTodos.length) overview += '  ⚠️  已逾期：' + overdueTodos.length + ' 项\n';
  overview += '  💬  对话次数：' + chatCountToday + ' 次\n';
  overview += '  🗂️  新增记录：' + recCount + ' 条\n';
  overview += '  📝  笔记更新：' + docCountToday + ' 个文件\n';
  if (doneWeek.length) overview += '  📈  本周完成：' + weekTotal + ' 项\n';

  let doneSection = '';
  if (doneToday.length) {
    doneSection += '✅ 今日完成（' + doneToday.length + ' 项）\n';
    doneToday.forEach(t => {
      const icon = t.priority === 'high' ? '⭐' : t.priority === 'low' ? '🔹' : '✅';
      doneSection += '  ' + icon + ' ' + t.title + '\n';
    });
  }

  let overdueSection = '';
  if (overdueTodos.length) {
    overdueSection += '⚠️ 逾期待办（' + overdueTodos.length + ' 项）\n';
    overdueTodos.forEach(t => overdueSection += '  🔴 ' + t.title + '（截止 ' + t.due_date + '）\n');
  }

  let pendingSection = '';
  if (pendingTodos.length) {
    pendingSection += '📋 待办事项\n';
    pendingTodos.forEach(t => {
      const due = t.due_date ? ' 截止 ' + t.due_date : '';
      const icon = t.status === 'in_progress' ? '🔄' : (t.priority === 'high' ? '🔴' : '⬜');
      pendingSection += '  ' + icon + ' ' + t.title + due + '\n';
    });
  }

  let reminderSection = '';
  if (reminders.length) {
    const todayReminders = reminders.filter(rem => {
      if (rem.type === 'daily') return true;
      if (rem.type === 'weekly') return rem.day_of_week == new Date().getDay();
      if (rem.type === 'monthly') return rem.day_of_month == new Date().getDate();
      return false;
    });
    if (todayReminders.length) {
      reminderSection += '⏰ 今日提醒\n';
      todayReminders.forEach(rem => reminderSection += '  🔔 ' + rem.name + '（' + rem.time + '）\n');
    }
  }

  let worklogSection = '';
  if (workLogs.length) {
    worklogSection += '📝 工作日志\n';
    workLogs.forEach(wl => {
      let wd;
      try { wd = JSON.parse(wl.data_json || '{}'); } catch { wd = {}; }
      const wc = wd.内容 || wd.content || wd.今日工作 || '';
      const wp = wd.项目 || wd.project || '';
      if (wc) worklogSection += '  ' + (wp ? '📁 [' + wp + '] ' : '📄 ') + wc.slice(0, 120) + '\n';
    });
  }

  let chatSection = '';
  if (chats.length) {
    chatSection += '💬 对话与沟通\n';
    chatSection += '  今日共 ' + chats.length + ' 次对话';
    if (chatCountWeek > 0) chatSection += '，本周累计 ' + chatCountWeek + ' 次';
    chatSection += '\n';
    chats.forEach(c => {
      const snippet = (c.snippet || '').replace(/\n/g, ' ').slice(0, 100);
      if (snippet) chatSection += '  💭 ' + snippet + '\n';
    });
  }

  let recordSection = '';
  if (recs.length) {
    recordSection += '🗂️ 数据中心动态\n';
    recordSection += '  今日新增 ' + recCount + ' 条记录';
    if (recCountWeek > 0) recordSection += '，本周累计 ' + recCountWeek + ' 条';
    recordSection += '\n';
    const groups: any = {};
    recs.forEach(rec => {
      const id = rec.dataset_id;
      if (!groups[id]) groups[id] = [];
      groups[id].push(rec);
    });
    for (const [dsId, grp] of Object.entries(groups) as any[]) {
      const dsName = dsNameMap[dsId] || '未分类';
      recordSection += '  📦 ' + dsName + '（' + grp.length + ' 条）\n';
      grp.forEach(rec => {
        let rd;
        try { rd = JSON.parse(rec.data_json || '{}'); } catch { rd = {}; }
        const name = rd.name || rd.名称 || rd.title || rd.标题 || '';
        const status = rd.status || rd.状态 || '';
        if (name) recordSection += '    📌 ' + name + (status ? '（' + status + '）' : '') + '\n';
      });
    }
  }

  let docSection = '';
  if (docs.length) {
    const meaningfulDocs = docs.filter(d => {
      const s = (d.snippet || '').trim();
      return s && !s.startsWith('{') && !s.startsWith('<') && !s.startsWith('import ') && !s.startsWith('module.');
    }).slice(0, 10);
    if (meaningfulDocs.length) {
      docSection += '📝 笔记更新\n';
      docSection += '  今日更新 ' + docs.length + ' 个文件';
      if (docs.length > 0) {
        const dirs = new Set();
        docs.forEach(d => {
          const dir = d.path ? d.path.split(/[\\/]/).slice(-2, -1)[0] : '';
          if (dir) dirs.add(dir);
        });
        if (dirs.size) docSection += '，涉及 ' + dirs.size + ' 个目录';
      }
      docSection += '\n';
      meaningfulDocs.forEach(d => {
        const name = d.path ? d.path.split(/[\\/]/).pop() : '';
        const s = (d.snippet || '').replace(/\n/g, ' ').slice(0, 80);
        docSection += '  📄 ' + name + '：' + s + '\n';
      });
      if (docs.length > meaningfulDocs.length) docSection += '  ...及其他 ' + (docs.length - meaningfulDocs.length) + ' 个文件\n';
    }
  }

  let analysisSection = '🔍 综合分析\n';
  analysisSection += '  ━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';

  {
    const totalTodos = todos.length;
    const doneCount = doneToday.length;
    const completionRate = totalTodos > 0 ? Math.round(doneCount / totalTodos * 100) : 0;
    const highPriPending = pendingTodos.filter(t => t.priority === 'high');
    analysisSection += '  📊 【工作状态分析】\n';
    if (totalTodos > 0) analysisSection += '  待办完成率：' + completionRate + '%（今日完成 ' + doneCount + '/' + totalTodos + '）\n';
    if (inProgress > 0) analysisSection += '  进行中任务：' + inProgress + ' 项\n';
    if (highPriPending.length) {
      analysisSection += '  ⚡ 高优先级待办：' + highPriPending.length + ' 项\n';
      highPriPending.forEach(t => analysisSection += '    🔴 ' + t.title + (t.due_date ? '（截止 ' + t.due_date + '）' : '') + '\n');
    }
    if (overdueTodos.length) {
      const overdueDays = overdueTodos.map(t => Math.ceil((new Date(today).getTime() - new Date(t.due_date).getTime()) / 86400000));
      const maxOverdue = Math.max(...overdueDays, 0);
      analysisSection += '  ⚠️ 有 ' + overdueTodos.length + ' 项逾期，最长逾期 ' + maxOverdue + ' 天，建议尽快处理\n';
    }
    if (doneToday.length > 0) {
      const highDone = doneToday.filter(t => t.priority === 'high').length;
      if (highDone > 0) analysisSection += '  ✅ 今日完成了 ' + highDone + ' 项高优先级任务，效率不错！\n';
    }
    analysisSection += '\n';
  }

  if (chats.length > 0) {
    analysisSection += '  💬 【沟通与协作分析】\n';
    analysisSection += '  今日对话 ' + chatCountToday + ' 次';
    if (chatCountWeek > 0) {
      const dailyAvg = Math.round(chatCountWeek / 7);
      analysisSection += '，日均 ' + dailyAvg + ' 次';
      if (chatCountToday > dailyAvg) analysisSection += '，今天对话较活跃';
      else if (chatCountToday < dailyAvg) analysisSection += '，今天对话较少';
    }
    analysisSection += '\n';
    const stopWords = ['的','了','是','在','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这','这个','我','他','她','它','们','那','那个','什么','怎么','如何','为什么','可以','能','吗','吧','啊','呢','哦','嗯','哈','呀'];
    const keywords: any[] = [];
    chats.forEach(c => {
      const snip = (c.snippet || '').trim();
      if (snip) {
        snip.split(/[\s,，。！？、；：""''（）()【】\[\]]/).forEach(word => {
          if (word.length >= 2 && !stopWords.includes(word) && !keywords.includes(word)) keywords.push(word);
        });
      }
    });
    if (keywords.length > 0) analysisSection += '  对话关键词：' + keywords.slice(0, 8).join('、') + '\n';
    const topicCats = { 开发: ['开发','代码','bug','修复','部署','功能','项目','前端','后端','接口','数据库','服务器','git','分支','合并','测试','上线'], 学习: ['学习','教程','课程','文档','阅读','笔记','知识','了解','研究'], 管理: ['任务','计划','安排','进度','汇报','会议','讨论','沟通','协调'], 内容: ['文章','写作','发布','内容','编辑','文案','排版'], 数据分析: ['数据','分析','统计','报表','图表','指标'] };
    const topicCounts: any = {};
    chats.forEach(c => {
      const snip = (c.snippet || '').toLowerCase();
      for (const [topic, words] of Object.entries(topicCats)) {
        for (const w of words) { if (snip.includes(w)) { topicCounts[topic] = (topicCounts[topic] || 0) + 1; break; } }
      }
    });
    const activeTopics = (Object.entries(topicCounts) as any[]).filter(([_, c]) => c >= 1).sort((a, b) => b[1] - a[1]);
    if (activeTopics.length > 0) analysisSection += '  对话主题：' + activeTopics.map(([t, c]) => t + '（' + c + '次）').join('、') + '\n';
    analysisSection += '\n';
  }

  if (docs.length > 0) {
    const meaningful = docs.filter(d => {
      const s = (d.snippet || '').trim();
      return s && !s.startsWith('{') && !s.startsWith('<') && !s.startsWith('import ') && !s.startsWith('module.');
    });
    analysisSection += '  📚 【知识沉淀分析】\n';
    analysisSection += '  今日记录 ' + docs.length + ' 篇笔记';
    if (docCountToday > 0) {
      const totalChars = meaningful.reduce((sum, d) => sum + (d.snippet || '').length, 0);
      analysisSection += '，总字数约 ' + totalChars + ' 字';
    }
    analysisSection += '\n';
    const dirGroups: any = {};
    docs.forEach(d => {
      const dir = d.path ? d.path.split(/[\\/]/).slice(-2, -1)[0] || '根目录' : '根目录';
      if (!dirGroups[dir]) dirGroups[dir] = [];
      dirGroups[dir].push(d);
    });
    const dirEntries = (Object.entries(dirGroups) as any[]).sort((a, b) => b[1].length - a[1].length);
    if (dirEntries.length > 1) analysisSection += '  笔记分布：' + dirEntries.slice(0, 5).map(([dir, files]) => dir + '（' + files.length + '篇）').join('、') + '\n';
    const ctypes = { 技术: 0, 随笔: 0, 计划: 0, 总结: 0 };
    meaningful.forEach(d => {
      const snip = (d.snippet || '').toLowerCase();
      if (snip.includes('代码') || snip.includes('函数') || snip.includes('api') || snip.includes('实现')) ctypes.技术++;
      if (snip.includes('今天') || snip.includes('感觉') || snip.includes('觉得')) ctypes.随笔++;
      if (snip.includes('计划') || snip.includes('待办') || snip.includes('安排')) ctypes.计划++;
      if (snip.includes('总结') || snip.includes('完成') || snip.includes('结果')) ctypes.总结++;
    });
    const activeTypes = Object.entries(ctypes).filter(([_, c]) => c > 0).sort((a, b) => b[1] - a[1]);
    if (activeTypes.length > 0) analysisSection += '  内容类型：' + activeTypes.map(([t, c]) => t + '（' + c + '篇）').join('、') + '\n';
    analysisSection += '\n';
  }

  if (doneWeek.length > 0 || recCountWeek > 0) {
    analysisSection += '  📈 【数据趋势分析】\n';
    if (doneWeek.length > 0) {
      analysisSection += '  本周完成任务趋势：';
      doneWeek.forEach((d, i) => {
        const dayName = ['周日','周一','周二','周三','周四','周五','周六'][new Date(d.d).getDay()];
        analysisSection += dayName + d.c + '项';
        if (i < doneWeek.length - 1) analysisSection += ' → ';
      });
      analysisSection += '\n';
      const todayDone = doneWeek.find(d => d.d === today);
      const yestDone = doneWeek.find(d => d.d === yesterday);
      if (todayDone && yestDone) {
        const diff = todayDone.c - yestDone.c;
        if (diff > 0) analysisSection += '  较昨日：📈 +' + diff + ' 项，效率提升！\n';
        else if (diff < 0) analysisSection += '  较昨日：📉 ' + diff + ' 项，需加油\n';
        else analysisSection += '  较昨日：➡️ 持平\n';
      }
    }
    analysisSection += '\n';
  }

  let score = 60;
  if (doneToday.length > 0) score += 10;
  if (doneToday.length >= 3) score += 5;
  if (inProgress > 0) score += 5;
  if (overdueTodos.length === 0) score += 10; else score -= 10;
  if (chats.length > 0) score += 5;
  if (docs.length > 0) score += 5;
  if (recCount > 0) score += 5;
  score = Math.max(0, Math.min(100, score));
  const scoreBar = '█'.repeat(Math.round(score / 10)) + '░'.repeat(10 - Math.round(score / 10));

  analysisSection += '  🎯 【综合评估与建议】\n';
  analysisSection += '  今日效率评分：' + scoreBar + ' ' + score + '/100\n';
  const suggestions: any[] = [];
  if (overdueTodos.length > 0) suggestions.push('优先处理 ' + overdueTodos.length + ' 项逾期待办');
  if (inProgress > 3) suggestions.push('进行中任务较多，建议集中精力完成一项再开始下一项');
  if (chatCountToday > 10) suggestions.push('今日对话较多，注意时间管理');
  if (docs.length === 0 && recCount === 0) suggestions.push('今日暂无知识沉淀，建议记录工作笔记');
  if (doneToday.length === 0) suggestions.push('今日尚未完成待办，建议设定小目标开始行动');
  if (pendingNoDue.length > 0 && overdueTodos.length === 0) suggestions.push('高优先级任务还有 ' + pendingNoDue.length + ' 项，建议优先攻克');
  if (suggestions.length > 0) {
    analysisSection += '  建议：\n';
    suggestions.forEach(s => analysisSection += '    💡 ' + s + '\n');
  } else {
    analysisSection += '  建议：今日状态良好，保持节奏继续加油！\n';
  }
  analysisSection += '  ';
  if (score >= 80) analysisSection += '🎉 今天效率很高，继续保持！';
  else if (score >= 60) analysisSection += '👍 状态不错，还有提升空间！';
  else if (score >= 40) analysisSection += '💪 加油，从完成一个小目标开始！';
  else analysisSection += '🌟 调整心态，重新出发，你可以的！';

  const sections = {
    greetingLine, overview, doneSection, overdueSection, pendingSection,
    reminderSection, worklogSection, chatSection, recordSection, docSection,
    analysisSection,
    footer: '📊 综合日报 · ' + today + '\n---\n💡 打开应用查看完整详情\n启航AI工作台 · ' + kbName,
  };
  const vars = {
    today, yesterday, greeting, kbName,
    doneCount: doneToday.length, pendingCount: pendingTodos.length,
    overdueCount: overdueTodos.length, chatCount: chatCountToday,
    recCount, docCount: docCountToday, weekTotal, score, scoreBar,
  };
  return { sections, vars, score };
}

const SYSTEM_PROMPT = `你是一位日报生成助手。请使用提供的工具查询今日数据，然后生成一份完整的综合日报。

## 可用工具
- query_tasks — 查询任务（plan_tasks，按状态、优先级过滤）
- query_messages — 查询今日对话记录
- query_documents — 查询今日更新的文档/笔记
- query_data_records — 查询数据中心记录
- query_reminders — 查询已启用的提醒
- get_today_info — 获取当前日期、项目信息

## 要求
1. 先调用 get_today_info 了解当前日期和项目
2. 调用各查询工具获取今日数据
3. 按用户要求的格式生成日报
4. 数据为空的部分略过，不要编造
5. 评分要合理，基于实际数据`;

const DEFAULT_REPORT_TEMPLATE = '{{greetingLine}}\n' +
'\n' +
'📅 {{today}}\n' +
'\n' +
'{{overview}}\n' +
'\n' +
'{{doneSection}}\n' +
'{{overdueSection}}\n' +
'{{pendingSection}}\n' +
'{{reminderSection}}\n' +
'{{worklogSection}}\n' +
'{{chatSection}}\n' +
'{{recordSection}}\n' +
'{{docSection}}\n' +
'\n' +
'{{analysisSection}}\n' +
'\n' +
'{{footer}}';

function renderReport(data) {
  const { sections, vars, score } = buildReportSections(data);
  const templateStr = appConfig.getConfig('daily_report_template') || DEFAULT_REPORT_TEMPLATE;
  try {
    let text = templateStr;
    for (const [key, val] of Object.entries(sections)) {
      const trimmed = (val || '').trim();
      text = text.split('{{' + key + '}}').join(trimmed ? trimmed + '\n' : '');
    }
    for (const [key, val] of Object.entries(vars)) {
      text = text.split('{{' + key + '}}').join(String(val !== undefined ? val : ''));
    }
    text = text.replace(/\n{3,}/g, '\n\n').trim();
    return { text, score };
  } catch (e) {
    logger.warn(`[Scheduler] template render error: ${e.message}, using default`);
    let r = sections.greetingLine + '\n\n📅 ' + vars.today + '\n\n';
    for (const key of ['overview', 'doneSection', 'overdueSection', 'pendingSection', 'reminderSection', 'worklogSection', 'chatSection', 'recordSection', 'docSection']) {
      const val = sections[key];
      if (val && val.trim()) r += val.trim() + '\n\n';
    }
    if (sections.analysisSection && sections.analysisSection.trim()) r += sections.analysisSection.trim() + '\n\n';
    r += sections.footer;
    return { text: r, score };
  }
}


async function sendFeishu(message) {
  const url = getWebhookUrl();
  if (!url) return;
  try {
    const body = typeof message === 'string'
      ? { msg_type: 'text', content: JSON.stringify({ text: message }) }
      : { msg_type: 'interactive', card: message };
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    logger.warn(`[Scheduler] feishu send failed: ${e.message}`);
  }
}

function buildReportCard(data) {
  const { today, doneToday, overdueTodos, pendingTodos, reminders, chats, workLogs, recs, recCount, docs, docCount, kbName, hour } = data;
  const elements: any[] = [];

  // greeting
  let greeting = '☀️ 早上好';
  if (hour >= 12 && hour < 14) greeting = '🌤️ 中午好';
  else if (hour >= 14 && hour < 18) greeting = '🌇 下午好';
  else if (hour >= 18) greeting = '🌙 晚上好';
  elements.push({ tag: 'markdown', content: `${greeting}，这是今天的综合日报` });
  elements.push({ tag: 'markdown', content: `📅 **${today}**` });
  elements.push({ tag: 'hr' });

  // stats bar
  let statsLine = `✅ 完成 ${doneToday.length} 项 · 📋 待办 ${pendingTodos.length} 项 · 🗂️ 新增 ${recCount} 条 · 📝 ${docCount} 篇`;
  elements.push({ tag: 'markdown', content: `**今日概览**\n${statsLine}` });
  elements.push({ tag: 'hr' });

  // ✅ 今日完成
  if (doneToday.length) {
    let md = `**✅ 今日完成（${doneToday.length} 项）**\n`;
    doneToday.forEach(t => { md += `✅ ${t.title}\n`; });
    elements.push({ tag: 'markdown', content: md });
  }

  // ⚠️ 逾期待办
  if (overdueTodos.length) {
    let md = `**⚠️ 逾期待办（${overdueTodos.length} 项）**\n`;
    overdueTodos.forEach(t => { md += `🔴 ${t.title}（截止 ${t.due_date}）\n`; });
    elements.push({ tag: 'markdown', content: md });
  }

  // 📋 待办
  if (pendingTodos.length) {
    let md = `**📋 待办事项（${pendingTodos.length} 项未完成）**\n`;
    pendingTodos.forEach(t => {
      const icon = t.status === 'in_progress' ? '🔄' : '⬜';
      const due = t.due_date ? `（截止 ${t.due_date}）` : '';
      md += `${icon} ${t.title} ${due}\n`;
      if (md.length > 1500) { md = md.slice(0, 1500) + '\n...'; return; }
    });
    elements.push({ tag: 'markdown', content: md });
  }

  // ⏰ 今日提醒
  if (reminders.length) {
    const todayReminders = reminders.filter(rem => {
      if (rem.type === 'daily') return true;
      if (rem.type === 'weekly') return rem.day_of_week == new Date().getDay();
      if (rem.type === 'monthly') return rem.day_of_month == new Date().getDate();
      return false;
    });
    if (todayReminders.length) {
      let md = `**⏰ 今日提醒**\n`;
      todayReminders.forEach(r => { md += `🔔 ${r.name}（${r.time}）\n`; });
      elements.push({ tag: 'markdown', content: md });
    }
  }

  // 💬 今日对话
  if (chats.length) {
    let md = `**💬 今日对话摘要**\n`;
    chats.forEach(c => {
      const s = (c.snippet || '').replace(/\n/g, ' ').slice(0, 80);
      if (s) md += `💭 ${s}\n`;
    });
    elements.push({ tag: 'markdown', content: md });
  }

  // 📝 工作日志
  if (workLogs.length) {
    let md = `**📝 工作日志**\n`;
    workLogs.forEach(wl => {
      let data;
      try { data = JSON.parse(wl.data_json || '{}'); } catch { data = {}; }
      const content = data.内容 || data.content || data.今日工作 || '';
      const project = data.项目 || data.project || '';
      if (content) md += `📄 ${project ? `[${project}] ` : ''}${content.slice(0, 100)}\n`;
    });
    elements.push({ tag: 'markdown', content: md });
  }

  // 🗂️ 数据中心
  if (recs.length) {
    let md = `**🗂️ 数据中心新增记录**\n`;
    recs.slice(0, 8).forEach(rec => {
      let data;
      try { data = JSON.parse(rec.data_json || '{}'); } catch { data = {}; }
      const name = data.name || data.名称 || data.title || data.标题 || '';
      const status = data.status || data.状态 || '';
      if (name) {
        const ds = db.qOne("SELECT name FROM data_center_datasets WHERE id = ?", rec.dataset_id);
        md += `📌 [${ds ? ds.name : '数据集'}] ${name}${status ? '（' + status + '）' : ''}\n`;
      }
    });
    if (recs.length > 8) md += `...及其他 ${recs.length - 8} 条\n`;
    elements.push({ tag: 'markdown', content: md });
  }

  // 📝 笔记
  if (docs.length) {
    const meaningfulDocs = docs.filter(d => {
      const s = (d.snippet || '').trim();
      return s && !s.startsWith('{') && !s.startsWith('<') && !s.startsWith('import ') && !s.startsWith('module.');
    }).slice(0, 6);
    if (meaningfulDocs.length) {
      let md = `**📝 笔记更新**\n`;
      meaningfulDocs.forEach(d => {
        const name = d.path ? d.path.split(/[\\\/]/).pop() : '';
        const s = (d.snippet || '').replace(/\n/g, ' ').slice(0, 60);
        md += `📄 ${name}：${s}\n`;
      });
      if (docs.length > meaningfulDocs.length) md += `...及其他 ${docs.length - meaningfulDocs.length} 个文件\n`;
      elements.push({ tag: 'markdown', content: md });
    }
  }

  elements.push({ tag: 'hr' });

  // completion rate
  let summary = `**📊 完成概览**\n`;
  summary += `✅ 今日完成：${doneToday.length} 项\n📋 剩余待办：${pendingTodos.length} 项`;
  if (overdueTodos.length) summary += `\n⚠️ **${overdueTodos.length} 项逾期**，建议优先处理`;
  elements.push({ tag: 'markdown', content: summary });

  return {
    header: { template: 'blue', title: { tag: 'plain_text', content: `☀️ 综合日报 ${today}` } },
    elements: [
      ...elements,
      { tag: 'hr' },
      { tag: 'markdown', content: `启航AI工作台 · ${kbName} · ${today}` },
    ],
  };
}

function sendNotification(title, body) {
  try {
    const n = new Notification({ title, body });
    n.show();
  } catch (e) {
    logger.warn(`[Scheduler] notification failed: ${e.message}`);
  }
}

function getCronFromReminder(r) {
  switch (r.type) {
    case 'daily': return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} * * *`;
    case 'weekly': return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} * * ${r.day_of_week || 1}`;
    case 'monthly': return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} ${r.day_of_month || 1} * *`;
    case 'yearly': {
      const parts = (r.month_day || '1-1').split('-');
      return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} ${parts[1] || 1} ${parts[0] || 1} *`;
    }
    case 'once': {
      const d = String(r.date || '').split('-');
      if (d.length !== 3) return null;
      return `${r.time.split(':')[1] || '0'} ${r.time.split(':')[0] || '9'} ${d[2] || 1} ${d[1] || 1} *`;
    }
    default: return null;
  }
}

const executors = {
  'ping': async (task) => {
    logger.info(`[Scheduler] ping: ${task.name}`);
  },
  'auto_index': async (task) => {
    logger.info(`[Scheduler] auto-index triggered: ${task.name}`);
    const noteProjects = db.project.list('note');
    for (const p of noteProjects) {
      try {
        const indexer = require('./indexer');
        await indexer.indexSingle(p.dir);
      } catch (e) {
        logger.error(`[Scheduler] index error for ${p.name}: ${e.message}`);
      }
    }
  },
'daily_report': async (task) => {
    logger.info(`[Scheduler] daily report: ${task.name}`);
    const today = getChinaDate();
    try {
      const notesDir = appConfig.getConfig('notesDir') || '';
      if (!notesDir) { logger.warn('[Scheduler] daily_report: notesDir not configured'); return; }
       const userPart = appConfig.getConfig('daily_report_prompt') || '请按以下格式生成日报：\n\n## 日报格式要求\n使用简化的 Markdown 格式（适配飞书），**不要使用表格**（用 `- key: value` 列表代替）：**\n\n### 1️⃣ 今日概览\n- ✅ 完成任务：数量、📋 待办：数量、💬 对话：次数、📝 笔记：更新数、🗂️ 新增：数量\n\n### 2️⃣ 今日完成\n- 列出今日完成的任务，高优先级的用 ⭐ 标记\n\n### 3️⃣ 待办事项\n- 逾期的用 🔴 标记并注明逾期天数\n- 进行中的用 🔄 标记\n- 高优先级的用 🔴 标记\n\n### 4️⃣ 对话与沟通\n- 今日对话次数和简要摘要\n\n### 5️⃣ 笔记与记录\n- 更新的文档和新增的记录\n\n### 6️⃣ 今日提醒\n- 已启用的提醒（如有）\n\n### 7️⃣ 综合评估\n- 根据完成任务、待办处理、知识沉淀等维度给出今日效率评分（0-100分）\n- 给出具体的改进行动建议\n\n## 格式注意事项\n- **不使用表格**：用 `- 维度 | 说明` 这样的列表代替\n- 数据为空的部分可以略过，不要编造数据\n- 评分要合理，基于实际数据给出\n- 建议要具体、可执行\n- 语言简洁专业，使用中文\n- 只输出日报正文，不要包含任何说明性文字（如"数据来源"、"让我先"、"思考过程"等）';
      const piAgent = require('./pi-agent');
      logger.info('[Scheduler] Calling pi agent to generate daily report...');
      const r = (await piAgent.generateDailyReport('scheduler_' + today, userPart)).trim();
      logger.info(`[Scheduler] AI report generated, length: ${r.length}`);

      db.run("INSERT INTO ai_analysis (project_id, type, content, report_date, created_at, updated_at) VALUES (NULL, 'daily_report', ?, ?, datetime('now', '+8 hours'), datetime('now', '+8 hours'))",
        r, today);

      const retentionDays = parseInt(appConfig.getConfig('daily_report_retention_days') || '30', 10);
      db.run("DELETE FROM ai_analysis WHERE type = 'daily_report' AND report_date < ?", getChinaDate(-retentionDays));

      sendNotification('每日报告', '✅ AI 综合日报已生成 - ' + today);
       if (task.notify_feishu) {
        const feishuText = convertMarkdownForFeishu(r.slice(0, 1800));
        const cardContent = '📊 AI 综合日报 **' + today + '**\n\n' + feishuText;
        await sendFeishu({
          header: { template: 'blue', title: { tag: 'plain_text', content: '📊 综合日报 ' + today } },
          elements: [{ tag: 'markdown', content: feishuText }]
        });
       }
    } catch (e) {
      logger.error(`[Scheduler] daily_report error: ${e.message}`);
    }
  },
  'reminder': async (task) => {
    logger.info(`[Scheduler] reminder: ${task.name}`);
    try {
      const msg = task.name + (task.message ? '\n' + task.message : '');
      sendNotification('⏰ 提醒', msg);
      if (task.notify_feishu) await sendFeishu(`⏰ ${msg}`);
    } catch (e) {
      logger.error(`[Scheduler] reminder error: ${e.message}`);
    }
  },
};

function start() {
  if (running) return;
  running = true;

  const reminders = db.reminder.getActive();
  for (const r of reminders) {
    scheduleReminder(r);
  }

  reloadTasks();

  logger.info(`[Scheduler] started with 0 tasks + ${reminders.length} reminders`);
}



function scheduleReminder(r) {
  const cronExpr = getCronFromReminder(r);
  if (!cronExpr || !cron.validate(cronExpr)) return;
  const job = cron.schedule(cronExpr, async () => {
    try {
      const msg = '⏰ ' + r.name + (r.message ? '\n' + r.message : '');
      sendNotification('⏰ ' + r.name, r.message || '');
      await sendFeishu(msg);
      logger.info(`[Scheduler] reminder triggered: ${r.name}`);
      if (r.type === 'once') {
        // 一次性提醒：触发后自动禁用并停止调度
        db.reminder.setEnabled(r.id, false);
        removeReminder(r.id);
      }
    } catch (e) {
      logger.error(`[Scheduler] reminder ${r.name} error:`, e.message);
    }
  });
  jobs.set('reminder_' + r.id, job);
}

function addReminder(r) {
  scheduleReminder(r);
}

function removeReminder(id) {
  const key = 'reminder_' + id;
  if (jobs.has(key)) { jobs.get(key).stop(); jobs.delete(key); }
}

// ==================== AI 自执行任务调度 ====================

function nowString(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

function notifyUI() {
  try {
    const { BrowserWindow } = require('electron') as typeof import('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send('task:changed');
    }
  } catch {}
}

/** 根据任务触发配置生成 cron 表达式（循环任务），无有效配置返回 null */
function getTaskCron(t: any): string | null {
  if (t.cycle_type === 'cron') return t.cycle_value || null;
  if (!t.cycle_time) return null;
  const parts = t.cycle_time.split(':');
  const h = parseInt(parts[0], 10);
  const m = parseInt(parts[1] || '0', 10);
  if (isNaN(h) || isNaN(m)) return null;
  if (t.cycle_type === 'daily') return `${m} ${h} * * *`;
  if (t.cycle_type === 'weekly') {
    const days = String(t.cycle_value || '').split(',').filter(Boolean).join(',');
    if (!days) return null;
    return `${m} ${h} * * ${days}`;
  }
  if (t.cycle_type === 'monthly') {
    const days = String(t.cycle_value || '').split(',').filter(Boolean).join(',');
    if (!days) return null;
    return `${m} ${h} ${days} * *`;
  }
  return null;
}

function scheduleTask(t: any) {
  const key = 'task_' + t.id;
  if (jobs.has(key)) { jobs.get(key).stop(); jobs.delete(key); }

  // 一次性定时：setTimeout 到点触发一次
  if (t.trigger_type === 'once' && t.scheduled_start) {
    const target = new Date(String(t.scheduled_start).replace(' ', 'T') + '+08:00').getTime();
    const delay = target - Date.now();
    if (delay <= 0) return; // 已过期，不补跑
    const timer = setTimeout(async () => {
      jobs.delete(key);
      const fresh = db.task.get(t.id);
      if (fresh && fresh.status === 'pending') enqueueTask(fresh, 'scheduled');
    }, delay);
    jobs.set(key, { stop: () => clearTimeout(timer) });
    return;
  }

  // 循环任务
  const cronExpr = getTaskCron(t);
  if (!cronExpr || !cron.validate(cronExpr)) return;
  const job = cron.schedule(cronExpr, async () => {
    const today = getChinaDate();
    if (t.cycle_end && t.cycle_end < today) {
      // 已到循环结束日期：转为已完成并停止调度
      db.task.update(t.id, { status: 'done' });
      removeTask(t.id);
      notifyUI();
      return;
    }
    const fresh = db.task.get(t.id);
    if (fresh && fresh.status === 'pending') {
      db.task.update(t.id, { last_cycle_run: nowString() });
      enqueueTask(fresh, 'scheduled');
    }
  });
  jobs.set(key, job);
}

function reloadTasks() {
  for (const [id, job] of jobs) {
    if (id.startsWith('task_')) { job.stop(); jobs.delete(id); }
  }
  const tasks = db.task.schedulable();
  for (const t of tasks) scheduleTask(t);
  logger.info(`[Scheduler] tasks scheduled: ${tasks.length}`);
}

function removeTask(id: number) {
  const key = 'task_' + id;
  if (jobs.has(key)) { jobs.get(key).stop(); jobs.delete(key); }
}

// ---- 串行执行队列 ----
let execQueue: any[] = [];
let execRunning = false;

async function pumpQueue() {
  if (execRunning) return;
  const item = execQueue.shift();
  if (!item) return;
  execRunning = true;
  try {
    await runTask(item.task, item.triggerType);
  } catch (e: any) {
    logger.error(`[Scheduler] task execution error: ${e.message}`);
  }
  execRunning = false;
  pumpQueue();
}

/** 将任务加入执行队列（手动/定时/到期共用） */
function enqueueTask(task: any, triggerType: string) {
  execQueue.push({ task, triggerType });
  notifyUI();
  pumpQueue();
}

/** 保存任务结果到笔记库 */
function saveTaskResultToNote(task: any, result: string): string {
  try {
    const notesDir = appConfig.getConfig('notesDir') || '';
    if (!notesDir) return '';
    let relPath = task.output_target || '';
    if (!relPath) {
      const title = String(task.title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
      relPath = `任务输出/${title}_${getChinaDate().replace(/-/g, '')}.md`;
    }
    const full = path.resolve(notesDir, relPath);
    if (!full.startsWith(path.resolve(notesDir))) return '';
    const fs = require('fs') as typeof import('fs');
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const header = `# ${task.title}\n\n> 执行时间：${nowString()} · 触发方式：${triggerTypeLabel(task)}\n\n`;
    fs.writeFileSync(full, header + result, 'utf-8');
    return relPath;
  } catch { return ''; }
}

function triggerTypeLabel(task: any): string {
  if (task.trigger_type === 'cycle') {
    if (task.cycle_type === 'cron') return '循环 Cron';
    if (task.cycle_type === 'weekly') return `每周 ${task.cycle_value}`;
    if (task.cycle_type === 'monthly') return `每月 ${task.cycle_value} 号`;
    return `每天 ${task.cycle_time}`;
  }
  if (task.trigger_type === 'once') return `一次性 ${task.scheduled_start}`;
  return '立即执行';
}

async function runTask(task: any, triggerType: string) {
  const start = nowString();
  const execId = db.taskExecution.add({
    task_id: task.id, task_title: task.title, status: 'RUNNING',
    trigger_type: triggerType, start_time: start,
  }) as number | null;
  db.task.update(task.id, { status: 'in_progress', last_run_at: start, last_status: 'RUNNING' });
  notifyUI();
  try {
    const { buildReportToolDefs, buildDataToolDefs, buildNoteToolDefs, buildCodingToolDefs } = require('./tools');
    const customTools: any[] = [];
    let cwd = '';
    const project: any = task.project_id ? db.project.get(task.project_id) : null;

    if (task.task_type === 'coding' && project) {
      // 代码任务：直接在项目目录上执行（代码工具的写操作）
      cwd = project.dir || '';
      customTools.push(...(await buildReportToolDefs(undefined)));
      customTools.push(...(await buildCodingToolDefs(cwd || undefined)));
    } else {
      // 笔记/知识任务：笔记库目录 + 笔记工具集
      const notesDir = appConfig.getConfig('notesDir') || (project ? project.dir : '') || '';
      cwd = notesDir;
      customTools.push(...(await buildReportToolDefs(undefined)));
      if (notesDir) customTools.push(...(await buildDataToolDefs(notesDir)));
      const noteProj: any = task.project_id && project ? project : db.qOne("SELECT * FROM prj_projects WHERE type = 'note' ORDER BY is_default DESC, id ASC LIMIT 1");
      if (noteProj) customTools.push(...(await buildNoteToolDefs(noteProj.id)));
    }

    const piAgent = require('./pi-agent');
    const sessionId = 'task_' + task.id;
    if (!task.session_id) {
      try {
        db.chat.createSession(sessionId, task.project_id && Number.isFinite(Number(task.project_id)) ? Number(task.project_id) : null, task.title.slice(0, 30), 'kb', 'pi', 'ui');
        db.task.update(task.id, { session_id: sessionId });
      } catch {}
    }
    const contextLine = project ? `\n执行项目：${project.name}（${project.dir}）` : '';
    const prompt = `你正在执行一个 AI 任务「${task.title}」。${contextLine}\n\n${task.prompt || '请根据任务标题自主完成并直接输出结果。'}\n\n执行要求：\n1. 先用可用工具查询所需数据（任务、对话记录、文档、数据集、笔记、外网资料等），再完成任务\n2. 若任务涉及修改文件/代码，直接在目标目录中完成\n3. 直接输出最终成果（Markdown 格式），不要输出过程说明、思考过程或"数据来源"等前缀`;
    const result = (await piAgent.generateDailyReport(sessionId, prompt)).trim();
    const end = nowString();

    const savedNote = task.task_type === 'coding' ? '' : saveTaskResultToNote(task, result);
    const nextStatus = task.trigger_type === 'cycle' ? 'pending' : 'done';
    if (execId != null) db.taskExecution.update(execId, { status: 'SUCCESS', end_time: end, result_text: result, log_text: savedNote ? `已保存笔记：${savedNote}` : '' });
    db.task.update(task.id, { last_result: result.slice(0, 3000), last_status: 'SUCCESS', last_run_at: end, status: nextStatus });

    sendNotification('✅ AI 任务完成', task.title);
    if (task.notify_feishu) {
      const feishuText = convertMarkdownForFeishu(result.slice(0, 1800));
      await sendFeishu({
        config: { wide_screen_mode: true },
        header: { template: 'blue', title: { tag: 'plain_text', content: `✅ AI 任务完成：${task.title}` } },
        elements: [
          { tag: 'markdown', content: `${savedNote ? `📝 已保存笔记：\`${savedNote}\`\n\n` : ''}${feishuText}` },
        ],
      });
    }
    notifyUI();
  } catch (e: any) {
    const end = nowString();
    if (execId != null) db.taskExecution.update(execId, { status: 'FAILED', end_time: end, error_message: (e && e.message) || String(e) });
    db.task.update(task.id, { last_status: 'FAILED', last_run_at: end, status: 'pending' });
    sendNotification('❌ AI 任务失败', task.title + '：' + ((e && e.message) || String(e)));
    if (task.notify_feishu) await sendFeishu(`❌ AI 任务「${task.title}」执行失败：${(e && e.message) || String(e)}`);
    notifyUI();
  }
}

/** 立即执行任务（手动触发 / 新建即执行） */
function executeTaskNow(id: number) {
  const t = db.task.get(id);
  if (!t) return false;
  if (t.status === 'in_progress') return false;
  enqueueTask(t, 'manual');
  return true;
}

/** 手动触发一次提醒（测试用） */
function triggerReminderNow(id: string) {
  const r = db.reminder.get(id);
  if (!r) return false;
  const msg = '⏰ ' + r.name + (r.message ? '\n' + r.message : '');
  sendNotification('⏰ ' + r.name, r.message || '');
  (async () => { await sendFeishu(msg); })();
  return true;
}

function stop() {
  for (const [id, job] of jobs) {
    job.stop();
  }
  jobs.clear();
  running = false;
  execQueue = [];
  logger.info('[Scheduler] stopped');
}

function reload() {
  stop();
  start();
}

function isRunning() { return running; }

export { start, stop, reload, isRunning, addReminder, removeReminder, reloadTasks, removeTask, executeTaskNow, triggerReminderNow, DEFAULT_REPORT_TEMPLATE };