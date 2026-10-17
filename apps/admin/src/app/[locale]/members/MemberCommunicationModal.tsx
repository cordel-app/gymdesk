'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { useToast } from '@/components/Toast';
import { CrudModal } from '@/components/CrudModal';
import { formFieldLabelStyle, formControlStyle } from '@/components/formChrome';

// Mirrors `COMMUNICATION_TITLE_MAX` / `COMMUNICATION_MESSAGE_MAX` in
// api/src/domain/staffCommunication.ts; the API enforces them again.
const TITLE_MAX = 120;
const MESSAGE_MAX = 2000;

/**
 * #1390: Send Communication to one Member. Names no permission — the page
 * decides whether to offer it and the API refuses anyone else. The Member is
 * the URL's (`memberId`), never part of the body.
 */
export function MemberCommunicationModal({ memberId, memberName, onClose, onSent }: {
  memberId: number;
  memberName: string;
  onClose: () => void;
  /** Called once, after the API accepted the communication (never on cancel or error). */
  onSent?: () => void;
}) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const { toast } = useToast();
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    if (sending) return;
    const cleanTitle = title.trim();
    const cleanMessage = message.trim();
    if (!cleanTitle) { setError(t('communication_title_required')); return; }
    if (!cleanMessage) { setError(t('communication_message_required')); return; }
    setSending(true);
    setError(null);
    try {
      await apiFetch(`/members/${memberId}/communications`, {
        method: 'POST',
        body: JSON.stringify({ title: cleanTitle, message: cleanMessage }),
      });
      toast(t('communication_sent', { name: memberName }));
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
      title={t('communication_heading', { name: memberName })}
      error={error}
      saving={sending}
      cancelLabel={t('communication_cancel')}
      saveLabel={sending ? t('communication_sending') : t('communication_send')}
      onCancel={onClose}
      onSave={send}
    >
      <p style={{ margin: '0 0 12px', fontSize: 13, color: '#6b7280' }}>{t('communication_hint')}</p>
      <label style={formFieldLabelStyle} htmlFor="member-comm-title">{t('communication_title_label')}</label>
      <input
        id="member-comm-title"
        value={title}
        maxLength={TITLE_MAX}
        onChange={(e) => setTitle(e.target.value)}
        style={{ ...formControlStyle, marginBottom: 12 }}
      />
      <label style={formFieldLabelStyle} htmlFor="member-comm-message">{t('communication_message_label')}</label>
      <textarea
        id="member-comm-message"
        value={message}
        maxLength={MESSAGE_MAX}
        rows={5}
        onChange={(e) => setMessage(e.target.value)}
        style={{ ...formControlStyle, resize: 'vertical' }}
      />
    </CrudModal>
  );
}
