#!/usr/bin/env python3
"""Push New Folder and Suggested Tags from the categorized CSV to Raindrop.io.

Dry run (default, changes nothing):
    python3 sync.py
Apply the changes and write sync-log.jsonl:
    python3 sync.py --apply

Secrets are read from .env in this folder. Only the Python standard library is used.
"""
import csv
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

API = 'https://api.raindrop.io/rest/v1'
HERE = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(HERE, '.env')
LOG_PATH = os.path.join(HERE, 'sync-log.jsonl')
CSV_PATH = os.environ.get(
    'CSV_PATH', 'raindrop-export-categorized.csv')
MIN_INTERVAL = 0.7  # seconds between calls, keeps the rate under 120 per minute
PAGE_SIZE = 50


def load_env(path):
    """Read KEY=VALUE lines. Values from the real environment win over .env."""
    values = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                values[key.strip()] = value.strip().strip('"').strip("'")
    values.update({k: v for k, v in os.environ.items() if k.startswith('RAINDROP_')})
    return values


ENV = load_env(ENV_PATH)
TOKEN = ENV.get('RAINDROP_TEST_TOKEN', '')
if not TOKEN:
    sys.exit('Missing RAINDROP_TEST_TOKEN. Add it to .env (see .env.example).')

_last_call = [0.0]


def call(method, path, body=None):
    """Send one API request. Retry on 429 and 5xx. Return the parsed JSON."""
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    for attempt in range(5):
        wait = MIN_INTERVAL - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            # The status decides the retry. A body that cannot be read must not hide it.
            try:
                detail = e.read().decode('utf-8', errors='replace')
            except (OSError, http.client.HTTPException) as read_error:
                detail = f'(error body could not be read: {read_error})'
            # A POST may already have reached Raindrop. A 5xx answer is then uncertain, so it is not retried.
            if e.code == 429 or (e.code >= 500 and method != 'POST'):
                time.sleep(int(e.headers.get('Retry-After', '10')))
                continue
            raise RuntimeError(f'{method} {path} failed with {e.code}: {detail}')
        except (urllib.error.URLError, OSError, http.client.HTTPException) as e:
            # The request may have reached Raindrop before the connection failed.
            # A POST is therefore not repeated, because a repeat could create a second folder.
            if method == 'POST':
                raise RuntimeError(f'{method} {path} network error, not retried: {e}')
            # No connection, a DNS failure, a timeout or a truncated body. Wait, then try again.
            if attempt == 4:
                raise RuntimeError(f'{method} {path} network error after retries: {e}')
            time.sleep(2 ** attempt)
    raise RuntimeError(f'{method} {path} failed after retries')


def fetch_collections():
    """Return {collection_id: title} for all top-level and nested collections."""
    result = {}
    for path in ('/collections', '/collections/childrens'):
        for col in call('GET', path).get('items', []):
            result[col['_id']] = col['title']
    return result


def fetch_all_raindrops():
    """Return {raindrop_id: raindrop} for every bookmark in the account."""
    items = {}
    page = 0
    while True:
        batch = call('GET', f'/raindrops/0?perpage={PAGE_SIZE}&page={page}').get('items', [])
        for item in batch:
            items[item['_id']] = item
        if len(batch) < PAGE_SIZE:
            return items
        page += 1


def split_tags(text):
    return [t.strip() for t in text.split(',') if t.strip()]


def merge_tags(*lists):
    """Join tag lists in order. Drop duplicates that differ only in capitals."""
    seen, merged = set(), []
    for tags in lists:
        for tag in tags:
            if tag.lower() not in seen:
                seen.add(tag.lower())
                merged.append(tag)
    return merged


def build_plan(rows, live, titles_by_id, cols_by_title):
    """Compare each CSV row with the live account. Return planned changes."""
    plan = {'missing_ids': [], 'new_collections': [], 'changes': []}
    wanted = {row['New Folder'] for row in rows if row.get('New Folder')}
    plan['new_collections'] = sorted(w for w in wanted if w not in cols_by_title)
    for row in rows:
        rid = int(row['id'])
        item = live.get(rid)
        if item is None:
            plan['missing_ids'].append(rid)
            continue
        target_folder = row['New Folder']
        current_folder = titles_by_id.get(item.get('collection', {}).get('$id'), 'Unsorted')
        move = current_folder != target_folder
        live_tags = item.get('tags', [])
        desired_tags = merge_tags(live_tags, split_tags(row.get('Suggested Tags', '')))
        retag = {t.lower() for t in desired_tags} != {t.lower() for t in live_tags}
        if move or retag:
            plan['changes'].append({
                'id': rid, 'title': item.get('title', '')[:80],
                'from_folder': current_folder, 'to_folder': target_folder,
                'move': move, 'tags_before': live_tags,
                'tags_after': desired_tags if retag else live_tags,
            })
    return plan


def print_plan(plan):
    print(f"Collections to create : {len(plan['new_collections'])}")
    for name in plan['new_collections']:
        print(f"  + {name}")
    print(f"Bookmarks not found   : {len(plan['missing_ids'])} {plan['missing_ids'][:10]}")
    moves = sum(1 for c in plan['changes'] if c['move'])
    retags = sum(1 for c in plan['changes'] if c['tags_after'] != c['tags_before'])
    print(f"Bookmarks to change   : {len(plan['changes'])} (moves: {moves}, tag updates: {retags})")
    for c in plan['changes'][:15]:
        print(f"  #{c['id']} {c['from_folder']} -> {c['to_folder']} | {c['title']}")
    if len(plan['changes']) > 15:
        print(f"  ... and {len(plan['changes']) - 15} more")


def apply_plan(plan, cols_by_title):
    """Create missing collections, then update each bookmark and log the result."""
    for name in plan['new_collections']:
        res = call('POST', '/collection', {'title': name})
        cols_by_title[name] = res['item']['_id']
        print(f"created collection: {name}")
    done = failed = 0
    with open(LOG_PATH, 'a', encoding='utf-8') as log:
        for c in plan['changes']:
            body = {}
            if c['move']:
                body['collection'] = {'$id': cols_by_title[c['to_folder']]}
            if c['tags_after'] != c['tags_before']:
                body['tags'] = c['tags_after']
            entry = {'time': datetime.now(timezone.utc).isoformat(), **c}
            try:
                call('PUT', f"/raindrop/{c['id']}", body)
                entry['ok'] = True
                done += 1
            except RuntimeError as e:
                entry.update(ok=False, error=str(e))
                failed += 1
                print(f"failed #{c['id']}: {e}")
            log.write(json.dumps(entry, ensure_ascii=False) + '\n')
    print(f"done: {done} updated, {failed} failed. Log: {LOG_PATH}")


def main():
    apply = '--apply' in sys.argv
    with open(CSV_PATH, encoding='utf-8', newline='') as f:
        rows = list(csv.DictReader(f))
    titles_by_id = fetch_collections()
    cols_by_title = {title: cid for cid, title in titles_by_id.items()}
    live = fetch_all_raindrops()
    print(f"Account has {len(live)} bookmarks. CSV has {len(rows)} rows.")
    plan = build_plan(rows, live, titles_by_id, cols_by_title)
    print_plan(plan)
    if not apply:
        print('\nDry run. Run with --apply to make these changes.')
        return
    apply_plan(plan, cols_by_title)


if __name__ == '__main__':
    main()
