'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { formFieldLabelStyle, formControlStyle } from '@/components/formChrome';

// Mirrors COMMUNICATION_TITLE_MAX / COMMUNICATION_MESSAGE_MAX (api/src/domain/staffCommunication.ts).
const TITLE_MAX = 120;
const MESSAGE_MAX = 2000;

/**
 * #1754: Send Communication to a class's booked members, from outside the
 * Calendar panel (Home). Same route and copy as the panel's inline form
 * (`POST /class-sessions/:id/communications`, #1391); the recipients are the
 * server's, derived from the event. Names no permission — the caller decides
 * whether to offer it and the API refuses anyone else.
 */
export function ClassCommunicationModal({ sessionId, sessionName, onClose, onSent }: {
  sessionId: number;
  sessionName: string;
  onClose: () => void;
  onSent?: () => void;
}) {
  const t = useTranslations('calendar');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (sending) return;
    if (!title.trim() || !message.trim()) { setError(t('communication_required')); return; }
    setSending(true);
    setError(null);
    try {
      const res = await apiFetch<{ recipients: number }>(`/class-sessions/${sessionId}/communications`, {
        method: 'POST',
        body: JSON.stringify({ title: title.trim(), message: message.trim() }),
      });
      toast(res.recipients > 0 ? t('communication_sent', { count: res.recipients }) : t('communication_none'));
      onSent?.();
      onClose();
    } catch (err: any) {
      setError(err?.message || t('communication_error'));
      setSending(false);
    }
  }

  return (
    <CrudModal
      open
      title={`${t('communication_title')} — ${sessionName}`}
      error={error}
      saving={sending}
      cancelLabel={t('cancel')}
      saveLabel={sending ? t('communication_sending') : t('communication_send')}
      onCancel={onClose}
      onSave={send}
    >
      <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6b7280' }}>{t('communication_hint')}</p>
      <label style={formFieldLabelStyle} htmlFor="class-comm-title">{t('communication_title_label')}</label>
      <input id="class-comm-title" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} style={{ ...formControlStyle, marginBottom: 12 }} />
      <label style={formFieldLabelStyle} htmlFor="class-comm-message">{t('communication_message_label')}</label>
      <textarea id="class-comm-message" value={message} maxLength={MESSAGE_MAX} rows={5} onChange={(e) => setMessage(e.target.value)} style={{ ...formControlStyle, resize: 'vertical' }} />
    </CrudModal>
  );
}
