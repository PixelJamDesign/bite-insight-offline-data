"""Full load of off_products_uk from Open Food Facts' CSV export.

    python3 -I load_full.py [--dry-run] [--csv products.csv.gz] [--keep-download]

Downloads the export (~1.2 GB) unless --csv is given, keeps UK products,
cleans them (offuk.py), and upserts the ones that can be offered as swaps
in batches. Rows no longer in the export are deleted. Also rebuilds the
brand -> chains map and records the export in off_sync_log, so
apply_delta.py starts from the right day.
"""
import argparse
import email.utils
import gzip
import os
import shutil
import sys
import tempfile
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offuk  # noqa: E402
import sb  # noqa: E402

EXPORT = 'https://static.openfoodfacts.org/data/en.openfoodfacts.org.products.csv.gz'
BATCH = 500
UA = {'User-Agent': 'BiteInsight-OFF-import/1.0 (hello@pixeljam.design)'}

# Columns read from the CSV (it has 201).
KEEP = [
    'code', 'product_name', 'brands_en', 'brands_tags', 'stores', 'categories_tags',
    'countries_tags', 'ingredients_text', 'allergens_tags', 'traces_tags',
    'nutriscore_grade', 'last_modified_t', 'energy-kcal_100g', 'energy-kj_100g',
    'energy_100g', 'fat_100g', 'saturated-fat_100g', 'sugars_100g', 'salt_100g',
    'fiber_100g', 'proteins_100g', 'carbohydrates_100g', 'unique_scans_n',
    'image_small_url', 'labels_tags', 'ingredients_analysis_tags',
]


def download(dest):
    req = urllib.request.Request(EXPORT, headers=UA)
    with urllib.request.urlopen(req, timeout=600, context=sb.SSL) as res, open(dest, 'wb') as out:
        modified = res.headers.get('Last-Modified')
        shutil.copyfileobj(res, out, 1 << 20)
    return modified


def uk_records(path):
    """UK rows of the export as dicts. Fields can hold raw newlines (the CSV
    isn't quoted), so a record may span lines: join until it has every column."""
    with gzip.open(path, 'rt', encoding='utf-8', errors='replace', newline='\n') as f:
        header = f.readline().rstrip('\n').split('\t')
        n = len(header)
        idx = {k: header.index(k) for k in KEEP}
        buf = None
        for line in f:
            line = line.rstrip('\n').rstrip('\r')
            buf = line if buf is None else buf + ' ' + line
            if buf.count('\t') + 1 < n:
                continue
            fields = buf.split('\t')
            buf = None
            if len(fields) != n or 'en:united-kingdom' not in fields[idx['countries_tags']]:
                continue
            yield {k: fields[i] for k, i in idx.items()}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', help='use this export instead of downloading')
    ap.add_argument('--dry-run', action='store_true', help='clean and count, write nothing')
    ap.add_argument('--keep-download', action='store_true')
    ap.add_argument('--export-t', type=int, help="with --csv: the export's Last-Modified as unix time")
    args = ap.parse_args()

    t0 = time.time()
    tmpdir = None
    if args.csv:
        path = args.csv
        export_t = args.export_t or int(os.path.getmtime(path))
    else:
        tmpdir = tempfile.mkdtemp(prefix='off-export-')
        path = os.path.join(tmpdir, 'products.csv.gz')
        print('Downloading export...', flush=True)
        modified = download(path)
        export_t = int(email.utils.parsedate_to_datetime(modified).timestamp()) if modified else int(time.time())

    products = {}
    for rec in uk_records(path):
        p = offuk.clean_product(rec)
        if p is None:
            continue
        old = products.get(p['code'])
        if old is None or (p['last_modified'] and (old['last_modified'] is None or p['last_modified'] > old['last_modified'])):
            products[p['code']] = p
    brand_stores = offuk.brand_store_map(products.values())
    rows = [r for r in (offuk.table_row(p, brand_stores) for p in products.values()) if r]
    print(f'UK products {len(products)}, swap-ready rows {len(rows)}, brands with stores {len(brand_stores)} '
          f'({time.time() - t0:.0f}s)', flush=True)

    if tmpdir and not args.keep_download:
        shutil.rmtree(tmpdir, ignore_errors=True)
    if args.dry_run:
        return

    ids = sb.category_ids(t for r in rows for t in r['categories_tags'])
    for r in rows:
        r['category_ids'] = [ids[t] for t in r.pop('categories_tags')]

    for i in range(0, len(rows), BATCH):
        sb.upsert('off_products_uk', rows[i:i + BATCH], 'code')
        if (i // BATCH) % 10 == 0:
            print(f'  upserted {min(i + BATCH, len(rows))}/{len(rows)}', flush=True)

    keep = {r['code'] for r in rows}
    stale = [r['code'] for r in sb.select_all('off_products_uk', 'code') if r['code'] not in keep]
    sb.delete_in('off_products_uk', 'code', stale)

    brand_rows = [{'brand_key': k, 'stores': m} for k, m in brand_stores.items()]
    old_brands = {r['brand_key'] for r in sb.select_all('off_brand_stores', 'brand_key')}
    sb.delete_in('off_brand_stores', 'brand_key', sorted(old_brands - set(brand_stores)))
    for i in range(0, len(brand_rows), 1000):
        sb.upsert('off_brand_stores', brand_rows[i:i + 1000], 'brand_key')

    sb.upsert('off_sync_log', [{'file': f'full-export-{export_t}', 'end_t': export_t,
                                'upserted': len(rows), 'deleted': len(stale)}], 'file')
    print(f'Done: {len(rows)} rows, {len(stale)} stale removed ({time.time() - t0:.0f}s)')


if __name__ == '__main__':
    main()
