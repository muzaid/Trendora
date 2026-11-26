import { randomUUID } from 'node:crypto';
import { signWebhook, verifyWebhook } from '@trendora/core';

/**
 * Payment provider abstraction (spec §8): create hosted checkout, verify signed
 * webhook, refund, dispute, payout reconciliation. Only the SANDBOX adapter ships
 * until a marketplace-capable provider is approved for the launch geography.
 */
export interface ProviderEvent {
  id: string;
  type: 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'refund.failed' | 'dispute.created' | 'dispute.closed';
  created: number;
  data: Record<string, unknown>;
}

export interface PaymentProvider {
  readonly name: string;
  readonly isSandbox: boolean;
  createCheckoutSession(i: { checkoutId: string; orderId: string; amountMinor: number; currency: string; expiresAt: Date }): Promise<{ sessionId: string; hostedUrl: string }>;
  verifyWebhook(rawBody: string, headers: Headers | Record<string, string | null>, nowSeconds: number): ProviderEvent | null;
  requestRefund(i: { paymentExternalId: string; amountMinor: number; currency: string; reason: string }): Promise<{ refundExternalId: string }>;
}

const header = (h: Headers | Record<string, string | null>, name: string) =>
  h instanceof Headers ? h.get(name) : (h[name] ?? h[name.toLowerCase()] ?? null);

export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';
  readonly isSandbox = true;
  constructor(private readonly opts: { appUrl: string; webhookSecret: string }) {}

  async createCheckoutSession(i: { checkoutId: string }) {
    return { sessionId: `sbx_cs_${i.checkoutId}`, hostedUrl: `${this.opts.appUrl}/sandbox/checkout/${i.checkoutId}` };
  }

  verifyWebhook(rawBody: string, headers: Headers | Record<string, string | null>, nowSeconds: number): ProviderEvent | null {
    if (!verifyWebhook(this.opts.webhookSecret, rawBody, header(headers, 'trendora-signature'), nowSeconds)) return null;
    try {
      const evt = JSON.parse(rawBody) as ProviderEvent;
      if (typeof evt.id !== 'string' || typeof evt.type !== 'string' || typeof evt.data !== 'object') return null;
      return evt;
    } catch {
      return null;
    }
  }

  async requestRefund() {
    return { refundExternalId: `sbx_re_${randomUUID()}` };
  }

  /** Test/sandbox helper: build a correctly signed webhook delivery, as the provider would send it. */
  buildDelivery(evt: Omit<ProviderEvent, 'created'> & { created?: number }, nowSeconds = Math.floor(Date.now() / 1000)) {
    const body = JSON.stringify({ created: nowSeconds, ...evt });
    return { body, headers: { 'trendora-signature': signWebhook(this.opts.webhookSecret, body, nowSeconds) } };
  }
}
