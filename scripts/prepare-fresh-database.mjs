import fs from 'node:fs';
import path from 'node:path';
import { prepareFreshDatabase, root, expectedProjectRef, hash, artifactPath } from './helpers/fresh-database.mjs';

// Local files only: intentionally does not load .env, connect, link, or deploy.
const target = path.join(root, 'supabase/fresh-install');
if (fs.existsSync(path.join(target, 'installation.json'))) {
  throw new Error('This baseline has been installed. Keep it immutable and add a new forward migration instead.');
}
const { sql, manifest } = prepareFreshDatabase();
fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
fs.writeFileSync(artifactPath, sql);
fs.writeFileSync(path.join(target, 'manifest.json'), JSON.stringify({
  expectedProjectRef, sqlSha256: hash(sql), migrations: manifest,
}, null, 2) + '\n');
console.log(`Prepared ${manifest.length} source migrations for a new empty database. No database connection made.`);
