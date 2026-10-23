#!/usr/bin/env node

/**
 * build-offline-db.js
 *
 * Streams the Open Food Facts CSV export and builds lean SQLite databases
 * for offline barcode scanning, one per supported region.
 *
 * This copy, in PixelJamDesign/bite-insight-offline-data, is the source of
 * truth. The GitHub Action in .github/workflows/offline-db.yml runs it every
 * month, checks the result with check.js and publishes the release. The
 * copy that used to live in the app repo is retired; change this one.
 *
 * Usage (from scripts/offline-db, after `npm ci`):
 *   node build-offline-db.js                      # all regions, one pass
 *   node build-offline-db.js --region gb          # one region
 *   node build-offline-db.js --region gb,us       # a few regions
 *   node build-offline-db.js --limit 2000         # test run: stop each region
 *                                                 # after 2000 products
 *   node build-offline-db.js --out /tmp/offline   # write somewhere else
 *   node build-offline-db.js --source URL         # another copy of the export
 *
 * Output (default scripts/offline-db/output):
 *   offline_{code}_products.db   SQLite database per region
 *   manifest.json                what the app reads first
 *
 * The app (lib/offlineDatabase.ts) reads manifest.json from
 * releases/latest/download, then downloads offline_{code}_products.db and
 * reads `version` and `product_count` from its metadata table.
 *
 * Columns come from the OFF CSV export, which has no allergens_tags,
 * ingredients_text_en or lang columns: allergens are built from
 * allergens_en + allergens, traces from traces_tags, ingredient_ids from
 * ingredients_tags, off_lang from the ingredient tags. NULL allergens/traces
 * means unknown, '' means none.
 * Dry-run the row mapping with require('./build-offline-db').extractRow.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const zlib = require('zlib');
const { pipeline } = require('stream');
const { parse } = require('csv-parse');
const Database = require('better-sqlite3');

// ── Config ───────────────────────────────────────────────────────────────────
const CSV_URL =
  'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz';
const USER_AGENT = 'BiteInsight-dev/1.0 (hello@pixeljam.design)';
const DEFAULT_OUTPUT_DIR = path.join(__dirname, 'output');
const BATCH_SIZE = 5000;
// Give up if the export stops sending data for this long.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// ── Region definitions ───────────────────────────────────────────────────────
const REGION_FILTERS = {
  gb: {
    label: 'United Kingdom',
    flag: '🇬🇧',
    tags: ['en:united-kingdom', 'en:uk', 'en:great-britain'],
  },
  us: {
    label: 'United States',
    flag: '🇺🇸',
    tags: ['en:united-states', 'en:us'],
  },
  fr: {
    label: 'France',
    flag: '🇫🇷',
    tags: ['en:france'],
  },
  de: {
    label: 'Germany',
    flag: '🇩🇪',
    tags: ['en:germany'],
  },
  es: {
    label: 'Spain',
    flag: '🇪🇸',
    tags: ['en:spain'],
  },
  it: {
    label: 'Italy',
    flag: '🇮🇹',
    tags: ['en:italy'],
  },
  in: {
    label: 'India',
    flag: '🇮🇳',
    tags: ['en:india'],
  },
  au: {
    label: 'Australia',
    flag: '🇦🇺',
    tags: ['en:australia'],
  },
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const get = url.startsWith('https') ? https.get : http.get;
    const req = get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects from ${url}`));
          return;
        }
        const next = new URL(res.headers.location, url).toString();
        console.log(`  ↳ Redirecting to ${next}`);
        download(next, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        res.resume();
        return;
      }
      const size = Number(res.headers['content-length']);
      if (size) console.log(`  Size: ${(size / (1024 * 1024)).toFixed(0)} MB compressed`);
      resolve(res);
    });
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`No data from ${url} for ${IDLE_TIMEOUT_MS / 1000}s`));
    });
    req.on('error', reject);
  });
}

/** Check which regions a product belongs to. Returns array of matching region codes. */
function matchRegions(countriesTags, regionCodes) {
  if (!countriesTags) return [];
  const lower = countriesTags.toLowerCase();
  const matches = [];
  for (const code of regionCodes) {
    const filter = REGION_FILTERS[code];
    if (filter.tags.some((tag) => lower.includes(tag))) {
      matches.push(code);
    }
  }
  return matches;
}

/** Parse a numeric field, returning null if empty or NaN. */
function num(val) {
  if (val === '' || val === undefined || val === null) return null;
  const n = parseFloat(val);
  return Number.isNaN(n) ? null : n;
}

/** Return a string or null if empty. */
function str(val) {
  if (val === '' || val === undefined || val === null) return null;
  return val;
}

/** Split an OFF list column ("a,b, c") into trimmed, non-empty entries. */
function list(val) {
  if (!str(val)) return [];
  return String(val).split(',').map((v) => v.trim()).filter(Boolean);
}

/**
 * OFF allergen / trace names or tags as tags, the form the app's matcher
 * and the live API use: 'milk' -> 'en:milk', 'Sulphur dioxide and
 * sulphites' -> 'en:sulphur-dioxide-and-sulphites', 'de:Hühnereiweiss'
 * -> 'de:hühnereiweiss'. Names without a prefix are English (they come
 * from the *_en columns).
 */
function toTags(...lists) {
  const out = [];
  for (const entry of lists.flat()) {
    const lower = entry.toLowerCase();
    const m = lower.match(/^([a-z]{2,3}):(.+)$/);
    const lang = m ? m[1] : 'en';
    const name = (m ? m[2] : lower).trim().replace(/[\s_]+/g, '-');
    if (!name) continue;
    const tag = `${lang}:${name}`;
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/**
 * Parent tags in ingredients_tags that read as an allergen but group
 * products that don't have it: en:nut is a parent of peanut, en:modified-
 * starch of modified corn starch, en:wholemeal-flour of brown rice flour.
 * Real tree nuts and wheat still come through their own ids, the
 * allergen tags and the text.
 */
const MISLEADING_PARENT_TAGS = new Set(['en:nut', 'en:nut-paste', 'en:modified-starch', 'en:wholemeal-flour']);

/**
 * The ingredient text's language. The CSV has no lang/lc column. OFF
 * tags ingredients it couldn't map to its taxonomy with the text's own
 * language ('fr:sirop-de-glucose'), so the most common non-English
 * prefix gives it away. When every ingredient was recognised we can't
 * tell, and fall back to 'en' as before.
 */
function textLanguage(ingredientTags) {
  const counts = {};
  for (const tag of ingredientTags) {
    const m = tag.match(/^([a-z]{2}):/);
    if (m && m[1] !== 'en') counts[m[1]] = (counts[m[1]] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : 'en';
}

/** Check if a product meets the quality threshold. */
function meetsQualityThreshold(record) {
  // Must have a barcode
  if (!str(record.code)) return false;

  // Must have a product name (minimum for user identification)
  const name =
    str(record.product_name) ||
    str(record.product_name_en) ||
    str(record.abbreviated_product_name) ||
    str(record.generic_name);
  if (!name) return false;

  // Everything else (nutrition, completeness) is optional — products
  // without nutrition data can still be identified when scanned offline.
  return true;
}

const CREATE_TABLE_SQL = `
  CREATE TABLE products (
    barcode               TEXT PRIMARY KEY,
    product_name          TEXT NOT NULL DEFAULT '',
    brand                 TEXT,
    image_url             TEXT,
    quantity              TEXT,
    nutriscore_grade      TEXT,
    energy_kcal           REAL,
    carbs                 REAL,
    sugars                REAL,
    fiber                 REAL,
    fat                   REAL,
    saturated_fat         REAL,
    proteins              REAL,
    salt                  REAL,
    serving_size          TEXT,
    energy_kcal_serving   REAL,
    carbs_serving         REAL,
    sugars_serving        REAL,
    fiber_serving         REAL,
    fat_serving           REAL,
    saturated_fat_serving REAL,
    proteins_serving      REAL,
    salt_serving          REAL,
    ingredients_text      TEXT,
    allergens             TEXT,
    traces                TEXT,
    ingredients_json      TEXT,
    ingredient_ids        TEXT,
    off_lang              TEXT
  );

  CREATE TABLE metadata (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`;

/** The products columns, in table order. check.js makes sure every one is there. */
const PRODUCT_COLUMNS = [
  ...CREATE_TABLE_SQL.split('CREATE TABLE metadata')[0].matchAll(/^\s+([a-z_]+)\s+(?:TEXT|REAL)\b/gm),
].map((m) => m[1]);

const INSERT_SQL = `
  INSERT OR IGNORE INTO products (
    barcode, product_name, brand, image_url, quantity, nutriscore_grade,
    energy_kcal, carbs, sugars, fiber, fat, saturated_fat, proteins, salt,
    serving_size, energy_kcal_serving, carbs_serving, sugars_serving,
    fiber_serving, fat_serving, saturated_fat_serving, proteins_serving, salt_serving,
    ingredients_text, allergens, traces, ingredients_json,
    ingredient_ids, off_lang
  ) VALUES (
    ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?, ?, ?, ?,
    ?, ?, ?, ?,
    ?, ?
  )
`;

/** Extract a product row array from a CSV record. */
function extractRow(record) {
  const barcode = str(record.code);
  if (!barcode) return null;

  const productName =
    str(record.product_name) ||
    str(record.product_name_en) ||
    str(record.abbreviated_product_name) ||
    str(record.generic_name) ||
    '';

  const ingredientsText = str(record.ingredients_text);
  const ingredientTags = toTags(list(record.ingredients_tags));
  // Allergens and traces are worked out from the ingredients. With no
  // ingredient data at all we don't know them: store NULL, which the app
  // reads as "couldn't check". With data, '' means none.
  const hasIngredientData = !!ingredientsText || ingredientTags.length > 0;
  // allergens_en is OFF's full computed list ('gluten,milk'); 'allergens'
  // is often only the part typed in by hand ('en:milk'). Take both.
  const allergens = toTags(list(record.allergens_en), list(record.allergens));
  const tracesList = list(record.traces_tags).length > 0
    ? toTags(list(record.traces_tags), list(record.traces))
    : toTags(list(record.traces_en), list(record.traces));
  const knownOrNull = (tags) => (tags.length > 0 ? tags.join(',') : hasIngredientData ? '' : null);
  // OFF ingredient ids for the app's id matching, kept light: a comma
  // list with the 'en:' prefix dropped ('skimmed-milk-powder,fr:x').
  // The app turns it into ingredients JSON when it reads the row.
  // ingredients_tags also lists parent tags ('dairy' for skimmed milk
  // powder), which only widens the checks.
  const ingredientIds = ingredientTags
    .filter((t) => !MISLEADING_PARENT_TAGS.has(t))
    .map((t) => t.replace(/^en:/, ''))
    .join(',') || null;

  return [
    barcode,
    productName,
    str(record.brands),
    str(record.image_front_url) || str(record.image_url),
    str(record.quantity),
    str(record.nutriscore_grade) || str(record.nutrition_grade_fr),
    num(record['energy-kcal_100g']),
    num(record.carbohydrates_100g),
    num(record.sugars_100g),
    num(record.fiber_100g),
    num(record.fat_100g),
    num(record['saturated-fat_100g']),
    num(record.proteins_100g),
    num(record.salt_100g),
    str(record.serving_size),
    num(record['energy-kcal_serving']),
    num(record.carbohydrates_serving),
    num(record.sugars_serving),
    num(record.fiber_serving),
    num(record.fat_serving),
    num(record['saturated-fat_serving']),
    num(record.proteins_serving),
    num(record.salt_serving),
    ingredientsText,
    knownOrNull(allergens),
    knownOrNull(tracesList),
    null, // ingredients_json: the full OFF JSON is too big; see ingredient_ids
    ingredientIds,
    ingredientsText ? textLanguage(ingredientTags) : 'en',
  ];
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function usageError(message) {
  console.error(message);
  console.error('Usage: node build-offline-db.js [--region gb[,us...]] [--limit N] [--out DIR] [--source URL]');
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { regionCodes: Object.keys(REGION_FILTERS), limit: null, outDir: DEFAULT_OUTPUT_DIR, source: CSV_URL };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usageError(`${arg} needs a value.`);
      return v;
    };
    if (arg === '--region') {
      const codes = value().toLowerCase().split(',').map((c) => c.trim()).filter(Boolean);
      for (const code of codes) {
        if (!REGION_FILTERS[code]) {
          usageError(`Unknown region: ${code}. Available: ${Object.keys(REGION_FILTERS).join(', ')}`);
        }
      }
      if (codes.length === 0) usageError('--region needs at least one region code.');
      opts.regionCodes = [...new Set(codes)];
    } else if (arg === '--limit') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 1) usageError('--limit needs a whole number above 0.');
      opts.limit = n;
    } else if (arg === '--out') {
      opts.outDir = path.resolve(value());
    } else if (arg === '--source') {
      opts.source = value();
      if (!/^https?:\/\//.test(opts.source)) usageError('--source needs an http(s) URL of a .csv.gz export.');
    } else {
      usageError(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { regionCodes, limit, outDir, source: sourceUrl } = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(outDir, 'manifest.json');

  console.log('=== BiteInsight Offline Database Builder ===\n');
  console.log(`Regions: ${regionCodes.map((c) => `${REGION_FILTERS[c].flag}  ${REGION_FILTERS[c].label} (${c})`).join(', ')}`);
  console.log(`Quality filter: requires product name (nutrition data optional)`);
  if (limit) console.log(`Test run: stopping each region after ${limit.toLocaleString()} products`);
  console.log(`Output: ${outDir}\n`);

  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);

  // Set up a DB + insert statement + batch buffer per region
  const regionDbs = {};
  for (const code of regionCodes) {
    const dbPath = path.join(outDir, `offline_${code}_products.db`);
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.exec(CREATE_TABLE_SQL);

    const insert = db.prepare(INSERT_SQL);
    const insertMany = db.transaction((rows) => {
      for (const row of rows) insert.run(...row);
    });

    // `matched` counts rows sent to the region (it decides when --limit is
    // reached); the real product count is read back from the table, since
    // INSERT OR IGNORE drops a barcode the export lists twice.
    regionDbs[code] = { db, insertMany, batch: [], matched: 0, dbPath };
  }

  console.log('Streaming the Open Food Facts CSV export...');
  console.log(`  URL: ${sourceUrl}`);

  const source = await download(sourceUrl);
  const gunzip = zlib.createGunzip();
  const parser = parse({
    delimiter: '\t',
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    relax_quotes: true,
  });

  // Download, gunzip and parse in one pass. Any error in any of them
  // (dropped connection, truncated gzip, bad CSV) ends the loop below
  // with that error, so a half-read export never becomes a database.
  let stoppedEarly = false;
  let streamError = null;
  pipeline(source, gunzip, parser, (err) => {
    if (err && !stoppedEarly) streamError = err;
  });

  let processed = 0;
  let qualityFiltered = 0;
  let open = regionCodes.slice(); // regions still taking products (--limit)

  for await (const record of parser) {
    processed++;

    if (processed % 100000 === 0) {
      const counts = regionCodes.map((c) => `${c}:${regionDbs[c].matched}`).join(' ');
      console.log(`  ${(processed / 1000).toFixed(0)}K rows processed | ${counts} | filtered:${qualityFiltered}`);
    }

    // Quality filter first (before region check, saves work)
    if (!meetsQualityThreshold(record)) {
      qualityFiltered++;
      continue;
    }

    // Check which regions this product belongs to
    const matches = matchRegions(record.countries_tags, open);
    if (matches.length === 0) continue;

    // Extract row data once
    const row = extractRow(record);
    if (!row) continue;

    // Insert into each matching region's DB
    for (const code of matches) {
      const rd = regionDbs[code];
      rd.batch.push(row);
      rd.matched++;

      if (rd.batch.length >= BATCH_SIZE) {
        rd.insertMany(rd.batch);
        rd.batch = [];
      }
      if (limit && rd.matched >= limit) open = open.filter((c) => c !== code);
    }

    if (open.length === 0) {
      stoppedEarly = true;
      break; // ends the loop and closes the download
    }
  }

  if (streamError) throw streamError;

  // Flush remaining batches
  for (const code of regionCodes) {
    const rd = regionDbs[code];
    if (rd.batch.length > 0) {
      rd.insertMany(rd.batch);
      rd.batch = [];
    }
  }

  console.log(`\nDone! Processed ${processed.toLocaleString()} rows${stoppedEarly ? ' (stopped early, test run)' : ''}.`);
  console.log(`Quality filtered: ${qualityFiltered.toLocaleString()} rows.\n`);

  // Finalize each region DB and build manifest
  const today = new Date().toISOString().slice(0, 10);
  const buildDate = new Date().toISOString();
  const manifestRegions = {};

  for (const code of regionCodes) {
    const rd = regionDbs[code];
    const filter = REGION_FILTERS[code];
    const count = rd.db.prepare('SELECT COUNT(*) AS n FROM products').get().n;

    console.log(`${filter.flag}  ${filter.label}: ${count.toLocaleString()} products`);

    // Write metadata into the DB
    const insertMeta = rd.db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
    insertMeta.run('version', today);
    insertMeta.run('product_count', String(count));
    insertMeta.run('build_date', buildDate);
    insertMeta.run('region', code);
    // 2: allergens as en: tags, traces, ingredient_ids.
    insertMeta.run('schema', '2');

    // Optimize
    rd.db.pragma('journal_mode = DELETE');
    rd.db.exec('VACUUM');
    rd.db.close();

    // Get file size
    const stat = fs.statSync(rd.dbPath);
    const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
    console.log(`   → ${sizeMB} MB (${rd.dbPath})`);

    manifestRegions[code] = {
      filename: `offline_${code}_products.db`,
      sizeBytes: stat.size,
      productCount: count,
      label: filter.label,
      flag: filter.flag,
    };
  }

  // Write global manifest
  const manifest = {
    version: today,
    buildDate,
    regions: manifestRegions,
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\nManifest written to: ${manifestPath}`);
  console.log(`Next: node check.js --dir ${outDir}`);
}

// Exported for check.js and for dry runs of the row mapping (no download, no database).
module.exports = {
  extractRow,
  toTags,
  textLanguage,
  INSERT_SQL,
  CREATE_TABLE_SQL,
  PRODUCT_COLUMNS,
  REGION_FILTERS,
};

if (require.main === module) {
  const finish = (code) => {
    process.exitCode = code;
    // A download socket can linger after an early stop. Don't wait on it,
    // but give the output time to flush first.
    setTimeout(() => process.exit(code), 10000).unref();
  };
  main().then(
    () => finish(0),
    (err) => {
      console.error('\nFatal error:', err);
      finish(1);
    },
  );
}
