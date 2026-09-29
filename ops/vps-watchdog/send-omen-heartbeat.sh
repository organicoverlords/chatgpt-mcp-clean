#!/usr/bin/env bash
set -euo pipefail

host="${V3_WATCHDOG_SSH_HOST:-5.61.91.127}"
key="${V3_WATCHDOG_OMEN_KEY:-$HOME/.config/v3-watchdog/omen_ed25519}"

exec ssh -T \
  -o BatchMode=yes \
  -o ConnectTimeout=4 \
  -o ServerAliveInterval=5 \
  -o ServerAliveCountMax=1 \
  -o StrictHostKeyChecking=yes \
  -i "$key" \
  "v3watchdog@$host" heartbeat
