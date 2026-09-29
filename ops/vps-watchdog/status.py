#!/usr/bin/env python3
import json
import os
import time
from pathlib import Path

STATE_DIR = Path(os.environ.get("V3_WATCHDOG_STATE_DIR", "/var/lib/v3-watchdog"))
CONFIG_PATH = Path(os.environ.get("V3_WATCHDOG_CONFIG", "/etc/v3-watchdog/config.json"))
SEVERITY = {"healthy": 0, "unknown": 1, "warning": 2, "critical": 3}


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def worst(*levels: str) -> str:
    return max(levels, key=lambda value: SEVERITY[value])


def host_level(age, cfg: dict) -> str:
    if age is None:
        return "unknown"
    if age >= float(cfg["heartbeat_critical_seconds"]):
        return "critical"
    if age >= float(cfg["heartbeat_warn_seconds"]):
        return "warning"
    return "healthy"


def low_value_level(value, warn, critical) -> str:
    if value is None:
        return "unknown"
    value = float(value)
    if value <= float(critical):
        return "critical"
    if value <= float(warn):
        return "warning"
    return "healthy"


def resources_from_existing_healthline(healthline, node_id: str, now: float, stale_seconds: float):
    if not healthline:
        return {"level": "unknown", "reason": "no existing healthline snapshot"}
    received_at = healthline.get("received_at")
    if not isinstance(received_at, (int, float)):
        return {"level": "unknown", "reason": "invalid healthline timestamp"}
    age = max(0.0, now - float(received_at))
    if age > stale_seconds:
        return {"level": "unknown", "reason": "existing healthline snapshot stale", "age_seconds": round(age, 1)}

    payload = healthline.get("payload") or {}
    nodes = ((payload.get("current_nodes") or {}).get("nodes") or {})
    node = nodes.get(node_id) or {}
    return {
        "age_seconds": round(age, 1),
        "memory_available_gb": node.get("mem_available_gb"),
        "disk_free_gb": node.get("disk_free_gb") if node.get("disk_free_gb") is not None else node.get("nvme_disk_free_gb"),
        "source_freshness": node.get("freshness"),
        "machine_state": node.get("machine_state"),
        "reachability": node.get("machine_reachability"),
    }


def main() -> int:
    cfg = read_json(CONFIG_PATH)
    if not cfg:
        raise SystemExit(f"watchdog config unavailable: {CONFIG_PATH}")

    now = time.time()
    healthline = read_json(STATE_DIR / "healthline.json")
    stale_seconds = float(cfg.get("healthline_stale_seconds", 600))
    nodes_out = {}

    for name, node_id in (("KONE", "kone-gpu-desktop"), ("OMEN", "omen-linux-laptop")):
        node_cfg = cfg["nodes"][name]
        heartbeat = read_json(STATE_DIR / f"{name.lower()}.heartbeat.json")
        received_at = heartbeat.get("received_at") if heartbeat else None
        age = max(0.0, now - float(received_at)) if isinstance(received_at, (int, float)) else None
        h_level = host_level(age, node_cfg)

        resources = resources_from_existing_healthline(healthline, node_id, now, stale_seconds)
        if resources.get("reason"):
            resource_level = "unknown"
        else:
            resource_level = worst(
                low_value_level(resources.get("memory_available_gb"), node_cfg["memory_warn_gb"], node_cfg["memory_critical_gb"]),
                low_value_level(resources.get("disk_free_gb"), node_cfg["disk_warn_gb"], node_cfg["disk_critical_gb"]),
            )
        resources["level"] = resource_level

        nodes_out[name] = {
            "overall": worst(h_level, resource_level),
            "host": {
                "level": h_level,
                "heartbeat_age_seconds": round(age, 1) if age is not None else None,
            },
            "resources": resources,
        }

    print(json.dumps({
        "schema": "v3-watchdog.status.v1",
        "generated_at": now,
        "overall": worst(*(entry["overall"] for entry in nodes_out.values())),
        "nodes": nodes_out,
        "healthline_received_at": healthline.get("received_at") if healthline else None,
    }, separators=(",", ":"), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
