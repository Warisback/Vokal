#!/usr/bin/env bash
# Build + flash + monitor for the Waveshare ESP32-S3-Touch-AMOLED-1.8 V2
set -e
cd "$(dirname "$0")"
FQBN="esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app"
SKETCH="${2:-firmware}"
PORT="${1:-$(ls /dev/cu.usbmodem* 2>/dev/null | head -1)}"
if [ -z "$PORT" ]; then
  echo "No port. Data cable? Hold BOOT, tap RESET, release BOOT, retry."
  exit 1
fi
echo "==> $SKETCH -> $PORT"
arduino-cli compile --fqbn "$FQBN" "$SKETCH" -u -p "$PORT"
arduino-cli monitor -p "$PORT" -c baudrate=115200
