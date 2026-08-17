import type { PaymentProvider } from './provider';
import { MoneiProvider } from './providers/monei';

let cached: PaymentProvider | null = null;

export function getPaymentProvider(): PaymentProvider {
  if (cached) return cached;

  const providerName = process.env.PAYMENT_PROVIDER ?? 'monei';

  if (providerName === 'monei') {
    const apiKey = process.env.MONEI_API_KEY;
    const webhookSecret = process.env.MONEI_WEBHOOK_SECRET;

    if (!apiKey) throw new Error('MONEI_API_KEY env var is required');
    if (!webhookSecret) throw new Error('MONEI_WEBHOOK_SECRET env var is required');

    cached = new MoneiProvider(apiKey, webhookSecret);
    return cached;
  }

  throw new Error(`Unknown payment provider: "${providerName}"`);
}
