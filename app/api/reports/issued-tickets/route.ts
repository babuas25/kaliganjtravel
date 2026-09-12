import { z } from 'zod';

import { getDashboardSession } from '@/lib/dashboard/session';
import {
  issuedTicketScopeFor,
  listAllIssuedTickets,
  listIssuedTicketAirlines,
  listIssuedTickets,
  summarizeIssuedTickets,
  type IssuedTicketFilters,
  type IssuedTicketRow,
} from '@/lib/reports/issued-tickets';
import { AGENCY_CODE_PATTERN } from '@/lib/agency';
import { walletFail, walletOk } from '@/lib/wallet/http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const date = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    return parsed.getUTCFullYear() === year
      && parsed.getUTCMonth() === month - 1
      && parsed.getUTCDate() === day;
  })
  .optional();
const schema = z.object({
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(10).max(100).default(25),
  from: date,
  to: date,
  bookedBy: z.string().trim().max(255).optional(),
  airline: z.string().trim().max(10).optional(),
  search: z.string().trim().max(100).optional(),
  agency: z.string().trim().regex(AGENCY_CODE_PATTERN).optional(),
  format: z.enum(['json', 'xlsx', 'pdf']).default('json'),
});

function filtersOf(input: z.infer<typeof schema>): IssuedTicketFilters {
  return {
    ...(input.from ? { from: input.from } : {}),
    ...(input.to ? { to: input.to } : {}),
    ...(input.bookedBy ? { bookedBy: input.bookedBy } : {}),
    ...(input.airline ? { airline: input.airline.toUpperCase() } : {}),
    ...(input.search ? { search: input.search } : {}),
  };
}

function exportName(extension: string, agencyCode: string) {
  return `sales-report-${agencyCode}-${new Date().toISOString().slice(0, 10)}.${extension}`;
}

async function excelResponse(rows: IssuedTicketRow[], agencyCode: string) {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Kaliganj Travels';
  workbook.created = new Date();
  const sheet = workbook.addWorksheet('Sales Report', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    { header: 'Created On', key: 'createdAt', width: 22 },
    { header: 'Order Reference', key: 'orderDetails', width: 34 },
    { header: 'PNR', key: 'pnr', width: 18 },
    { header: 'Airline', key: 'airlineCode', width: 12 },
    { header: 'Total Segments', key: 'totalSegments', width: 16 },
    { header: 'Ticketed On', key: 'ticketedAt', width: 22 },
    { header: 'User Name', key: 'bookedByName', width: 28 },
    { header: 'Currency', key: 'currency', width: 12 },
    { header: 'Gross Fare', key: 'grossFare', width: 16 },
    { header: 'Payable Amount', key: 'payableAmount', width: 20 },
    { header: 'Profit', key: 'profit', width: 16 },
  ];
  for (const row of rows) {
    const sheetRow = sheet.addRow({
      ...row,
      createdAt: new Date(row.createdAt),
      orderDetails: `${row.mainTravellerName}\n${row.orderReference} · ${row.totalPassengers} Pax`,
      ticketedAt: new Date(row.ticketedAt),
    });
    sheetRow.getCell('orderDetails').alignment = { vertical: 'middle', wrapText: true };
    sheetRow.height = 30;
  }
  sheet.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF061A4D' } };
  });
  sheet.getColumn('createdAt').numFmt = 'dd-mm-yyyy hh:mm:ss';
  sheet.getColumn('ticketedAt').numFmt = 'dd-mm-yyyy hh:mm:ss';
  sheet.getColumn('grossFare').numFmt = '#,##0.00';
  sheet.getColumn('payableAmount').numFmt = '#,##0.00';
  sheet.getColumn('profit').numFmt = '#,##0.00';
  sheet.autoFilter = { from: 'A1', to: 'K1' };
  const buffer = await workbook.xlsx.writeBuffer();
  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${exportName('xlsx', agencyCode)}"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function pdfBuffer(rows: IssuedTicketRow[]): Promise<Buffer> {
  const { default: PDFDocument } = await import('pdfkit');
  return new Promise((resolve, reject) => {
    const document = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 24 });
    const chunks: Buffer[] = [];
    document.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    document.on('end', () => resolve(Buffer.concat(chunks)));
    document.on('error', reject);

    document.font('Helvetica-Bold').fontSize(15).fillColor('#061a4d')
      .text('Kaliganj Travels — Sales Report');
    document.font('Helvetica').fontSize(8).fillColor('#555555')
      .text(`Generated ${new Date().toLocaleString('en-GB')} • ${rows.length} tickets`);
    document.moveDown(0.8);

    const headers = ['Created', 'Order reference', 'PNR', 'Airline', 'Seg', 'Ticketed', 'User name', 'Cur', 'Gross fare', 'Payable amount', 'Profit'];
    const widths = [72, 135, 50, 36, 24, 72, 105, 28, 55, 60, 50];
    const drawRow = (values: string[], header = false) => {
      const rowHeight = header ? 20 : 30;
      if (document.y + rowHeight > document.page.height - 24) {
        document.addPage();
      }
      const y = document.y;
      let x = document.page.margins.left;
      if (header) document.rect(x, y, widths.reduce((sum, width) => sum + width, 0), rowHeight).fill('#061a4d');
      document.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(header ? 7 : 6.5)
        .fillColor(header ? '#ffffff' : '#222222');
      values.forEach((value, index) => {
        document.text(value, x + 3, y + 6, { width: widths[index] - 6, height: rowHeight - 8, ellipsis: true });
        x += widths[index];
      });
      document.y = y + rowHeight;
      if (!header) document.moveTo(document.page.margins.left, document.y).lineTo(x, document.y).strokeColor('#dddddd').stroke();
    };
    drawRow(headers, true);
    for (const row of rows) {
      drawRow([
        new Date(row.createdAt).toLocaleString('en-GB'),
        `${row.mainTravellerName}\n${row.orderReference} · ${row.totalPassengers} Pax`,
        row.pnr,
        row.airlineCode,
        String(row.totalSegments),
        new Date(row.ticketedAt).toLocaleString('en-GB'),
        row.bookedByName,
        row.currency,
        row.grossFare === null ? '—' : row.grossFare.toFixed(2),
        row.payableAmount.toFixed(2),
        row.profit === null ? '—' : row.profit.toFixed(2),
      ]);
    }
    document.end();
  });
}

export async function GET(request: Request) {
  try {
    const session = await getDashboardSession();
    if (!session) return walletFail(401, 'SIGN_IN_REQUIRED', 'Please sign in.');
    const url = new URL(request.url);
    const parsed = schema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) {
      return walletFail(400, 'INVALID_REPORT_FILTERS', 'Check the report filters.');
    }
    if (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to) {
      return walletFail(400, 'INVALID_DATE_RANGE', 'The start date cannot be after the end date.');
    }
    const scope = issuedTicketScopeFor(session, parsed.data.agency);
    if (!scope) {
      return walletFail(403, 'FORBIDDEN', 'Choose a B2B agency you are allowed to report on.');
    }
    const filters = filtersOf(parsed.data);
    if (parsed.data.format !== 'json') {
      const rows = await listAllIssuedTickets(scope, filters);
      if (parsed.data.format === 'xlsx') return excelResponse(rows, scope.agencyCode);
      const buffer = await pdfBuffer(rows);
      return new Response(new Uint8Array(buffer), {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="${exportName('pdf', scope.agencyCode)}"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    const [report, airlines, summary] = await Promise.all([
      listIssuedTickets(scope, filters, parsed.data.page, parsed.data.pageSize),
      listIssuedTicketAirlines(scope),
      summarizeIssuedTickets(scope, filters),
    ]);
    return walletOk({
      ...report,
      airlines,
      summary,
      page: parsed.data.page,
      pageSize: parsed.data.pageSize,
      pageCount: Math.max(1, Math.ceil(report.total / parsed.data.pageSize)),
    });
  } catch (error) {
    console.error('[issued-ticket-report] failed:', error);
    return walletFail(503, 'REPORT_UNAVAILABLE', 'The sales report is unavailable.');
  }
}
