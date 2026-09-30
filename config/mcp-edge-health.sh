#!/usr/bin/env bash
set -u

state="${MCP_EDGE_STATE_DIR:-/var/lib/mcp-edge}"
mkdir -p "$state"
tmp="$state/status.json.tmp"
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

primary=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 http://10.203.0.2:3011/health || true)
fallback_3101=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3101/health || true)
fallback_3102=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3102/health || true)
fallback_3103=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3103/health || true)
fallback_3104=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3104/health || true)
metadata=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 8 https://5-61-91-127.sslip.io/.well-known/oauth-protected-resource/mcp || true)

# Existing machine/service endpoints only. These are two bounded health probes,
# not filesystem/process scans and not duplicate resource telemetry.
kone_public=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 https://91-159-12-133.sslip.io/health || true)
omen_supertest=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 https://supertest9000.91-159-12-133.sslip.io/health || true)

# The KONE collector publishes the aggregate fleet snapshot here every minute.
# Freshness is an independent liveness signal: if KONE or its collector stops,
# the VPS can detect that without relying on KONE to report its own failure.
fleet_snapshot=/srv/mcp-artifacts/monitoring/fleet-status.json
fleet_snapshot_present=false
fleet_snapshot_age_seconds=-1
fleet_snapshot_fresh=false
fleet_reported_state=unknown
now_epoch=$(date +%s)
if [ -f "$fleet_snapshot" ]; then
  fleet_snapshot_present=true
  fleet_snapshot_mtime=$(stat -c %Y "$fleet_snapshot" 2>/dev/null || printf '0')
  case "$fleet_snapshot_mtime" in ''|*[!0-9]*) fleet_snapshot_mtime=0 ;; esac
  if [ "$fleet_snapshot_mtime" -gt 0 ]; then
    fleet_snapshot_age_seconds=$((now_epoch - fleet_snapshot_mtime))
    if [ "$fleet_snapshot_age_seconds" -ge 0 ] && [ "$fleet_snapshot_age_seconds" -le 180 ]; then fleet_snapshot_fresh=true; fi
  fi
  fleet_reported_state=$(sed -n 's/^[[:space:]]*"state":[[:space:]]*"\([^"]*\)".*/\1/p' "$fleet_snapshot" | head -1)
  [ -n "$fleet_reported_state" ] || fleet_reported_state=unknown
fi

normalize_http() {
  case "$1" in
    ''|000|*[!0-9]*) printf '0' ;;
    *) printf '%d' "$((10#$1))" ;;
  esac
}

primary_json=$(normalize_http "$primary")
fallback_3101_json=$(normalize_http "$fallback_3101")
fallback_3102_json=$(normalize_http "$fallback_3102")
fallback_3103_json=$(normalize_http "$fallback_3103")
fallback_3104_json=$(normalize_http "$fallback_3104")
metadata_json=$(normalize_http "$metadata")
kone_public_json=$(normalize_http "$kone_public")
omen_supertest_json=$(normalize_http "$omen_supertest")

kone_public_state=unhealthy
[ "$kone_public" = 200 ] && kone_public_state=healthy

# OMEN's current public Supertest route uses KONE's public ingress. If KONE's
# ingress is down, OMEN is dependency-unknown rather than falsely marked down.
omen_supertest_state=unknown_dependency
if [ "$kone_public" = 200 ]; then
  if [ "$omen_supertest" = 200 ]; then
    omen_supertest_state=healthy
  else
    omen_supertest_state=unhealthy
  fi
fi

fleet_healthy=false
fleet_state=unhealthy
if [ "$fleet_snapshot_fresh" = true ] && [ "$kone_public" = 200 ] && [ "$omen_supertest_state" = healthy ]; then
  case "$fleet_reported_state" in
    OK) fleet_healthy=true; fleet_state=healthy ;;
    WARNING) fleet_state=warning ;;
    *) fleet_state=unhealthy ;;
  esac
fi

caddy=$(systemctl is-active caddy 2>/dev/null || true)
wireguard_iface=no
wireguard_handshake_age_seconds=-1
wireguard_peer_fresh=false
if ip link show wg-mcp >/dev/null 2>&1; then
  wireguard_iface=yes
  wireguard_handshake_epoch=$(wg show wg-mcp latest-handshakes 2>/dev/null | awk 'NR==1 {print $2}')
  case "$wireguard_handshake_epoch" in ''|*[!0-9]*) wireguard_handshake_epoch=0 ;; esac
  if [ "$wireguard_handshake_epoch" -gt 0 ]; then
    now_epoch=$(date +%s)
    wireguard_handshake_age_seconds=$((now_epoch - wireguard_handshake_epoch))
    if [ "$wireguard_handshake_age_seconds" -ge 0 ] && [ "$wireguard_handshake_age_seconds" -le 180 ]; then wireguard_peer_fresh=true; fi
  fi
fi

fallback_healthy=0
for code in "$fallback_3101" "$fallback_3102" "$fallback_3103" "$fallback_3104"; do
  [ "$code" = 200 ] && fallback_healthy=$((fallback_healthy + 1))
done

primary_healthy=false
if [ "$primary" = 200 ] && [ "$wireguard_peer_fresh" = true ]; then primary_healthy=true; fi
recovery_available=false
if [ "$fallback_healthy" -gt 0 ]; then recovery_available=true; fi

artifacts=$(find /srv/mcp-artifacts -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
disk=$(df -P / | awk 'NR==2 {print $5}')
healthy=false
if [ "$primary_healthy" = true ] && [ "$metadata" = 200 ] && [ "$caddy" = active ]; then healthy=true; fi

runner_service=$(systemctl is-active actions.runner.organicoverlords-p3.P3-VPS-LIGHT.service 2>/dev/null || true)
runner_listener_count=$(pgrep -fc '/opt/actions-runner-p3-light/bin/Runner.Listener' 2>/dev/null || true)
case "$runner_listener_count" in ''|*[!0-9]*) runner_listener_count=0 ;; esac
runner_healthy=false
if [ "$runner_service" = active ] && [ "$runner_listener_count" -ge 1 ]; then runner_healthy=true; fi

read -r load1 load5 load15 _ < /proc/loadavg
mem_total_mb=$(awk '/MemTotal:/ {printf "%.1f", $2/1024}' /proc/meminfo)
mem_available_mb=$(awk '/MemAvailable:/ {printf "%.1f", $2/1024}' /proc/meminfo)
root_free_gb=$(df -Pk / | awk 'NR==2 {printf "%.1f", $4/1048576}')
uptime_seconds=$(awk '{printf "%d", $1}' /proc/uptime)

printf '{"timestamp":"%s","healthy":%s,"primary_healthy":%s,"primary_backend_http":%s,"wireguard_interface":"%s","wireguard_handshake_age_seconds":%s,"wireguard_peer_fresh":%s,"recovery_available":%s,' \
  "$ts" "$healthy" "$primary_healthy" "$primary_json" "$wireguard_iface" "$wireguard_handshake_age_seconds" "$wireguard_peer_fresh" "$recovery_available" > "$tmp"
printf '"fallback_3101_http":%s,"fallback_3102_http":%s,"fallback_3103_http":%s,"fallback_3104_http":%s,"fallback_healthy_count":%s,"metadata_http":%s,"caddy":"%s","artifact_sets":%s,"root_disk_used":"%s",' \
  "$fallback_3101_json" "$fallback_3102_json" "$fallback_3103_json" "$fallback_3104_json" "$fallback_healthy" "$metadata_json" "$caddy" "${artifacts:-0}" "$disk" >> "$tmp"
printf '"vps":{"load1":%s,"load5":%s,"load15":%s,"memory_total_mb":%s,"memory_available_mb":%s,"root_free_gb":%s,"uptime_seconds":%s},' \
  "$load1" "$load5" "$load15" "$mem_total_mb" "$mem_available_mb" "$root_free_gb" "$uptime_seconds" >> "$tmp"
printf '"machine_probes":{"kone":{"public_mcp_http":%s,"state":"%s"},"omen":{"supertest_via_kone_http":%s,"state":"%s","dependency":"kone_public_ingress"}},' \
  "$kone_public_json" "$kone_public_state" "$omen_supertest_json" "$omen_supertest_state" >> "$tmp"
printf '"fleet_monitor":{"healthy":%s,"state":"%s","snapshot_present":%s,"snapshot_age_seconds":%s,"snapshot_fresh":%s,"reported_state":"%s","alert_delivery_configured":false},' \
  "$fleet_healthy" "$fleet_state" "$fleet_snapshot_present" "$fleet_snapshot_age_seconds" "$fleet_snapshot_fresh" "$fleet_reported_state" >> "$tmp"
printf '"github_runner":{"service":"%s","listener_count":%s,"healthy":%s}}\n' \
  "$runner_service" "$runner_listener_count" "$runner_healthy" >> "$tmp"

chmod 0644 "$tmp"
mv -f "$tmp" "$state/status.json"
