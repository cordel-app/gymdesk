'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { CrudModal } from '@/components/CrudModal';
import { ViewAuditLogButton } from '@/components/ViewAuditLogButton';
import {
  DetailsModalField as ModalField, DetailsModalSection as ModalSection,
  detailsModalDividerStyle, detailsModalGridStyle,
} from '@/components/DetailsModalFields';
import { fmtAmount, fmtDateTime, type BillingEventDetails } from './BillingEventExpandedRow';
import { billingEventStatusLabel } from './BillingEventShared';
import { billingEventDetailsView } from './billingEventDetailsView';

/**
 * #3300: `⋮ → Details` of a Billing Event. The Product Details modal is the
 * reference: the same CrudModal, the same field set, order, sections and
 * read-only rows (labels from the `products` namespace, so they cannot drift),
 * and View Audit Log as the modal's footer action. Read-only: it fetches the
 * event and writes nothing.
 */
export function BillingEventDetailsModal({ billingEventId, onClose }: { billingEventId: number | null; onClose: () => void }) {
  const t = useTranslations();
  const tp = useTranslations('products');
  const gymFmt = useGymFormatSettings();
  const { apiFetch } = useApiClient();
  const [details, setDetails] = useState<BillingEventDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetails(null);
    setError(null);
    if (billingEventId == null) return;
    let alive = true;
    apiFetch<BillingEventDetails>(`/payments/billing-events/${billingEventId}`)
      .then((d) => { if (alive) setDetails(d); })
      .catch((err: any) => { if (alive) setError(err?.message ?? t('billing_events_page.details_load_error')); });
    return () => { alive = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingEventId]);

  const view = details ? billingEventDetailsView(details, {
    statusLabel: billingEventStatusLabel(details, t),
    formatAmount: fmtAmount,
    formatDateTime: (iso) => fmtDateTime(iso, gymFmt),
    systemActor: t('billing_events_page.actor_system'),
  }) : null;
  const v = view?.values;

  return (
    <CrudModal
      open={billingEventId !== null}
      title={t('billing_events_page.details_modal_title')}
      error={error}
      saving={false}
      hideSave
      cancelLabel={tp('close')}
      saveLabel=""
      extraFooter={<ViewAuditLogButton entityType="billing_event" entityId={billingEventId ?? undefined} onNavigate={onClose} />}
      onCancel={onClose}
      onSave={onClose}
    >
      {v && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ModalSection title={tp('section_general')} />
          <ModalField label={tp('label_name')} value={v.name} />
          <ModalField label={tp('label_type')} value={v.type} />
          <ModalField label={tp('label_description')} value={v.description} />
          <div style={detailsModalGridStyle}>
            <ModalField label={tp('label_units')} value={v.units} />
            <ModalField label={tp('label_status')} value={v.status} />
            <ModalField label={tp('label_enrollment_status')} value={v.enrollment_status} />
            <ModalField label={tp('label_mandatory')} value={v.mandatory} />
          </div>

          <hr style={detailsModalDividerStyle} />
          <ModalSection title={tp('section_billing')} />
          <div style={detailsModalGridStyle}>
            <ModalField label={tp('label_price')} value={v.price} />
            <ModalField label={tp('label_frequency')} value={v.frequency} />
            <ModalField label={tp('label_validity_days')} value={v.validity_days} />
            <ModalField label={tp('label_tax_rate')} value={v.tax_rate} />
          </div>

          {view?.notes && (
            <>
              <hr style={detailsModalDividerStyle} />
              <ModalSection title={tp('section_notes')} />
              <ModalField label="" value={view.notes} />
            </>
          )}

          <hr style={detailsModalDividerStyle} />
          <ModalSection title={tp('section_audit')} />
          <div style={detailsModalGridStyle}>
            <ModalField label={tp('audit_created_at')} value={v.created_at} />
            <ModalField label={tp('audit_created_by')} value={v.created_by} />
            <ModalField label={tp('audit_modified_at')} value={v.modified_at} />
            <ModalField label={tp('audit_modified_by')} value={v.modified_by} />
            <ModalField label={tp('audit_deleted_at')} value={v.deleted_at} />
            <ModalField label={tp('audit_deleted_by')} value={v.deleted_by} />
          </div>
        </div>
      )}
    </CrudModal>
  );
}
