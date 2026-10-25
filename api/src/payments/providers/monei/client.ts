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

  /**
   * #2087: reads one payment back from MONEI — what the hosted page's
   * confirmation and the cleanup ask instead of waiting for the callback.
   */
  async getPayment(id: string): Promise<MoneiPayment> {
    const response = await fetch(`${MONEI_API_BASE}/payments/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: this.headers(),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Monei API error ${response.status}: ${text}`);
    }
    return response.json() as Promise<MoneiPayment>;
  }

  private headers(): Record<string, string> {
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
    return headers;
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${MONEI_API_BASE}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Monei API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }
}
