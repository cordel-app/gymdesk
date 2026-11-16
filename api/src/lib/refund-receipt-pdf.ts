import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

/**
 * #2935 — the Refund Receipt PDF ("JUSTIFICANTE DE DEVOLUCIÓN"). Same layout
 * language as the receipt (`receipt-pdf.ts`), but it documents money returned:
 * the refund's own number, date, amount, method and reference, and the
 * original payment and receipt it relates to. It is not a rectifying invoice
 * and says so in its footer.
 */
export interface RefundReceiptData {
  refundReceiptNumber: string;
  issuedAt: Date;
  gym: {
    name: string;
    legalName: string | null;
    cif: string | null;
    fiscalAddress: string | null;
    fiscalPhone: string | null;
  };
  customer: { name: string; taxId: string | null; address: string | null };
  refund: {
    completedAt: Date;
    amount: number;
    currency: string;
    method: string;
    reference: string;
    /** What was refunded: the full payment, the named lines, or an amount. */
    reason: string | null;
  };
  original: {
    receiptNumber: string | null;
    paidAt: Date | null;
    amount: number;
    billingEventId: number;
  };
}

const safe = (s: string) => s.replace(/[^\x20-\x7E -ÿ]/g, '?');
const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;
const date = (d: Date) => d.toISOString().slice(0, 10);
const dateTime = (d: Date) => `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;

export async function generateRefundReceiptPdf(data: RefundReceiptData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const { width, height } = page.getSize();
  const margin = 50;
  const grey = rgb(0.4, 0.4, 0.4);
  let y = height - margin;

  const text = (s: string, x: number, size: number, isBold = false, color = rgb(0, 0, 0)) =>
    page.drawText(safe(s), { x, y, size, font: isBold ? bold : regular, color });
  const rule = (thickness = 0.5) => page.drawLine({
    start: { x: margin, y }, end: { x: width - margin, y }, thickness, color: rgb(0.8, 0.8, 0.8),
  });
  const row = (label: string, value: string) => {
    text(label, margin, 10, false, grey);
    text(value, margin + 190, 10);
    y -= 15;
  };

  // --- Company ---
  text(data.gym.legalName ?? data.gym.name, margin, 16, true);
  y -= 20;
  for (const line of [
    data.gym.cif ? `NIF: ${data.gym.cif}` : null,
    data.gym.fiscalAddress,
    data.gym.fiscalPhone ? `Tel: ${data.gym.fiscalPhone}` : null,
  ]) {
    if (!line) continue;
    text(line, margin, 10, false, grey);
    y -= 14;
  }
  y -= 10; rule(); y -= 22;

  // --- Title ---
  text('JUSTIFICANTE DE DEVOLUCIÓN', margin, 13, true);
  y -= 14;
  text('REFUND RECEIPT', margin, 9, false, grey);
  y -= 16;
  text(`Nº ${data.refundReceiptNumber}`, margin, 11);
  text(`Fecha de emisión: ${date(data.issuedAt)}`, width - margin - 170, 11);
  y -= 20; rule(); y -= 20;

  // --- Customer ---
  text('Cliente:', margin, 10, false, grey);
  y -= 14;
  text(data.customer.name, margin, 11, true);
  y -= 14;
  if (data.customer.taxId) { text(`NIF: ${data.customer.taxId}`, margin, 10, false, grey); y -= 14; }
  if (data.customer.address) { text(data.customer.address, margin, 10, false, grey); y -= 14; }
  y -= 10; rule(); y -= 20;

  // --- Refund ---
  text('Devolución', margin, 11, true);
  y -= 18;
  row('Fecha y hora de la devolución', dateTime(data.refund.completedAt));
  row('Importe devuelto', money(data.refund.amount, data.refund.currency));
  row('Moneda', data.refund.currency);
  row('Método de devolución', data.refund.method);
  row('Referencia de la devolución', data.refund.reference);
  if (data.refund.reason) row('Concepto', data.refund.reason.slice(0, 60));
  y -= 8; rule(); y -= 20;

  // --- Original payment ---
  text('Pago original', margin, 11, true);
  y -= 18;
  row('Nº de recibo original', data.original.receiptNumber ?? '—');
  row('Fecha del pago original', data.original.paidAt ? date(data.original.paidAt) : '—');
  row('Importe del pago original', money(data.original.amount, data.refund.currency));
  row('Evento de facturación', `#${data.original.billingEventId}`);
  y -= 8; rule(1); y -= 22;

  text('TOTAL DEVUELTO', margin + 300, 11, true);
  text(money(data.refund.amount, data.refund.currency), margin + 410, 11, true);
  y -= 40; rule(); y -= 18;

  text(
    'Este justificante documenta una devolución y no es una factura rectificativa. El recibo original no se modifica.',
    margin, 7.5, false, rgb(0.6, 0.6, 0.6),
  );

  return Buffer.from(await doc.save());
}
