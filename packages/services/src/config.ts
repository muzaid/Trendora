import { z } from 'zod';

/** Environment validation (spec §16 P0). Secrets come only from the environment vault. */
const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.string().url(),
  APP_URL: z.string().url().default('http://localhost:3000'),
  /** Sandbox mode: sandbox payment/video adapters, sandbox login and clock controls. Never in production. */
  SANDBOX_MODE: bool.default(true),
  AUTH_JWT_SECRET: z.string().min(32),
  AUTH_JWT_ISSUER: z.string().default('trendora'),
  /** When set, also accept Supabase Auth access tokens signed with this secret. */
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SIGNING_SECRET: z.string().min(32),
  COUPON_SECRET: z.string().min(32),
  PAYMENT_PROVIDER: z.enum(['sandbox']).default('sandbox'),
  SANDBOX_WEBHOOK_SECRET: z.string().min(16).default('whsec_sandbox_local_only_0000'),
  VIDEO_PROVIDER: z.enum(['sandbox']).default('sandbox'),
  MEDIA_DIR: z.string().default('.trendora-data/media'),
  PLATFORM_COMMISSION_BPS: z.coerce.number().int().min(0).max(5000).default(800),
  CHECKOUT_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(900),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  AI_MONTHLY_BUDGET_USD: z.coerce.number().min(0).default(25),
  REQUIRE_MFA_FOR_PRIVILEGED: bool.default(false),
});

export type AppConfig = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production' && cfg.SANDBOX_MODE && env.ALLOW_SANDBOX_IN_PRODUCTION !== 'true') {
    throw new Error('SANDBOX_MODE must be false in production (set ALLOW_SANDBOX_IN_PRODUCTION=true only for staging demos)');
  }
  return cfg;
}
