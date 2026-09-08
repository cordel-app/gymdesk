import type { MoneiPayment, MoneiRecurringPaymentResponse } from './types';

const MONEI_API_BASE = 'https://api.monei.com/v1';

export class MoneiClient {
  private readonly apiKey: string;
  private readonly accountId?: string;

  constructor(apiKey: string, accountId?: string) {
    this.apiKey = apiKey;
    this.accountId = accountId;
  }

  async createPayment(body: Record<string, unknown>): Promise<MoneiPayment> {
    return this.post<MoneiPayment>('/payments', body);
  }

  async createRecurringPayment(body: Record<string, unknown>): Promise<MoneiRecurringPaymentResponse> {
    return this.post<MoneiRecurringPaymentResponse>('/payments', body);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = {
      // MONEI's API expects the raw API key, not a Bearer-scheme token —
      // confirmed against the official SDK's setApiKeyToObject(), which
      // assigns the key straight to the Authorization header.
      'Authorization': this.apiKey,
      'Content-Type': 'application/json',
    };
    // This account is a MONEI Connect partner (master account) — the
    // partner API key alone only authenticates partner-level endpoints.
    // Merchant operations (creating a payment) need the target merchant
    // sub-account named explicitly, or the request 401s.
    if (this.accountId) headers['MONEI-Account-ID'] = this.accountId;

    const response = await fetch(`${MONEI_API_BASE}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Monei API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }
}
