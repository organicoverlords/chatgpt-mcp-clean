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
machine_watchdog_json=$(/opt/v3-watchdog/status.py 2>/dev/null || printf '{"schema":"v3-watchdog.status.v1","overall":"unknown","nodes":{}}')
read -r load1 load5 load15 _ < /proc/loadavg
mem_total_mb=$(awk '/MemTotal:/ {printf "%.1f", $2/1024}' /proc/meminfo)
mem_available_mb=$(awk '/MemAvailable:/ {printf "%.1f", $2/1024}' /proc/meminfo)
root_free_gb=$(df -Pk / | awk 'NR==2 {printf "%.1f", $4/1048576}')
uptime_seconds=$(awk '{printf "%d", $1}' /proc/uptime)
printf '{"timestamp":"%s","healthy":%s,"primary_healthy":%s,"primary_backend_http":%s,"wireguard_interface":"%s","wireguard_handshake_age_seconds":%s,"wireguard_peer_fresh":%s,"recovery_available":%s,' \
  "$ts" "$healthy" "$primary_healthy" $primary_json "$wireguard_iface" "$wireguard_handshake_age_seconds" "$wireguard_peer_fresh" "$recovery_available" > "$tmp"
printf '"fallback_3101_http":%s,"fallback_3102_http":%s,"fallback_3103_http":%s,"fallback_3104_http":%s,"fallback_healthy_count":%s,"metadata_http":%s,"caddy":"%s","artifact_sets":%s,"root_disk_used":"%s",' \
  $fallback_3101_json $fallback_3102_json $fallback_3103_json $fallback_3104_json "$fallback_healthy" $metadata_json "$caddy" "${artifacts:-0}" "$disk" >> "$tmp"
printf '"vps":{"load1":%s,"load5":%s,"load15":%s,"memory_total_mb":%s,"memory_available_mb":%s,"root_free_gb":%s,"uptime_seconds":%s},' \
  "$load1" "$load5" "$load15" "$mem_total_mb" "$mem_available_mb" "$root_free_gb" "$uptime_seconds" >> "$tmp"
printf '"github_runner":{"service":"%s","listener_count":%s,"healthy":%s},"machines":%s}
' \
  "$runner_service" "$runner_listener_count" "$runner_healthy" "$machine_watchdog_json" >> "$tmp"
chmod 0644 "$tmp"
mv -f "$tmp" "$state/status.json"
