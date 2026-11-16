'use client';

// #2806 — the Receipts & Invoices section of a Billing Event: every document
// issued for the event with its type, number, issue date, status and a View
// action. Since #2648 stage 6 it generates nothing: the simplified invoice is
// issued by the system, and Generate Receipt / Generate Complete Invoice are
// the event's ⋮ menu items (`useBillingEventActions`).
//
// #2648 stage 5 — an invoice row also carries its VERI*FACTU records: each
// record's submission status, attempts, last and next attempt and AEAT's last
// answer, kept apart from the invoice's payment status. A gym admin may cancel
// an invoice's record (Registro de Anulación) when the API offers it.

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { primaryBtnSmall } from '@/components/ui';
import {
  formControlStyle, formErrorStyle, formFieldLabelStyle, inlineActionsRowStyle, innerCardStyle, secondaryBtnSmall,
} from '@/components/formChrome';
import type { GymFormatSettings } from '@/lib/gymFormat';
import { CollapsibleSection, StatusBadge, fmtDateTime } from './BillingEventExpandedRow';
import {
  verifactuBadgeTone, verifactuResponseText, verifactuStatusKey,
  type InvoiceRow, type VerifactuRecordView,
} from './verifactuInvoiceView';
import {
  billingDocuments, documentStatusKey, documentTypeKey, type BillingDocumentRow, type ReceiptInfo,
} from './receiptsInvoicesView';
import { useBillingEventDocumentsChanged } from './documentsChanged';

const cell: React.CSSProperties = { padding: '6px 10px', verticalAlign: 'top' };

function RecordStatus({ r, t, gymFmt }: { r: VerifactuRecordView; t: ReturnType<typeof useTranslations>; gymFmt: GymFormatSettings }) {
  const response = verifactuResponseText(r);
  return (
    <div>
      <StatusBadge status={verifactuBadgeTone(r.submission_status)} label={t(`billing_events_page.${verifactuStatusKey(r.submission_status)}` as any)} />
      <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
        {t('billing_events_page.vf_record', { id: r.id, seq: r.chain_seq })}
        {' · '}{t('billing_events_page.vf_attempts', { count: r.submission_attempts })}
        {r.last_submission_at && <> · {t('billing_events_page.vf_last_sent', { at: fmtDateTime(r.last_submission_at, gymFmt) })}</>}
        {r.submission_status === 'retry_pending' && r.next_attempt_at && (
          <> · {t('billing_events_page.vf_next_attempt', { at: fmtDateTime(r.next_attempt_at, gymFmt) })}</>
        )}
      </div>
      {response && (
        <div style={{ fontSize: 12, color: r.submission_status === 'rejected' ? '#991b1b' : '#6b7280' }}>
          {t('billing_events_page.vf_last_response', { text: response })}
        </div>
      )}
    </div>
  );
}

const COLUMNS = [
  'col_doc_type', 'col_inv_number', 'col_inv_issued', 'col_doc_status', 'col_inv_payment', 'col_inv_verifactu', 'col_inv_actions',
] as const;

export function ReceiptsInvoicesSection({
  billingEventId, gymFmt, receipt,
}: {
  billingEventId: number;
  gymFmt: GymFormatSettings;
  receipt: ReceiptInfo;
}) {
  const t = useTranslations();
  const { apiFetch, pdfFetch } = useApiClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [invoices, setInvoices] = useState<InvoiceRow[] | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiFetch<{ invoices: InvoiceRow[] }>(`/payments/billing-events/${billingEventId}/invoices`);
      setInvoices(r.invoices);
    } catch {
      setInvoices([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingEventId]);

  useEffect(() => { load(); }, [load]);
  // #2885: a receipt or complete invoice issued from the ⋮ menu appears here at
  // once — the table is re-read and opened so the new row is in view; a failed
  // issue sends no signal.
  useBillingEventDocumentsChanged(billingEventId, () => { setOpen(true); load(); });

  const documents = billingDocuments(receipt, invoices ?? []);

  function openPdf(blob: Blob) {
    window.open(URL.createObjectURL(blob), '_blank');
  }

  async function view(doc: BillingDocumentRow) {
    setViewing(doc.key);
    try {
      openPdf(await pdfFetch(doc.invoice ? `/payments/invoices/${doc.invoice.id}/pdf` : `/payments/${billingEventId}/receipt`));
    } catch (err: any) {
      toast(err?.message ?? t('billing_events_page.action_error'));
    } finally {
      setViewing(null);
    }
  }

  async function confirmCancel(invoiceId: number) {
    if (!reason.trim()) { setError(t('billing_events_page.vf_cancel_reason_required')); return; }
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/payments/invoices/${invoiceId}/verifactu/cancel`, {
        method: 'POST', body: JSON.stringify({ reason: reason.trim() }),
      });
      setCancelling(null);
      setReason('');
      toast(t('billing_events_page.vf_cancel_done'));
      await load();
    } catch (err: any) {
      setError(err?.message ?? t('billing_events_page.action_error'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <CollapsibleSection title={t('billing_events_page.invoices_heading')} defaultOpen={false}
      open={open} onOpenChange={setOpen}>
      {invoices == null ? (
        <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>{t('billing_events_page.loading')}</p>
      ) : documents.length === 0 ? (
        <p style={{ margin: '0 0 16px', color: '#6b7280', fontSize: 13 }}>{t('billing_events_page.invoices_empty')}</p>
      ) : (
        <div style={{ marginBottom: 16, overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: 13, width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid #e5e7eb' }}>
                {COLUMNS.map((k) => (
                  <th key={k} style={{ padding: '4px 10px', textAlign: 'left', fontWeight: 600, color: '#374151' }}>
                    {t(`billing_events_page.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {documents.map((doc) => {
                const inv = doc.invoice;
                const statusKey = documentStatusKey(doc.status);
                return (
                  <React.Fragment key={doc.key}>
                    <tr style={{ borderBottom: '1px solid #f3f4f6' }}>
                      <td style={cell}>
                        {t(`billing_events_page.${documentTypeKey(doc.kind)}` as any)}
                        {doc.rectifying && <span style={{ color: '#6b7280' }}> ({t('billing_events_page.inv_rectifying')})</span>}
                      </td>
                      <td style={cell}>{doc.number ?? '—'}</td>
                      <td style={cell}>{fmtDateTime(doc.issuedAt, gymFmt)}</td>
                      <td style={cell}>
                        <StatusBadge status={doc.status === 'issued' ? 'recorded' : 'pending'}
                          label={statusKey ? t(`billing_events_page.${statusKey}` as any) : doc.status} />
                      </td>
                      <td style={cell}>
                        {inv
                          ? (inv.payment_status ? t(`billing_events_page.inv_payment_${inv.payment_status}` as any) : '—')
                          : t('billing_events_page.inv_payment_paid')}
                      </td>
                      <td style={cell}>
                        {!inv ? '—' : inv.verifactu?.alta ? (
                          <>
                            <RecordStatus r={inv.verifactu.alta} t={t} gymFmt={gymFmt} />
                            {inv.verifactu.anulacion && (
                              <div style={{ marginTop: 8 }}>
                                <div style={{ fontSize: 12, fontWeight: 600 }}>{t('billing_events_page.vf_anulacion')}</div>
                                <RecordStatus r={inv.verifactu.anulacion} t={t} gymFmt={gymFmt} />
                              </div>
                            )}
                          </>
                        ) : <span style={{ color: '#6b7280' }}>{t('billing_events_page.vf_none')}</span>}
                      </td>
                      <td style={cell}>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          <button type="button" style={secondaryBtnSmall} disabled={viewing === doc.key} onClick={() => view(doc)}>
                            {viewing === doc.key ? t('billing_events_page.doc_opening') : t('billing_events_page.doc_view')}
                          </button>
                          {inv?.can_cancel_verifactu && cancelling !== inv.id && (
                            <button type="button" style={secondaryBtnSmall}
                              onClick={() => { setCancelling(inv.id); setReason(''); setError(null); }}>
                              {t('billing_events_page.vf_cancel_action')}
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {inv && cancelling === inv.id && (
                      <tr>
                        <td colSpan={COLUMNS.length} style={{ padding: '6px 10px' }}>
                          <div style={innerCardStyle}>
                            <p style={{ margin: '0 0 8px', fontSize: 13 }}>{t('billing_events_page.vf_cancel_explain')}</p>
                            <label style={formFieldLabelStyle} htmlFor={`vf-cancel-${inv.id}`}>
                              {t('billing_events_page.vf_cancel_reason')}
                            </label>
                            <textarea id={`vf-cancel-${inv.id}`} rows={2} maxLength={500} value={reason}
                              onChange={(e) => setReason(e.target.value)} style={formControlStyle} />
                            {error && <div style={formErrorStyle}>{error}</div>}
                            <div style={inlineActionsRowStyle}>
                              <button type="button" style={primaryBtnSmall()} disabled={saving} onClick={() => confirmCancel(inv.id)}>
                                {saving ? t('billing_events_page.vf_cancel_working') : t('billing_events_page.vf_cancel_confirm')}
                              </button>
                              <button type="button" style={secondaryBtnSmall} disabled={saving}
                                onClick={() => { setCancelling(null); setError(null); }}>
                                {t('billing_events_page.vf_cancel_back')}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleSection>
  );
}
