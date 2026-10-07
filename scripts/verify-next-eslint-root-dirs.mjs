import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { ESLint } from 'eslint';
import nextPlugin from '@next/eslint-plugin-next';

const require = createRequire(import.meta.url);
const utilityPath = require.resolve('@next/eslint-plugin-next/dist/utils/get-root-dirs.js');
const { getRootDirs } = require(utilityPath);
const fixture = mkdtempSync(path.join(tmpdir(), 'next-eslint-roots-'));
const previousCwd = process.cwd();

// Expected paths were captured from the real 16.3.6 Next utility using fast-glob
// 3.3.1. Keep these expectations independent of any replacement glob library.
const cases = [
  ['default root', undefined, () => [fixture]],
  ['exact directory', 'apps/web', () => ['apps/web']],
  ['explicit current directory', '.', () => ['.']],
  ['explicit relative prefix', './apps/web', () => ['./apps/web']],
  ['exact directory trailing slash', 'apps/web/', () => ['apps/web/']],
  ['single wildcard with symlink', 'apps/*', () => ['apps/admin', 'apps/alias', 'apps/web']],
  ['brace alternatives', 'apps/{web,admin}', () => ['apps/admin', 'apps/web']],
  ['numeric brace range', 'packages/app{1..2}', () => ['packages/app1', 'packages/app2']],
  ['multiple digit numeric brace range', 'packages/app{1..11}', () => ['packages/app1', 'packages/app2', 'packages/app10', 'packages/app11']],
  ['stepped numeric brace range', 'packages/app{1..11..2}', () => ['packages/app1', 'packages/app11']],
  ['extglob alternatives', 'packages/+(alpha|beta)', () => ['packages/alpha', 'packages/beta']],
  ['wildcard excludes hidden directories', 'packages/*', () => ['packages/alpha', 'packages/app1', 'packages/app10', 'packages/app11', 'packages/app2', 'packages/beta']],
  ['explicit hidden directory wildcard', 'packages/.*', () => ['packages/.hidden']],
  ['exact hidden directory', 'packages/.hidden', () => ['packages/.hidden']],
  ['exact symlink directory', 'apps/alias', () => ['apps/alias']],
  ['dangling symlink is excluded', 'apps/dangling', () => []],
  ['globstar traverses symlinks and excludes its base', 'apps/**', () => [
    'apps/admin', 'apps/admin/pages', 'apps/alias', 'apps/alias/app',
    'apps/alias/app/about', 'apps/web', 'apps/web/app', 'apps/web/app/about',
  ]],
  ['globstar with trailing slash', 'packages/**/', () => ['packages/alpha', 'packages/app1', 'packages/app10', 'packages/app11', 'packages/app2', 'packages/beta']],
  ['static brace paths retain trailing slash', 'apps/{web,alias}/', () => ['apps/web/', 'apps/alias/']],
  ['globstar brace alternative', 'apps/{**,web}', () => [
    'apps/admin', 'apps/admin/pages', 'apps/alias', 'apps/alias/app',
    'apps/alias/app/about', 'apps/web', 'apps/web/app', 'apps/web/app/about',
  ]],
  ['globstar followed by directory', 'apps/**/app', () => ['apps/alias/app', 'apps/web/app']],
  ['explicit symlink globstar', 'apps/alias/**', () => ['apps/alias/app', 'apps/alias/app/about']],
  ['negative pattern alone', '!apps/admin', () => []],
  ['negative brace branch filters positive branch', '{apps/*,!apps/admin}', () => ['apps/alias', 'apps/web']],
  ['negated extglob', 'apps/!(admin)', () => ['apps/alias', 'apps/web']],
  ['rootDir array ignores nonstrings', ['apps/web', 42, null, 'apps/admin'], () => ['apps/admin', 'apps/web']],
  ['rootDir array preserves duplicate matches', ['apps/web', 'apps/web'], () => ['apps/web', 'apps/web']],
  // Next processes rootDir array items independently; a negative item is not an
  // ignore filter for another item. There is no glob-options ignore setting here.
  ['negative array item does not filter earlier matches', ['apps/*', '!apps/admin'], () => ['apps/admin', 'apps/alias', 'apps/web']],
  ['unmatched directory', 'does-not-exist', () => []],
  ['unsupported rootDir value uses default', 42, () => [fixture]],
  ['backslash separators normalized by Next', 'apps\\web', () => ['apps/web']],
  ['absolute root', () => path.join(fixture, 'apps/web'), () => [path.join(fixture, 'apps/web')]],
  ['absolute glob', () => path.join(fixture, 'apps/*'), () => ['admin', 'alias', 'web'].map((name) => path.join(fixture, 'apps', name))],
];

function verifyUtility(utility, label) {
  for (const [name, rootDirValue, expected] of cases) {
    const rootDir = typeof rootDirValue === 'function' ? rootDirValue() : rootDirValue;
    const settings = rootDir === undefined ? {} : { next: { rootDir } };
    assert.deepEqual(Array.from(utility({ cwd: fixture, settings })).sort(), expected().sort(), `${label}: ${name}`);
  }
}

function verifyAdapterContract(adapter) {
  assert.deepEqual(adapter.globSync('apps/loop', { onlyDirectories: true }), [], 'A self-referential symlink is not a directory');
  assert.throws(() => adapter.globSync('apps/*', { onlyDirectories: true, ignore: ['apps/admin'] }), TypeError);
  assert.throws(() => adapter.globSync(['apps/*'], { onlyDirectories: true }), TypeError);
  assert.throws(() => adapter.globSync('apps/*'), TypeError);
  assert.throws(() => adapter.globSync('{'.repeat(101) + 'a,b' + '}'.repeat(101), { onlyDirectories: true }), SyntaxError);
  assert.throws(() => adapter.globSync('a'.repeat(10001), { onlyDirectories: true }), SyntaxError);
  assert.throws(() => adapter.globSync('{a,b}'.repeat(10), { onlyDirectories: true }), SyntaxError);
}

try {
  for (const directory of ['apps/web/app/about', 'apps/admin/pages', 'packages/alpha', 'packages/beta', 'packages/.hidden', 'packages/app1', 'packages/app2', 'packages/app10', 'packages/app11']) {
    mkdirSync(path.join(fixture, directory), { recursive: true });
  }
  writeFileSync(path.join(fixture, 'apps/web/app/about/page.jsx'), 'export default function Page() { return <main />; }\n');
  writeFileSync(path.join(fixture, 'apps/admin/pages/about.jsx'), 'export default function Page() { return <main />; }\n');
  symlinkSync('web', path.join(fixture, 'apps/alias'), 'dir');
  // These links must not discard sibling matches when tinyglobby reads apps/*.
  symlinkSync('loop', path.join(fixture, 'apps/loop'), 'dir');
  symlinkSync('missing-directory', path.join(fixture, 'apps/dangling'), 'dir');
  process.chdir(fixture);

  verifyUtility(getRootDirs, 'installed Next utility');

  // Optional pre-install adapter comparison uses the real installed utility
  // source and changes only its require("fast-glob") dependency in this VM.
  for (const flag of ['--baseline', '--adapter']) {
    const adapterFlagIndex = process.argv.indexOf(flag);
    if (adapterFlagIndex === -1) continue;
    const adapterPath = process.argv[adapterFlagIndex + 1];
    assert.ok(adapterPath, `${flag} requires a path`);
    const adapter = require(path.resolve(previousCwd, adapterPath));
    const exports = {};
    runInNewContext(readFileSync(utilityPath, 'utf8'), {
      exports,
      require(name) {
        assert.equal(name, 'fast-glob', 'Next utility added a dependency; review adapter contract');
        return adapter;
      },
    }, { filename: utilityPath });
    verifyUtility(exports.getRootDirs, flag === '--baseline' ? 'original glob baseline' : 'candidate adapter');
    if (flag === '--adapter') verifyAdapterContract(adapter);
  }

  const globRequire = createRequire(utilityPath);
  if (globRequire('fast-glob/package.json').name === '@kaliganj/next-eslint-glob-adapter') {
    verifyAdapterContract(globRequire('fast-glob'));
  }

  const eslint = new ESLint({
    cwd: fixture,
    overrideConfigFile: true,
    overrideConfig: [{
      files: ['**/*.jsx'],
      languageOptions: { ecmaVersion: 'latest', sourceType: 'module', parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { '@next/next': nextPlugin },
      settings: { next: { rootDir: 'apps/{web,admin}' } },
      rules: { ...nextPlugin.configs.recommended.rules, ...nextPlugin.configs['core-web-vitals'].rules },
    }],
  });
  const [result] = await eslint.lintText('export default function Page() { return <a href="/about">About</a>; }', { filePath: 'probe.jsx' });
  assert.ok(result.messages.some((message) => message.ruleId === '@next/next/no-html-link-for-pages'), 'Next internal-link safeguard must remain enabled and find the fixture route');
  console.log(`Next ESLint root-directory verification passed: ${cases.length} cases and internal-link safeguard.`);
} finally {
  process.chdir(previousCwd);
  rmSync(fixture, { recursive: true, force: true });
}
