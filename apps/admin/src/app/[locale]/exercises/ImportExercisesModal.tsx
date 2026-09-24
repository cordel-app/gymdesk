'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { btnStyle } from '@/components/ui';

/**
 * #718: Import Exercises — pick Base Exercises from the platform library and
 * import the selection in one request (`POST /exercises/import`).
 *
 * Both filters are server-side (`GET /exercises/base?q=&muscle=`), so the
 * library is never pulled into the browser to be filtered here, and
 * "Select all matching" means exactly the rows the server returned for the
 * current filters. Selection is keyed by base exercise id and lives outside
 * the fetched list, so changing a filter never drops what is already ticked.
 */

interface BaseMuscle { key: string; role: 'principal' | 'secondary' }

export interface BaseExercise {
  id: number;
  name: string;
  description: string | null;
  image_url: string | null;
  muscles: BaseMuscle[] | null;
  /** The gym's own copy, when it already has one — such a row can't be imported again. */
  imported_exercise_id: number | null;
}

interface ImportResult {
  imported: { id: number }[];
  skipped: { id: number; name: string; reason: string }[];
}

interface Props {
  open: boolean;
  /** Muscle keys of the static catalog (`GET /muscles`), for the Muscle filter. */
  muscleKeys: string[];
  muscleLabel: (key: string) => string;
  onCancel: () => void;
  /** Called after a successful import so the page can refresh and toast. */
  onImported: (result: ImportResult) => void;
}

export function ImportExercisesModal({ open, muscleKeys, muscleLabel, onCancel, onImported }: Props) {
  const t = useTranslations('exercises');
  const { apiFetch } = useApiClient();

  const [nameInput, setNameInput] = useState('');
  const [name, setName] = useState('');
  const [muscle, setMuscle] = useState('');
  const [rows, setRows] = useState<BaseExercise[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against out-of-order responses: a slow unfiltered request must not
  // land after a faster filtered one and show the wrong list (same reason as
  // ImpersonationDialog's searchSeq).
  const loadSeq = useRef(0);

  const load = useCallback(async (q: string, muscleKey: string) => {
    const seq = ++loadSeq.current;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (muscleKey) params.set('muscle', muscleKey);
      const qs = params.toString();
      const result = await apiFetch<BaseExercise[]>(`/exercises/base${qs ? `?${qs}` : ''}`);
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

  // §9: opening the modal always starts from a fresh selection and no filters.
  useEffect(() => {
    if (!open) return;
    setNameInput('');
    setName('');
    setMuscle('');
    setSelected(new Set());
    setError(null);
  }, [open]);

  // One effect drives every fetch; a typed name debounces, everything else fires at once.
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => load(name, muscle), name ? 300 : 0);
    return () => clearTimeout(timer);
  }, [open, name, muscle, load]);

  useEffect(() => {
    if (nameInput === name) return;
    const timer = setTimeout(() => setName(nameInput), 300);
    return () => clearTimeout(timer);
  }, [nameInput, name]);

  if (!open) return null;

  const importable = rows.filter((r) => r.imported_exercise_id == null);
  const allMatchingSelected = importable.length > 0 && importable.every((r) => selected.has(r.id));

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  /**
   * §6: applies to the current filtered result set only — never to rows the
   * filters exclude, and never to an exercise the gym already has. When every
   * matching row is already ticked the same control clears them again.
   */
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
      const result = await apiFetch<ImportResult>('/exercises/import', {
        method: 'POST',
        body: JSON.stringify({ baseExerciseIds: Array.from(selected) }),
      });
      onImported(result);
    } catch (err: any) {
      // §8: an API error keeps the modal open with the selection intact.
      setError(err.message ?? t('error_generic'));
    } finally {
      setImporting(false);
    }
  }

  const inputSt: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', padding: '8px 12px',
    border: '1px solid var(--gd-input-border, #d1d5db)', borderRadius: 6,
    background: 'var(--gd-input-bg, #ffffff)', fontSize: 14, color: 'inherit',
  };

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
        width: '100%', maxWidth: 560, maxHeight: '80vh',
        boxShadow: '0 8px 32px rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '18px 22px 12px' }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('import_modal_title')}</h2>
        </div>

        <div style={{ padding: '0 22px 12px', display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: '1 1 220px' }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{t('import_filter_name')}</label>
            <input
              autoFocus
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={t('import_filter_name_placeholder')}
              style={inputSt}
            />
          </div>
          <div style={{ flex: '1 1 160px' }}>
            <label style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{t('import_filter_muscle')}</label>
            <select value={muscle} onChange={(e) => setMuscle(e.target.value)} style={inputSt}>
              <option value="">{t('import_filter_muscle_all')}</option>
              {muscleKeys.map((key) => <option key={key} value={key}>{muscleLabel(key)}</option>)}
            </select>
          </div>
        </div>

        <div style={{ padding: '0 22px 10px', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button
            type="button"
            onClick={toggleAllMatching}
            disabled={importable.length === 0 || importing}
            style={{
              background: 'none', border: 'none', padding: 0, cursor: importable.length === 0 ? 'not-allowed' : 'pointer',
              color: 'var(--brand, #6c63ff)', fontSize: 13, fontWeight: 600,
              opacity: importable.length === 0 ? 0.45 : 1,
            }}
          >
            {allMatchingSelected ? t('import_clear_all_matching') : t('import_select_all_matching')}
          </button>
          <span style={{ fontSize: 13, color: '#777' }}>
            {t('import_available_count', { n: importable.length })}
          </span>
          <span style={{ fontSize: 13, color: '#777' }}>
            {t('import_selected_count', { n: selected.size })}
          </span>
        </div>

        <div style={{ overflowY: 'auto', padding: '0 22px', flex: 1 }}>
          {loading && <p style={{ color: '#888', fontSize: 14 }}>{t('loading')}</p>}
          {!loading && rows.length === 0 && (
            <p style={{ color: '#888', fontSize: 14 }}>{t('import_empty')}</p>
          )}
          {!loading && rows.map((row) => {
            const alreadyImported = row.imported_exercise_id != null;
            const principal = (row.muscles ?? []).filter((m) => m.role === 'principal').map((m) => muscleLabel(m.key)).join(', ');
            return (
              <label
                key={row.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0',
                  borderBottom: '1px solid var(--gd-card-border, #eee)',
                  cursor: alreadyImported ? 'default' : 'pointer',
                  opacity: alreadyImported ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={selected.has(row.id)}
                  disabled={alreadyImported || importing}
                  onChange={() => toggle(row.id)}
                />
                <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{row.name}</span>
                {principal && <span style={{ fontSize: 12, color: '#777' }}>{principal}</span>}
                {alreadyImported && (
                  <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 7px', borderRadius: 4, background: '#e8f4fd', color: '#1a6da8' }}>
                    {t('type_system_sourced')}
                  </span>
                )}
              </label>
            );
          })}
        </div>

        {error && <p style={{ color: '#c0392b', margin: 0, padding: '10px 22px 0', fontSize: 14 }}>{error}</p>}

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', padding: '16px 22px 20px' }}>
          <button onClick={onCancel} disabled={importing} style={btnStyle('#aaa')}>{t('cancel')}</button>
          <button
            onClick={handleImport}
            disabled={importing || selected.size === 0}
            style={{ ...btnStyle(), opacity: importing || selected.size === 0 ? 0.45 : 1 }}
          >
            {importing ? t('import_importing') : t('import')}
          </button>
        </div>
      </div>
    </div>
  );
}
