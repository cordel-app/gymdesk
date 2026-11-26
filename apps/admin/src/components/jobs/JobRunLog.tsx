'use client';

import React from 'react';
import {
  type JobRun, detailEntries, formatDuration, formatHttpStatus, issueLabelKey, jobDescriptionKey,
  metricsSummary, resultLabelKey,
} from '@/lib/jobRuns';

/**
 * The log of one job execution: its metrics, result, warnings, timing, HTTP status,
 * error and the source's own counters. #3471 promoted it out of the Log history row so
 * the Jobs tab's expanded latest run is the same view of the same record.
 */
export function JobRunLog({ run, t, started }: {
  run: JobRun; t: (k: string, v?: any) => string; started: string;
}) {
  const entries = detailEntries(run.details);
  const descKey = jobDescriptionKey(run.job);
  const resultKey = resultLabelKey(run.result);
  const summary = metricsSummary(run);
  return (
    <>
      {summary && (
        <div style={{ display: 'flex', gap: 24, margin: '4px 0 12px', flexWrap: 'wrap' }}>
          {summary.map((m) => (
            <span key={m.key}>
              <span style={{ color: '#888' }}>{t(`summary_${m.key}`)}: </span>
              <strong>{m.value}</strong>
            </span>
          ))}
        </div>
      )}
      <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', margin: 0 }}>
        {descKey && (<><dt style={{ color: '#888' }}>{t('field_purpose')}</dt><dd style={{ margin: 0 }}>{t(descKey)}</dd></>)}
        {resultKey && (<><dt style={{ color: '#888' }}>{t('field_result')}</dt><dd style={{ margin: 0 }}>{t(resultKey)}</dd></>)}
        {(run.issues ?? []).map((i) => (<React.Fragment key={`i-${i}`}><dt style={{ color: '#888' }}>{t('field_warning')}</dt><dd style={{ margin: 0, color: '#93370d' }}>{t(issueLabelKey(i))}</dd></React.Fragment>))}
        <dt style={{ color: '#888' }}>{t('field_started')}</dt><dd style={{ margin: 0 }}>{started}</dd>
        <dt style={{ color: '#888' }}>{t('field_duration')}</dt><dd style={{ margin: 0 }}>{formatDuration(run.duration_seconds)}</dd>
        <dt style={{ color: '#888' }}>{t('field_http_status')}</dt><dd style={{ margin: 0 }}>{formatHttpStatus(run.http_status)}</dd>
        {run.error_summary && (<><dt style={{ color: '#888' }}>{t('field_error')}</dt><dd style={{ margin: 0, color: '#b42318' }}>{run.error_summary}</dd></>)}
        {entries.map((e) => (<React.Fragment key={`k-${e.key}`}><dt style={{ color: '#888' }}>{e.key}</dt><dd style={{ margin: 0 }}>{e.value}</dd></React.Fragment>))}
      </dl>
    </>
  );
}
