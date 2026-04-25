#!/usr/bin/env sh
set -e

shutdown() {
  echo "Received shutdown signal, stopping services..."
  if [ -n "${NGINX_PID:-}" ] && kill -0 "$NGINX_PID" 2>/dev/null; then
    kill -TERM "$NGINX_PID" 2>/dev/null || true
  fi
  if [ -n "${APP_PID:-}" ] && kill -0 "$APP_PID" 2>/dev/null; then
    kill -TERM "$APP_PID" 2>/dev/null || true
  fi
}

trap shutdown INT TERM

# Start Node app in background
node dist/index.js &
APP_PID=$!

# Start NGINX in foreground
nginx -g 'daemon off;' &
NGINX_PID=$!

wait "$NGINX_PID"
wait "$APP_PID"

