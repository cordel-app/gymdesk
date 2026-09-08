import type { PaymentProvider } from './provider';
import { MoneiProvider } from './providers/monei';

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;

  const providerName = process.env.PAYMENT_PROVIDER ?? 'monei';

  if (providerName === 'monei') {
    const apiKey = process.env.MONEI_API_KEY;
    const webhookSecret = process.env.MONEI_WEBHOOK_SECRET;
    // Optional: only required because this account is a MONEI Connect
    // partner (master account) — a plain merchant account's own API key
    // wouldn't need one.
    const accountId = process.env.MONEI_ACCOUNT_ID;

    if (!apiKey) throw new Error('MONEI_API_KEY env var is required');
    if (!webhookSecret) throw new Error('MONEI_WEBHOOK_SECRET env var is required');

    cached = new MoneiProvider(apiKey, webhookSecret, accountId);
    return cached;
  }

  throw new Error(`Unknown payment provider: "${providerName}"`);
}
