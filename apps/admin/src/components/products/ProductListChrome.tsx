'use client';

import type React from 'react';
import type { ReactNode } from 'react';
import { ContextMenu, ContextMenuItem } from '@/components/ContextMenu';
import { StatusBadge } from '@/components/StatusBadge';
import { CardSquareImage } from '@/components/CardGrid';
import { MemberAvatar } from '@/components/MemberAvatar';
import { cardSurfaceStyle } from '@/components/ui';
import {
  LIST_GRID_ROW_CLASS, LIST_MIN_WIDTH_CLASS, type ListGridColumn, listCellClasses,
  listNameBadgeAccentStyle, listNameBadgeStyle, listScrollerClass,
} from '@/components/listChrome';
import { formHelpTextStyle } from '@/components/formChrome';
import { billingFrequencyLabel } from '@/lib/billingFrequency';

/**
 * #2105 stage 1 — the Products list renderer, extracted from the Gym Products
 * page so the Base Products page can adopt it (stage 2) instead of keeping a
 * second one. It draws: the column header band and scroller (`ProductListFrame`),
 * a collapsed list row (`ProductListRow`) and the closed card (`ProductCardHeader`).
 * It names no endpoint and decides no permission: the page hands it the row,
 * the already-built `⋮` items and its translators.
 */

// ─── Row shape ────────────────────────────────────────────────────────────────

/** What the shared renderer reads from a Product (Gym or Base). */
export interface ProductRowData {
  id: number;
  name: string;
  type: string;
  units: number | null;
  status: 'active' | 'inactive';
  enrollment_status: 'public' | 'staff_only';
  /** Gym Products only: a System row shows the System badge. */
  is_system?: number | boolean;
  mandatory: number | boolean;
  one_time_purchase?: number | boolean;
  amount: string | null;
  currency: string;
  billing_frequency: string | null;
  tax_behavior: 'inclusive' | 'exclusive';
  amount_incl_tax?: number | null;
  applied_tax_rate?: number | null;
  created_by: string | null;
  created_at: string | null;
  modified_at: string | null;
  image_url?: string | null;
}

/** The translators the renderer needs, supplied by the page. */
export interface ProductListText {
  /** Keys of the page's `products` namespace. */
  t: (key: string, values?: Record<string, string | number>) => string;
  /** The one billing-frequency namespace (#1128). */
  tFreq: (key: any) => string;
  tStatus: (key: string) => string;
  formatDate: (iso: string | null) => string;
}

// ─── List columns (#637) ──────────────────────────────────────────────────────

interface ListColumn extends ListGridColumn {
  labelKey: string;
  width: number;
  grow?: number;
  align?: 'right';
}

// #1011 stage 2: `mobile` says what each column is on a phone. The name is the
// row's identity and the status the badge beside it; everything else is read in
// the expanded card.
const LIST_COLUMNS: ListColumn[] = [
  { key: 'name', labelKey: 'col_name', width: 180, grow: 2, mobile: 'name' },
  { key: 'type', labelKey: 'col_type', width: 100, mobile: 'secondary' },
  { key: 'units', labelKey: 'col_units', width: 70, align: 'right', mobile: 'secondary' },
  // #942: the Price cell carries the "Total price for N sessions" line.
  { key: 'price', labelKey: 'col_price', width: 200, mobile: 'secondary' },
  { key: 'tax_rate', labelKey: 'col_tax_rate', width: 80, mobile: 'secondary' },
  { key: 'frequency', labelKey: 'col_frequency', width: 110, mobile: 'secondary' },
  { key: 'created_by', labelKey: 'col_created_by', width: 100, mobile: 'secondary' },
  { key: 'created_at', labelKey: 'col_created_at', width: 90, mobile: 'secondary' },
  { key: 'status', labelKey: 'col_status', width: 90, mobile: 'keep' },
  { key: 'enrollment_status', labelKey: 'col_enrollment_status', width: 100, mobile: 'secondary' },
  { key: 'actions', labelKey: 'col_actions', width: 84, mobile: 'actions' },
];

const CELL_CLASS = listCellClasses(LIST_COLUMNS);

const LIST_COLUMN_GAP = 10;
const LIST_ROW_PADDING_X = 16;

const LIST_GRID_COLUMNS = LIST_COLUMNS
  .map((c) => (c.grow ? `minmax(${c.width}px, ${c.grow}fr)` : `${c.width}px`))
  .join(' ');

/** Tracks + gaps + a row's horizontal padding: below this the list scrolls. */
const LIST_MIN_WIDTH =
  LIST_COLUMNS.reduce((sum, c) => sum + c.width, 0)
  + LIST_COLUMN_GAP * (LIST_COLUMNS.length - 1)
  + LIST_ROW_PADDING_X * 2;

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function fmtAmount(amount: string | null, currency: string) {
  if (amount == null) return '—';
  const sym = currency === 'EUR' ? '€' : currency;
  return `${sym}${parseFloat(amount).toFixed(2)}`;
}

/** The collapsed Price figure: the VAT-inclusive amount when the server gave one. */
function priceText(item: ProductRowData, t: ProductListText['t']): string {
  return item.amount_incl_tax != null
    ? `${item.currency === 'EUR' ? '€' : item.currency}${item.amount_incl_tax.toFixed(2)} ${t(item.tax_behavior === 'exclusive' ? 'taxExcluded' : 'taxIncluded')}`
    : fmtAmount(item.amount, item.currency);
}

// ─── List frame ───────────────────────────────────────────────────────────────

/**
 * The scroller and the column header band every Products list sits in. Headers
 * and rows share one grid and scroll together (#637).
 */
export function ProductListFrame({
  showHeader, t, children,
}: { showHeader: boolean; t: ProductListText['t']; children: ReactNode }) {
  return (
    <div className={listScrollerClass('collapse')} style={{ overflowX: 'auto' }}>
      <div className={LIST_MIN_WIDTH_CLASS} style={{ minWidth: LIST_MIN_WIDTH }}>
        {showHeader && (
          <div className={LIST_GRID_ROW_CLASS} style={colHeaderStyle}>
            {LIST_COLUMNS.map((col) => (
              <div key={col.key} className={CELL_CLASS[col.key]} style={{ ...cellStyle, textAlign: col.align }}>
                {t(col.labelKey)}
              </div>
            ))}
          </div>
        )}
        {children}
      </div>
    </div>
  );
}

// ─── Collapsed list row ───────────────────────────────────────────────────────

export function ProductListRow({
  item, isExpanded, menuItems, sessionNote, text, onToggle,
}: {
  item: ProductRowData;
  isExpanded: boolean;
  menuItems: ContextMenuItem[];
  /** #942: the "Total price for N sessions" line, decided by the page. */
  sessionNote: string | null;
  text: ProductListText;
  onToggle: () => void;
}) {
  const { t, tFreq, tStatus, formatDate } = text;
  const isSystem = Boolean(item.is_system);
  const isMandatory = Boolean(item.mandatory);
  return (
    <div className={LIST_GRID_ROW_CLASS} style={rowStyle} onClick={onToggle}>
      <div className={CELL_CLASS.name} style={{ ...cellStyle, fontWeight: 600, fontSize: 15 }} title={item.name}>
        {item.name}
        {isSystem && (
          <span style={listNameBadgeStyle}>
            {t('system_badge')}
          </span>
        )}
        {/* #894 / #913: read from the column, in the accent pill. */}
        {isMandatory && (
          <span style={listNameBadgeAccentStyle}>
            {t('mandatory_badge')}
          </span>
        )}
        {Boolean(item.one_time_purchase) && (
          <span style={listNameBadgeStyle}>
            {t('one_time_badge')}
          </span>
        )}
      </div>
      <div className={CELL_CLASS.type} style={{ ...cellStyle, fontSize: 13, color: '#555' }}>
        {t(`type_${item.type}`)}
      </div>
      <div className={CELL_CLASS.units} style={{ ...cellStyle, fontSize: 13, color: '#555', textAlign: 'right' }}>
        {item.units != null ? item.units : '—'}
      </div>
      <div className={CELL_CLASS.price} style={{ ...cellStyle, fontSize: 13 }}>
        {priceText(item, t)}
        {/* #942: the figure is the whole package, not one session. */}
        {sessionNote && <span style={listHintStyle} title={sessionNote}>{sessionNote}</span>}
      </div>
      <div className={CELL_CLASS.tax_rate} style={{ ...cellStyle, fontSize: 13, color: '#666' }}>
        {item.applied_tax_rate != null
          ? item.applied_tax_rate === 0 ? t('exempt') : `${item.applied_tax_rate}%`
          : '—'}
      </div>
      <div className={CELL_CLASS.frequency} style={{ ...cellStyle, fontSize: 13, color: '#666' }}>
        {billingFrequencyLabel(item.billing_frequency as any, tFreq as any) ?? '—'}
      </div>
      <div className={CELL_CLASS.created_by} style={{ ...cellStyle, fontSize: 13, color: '#888' }}>
        {item.created_by ?? '—'}
      </div>
      <div className={CELL_CLASS.created_at} style={{ ...cellStyle, fontSize: 13, color: '#888' }}>
        {formatDate(item.created_at)}
      </div>
      <div className={CELL_CLASS.status} style={badgeCellStyle}>
        <StatusBadge status={item.status} label={tStatus(item.status)} />
      </div>
      <div className={CELL_CLASS.enrollment_status} style={badgeCellStyle}>
        <StatusBadge
          status={item.enrollment_status === 'public' ? 'active' : 'paused'}
          label={tStatus(item.enrollment_status)}
        />
      </div>
      <div className={CELL_CLASS.actions} style={actionsCellStyle}>
        <span style={{ fontSize: 14, color: '#aaa', transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
        <div onClick={(e) => e.stopPropagation()}>
          <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
        </div>
      </div>
    </div>
  );
}

// ─── Closed card (#1832) ──────────────────────────────────────────────────────

export function ProductCardHeader({
  item, isExpanded, menuItems, text, onToggle,
}: {
  item: ProductRowData;
  isExpanded: boolean;
  menuItems: ContextMenuItem[];
  text: ProductListText;
  onToggle: () => void;
}) {
  const { t, tFreq, tStatus } = text;
  const image = item.image_url;
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {image && <CardSquareImage src={image} alt={item.name} version={item.modified_at} placeholder={null} />}
      <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {!image && <MemberAvatar name={item.name} imageUrl={null} stamp={item.modified_at} size={40} />}
          <div style={{ flex: 1, minWidth: 0, fontWeight: 600, fontSize: 16, overflowWrap: 'anywhere' }}>{item.name}</div>
          <div onClick={(e) => e.stopPropagation()}>
            <ContextMenu items={menuItems} ariaLabel={`Actions for ${item.name}`} />
          </div>
        </div>
        <div style={{ fontSize: 13, color: 'var(--gd-text-secondary, #666)' }}>
          {t(`type_${item.type}`)} · {priceText(item, t)} · {billingFrequencyLabel(item.billing_frequency as any, tFreq as any) ?? '—'}
        </div>
        <div>
          <StatusBadge status={item.status} label={tStatus(item.status)} />
        </div>
      </div>
      <button
        type="button"
        aria-expanded={isExpanded}
        onClick={onToggle}
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
          padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13,
          borderTop: '1px solid var(--gd-card-border, #eee)', color: 'inherit',
        }}
      >
        <span>{isExpanded ? t('hide_all_attributes') : t('show_all_attributes')}</span>
        <span aria-hidden style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
      </button>
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

/** The card surface a Product's row/card sits in. */
export const productCardStyle: React.CSSProperties = { ...cardSurfaceStyle, overflow: 'hidden' };

/** The expanded body, in both modes (#974 §1). */
export const productExpandedBodyStyle: React.CSSProperties = {
  padding: '16px 20px',
  borderTop: '1px solid var(--gd-border, #eee)',
};

// #942: the clarification line beside a displayed price (italic gloss).
export const productValueHintStyle: React.CSSProperties = {
  ...formHelpTextStyle, fontStyle: 'italic',
};

const listHintStyle: React.CSSProperties = {
  ...productValueHintStyle, display: 'block', margin: '2px 0 0', fontSize: 11,
};

const listGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: LIST_GRID_COLUMNS,
  alignItems: 'center',
  gap: LIST_COLUMN_GAP,
};

const rowStyle: React.CSSProperties = {
  ...listGridStyle, padding: `12px ${LIST_ROW_PADDING_X}px`,
  cursor: 'pointer', userSelect: 'none',
};

const colHeaderStyle: React.CSSProperties = {
  ...listGridStyle, padding: `6px ${LIST_ROW_PADDING_X}px`,
  // Rows sit inside a bordered card, so the header carries a matching
  // transparent border — without it every column would be off by 1px.
  border: '1px solid transparent',
  fontSize: 12, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: '0.04em',
  marginBottom: 4,
};

/** Keeps an over-long value inside its track instead of widening the row. */
const cellStyle: React.CSSProperties = {
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

const badgeCellStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', alignItems: 'center',
};

const actionsCellStyle: React.CSSProperties = {
  minWidth: 0, display: 'flex', alignItems: 'center', gap: 6,
};
