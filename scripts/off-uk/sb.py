"""Tiny Supabase REST client (stdlib only) for the OFF import scripts.

Needs SUPABASE_URL (defaults to the Bite Insight project) and
SUPABASE_SERVICE_ROLE_KEY in the environment.
"""
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

URL = os.environ.get('SUPABASE_URL', 'https://bfkxjgbvsygvenmciasg.supabase.co').rstrip('/')
KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY')


def ssl_context():
    """python.org's macOS Python ships without CA certificates; fall back to
    the system bundle when the default one is missing."""
    cafile = ssl.get_default_verify_paths().cafile
    if (not cafile or not os.path.exists(cafile)) and os.path.exists('/etc/ssl/cert.pem'):
        return ssl.create_default_context(cafile='/etc/ssl/cert.pem')
    return ssl.create_default_context()


SSL = ssl_context()


def _headers(extra=None):
    if not KEY:
        sys.exit('SUPABASE_SERVICE_ROLE_KEY is not set')
    h = {
        'apikey': KEY,
        'Authorization': f'Bearer {KEY}',
        'Content-Type': 'application/json',
    }
    h.update(extra or {})
    return h


def request(method, path, body=None, params=None, headers=None, tries=4):
    url = f'{URL}/rest/v1/{path}'
    if params:
        url += '?' + urllib.parse.urlencode(params, safe='(),.*:')
    data = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
    for attempt in range(tries):
        req = urllib.request.Request(url, data=data, method=method, headers=_headers(headers))
        try:
            with urllib.request.urlopen(req, timeout=120, context=SSL) as res:
                raw = res.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as e:
            msg = e.read().decode(errors='replace')
            # Retry server hiccups and rate limits; fail fast on bad requests.
            if e.code >= 500 or e.code == 429:
                if attempt < tries - 1:
                    time.sleep(2 ** attempt * 2)
                    continue
            raise RuntimeError(f'{method} {path} -> {e.code}: {msg[:500]}') from None
        except urllib.error.URLError:
            if attempt < tries - 1:
                time.sleep(2 ** attempt * 2)
                continue
            raise


def upsert(table, rows, on_conflict, ignore_duplicates=False):
    if not rows:
        return
    pref = 'resolution=ignore-duplicates' if ignore_duplicates else 'resolution=merge-duplicates'
    request('POST', table, rows, params={'on_conflict': on_conflict},
            headers={'Prefer': f'{pref},return=minimal'})


def select_all(table, columns, page=1000, **filters):
    """Every row, paged by Range."""
    out = []
    start = 0
    while True:
        params = {'select': columns, 'order': columns.split(',')[0], **filters}
        rows = request('GET', table, params=params,
                       headers={'Range-Unit': 'items', 'Range': f'{start}-{start + page - 1}'})
        out.extend(rows)
        if len(rows) < page:
            return out
        start += page


def delete_in(table, column, values, chunk=150):
    for i in range(0, len(values), chunk):
        part = values[i:i + chunk]
        quoted = ','.join('"' + v.replace('"', '') + '"' for v in part)
        request('DELETE', table, params={column: f'in.({quoted})'}, headers={'Prefer': 'return=minimal'})


def category_ids(tags):
    """tag -> id, adding any tags not seen before."""
    tags = sorted(set(tags))
    for i in range(0, len(tags), 1000):
        upsert('off_categories', [{'tag': t} for t in tags[i:i + 1000]], 'tag', ignore_duplicates=True)
    return {r['tag']: r['id'] for r in select_all('off_categories', 'id,tag')}
