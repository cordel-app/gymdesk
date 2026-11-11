// #2648 stage 3 — an invoice with a VERI*FACTU Alta record prints the AEAT
// verification QR and the "VERI*FACTU" legend; one without keeps its layout.
// The QR is checked by rebuilding its module matrix from the drawn squares and
// comparing it with the matrix of the expected URL at error correction M.
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import { generateInvoicePdf, VERIFACTU_QR_SIZE_PT, type InvoicePdfData } from '../lib/invoice-pdf';
import {
  parseVerifactuEnvironment, verifactuQrFromRecord, VERIFACTU_QR_LEGEND,
} from '../domain/verifactu';

/** Every content stream of the PDF, inflated. */
function contentText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    try { out.push(inflateSync(pdf.subarray(start, end)).toString('latin1')); } catch { /* not flate */ }
  }
  return out.join('\n');
}

const hex = (s: string) => Buffer.from(s, 'latin1').toString('hex').toUpperCase();

/** The black squares the page draws, as their lower-left corners (pdf-lib emits a `cm` then a closed `m`/`l` path). */
function blackSquares(content: string): Array<{ x: number; y: number; w: number }> {
  const squares: Array<{ x: number; y: number; w: number }> = [];
  // pdf-lib draws a rectangle as: q, 0 0 0 rg, 1 0 0 1 x y cm, 0 0 m, 0 h l, w h l, …, Q
  const re = /q\n([\s\S]*?)\nQ/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    const block = m[1];
    if (!/(^|\n)0 0 0 rg/.test(block)) continue;
    const cm = /1 0 0 1 ([\d.-]+) ([\d.-]+) cm/.exec(block);
    const rect = /\n0 0 m\n0 [\d.]+ l\n([\d.]+) [\d.]+ l/.exec(block);
    if (cm && rect) squares.push({ x: +cm[1], y: +cm[2], w: +rect[1] });
  }
  return squares;
}

const base: InvoicePdfData = {
  type: 'simplified', state: 'not-paid', lang: 'es', number: 'S-2026-000001', issuedAt: new Date('2026-11-11T10:00:00Z'),
  gym: { name: 'Gym', legalName: 'Gym SL', cif: '12345678Z', fiscalAddress: 'Calle 1', fiscalPhone: null },
  customer: { name: 'Ana', taxId: null, address: null },
  lines: [{ name: 'Cuota', quantity: 1, amount: 29.99 } as any],
  totals: { net: 24.79, tax: 5.2, total: 29.99 } as any,
  currency: 'EUR',
};

const record = { issuer_nif: '12345678Z', invoice_number: 'S-2026-000001', invoice_issue_date: '11-11-2026', invoice_total: '29.99' };

describe('VERI*FACTU QR on the invoice PDF', () => {
  it('builds the QR from the stored record, test service unless production is configured', () => {
    expect(parseVerifactuEnvironment(undefined)).toBe('test');
    expect(parseVerifactuEnvironment(' ')).toBe('test');
    expect(parseVerifactuEnvironment('production')).toBe('production');
    expect(() => parseVerifactuEnvironment('prod')).toThrow(/VERIFACTU_ENVIRONMENT/);
    expect(verifactuQrFromRecord('test', record)).toEqual({
      url: 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=12345678Z&numserie=S-2026-000001&fecha=11-11-2026&importe=29.99',
      legend: VERIFACTU_QR_LEGEND,
    });
  });

  it('draws exactly the modules of the expected URL, 35 mm wide, with the legend', async () => {
    const qr = verifactuQrFromRecord('production', record);
    const content = contentText(await generateInvoicePdf({ ...base, verifactu: qr }));
    expect(content).toContain(`<${hex('VERI*FACTU')}>`);

    const expected = QRCode.create(qr.url, { errorCorrectionLevel: 'M' }).modules;
    const n = expected.size;
    const squares = blackSquares(content).filter((s) => Math.abs(s.w - VERIFACTU_QR_SIZE_PT / n) < 1e-3);
    const left = Math.min(...squares.map((s) => s.x));
    const top = Math.max(...squares.map((s) => s.y)) + VERIFACTU_QR_SIZE_PT / n;
    const cell = VERIFACTU_QR_SIZE_PT / n;
    const drawn = new Set(squares.map((s) => `${Math.round((top - s.y) / cell) - 1},${Math.round((s.x - left) / cell)}`));
    const dark = new Set<string>();
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (expected.get(r, c)) dark.add(`${r},${c}`);
    expect(drawn).toEqual(dark);
    expect(cell * n * 25.4 / 72).toBeCloseTo(35, 5);
  });

  it('a rectifying invoice prints its QR too; an invoice with no record prints none', async () => {
    const rect = contentText(await generateInvoicePdf({
      ...base, number: 'R-2026-000001', rectifies: { number: 'S-2026-000001', reason: 'x' },
      verifactu: verifactuQrFromRecord('test', { ...record, invoice_number: 'R-2026-000001', invoice_total: '-29.99' }),
    }));
    expect(rect).toContain(`<${hex('VERI*FACTU')}>`);
    const plain = contentText(await generateInvoicePdf(base));
    expect(plain).not.toContain(hex('VERI*FACTU'));
    expect(blackSquares(plain)).toHaveLength(0);
  });
});
