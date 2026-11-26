'use client';

// #3437 — the **Past Payments** subcard's body: the filters, then the payments a
// page at a time, the next page loaded as the member scrolls near the end (a
// sentinel watched by an IntersectionObserver, which fires for a mouse wheel, a
// trackpad and a touch scroll alike). It decides nothing: the request, how a
// page joins the list and the filter rules are `lib/memberPastPayments.ts`', the
// payments and their order the API's, every label arrives resolved and each
// payment is drawn by the page (`renderItem`), so it keeps #3299's card. It
// mounts when the subcard opens, so the first page is read then and not before.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { inputStyle, memberTheme, secondaryButtonStyle } from '../lib/memberChrome';
import type { MemberBillingEvent } from '../lib/memberPayments';
import {
  EMPTY_PAST_FILTERS,
  PAST_PAYMENTS_PRODUCTS_PATH,
  appendPastPage,
  hasPastFilters,
  pastFiltersError,
  pastPaymentsPath,
  type PastPaymentProductOption,
  type PastPaymentsFilters,
  type PastPaymentsPage,
} from '../lib/memberPastPayments';

export interface PastPaymentsLabels {
  dateFrom: string;
  dateTo: string;
  product: string;
  allProducts: string;
  clear: string;
  loading: string;
  empty: string;
  emptyFiltered: string;
  loadFailed: string;
  retry: string;
  /** Resolves a locale key the lib answers (a filter error). */
  message: (key: string) => string;
}

export function PastPaymentsList({ load, renderItem, labels }: {
  /** The page's authenticated GET (`apiFetch`). */
  load: <T>(path: string) => Promise<T>;
  renderItem: (event: MemberBillingEvent) => ReactNode;
  labels: PastPaymentsLabels;
}) {
  const [filters, setFilters] = useState<PastPaymentsFilters>(EMPTY_PAST_FILTERS);
  const [products, setProducts] = useState<PastPaymentProductOption[]>([]);
  const [items, setItems] = useState<MemberBillingEvent[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [done, setDone] = useState(false);
  // Each filter change starts a new list; an answer to an older one is dropped.
  const generation = useRef(0);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const filterError = pastFiltersError(filters);

  useEffect(() => {
    load<{ items: PastPaymentProductOption[] }>(PAST_PAYMENTS_PRODUCTS_PATH)
      .then((res) => setProducts(res.items))
      .catch(() => setProducts([]));
  }, [load]);

  const fetchPage = useCallback(async (from: string | null, gen: number, current: PastPaymentsFilters) => {
    setLoading(true);
    setFailed(false);
    try {
      const page = await load<PastPaymentsPage>(pastPaymentsPath(current, from));
      if (gen !== generation.current) return;
      setItems((shown) => (from ? appendPastPage(shown, page.items) : page.items));
      setCursor(page.next_cursor);
      setDone(page.next_cursor == null);
    } catch {
      if (gen === generation.current) setFailed(true);
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, [load]);

  // A filter change resets the list and reads its first page.
  useEffect(() => {
    generation.current += 1;
    setItems([]);
    setCursor(null);
    setDone(false);
    if (filterError) { setLoading(false); return; }
    void fetchPage(null, generation.current, filters);
  }, [filters, filterError, fetchPage]);

  // The next page when the end of the list comes into view. Re-observed after
  // every page, so an end still in view after a short page loads the next one.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || done || loading || failed || !cursor || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        observer.disconnect();
        void fetchPage(cursor, generation.current, filters);
      }
    }, { rootMargin: '200px 0px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [cursor, done, loading, failed, items.length, filters, fetchPage]);

  const set = (patch: Partial<PastPaymentsFilters>) => setFilters((prev) => ({ ...prev, ...patch }));
  const filtered = hasPastFilters(filters);
  const firstLoad = loading && items.length === 0;

  return (
    <div style={styles.wrap}>
      <div style={styles.filters}>
        <label style={styles.field}>
          <span style={styles.label}>{labels.dateFrom}</span>
          <input type="date" value={filters.dateFrom} max={filters.dateTo || undefined}
            onChange={(e) => set({ dateFrom: e.target.value })} style={styles.input} />
        </label>
        <label style={styles.field}>
          <span style={styles.label}>{labels.dateTo}</span>
          <input type="date" value={filters.dateTo} min={filters.dateFrom || undefined}
            onChange={(e) => set({ dateTo: e.target.value })} style={styles.input} />
        </label>
        {products.length > 0 && (
          <label style={styles.field}>
            <span style={styles.label}>{labels.product}</span>
            <select value={filters.productId} onChange={(e) => set({ productId: e.target.value })} style={styles.input}>
              <option value="">{labels.allProducts}</option>
              {products.map((p) => <option key={p.id} value={String(p.id)}>{p.name}</option>)}
            </select>
          </label>
        )}
        {filtered && (
          <button type="button" onClick={() => setFilters(EMPTY_PAST_FILTERS)} style={styles.clear}>{labels.clear}</button>
        )}
        {filterError && <p role="alert" style={styles.error}>{labels.message(filterError)}</p>}
      </div>

      {!filterError && !firstLoad && !failed && items.length === 0 && (
        <div style={styles.empty}>
          <p style={styles.hint}>{filtered ? labels.emptyFiltered : labels.empty}</p>
          {filtered && (
            <button type="button" onClick={() => setFilters(EMPTY_PAST_FILTERS)} style={styles.clear}>{labels.clear}</button>
          )}
        </div>
      )}

      {items.map((event) => renderItem(event))}

      {loading && <p style={styles.hint} aria-live="polite">{labels.loading}</p>}
      {failed && (
        <div style={styles.empty}>
          <p role="alert" style={styles.hint}>{labels.loadFailed}</p>
          <button type="button" onClick={() => void fetchPage(cursor, generation.current, filters)} style={styles.clear}>
            {labels.retry}
          </button>
        </div>
      )}
      <div ref={sentinel} aria-hidden="true" style={styles.sentinel} />
    </div>
  );
}

const styles: Record<string, CSSProperties> = {
  wrap: { display: 'flex', flexDirection: 'column', gap: 8 },
  // Kept in view while the member scrolls the results (§2).
  filters: {
    position: 'sticky', top: 0, zIndex: 1, background: memberTheme.surface,
    display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', gap: 8, padding: '4px 0 8px',
    borderBottom: `1px solid ${memberTheme.separator}`,
  },
  field: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0, flex: '1 1 130px' },
  label: { fontSize: 11, color: memberTheme.textMuted },
  input: { ...inputStyle, fontSize: 13, padding: '6px 8px', minWidth: 0, width: '100%', boxSizing: 'border-box' },
  clear: { ...secondaryButtonStyle, fontSize: 12, padding: '6px 10px' },
  error: { margin: 0, flexBasis: '100%', fontSize: 12, color: memberTheme.statusError },
  empty: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 6 },
  hint: { margin: 0, fontSize: 13, color: memberTheme.textMuted },
  sentinel: { height: 1 },
};
