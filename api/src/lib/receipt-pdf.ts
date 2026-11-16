import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import type { InvoiceLine, TaxBreakdown } from '../domain/billingInvoice';
import { formatTaxRate } from './invoice-pdf';

export interface ReceiptData {
  receiptNumber: string;
  issuedAt: Date;
  gym: {
    name: string;
    legalName: string | null;
    cif: string | null;
    fiscalAddress: string | null;
    fiscalPhone: string | null;
  };
  memberName: string;
  /** #2884: the event's lines, each with its own rate and tax (`invoiceLineTaxes()`). */
  lines: InvoiceLine[];
  totals: TaxBreakdown;
  currency: string;
}

function formatCurrency(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

// pdf-lib's standard fonts are WinAnsi: drop anything they cannot encode.
const safe = (s: string) => s.replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '?');

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function generateReceiptPdf(data: ReceiptData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4

  const helveticaBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);

  const { width, height } = page.getSize();
  const margin = 50;
  const contentWidth = width - margin * 2;
  let y = height - margin;

  const drawText = (text: string, x: number, yPos: number, size: number, bold = false, color = rgb(0, 0, 0)) => {
    page.drawText(text, {
      x,
      y: yPos,
      size,
      font: bold ? helveticaBold : helvetica,
      color,
    });
  };

  const drawHLine = (yPos: number, thickness = 0.5) => {
    page.drawLine({
      start: { x: margin, y: yPos },
      end: { x: width - margin, y: yPos },
      thickness,
      color: rgb(0.8, 0.8, 0.8),
    });
  };

  // --- Header: Gym name ---
  drawText(data.gym.legalName ?? data.gym.name, margin, y, 16, true);
  y -= 20;

  if (data.gym.cif) {
    drawText(`CIF: ${data.gym.cif}`, margin, y, 10, false, rgb(0.4, 0.4, 0.4));
    y -= 14;
  }
  if (data.gym.fiscalAddress) {
    drawText(data.gym.fiscalAddress, margin, y, 10, false, rgb(0.4, 0.4, 0.4));
    y -= 14;
  }
  if (data.gym.fiscalPhone) {
    drawText(`Tel: ${data.gym.fiscalPhone}`, margin, y, 10, false, rgb(0.4, 0.4, 0.4));
    y -= 14;
  }

  y -= 10;
  drawHLine(y);
  y -= 20;

  // --- Document title and number ---
  drawText('FACTURA SIMPLIFICADA', margin, y, 13, true);
  y -= 18;
  drawText(`Nº ${data.receiptNumber}`, margin, y, 11);
  drawText(`Fecha: ${formatDate(data.issuedAt)}`, width - margin - 150, y, 11);
  y -= 14;
  drawText('Pagado en efectivo', margin, y, 10, false, rgb(0.2, 0.6, 0.2));

  y -= 24;
  drawHLine(y);
  y -= 20;

  // --- Member ---
  drawText('Cliente:', margin, y, 10, false, rgb(0.4, 0.4, 0.4));
  y -= 14;
  drawText(data.memberName, margin, y, 11, true);

  y -= 28;
  drawHLine(y);
  y -= 20;

  // --- Line table (#2884: each line states its own rate and tax) ---
  const col = { qty: 0.42, rate: 0.5, tax: 0.6, amount: 0.8 };
  drawText('Concepto', margin, y, 10, true);
  drawText('Cant.', margin + contentWidth * col.qty, y, 10, true);
  drawText('% IVA', margin + contentWidth * col.rate, y, 10, true);
  drawText('Cuota IVA', margin + contentWidth * col.tax, y, 10, true);
  drawText('Importe', margin + contentWidth * col.amount, y, 10, true);
  y -= 14;
  drawHLine(y, 1);
  y -= 16;

  for (const l of data.lines) {
    drawText(safe(l.name).slice(0, 34), margin, y, 10);
    drawText(String(l.quantity), margin + contentWidth * col.qty, y, 10);
    drawText(formatTaxRate(l.rate), margin + contentWidth * col.rate, y, 10);
    drawText(formatCurrency(l.tax, data.currency), margin + contentWidth * col.tax, y, 10);
    drawText(formatCurrency(l.amount, data.currency), margin + contentWidth * col.amount, y, 10);
    y -= 16;
  }

  y -= 4;
  drawHLine(y, 1);
  y -= 18;

  // --- Totals: net, tax (the sum of the lines' tax) and grand total ---
  drawText('Base imponible', margin + contentWidth * col.tax, y, 10);
  drawText(formatCurrency(data.totals.net, data.currency), margin + contentWidth * col.amount, y, 10);
  y -= 16;
  drawText('IVA', margin + contentWidth * col.tax, y, 10);
  drawText(formatCurrency(data.totals.tax, data.currency), margin + contentWidth * col.amount, y, 10);
  y -= 18;
  drawText('TOTAL', margin + contentWidth * col.tax, y, 11, true);
  drawText(formatCurrency(data.totals.total, data.currency), margin + contentWidth * col.amount, y, 11, true);

  y -= 40;
  drawHLine(y);
  y -= 20;

  // --- Footer ---
  drawText(
    'Este documento es una factura simplificada conforme al RD 1619/2012.',
    margin,
    y,
    8,
    false,
    rgb(0.6, 0.6, 0.6),
  );

  const pdfBytes = await doc.save();
  return Buffer.from(pdfBytes);
}
