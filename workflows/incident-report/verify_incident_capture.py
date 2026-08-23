#!/usr/bin/env python3
import hashlib, json, sys
from pathlib import Path

def fail(message):
    print(f"capture verification failed: {message}", file=sys.stderr); return 1

def main(argv):
    if len(argv) != 2: print(f"usage: {argv[0]} METADATA_JSON", file=sys.stderr); return 2
    try: meta=json.loads(Path(argv[1]).read_text(encoding="utf-8"))
    except Exception as exc: return fail(f"invalid metadata: {exc}")
    required=("source_path","byte_size","sha256","capture_state","complete")
    missing=[k for k in required if k not in meta]
    if missing: return fail("metadata missing fields: "+", ".join(missing))
    if meta["capture_state"]!="captured" or meta["complete"] is not True: return fail("capture is not complete and verified")
    source=Path(meta["source_path"])
    if not source.is_file(): return fail(f"source file missing: {source}")
    if source.stat().st_size != meta["byte_size"]: return fail("byte size mismatch")
    digest=hashlib.sha256()
    with source.open("rb") as h:
        for chunk in iter(lambda:h.read(1024*1024), b""): digest.update(chunk)
    if digest.hexdigest().lower()!=str(meta["sha256"]).lower(): return fail("sha256 mismatch")
    print(f"capture verified: {source} ({source.stat().st_size} bytes, sha256={digest.hexdigest()})"); return 0

if __name__ == "__main__": raise SystemExit(main(sys.argv))
