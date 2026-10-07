'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { expand } = require('brace-expansion');
const picomatch = require('picomatch');
const { globSync: tinyGlobSync, isDynamicPattern } = require('tinyglobby');

function isDirectory(directory) {
  try { return fs.statSync(directory).isDirectory(); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'ELOOP') return false;
    throw error;
  }
}

function globSync(pattern, options) {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    throw new TypeError('Next ESLint rootDir must be a nonempty glob string');
  }
  if (!options || options.onlyDirectories !== true || Object.keys(options).some((key) => key !== 'onlyDirectories')) {
    throw new TypeError('Next ESLint adapter supports only globSync(pattern, { onlyDirectories: true })');
  }
  if (pattern.length > 10000) throw new SyntaxError('Next ESLint rootDir exceeds 10000 characters');
  let depth = 0;
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '\\') { index += 1; continue; }
    if ('{(['.includes(character) && ++depth > 100) throw new SyntaxError('Next ESLint rootDir nesting exceeds 100');
    if ('})]'.includes(character)) depth = Math.max(0, depth - 1);
  }
  const patterns = expand(pattern, { max: 1001, maxDepth: 100 });
  if (patterns.length > 1000) throw new SyntaxError('Next ESLint rootDir expands to more than 1000 patterns');
  const isNegative = (value) => value.startsWith('!') && !value.startsWith('!(');
  const exclude = patterns.filter(isNegative).map((value) => picomatch(value.slice(1), { dot: false, posix: true }));
  const matches = patterns.filter((value) => !isNegative(value)).flatMap(matchDirectoryPattern);
  return [...new Set(matches)].filter((value) => !exclude.some((matcher) => matcher(value.replace(/^\.\//, '').replace(/\/$/, ''))));
}

function matchDirectoryPattern(pattern) {
  if (!isDynamicPattern(pattern)) return isDirectory(pattern) ? [pattern] : [];

  // fast-glob excludes the base of a terminal globstar and does not retain a
  // trailing slash on dynamic results. tinyglobby otherwise includes that base.
  let globPattern = pattern.replace(/\/$/, '');
  globPattern = globPattern === '**' ? '**/*' : globPattern.replace(/\/\*\*$/, '/**/*');
  const absolute = path.isAbsolute(globPattern);
  const explicitRelativePrefix = globPattern.startsWith('./');
  const symlinkDirectories = new Set();
  const matches = tinyGlobSync(globPattern, {
    absolute,
    onlyDirectories: true,
    expandDirectories: false,
    fs: {
      readdirSync(directory, readOptions) {
        const entries = fs.readdirSync(directory, readOptions);
        // fdir traverses directory symlinks but omits the link itself. Capture
        // those entries during its normal crawl without a second traversal.
        if (readOptions && readOptions.withFileTypes) {
          for (const entry of entries) {
            if (entry.isSymbolicLink()) {
              const fullPath = path.resolve(directory, entry.name);
              if (isDirectory(fullPath)) symlinkDirectories.add(fullPath);
            }
          }
        }
        return entries;
      },
    },
  });
  const matcher = picomatch(globPattern, { dot: false, posix: true });
  for (const directory of symlinkDirectories) {
    const candidate = absolute ? directory : path.relative(process.cwd(), directory);
    if (matcher(candidate)) matches.push(candidate);
  }
  return [...new Set(matches.map((directory) => {
    const normalized = directory === '/' ? directory : directory.replace(/\/$/, '');
    return explicitRelativePrefix && normalized !== '.' ? `./${normalized}` : normalized;
  }))];
}

module.exports = { globSync };
