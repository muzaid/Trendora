/** Structured, redacted JSON logs with correlation ids (spec §9 observability). */
const REDACT = /(authorization|password|secret|token|couponcode|card|email|address|cookie)/i;

function redact(v: unknown, depth = 0): unknown {
  if (depth > 4 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => redact(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, REDACT.test(k) ? '[redacted]' : redact(x, depth + 1)]));
}

export interface Logger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

export function createLogger(base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => console.log(l)): Logger {
  const emit = (level: string, msg: string, fields?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === 'silent') return;
    sink(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact({ ...base, ...fields }) as object) }));
  };
  return {
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (f) => createLogger({ ...base, ...f }, sink),
  };
}
