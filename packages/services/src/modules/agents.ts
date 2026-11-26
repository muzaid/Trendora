import { randomUUID } from 'node:crypto';
import { forbidden, invalid, notFound, conflict, type AgentKind } from '@trendora/contracts';
import type { Actor, ServiceContext } from '../context';
import { audit } from '../ops';
import { requireActor, requireOrgPermission, requirePlatform } from './identity';
import { loadCampaign } from './campaign-data';
import { campaignAnalytics } from './analytics';

/**
 * Optional multi-agent layer (spec §13–14, P6). Inputs are assembled server-side
 * from tenant-authorized aggregates; outputs are advisory, validated, logged with
 * cost and trace id, and require human approval. Agents have no write tools.
 */
const MERCHANT_AGENTS: AgentKind[] = ['TREND', 'CAMPAIGN', 'COMMERCE', 'MARKETING', 'ANALYTICS', 'VIDEO_STUDIO'];
const PLATFORM_AGENTS: AgentKind[] = ['TRUST', 'REWARDS'];

async function monthlySpendMicros(ctx: ServiceContext) {
  return (await ctx.db.one<{ n: number }>(`select coalesce(sum(cost_usd_micros),0)::bigint as n from agent_runs where created_at > date_trunc('month', now())`)).n;
}

export async function runAgent(ctx: ServiceContext, actor: Actor | null, input: { agent: AgentKind; orgId?: string; campaignId?: string; prompt: string }) {
  const a = requireActor(actor);
  let orgId: string | null = null;
  const data: Record<string, unknown> = {};
  let task = '';
  if (MERCHANT_AGENTS.includes(input.agent)) {
    if (!input.orgId) throw invalid('orgId is required for merchant agents');
    requireOrgPermission(a, input.orgId, 'agents.run');
    orgId = input.orgId;
  } else if (PLATFORM_AGENTS.includes(input.agent)) {
    requirePlatform(ctx, a, 'moderation');
  } else throw forbidden();

  if (input.campaignId) {
    const c = await loadCampaign(ctx.db, input.campaignId);
    const store = await ctx.db.one<{ org_id: string }>(`select org_id from stores where id = $1`, [c.store_id]);
    if (orgId && store.org_id !== orgId) throw forbidden('Campaign belongs to another organization');
    data.campaignTitle = c.title;
    data.campaignStatus = c.status;
    data.inventoryCap = c.inventory_cap;
    const stock = await ctx.db.one<{ n: number }>(`select coalesce(sum(i.available),0)::int as n from campaign_skus cs join inventory i on i.variant_id = cs.variant_id where cs.campaign_id = $1`, [c.id]);
    data.availableStock = stock.n;
    const sku = await ctx.db.maybeOne<{ offer_minor: number; price_minor: number }>(`select cs.offer_minor, v.price_minor from campaign_skus cs join variants v on v.id = cs.variant_id where cs.campaign_id = $1 limit 1`, [c.id]);
    if (sku) { data.offerMinor = sku.offer_minor; data.regularMinor = sku.price_minor; }
    const prize = await ctx.db.one<{ n: number }>(`select coalesce(sum(value_minor * (coalesce(rank_to, rank_from) - rank_from + 1)),0)::bigint as n from prize_tiers where campaign_id = $1 and type = 'PRIZE'`, [c.id]);
    data.prizeBudgetMinor = prize.n;
    if (input.agent === 'ANALYTICS' || input.agent === 'COMMERCE') {
      const an = await campaignAnalytics(ctx, a, c.id);
      data.paidOrders = an.funnel.paidOrders;
      data.impressions = an.funnel.impressions;
      data.paidConversionRate = an.funnel.organicImpressions ? an.funnel.paidOrders / an.funnel.organicImpressions : 0;
      data.grossMinor = an.revenue.grossMinor;
    }
    if (input.agent === 'TRUST') {
      data.openFlags = (await ctx.db.one<{ n: number }>(`select count(*)::int as n from fraud_flags where campaign_id = $1 and status = 'OPEN'`, [c.id])).n;
      data.duplicateMediaHashes = (await ctx.db.one<{ n: number }>(`select count(*)::int as n from fraud_flags where campaign_id = $1 and kind = 'DUPLICATE_MEDIA'`, [c.id])).n;
      data.invalidEventsByReason = await ctx.db.query(`select invalid_reason as reason, count(*)::int as n from engagement_events ev join entries e on e.id = ev.entry_id where e.campaign_id = $1 and ev.validity = 'INVALID' group by 1`, [c.id]);
    }
    if (input.agent === 'REWARDS') {
      data.overduePrizes = (await ctx.db.one<{ n: number }>(`select count(*)::int as n from rewards where campaign_id = $1 and type = 'PRIZE' and status <> 'FULFILLED' and delivery_deadline < $2`, [c.id, ctx.clock.now()])).n;
      data.unclaimedPrizes = (await ctx.db.one<{ n: number }>(`select count(*)::int as n from rewards where campaign_id = $1 and type = 'PRIZE' and status = 'ISSUED'`, [c.id])).n;
    }
  }
  if (input.prompt) data.merchantNotes_UNTRUSTED = input.prompt.slice(0, 2000);
  task = {
    TREND: 'Propose up to 3 campaign briefs with rationale, audience, risk and confidence. Use only the supplied aggregates; if trend data is missing, escalate rather than invent.',
    CAMPAIGN: 'Suggest offer price, inventory cap and prize tiers with sensitivity. Never publish; the merchant decides.',
    COMMERCE: 'Suggest merchandising changes and inventory alerts. No automatic price changes.',
    VIDEO_STUDIO: 'Draft a storyboard, captions and shot list for a creator. Only licensed/permitted assets; user approval required.',
    TRUST: 'Produce advisory risk flags with evidence and confidence. You cannot sanction anyone.',
    REWARDS: 'Detect fulfilment discrepancies and suggest next steps. You cannot issue or alter prizes.',
    MARKETING: 'Draft ad copy, a channel plan and the required sponsorship disclosure for merchant approval.',
    ANALYTICS: 'Explain the aggregate results citing source metrics; recommendations apply to the next campaign only.',
  }[input.agent];

  const budgetMicros = ctx.config.AI_MONTHLY_BUDGET_USD * 1_000_000;
  const traceId = randomUUID();
  const provider = !ctx.ai.isSandbox && (await monthlySpendMicros(ctx)) >= budgetMicros ? null : ctx.ai;
  if (!provider) throw conflict('Monthly AI budget reached; runs are paused until next month');
  const run = await ctx.db.one<{ id: string }>(
    `insert into agent_runs (agent, org_id, requested_by, provider, input_ref, trace_id) values ($1,$2,$3,$4,$5,$6) returning id`,
    [input.agent, orgId, a.userId, provider.name, JSON.stringify({ campaignId: input.campaignId ?? null, keys: Object.keys(data) }), traceId],
  );
  try {
    const result = await provider.run({ agent: input.agent, task, data });
    await ctx.db.query(`update agent_runs set status = 'SUCCEEDED', output = $2, cost_usd_micros = $3 where id = $1`, [run.id, JSON.stringify(result.output), result.costUsdMicros]);
    return { runId: run.id, traceId, provider: result.provider, sandbox: provider.isSandbox, output: result.output, costUsdMicros: result.costUsdMicros };
  } catch (e) {
    const cost = (e as { costUsdMicros?: number }).costUsdMicros ?? 0;
    const status = (e as Error).name === 'ZodError' ? 'REJECTED_OUTPUT' : 'FAILED';
    await ctx.db.query(`update agent_runs set status = $2, error = $3, cost_usd_micros = $4 where id = $1`, [run.id, status, (e as Error).message.slice(0, 500), cost]);
    ctx.log.warn('agent run failed', { runId: run.id, traceId, status });
    throw conflict('The assistant could not produce a valid result; nothing was changed');
  }
}

export async function decideAgentRun(ctx: ServiceContext, actor: Actor | null, runId: string, decision: 'APPROVED' | 'DISMISSED') {
  const a = requireActor(actor);
  const run = await ctx.db.maybeOne<{ id: string; org_id: string | null; status: string }>(`select id, org_id, status from agent_runs where id = $1`, [runId]);
  if (!run) throw notFound('Agent run');
  if (run.org_id) requireOrgPermission(a, run.org_id, 'agents.run');
  else requirePlatform(ctx, a, 'moderation');
  if (run.status !== 'SUCCEEDED') throw conflict('Only successful runs can be reviewed');
  await ctx.db.tx(async (q) => {
    await q.query(`update agent_runs set status = $2, approved_by = $3 where id = $1`, [runId, decision, a.userId]);
    await audit(q, { actorId: a.userId, action: `agent_run.${decision.toLowerCase()}`, targetType: 'agent_run', targetId: runId });
  });
  // Approval records the human decision only; applying a suggestion is a separate, deterministic merchant action.
  return { status: decision };
}

export async function listAgentRuns(ctx: ServiceContext, actor: Actor | null, orgId?: string) {
  const a = requireActor(actor);
  if (orgId) requireOrgPermission(a, orgId, 'agents.run');
  else requirePlatform(ctx, a, 'moderation');
  return ctx.db.query(
    `select id, agent, provider, status, output, cost_usd_micros as "costUsdMicros", trace_id as "traceId", created_at as "createdAt" from agent_runs
     where ($1::uuid is null and org_id is null) or org_id = $1 order by created_at desc limit 30`,
    [orgId ?? null],
  );
}
