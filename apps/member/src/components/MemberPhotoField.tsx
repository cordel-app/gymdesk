'use client';

import { useRef, useState, type CSSProperties } from 'react';
import { useApiClient } from '@/lib/apiClient';
import { MemberAvatar } from '@/components/MemberAvatar';
import { MemberDialog } from '@/components/MemberDialog';
import { destructiveButtonStyle, memberTheme, primaryButtonStyle, secondaryButtonStyle } from '@/lib/memberChrome';
import { MEMBER_IMAGE_ACCEPT, isPreparedMemberImage, prepareMemberImage } from '@/lib/memberImageUpload';

/**
 * #1375 — the member's own photo, on the Profile page: the avatar at a size
 * that reads as a portrait, `Upload photo` / `Replace photo`, and `Remove`
 * (confirmed through the app's one dialog shell).
 *
 * The upload and the removal act on the server straight away
 * (`POST`/`DELETE /me/profile/image`) and hand the page the profile that came
 * back, so the phone field's own Edit/Save pair neither carries nor can undo
 * them. The browser crops and scales whatever picture was picked
 * (`lib/memberImageUpload.ts`); the server still judges the bytes. Every colour
 * is a `memberChrome` role (#983), every label arrives resolved from the page
 * (`label`), and a plain `<input type="file">` is what opens the camera or the
 * gallery in the native shell — no plugin (#1073).
 *
 * `canEdit: false` draws the avatar and nothing else: a superadmin impersonating
 * the member sees their photo and gets no control (ticket §2).
 */
export function MemberPhotoField({
  member, canEdit, label, onChanged,
}: {
  member: { id: number; name: string; image_url?: string | null; modified_at?: string | null };
  canEdit: boolean;
  /** Resolves a key in the `profile` namespace. */
  label: (key: string) => string;
  /** The profile as the API returned it after the change. */
  onChanged: (profile: unknown) => void;
}) {
  const { apiFetch, uploadFetch } = useApiClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const hasPhoto = !!member.image_url;

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared so picking the same file twice still fires `onChange`.
    e.target.value = '';
    if (!file) return;
    setError(null);
    setBusy('upload');
    try {
      const prepared = await prepareMemberImage(file);
      if (!isPreparedMemberImage(prepared)) {
        // Nothing is sent, so the photo already there is untouched.
        setError(label(prepared));
        return;
      }
      const updated = await uploadFetch('/me/profile/image', prepared);
      onChanged(updated);
    } catch (err: any) {
      setError(err.message ?? label('photo_error_upload_failed'));
    } finally {
      setBusy(null);
    }
  }

  async function handleRemove() {
    setConfirming(false);
    setError(null);
    setBusy('remove');
    try {
      const updated = await apiFetch('/me/profile/image', { method: 'DELETE' });
      onChanged(updated);
    } catch (err: any) {
      setError(err.message ?? label('photo_error_remove_failed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div style={styles.row}>
      <p style={styles.label}>{label('photo')}</p>
      <div style={styles.body}>
        <MemberAvatar member={member} size={96} />
        {canEdit && (
          <div style={styles.controls}>
            <input
              ref={inputRef}
              type="file"
              accept={MEMBER_IMAGE_ACCEPT}
              style={{ display: 'none' }}
              onChange={handleFile}
              disabled={busy !== null}
            />
            <div style={styles.buttons}>
              <button
                type="button"
                style={styles.primary}
                disabled={busy !== null}
                onClick={() => inputRef.current?.click()}
              >
                {busy === 'upload' ? label('photo_uploading') : label(hasPhoto ? 'photo_replace' : 'photo_upload')}
              </button>
              {hasPhoto && (
                <button
                  type="button"
                  style={styles.secondary}
                  disabled={busy !== null}
                  onClick={() => setConfirming(true)}
                >
                  {label('photo_remove')}
                </button>
              )}
            </div>
            <p style={styles.hint}>{label('photo_hint')}</p>
            {error && <p style={styles.error}>{error}</p>}
          </div>
        )}
      </div>

      {confirming && (
        <MemberDialog
          title={label('photo_remove_title')}
          onClose={() => setConfirming(false)}
          labelledBy="member-photo-remove-title"
          actions={(
            <>
              <button type="button" style={{ ...styles.dialogButton, ...secondaryButtonStyle }} onClick={() => setConfirming(false)}>
                {label('cancel')}
              </button>
              <button type="button" style={{ ...styles.dialogButton, ...destructiveButtonStyle }} onClick={handleRemove}>
                {label('photo_remove')}
              </button>
            </>
          )}
        >
          <p style={styles.dialogText}>{label('photo_remove_confirm')}</p>
        </MemberDialog>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  row: { padding: '12px 0', borderBottom: `1px solid ${memberTheme.separator}` },
  label: { margin: 0, fontSize: 12, color: memberTheme.textMuted, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.04em' },
  body: { display: 'flex', alignItems: 'center', gap: 16, marginTop: 8, flexWrap: 'wrap' },
  controls: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, flex: 1 },
  buttons: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  primary: { ...primaryButtonStyle, padding: '8px 14px', fontSize: 14, fontWeight: 600 },
  secondary: { ...secondaryButtonStyle, padding: '8px 14px', fontSize: 14, fontWeight: 600 },
  hint: { margin: 0, fontSize: 12, color: memberTheme.textMuted },
  error: { margin: 0, fontSize: 13, color: memberTheme.statusError },
  dialogText: { margin: 0, fontSize: 14, color: memberTheme.text },
  dialogButton: { flex: 1, padding: '10px 0', fontSize: 15, fontWeight: 600 },
};
