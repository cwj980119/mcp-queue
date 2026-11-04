#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -z "${QUEUE_HOST_ADDRESS:-}" ]; then
  if command -v ip >/dev/null 2>&1; then
    QUEUE_HOST_ADDRESS=$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") {print $(i+1); exit}}')
  elif command -v ipconfig >/dev/null 2>&1 && command -v route >/dev/null 2>&1; then
    queue_interface=$(route -n get default 2>/dev/null | awk '/interface:/ {print $2; exit}')
    QUEUE_HOST_ADDRESS=$(ipconfig getifaddr "$queue_interface" 2>/dev/null || true)
  fi
fi
if [ -z "${QUEUE_HOST_ADDRESS:-}" ]; then
  QUEUE_HOST_ADDRESS=$(hostname)
fi
export QUEUE_HOST_ADDRESS
export QUEUE_LISTEN_ADDRESS=0.0.0.0
docker compose up -d --build --wait
printf '\nServer address: '
cat .local/server-address.txt
printf '\nGive each user only their own file in .local/connections/.\n'
