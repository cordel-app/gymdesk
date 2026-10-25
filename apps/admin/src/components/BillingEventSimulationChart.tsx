'use client';

// #1808 — the interactive chart under a Billing Event Simulation: one point per
// billing date (that date's total, as the server reported it) and a detail table
// for the date the viewer selected. It derives everything from the simulation
// already loaded — no endpoint, no pricing, nothing persisted — and reuses the
// simulation's own line table for the detail.

import React, { useMemo, useState } from 'react';
import { LineChart } from '@gymdesk/charts';

import { BillingEventTable, fmtMoney } from './BillingEventSimulation';
import { innerCardStyle } from './formChrome';
import {
  type BillingEventSimulationData,
  billingDateAtX,
  billingEventChartPoints,
  fillMissingMonths,
  billingDateToX,
  selectedBillingGroup,
  visibleBillingDates,
} from '@/lib/billingEventSimulation';

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function BillingEventSimulationChart({
  simulation, t, formatDate, showZero = false, continuousMonths = false,
}: {
  simulation: BillingEventSimulationData | null | undefined;
  t: Translate;
  formatDate: (date: string) => string;
  /** #1810 — the host's "Show €0 billing events" choice. */
  showZero?: boolean;
  /** #2090 — draw every calendar month, a month with nothing due as an explicit 0. */
  continuousMonths?: boolean;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const dates = useMemo(
    () => visibleBillingDates(simulation?.dates ?? [], showZero),
    [simulation, showZero],
  );
  const points = useMemo(
    () => {
      const total = (value: string) => t('chart_total', { total: value });
      const base = billingEventChartPoints(
      dates, formatDate, fmtMoney, undefined,
      total,
      (line) => (line.proration
        ? t('simulation_prorated', { days: line.proration.prorated_days, period: line.proration.period_days })
        : null),
      );
      return continuousMonths ? fillMissingMonths(base, formatDate, fmtMoney, total) : base;
    },
    // formatDate is a new closure per render; the dates decide the points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dates, continuousMonths],
  );
  const group = selectedBillingGroup(dates, selected);

  if (!simulation?.available || points.length === 0) {
    return <p style={hint}>{t('chart_empty')}</p>;
  }

  return (
    <div>
      <LineChart
        points={points.map((p) => ({ x: p.x, y: p.y, label: p.label, valueLabel: p.valueLabel, detailLines: p.detailLines }))}
        height={240}
        ariaLabel={t('chart_aria')}
        xAxisType="time"
        zoom={false}
        axisLabelFormatter={(x) => {
          const point = points.find((p) => p.x === x);
          return point ? point.label : '';
        }}
        selectedX={group ? billingDateToX(group.date) : null}
        onPointClick={(x) => setSelected(billingDateAtX(points, x))}
      />
      {group ? (
        <div style={detailCard}>
          <p style={detailTitle}>
            {t('chart_selected', { date: formatDate(group.date), total: fmtMoney(group.total) })}
          </p>
          {group.lines.length > 0
            ? <BillingEventTable group={group} t={t} formatDate={formatDate} />
            : <p style={hint}>{t('chart_no_lines')}</p>}
        </div>
      ) : (
        <p style={hint}>{t('chart_select_hint')}</p>
      )}
    </div>
  );
}

const hint: React.CSSProperties = { color: '#888', fontSize: 13, margin: '6px 0 0' };
const detailCard: React.CSSProperties = { ...innerCardStyle, padding: 8, marginTop: 8 };
const detailTitle: React.CSSProperties = { margin: '0 0 6px', fontSize: 13, fontWeight: 600 };
