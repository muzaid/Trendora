import { createDb, type Db } from '@trendora/db';
import { loadConfig, type AppConfig } from './config';
import { createLogger } from './logger';
import { DbClock } from './clock';
import type { Clock, ServiceContext } from './context';
import { SandboxPaymentProvider } from './adapters/payments';
import { SandboxVideoProvider } from './adapters/video';
import { ClaudeAgentProvider, SandboxAgentProvider } from './adapters/ai';

export interface Services extends ServiceContext {
  dbClock: DbClock | null;
}

/** Wire adapters from configuration. Sandbox adapters are explicitly labelled until providers are approved. */
export function createServices(opts: { env?: NodeJS.ProcessEnv; config?: AppConfig; db?: Db; clock?: Clock } = {}): Services {
  const config = opts.config ?? loadConfig(opts.env);
  const db = opts.db ?? createDb(config.DATABASE_URL);
  const dbClock = opts.clock ? null : new DbClock(db, config.SANDBOX_MODE);
  const log = createLogger({ service: 'trendora' });
  return {
    db,
    config,
    log,
    clock: opts.clock ?? dbClock!,
    dbClock,
    payments: new SandboxPaymentProvider({ appUrl: config.APP_URL, webhookSecret: config.SANDBOX_WEBHOOK_SECRET }),
    video: new SandboxVideoProvider(config.MEDIA_DIR),
    ai: config.ANTHROPIC_API_KEY ? new ClaudeAgentProvider({ apiKey: config.ANTHROPIC_API_KEY, model: config.AI_MODEL }) : new SandboxAgentProvider(),
  };
}
