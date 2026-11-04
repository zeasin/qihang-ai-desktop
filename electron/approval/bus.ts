import type { BusEvent } from './types';

/** 同步 pub/sub（从 qihang-code-approver 移植） */
export class Bus {
  private subs = new Set<(e: BusEvent) => void>();

  subscribe(fn: (e: BusEvent) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  emit(e: BusEvent): void {
    for (const fn of this.subs) {
      try { fn(e); } catch { /* 订阅者异常不影响总线 */ }
    }
  }
}
