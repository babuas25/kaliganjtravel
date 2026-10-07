import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import tailwindPostcss from '@tailwindcss/postcss';
import { twMerge } from 'tailwind-merge';

// Compile the real stylesheet: a successful JS/type check cannot catch a lost
// theme, content source, animation plugin, or changed CSS compiler defaults.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'app/globals.css');
const result = await postcss([tailwindPostcss({ base: root, optimize: false })])
  .process(await readFile(source, 'utf8'), { from: source });
const sheet = postcss.parse(result.css);

function declaration(selector, property) {
  let value;
  sheet.walkRules(selector, (rule) => {
    for (const node of rule.nodes ?? []) {
      if (node.type === 'decl' && node.prop === property) value = node.value;
    }
  });
  assert.ok(value, `${selector} must generate ${property}`);
  return value;
}

function token(property) {
  let value;
  sheet.walkDecls(property, (node) => { value = node.value; });
  assert.ok(value, `Theme must define ${property}`);
  return value;
}

assert.equal(declaration('.rounded', 'border-radius'), '0.25rem');
assert.equal(declaration('.rounded-lg', 'border-radius'), 'var(--radius)');
assert.equal(declaration('.rounded-sm', 'border-radius'), 'calc(var(--radius) - 4px)');
assert.match(declaration('.shadow-sm', '--tw-shadow'), /0 1px 2px 0 .*0\.05/);
assert.match(declaration('.shadow', '--tw-shadow'), /0 1px 3px 0 .*0\.1/);
assert.equal(declaration('.blur', '--tw-blur'), 'blur(8px)');
assert.equal(declaration('.backdrop-blur-sm', '--tw-backdrop-blur'), 'blur(4px)');
assert.match(declaration('.ring', '--tw-ring-shadow'), /calc\(3px \+/);
assert.match(declaration('.ring', '--tw-ring-shadow'), /rgb\(59 130 246 \/ 0\.5\)/);

// Text uses a readable darker orange; backgrounds keep the logo orange.
assert.equal(token('--text-color-brand-orange'), '#ad4f08');
assert.equal(declaration('.text-brand-orange', 'color'), 'var(--text-color-brand-orange)');
assert.equal(declaration('.hover\\:text-brand-orange:hover', 'color'), 'var(--text-color-brand-orange)');
assert.equal(declaration('.bg-brand-orange', 'background-color'), '#f68712');
assert.equal(token('--color-neutral-200'), '#e5e5e5');
assert.equal(token('--color-blue-500'), '#3b82f6');

// Check content classes outside JSX components and legacy animation plugins.
assert.equal(declaration('.bg-search-gradient', 'background-image'), 'linear-gradient(135deg, #fff1e2 0%, #f68712 100%)');
assert.equal(declaration('.animate-in', 'animation-name'), 'enter');
assert.equal(declaration('.dark\\:border-destructive:is(.dark *)', 'border-color'), 'hsl(var(--destructive))');
assert.equal(declaration('.bg-linear-to-r\\/srgb', '--tw-gradient-position'), 'to right');
assert.ok(result.css.includes('to right in srgb'), 'Existing gradients must keep sRGB interpolation');

let accessibleOutline = false;
sheet.walkRules('.outline-hidden', (rule) => {
  rule.walkAtRules('media', (media) => {
    if (media.params !== '(forced-colors: active)') return;
    media.walkDecls('outline', (node) => {
      if (node.value === '2px solid transparent') accessibleOutline = true;
    });
  });
});
assert.ok(accessibleOutline, 'Hidden outlines must remain visible in forced colors mode');

for (const [input, expected] of [
  ['shadow shadow-sm', 'shadow-sm'],
  ['shadow-sm shadow', 'shadow'],
  ['rounded rounded-lg', 'rounded-lg'],
  ['ring ring-2', 'ring-2'],
  ['hover:shadow hover:shadow-sm', 'hover:shadow-sm'],
  ['text-brand-orange text-red-700', 'text-red-700'],
  ['ring-ring ring-brand-orange/20', 'ring-brand-orange/20'],
  ['bg-[var(--color-bg)] bg-white', 'bg-white'],
]) assert.equal(twMerge(input), expected, `Class merge changed for ${input}`);

console.log('Tailwind compatibility checks passed: theme, controls, variants, animations, gradients, and class merging.');
