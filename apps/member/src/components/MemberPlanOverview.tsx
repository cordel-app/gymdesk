'use client';

import { useState, type CSSProperties } from 'react';
import { memberTheme } from '@/lib/memberChrome';
import { ImagePreviewButton } from './ImagePreview';

/**
 * #2426 — the body of an **Add Plan** card beyond its name and price: Billing &
 * Duration, the Products the plan carries, the pre-paid commitment end, the
 * Initial Payment and the two-cycle Billing Event Simulation (collapsed until
 * asked for). Like `MemberPlanCatalogue` it resolves nothing: every string
 * arrives translated and every figure formatted by the page, which got them
 * from the server's engine (`memberPlanOverview.ts` on the API), so it calls
 * no `t()`, computes no money and spells no colour (#983).
 */

export interface PlanOverviewProduct {
  key: string;
  name: string;
  /** *Mandatory* / *Optional*. */
  requirement: string;
  /** *2 × · Monthly* — quantity and frequency, pre-composed. */
  detail: string;
  regularLabel: string;
  regular: string;
  /** The benefit applied, or *No benefit*. */
  benefit: string;
  finalLabel: string;
  final: string;
  /** #2495 — circular thumbnail; `null` draws the placeholder. */
  imageUrl?: string | null;
  imageFullUrl?: string | null;
  /** #2495 — the optional Product's own checkbox; absent for a mandatory one. */
  checkbox?: { checked: boolean; label: string; onToggle: () => void } | null;
  /** #2495 — un-ticked: shown struck through, charged nowhere. */
  declined?: boolean;
  placeholder?: string;
}

export interface PlanOverviewSimulationDate {
  key: string;
  date: string;
  total: string;
  lines: { key: string; label: string; amount: string; note?: string | null }[];
}

export interface PlanOverviewView {
  durationHeading: string;
  durationRows: { label: string; value: string }[];
  productsHeading: string;
  products: PlanOverviewProduct[];
  prepaid?: { label: string; value: string } | null;
  initial?: { label: string; value: string } | null;
  simulationHeading: string;
  simulationToggleLabel: string;
  simulation: PlanOverviewSimulationDate[];
}

export function MemberPlanOverview({ view }: { view: PlanOverviewView }) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  return (
    <div>
      <div style={styles.block}>
        <span style={styles.heading}>{view.durationHeading}</span>
        {view.durationRows.map((r) => (
          <div key={r.label} style={styles.row}><span style={styles.muted}>{r.label}</span><span>{r.value}</span></div>
        ))}
      </div>
      {view.products.length > 0 && (
        <div style={styles.block}>
          <span style={styles.heading}>{view.productsHeading}</span>
          {view.products.map((p) => (
            <div key={p.key} style={styles.productRow}>
              <span style={styles.thumb}>
                {p.imageUrl ? (
                  <ImagePreviewButton src={p.imageFullUrl ?? p.imageUrl} alt={p.name} title={p.name}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.imageUrl} alt={p.name} style={styles.thumbImg} />
                  </ImagePreviewButton>
                ) : <span style={styles.thumbPlaceholder} aria-hidden="true" title={p.placeholder} />}
              </span>
              <div style={{ ...styles.product, flex: 1, minWidth: 0, ...(p.declined ? styles.struck : null) }}>
                <div style={styles.row}>
                  <span style={styles.strong}>{p.name}</span>
                  <span style={styles.muted}>{p.requirement}</span>
                </div>
                {p.checkbox && (
                  <label style={styles.checkRow} onClick={(e) => e.stopPropagation()}>
                    <input type="checkbox" checked={p.checkbox.checked} onChange={p.checkbox.onToggle} />
                    <span style={{ textDecoration: 'none' }}>{p.checkbox.label}</span>
                  </label>
                )}
                <span style={styles.muted}>{p.detail}</span>
                <div style={styles.row}><span style={styles.muted}>{p.regularLabel}</span><span>{p.regular}</span></div>
                <div style={styles.row}><span style={styles.muted}>{p.benefit}</span></div>
                <div style={styles.row}><span style={styles.muted}>{p.finalLabel}</span><span style={styles.strong}>{p.final}</span></div>
              </div>
            </div>
          ))}
        </div>
      )}
      {view.prepaid && (
        <div style={styles.block}>
          <div style={styles.row}><span style={styles.muted}>{view.prepaid.label}</span><span>{view.prepaid.value}</span></div>
        </div>
      )}
      {view.initial && (
        <div style={styles.block}>
          <div style={styles.row}><span style={styles.heading}>{view.initial.label}</span><span style={styles.strong}>{view.initial.value}</span></div>
        </div>
      )}
      {view.simulation.length > 0 && (
        <div style={styles.block}>
          <button type="button" style={styles.toggle} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? '▾' : '▸'} {view.simulationToggleLabel}
          </button>
          {open && view.simulation.map((d) => (
            <div key={d.key} style={styles.product}>
              <button
                type="button" style={styles.toggle} aria-expanded={!!expanded[d.key]}
                onClick={() => setExpanded((s) => ({ ...s, [d.key]: !s[d.key] }))}
              >
                <span>{expanded[d.key] ? '▾' : '▸'} {d.date}</span><span style={styles.strong}>{d.total}</span>
              </button>
              {expanded[d.key] && d.lines.map((l) => (
                <div key={l.key} style={styles.row}>
                  <span style={styles.muted}>{l.label}{l.note ? ` · ${l.note}` : ''}</span><span>{l.amount}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  block: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${memberTheme.separator}`, fontSize: 13, color: memberTheme.text },
  heading: { fontSize: 11, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: memberTheme.textMuted },
  row: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
  product: { display: 'flex', flexDirection: 'column', gap: 2, padding: '6px 0' },
  productRow: { display: 'flex', alignItems: 'flex-start', gap: 10 },
  thumb: { width: 40, height: 40, flexShrink: 0, borderRadius: '50%', overflow: 'hidden', display: 'block', marginTop: 6 },
  thumbImg: { width: 40, height: 40, objectFit: 'contain', borderRadius: '50%', display: 'block', background: memberTheme.surface },
  thumbPlaceholder: { display: 'block', width: 40, height: 40, borderRadius: '50%', background: memberTheme.separator },
  struck: { textDecoration: 'line-through', opacity: 0.6 },
  checkRow: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: memberTheme.text },
  muted: { color: memberTheme.textSecondary },
  strong: { fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  toggle: { display: 'flex', justifyContent: 'space-between', gap: 10, width: '100%', background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontSize: 13, color: memberTheme.text, textAlign: 'left' },
};
