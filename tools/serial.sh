#!/usr/bin/env bash
# Find the board and open a serial monitor. `./tools/serial.sh`
set -euo pipefail
PORTS=$(ls /dev/cu.usbserial-* /dev/cu.usbmodem* /dev/cu.wchusbserial* /dev/cu.SLAB_USBtoUART* 2>/dev/null || true)
if [ -z "$PORTS" ]; then
  echo "No serial device found."
  echo
  echo "Checklist:"
  echo "  1. Is the cable a DATA cable? Charge-only USB cables enumerate nothing."
  echo "  2. Native-USB boards (S3/C3) may need the BOOT button held while plugging in."
  echo "  3. Classic boards need a driver:"
  echo "       CP210x -> https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers"
  echo "       CH34x  -> https://www.wch-ic.com/downloads/CH341SER_MAC_ZIP.html"
  echo "  4. Check System Settings > Privacy & Security for a blocked system extension."
  exit 1
fi
PORT=$(echo "$PORTS" | head -1)
echo "Monitoring $PORT at 115200 (ctrl-C to quit)"
arduino-cli monitor -p "$PORT" -c baudrate=115200
