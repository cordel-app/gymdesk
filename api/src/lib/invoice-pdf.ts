import { PDFDocument, rgb, StandardFonts, degrees, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';
import { stampText, type InvoiceLanguage, type LineInput, type TaxBreakdown } from '../domain/billingInvoice';
import type { InvoiceType, InvoicePaymentState } from '../domain/billingDocumentKeys';

export interface InvoicePdfData {
  type: InvoiceType;
  state: InvoicePaymentState;
  lang: InvoiceLanguage;
  number: string;
  issuedAt: Date;
  gym: { name: string; legalName: string | null; cif: string | null; fiscalAddress: string | null; fiscalPhone: string | null };
  customer: { name: string; taxId: string | null; address: string | null };
  lines: LineInput[];
  totals: TaxBreakdown;
  currency: string;
  /** Set on a rectifying invoice: the original it corrects and why. It carries no PAID stamp. */
  rectifies?: { number: string; reason: string };
  /**
   * #2648 stage 3: set when the invoice has a VERI*FACTU Alta record. The PDF
   * then prints the AEAT verification QR (encoding `url`) with `legend` above it.
   */
  verifactu?: { url: string; legend: string } | null;
}

/** QR side in points: 35 mm, inside AEAT's 30–40 mm range. */
export const VERIFACTU_QR_SIZE_PT = (35 / 25.4) * 72;
/** ISO/IEC 18004 quiet zone, in modules. */
const QR_QUIET_MODULES = 4;

/**
 * Draws the QR of `url` (ISO/IEC 18004, error correction M, as AEAT requires)
 * with its top-left corner at (x, top): one filled square per dark module over
 * a white quiet zone, so the diagonal payment stamp never touches it.
 */
function drawQr(page: PDFPage, url: string, x: number, top: number, size: number): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size;
  const cell = size / n;
  const quiet = QR_QUIET_MODULES * cell;
  page.drawRectangle({ x: x - quiet, y: top - size - quiet, width: size + 2 * quiet, height: size + 2 * quiet, color: rgb(1, 1, 1) });
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue;
      page.drawRectangle({ x: x + c * cell, y: top - (r + 1) * cell, width: cell, height: cell, color: rgb(0, 0, 0) });
    }
  }
}

const T: Record<InvoiceLanguage, Record<string, string>> = {
  en: { simplified: 'SIMPLIFIED INVOICE', full: 'INVOICE', customer: 'Customer', rectifying: 'RECTIFYING INVOICE', rectifies: 'Rectifies invoice', reason: 'Reason', concept: 'Concept', qty: 'Qty', amount: 'Amount', net: 'Net', tax: 'Tax', total: 'TOTAL', date: 'Date' },
  es: { simplified: 'FACTURA SIMPLIFICADA', full: 'FACTURA', customer: 'Cliente', rectifying: 'FACTURA RECTIFICATIVA', rectifies: 'Rectifica la factura', reason: 'Motivo', concept: 'Concepto', qty: 'Cant.', amount: 'Importe', net: 'Base imponible', tax: 'IVA', total: 'TOTAL', date: 'Fecha' },
  ca: { simplified: 'FACTURA SIMPLIFICADA', full: 'FACTURA', customer: 'Client', rectifying: 'FACTURA RECTIFICATIVA', rectifies: 'Rectifica la factura', reason: 'Motiu', concept: 'Concepte', qty: 'Quant.', amount: 'Import', net: 'Base imposable', tax: 'IVA', total: 'TOTAL', date: 'Data' },
};

// pdf-lib's standard fonts are WinAnsi: drop anything they cannot encode.
const safe = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, '?');

export async function generateInvoicePdf(d: InvoicePdfData): Promise<Buffer> {
  const t = T[d.lang];
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const { width, height } = page.getSize();
  const margin = 50;
  let y = height - margin;
  const grey = rgb(0.4, 0.4, 0.4);
  const text = (s: string, x: number, yy: number, size: number, b = false, color = rgb(0, 0, 0)) =>
    page.drawText(safe(s), { x, y: yy, size, font: b ? bold : font, color });
  const line = (yy: number, w = 0.5) =>
    page.drawLine({ start: { x: margin, y: yy }, end: { x: width - margin, y: yy }, thickness: w, color: rgb(0.8, 0.8, 0.8) });
  const money = (n: number) => `${n.toFixed(2)} ${d.currency}`;

  // Diagonal payment stamp, drawn first so the content stays readable on top.
  const stamp = stampText(d.lang, d.state);
  const stampColor = d.state === 'paid' ? rgb(0.75, 0.9, 0.75) : rgb(0.95, 0.75, 0.75);
  if (!d.rectifies) page.drawText(stamp, { x: 110, y: 280, size: 90, font: bold, color: stampColor, rotate: degrees(40), opacity: 0.5 });

  // #2648 stage 3: the VERI*FACTU legend and QR sit at the top right of the
  // header, and the header never ends above the QR's bottom edge.
  let headerFloor = y;
  if (d.verifactu) {
    const size = VERIFACTU_QR_SIZE_PT;
    const x = width - margin - size;
    const legendSize = 9;
    const legendWidth = bold.widthOfTextAtSize(d.verifactu.legend, legendSize);
    text(d.verifactu.legend, x + (size - legendWidth) / 2, y - legendSize + 2, legendSize, true);
    const top = y - legendSize - 8;
    drawQr(page, d.verifactu.url, x, top, size);
    headerFloor = top - size - 6;
  }

  // Beside the QR a header line is cut to the room left of it.
  const headerWidth = d.verifactu ? width - 2 * margin - VERIFACTU_QR_SIZE_PT - 20 : Infinity;
  const fit = (s: string, size: number, b = false) => {
    const f = b ? bold : font;
    let out = safe(s);
    while (out.length > 1 && f.widthOfTextAtSize(out, size) > headerWidth) out = out.slice(0, -1);
    return out;
  };
  text(fit(d.gym.legalName ?? d.gym.name, 16, true), margin, y, 16, true); y -= 20;
  if (d.gym.cif) { text(fit(`CIF: ${d.gym.cif}`, 10), margin, y, 10, false, grey); y -= 14; }
  if (d.gym.fiscalAddress) { text(fit(d.gym.fiscalAddress, 10), margin, y, 10, false, grey); y -= 14; }
  if (d.gym.fiscalPhone) { text(fit(`Tel: ${d.gym.fiscalPhone}`, 10), margin, y, 10, false, grey); y -= 14; }
  y = Math.min(y, headerFloor);
  y -= 10; line(y); y -= 20;

  text(d.rectifies ? t.rectifying : t[d.type], margin, y, 13, true); y -= 18;
  text(`Nº ${d.number}`, margin, y, 11);
  text(`${t.date}: ${d.issuedAt.toISOString().slice(0, 10)}`, width - margin - 150, y, 11);
  y -= 18;
  if (d.rectifies) {
    text(`${t.rectifies}: ${d.rectifies.number}`, margin, y, 10, false, grey); y -= 14;
    text(`${t.reason}: ${d.rectifies.reason.replace(/\s+/g, ' ').slice(0, 80)}`, margin, y, 10, false, grey); y -= 14;
  }
  y -= 6; line(y); y -= 20;

  text(`${t.customer}:`, margin, y, 10, false, grey); y -= 14;
  text(d.customer.name, margin, y, 11, true); y -= 14;
  if (d.customer.taxId) { text(`NIF: ${d.customer.taxId}`, margin, y, 10); y -= 14; }
  if (d.customer.address) { text(d.customer.address.replace(/\s+/g, ' ').slice(0, 90), margin, y, 10); y -= 14; }
  y -= 10; line(y); y -= 20;

  text(t.concept, margin, y, 10, true);
  text(t.qty, margin + 330, y, 10, true);
  text(t.amount, margin + 420, y, 10, true);
  y -= 14; line(y, 1); y -= 16;
  for (const l of d.lines) {
    text(l.name.slice(0, 60), margin, y, 10);
    text(String(l.quantity), margin + 330, y, 10);
    text(money(l.amount), margin + 420, y, 10);
    y -= 16;
  }
  y -= 4; line(y, 1); y -= 18;
  text(t.net, margin + 300, y, 10); text(money(d.totals.net), margin + 420, y, 10); y -= 16;
  text(t.tax, margin + 300, y, 10); text(money(d.totals.tax), margin + 420, y, 10); y -= 18;
  text(t.total, margin + 300, y, 11, true); text(money(d.totals.total), margin + 420, y, 11, true);

  return Buffer.from(await doc.save());
}
