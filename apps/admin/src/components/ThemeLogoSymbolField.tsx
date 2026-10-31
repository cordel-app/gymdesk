'use client';

import { useRef, useState } from 'react';
import { FormLabel } from '@/components/CrudModal';
import { btnSmall, readOnlyStyle } from '@/components/ui';
import { useApiClient, apiErrorMessage } from '@/lib/apiClient';

// #2157 — a Theme's logo symbol (the favicon). Unlike the full logo, which is
// queued with the card's Save, the symbol acts on the server at once (the same
// "immediate" shape as `MemberImageField`): its own `POST` / `DELETE
// <basePath>/<id>/logo-symbol`, independent of the full logo. The server does
// the WebP conversion; the browser sends the picked file as it is.
//
// Presentational about permissions: the page decides `basePath` (`/system/themes`
// vs `/platform/themes`), `disabledReason` (read-only or storage not ready) and
// what to do once the server has changed it (`onChanged`, a reload).

interface Props {
  basePath: string;
  themeId: string;
  url: string | null;
  /** A Base Theme viewed from a gym: the symbol is shown, no control is offered. */
  readOnly?: boolean;
  disabledReason?: string | null;
  onChanged: () => void | Promise<void>;
  t: (key: any) => string;
}

export function ThemeLogoSymbolField({ basePath, themeId, url, readOnly = false, disabledReason = null, onChanged, t }: Props) {
  const { apiFetch, uploadFetch } = useApiClient();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const disabled = busy || disabledReason !== null;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged();
    } catch (err: any) {
      setError(`${t('logo_symbol_failed')}: ${apiErrorMessage(err) ?? err?.message ?? ''}`);
    } finally {
      setBusy(false);
    }
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void run(() => uploadFetch(`${basePath}/${themeId}/logo-symbol`, file));
  }

  return (
    <div style={{ marginTop: 16 }}>
      <FormLabel>{t('label_logo_symbol')}</FormLabel>
      <p style={{ margin: '0 0 8px', fontSize: 12, color: '#888' }}>{t('logo_symbol_hint')}</p>
      {url && brokenSrc !== url && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={url}
          alt="logo symbol preview"
          onError={() => setBrokenSrc(url)}
          style={{ height: 48, width: 'auto', maxWidth: 200, objectFit: 'contain', display: 'block', border: '1px solid #eee', borderRadius: 6, padding: 4, marginBottom: 8 }}
        />
      )}
      {error && <p style={{ margin: '0 0 8px', fontSize: 12, color: '#c0392b', whiteSpace: 'pre-line' }}>{error}</p>}
      {!readOnly && disabledReason && (
        <p style={{ margin: '0 0 8px', fontSize: 12, color: '#c0392b' }}>{disabledReason}</p>
      )}
      {!readOnly && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={disabled}
            style={readOnlyStyle(btnSmall('#444'), disabled)}
          >
            {t('logo_symbol_upload')}
          </button>
          {url && (
            <button
              type="button"
              disabled={disabled}
              onClick={() => void run(() => apiFetch(`${basePath}/${themeId}/logo-symbol`, { method: 'DELETE' }))}
              style={readOnlyStyle(btnSmall('#c0392b'), disabled)}
            >
              {t('logo_symbol_clear')}
            </button>
          )}
        </div>
      )}
      <input ref={inputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" style={{ display: 'none' }} disabled={disabled} onChange={onPick} />
    </div>
  );
}
