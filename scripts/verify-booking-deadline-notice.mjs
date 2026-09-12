import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const code = ts.transpileModule(fs.readFileSync('components/flights/BookingDeadlineNotice.tsx', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const module = { exports: {} };
new Function('exports', 'require', code)(module.exports, (name) => {
  if (name === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }) };
  throw new Error(`Unexpected import ${name}`);
});
const render = (deadline) => module.exports.BookingDeadlineNotice({ deadline, bookingReference: 'STR260906000005' });
assert.match(render('2026-09-07T07:40:00+00:00').props.children, /7 Sept 2026, 13:40/);
assert.match(render('2026-09-07T07:40:00+00:00').props.children, /Bangladesh time/);
assert.match(render('2020-09-07T07:40:00Z').props.children, /Issue before:/);
assert.match(render(null).props.children, /Awaiting the supplier/);
assert.match(render('invalid').props.children, /Awaiting the supplier/);
assert.doesNotMatch(code, /setInterval|router\.refresh/,
  'The notice must not interrupt the supplier acquisition controller with page reloads');
console.log('Deadline timezone, missing-state copy and single refresh-controller ownership passed.');
