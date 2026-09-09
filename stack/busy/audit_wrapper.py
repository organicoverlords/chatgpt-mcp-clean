import argparse
import json
import os
import pathlib
import subprocess
import sys
import time

EXTRA_COMMANDS = {"contract", "log", "audit"}
MAX_AUDIT_DETAIL_CHARS = 2048
MAX_AUDIT_CHECKPOINT_CHARS = 1024
MAX_AUDIT_EXPIRED_ITEMS = 32
DEFAULT_AUDIT_MAX_BYTES = 5 * 1024 * 1024
DEFAULT_AUDIT_BACKUPS = 3
META_VALUE_FLAGS = {
    "--tool": "tool",
    "--model": "model",
    "--input-tokens": "input_tokens",
    "--output-tokens": "output_tokens",
    "--cached-tokens": "cached_tokens",
    "--reasoning-tokens": "reasoning_tokens",
    "--total-tokens": "total_tokens",
    "--cost-usd": "cost_usd",
}


def install_root() -> pathlib.Path:
    here = pathlib.Path(__file__).resolve().parent
    if (here / "coordinator-contract.json").exists():
        return here
    return here.parent


def contract_path() -> pathlib.Path:
    return install_root() / "coordinator-contract.json"


def load_contract() -> dict:
    return json.loads(contract_path().read_text(encoding="utf-8-sig"))


def default_store() -> pathlib.Path:
    if os.environ.get("BUSY_STORE_PATH"):
        return pathlib.Path(os.environ["BUSY_STORE_PATH"])
    if os.environ.get("MCP_BUSY_STORE_PATH"):
        return pathlib.Path(os.environ["MCP_BUSY_STORE_PATH"])
    local = pathlib.Path(os.environ.get("LOCALAPPDATA", pathlib.Path.home() / "AppData" / "Local"))
    return local / "ChatGPTMcpClean" / ".state" / "busy-claims.json"


def default_audit_log(store: pathlib.Path) -> pathlib.Path:
    override = os.environ.get("BUSY_AUDIT_LOG")
    return pathlib.Path(override) if override else store.with_name("busy-audit.jsonl")


def audit_limits() -> tuple[int, int]:
    max_bytes = int(os.environ.get("BUSY_AUDIT_MAX_BYTES", DEFAULT_AUDIT_MAX_BYTES))
    backups = max(1, int(os.environ.get("BUSY_AUDIT_BACKUPS", DEFAULT_AUDIT_BACKUPS)))
    return max_bytes, backups


def rotated_path(path: pathlib.Path, index: int) -> pathlib.Path:
    return pathlib.Path(str(path) + f".{index}")


def acquire_lock(path: pathlib.Path, timeout: float = 2.0) -> int:
    lock = pathlib.Path(str(path) + ".lock")
    lock.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout
    while True:
        try:
            fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            os.write(fd, f"{os.getpid()}\n".encode())
            return fd
        except (FileExistsError, PermissionError):
            try:
                if time.time() - lock.stat().st_mtime > 15.0:
                    lock.unlink(missing_ok=True)
                    continue
            except FileNotFoundError:
                continue
            if time.monotonic() >= deadline:
                raise TimeoutError(f"audit log locked: {path}")
            time.sleep(0.01)


def release_lock(path: pathlib.Path, fd: int) -> None:
    os.close(fd)
    pathlib.Path(str(path) + ".lock").unlink(missing_ok=True)


def rotate_audit(path: pathlib.Path, backups: int) -> None:
    for index in range(backups, 0, -1):
        src = path if index == 1 else rotated_path(path, index - 1)
        dst = rotated_path(path, index)
        if not src.exists():
            continue
        dst.unlink(missing_ok=True)
        os.replace(src, dst)


def append_audit(store: pathlib.Path, event: dict, *, lock_timeout: float = 2.0) -> None:
    path = default_audit_log(store)
    max_bytes, backups = audit_limits()
    line = json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n"
    encoded_size = len(line.encode("utf-8"))
    fd = acquire_lock(path, timeout=lock_timeout)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size + encoded_size > max_bytes:
            rotate_audit(path, backups)
        with path.open("a", encoding="utf-8", newline="") as handle:
            handle.write(line)
    finally:
        release_lock(path, fd)


def read_audit(store: pathlib.Path, *, limit: int = 50, actor: str | None = None,
               scope: str | None = None, tool: str | None = None,
               command: str | None = None) -> dict:
    limit = max(1, min(limit, 1000))
    path = default_audit_log(store)
    _, backups = audit_limits()
    paths = [rotated_path(path, index) for index in range(backups, 0, -1)] + [path]
    events = []
    malformed = 0
    for candidate in paths:
        if not candidate.exists():
            continue
        for line in candidate.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except Exception:
                malformed += 1
                continue
            if not isinstance(event, dict):
                malformed += 1
                continue
            if actor and event.get("actor") != actor:
                continue
            if scope and event.get("scope") != scope:
                continue
            if tool and event.get("tool") != tool:
                continue
            if command and event.get("command") != command:
                continue
            events.append(event)
    return {"ok": True, "events": events[-limit:], "malformed": malformed, "path": str(path)}


def store_and_command(argv: list[str]) -> tuple[pathlib.Path, str | None, list[str]]:
    args = list(argv)
    store = default_store()
    if len(args) >= 2 and args[0] == "--store":
        store = pathlib.Path(args[1])
        args = args[2:]
    command = args[0] if args else None
    return store, command, args[1:] if args else []


def extract_metadata(argv: list[str]) -> tuple[list[str], dict]:
    cleaned: list[str] = []
    meta = {
        "tool": os.environ.get("BUSY_TOOL"),
        "model": os.environ.get("BUSY_MODEL"),
    }
    index = 0
    while index < len(argv):
        arg = argv[index]
        field = META_VALUE_FLAGS.get(arg)
        if field:
            if index + 1 >= len(argv):
                raise ValueError(f"{arg} requires a value")
            raw = argv[index + 1]
            if field.endswith("tokens"):
                meta[field] = int(raw)
            elif field == "cost_usd":
                meta[field] = float(raw)
            else:
                meta[field] = raw
            index += 2
            continue
        cleaned.append(arg)
        index += 1
    return cleaned, {key: value for key, value in meta.items() if value is not None}


def reported_tokens(meta: dict) -> dict | None:
    values = {
        "input": meta.get("input_tokens"),
        "output": meta.get("output_tokens"),
        "cached": meta.get("cached_tokens"),
        "reasoning": meta.get("reasoning_tokens"),
        "total": meta.get("total_tokens"),
    }
    compact = {key: value for key, value in values.items() if value is not None}
    return compact or None


def find_option(args: list[str], name: str) -> str | None:
    try:
        index = args.index(name)
    except ValueError:
        return None
    return args[index + 1] if index + 1 < len(args) else None


def event_identity(command: str | None, command_args: list[str], result: dict | None) -> tuple[str | None, str | None]:
    actor = None
    scope = None
    if command in {"recover", "handoff", "claim", "heartbeat", "release", "block", "complete", "inspect"}:
        if len(command_args) >= 1:
            actor = command_args[0]
        if len(command_args) >= 2:
            scope = command_args[1]
    elif command == "next":
        actor = command_args[0] if command_args else None
    elif command in {"enqueue", "ready"}:
        scope = command_args[0] if command_args else None
    elif command == "snapshot":
        actor = find_option(command_args, "--actor")
        scope = find_option(command_args, "--scope")
    if isinstance(result, dict):
        claim = result.get("claim")
        job = result.get("job")
        if not scope and isinstance(claim, dict):
            scope = claim.get("scope")
        if not scope and isinstance(job, dict):
            scope = job.get("scope")
    return actor, scope


def parse_result(stdout: str, stderr: str) -> dict | None:
    for text in (stdout.strip(), stderr.strip()):
        if not text:
            continue
        try:
            value = json.loads(text.splitlines()[-1])
        except Exception:
            continue
        if isinstance(value, dict):
            return value
    return None


def bounded_checkpoint(value: object) -> tuple[str | None, bool, int | None]:
    if not isinstance(value, str):
        return None, False, None
    chars = len(value)
    if chars <= MAX_AUDIT_CHECKPOINT_CHARS:
        return value, False, chars
    return value[:MAX_AUDIT_CHECKPOINT_CHARS], True, chars


def compact_claim_projection(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    projected = {key: value.get(key) for key in ("actor", "scope", "timestamp") if value.get(key) is not None}
    return projected or None


def compact_handoff_projection(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    keys = ("parent_scope", "finding_id", "reported_by", "reported_at")
    projected = {key: value.get(key) for key in keys if value.get(key) is not None}
    return projected or None


def compact_job_projection(value: object) -> dict | None:
    if not isinstance(value, dict):
        return None
    keys = ("job_id", "scope", "state", "owner", "lease_expires_at", "claim_timestamp", "updated_at")
    projected = {key: value.get(key) for key in keys if key in value}
    checkpoint, truncated, chars = bounded_checkpoint(value.get("checkpoint"))
    if checkpoint is not None:
        projected["checkpoint"] = checkpoint
        if truncated:
            projected["checkpoint_truncated"] = True
            projected["checkpoint_chars"] = chars
    handoff = compact_handoff_projection(value.get("handoff"))
    if handoff is not None:
        projected["handoff"] = handoff
    return projected or None


def result_projection(result: object) -> dict | None:
    if not isinstance(result, dict):
        return None
    projected: dict = {}
    job = compact_job_projection(result.get("job"))
    if job is not None:
        projected["job"] = job
    for key in ("claim", "recovered", "released", "block", "complete"):
        claim = compact_claim_projection(result.get(key))
        if claim is not None:
            projected[key] = claim
    handoff = compact_handoff_projection(result.get("handoff"))
    if handoff is not None:
        projected["handoff"] = handoff
    expired = result.get("expired")
    if isinstance(expired, list):
        items = [compact_claim_projection(item) for item in expired[:MAX_AUDIT_EXPIRED_ITEMS]]
        projected["expired"] = [item for item in items if item is not None]
        if len(expired) > MAX_AUDIT_EXPIRED_ITEMS:
            projected["expired_truncated"] = True
            projected["expired_count"] = len(expired)
    return projected or None


def transition_projection(command: str | None, result: object) -> dict | None:
    if not isinstance(result, dict) or not result.get("ok"):
        return None
    if command not in {"recover", "handoff", "enqueue", "ready", "next", "claim", "heartbeat", "release", "block", "complete"}:
        return None
    transition: dict = {}
    job = result.get("job")
    if isinstance(job, dict) and isinstance(job.get("state"), str):
        transition["state"] = job["state"]
        transition["owner"] = job.get("owner")
    elif command in {"claim", "heartbeat"}:
        transition["state"] = "active"
        claim = result.get("claim")
        if isinstance(claim, dict):
            transition["owner"] = claim.get("actor")
    elif command == "block":
        transition["state"] = "blocked"
        transition["owner"] = None
    elif command == "complete":
        transition["state"] = "completed"
        transition["owner"] = None
    elif command == "release":
        transition["claim_released"] = True
    return transition or None


def coordinator_event(command: str | None, command_args: list[str], result: dict | None,
                      returncode: int, meta: dict, duration_ms: float, error_text: str) -> dict:
    actor, scope = event_identity(command, command_args, result)
    ok = bool(result.get("ok", returncode == 0)) if isinstance(result, dict) else returncode == 0
    reason = result.get("reason") if isinstance(result, dict) else None
    if not reason and returncode != 0:
        reason = error_text.strip().splitlines()[-1] if error_text.strip() else f"exit_{returncode}"
    checkpoint, checkpoint_truncated, checkpoint_chars = bounded_checkpoint(find_option(command_args, "--checkpoint"))
    event = {
        "schema": 1,
        "event_type": "coordinator_command",
        "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int((time.time()%1)*1000):03d}Z",
        "command": command,
        "actor": actor,
        "scope": scope,
        "operation_id": find_option(command_args, "--operation-id"),
        "checkpoint": checkpoint,
        "checkpoint_truncated": True if checkpoint_truncated else None,
        "checkpoint_chars": checkpoint_chars if checkpoint_truncated else None,
        "ok": ok,
        "reason": reason,
        "result_projection": result_projection(result),
        "transition": transition_projection(command, result),
        "tool": meta.get("tool"),
        "model": meta.get("model"),
        "tokens": reported_tokens(meta),
        "cost_usd": meta.get("cost_usd"),
        "duration_ms": round(duration_ms, 3),
        "pid": os.getpid(),
        "machine": os.environ.get("COMPUTERNAME"),
    }
    return {key: value for key, value in event.items() if value is not None}


def target_command(implementation: str, root: pathlib.Path) -> list[str]:
    if implementation == "python":
        return [sys.executable, str(root / "python" / "busy.py")]
    if implementation == "rust":
        candidate = root / "rust" / "busy-coordinator.exe"
        if not candidate.exists():
            candidate = root / "rust" / "target" / "release" / "busy-coordinator.exe"
        return [str(candidate)]
    raise ValueError(f"unknown implementation: {implementation}")


def print_help(contract: dict) -> int:
    commands = ",".join(contract["required_commands"])
    print(f"usage: busy [--store STORE] {{{commands}}} ...")
    print("\nCoordinator state commands are delegated to the selected core implementation.")
    print("contract/audit/log are non-authoritative observability extensions outside the ownership store; log is best-effort and never a durable project record.")
    return 0


def handle_contract(contract: dict, implementation: str) -> int:
    print(json.dumps({
        "ok": True,
        "contract_version": contract["contract_version"],
        "state_schema_version": contract["canonical_store"]["coordinator_schema_version"],
        "authority": contract["authority"],
        "implementation": implementation,
        "required_commands": contract["required_commands"],
        "core_required_commands": contract["core_required_commands"],
    }, separators=(",", ":")))
    return 0


def handle_audit(store: pathlib.Path, args: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="busy audit")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--actor")
    parser.add_argument("--scope")
    parser.add_argument("--tool")
    parser.add_argument("--command")
    parsed = parser.parse_args(args)
    print(json.dumps(read_audit(store, limit=parsed.limit, actor=parsed.actor, scope=parsed.scope,
                                tool=parsed.tool, command=parsed.command), separators=(",", ":")))
    return 0


def handle_log(store: pathlib.Path, args: list[str], meta: dict) -> int:
    parser = argparse.ArgumentParser(prog="busy log")
    parser.add_argument("actor")
    parser.add_argument("scope")
    parser.add_argument("--action", required=True)
    parser.add_argument("--target")
    parser.add_argument("--detail")
    parser.add_argument("--duration-ms", type=float)
    parser.add_argument("--failed", action="store_true")
    parser.add_argument("--reason")
    parser.add_argument("--operation-id")
    parsed = parser.parse_args(args)
    if parsed.detail is not None and len(parsed.detail) > MAX_AUDIT_DETAIL_CHARS:
        raise ValueError(f"detail exceeds {MAX_AUDIT_DETAIL_CHARS} characters")
    event = {
        "schema": 1,
        "event_type": "tool_event",
        "at": time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime()) + f".{int((time.time()%1)*1000):03d}Z",
        "command": parsed.action,
        "actor": parsed.actor,
        "scope": parsed.scope.strip(),
        "operation_id": parsed.operation_id,
        "ok": not parsed.failed,
        "reason": parsed.reason,
        "tool": meta.get("tool"),
        "model": meta.get("model"),
        "target": parsed.target,
        "detail": parsed.detail,
        "tokens": reported_tokens(meta),
        "cost_usd": meta.get("cost_usd"),
        "duration_ms": parsed.duration_ms,
        "pid": os.getpid(),
        "machine": os.environ.get("COMPUTERNAME"),
    }
    event = {key: value for key, value in event.items() if value is not None}
    try:
        append_audit(store, event, lock_timeout=0.25)
    except Exception as exc:
        print(json.dumps({"ok": True, "logged": False, "non_authoritative": True,
                          "warning": str(exc), "event": event}, separators=(",", ":")))
        return 0
    print(json.dumps({"ok": True, "logged": event}, separators=(",", ":")))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--impl", choices=("python", "rust"), required=True)
    known, remaining = parser.parse_known_args()
    root = install_root()
    contract = load_contract()
    if not remaining or remaining == ["--help"] or remaining == ["-h"]:
        return print_help(contract)
    try:
        cleaned, meta = extract_metadata(remaining)
        store, command, command_args = store_and_command(cleaned)
        if command == "contract":
            return handle_contract(contract, known.impl)
        if command == "audit":
            return handle_audit(store, command_args)
        if command == "log":
            return handle_log(store, command_args, meta)
        started = time.perf_counter()
        cp = subprocess.run(target_command(known.impl, root) + cleaned, capture_output=True, text=True, check=False)
        duration_ms = (time.perf_counter() - started) * 1000
        if cp.stdout:
            sys.stdout.write(cp.stdout)
        if cp.stderr:
            sys.stderr.write(cp.stderr)
        result = parse_result(cp.stdout, cp.stderr)
        try:
            append_audit(store, coordinator_event(command, command_args, result, cp.returncode, meta, duration_ms, cp.stderr))
        except Exception as exc:
            print(f"audit warning: {exc}", file=sys.stderr)
        return cp.returncode
    except SystemExit as exc:
        return int(exc.code)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
