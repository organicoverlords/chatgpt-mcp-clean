import argparse
import ctypes
import json
import os
import pathlib
import secrets
import signal
import subprocess
import sys
import tempfile
import time

DEFAULT_LEASE_SECONDS = 90
BUSY_EXIT = 75
OWNERSHIP_LOST_EXIT = 76
CHILD_COUPLING_EXIT = 77


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


def source_root() -> pathlib.Path:
    return pathlib.Path(__file__).resolve().parents[1]


def core_command(implementation: str, store: pathlib.Path | None) -> list[str]:
    root = source_root()
    if implementation == "python":
        command = [sys.executable, str(root / "python" / "busy.py")]
    else:
        candidates = (
            root / "rust" / "busy-coordinator.exe",
            root / "rust" / "target" / "release" / "busy-coordinator.exe",
        )
        binary = next((path for path in candidates if path.exists()), None)
        if binary is None:
            raise RuntimeError("rust BusyCoordinator binary is not installed or built")
        command = [str(binary)]
    if store is not None:
        command.extend(["--store", str(store)])
    return command


def invoke_core(implementation: str, store: pathlib.Path | None, *args: str) -> dict:
    cp = subprocess.run(
        [*core_command(implementation, store), *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if cp.returncode != 0:
        detail = (cp.stderr or cp.stdout).strip()
        raise RuntimeError(detail or f"BusyCoordinator exited {cp.returncode}")
    try:
        result = json.loads(cp.stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"invalid BusyCoordinator JSON: {cp.stdout!r}") from exc
    if not isinstance(result, dict):
        raise RuntimeError("BusyCoordinator result is not an object")
    return result


def guard_owner(actor: str) -> str:
    return f"{actor}/guard-{os.getpid()}-{secrets.token_hex(4)}"


def emit_status(payload: dict) -> None:
    print(
        "BUSY_GUARD " + json.dumps(payload, separators=(",", ":")),
        file=sys.stderr,
        flush=True,
    )


class WindowsKillOnCloseJob:
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    JobObjectExtendedLimitInformation = 9

    def __init__(self) -> None:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel32 = kernel32
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
        kernel32.CreateJobObjectW.restype = ctypes.c_void_p
        kernel32.SetInformationJobObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_int,
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        kernel32.SetInformationJobObject.restype = ctypes.c_int
        kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        kernel32.AssignProcessToJobObject.restype = ctypes.c_int
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_int

        handle = kernel32.CreateJobObjectW(None, None)
        if not handle:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        self.handle = handle
        info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
        info.BasicLimitInformation.LimitFlags = self.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        ok = kernel32.SetInformationJobObject(
            self.handle,
            self.JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            error = ctypes.get_last_error()
            self.close()
            raise OSError(error, "SetInformationJobObject failed")

    def assign(self, process: subprocess.Popen) -> None:
        handle = ctypes.c_void_p(int(process._handle))  # type: ignore[attr-defined]
        if not self.kernel32.AssignProcessToJobObject(self.handle, handle):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")

    def close(self) -> None:
        if getattr(self, "handle", None):
            self.kernel32.CloseHandle(self.handle)
            self.handle = None


def linux_pdeathsig(parent_pid: int):
    def configure() -> None:
        libc = ctypes.CDLL(None)
        PR_SET_PDEATHSIG = 1
        if libc.prctl(PR_SET_PDEATHSIG, signal.SIGKILL) != 0:
            os._exit(CHILD_COUPLING_EXIT)
        if os.getppid() != parent_pid:
            os.kill(os.getpid(), signal.SIGKILL)

    return configure


def new_gate() -> pathlib.Path:
    fd, raw = tempfile.mkstemp(prefix="busy-lease-guard-", suffix=".gate")
    os.close(fd)
    path = pathlib.Path(raw)
    path.unlink(missing_ok=True)
    return path


def child_runner(gate: pathlib.Path, command: list[str]) -> int:
    deadline = time.monotonic() + 30.0
    while not gate.exists():
        if time.monotonic() >= deadline:
            return CHILD_COUPLING_EXIT
        time.sleep(0.02)
    gate.unlink(missing_ok=True)

    if os.name == "nt":
        if pathlib.Path(command[0]).suffix.lower() in {".cmd", ".bat"}:
            command = [os.environ.get("COMSPEC", "cmd.exe"), "/d", "/c", *command]
        return subprocess.call(command)

    os.execvp(command[0], command)
    return CHILD_COUPLING_EXIT


class CoupledChild:
    def __init__(self, command: list[str]) -> None:
        self.command = command
        self.gate = new_gate()
        self.job: WindowsKillOnCloseJob | None = None
        self.process: subprocess.Popen | None = None

    def start(self) -> subprocess.Popen:
        runner = [
            sys.executable,
            str(pathlib.Path(__file__).resolve()),
            "--_child-runner",
            str(self.gate),
            "--",
            *self.command,
        ]
        if os.name == "nt":
            self.job = WindowsKillOnCloseJob()
            self.process = subprocess.Popen(runner)
            try:
                self.job.assign(self.process)
            except Exception:
                self.process.kill()
                self.process.wait(timeout=5)
                self.job.close()
                raise
        elif sys.platform.startswith("linux"):
            self.process = subprocess.Popen(
                runner,
                start_new_session=True,
                preexec_fn=linux_pdeathsig(os.getpid()),
            )
        else:
            raise RuntimeError(
                "lease guard requires Windows Job Objects or Linux PR_SET_PDEATHSIG "
                "to prevent a guarded child from outliving the guard"
            )

        self.gate.write_text("go\n", encoding="ascii")
        return self.process

    def terminate(self) -> None:
        process = self.process
        if process is None or process.poll() is not None:
            return
        if os.name == "nt":
            if self.job is not None:
                self.job.close()
            else:
                process.kill()
        else:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)

    def close(self) -> None:
        self.gate.unlink(missing_ok=True)
        if self.job is not None:
            self.job.close()
            self.job = None


def build_outer_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="busy-run",
        description=(
            "Run one mutation critical section under a short renewable Busy lease. "
            "The child is coupled to the guard process; guard death stops the child "
            "and ordinary lease expiry clears the stale claim."
        ),
    )
    parser.add_argument("--impl", choices=("python", "rust"), default="python")
    parser.add_argument("--store", type=pathlib.Path)
    parser.add_argument("--lease-seconds", type=int, default=DEFAULT_LEASE_SECONDS)
    parser.add_argument("--heartbeat-seconds", type=float)
    parser.add_argument("--checkpoint")
    parser.add_argument("actor")
    parser.add_argument("scope")
    return parser


def parse_outer(argv: list[str]) -> tuple[argparse.Namespace, list[str]]:
    parser = build_outer_parser()
    if "--" not in argv:
        if any(item in {"-h", "--help"} for item in argv):
            parser.parse_args(argv)
        parser.error("guarded command must follow --")
    split = argv.index("--")
    guard_argv = argv[:split]
    command = argv[split + 1 :]
    if not command:
        parser.error("guarded command must not be empty")

    args = parser.parse_args(guard_argv)
    if args.lease_seconds < 2:
        parser.error("--lease-seconds must be at least 2")
    if args.heartbeat_seconds is None:
        args.heartbeat_seconds = min(20.0, args.lease_seconds / 3.0)
    if args.heartbeat_seconds <= 0 or args.heartbeat_seconds >= args.lease_seconds:
        parser.error("--heartbeat-seconds must be > 0 and < --lease-seconds")
    return args, command


def run_guarded(args: argparse.Namespace, command: list[str]) -> int:
    owner = guard_owner(args.actor)
    checkpoint = args.checkpoint or f"guarded child: {pathlib.Path(command[0]).name}"
    lease = str(args.lease_seconds)

    claim = invoke_core(
        args.impl,
        args.store,
        "claim",
        owner,
        args.scope,
        "--lease-seconds",
        lease,
        "--checkpoint",
        checkpoint,
    )
    if not claim.get("ok"):
        emit_status(
            {
                "ok": False,
                "reason": claim.get("reason", "claim_failed"),
                "scope": args.scope,
                "claim": claim.get("claim"),
            }
        )
        return BUSY_EXIT

    child = CoupledChild(command)
    child_exit: int | None = None
    ownership_lost = False
    release_failed = False
    try:
        process = child.start()
        next_heartbeat = time.monotonic() + args.heartbeat_seconds
        while True:
            child_exit = process.poll()
            if child_exit is not None:
                break
            now = time.monotonic()
            if now >= next_heartbeat:
                try:
                    heartbeat = invoke_core(
                        args.impl,
                        args.store,
                        "heartbeat",
                        owner,
                        args.scope,
                        "--lease-seconds",
                        lease,
                        "--checkpoint",
                        checkpoint,
                    )
                except Exception as exc:
                    emit_status(
                        {
                            "ok": False,
                            "reason": "heartbeat_error",
                            "scope": args.scope,
                            "error": str(exc),
                        }
                    )
                    ownership_lost = True
                    child.terminate()
                    break
                if not heartbeat.get("ok"):
                    emit_status(
                        {
                            "ok": False,
                            "reason": heartbeat.get("reason", "heartbeat_failed"),
                            "scope": args.scope,
                            "claim": heartbeat.get("claim"),
                        }
                    )
                    ownership_lost = True
                    child.terminate()
                    break
                next_heartbeat = now + args.heartbeat_seconds
            time.sleep(min(0.1, max(0.01, next_heartbeat - now)))
    except KeyboardInterrupt:
        ownership_lost = True
        child.terminate()
    except Exception as exc:
        emit_status(
            {
                "ok": False,
                "reason": "child_coupling_error",
                "scope": args.scope,
                "error": str(exc),
            }
        )
        ownership_lost = True
        child.terminate()
    finally:
        try:
            release = invoke_core(
                args.impl,
                args.store,
                "release",
                owner,
                args.scope,
                "--checkpoint",
                "guarded child ended",
            )
            if not release.get("ok"):
                release_failed = True
                emit_status(
                    {
                        "ok": False,
                        "reason": release.get("reason", "release_failed"),
                        "scope": args.scope,
                        "claim": release.get("claim"),
                    }
                )
        except Exception as exc:
            release_failed = True
            emit_status(
                {
                    "ok": False,
                    "reason": "release_error",
                    "scope": args.scope,
                    "error": str(exc),
                }
            )
        child.close()

    if ownership_lost or release_failed:
        return OWNERSHIP_LOST_EXIT
    emit_status(
        {
            "ok": True,
            "scope": args.scope,
            "child_exit": child_exit,
            "lease_seconds": args.lease_seconds,
        }
    )
    return int(child_exit or 0)


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "--_child-runner":
        if len(argv) < 4 or argv[2] != "--":
            return CHILD_COUPLING_EXIT
        return child_runner(pathlib.Path(argv[1]), argv[3:])

    args, command = parse_outer(argv)
    try:
        return run_guarded(args, command)
    except Exception as exc:
        emit_status({"ok": False, "reason": "guard_error", "error": str(exc)})
        return OWNERSHIP_LOST_EXIT


if __name__ == "__main__":
    raise SystemExit(main())
