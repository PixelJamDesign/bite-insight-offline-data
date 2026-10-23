#!/usr/bin/env node

/**
 * check.js
 *
 * Quality gate for a finished build. Run it after build-offline-db.js and
 * publish only if it passes. It exits with 1 if anything is wrong.
 *
 * For every region it checks that:
 *   - the .db opens and PRAGMA integrity_check says ok
 *   - it has every products column the app reads (allergens, traces and
 *     ingredient_ids included) and a metadata table with version,
 *     product_count, region and schema
 *   - allergen data is really there: enough rows have non-NULL allergens,
 *     no row with ingredients is missing its allergens or traces, some rows
 *     list an allergen, and ingredient ids came through. The May 2026
 *     release had NULL allergens on every row; this is the check that would
 *     have stopped it.
 *   - the product count is close to the last release's: no more than 20%
 *     down or 100% up (skipped for a region the old manifest doesn't have)
 * and that manifest.json is valid and lists every .db with its real size
 * and product count.
 *
 * Usage (from scripts/offline-db):
 *   node check.js --dir output
 *   node check.js --dir output --regions gb,us     # partial test build
 *   node check.js --dir output --skip-count-compare
 *   node check.js --dir output --previous old/manifest.json
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { PRODUCT_COLUMNS, REGION_FILTERS } = require('./build-offline-db');

const PREVIOUS_MANIFEST_URL =
  'https://github.com/PixelJamDesign/bite-insight-offline-data/releases/latest/download/manifest.json';
const USER_AGENT = 'BiteInsight-dev/1.0 (hello@pixeljam.design)';

const MAX_DROP = 0.2; // fail if a region has more than 20% fewer products
const MAX_RISE = 1.0; // or more than twice as many
const MAX_FILE_BYTES = 2 * 1024 ** 3; // GitHub's limit for a release file

/**
 * Lowest share of products with non-NULL allergens, per region. Only
 * products with ingredient data get allergens, so this follows how many
 * products in Open Food Facts have ingredients. In the May 2026 build
 * that was gb 35%, us 50%, fr 32%, de 30%, es 15%, it 13%, in 29%, au 20%.
 * The floors sit at about two thirds of that, so normal drift passes and
 * missing data doesn't.
 */
const MIN_ALLERGEN_SHARE = {
  gb: 0.25,
  us: 0.35,
  fr: 0.2,
  de: 0.2,
  es: 0.1,
  it: 0.08,
  in: 0.18,
  au: 0.12,
};
const DEFAULT_MIN_ALLERGEN_SHARE = 0.1; // a region added later, until it has numbers

// Of the products with allergen data, at least this many must list one.
// Around half do; '' everywhere would mean the allergen columns went missing.
const MIN_WITH_ALLERGEN_SHARE = 0.2;
// Of the products with ingredient text, at least this many must have ids.
const MIN_IDS_PER_TEXT = 0.7;

const METADATA_KEYS = ['version', 'product_count', 'region', 'schema'];

// ── CLI ──────────────────────────────────────────────────────────────────────

function usageError(message) {
  console.error(message);
  console.error('Usage: node check.js --dir DIR [--regions gb,us] [--skip-count-compare] [--previous URL|FILE]');
  process.exit(2);
}

function parseArgs(argv) {
  const opts = {
    dir: path.join(__dirname, 'output'),
    regions: Object.keys(REGION_FILTERS),
    compareCounts: true,
    previous: PREVIOUS_MANIFEST_URL,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usageError(`${arg} needs a value.`);
      return v;
    };
    if (arg === '--dir') opts.dir = path.resolve(value());
    else if (arg === '--regions' || arg === '--region') {
      opts.regions = [...new Set(value().toLowerCase().split(',').map((c) => c.trim()).filter(Boolean))];
      if (opts.regions.length === 0) usageError('--regions needs at least one region code.');
    } else if (arg === '--skip-count-compare') opts.compareCounts = false;
    else if (arg === '--previous') opts.previous = value();
    else usageError(`Unknown option: ${arg}`);
  }
  return opts;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const pct = (x) => `${(100 * x).toFixed(1)}%`;

async function loadPreviousManifest(source) {
  if (!/^https?:\/\//.test(source)) return JSON.parse(fs.readFileSync(source, 'utf8'));
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(source, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastError = err;
      if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }
  throw new Error(`Couldn't read the last release's manifest (${source}): ${lastError.message}`);
}

/** Checks one region's database. Returns { failures, stats }. */
function checkDatabase(code, file) {
  const failures = [];
  const stats = {};
  let db;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
  } catch (err) {
    return { failures: [`can't open ${path.basename(file)}: ${err.message}`], stats };
  }
  try {
    const integrity = db.pragma('integrity_check').map((r) => r.integrity_check);
    if (integrity.length !== 1 || integrity[0] !== 'ok') {
      failures.push(`integrity_check: ${integrity.slice(0, 5).join('; ')}`);
      return { failures, stats };
    }

    const journal = db.pragma('journal_mode', { simple: true });
    if (journal !== 'delete') failures.push(`journal_mode is ${journal}, expected delete (one self-contained file)`);

    // Schema
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all());
    for (const t of ['products', 'metadata']) if (!tables.has(t)) failures.push(`no ${t} table`);
    if (failures.length) return { failures, stats };

    const columns = new Set(db.prepare('PRAGMA table_info(products)').all().map((c) => c.name));
    const missing = PRODUCT_COLUMNS.filter((c) => !columns.has(c));
    if (missing.length) {
      failures.push(`products is missing column(s): ${missing.join(', ')}`);
      return { failures, stats };
    }

    const meta = Object.fromEntries(db.prepare('SELECT key, value FROM metadata').all().map((r) => [r.key, r.value]));
    for (const key of METADATA_KEYS) if (!meta[key]) failures.push(`metadata has no ${key}`);
    if (meta.version && !/^\d{4}-\d{2}-\d{2}$/.test(meta.version)) failures.push(`metadata version "${meta.version}" isn't YYYY-MM-DD`);
    if (meta.region && meta.region !== code) failures.push(`metadata region is "${meta.region}", expected "${code}"`);
    if (meta.schema && meta.schema !== '2') failures.push(`metadata schema is "${meta.schema}", expected "2"`);

    // Counts and allergen coverage, in one pass over the table
    const c = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(allergens IS NOT NULL) AS allergens_known,
        SUM(allergens IS NOT NULL AND allergens <> '') AS with_allergen,
        SUM(traces IS NOT NULL) AS traces_known,
        SUM(ingredients_text IS NOT NULL) AS with_text,
        SUM(ingredient_ids IS NOT NULL) AS with_ids,
        SUM((ingredients_text IS NOT NULL OR ingredient_ids IS NOT NULL)
            AND (allergens IS NULL OR traces IS NULL)) AS lost,
        SUM(allergens <> '' AND allergens NOT GLOB '[a-z][a-z]:*' AND allergens NOT GLOB '[a-z][a-z][a-z]:*') AS untagged,
        SUM(barcode IS NULL OR barcode = '') AS no_barcode
      FROM products
    `).get();

    stats.total = c.total;
    stats.version = meta.version;
    stats.allergenShare = c.total ? c.allergens_known / c.total : 0;
    stats.withAllergenShare = c.allergens_known ? c.with_allergen / c.allergens_known : 0;
    stats.tracesShare = c.total ? c.traces_known / c.total : 0;
    stats.idsPerText = c.with_text ? c.with_ids / c.with_text : 0;

    if (c.total === 0) {
      failures.push('no products');
      return { failures, stats };
    }
    if (meta.product_count && Number(meta.product_count) !== c.total) {
      failures.push(`metadata product_count is ${meta.product_count} but the table has ${c.total}`);
    }
    if (c.no_barcode) failures.push(`${c.no_barcode} rows have no barcode`);

    const minShare = MIN_ALLERGEN_SHARE[code] ?? DEFAULT_MIN_ALLERGEN_SHARE;
    if (stats.allergenShare < minShare) {
      failures.push(`only ${pct(stats.allergenShare)} of products have allergen data (needs ${pct(minShare)})`);
    }
    if (c.lost) failures.push(`${c.lost} products have ingredients but NULL allergens or traces`);
    if (stats.withAllergenShare < MIN_WITH_ALLERGEN_SHARE) {
      failures.push(`only ${pct(stats.withAllergenShare)} of products with allergen data list an allergen (needs ${pct(MIN_WITH_ALLERGEN_SHARE)})`);
    }
    if (c.untagged) failures.push(`${c.untagged} rows have allergens that aren't lang:name tags`);
    if (c.with_text && stats.idsPerText < MIN_IDS_PER_TEXT) {
      failures.push(`only ${pct(stats.idsPerText)} of products with ingredients have ingredient ids (needs ${pct(MIN_IDS_PER_TEXT)})`);
    }
  } catch (err) {
    // A damaged file can throw (SQLITE_CORRUPT) before integrity_check answers.
    failures.push(`couldn't read the database: ${err.message}`);
  } finally {
    db.close();
  }
  return { failures, stats };
}

function checkManifest(dir, regions) {
  const failures = [];
  const file = path.join(dir, 'manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { failures: [`manifest.json: ${err.message}`], manifest: null };
  }
  if (!manifest || typeof manifest !== 'object') return { failures: ['manifest.json is not an object'], manifest: null };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(manifest.version || '')) failures.push(`manifest version "${manifest.version}" isn't YYYY-MM-DD`);
  if (!manifest.regions || typeof manifest.regions !== 'object') {
    failures.push('manifest has no regions');
    return { failures, manifest: null };
  }

  const listed = Object.keys(manifest.regions);
  for (const code of regions) if (!listed.includes(code)) failures.push(`manifest doesn't list ${code}`);
  for (const code of listed) if (!regions.includes(code)) failures.push(`manifest lists ${code}, which wasn't expected`);

  for (const [code, entry] of Object.entries(manifest.regions)) {
    const expectedName = `offline_${code}_products.db`;
    if (entry.filename !== expectedName) failures.push(`${code}: manifest filename is "${entry.filename}", expected ${expectedName}`);
    const dbFile = path.join(dir, expectedName);
    if (!fs.existsSync(dbFile)) {
      failures.push(`${code}: ${expectedName} is listed but not there`);
      continue;
    }
    const size = fs.statSync(dbFile).size;
    if (entry.sizeBytes !== size) failures.push(`${code}: manifest says ${entry.sizeBytes} bytes, file is ${size}`);
    if (size >= MAX_FILE_BYTES) failures.push(`${code}: ${size} bytes is over GitHub's 2 GB release file limit`);
    if (!Number.isInteger(entry.productCount) || entry.productCount <= 0) failures.push(`${code}: productCount "${entry.productCount}" isn't a positive whole number`);
    if (typeof entry.label !== 'string' || !entry.label) failures.push(`${code}: no label`);
    if (typeof entry.flag !== 'string' || !entry.flag) failures.push(`${code}: no flag`);
  }

  // Nothing else in the folder: every .db is listed, no journal files left.
  for (const name of fs.readdirSync(dir)) {
    const m = name.match(/^offline_([a-z]+)_products\.db$/);
    if (m && !listed.includes(m[1])) failures.push(`${name} is in the folder but not in the manifest`);
    if (/\.db-(wal|shm|journal)$/.test(name)) failures.push(`${name} left over: the database wasn't closed cleanly`);
  }
  return { failures, manifest };
}

function compareCounts(code, count, previous) {
  const old = previous && previous.regions && previous.regions[code];
  if (!old || !Number.isInteger(old.productCount) || old.productCount <= 0) {
    return { note: 'new region, not compared' };
  }
  const change = (count - old.productCount) / old.productCount;
  const counts = `${old.productCount.toLocaleString()} → ${count.toLocaleString()}`;
  const note = `${counts} (${change >= 0 ? '+' : ''}${pct(change)})`;
  if (change < -MAX_DROP) {
    return { note, failure: `product count fell ${pct(-change)} since ${previous.version} (${counts}), more than the ${pct(MAX_DROP)} allowed` };
  }
  if (change > MAX_RISE) {
    return { note, failure: `product count rose ${pct(change)} since ${previous.version} (${counts}), more than the ${pct(MAX_RISE)} allowed` };
  }
  return { note };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const failures = [];
  const rows = [];

  console.log(`Checking ${opts.dir}`);
  console.log(`Regions: ${opts.regions.join(', ')}\n`);

  const { failures: manifestFailures, manifest } = checkManifest(opts.dir, opts.regions);
  failures.push(...manifestFailures);

  let previous = null;
  if (opts.compareCounts) {
    try {
      previous = await loadPreviousManifest(opts.previous);
      console.log(`Comparing with the last release: ${previous.version}\n`);
    } catch (err) {
      failures.push(err.message);
    }
  } else {
    console.log('Skipping the comparison with the last release (--skip-count-compare)\n');
  }

  for (const code of opts.regions) {
    const file = path.join(opts.dir, `offline_${code}_products.db`);
    if (!fs.existsSync(file)) {
      failures.push(`${code}: no ${path.basename(file)}`);
      continue;
    }
    console.log(`${code}: checking...`);
    const { failures: dbFailures, stats } = checkDatabase(code, file);
    const entry = manifest && manifest.regions[code];
    if (entry && stats.total !== undefined && entry.productCount !== stats.total) {
      dbFailures.push(`manifest says ${entry.productCount} products, table has ${stats.total}`);
    }
    if (manifest && stats.version && stats.version !== manifest.version) {
      dbFailures.push(`metadata version ${stats.version} doesn't match the manifest's ${manifest.version}`);
    }
    let countNote = opts.compareCounts ? '' : 'skipped';
    if (previous && stats.total) {
      const result = compareCounts(code, stats.total, previous);
      countNote = result.note;
      if (result.failure) dbFailures.push(result.failure);
    }
    failures.push(...dbFailures.map((f) => `${code}: ${f}`));
    rows.push({ code, stats, countNote, ok: dbFailures.length === 0 });
  }

  // Report
  console.log('');
  const table = [
    '| Region | Products | Allergen data | Lists an allergen | Traces data | Ids per text | vs last release | Result |',
    '|---|---:|---:|---:|---:|---:|---|---|',
    ...rows.map(({ code, stats: s, countNote, ok }) => (
      `| ${code} | ${s.total !== undefined ? s.total.toLocaleString() : '-'} | ${s.allergenShare !== undefined ? pct(s.allergenShare) : '-'} | ${s.withAllergenShare !== undefined ? pct(s.withAllergenShare) : '-'} | ${s.tracesShare !== undefined ? pct(s.tracesShare) : '-'} | ${s.idsPerText !== undefined ? pct(s.idsPerText) : '-'} | ${countNote || '-'} | ${ok ? 'ok' : 'FAIL'} |`
    )),
  ].join('\n');
  console.log(table);

  const verdict = failures.length
    ? `\nFAILED: ${failures.length} problem(s). Don't publish this build.\n${failures.map((f) => `  - ${f}`).join('\n')}`
    : '\nAll checks passed.';
  console.log(verdict);

  if (process.env.GITHUB_STEP_SUMMARY) {
    const summary = `## Offline database checks\n\n${table}\n${failures.length ? `\n**Failed.** Nothing was published.\n\n${failures.map((f) => `- ${f}`).join('\n')}\n` : '\nAll checks passed.\n'}`;
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }

  process.exitCode = failures.length ? 1 : 0;
}

main().catch((err) => {
  console.error('\ncheck.js crashed:', err);
  process.exitCode = 1;
});
