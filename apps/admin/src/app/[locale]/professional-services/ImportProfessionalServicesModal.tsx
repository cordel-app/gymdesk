'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { primaryBtnStyle, btnStyle } from '@/components/ui';
import { filterControlStyle } from '@/components/FilterBar';
import { modalActionsRowStyle } from '@/components/formChrome';

/**
 * #2004: Import Professional Services — pick Base Professional Services (the
 * platform's `gym_id IS NULL` rows) and create them as this gym's own in one
 * request (`POST /professional-services/import`). Same shape as the Products and
 * Exercises import modals: server-side filter, selection keyed by id and kept
 * across filter changes, already-imported rows shown and not selectable.
 */

export interface BaseServiceOption {
  id: number;
  name: string;
  description: string | null;
  max_capacity: number | null;
  imported: boolean;
  imported_professional_service_id: number | null;
}

export interface ImportServicesResult {
  imported: number[];
  skipped: number[];
}

interface Props {
  open: boolean;
  onCancel: () => void;
  /** Called after a successful import so the page can refresh and toast. */
  onImported: (result: ImportServicesResult) => void;
}

export function ImportProfessionalServicesModal({ open, onCancel, onImported }: Props) {
  const t = useTranslations('professional_services');
  const { apiFetch } = useApiClient();

  const [q, setQ] = useState('');
  const [rows, setRows] = useState<BaseServiceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A slow unfiltered response must not land after a faster filtered one.
  const loadSeq = useRef(0);

  const load = useCallback(async (query: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set('q', query.trim());
      const qs = params.toString();
      const result = await apiFetch<BaseServiceOption[]>(`/professional-services/base${qs ? `?${qs}` : ''}`);
      if (seq !== loadSeq.current) return;
      setRows(result);
      setError(null);
    } catch (err: any) {
      if (seq !== loadSeq.current) return;
      setRows([]);
      setError(err.message ?? t('error_generic'));
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [apiFetch, t]);

  // Opening starts from a fresh selection and no filter.
  useEffect(() => {
    if (!open) return;
    setQ('');
    setSelected(new Set());
    setError(null);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => load(q), 250);
    return () => clearTimeout(timer);
  }, [open, q, load]);

  if (!open) return null;

  const importable = rows.filter((r) => !r.imported);
  const allMatchingSelected = importable.length > 0 && importable.every((r) => selected.has(r.id));

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function toggleAllMatching() {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const row of importable) {
        if (allMatchingSelected) next.delete(row.id); else next.add(row.id);
      }
      return next;
    });
  }

  async function handleImport() {
    if (importing || selected.size === 0) return;
    setImporting(true);
    setError(null);
    try {
      const result = await apiFetch<ImportServicesResult>('/professional-services/import', {
        method: 'POST',
        body: JSON.stringify({ base_professional_service_ids: Array.from(selected) }),
      });
      onImported(result);
    } catch (err: any) {
      // An API error keeps the modal open with the selection intact.
      setError(err.message ?? t('error_generic'));
    } finally {
      setImporting(false);
    }
  }

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget && !importing) onCancel(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: 60,
      }}
    >
      <div style={{
        background: 'var(--gd-card-bg, #ffffff)', borderRadius: 12,
        width: '100%', maxWidth: 640, maxHeight: '80vh',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 22px 12px' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('import_modal_title')}</h2>
        </div>

        <div style={{ padding: '0 22px 10px' }}>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('search_placeholder')}
            aria-label={t('search_placeholder')}
            style={{ ...filterControlStyle, width: '100%', boxSizing: 'border-box' }}
            autoFocus
          />
        </div>

        <div style={{ padding: '0 22px 10px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={toggleAllMatching}
            disabled={importable.length === 0 || importing}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: importable.length === 0 ? 'not-allowed' : 'pointer',
              color: 'var(--gd-link, var(--brand, #6c63ff))', fontSize: 13, fontWeight: 600,
              opacity: importable.length === 0 ? 0.45 : 1,
            }}
          >
            {allMatchingSelected ? t('import_clear_all_matching') : t('import_select_all_matching')}
          </button>
          <span style={{ fontSize: 13, color: '#777' }}>{t('import_available_count', { n: importable.length })}</span>
          <span style={{ fontSize: 13, color: '#777' }}>{t('import_selected_count', { n: selected.size })}</span>
        </div>

        <div style={{ overflowY: 'auto', padding: '0 22px', flex: 1 }}>
          {loading && <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>}
          {!loading && rows.length === 0 && <p style={{ color: '#888', fontSize: 14 }}>{t('import_empty')}</p>}
          {!loading && rows.map((row) => (
            <label
              key={row.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
                borderBottom: '1px solid var(--gd-card-border, #eee)',
                cursor: row.imported ? 'default' : 'pointer',
                opacity: row.imported ? 0.6 : 1,
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(row.id)}
                disabled={row.imported || importing}
                onChange={() => toggle(row.id)}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontSize: 14, fontWeight: 500 }}>{row.name}</span>
                {row.description && <span style={{ display: 'block', fontSize: 12.5, color: '#888' }}>{row.description}</span>}
              </span>
              {row.imported && (
                <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#e8f4fd', color: '#1a6da8' }}>
                  {t('import_already_imported')}
                </span>
              )}
            </label>
          ))}
        </div>

        {error && <p style={{ color: '#c0392b', margin: 0, padding: '10px 22px 0', fontSize: 14 }}>{error}</p>}

        <div style={{ ...modalActionsRowStyle, padding: '16px 22px 20px' }}>
          <button
            onClick={onCancel}
            disabled={importing}
            style={{ ...btnStyle('#444'), opacity: importing ? 0.45 : 1, cursor: importing ? 'not-allowed' : 'pointer' }}
          >
            {t('cancel')}
          </button>
          <button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            style={{ ...primaryBtnStyle(), opacity: importing || selected.size === 0 ? 0.45 : 1 }}
          >
            {importing ? t('import_importing') : t('import_confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
