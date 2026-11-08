'use client';

// #2470 — the Billing Event Simulation section, one layout for every host:
// the chart directly under the section heading and the "Billing Simulation
// Details" collapsible (collapsed by default) right below it. The chart and the
// details read the same simulation and share the "Show €0 billing events"
// choice; nothing is recomputed or fetched here.

import React, { ReactNode, useState } from 'react';

import { BillingEventSimulation } from './BillingEventSimulation';
import { BillingEventSimulationChart } from './BillingEventSimulationChart';
import { CardSectionHeader } from './CardSectionHeader';
import type { BillingEventSimulationData } from '@/lib/billingEventSimulation';

type Translate = (key: string, values?: Record<string, string | number>) => string;

export function BillingEventSimulationPanel({
  simulation, chartSimulation, t, formatDate, cycleNote, zeroToggle, chartShowZero, continuousMonths,
  detailsTitle,
}: {
  simulation: BillingEventSimulationData | null | undefined;
  /** The unfiltered simulation the chart plots, when the host filters the details. */
  chartSimulation?: BillingEventSimulationData | null;
  t: Translate;
  formatDate: (date: string) => string;
  cycleNote?: ReactNode;
  /** Offer the €0 toggle inside the details (it also drives the chart). */
  zeroToggle?: boolean;
  /** A host that always plots every period passes `true`; omitted, the toggle decides. */
  chartShowZero?: boolean;
  continuousMonths?: boolean;
  /** The details heading, already worded by the host. */
  detailsTitle: string;
}) {
  const [showZero, setShowZero] = useState(false);
  const [open, setOpen] = useState(false);
  return (
    <div>
      <BillingEventSimulationChart
        simulation={chartSimulation ?? simulation}
        showZero={chartShowZero ?? showZero}
        continuousMonths={continuousMonths}
        t={t}
        formatDate={formatDate}
      />
      <div style={{ marginTop: 12 }}>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span aria-hidden="true" style={{ color: '#888', fontSize: 11, width: 10 }}>{open ? '▾' : '▸'}</span>
          <CardSectionHeader title={detailsTitle} />
        </button>
      </div>
      {open && (
        <BillingEventSimulation
          simulation={simulation}
          zeroToggle={zeroToggle}
          showZero={showZero}
          onShowZeroChange={setShowZero}
          cycleNote={cycleNote}
          t={t}
          formatDate={formatDate}
        />
      )}
    </div>
  );
}
