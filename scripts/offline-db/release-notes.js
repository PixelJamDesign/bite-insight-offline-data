#!/usr/bin/env node

/**
 * release-notes.js
 *
 * Prints the release notes for a checked build, from its manifest.json.
 *
 *   node release-notes.js --dir output > notes.md
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dirIdx = args.indexOf('--dir');
const dir = path.resolve(dirIdx !== -1 && args[dirIdx + 1] ? args[dirIdx + 1] : path.join(__dirname, 'output'));
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));

const built = new Date(`${manifest.version}T00:00:00Z`).toLocaleDateString('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

const rows = Object.values(manifest.regions).map(
  (r) => `| ${r.flag} ${r.label} | ${r.productCount.toLocaleString('en-GB')} | ${(r.sizeBytes / (1024 * 1024)).toFixed(1)} MB |`,
);

process.stdout.write(`Built from the Open Food Facts export on ${built}.

| Region | Products | Size |
|---|---:|---:|
${rows.join('\n')}

Checked with scripts/offline-db/check.js before publishing, including that the allergen data is there.

Product data © Open Food Facts contributors, available under the [Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/1-0/).
`);
