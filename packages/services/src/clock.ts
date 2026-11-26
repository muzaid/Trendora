import type { Db } from '@trendora/db';
import type { Clock } from './context';

/**
 * Server clock. In SANDBOX_MODE an admin-set offset (system_settings.sandbox_clock)
 * lets demos and E2E tests move through campaign phases without editing published
 * rules. In production the offset is ignored.
 */
export class DbClock implements Clock {
  private offsetMs = 0;
  private loadedAt = 0;
  constructor(private readonly db: Db, private readonly sandbox: boolean) {}
  now(): Date {
    return new Date(Date.now() + (this.sandbox ? this.offsetMs : 0));
  }
  async refresh(force = false): Promise<void> {
    if (!this.sandbox) return;
    if (!force && Date.now() - this.loadedAt < 2_000) return;
    const row = await this.db.maybeOne<{ value: { offsetMs: number } }>(`select value from system_settings where key = 'sandbox_clock'`);
    this.offsetMs = row?.value.offsetMs ?? 0;
    this.loadedAt = Date.now();
  }
  get offset() {
    return this.offsetMs;
  }
}

export class FixedClock implements Clock {
  constructor(public current: Date) {}
  now() {
    return new Date(this.current);
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(d: Date) {
    this.current = new Date(d);
  }
}
