#!/bin/bash
# wyebot — AI Development Agent Launcher
# Update PI_BIN to point to your Pi binary location.

PI_BIN="${PI_BIN:-pi}"

if ! command -v "$PI_BIN" &> /dev/null; then
  echo "Pi not found at '$PI_BIN'."
  echo ""
  echo "Install Pi from: https://github.com/mariozechner/pi-coding-agent"
  echo "Then either:"
  echo "  1. Add pi to your PATH"
  echo "  2. Set PI_BIN environment variable: export PI_BIN=/path/to/pi"
  echo "  3. Edit this script to set PI_BIN directly"
  exit 1
fi

echo "Starting wyebot..."
echo "Run /setup for first-time configuration."
echo ""

exec "$PI_BIN" "$@"
