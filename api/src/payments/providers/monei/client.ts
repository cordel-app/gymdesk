import type { MoneiPayment, MoneiRecurringPaymentResponse } from './types';

const MONEI_API_BASE = 'https://api.monei.com/v1';

export class MoneiClient {
  private readonly apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async createPayment(body: Record<string, unknown>): Promise<MoneiPayment> {
    return this.post<MoneiPayment>('/payments', body);
  }

  async createRecurringPayment(body: Record<string, unknown>): Promise<MoneiRecurringPaymentResponse> {
    return this.post<MoneiRecurringPaymentResponse>('/payments', body);
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${MONEI_API_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Monei API error ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }
}
