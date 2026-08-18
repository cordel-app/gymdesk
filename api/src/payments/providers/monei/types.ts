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

export interface MoneiWebhookBody {
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
}

export interface MoneiRecurringPaymentResponse {
  id: string;
  status: string;
  statusCode?: string;
  statusMessage?: string;
}
