"""Apply Open Food Facts' daily delta exports to off_products_uk.

    python3 -I apply_delta.py [--dry-run] [--max-files N]

Reads which files have been applied from off_sync_log and applies every
newer one, oldest first. A product that still qualifies is upserted; one
that no longer does (left the UK, lost its category or photo, marked
obsolete) is deleted. Stores come from the product itself plus the brand
map the last full load built.
"""
import argparse
import gzip
import json
import os
import re
import sys
import time
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offuk  # noqa: E402
import sb  # noqa: E402

DELTA = 'https://static.openfoodfacts.org/data/delta/'
UA = {'User-Agent': 'BiteInsight-OFF-import/1.0 (hello@pixeljam.design)'}
BATCH = 500


def delta_files():
    req = urllib.request.Request(DELTA + 'index.txt', headers=UA)
    with urllib.request.urlopen(req, timeout=60, context=sb.SSL) as res:
        names = res.read().decode().split()
    out = []
    for n in names:
        m = re.fullmatch(r'openfoodfacts_products_(\d+)_(\d+)\.json\.gz', n)
        if m:
            out.append((int(m.group(2)), n))
    return sorted(out)


def documents(name):
    req = urllib.request.Request(DELTA + name, headers=UA)
    with urllib.request.urlopen(req, timeout=600, context=sb.SSL) as res:
        with gzip.GzipFile(fileobj=res) as gz:
            for line in gz:
                yield line


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--max-files', type=int, default=14, help="safety cap; a gap longer than this needs a full load")
    args = ap.parse_args()

    last = sb.request('GET', 'off_sync_log', params={'select': 'end_t', 'order': 'end_t.desc', 'limit': '1'})
    if not last:
        sys.exit('off_sync_log is empty: run load_full.py first')
    last_t = last[0]['end_t']
    todo = [(end, n) for end, n in delta_files() if end > last_t]
    if not todo:
        print('Up to date.')
        return
    if len(todo) > args.max_files:
        sys.exit(f'{len(todo)} deltas behind (more than {args.max_files}): run load_full.py instead')

    brand_stores = {r['brand_key']: r['stores'] for r in sb.select_all('off_brand_stores', 'brand_key,stores')}
    existing = {r['code'] for r in sb.select_all('off_products_uk', 'code')}
    cat_ids = {r['tag']: r['id'] for r in sb.select_all('off_categories', 'id,tag')}

    for end_t, name in todo:
        t0 = time.time()
        upserts, deletes, seen = {}, set(), 0
        for line in documents(name):
            seen += 1
            # Cheap test before parsing: most of the file isn't UK.
            if b'en:united-kingdom' not in line:
                m = re.search(rb'"code"\s*:\s*"([^"]+)"', line)
                if m and m.group(1).decode() in existing:
                    deletes.add(m.group(1).decode())
                continue
            doc = json.loads(line)
            rec = offuk.from_delta(doc)
            p = None if doc.get('obsolete') else offuk.clean_product(rec)
            row = offuk.table_row(p, brand_stores) if p else None
            if row:
                upserts[row['code']] = row
                deletes.discard(row['code'])
            elif rec['code'] in existing:
                deletes.add(rec['code'])

        rows = list(upserts.values())
        new_tags = {t for r in rows for t in r['categories_tags']} - cat_ids.keys()
        print(f'{name}: {seen} products, {len(rows)} to upsert, {len(deletes)} to delete, '
              f'{len(new_tags)} new categories', flush=True)
        if args.dry_run:
            continue
        if new_tags:
            cat_ids = sb.category_ids(new_tags)
        for r in rows:
            r['category_ids'] = [cat_ids[t] for t in r.pop('categories_tags')]
        for i in range(0, len(rows), BATCH):
            sb.upsert('off_products_uk', rows[i:i + BATCH], 'code')
        sb.delete_in('off_products_uk', 'code', sorted(deletes))
        existing |= upserts.keys()
        existing -= deletes
        sb.upsert('off_sync_log', [{'file': name, 'end_t': end_t, 'upserted': len(rows),
                                    'deleted': len(deletes)}], 'file')
        print(f'  applied in {time.time() - t0:.0f}s', flush=True)


if __name__ == '__main__':
    main()
