import argparse
import json
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

LOCK_TIMEOUT_S = 2.0
LOCK_STALE_S = 15.0
LOCK_RETRY_S = 0.01
REPLACE_TIMEOUT_S = 0.5
REPLACE_RETRY_S = 0.01
TEMP_STALE_S = 60.0
MAX_SWEEP_TEMP_ITEMS = 32
DEFAULT_LEASE_S = 240
MAX_LEASE_S = 240
MAX_OPERATIONS = 512


def default_store() -> Path:
    if os.environ.get("BUSY_STORE_PATH"):
        return Path(os.environ["BUSY_STORE_PATH"])
    if os.environ.get("MCP_BUSY_STORE_PATH"):
        return Path(os.environ["MCP_BUSY_STORE_PATH"])
    base = Path(os.environ.get("LOCALAPPDATA", Path.home() / "AppData" / "Local"))
    return base / "ChatGPTMcpClean" / ".state" / "busy-claims.json"


def now_dt() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime | None = None) -> str:
    return (dt or now_dt()).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def capped_lease_seconds(value: int) -> int:
    # BUSY is collision avoidance only. A heartbeat can prove ownership for at
    # most four more minutes; callers cannot extend a lock beyond that horizon.
    return max(1, min(int(value), MAX_LEASE_S))


def capped_lease_expiry(claim_timestamp: str, raw_lease: object = None) -> str:
    cap = parse_iso(claim_timestamp) + timedelta(seconds=MAX_LEASE_S)
    if isinstance(raw_lease, str):
        try:
            return iso(min(parse_iso(raw_lease), cap))
        except Exception:
            pass
    return iso(cap)


def canonical_scope(scope: str) -> str:
    value = scope.strip()
    if not value:
        raise ValueError("scope must not be empty")
    # Busy scopes are often logical identifiers and must remain opaque. For an
    # explicitly absolute filesystem scope, however, Windows spelling aliases
    # (case, separator style, and `.` segments) name the same mutation resource
    # and therefore must collide atomically. Keep this lexical: claims may name
    # files that do not exist yet, so never require filesystem resolution.
    if os.path.isabs(value):
        return os.path.normcase(os.path.normpath(value))
    return value


def ambiguous_relative_path_scope(scope: str) -> bool:
    value = scope.strip()
    if not value or os.path.isabs(value):
        return False
    # A bare repo-relative path has no repository identity, so the same physical
    # file can otherwise be claimed simultaneously as e.g. `scripts/x.py` and
    # `p3:file:scripts/x.py`. New path-like claims must therefore be either an
    # absolute filesystem path or a namespaced logical identifier.
    return ("/" in value or "\\" in value) and ":" not in value


CLAIM_ACTOR_HARNESSES = ("ChatGPT", "Codex", "Claude", "OpenCode", "CommandCode", "Traycer")


def validate_claim_actor(actor: str) -> str:
    value = actor.strip()
    for harness in CLAIM_ACTOR_HARNESSES:
        if value.startswith(harness):
            rest = value[len(harness):]
            if len(rest) > 1 and rest[0] in "-:/" and rest[1:].strip():
                return value
    raise ValueError("claim actor must be <harness><separator><task/session suffix>")


class StoreLock:
    def __init__(self, store: Path):
        self.path = Path(str(store) + ".lock")
        self.fd = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        deadline = time.monotonic() + LOCK_TIMEOUT_S
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, f"{os.getpid()}\n".encode())
                return self
            except (FileExistsError, PermissionError):
                try:
                    if time.time() - self.path.stat().st_mtime > LOCK_STALE_S:
                        self.path.unlink(missing_ok=True)
                        continue
                except FileNotFoundError:
                    continue
                if time.monotonic() >= deadline:
                    raise TimeoutError("busy store locked by another writer")
                time.sleep(LOCK_RETRY_S)

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass


def empty_state() -> dict:
    return {"claims": [], "coordinator": {"version": 1, "jobs": {}, "operations": {}}}


def load_state(store: Path) -> dict:
    try:
        data = json.loads(store.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return empty_state()
    except Exception as exc:
        raise RuntimeError(f"cannot safely read BUSY store: {store}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("claims"), list):
        raise RuntimeError("invalid BUSY store shape")
    claims_by_scope: dict[str, dict] = {}
    for claim in data["claims"]:
        if not (isinstance(claim, dict) and all(isinstance(claim.get(k), str) for k in ("actor", "scope", "timestamp"))):
            continue
        scope = canonical_scope(claim["scope"])
        normalized = {"actor": claim["actor"], "scope": scope, "timestamp": claim["timestamp"]}
        previous = claims_by_scope.get(scope)
        if previous is None:
            claims_by_scope[scope] = normalized
            continue
        if previous["actor"] != normalized["actor"]:
            raise RuntimeError(f"conflicting BUSY claims canonicalize to one scope: {scope}")
        # Same-owner aliases represent one exact mutation resource. Preserve the
        # newest receipt so compatibility writers cannot resurrect an older spelling.
        if normalized["timestamp"] > previous["timestamp"]:
            claims_by_scope[scope] = normalized
    data["claims"] = list(claims_by_scope.values())
    coord = data.get("coordinator")
    if not isinstance(coord, dict):
        coord = {}
    if not isinstance(coord.get("jobs"), dict):
        coord["jobs"] = {}
    if not isinstance(coord.get("operations"), dict):
        coord["operations"] = {}
    coord["version"] = 1
    data["coordinator"] = coord
    return data


def persist(store: Path, state: dict) -> None:
    store.parent.mkdir(parents=True, exist_ok=True)
    payload = (json.dumps(state, indent=2, sort_keys=False) + "\n").encode("utf-8")
    tmp = Path(str(store) + f".{os.getpid()}.tmp")
    tmp.write_bytes(payload)
    deadline = time.monotonic() + REPLACE_TIMEOUT_S
    last_error: PermissionError | None = None
    while True:
        try:
            os.replace(tmp, store)
            return
        except PermissionError as exc:
            last_error = exc
            if time.monotonic() < deadline:
                time.sleep(REPLACE_RETRY_S)
                continue
            break

    # Windows readers may keep the store open without FILE_SHARE_DELETE. In that
    # state replace/rename is impossible for the lifetime of the reader even though
    # ordinary writes are still permitted. The coordinator lock still serializes all
    # writers, so fall back to an in-place overwrite rather than wedging ownership.
    try:
        with open(store, "r+b", buffering=0) as handle:
            handle.seek(0)
            handle.write(payload)
            handle.truncate()
            os.fsync(handle.fileno())
        tmp.unlink(missing_ok=True)
        return
    except OSError:
        tmp.unlink(missing_ok=True)
        if last_error is not None:
            raise last_error
        raise


def claim_for(state: dict, scope: str):
    return next((c for c in state["claims"] if c["scope"] == scope), None)


def job_for(state: dict, scope: str):
    job = state["coordinator"]["jobs"].get(scope)
    return job if isinstance(job, dict) else None


def normalize_jobs(state: dict) -> bool:
    """Normalize BUSY lease metadata without inferring any work lifecycle state."""
    jobs = state["coordinator"]["jobs"]
    raw_jobs: dict[str, dict] = {}
    known = {"job_id", "scope", "state", "owner", "lease_expires_at", "claim_timestamp", "checkpoint", "updated_at"}
    for raw_scope, raw_job in jobs.items():
        if not isinstance(raw_job, dict):
            continue
        try:
            scope = canonical_scope(str(raw_job.get("scope") or raw_scope))
        except ValueError:
            continue
        raw_jobs[scope] = raw_job

    normalized: dict[str, dict] = {}
    for claim in state["claims"]:
        scope = claim["scope"]
        raw_job = raw_jobs.get(scope, {})
        checkpoint = raw_job.get("checkpoint") if isinstance(raw_job.get("checkpoint"), str) else None
        extra = {key: value for key, value in raw_job.items() if key not in known}
        normalized[scope] = {
            "job_id": scope,
            "scope": scope,
            "state": "active",
            "owner": claim["actor"],
            "lease_expires_at": capped_lease_expiry(claim["timestamp"], raw_job.get("lease_expires_at")),
            "claim_timestamp": claim["timestamp"],
            "checkpoint": checkpoint,
            "updated_at": claim["timestamp"],
            **extra,
        }
    changed = normalized != jobs
    state["coordinator"]["jobs"] = normalized
    return changed


def compact_job(job: dict) -> dict:
    return {
        key: job.get(key)
        for key in ("scope", "state", "owner", "checkpoint", "lease_expires_at", "updated_at")
        if job.get(key) is not None
    }


def snapshot_state(state: dict, *, actor: str | None = None, raw_scope: str | None = None,
                   limit: int = 8, expired: list[dict] | None = None) -> dict:
    limit = max(1, min(limit, 32))
    claims = sorted(state["claims"], key=lambda claim: claim["scope"])
    jobs = state["coordinator"]["jobs"]
    active = sorted(
        (job for job in jobs.values() if isinstance(job, dict) and job.get("state") == "active"),
        key=lambda job: str(job.get("scope", "")),
    )
    managed_scopes = {str(job.get("scope")) for job in active}
    legacy_only = [claim for claim in claims if claim["scope"] not in managed_scopes]
    result = {
        "ok": True,
        "counts": {
            "active": len(active),
            "claims": len(claims),
            "legacy_only_claims": len(legacy_only),
        },
        "legacy_only_claims": legacy_only[:limit],
    }
    if actor:
        result["owned"] = [compact_job(job) for job in active if job.get("owner") == actor][:limit]
        result["active_other"] = [compact_job(job) for job in active if job.get("owner") != actor][:limit]
    else:
        result["active"] = [compact_job(job) for job in active[:limit]]
    if raw_scope:
        scope = canonical_scope(raw_scope)
        result["focus"] = {"scope": scope, "job": job_for(state, scope), "claim": claim_for(state, scope)}
    if expired:
        result["expired"] = expired[:limit]
    return result



def prune_operations(state: dict) -> None:
    ops = state["coordinator"]["operations"]
    if len(ops) <= MAX_OPERATIONS:
        return
    ordered = sorted(ops.items(), key=lambda item: str(item[1].get("at", "")))
    for key, _ in ordered[: len(ops) - MAX_OPERATIONS]:
        ops.pop(key, None)


def idempotent(state: dict, operation_id: str | None, signature: dict):
    if not operation_id:
        return None
    current = state["coordinator"]["operations"].get(operation_id)
    if current is None:
        return None
    if current.get("signature") != signature:
        return {"ok": False, "reason": "idempotency_conflict", "operation_id": operation_id}
    result = current.get("result")
    return result if isinstance(result, dict) else {"ok": False, "reason": "invalid_idempotency_record"}


def remember(state: dict, operation_id: str | None, signature: dict, result: dict) -> dict:
    if operation_id:
        state["coordinator"]["operations"][operation_id] = {
            "at": iso(),
            "signature": signature,
            "result": result,
        }
        prune_operations(state)
    return result


def remove_scope_metadata(state: dict, scope: str) -> None:
    state["coordinator"]["jobs"].pop(scope, None)


def writer_process_state(pid: int) -> str:
    if pid <= 0:
        return "unknown"
    if os.name != "nt":
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return "dead"
        except PermissionError:
            return "live"
        except OSError:
            return "unknown"
        return "live"

    import ctypes
    from ctypes import wintypes

    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel32.GetExitCodeProcess.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.CloseHandle.restype = wintypes.BOOL

    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return "dead" if ctypes.get_last_error() == 87 else "unknown"
    try:
        exit_code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return "unknown"
        return "live" if exit_code.value == still_active else "dead"
    finally:
        kernel32.CloseHandle(handle)


def sweep_stale_temp_files(store: Path) -> dict:
    parent = store.parent
    if not parent.exists():
        return {"removed_temp_count": 0, "removed_temp_files": []}
    prefix = store.name + "."
    suffix = ".tmp"
    now = time.time()
    removed_count = 0
    removed_files: list[dict] = []
    try:
        candidates = sorted(parent.iterdir(), key=lambda path: path.name)
    except OSError:
        return {"removed_temp_count": 0, "removed_temp_files": []}

    for candidate in candidates:
        name = candidate.name
        if not name.startswith(prefix) or not name.endswith(suffix):
            continue
        raw_pid = name[len(prefix):-len(suffix)]
        if not raw_pid.isdigit():
            continue
        try:
            pid = int(raw_pid)
            info = candidate.lstat()
        except (OSError, ValueError):
            continue
        if pid <= 0 or candidate.is_symlink() or not candidate.is_file():
            continue
        age = now - info.st_mtime
        if age < TEMP_STALE_S:
            continue
        if writer_process_state(pid) != "dead":
            continue
        try:
            candidate.unlink()
        except (FileNotFoundError, OSError):
            continue
        removed_count += 1
        if len(removed_files) < MAX_SWEEP_TEMP_ITEMS:
            removed_files.append({"name": name, "pid": pid})

    return {"removed_temp_count": removed_count, "removed_temp_files": removed_files}


def sweep_expired(state: dict) -> tuple[list[dict], bool]:
    now = now_dt()
    expired: list[dict] = []
    changed = False
    for scope, job in list(state["coordinator"]["jobs"].items()):
        if not isinstance(job, dict) or job.get("state") != "active":
            continue
        lease = job.get("lease_expires_at")
        owner = job.get("owner")
        if not isinstance(lease, str) or not isinstance(owner, str):
            continue
        try:
            if parse_iso(lease) > now:
                continue
        except Exception:
            continue
        current = claim_for(state, scope)
        if current and current.get("actor") == owner:
            state["claims"] = [claim for claim in state["claims"] if claim.get("scope") != scope]
        checkpoint = job.get("checkpoint") if isinstance(job.get("checkpoint"), str) else None
        remove_scope_metadata(state, scope)
        expired.append({"scope": scope, "previous_owner": owner, "checkpoint": checkpoint})
        changed = True
    return expired, changed


def operate(store: Path, command: str, actor: str | None = None, raw_scope: str | None = None,
            *, lease_seconds: int = DEFAULT_LEASE_S, checkpoint: str | None = None,
            operation_id: str | None = None, limit: int = 8,
            expected_claim_timestamp: str | None = None) -> dict:
    with StoreLock(store):
        state = load_state(store)
        normalized = normalize_jobs(state)
        swept, sweep_changed = sweep_expired(state)
        state_changed = normalized or sweep_changed

        if command in {"list", "sweep", "snapshot"}:
            temp_sweep = sweep_stale_temp_files(store) if command == "sweep" else None
            if state_changed:
                persist(store, state)
            if command == "list":
                return {"claims": sorted(state["claims"], key=lambda claim: claim["scope"])}
            if command == "snapshot":
                return snapshot_state(state, actor=actor, raw_scope=raw_scope, limit=limit, expired=swept)
            return {"ok": True, "expired": swept, **temp_sweep}

        if raw_scope is None:
            raise ValueError("scope required")
        scope = canonical_scope(raw_scope)

        if command == "recover":
            if actor is None:
                raise ValueError("expected owner required")
            if not expected_claim_timestamp:
                raise ValueError("--expected-claim-timestamp required")
            signature = {
                "command": command,
                "expected_owner": actor,
                "scope": scope,
                "expected_claim_timestamp": expected_claim_timestamp,
            }
            replay = idempotent(state, operation_id, signature)
            if replay is not None:
                if state_changed:
                    persist(store, state)
                return replay
            current = claim_for(state, scope)
            if current is None:
                result = {"ok": False, "reason": "scope_not_claimed"}
            elif current.get("actor") != actor or current.get("timestamp") != expected_claim_timestamp:
                result = {"ok": False, "reason": "claim_changed", "claim": current}
            else:
                state["claims"] = [claim for claim in state["claims"] if claim.get("scope") != scope]
                job = job_for(state, scope)
                saved_checkpoint = job.get("checkpoint") if isinstance(job, dict) and isinstance(job.get("checkpoint"), str) else None
                remove_scope_metadata(state, scope)
                result = {"ok": True, "recovered": current}
                if saved_checkpoint:
                    result["checkpoint"] = saved_checkpoint
            result = remember(state, operation_id, signature, result)
            persist(store, state)
            return result

        if command == "inspect":
            if state_changed:
                persist(store, state)
            return {"ok": True, "job": job_for(state, scope), "claim": claim_for(state, scope)}

        if actor is None:
            raise ValueError("actor required")
        if command in {"claim", "heartbeat"}:
            actor = validate_claim_actor(actor)
        if command in {"claim", "heartbeat"}:
            lease_seconds = capped_lease_seconds(lease_seconds)
        signature = {"command": command, "scope": scope, "actor": actor}
        if command in {"claim", "heartbeat"}:
            signature["lease_seconds"] = lease_seconds
        if checkpoint is not None:
            signature["checkpoint"] = checkpoint
        replay = idempotent(state, operation_id, signature)
        if replay is not None:
            if state_changed:
                persist(store, state)
            return replay

        current = claim_for(state, scope)
        existing = job_for(state, scope)
        if command == "claim":
            if current is None and ambiguous_relative_path_scope(raw_scope):
                result = {
                    "ok": False,
                    "reason": "ambiguous_relative_path_scope",
                    "scope": scope,
                    "guidance": "use an absolute filesystem path or a namespaced logical scope such as <repo>:file:<path>",
                }
            elif current and current.get("actor") != actor:
                result = {"ok": False, "reason": "scope_already_claimed", "claim": current}
            else:
                timestamp = iso()
                claim = {"actor": actor, "scope": scope, "timestamp": timestamp}
                state["claims"] = [item for item in state["claims"] if item.get("scope") != scope] + [claim]
                deadline = now_dt() + timedelta(seconds=lease_seconds)
                saved_checkpoint = checkpoint if checkpoint is not None else ((existing or {}).get("checkpoint"))
                state["coordinator"]["jobs"][scope] = {
                    "job_id": scope,
                    "scope": scope,
                    "state": "active",
                    "owner": actor,
                    "lease_expires_at": iso(deadline),
                    "claim_timestamp": timestamp,
                    "checkpoint": saved_checkpoint,
                    "updated_at": timestamp,
                }
                result = {"ok": True, "claim": claim}
        elif command == "heartbeat":
            if not current:
                result = {"ok": False, "reason": "scope_not_claimed"}
            elif current.get("actor") != actor:
                result = {"ok": False, "reason": "claim_belongs_to_another_actor", "claim": current}
            else:
                timestamp = iso()
                current["timestamp"] = timestamp
                deadline = now_dt() + timedelta(seconds=lease_seconds)
                saved_checkpoint = checkpoint if checkpoint is not None else ((existing or {}).get("checkpoint"))
                state["coordinator"]["jobs"][scope] = {
                    "job_id": scope,
                    "scope": scope,
                    "state": "active",
                    "owner": actor,
                    "lease_expires_at": iso(deadline),
                    "claim_timestamp": timestamp,
                    "checkpoint": saved_checkpoint,
                    "updated_at": timestamp,
                }
                result = {"ok": True, "claim": current}
        elif command == "release":
            if not current:
                result = {"ok": False, "reason": "scope_not_claimed"}
            elif current.get("actor") != actor:
                result = {"ok": False, "reason": "claim_belongs_to_another_actor", "claim": current}
            else:
                state["claims"] = [item for item in state["claims"] if item.get("scope") != scope]
                remove_scope_metadata(state, scope)
                result = {"ok": True, "released": current}
                if checkpoint:
                    result["checkpoint"] = checkpoint
        else:
            raise ValueError(f"unknown command: {command}")

        result = remember(state, operation_id, signature, result)
        persist(store, state)
        return result


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="busy")
    parser.add_argument("--store", type=Path, default=default_store())
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("sweep")
    snapshot = sub.add_parser("snapshot")
    snapshot.add_argument("--actor")
    snapshot.add_argument("--scope")
    snapshot.add_argument("--limit", type=int, default=8)
    recover = sub.add_parser("recover")
    recover.add_argument("actor")
    recover.add_argument("scope")
    recover.add_argument("--expected-claim-timestamp", required=True)
    recover.add_argument("--operation-id")
    inspect = sub.add_parser("inspect")
    inspect.add_argument("scope_or_actor")
    inspect.add_argument("legacy_scope", nargs="?")
    inspect.add_argument("--operation-id")
    for name in ("claim", "heartbeat", "release"):
        command = sub.add_parser(name)
        command.add_argument("actor")
        command.add_argument("scope")
        command.add_argument("--operation-id")
        if name in {"claim", "heartbeat"}:
            command.add_argument("--lease-seconds", type=int, default=DEFAULT_LEASE_S)
        command.add_argument("--checkpoint")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.cmd in {"list", "sweep"}:
            result = operate(args.store, args.cmd)
        elif args.cmd == "snapshot":
            result = operate(args.store, args.cmd, args.actor, args.scope, limit=args.limit)
        elif args.cmd == "recover":
            result = operate(
                args.store, args.cmd, args.actor, args.scope,
                operation_id=args.operation_id,
                expected_claim_timestamp=args.expected_claim_timestamp,
            )
        elif args.cmd == "inspect":
            scope = args.legacy_scope or args.scope_or_actor
            result = operate(args.store, args.cmd, raw_scope=scope, operation_id=args.operation_id)
        else:
            result = operate(
                args.store,
                args.cmd,
                args.actor,
                args.scope,
                lease_seconds=getattr(args, "lease_seconds", DEFAULT_LEASE_S),
                checkpoint=getattr(args, "checkpoint", None),
                operation_id=getattr(args, "operation_id", None),
            )
        print(json.dumps(result, separators=(",", ":")))
        return 0
    except TimeoutError as exc:
        print(json.dumps({"ok": False, "reason": "store_locked", "error": str(exc)}, separators=(",", ":")), file=sys.stderr)
        return 75
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
