import { z } from 'zod';
import * as api from './api';

/** Minimal OpenAPI 3.1 document generated from the Zod request schemas. */
const routes: { method: string; path: string; summary: string; body?: z.ZodType; auth: boolean; idempotent?: boolean }[] = [
  { method: 'get', path: '/v1/feed', summary: 'Approved video feed (cursor paginated)', auth: false },
  { method: 'get', path: '/v1/stores/{slug}', summary: 'Public store, products and active campaigns', auth: false },
  { method: 'get', path: '/v1/campaigns/{id}', summary: 'Campaign rules and prize tiers', auth: false },
  { method: 'get', path: '/v1/campaigns/{id}/leaderboard', summary: 'Provisional or final leaderboard', auth: false },
  { method: 'post', path: '/v1/checkouts', summary: 'Create hosted checkout (server reprices)', body: api.CreateCheckoutBody, auth: true, idempotent: true },
  { method: 'post', path: '/v1/webhooks/{provider}', summary: 'Signed payment/video provider webhook', auth: false },
  { method: 'post', path: '/v1/entries', summary: 'Create entry and signed upload URL', body: api.CreateEntryBody, auth: true },
  { method: 'post', path: '/v1/entries/{id}/submit', summary: 'Submit entry after asset ready', body: api.SubmitEntryBody, auth: true },
  { method: 'put', path: '/v1/entries/{id}/like', summary: 'Idempotent like upsert', body: api.LikeBody, auth: true },
  { method: 'post', path: '/v1/entries/{id}/share', summary: 'Create signed share link', auth: true },
  { method: 'post', path: '/v1/merchant/campaigns', summary: 'Create campaign draft', body: api.CampaignDraftBody, auth: true },
  { method: 'patch', path: '/v1/merchant/campaigns/{id}', summary: 'Update draft (optimistic expectedVersion)', body: api.CampaignPatchBody, auth: true },
  { method: 'post', path: '/v1/merchant/campaigns/{id}/publish', summary: 'Request platform review', auth: true },
  { method: 'post', path: '/v1/merchant/campaigns/{id}/cancel', summary: 'Cancel campaign (reason required)', body: api.ReasonBody, auth: true },
  { method: 'get', path: '/v1/me/rewards', summary: 'Own rewards and coupons', auth: true },
  { method: 'post', path: '/v1/rewards/{id}/claim', summary: 'Claim prize', body: api.ClaimRewardBody, auth: true },
  { method: 'post', path: '/v1/appeals', summary: 'File appeal', body: api.AppealBody, auth: true },
  { method: 'post', path: '/v1/admin/campaigns/{id}/finalize', summary: 'Finalize ranking and issue rewards', body: api.FinalizeBody, auth: true, idempotent: true },
];

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const params = [...r.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
    if (r.idempotent) params.push({ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } });
    paths[r.path] ??= {};
    paths[r.path]![r.method] = {
      summary: r.summary,
      parameters: params,
      security: r.auth ? [{ bearer: [] }] : [],
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(r.body, { io: 'input', unrepresentable: 'any' }) } } } } : {}),
      responses: {
        '2XX': { description: 'Success' },
        default: { description: 'Typed error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'TRENDORA API', version: '1.0.0' },
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'requestId'],
              properties: {
                code: { enum: ['INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT', 'INELIGIBLE', 'RATE_LIMITED', 'INTERNAL'] },
                message: { type: 'string' },
                requestId: { type: 'string' },
              },
            },
          },
        },
      },
    },
  };
}
