# Sync script

This text moved here from the root `README.md`. The script is `sync.py` in the root of the repository. Its tests are in `tests/test_sync.py`: run `python3 -m unittest discover -s tests`.

`sync.py` moves Raindrop.io bookmarks to the correct folder. It also adds suggested tags. The script reads a CSV file. Each row gives a bookmark, its new folder, and its suggested tags.

## Requirements

- Python 3. The script uses only the Python standard library.
- A Raindrop.io test token. Create it in the Raindrop App Management Console.

## Configuration

1. Copy the example file: `cp .env.example .env`
2. Open `.env`. Enter the value for `RAINDROP_TEST_TOKEN`.

The script reads only `RAINDROP_TEST_TOKEN`. Git ignores `.env`. Do not share its values.

## Input file

The CSV file must have these columns:

- `id`: The Raindrop bookmark ID.
- `New Folder`: The target folder name. The script creates the folder when it does not exist.
- `Suggested Tags`: Comma-separated tags to add to the bookmark.

The script reads the path in `CSV_PATH`. Set this variable to use another file:

```bash
CSV_PATH=/path/to/file.csv python3 sync.py
```

## Usage

Run a dry run first. The dry run changes nothing:

```bash
python3 sync.py
```

Apply the changes:

```bash
python3 sync.py --apply
```

The dry run prints the folders to create, the bookmarks not found, and the planned changes.

## Log

With `--apply`, the script appends each change to `sync-log.jsonl`. Each line records the time, the bookmark, the folders, the tags, and the result.

## Notes

- The script waits between API calls. It keeps the rate under 120 calls per minute.
- The script retries network errors, timeouts and truncated responses up to five times. A bookmark that still fails is logged as failed. The run then continues with the next bookmark.
- The script never repeats a POST request after a network error or a 5xx answer. A repeat could create a second folder.
- The script merges tags. Existing tags stay. Tags that differ only in capitals are kept once.
- Bookmarks that the account does not contain are reported and skipped.
