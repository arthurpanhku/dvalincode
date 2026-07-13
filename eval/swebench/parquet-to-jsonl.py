#!/usr/bin/env python3
"""Fallback dataset fetch for when the HF datasets-server is down.

Downloads the SWE-bench Lite `test` parquet straight from the hub CDN (separate
infra from the flaky datasets-server) and emits one JSON object per row to
stdout. Requires pyarrow (the caller provisions it in a cached tool venv).

Usage: python parquet-to-jsonl.py > instances/_rows.jsonl
"""
import json
import sys
import urllib.request

import pyarrow.parquet as pq

URL = (
    "https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite/"
    "resolve/main/data/test-00000-of-00001.parquet"
)


def main() -> int:
    print(f"downloading {URL}", file=sys.stderr)
    req = urllib.request.Request(URL, headers={"User-Agent": "dvalincode-swebench-eval"})
    with urllib.request.urlopen(req) as resp:  # noqa: S310 (trusted hub URL)
        data = resp.read()
    tmp = "/tmp/swebench-lite-test.parquet"
    with open(tmp, "wb") as fh:
        fh.write(data)
    table = pq.read_table(tmp)
    rows = table.to_pylist()
    print(f"read {len(rows)} rows", file=sys.stderr)
    out = sys.stdout
    for row in rows:
        out.write(json.dumps(row, default=str))
        out.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
