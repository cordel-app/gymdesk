'use client';

import { useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { apiErrorMessage, useApiClient } from '@/lib/apiClient';
import { useGym } from '@/context/GymContext';
import { cardSurfaceStyle, primaryActionColors, primaryBtnStyle } from '@/components/ui';
import {
  alertTextColor,
  cardHintStyle,
  cardSectionLabelStyle,
  formCheckboxLabelStyle,
  formErrorStyle,
  secondaryBtnStyle,
} from '@/components/formChrome';
import {
  type ArchiveEntity,
  type CollectedEntity,
  type ExportRecord,
  type TransferSummary,
  archiveFileName,
  buildArchive,
  emptySummary,
  imageExtensionFromUrl,
  imageSlotsToCollect,
  importPayload,
  progressPercent,
  readArchive,
  recordOutcome,
  stepsForEntities,
  transferTypeLabelKey,
} from '@/lib/entityTransfer';

type Operation = 'export' | 'import';

interface Progress {
  operation: Operation;
  done: number;
  total: number;
  finished: boolean;
}

/**
 * #2952 — Cordel → Export / Import. The selected entity types are exported into a
 * ZIP (one JSON per entity plus its images) or imported from one: each entity is
 * created or updated by its slug through `/platform/transfer`, one at a time, so
 * the progress bar moves as they are processed and a failed entity never stops
 * the rest. What the archive holds and how it is read is `lib/entityTransfer.ts`.
 */
export default function CordelTransferPage() {
  const t = useTranslations('transfer');
  const locale = useLocale();
  const router = useRouter();
  const { apiFetch, pdfFetch, uploadFetch } = useApiClient();
  const { isSuperadmin, loading: gymLoading } = useGym();

  const [types, setTypes] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [summary, setSummary] = useState<TransferSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!gymLoading && !isSuperadmin) router.replace(`/${locale}`);
  }, [gymLoading, isSuperadmin]);

  useEffect(() => {
    if (gymLoading || !isSuperadmin) return;
    (async () => {
      try {
        const res = (await apiFetch('/platform/transfer/types')) as { types: string[] };
        setTypes(res.types);
      } catch {
        setLoadError(true);
      }
    })();
  }, [gymLoading, isSuperadmin]);

  if (gymLoading || !isSuperadmin) return null;

  const busy = progress !== null && !progress.finished;
  const chosen = (types ?? []).filter((type) => selected.has(type));

  function typeLabel(type: string): string {
    const key = transferTypeLabelKey(type);
    return key ? t(key) : type;
  }

  function toggle(type: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type); else next.add(type);
      return next;
    });
  }

  function start(operation: Operation): void {
    setError(null);
    setSummary(null);
    setProgress({ operation, done: 0, total: 0, finished: false });
  }

  function advance(steps = 1): void {
    setProgress((p) => (p ? { ...p, done: p.done + steps } : p));
  }

  async function runExport() {
    if (!chosen.length) return;
    start('export');
    let result = emptySummary();
    try {
      const lists: { type: string; records: ExportRecord[] }[] = [];
      for (const type of chosen) {
        const res = (await apiFetch(`/platform/transfer/${type}`)) as { entities: ExportRecord[] };
        lists.push({ type, records: res.entities });
      }
      const total = lists.reduce((n, l) => n + stepsForEntities(l.records), 0);
      setProgress((p) => (p ? { ...p, total } : p));

      const collected: CollectedEntity[] = [];
      for (const { type, records } of lists) {
        for (const record of records) {
          const entity: CollectedEntity = { type, record, images: {} };
          let failure: string | null = null;
          advance();
          for (const { slot, url } of imageSlotsToCollect(record)) {
            if (failure) { advance(); continue; }
            try {
              const blob = await pdfFetch(`/platform/transfer/object?url=${encodeURIComponent(url)}`);
              entity.images[slot] = { bytes: new Uint8Array(await blob.arrayBuffer()), extension: imageExtensionFromUrl(url) };
            } catch (err: any) {
              failure = t('image_failed', { slot, message: apiErrorMessage(err) ?? t('unknown_error') });
            }
            advance();
          }
          // An entity whose image could not be read is left out of the archive, so
          // an import of it can never strip an image the source still holds.
          if (!failure) collected.push(entity);
          result = recordOutcome(result, { type, slug: record.slug, error: failure });
        }
      }

      const zip = buildArchive(chosen, collected, new Date());
      const url = URL.createObjectURL(new Blob([zip.slice()], { type: 'application/zip' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = archiveFileName(new Date());
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err: any) {
      setError(apiErrorMessage(err) ?? t('unknown_error'));
    } finally {
      setSummary(result);
      setProgress((p) => (p ? { ...p, done: p.total, finished: true } : p));
    }
  }

  async function importEntity(entity: ArchiveEntity): Promise<string | null> {
    const slots = Object.keys(entity.images);
    try {
      await apiFetch(`/platform/transfer/${entity.type}`, { method: 'POST', body: JSON.stringify(importPayload(entity)) });
    } catch (err: any) {
      advance(1 + slots.length);
      return apiErrorMessage(err) ?? t('unknown_error');
    }
    advance();
    let failure: string | null = null;
    for (const slot of slots) {
      if (failure) { advance(); continue; }
      const image = entity.images[slot];
      try {
        await uploadFetch(
          `/platform/transfer/${entity.type}/${encodeURIComponent(entity.slug)}/image/${encodeURIComponent(slot)}`,
          new Blob([image.bytes.slice()], { type: image.mime }),
        );
      } catch (err: any) {
        failure = t('image_failed', { slot, message: apiErrorMessage(err) ?? t('unknown_error') });
      }
      advance();
    }
    return failure;
  }

  async function runImport() {
    if (!chosen.length || !file) return;
    start('import');
    let result = emptySummary();
    try {
      const { entities, problems } = readArchive(new Uint8Array(await file.arrayBuffer()), chosen);
      setProgress((p) => (p ? { ...p, total: stepsForEntities(entities) } : p));
      for (const problem of problems) {
        result = recordOutcome(result, { type: '', slug: problem.path, error: t(`archive_${problem.message}`) });
      }
      for (const entity of entities) {
        const failure = await importEntity(entity);
        result = recordOutcome(result, { type: entity.type, slug: entity.slug, error: failure });
      }
    } catch (err: any) {
      setError(apiErrorMessage(err) ?? t('unknown_error'));
    } finally {
      setSummary(result);
      setProgress((p) => (p ? { ...p, done: p.total, finished: true } : p));
    }
  }

  const percent = progress ? (progress.finished ? 100 : progressPercent(progress.done, progress.total)) : 0;

  return (
    <div>
      <h1 style={{ margin: '0 0 6px' }}>{t('title')}</h1>
      <p style={{ margin: '0 0 16px', color: '#666', maxWidth: 720 }}>{t('intro')}</p>

      {progress && (
        <div style={{ ...cardSurfaceStyle, padding: 16, marginBottom: 16 }} aria-live="polite">
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8, fontSize: 14 }}>
            <span>
              {progress.finished
                ? t(progress.operation === 'export' ? 'export_finished' : 'import_finished')
                : t(progress.operation === 'export' ? 'exporting' : 'importing')}
            </span>
            <span>{percent}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
            aria-label={t(progress.operation === 'export' ? 'exporting' : 'importing')}
            style={{ height: 8, borderRadius: 4, background: 'var(--gd-input-border, #d1d5db)', overflow: 'hidden' }}
          >
            <div style={{ width: `${percent}%`, height: '100%', background: primaryActionColors.background, transition: 'width 0.2s' }} />
          </div>
          {summary && (
            <div style={{ marginTop: 12, fontSize: 14 }}>
              <div>
                {t('summary_total', { count: summary.total })}
                {' · '}
                <span>{t('summary_succeeded', { count: summary.succeeded })}</span>
                {' · '}
                <span style={summary.failed ? { color: alertTextColor, fontWeight: 600 } : undefined}>
                  {t('summary_failed', { count: summary.failed })}
                </span>
              </div>
              {summary.failures.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 20, color: alertTextColor }}>
                  {summary.failures.map((f, i) => (
                    <li key={`${f.type}-${f.slug}-${i}`}>
                      <strong>{f.type ? `${typeLabel(f.type)} · ${f.slug}` : f.slug}</strong>: {f.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {error && <div style={{ ...formErrorStyle, marginTop: 8 }}>{error}</div>}
        </div>
      )}

      <div style={{ ...cardSurfaceStyle, padding: 16 }}>
        <div style={cardSectionLabelStyle}>{t('entity_types')}</div>
        {loadError && <div style={formErrorStyle}>{t('load_failed')}</div>}
        {types && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, margin: '8px 0 16px' }}>
            {types.map((type) => (
              <label key={type} style={formCheckboxLabelStyle}>
                <input type="checkbox" checked={selected.has(type)} disabled={busy} onChange={() => toggle(type)} />
                {typeLabel(type)}
              </label>
            ))}
          </div>
        )}
        <p style={{ ...cardHintStyle, margin: '0 0 16px' }}>{t('import_hint')}</p>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
          <button
            type="button"
            style={{ ...primaryBtnStyle(), opacity: busy || !chosen.length ? 0.5 : 1 }}
            disabled={busy || !chosen.length}
            onClick={runExport}
          >
            {t('export')}
          </button>
          <input
            ref={fileInput}
            type="file"
            accept=".zip,application/zip"
            style={{ display: 'none' }}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <button type="button" style={secondaryBtnStyle} disabled={busy} onClick={() => fileInput.current?.click()}>
            {t('choose_file')}
          </button>
          <span style={{ fontSize: 13, color: '#666' }}>{file ? file.name : t('no_file')}</span>
          <button
            type="button"
            style={{ ...primaryBtnStyle(), opacity: busy || !chosen.length || !file ? 0.5 : 1 }}
            disabled={busy || !chosen.length || !file}
            onClick={runImport}
          >
            {t('import')}
          </button>
        </div>
      </div>
    </div>
  );
}
