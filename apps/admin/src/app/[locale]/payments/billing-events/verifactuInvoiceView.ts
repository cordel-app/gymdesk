// #2648 stage 5 — how an invoice's VERI*FACTU records read in the Billing Event
// view. Pure: no React, no `t()`. It decides only presentation (which badge tone
// and locale key a stored submission status takes); whether a record may be
// cancelled is the API's `can_cancel_verifactu`, never decided here.

export type VerifactuSubmissionStatus =
  | 'pending' | 'sending' | 'submitted' | 'retry_pending' | 'accepted' | 'accepted_with_errors' | 'rejected';

export interface VerifactuRecordView {
  id: number;
  record_type: 'alta' | 'anulacion';
  chain_seq: number;
  submission_status: VerifactuSubmissionStatus;
  submission_attempts: number;
  last_submission_at: string | null;
  next_attempt_at: string | null;
  accepted_at: string | null;
  aeat_response_code: string | null;
  aeat_response_description: string | null;
  aeat_csv: string | null;
  record_hash: string;
  created_at: string;
}

export interface InvoiceRow {
  id: number;
  invoice_type: 'simplified' | 'full';
  status: string;
  fiscal_number: string | null;
  issued_at: string | null;
  payment_status: string | null;
  related_invoice_id: number | null;
  rectification_reason: string | null;
  verifactu: { alta: VerifactuRecordView | null; anulacion: VerifactuRecordView | null } | null;
  can_cancel_verifactu: boolean;
}

/** The `StatusBadge` tone a submission status reads in (the badge's own palette). */
export function verifactuBadgeTone(status: VerifactuSubmissionStatus): 'paid' | 'pending' | 'failed' | 'scheduled' | 'recorded' {
  switch (status) {
    case 'accepted': return 'paid';
    case 'accepted_with_errors': return 'scheduled';
    case 'rejected': return 'failed';
    case 'sending': return 'recorded';
    default: return 'pending';
  }
}

/** The `billing_events_page` locale key a submission status reads under. */
export function verifactuStatusKey(status: VerifactuSubmissionStatus): string {
  return `vf_status_${status === 'submitted' ? 'sending' : status}`;
}

/** AEAT's last answer, `CODE: description`, or null when there is none. */
export function verifactuResponseText(r: VerifactuRecordView): string | null {
  const text = [r.aeat_response_code, r.aeat_response_description].filter(Boolean).join(': ');
  return text || null;
}
