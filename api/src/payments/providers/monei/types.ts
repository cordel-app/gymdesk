export interface MoneiPayment {
  id: string;
  orderId: string;
  status: string;
  amount: number;
  currency: string;
  nextAction?: {
    redirectUrl: string;
  };
  paymentMethod?: {
    card?: {
      last4: string;
      brand: string;
    };
  };
}

/**
 * MONEI Connect partner-account webhooks POST an event envelope, not the
 * charge object directly — see docs.monei.com/monei-connect. `object` carries
 * the actual resource; its shape depends on `objectType` (only 'charge'
 * events are subscribed to here).
 */
export interface MoneiWebhookBody {
  id: string;
  type: string;
  objectType: string;
  objectId: string;
  accountId: string;
  livemode: boolean;
  createdAt: number;
  object: {
    id: string;
    orderId: string;
    status: string;
    paymentToken?: string;
    sequenceId?: string;
    paymentMethod?: {
      card?: {
        last4: string;
        brand: string;
      };
    };
  };
}

export interface MoneiRecurringPaymentResponse {
  id: string;
  status: string;
  statusCode?: string;
  statusMessage?: string;
}
