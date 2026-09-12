import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../../lib/flights/airline-pnr.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const exports = {};
new Function('exports', compiled)(exports);
export const airlinePnrModule = exports;
