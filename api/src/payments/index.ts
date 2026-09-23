import type { PaymentProvider } from './provider';
import { MoneiProvider } from './providers/monei';

let cached: PaymentProvider | null = null;

/**
 * #636: adapter keys this layer implements. A `payment_providers` catalogue row
 * names one of these in its `provider_key`, so the Cordel CRUD cannot create a
 * provider no code can transact through. Credentials for the key stay in the
 * environment — the catalogue never stores them.
 */
export const SUPPORTED_PAYMENT_PROVIDER_KEYS = ['monei'] as const;

export type PaymentProviderKey = typeof SUPPORTED_PAYMENT_PROVIDER_KEYS[number];

export function isSupportedPaymentProviderKey(key: string): key is PaymentProviderKey {
  return (SUPPORTED_PAYMENT_PROVIDER_KEYS as readonly string[]).includes(key);
}

export interface PaymentDeploymentStatus {
  /** Adapter `getPaymentProvider()` resolves from the environment. */
  provider_key: string;
  /** PAYMENT_ENV, informational — null when unset. */
  environment: string | null;
  credentials_configured: boolean;
  /** Env vars the configured adapter needs but did not receive. */
  missing_config: string[];
  /** URL to register in the provider's dashboard. */
  webhook_url: string | null;
  supported_provider_keys: string[];
}

/**
 * #636: what the retired Finance → Payment Providers page used to render from
 * the *admin* container's environment. It is reported from the API instead,
 * because that is the process whose env actually decides whether a charge can
 * be created — the admin app never reads MONEI_API_KEY at runtime.
 */
export function describePaymentDeployment(): PaymentDeploymentStatus {
  const providerKey = process.env.PAYMENT_PROVIDER ?? 'monei';
  const missing: string[] = [];

  if (providerKey === 'monei') {
    if (!process.env.MONEI_API_KEY) missing.push('MONEI_API_KEY');
    if (!process.env.MONEI_WEBHOOK_SECRET) missing.push('MONEI_WEBHOOK_SECRET');
  }

  return {
    provider_key: providerKey,
    environment: process.env.PAYMENT_ENV ?? null,
    credentials_configured: isSupportedPaymentProviderKey(providerKey) && missing.length === 0,
    missing_config: missing,
    webhook_url: process.env.PAYMENT_NOTIFICATION_URL ?? null,
    supported_provider_keys: [...SUPPORTED_PAYMENT_PROVIDER_KEYS],
  };
}

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
