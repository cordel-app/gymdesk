import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';

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
  concept: string;
  totalAmount: number;
  ivaRate: number; // e.g. 21 for 21%
  currency: string;
}

function formatCurrency(amount: number, currency: string): string {
  return `${amount.toFixed(2)} ${currency}`;
}

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

  // --- Concept table header ---
  drawText('Concepto', margin, y, 10, true);
  drawText('Base imponible', margin + contentWidth * 0.5, y, 10, true);
  drawText(`IVA (${data.ivaRate}%)`, margin + contentWidth * 0.7, y, 10, true);
  drawText('Total', margin + contentWidth * 0.87, y, 10, true);
  y -= 14;
  drawHLine(y, 1);
  y -= 16;

  // --- Concept row ---
  const base = data.totalAmount / (1 + data.ivaRate / 100);
  const iva = data.totalAmount - base;

  drawText(data.concept, margin, y, 11);
  drawText(formatCurrency(base, data.currency), margin + contentWidth * 0.5, y, 11);
  drawText(formatCurrency(iva, data.currency), margin + contentWidth * 0.7, y, 11);
  drawText(formatCurrency(data.totalAmount, data.currency), margin + contentWidth * 0.87, y, 11);

  y -= 20;
  drawHLine(y, 1);
  y -= 16;

  // --- Total row ---
  drawText('TOTAL', margin + contentWidth * 0.7, y, 11, true);
  drawText(formatCurrency(data.totalAmount, data.currency), margin + contentWidth * 0.87, y, 11, true);

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
