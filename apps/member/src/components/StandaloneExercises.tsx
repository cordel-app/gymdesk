'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useApiClient } from '@/lib/apiClient';
import { MemberDialog } from '@/components/MemberDialog';
import { ExerciseMedia } from '@/components/ExerciseMedia';
import {
  inputStyle, memberTheme, noticeStyle, primaryButtonStyle, secondaryButtonStyle,
} from '@/lib/memberChrome';

interface CatalogueExercise {
  id: number; name: string; image_thumbnail_url: string | null; primary_muscle: string | null;
}
interface LoggedSet { id: number; set_number: number; weight: number | string | null; reps: number | null }
interface StandaloneExercise {
  id: number; exercise_id: number; exercise_name: string; image_url?: string | null; image_thumbnail_url: string | null; primary_muscle: string | null;
  logs: { id: number; sets: LoggedSet[] | null }[];
}

/** `quads` / `lower_back` → `Quads` / `Lower back`; the muscle slug has no Members App label. */
function muscleLabel(slug: string | null): string | null {
  if (!slug) return null;
  const s = slug.replace(/[_-]+/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : null;
}

/**
 * #1916 — the **Add Exercise** section at the bottom of My Training: extra
 * exercises a member adds to the selected day without touching their plan, and
 * Register (weight × reps per set) through the ordinary exercise-log model.
 * It decides nothing about eligibility: the API validates the exercise and the
 * day, and a duplicate answers 409.
 */
export function StandaloneExercises({ date }: { date: string }) {
  const t = useTranslations('training');
  const { apiFetch } = useApiClient();
  const [items, setItems] = useState<StandaloneExercise[]>([]);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState('');
  const [catalogue, setCatalogue] = useState<CatalogueExercise[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [draft, setDraft] = useState({ weight: '', reps: '' });
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setItems(await apiFetch<StandaloneExercise[]>(`/me/standalone-exercises?date=${date}`)); }
    catch (err: any) { setMessage(err.message ?? null); }
  }
  useEffect(() => { setOpen(null); load(); }, [date]);

  useEffect(() => {
    if (!picking) return;
    const handle = setTimeout(async () => {
      try {
        setCatalogue(await apiFetch<CatalogueExercise[]>(`/me/standalone-exercises/catalogue?q=${encodeURIComponent(query)}`));
      } catch (err: any) { setMessage(err.message ?? null); }
    }, 200);
    return () => clearTimeout(handle);
  }, [picking, query]);

  async function add(ex: CatalogueExercise) {
    try {
      await apiFetch('/me/standalone-exercises', { method: 'POST', body: JSON.stringify({ exercise_id: ex.id, date }) });
      setPicking(false); setQuery(''); setMessage(null);
      await load();
    } catch (err: any) { setMessage(err.message ?? null); }
  }

  async function remove(item: StandaloneExercise) {
    try { await apiFetch(`/me/standalone-exercises/${item.id}`, { method: 'DELETE' }); await load(); }
    catch (err: any) { setMessage(err.message ?? null); }
  }

  async function register(item: StandaloneExercise) {
    if (saving || !draft.reps) return;
    setSaving(true);
    try {
      await apiFetch('/me/exercise-logs', {
        method: 'POST',
        body: JSON.stringify({
          standalone_exercise_id: item.id,
          logged_date: date,
          sets: [{ weight: draft.weight ? parseFloat(draft.weight) : null, reps: parseInt(draft.reps, 10) }],
        }),
      });
      setDraft({ weight: '', reps: '' });
      await load();
    } catch (err: any) { setMessage(err.message ?? null); }
    finally { setSaving(false); }
  }

  const thumb = (url: string | null, name: string) => url
    ? <img src={url} alt="" style={styles.thumb} />
    : <span aria-hidden="true" style={{ ...styles.thumb, ...styles.thumbFallback }}>{name.charAt(0).toUpperCase()}</span>;

  return (
    <section style={styles.section} aria-label={t('standalone_title')}>
      <hr style={styles.divider} />
      <h2 style={styles.title}>{t('standalone_title')}</h2>
      <p style={styles.hint}>{t('standalone_hint')}</p>
      {message && <div style={styles.message}>{message}</div>}

      {items.length === 0 && <p style={styles.hint}>{t('standalone_empty')}</p>}
      {items.map((item) => (
        <div key={item.id} style={styles.card}>
          <div style={styles.exerciseMedia}>
            <ExerciseMedia fill exercise={{
              exercise_name: item.exercise_name,
              exercise_image_url: item.image_url ?? null,
              exercise_image_thumbnail_url: item.image_thumbnail_url,
            }} />
          </div>
          <div style={styles.info}>
            <div style={styles.rowTop}>
              <span style={styles.name}>{item.exercise_name}</span>
              <span style={styles.chip}>{t('standalone_chip')}</span>
            </div>
            {muscleLabel(item.primary_muscle) && <div style={styles.meta}>{muscleLabel(item.primary_muscle)}</div>}
            {item.logs.flatMap((l) => l.sets ?? []).length > 0 && (
              <div style={styles.meta}>
                {item.logs.flatMap((l) => l.sets ?? []).map((s) => `${s.weight ?? '—'} × ${s.reps ?? '—'}`).join(' · ')}
              </div>
            )}
            {item.logs.length === 0 && (
              <button type="button" onClick={() => remove(item)} style={styles.linkBtn}>{t('standalone_remove')}</button>
            )}
          </div>
          <button type="button" aria-expanded={open === item.id}
                  onClick={() => { setOpen(open === item.id ? null : item.id); setDraft({ weight: '', reps: '' }); }}
                  style={styles.registerBtn}>
            {t('register')}
          </button>
          {open === item.id && (
            <div style={styles.entry}>
              <input type="number" min="0" step="0.5" aria-label={t('weight')} placeholder={t('weight')} value={draft.weight}
                     onChange={(e) => setDraft({ ...draft, weight: e.target.value })} style={styles.miniInput} />
              <input type="number" min="0" aria-label={t('reps')} placeholder={t('reps')} value={draft.reps}
                     onChange={(e) => setDraft({ ...draft, reps: e.target.value })}
                     onKeyDown={(e) => { if (e.key === 'Enter') register(item); }} style={styles.miniInput} />
              <button type="button" aria-label={t('add_log')} onClick={() => register(item)}
                      disabled={saving || !draft.reps} style={styles.addBtn}>+</button>
            </div>
          )}
        </div>
      ))}

      <button type="button" onClick={() => { setPicking(true); setMessage(null); }} style={styles.addExerciseBtn}>
        {t('standalone_add')}
      </button>

      {picking && (
        <MemberDialog title={t('standalone_title')} onClose={() => setPicking(false)} labelledBy="standalone-picker-title"
          actions={<button type="button" onClick={() => setPicking(false)} style={styles.closeBtn}>{t('standalone_close')}</button>}>
          <input type="search" aria-label={t('standalone_search')} placeholder={t('standalone_search')} value={query}
                 onChange={(e) => setQuery(e.target.value)} style={{ ...inputStyle, width: '100%', boxSizing: 'border-box', marginBottom: 8 }} />
          {catalogue.length === 0 && <p style={styles.hint}>{t('standalone_none')}</p>}
          {catalogue.map((ex) => (
            <button key={ex.id} type="button" onClick={() => add(ex)} style={styles.pickRow}>
              {thumb(ex.image_thumbnail_url, ex.name)}
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <span style={styles.name}>{ex.name}</span>
                {muscleLabel(ex.primary_muscle) && <span style={{ ...styles.meta, display: 'block' }}>{muscleLabel(ex.primary_muscle)}</span>}
              </span>
            </button>
          ))}
        </MemberDialog>
      )}
    </section>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: { marginTop: 8, marginBottom: 24 },
  divider: { border: 'none', borderTop: `1px solid ${memberTheme.separator}`, margin: '8px 0 16px' },
  title: { margin: 0, fontSize: 17, fontWeight: 700, color: memberTheme.title2, fontFamily: memberTheme.title2Font },
  hint: { color: memberTheme.textMuted, fontSize: 13, margin: '4px 0 12px' },
  message: { ...noticeStyle('error'), marginBottom: 12 },
  card: { marginTop: 8, marginBottom: 10, padding: 0, overflow: 'hidden', borderRadius: 12, border: `1px solid ${memberTheme.separator}`, background: memberTheme.surface },
  exerciseMedia: { display: 'block', width: '100%' },
  info: { display: 'flex', flexDirection: 'column', gap: 2, padding: '8px 12px 0' },
  rowTop: { display: 'flex', alignItems: 'center', gap: 8 },
  thumb: { width: 48, height: 48, borderRadius: 8, objectFit: 'cover', flex: '0 0 auto', background: memberTheme.pageBackground },
  thumbFallback: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: memberTheme.textMuted, fontWeight: 700 },
  name: { fontSize: 15, fontWeight: 600, color: memberTheme.text },
  meta: { fontSize: 12, color: memberTheme.textMuted, marginTop: 2 },
  chip: { marginLeft: 6, fontSize: 10, fontWeight: 600, borderRadius: 999, padding: '1px 6px', color: memberTheme.title2, background: `color-mix(in srgb, ${memberTheme.title2} 12%, ${memberTheme.surface})` },
  linkBtn: { ...secondaryButtonStyle, alignSelf: 'flex-start', marginTop: 6, padding: '6px 10px', borderRadius: 6, fontSize: 12 },
  registerBtn: { ...primaryButtonStyle, display: 'block', boxSizing: 'border-box', margin: '8px 12px 12px', width: 'calc(100% - 24px)', padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600 },
  entry: { display: 'flex', gap: 8, alignItems: 'center', margin: '0 12px 12px' },
  miniInput: { ...inputStyle, width: 80, minWidth: 0, boxSizing: 'border-box', padding: '6px 8px', borderRadius: 4, fontSize: 14 },
  addBtn: { ...secondaryButtonStyle, padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 },
  addExerciseBtn: { ...primaryButtonStyle, display: 'block', width: '100%', boxSizing: 'border-box', padding: '10px 14px', borderRadius: 8, fontSize: 14, fontWeight: 600 },
  closeBtn: { ...secondaryButtonStyle, padding: '8px 14px', borderRadius: 6, fontSize: 13, fontWeight: 600 },
  pickRow: { display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '8px 0', background: 'none', border: 'none', borderTop: `1px solid ${memberTheme.separator}`, cursor: 'pointer', color: memberTheme.text },
};
