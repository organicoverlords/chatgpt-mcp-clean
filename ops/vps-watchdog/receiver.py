#!/usr/bin/env python3
import json
import os
import sys
import tempfile
import time
from pathlib import Path

MAX_HEALTHLINE_BYTES = 512 * 1024
STATE_DIR = Path(os.environ.get("V3_WATCHDOG_STATE_DIR", "/var/lib/v3-watchdog"))
STATUS_PROGRAM = os.environ.get("V3_WATCHDOG_STATUS_PROGRAM", "/opt/v3-watchdog/status.py")


def atomic_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(prefix=path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, separators=(",", ":"), sort_keys=True)
            handle.write("\n")
        os.replace(tmp_name, path)
    finally:
        if os.path.exists(tmp_name):
            os.unlink(tmp_name)


def main() -> int:
    if len(sys.argv) != 2 or sys.argv[1] not in {"KONE", "OMEN"}:
        print("invalid watchdog node", file=sys.stderr)
        return 64

    node = sys.argv[1]
    command = os.environ.get("SSH_ORIGINAL_COMMAND", "").strip()
    now = time.time()

    if command == "heartbeat":
        atomic_json(STATE_DIR / f"{node.lower()}.heartbeat.json", {"node": node, "received_at": now})
        print(json.dumps({"accepted": True, "node": node}, separators=(",", ":")))
        return 0

    if command == "healthline":
        if node != "KONE":
            print("healthline publication is KONE-owned", file=sys.stderr)
            return 64
        raw = sys.stdin.buffer.read(MAX_HEALTHLINE_BYTES + 1)
        if len(raw) > MAX_HEALTHLINE_BYTES:
            print("healthline payload too large", file=sys.stderr)
            return 65
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError as exc:
            print(f"invalid healthline json: {exc}", file=sys.stderr)
            return 65
        if not isinstance(payload, dict):
            print("healthline payload must be an object", file=sys.stderr)
            return 65
        atomic_json(STATE_DIR / "healthline.json", {"received_at": now, "payload": payload})
        print('{"accepted":true,"kind":"healthline"}')
        return 0

    if command == "status":
        os.execv(sys.executable, [sys.executable, STATUS_PROGRAM])
        return 70

    print("unsupported watchdog command", file=sys.stderr)
    return 64


if __name__ == "__main__":
    raise SystemExit(main())
