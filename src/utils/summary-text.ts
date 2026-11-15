/**
 * 摘要文本清洗 —— 渲染前剥掉 AI 照抄任务交接模板产生的噪音开头。
 *
 * 背景：codex 等工具的会话收口时上下文里带着「# Task handoff / You are ...」
 * 之类的交接模板，提炼层偶尔会原样照抄进摘要开头，渲染时露出无意义的原始文本。
 *
 * 规则（保守，只处理"开头"）：
 * 1. 若摘要含四段卡片起始标记「**做了什么**」，其之前的整段都是模板噪音，直接截断；
 * 2. 否则从首行起逐行剥掉匹配任务交接模板特征的行（Task handoff / You are ... / 空行）。
 */
export function cleanSummaryText(summary: string): string {
  let s = String(summary || '').trim();
  if (!s) return s;

  // 1) 定位四段卡片开头，截掉之前的模板噪音
  const anchor = s.indexOf('做了什么');
  if (anchor > 0) {
    // 回退到紧邻的 ** 标记处，保留完整加粗头
    const marker = s.lastIndexOf('**', anchor);
    if (marker >= 0 && anchor - marker <= 3) {
      const head = s.slice(0, marker).trim();
      // 只有当被截掉的头部确实像模板噪音（含交接标记）时才截断，避免误伤正常前缀
      if (/task\s*handoff|you\s+are\b/i.test(head)) s = s.slice(marker);
      return s.trim();
    }
  }

  // 2) 无锚点时逐行剥模板行
  const lines = s.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || /task\s*handoff/i.test(line) || /^you\s+are\b/i.test(line)) {
      i++;
      continue;
    }
    break;
  }
  return i > 0 ? lines.slice(i).join('\n').trim() : s;
}
