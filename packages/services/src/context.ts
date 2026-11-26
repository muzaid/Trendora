import type { Db, Queryable } from '@trendora/db';
import type { MerchantRole, PlatformRole } from '@trendora/contracts';
import type { AppConfig } from './config';
import type { Logger } from './logger';
import type { PaymentProvider } from './adapters/payments';
import type { VideoProvider } from './adapters/video';
import type { AgentProvider } from './adapters/ai';

export interface Clock {
  now(): Date;
}

export interface ServiceContext {
  db: Db;
  config: AppConfig;
  log: Logger;
  clock: Clock;
  payments: PaymentProvider;
  video: VideoProvider;
  ai: AgentProvider;
  /** Called after commits that enqueue outbox work (lets the web tier drain promptly in sandbox). */
  kickJobs?: () => void;
}

export interface Actor {
  userId: string;
  handle: string;
  displayName: string;
  status: string;
  country: string | null;
  birthYear: number | null;
  createdAt: Date;
  riskScore: number;
  platformRoles: PlatformRole[];
  memberships: { orgId: string; role: MerchantRole }[];
  /** Authenticator assurance level from the token (aal2 = MFA verified). */
  aal: 'aal1' | 'aal2';
}

export interface RequestMeta {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
  deviceId?: string | null;
}

export type Q = Queryable;
