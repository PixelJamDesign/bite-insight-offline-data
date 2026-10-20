"""Shared cleaning rules for the UK Open Food Facts slice.

Used by the one-off build and by the nightly delta job, so both produce
identical rows.
"""
import re
from datetime import datetime, timezone

# Chains we care about, in a fixed order. The bit position is the store_mask bit.
STORES = ['tesco', 'sainsburys', 'asda', 'morrisons', 'aldi', 'lidl', 'waitrose', 'coop', 'mands']

# What a chain looks like in OFF's free-text `stores` field.
STORE_PATTERNS = {
    'tesco': r'\btesco',
    'sainsburys': r'\bsainsbury',
    'asda': r'\basda\b',
    'morrisons': r'\bmorrison',
    'aldi': r'\baldi\b',
    'lidl': r'\blidl\b',
    'waitrose': r'\bwaitrose',
    'coop': r'\bco-?op\b|\bco-?operative\b',
    'mands': r'\bm\s?&\s?s\b|\bm-s\b|marks[\s-]*(&|and)?[\s-]*spencer',
}

# Own-label brands only sold by one chain. Matched against OFF brand tags
# (lowercase, hyphenated), so "Tesco Finest" is "tesco-finest".
OWN_LABEL = {
    'tesco': ['tesco*', 'stockwell*', 'ms-molly-s', 'hearty-food-co*', 'creamfields',
              'eastman-s', 'grower-s-harvest', 'redmere-farms', 'willow-farms',
              'boswell-farms', 'nightingale-farms', 'rosedene-farms', 'woodside-farms',
              'h-w-nevill-s', 'suntrail-farms', 'finest'],
    'sainsburys': ['sainsbury*', 'by-sainsbury-s', 'taste-the-difference', 'stamford-street-co'],
    'asda': ['asda*', 'extra-special', 'just-essentials*', 'asda-smart-price'],
    'morrisons': ['morrisons*', 'market-street', 'morrisons-the-best', 'the-best'],
    'aldi': ['aldi*', 'specially-selected', 'cucina', 'brooklea', 'everyday-essentials',
             'harvest-morn', 'belmont', 'moser-roth', 'snackrite', 'ashfield-farm',
             'nature-s-pick', 'mamia', 'cowbelle', 'the-fishmonger', 'dairyfine',
             'village-bakery', 'baker-street', 'corale', 'the-deli', 'holland-s-kitchen',
             'bramwells', 'jacob-s-bakery-aldi', 'scholl-s', 'crestwood', 'westcliff'],
    'lidl': ['lidl*', 'deluxe', 'milbona', 'crownfield', 'pilos', 'freshona', 'chef-select',
             'alesto', 'snack-day', 'solevita', 'combino', 'dulano', 'birchwood', 'rowan-glen',
             'oaklands', 'baresa', 'vitasia', 'golden-sun', 'trattoria-alfredo', 'favorina',
             'mcennedy', 'fin-carre', 'j-d-gross', 'kania', 'saskia', 'harvest-basket',
             'tower-gate', 'rocket-zero', 'high-protein-lidl', 'eridanous', 'italiamo',
             'el-tequito', 'sondey', 'lord-nelson', 'perlenbacher', 'freeway', 'cien'],
    'waitrose': ['waitrose*', 'essential-waitrose*', 'duchy*', 'waitrose-duchy-organic',
                 'no-1-waitrose', 'waitrose-1'],
    'coop': ['co-op*', 'coop', 'coop-*', 'the-co-operative*', 'co-operative*', 'irresistible*'],
    'mands': ['marks-spencer*', 'marks-and-spencer*', 'marks-spencers', 'm-s', 'm-s-*', 'ms-food',
              'percy-pig*', 'count-on-us', 'marks-spencer-food'],
}

_store_res = {k: re.compile(v, re.I) for k, v in STORE_PATTERNS.items()}


def _slug(s):
    s = s.strip().lower().replace('’', "'")
    s = re.sub(r'^[a-z]{2}:', '', s)
    return re.sub(r'[^a-z0-9]+', '-', s).strip('-')


def _brand_matches(slug, pattern):
    if pattern.endswith('*'):
        return slug.startswith(pattern[:-1])
    return slug == pattern


def stores_from_text(stores_text):
    """Chains named in OFF's free-text stores field."""
    if not stores_text:
        return set()
    return {k for k, r in _store_res.items() if r.search(stores_text)}


def stores_from_brands(brands_tags, brands_text):
    """Chains implied by an own-label brand."""
    found = set()
    slugs = {_slug(b) for b in (brands_tags or '').split(',') if b.strip()}
    slugs |= {_slug(b) for b in (brands_text or '').split(',') if b.strip()}
    slugs.discard('')
    for chain, pats in OWN_LABEL.items():
        for s in slugs:
            if any(_brand_matches(s, p) for p in pats):
                found.add(chain)
                break
    return found


def to_num(v):
    if v is None:
        return None
    v = str(v).strip()
    if not v:
        return None
    try:
        x = float(v)
    except ValueError:
        return None
    if x != x or x < 0:
        return None
    return x


def clean_nutrients(row):
    """Per-100g values. Energy in kcal, from kcal or else kJ / 4.184.
    Values outside physical limits are dropped rather than trusted."""
    kcal = to_num(row.get('energy-kcal_100g'))
    if kcal is None:
        kj = to_num(row.get('energy-kj_100g')) or to_num(row.get('energy_100g'))
        if kj is not None:
            kcal = kj / 4.184
    out = {
        'energy_kcal': kcal,
        'fat': to_num(row.get('fat_100g')),
        'saturated_fat': to_num(row.get('saturated-fat_100g')),
        'sugars': to_num(row.get('sugars_100g')),
        'salt': to_num(row.get('salt_100g')),
        'fibre': to_num(row.get('fiber_100g')),
        'protein': to_num(row.get('proteins_100g')),
        'carbs': to_num(row.get('carbohydrates_100g')),
    }
    if out['energy_kcal'] is not None and out['energy_kcal'] > 950:
        out['energy_kcal'] = None
    for k in ('fat', 'saturated_fat', 'sugars', 'salt', 'fibre', 'protein', 'carbs'):
        if out[k] is not None and out[k] > 100:
            out[k] = None
    if out['fat'] is not None and out['saturated_fat'] is not None and out['saturated_fat'] > out['fat'] + 0.5:
        out['saturated_fat'] = None
    return out


def split_tags(s):
    return [t for t in (s or '').split(',') if t]


def parse_modified(v):
    """OFF exports have used both unix seconds and ISO strings here."""
    if v is None or v == '':
        return None
    if isinstance(v, (int, float)) or str(v).isdigit():
        return datetime.fromtimestamp(int(v), tz=timezone.utc)
    try:
        return datetime.fromisoformat(str(v).replace('Z', '+00:00'))
    except ValueError:
        return None


GRADES = {'a', 'b', 'c', 'd', 'e'}

IMAGE_PREFIX = 'https://images.openfoodfacts.org/images/products/'


def image_folder(code):
    """OFF's image folder for a barcode: padded to 13 digits, split 3/3/3/rest."""
    c = code.zfill(13)
    return f'{c[0:3]}/{c[3:6]}/{c[6:9]}/{c[9:]}'


def image_key_from_url(url, code):
    """'.../front_en.12.200.jpg' -> 'en.12'. The database rebuilds the URL
    from the barcode, so only this part is stored."""
    url = (url or '').strip()
    m = re.match(re.escape(IMAGE_PREFIX) + r'(.+)/front_([a-z]{2,3})\.(\d+)\.200\.jpg$', url)
    if not m or m.group(1) != image_folder(code):
        return None
    return f'{m.group(2)}.{m.group(3)}'


# Diet facts worth filtering on in SQL. ingredients_analysis gives vegan /
# vegetarian / palm oil status; labels are what the pack claims.
DIET_LABELS = {
    'en:vegan', 'en:vegetarian', 'en:non-vegan', 'en:non-vegetarian',
    'en:gluten-free', 'en:no-gluten', 'en:lactose-free', 'en:no-lactose', 'en:kosher',
    'en:halal', 'en:organic', 'en:no-added-sugar', 'en:low-sugar', 'en:sugar-free',
    'en:low-fat', 'en:low-salt', 'en:palm-oil', 'en:palm-oil-free',
}


def diet_tags(analysis, labels):
    tags = set(split_tags(analysis)) | set(split_tags(labels))
    out = {t for t in tags if t in DIET_LABELS}
    if 'en:no-gluten' in out:
        out.discard('en:no-gluten')
        out.add('en:gluten-free')
    if 'en:no-lactose' in out:
        out.discard('en:no-lactose')
        out.add('en:lactose-free')
    return sorted(out)


def brand_key(brands):
    b = (brands or '').split(',')[0].strip().lower()
    return re.sub(r'[^a-z0-9]+', '-', b).strip('-') or None


def clean_product(row):
    """One OFF record (CSV column names) -> our cleaned product, or None if
    it isn't a UK product with a name and some nutrition."""
    name = (row.get('product_name') or '').strip()
    if not name:
        return None
    if 'en:united-kingdom' not in (row.get('countries_tags') or ''):
        return None
    nut = clean_nutrients(row)
    if all(v is None for v in nut.values()):
        return None
    code = row['code'].strip()
    brands = (row.get('brands_en') or row.get('brands') or '').strip()[:200] or None
    grade = (row.get('nutriscore_grade') or '').strip().lower()
    return {
        'code': code,
        'product_name': name[:300],
        'brands': brands,
        'stores_listed': sorted(stores_from_text(row.get('stores') or '')),
        'stores_own_label': sorted(stores_from_brands(row.get('brands_tags'), brands)),
        'categories_tags': [t for t in split_tags(row.get('categories_tags')) if re.fullmatch(r'[a-z]{2}:[a-z0-9-]+', t)],
        'allergens_tags': split_tags(row.get('allergens_tags')),
        'traces_tags': split_tags(row.get('traces_tags')),
        'ingredients_text': (row.get('ingredients_text') or '').strip() or None,
        'nutriscore_grade': grade if grade in GRADES else None,
        'last_modified': parse_modified(row.get('last_modified_t')),
        'image_key': row.get('image_key') or image_key_from_url(row.get('image_small_url'), code),
        'unique_scans_n': int(to_num(row.get('unique_scans_n')) or 0),
        'diet_tags': diet_tags(row.get('ingredients_analysis_tags'), row.get('labels_tags')),
        **nut,
    }


# ── Delta export (JSON product documents) ────────────────────────────────────

_NUTRIENTS = ['energy-kcal', 'energy-kj', 'energy', 'fat', 'saturated-fat', 'sugars',
              'salt', 'fiber', 'proteins', 'carbohydrates']
_UNIT = {'g': 1, 'mg': 1e-3, 'µg': 1e-6, 'mcg': 1e-6, 'kcal': 1, 'kJ': 1, 'kj': 1}


def _delta_nutrients(doc):
    out = {}
    agg = (doc.get('nutrition') or {}).get('aggregated_set') or {}
    if agg.get('per') == '100g' and agg.get('preparation', 'as_sold') == 'as_sold':
        for n in _NUTRIENTS:
            v = (agg.get('nutrients') or {}).get(n)
            if isinstance(v, dict) and isinstance(v.get('value'), (int, float)):
                f = _UNIT.get(v.get('unit') or 'g')
                if f is not None:
                    out[f'{n}_100g'] = v['value'] * f
    if not out:  # older documents
        nm = doc.get('nutriments') or {}
        for n in _NUTRIENTS:
            if f'{n}_100g' in nm:
                out[f'{n}_100g'] = nm[f'{n}_100g']
    return out


def _join(v):
    if isinstance(v, list):
        return ','.join(str(x) for x in v)
    return v or ''


def _delta_image_key(doc):
    front = (((doc.get('images') or {}).get('selected') or {}).get('front')) or {}
    if not front:
        return None
    for lang in ('en', doc.get('lang'), *front.keys()):
        if lang in front and front[lang].get('rev'):
            return f"{lang}.{front[lang]['rev']}"
    return None


def from_delta(doc):
    """A delta product document mapped onto the CSV column names."""
    stores = ','.join(filter(None, [doc.get('stores') or '', _join(doc.get('stores_tags'))]))
    return {
        'code': str(doc.get('code') or ''),
        'product_name': doc.get('product_name_en') or doc.get('product_name'),
        'brands': doc.get('brands'),
        'brands_tags': _join(doc.get('brands_tags')),
        'stores': stores,
        'categories_tags': _join(doc.get('categories_tags')),
        'countries_tags': _join(doc.get('countries_tags')),
        'ingredients_text': doc.get('ingredients_text_en') or doc.get('ingredients_text'),
        'allergens_tags': _join(doc.get('allergens_tags')),
        'traces_tags': _join(doc.get('traces_tags')),
        'nutriscore_grade': doc.get('nutriscore_grade'),
        'last_modified_t': doc.get('last_modified_t'),
        'unique_scans_n': doc.get('unique_scans_n'),
        'labels_tags': _join(doc.get('labels_tags')),
        'ingredients_analysis_tags': _join(doc.get('ingredients_analysis_tags')),
        'image_key': _delta_image_key(doc),
        **_delta_nutrients(doc),
    }


# ── Rows for the table ───────────────────────────────────────────────────────

def mask(chains):
    return sum(1 << STORES.index(c) for c in set(chains))


def store_masks(p, brand_stores):
    """(confirmed, likely). Likely = the brand is listed at that chain on
    other products; never for own-label, which is only ever one chain."""
    confirmed = mask(p['stores_listed']) | mask(p['stores_own_label'])
    likely = 0
    if not p['stores_own_label']:
        likely = brand_stores.get(brand_key(p['brands']), 0) & ~confirmed
    return confirmed, likely


def brand_store_map(products, min_products=2):
    """brand -> chains it's listed at on >= min_products branded products."""
    counts = {}
    for p in products:
        if p['stores_own_label'] or not p['stores_listed']:
            continue
        k = brand_key(p['brands'])
        if not k:
            continue
        c = counts.setdefault(k, {})
        for s in p['stores_listed']:
            c[s] = c.get(s, 0) + 1
    out = {}
    for k, c in counts.items():
        m = mask([s for s, n in c.items() if n >= min_products])
        if m:
            out[k] = m
    return out


def _r(x, d=2):
    return None if x is None else round(x, d)


def table_row(p, brand_stores):
    """Our product -> a row for off_products_uk (categories still as tags),
    or None if it can never be offered as a swap."""
    confirmed, likely = store_masks(p, brand_stores)
    if not p['categories_tags'] or not p['image_key'] or not (confirmed | likely):
        return None
    return {
        'code': p['code'],
        'product_name': p['product_name'],
        'brands': p['brands'],
        'image_key': p['image_key'],
        'stores': confirmed,
        'stores_likely': likely,
        'categories_tags': p['categories_tags'],
        'allergens_tags': p['allergens_tags'],
        'traces_tags': p['traces_tags'],
        'diet_tags': p['diet_tags'],
        'ingredients_text': p['ingredients_text'],
        'nutriscore_grade': p['nutriscore_grade'],
        'energy_kcal': _r(p['energy_kcal'], 0),
        'fat': _r(p['fat']),
        'saturated_fat': _r(p['saturated_fat']),
        'carbs': _r(p['carbs']),
        'sugars': _r(p['sugars']),
        'fibre': _r(p['fibre']),
        'protein': _r(p['protein']),
        'salt': _r(p['salt']),
        'unique_scans_n': p['unique_scans_n'],
        'last_modified': p['last_modified'].isoformat() if p['last_modified'] else None,
    }
