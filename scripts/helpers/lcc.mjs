import fs from 'node:fs';
import ts from 'typescript';

// Use the production carrier catalog and classifier in isolated pricing tests.
const source = fs.readFileSync(new URL('../../lib/airlines/lcc.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const module = { exports: {} };
Function('require', 'module', 'exports', compiled)((id) => {
  throw new Error(`Unexpected LCC classifier dependency: ${id}`);
}, module, module.exports);
export const lccModule = module.exports;
