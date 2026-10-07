# Next ESLint directory-glob adapter

This private MIT package replaces only the `fast-glob` dependency of
`@next/eslint-plugin-next`. All upstream Next.js lint rules remain installed.
The plugin currently calls only `globSync(rootDir, { onlyDirectories: true })`;
other options and APIs are deliberately rejected rather than silently ignored.

The adapter uses released `tinyglobby` 0.2.17, `picomatch` 4.0.4, and the patched
`brace-expansion` 5.0.12, eliminating
the unpatched `micromatch -> braces` dependency chain. It disables automatic
directory expansion, pre-expands brace alternatives and ranges, preserves exact/relative/absolute directory spelling,
normalizes dynamic result slashes, excludes terminal globstar bases, and retains
directory symlinks that tinyglobby traverses but does not emit. Dangling and
self-referential symlinks are ignored without discarding their valid siblings.
A length and
nesting guard rejects excessive patterns before parsing. More than 1,000 expanded
patterns are rejected instead of silently losing directory matches.

Run `node scripts/verify-next-eslint-root-dirs.mjs` after installation. Before an
override is installed, pass `--adapter /absolute/path/to/adapter` to compare the
candidate against independent expectations captured from Next 16.3.6 with
fast-glob 3.3.1. The verifier also checks that an internal-link lint violation is
still reported with the recommended and Core Web Vitals rules.

This is a narrow compatibility adapter, not a full fast-glob implementation.
It targets POSIX paths and this project's Node.js 24 runtime. New Next plugin
calls or versions must be checked against the documented contract. Remove the
override when an upstream plugin adopts a dependency without this advisory.

Sources:

- https://github.com/vercel/next.js/blob/v16.3.6/packages/eslint-plugin-next/src/utils/get-root-dirs.ts
- https://github.com/SuperchupuDev/tinyglobby
- https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
