'use client';

// #3311 — **Payments History and Forecast**, at the top of the Member card's
// Payments tab: the member's payments, their scheduled Billing Events and the
// engine's forecast on one month-labelled timeline, with a Today marker. It reads
// `GET /payments/members/:id/timeline` (which decides every point) and writes
// nothing; selecting a point lists what stands on that date, as the Billing
// Event Simulation chart does (#1808). Since #3311 stage 4 it is one continuous
// line in one theme colour; each point's marker and status say what it is.

import React, { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { LineChart } from '@gymdesk/charts';
import { useApiClient } from '@/lib/apiClient';
import { useGymFormatSettings } from '@/lib/useGymFormatSettings';
import { formatGymAmount, formatGymDateOnly } from '@/lib/gymFormat';
import { cardMutedTextStyle, cardSectionLabelStyle, formErrorStyle, innerCardStyle } from '@/components/formChrome';
import {
  MONTH_TICK_MS, type PaymentsTimeline, type TimelinePoint, type TimelinePointKind,
  dateToX, knownStatusKey, monthTickLabel, pointsAtX, timelineSeries,
} from './paymentsTimelineView';

export function PaymentsTimelineChart({ memberId, reloadKey }: { memberId: number | string; reloadKey?: unknown }) {
  const t = useTranslations('members');
  const { apiFetch } = useApiClient();
  const gym = useGymFormatSettings();
  const [timeline, setTimeline] = useState<PaymentsTimeline | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    apiFetch<PaymentsTimeline>(`/payments/members/${memberId}/timeline`)
      .then((r) => { setTimeline(r); setFailed(false); })
      .catch(() => setFailed(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, reloadKey]);

  const kindLabel = (kind: TimelinePointKind) => t(`timeline_kind_${kind}`);
  const statusLabel = (p: TimelinePoint) => t(knownStatusKey(p));
  const money = (n: number) => formatGymAmount(n, gym);
  const date = (d: string) => formatGymDateOnly(d, gym);

  const series = useMemo(
    () => (timeline ? timelineSeries(timeline, { date, money, status: statusLabel }) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline, gym],
  );
  const selectedPoints = timeline ? pointsAtX(timeline, selected) : [];

  return (
    <div>
      <p style={cardSectionLabelStyle}>{t('timeline_title')}</p>
      {failed ? <p style={formErrorStyle}>{t('timeline_error')}</p>
        : !timeline ? <p style={cardMutedTextStyle}>{t('timeline_loading')}</p>
        : timeline.points.length === 0 ? <p style={cardMutedTextStyle}>{t('timeline_empty')}</p>
        : (
          <>
            <LineChart
              series={series}
              height={300}
              ariaLabel={t('timeline_title')}
              xAxisType="time"
              zoom={false}
              xMinInterval={MONTH_TICK_MS}
              axisLabelFormatter={(x) => monthTickLabel(x, gym)}
              xMarker={{ value: dateToX(timeline.today), label: t('timeline_today') }}
              selectedX={selected}
              onPointClick={(x) => setSelected(x)}
            />
            {selectedPoints.length > 0 ? (
              <div style={detailCard}>
                {selectedPoints.map((p, i) => (
                  <div key={`${p.kind}-${p.billing_event_id ?? i}`} style={i > 0 ? { marginTop: 8 } : undefined}>
                    <p style={detailTitle}>
                      {t('timeline_detail', { date: date(p.date), amount: money(p.amount) })}
                    </p>
                    <p style={detailMeta}>
                      {p.billing_event_id != null ? `${kindLabel(p.kind)} · ` : ''}{statusLabel(p)}{p.name ? ` · ${p.name}` : ''}
                      {p.billing_event_id != null ? ` · #${p.billing_event_id}` : ''}
                    </p>
                    {p.lines.length > 0 ? (
                      <ul style={lineList}>
                        {p.lines.map((l, j) => <li key={j}>{l.label} × {l.quantity}: {money(l.amount)}</li>)}
                      </ul>
                    ) : <p style={cardMutedTextStyle}>{t('timeline_no_lines')}</p>}
                  </div>
                ))}
              </div>
            ) : <p style={cardMutedTextStyle}>{t('timeline_select_hint')}</p>}
          </>
        )}
    </div>
  );
}

const detailCard: React.CSSProperties = { ...innerCardStyle, padding: 8, marginTop: 8 };
const detailTitle: React.CSSProperties = { margin: '0 0 2px', fontSize: 13, fontWeight: 600 };
const detailMeta: React.CSSProperties = { margin: '0 0 4px', fontSize: 12 };
const lineList: React.CSSProperties = { margin: 0, paddingLeft: 18, fontSize: 12 };
