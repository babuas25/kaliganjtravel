import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ZipArchive } from 'archiver';
import ExcelJS from 'exceljs';
import { ESLint } from 'eslint';
import nodemailer from 'nodemailer';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import ts from 'typescript';
import { z } from 'zod';

// Disposable files, in-memory archives and stream-only mail. Never read local
// environment files, contact an application/database, or open an SMTP transport.
globalThis.fetch = () => { throw new Error('Network access is forbidden in this verifier'); };
const require = createRequire(import.meta.url);
const fixture = mkdtempSync(path.join(tmpdir(), 'dependency-compatibility-'));

function loadProduction(file, dependencies = {}) {
  const code = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const exports = {};
  new Function('exports', 'require', code)(exports, (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `Unexpected production dependency: ${name}`);
    return dependencies[name];
  });
  return exports;
}

async function verifyGlobConsumers() {
  const eslint = new ESLint({
    cwd: fixture,
    overrideConfigFile: true,
    overrideConfig: [
      { ignores: ['src/generated/**'] },
      {
        files: ['src/**/*.{ts,tsx}'],
        languageOptions: { parser: tsParser },
        plugins: { '@typescript-eslint': tsPlugin },
        rules: { '@typescript-eslint/no-unused-vars': 'error' },
      },
    ],
  });
  const [result] = await eslint.lintText('const used: number = 1; void used; const unused: string = "value";', {
    filePath: 'src/nested/report.ts',
  });
  assert.equal(result.fatalErrorCount, 0);
  assert.equal(result.errorCount, 1);
  assert.equal(result.messages[0].ruleId, '@typescript-eslint/no-unused-vars');
  assert.match(result.messages[0].message, /unused/);
  assert.equal(await eslint.isPathIgnored(path.join(fixture, 'src/generated/report.ts')), true);
  assert.equal(await eslint.isPathIgnored(path.join(fixture, 'src/nested/report.ts')), false);

  for (const [name, content] of Object.entries({
    'reports/issued.csv': 'reference,total\nKTT-SYNTHETIC,500.25\n',
    'reports/nested/summary.json': '{"synthetic":true}',
    'reports/private.csv': 'excluded',
    'reports/.hidden.csv': 'excluded',
    'reports/notes.txt': 'excluded',
  })) {
    mkdirSync(path.dirname(path.join(fixture, name)), { recursive: true });
    writeFileSync(path.join(fixture, name), content);
  }

  // Archiver's glob integration reaches readdir-glob and its overridden
  // minimatch dependency. Read the finished archive with a different library.
  const archive = new ZipArchive({ zlib: { level: 1 } });
  const chunks = [];
  archive.on('data', (chunk) => chunks.push(chunk));
  const ended = once(archive, 'end');
  archive.glob('reports/**/*.{csv,json}', {
    cwd: fixture, ignore: ['**/private.csv'], nodir: true,
  });
  await Promise.all([archive.finalize(), ended]);
  const JSZip = createRequire(require.resolve('exceljs'))('jszip');
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  assert.deepEqual(Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort(), [
    'reports/issued.csv', 'reports/nested/summary.json',
  ]);
  assert.equal(await zip.file('reports/issued.csv').async('string'), 'reference,total\nKTT-SYNTHETIC,500.25\n');
}

async function verifyActualSalesExport() {
  const row = {
    createdAt: '2026-11-03T04:00:00.000Z', ticketedAt: '2026-11-03T04:05:00.000Z',
    mainTravellerName: 'Synthetic Traveller', orderReference: 'KTT-SYNTHETIC', totalPassengers: 2,
    pnr: 'ABC123', airlineCode: 'BG', totalSegments: 2, bookedByName: 'Synthetic Agent',
    currency: 'BDT', grossFare: 600.5, payableAmount: 500.25, profit: 100.25,
  };
  let reads = 0;
  const route = loadProduction('app/api/reports/issued-tickets/route.ts', {
    zod: { z },
    exceljs: ExcelJS,
    '@/lib/agency': loadProduction('lib/agency.ts'),
    '@/lib/dashboard/session': { getDashboardSession: async () => ({ clerkId: 'synthetic-admin', role: 'admin' }) },
    '@/lib/reports/issued-tickets': {
      issuedTicketScopeFor: () => ({ agencyCode: 'ST-B2B123456' }),
      listAllIssuedTickets: async (scope, filters) => {
        assert.equal(scope.agencyCode, 'ST-B2B123456');
        assert.deepEqual(filters, { from: '2026-11-01', to: '2026-11-03' });
        reads++;
        return [row];
      },
    },
    '@/lib/wallet/http': {
      walletFail: (status, code) => Response.json({ code }, { status }),
      walletOk: (data) => Response.json(data),
    },
  });
  const response = await route.GET(new Request('http://localhost/api/reports/issued-tickets?format=xlsx&from=2026-11-01&to=2026-11-03'));
  assert.equal(response.status, 200);
  assert.equal(reads, 1);
  assert.equal(response.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(response.headers.get('content-disposition'), /sales-report-ST-B2B123456-.*\.xlsx/);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  const sheet = workbook.getWorksheet('Sales Report');
  assert.ok(sheet, 'The real sales export must remain a readable XLSX workbook');
  assert.equal(sheet.rowCount, 2);
  assert.deepEqual(sheet.getRow(2).values.slice(1), [
    new Date(row.createdAt), 'Synthetic Traveller\nKTT-SYNTHETIC · 2 Pax', 'ABC123', 'BG', 2,
    new Date(row.ticketedAt), 'Synthetic Agent', 'BDT', 600.5, 500.25, 100.25,
  ]);
  assert.equal(sheet.getCell('B2').alignment.wrapText, true);
  assert.equal(sheet.getCell('J2').numFmt, '#,##0.00');
  assert.equal(sheet.getCell('A1').font.bold, true);
  assert.equal(sheet.views[0].state, 'frozen');
  assert.equal(sheet.views[0].ySplit, 1);
  assert.equal(sheet.autoFilter, 'A1:K1');
}

async function verifyMailEnvelope() {
  // Nodemailer's built-in stream transport deliberately preserves BCC headers.
  // Consume the standard compiled message directly, as SMTP does, without
  // changing MIME defaults or opening any connection.
  const transport = nodemailer.createTransport({
    name: 'synthetic-memory', version: '1',
    send(mail, done) {
      const envelope = mail.message.getEnvelope();
      const chunks = [];
      const stream = mail.message.createReadStream();
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.once('error', done);
      stream.once('end', () => done(null, { envelope, message: Buffer.concat(chunks) }));
    },
  });
  try {
    // A nested comment must not become a second/different delivery recipient.
    // This is the address-parser regression described in GHSA-8c8m-p3m8-cjg8.
    const regression = await transport.sendMail({
      from: 'sender@example.invalid',
      to: 'Victim (x(y) <attacker@example.invalid>) <victim@example.invalid>',
      subject: 'Synthetic address-parser regression', text: 'No network delivery.',
    });
    assert.deepEqual(regression.envelope.to, ['victim@example.invalid']);

    const ordinary = await transport.sendMail({
      from: { name: 'Synthetic Agency', address: 'sender@example.invalid' },
      to: 'passenger@example.invalid', bcc: 'archive@example.invalid',
      subject: 'Synthetic booking receipt', text: 'Booking KTT-SYNTHETIC',
      html: '<p>Booking KTT-SYNTHETIC</p>',
      attachments: [{ filename: 'receipt.txt', content: Buffer.from('Synthetic receipt only') }],
    });
    assert.deepEqual(ordinary.envelope.to, ['passenger@example.invalid', 'archive@example.invalid']);
    const message = ordinary.message.toString('utf8');
    assert.match(message, /^To: passenger@example\.invalid\r?$/m);
    assert.doesNotMatch(message, /^Bcc:/mi);
    assert.doesNotMatch(message, /archive@example\.invalid/);
    assert.match(message, /multipart\/mixed/);
    assert.match(message, /filename=receipt\.txt/);
    assert.match(message, /U3ludGhldGljIHJlY2VpcHQgb25seQ==/);
  } finally {
    transport.close();
  }
}

try {
  await verifyGlobConsumers();
  await verifyActualSalesExport();
  await verifyMailEnvelope();
  console.log('PASS dependency security compatibility: real ESLint/TypeScript glob selection, Archiver glob ZIP contents, production sales-export XLSX round trip, Nodemailer recipient regression and private BCC/attachment stream; no network, database or email delivery.');
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
