#!/usr/bin/env bash
# =====================================================================
#  One-time setup for the meeting puck.
#  Target: Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2)
#    ./setup.sh
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"

CORE_URL=https://espressif.github.io/arduino-esp32/package_esp32_index.json
WS_REPO=https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8.git
LIBDIR="$HOME/Documents/Arduino/libraries"

# --- arduino-cli ------------------------------------------------------
if ! command -v arduino-cli >/dev/null 2>&1; then
  echo "==> installing arduino-cli"
  if command -v brew >/dev/null 2>&1; then brew install arduino-cli
  else
    mkdir -p "$HOME/.local/bin"
    curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \
      | BINDIR="$HOME/.local/bin" sh
    export PATH="$HOME/.local/bin:$PATH"
  fi
fi

# --- esp32 core -------------------------------------------------------
echo "==> esp32 core"
arduino-cli config init --overwrite >/dev/null 2>&1 || true
arduino-cli config add board_manager.additional_urls "$CORE_URL" 2>/dev/null \
  || arduino-cli config set board_manager.additional_urls "$CORE_URL"
arduino-cli core update-index
arduino-cli core install esp32:esp32

# --- vendor libraries -------------------------------------------------
# Arduino_GFX (CO5300 QSPI AMOLED), Arduino_DriveBus (CST816 touch) and
# SensorLib (QMI8658 IMU) are board-specific forks -- the Library Manager
# versions will NOT drive this panel. They come from Waveshare's repo.
echo "==> vendor libraries"
mkdir -p "$LIBDIR"
TMP=$(mktemp -d)
git clone --depth 1 "$WS_REPO" "$TMP/ws"
for lib in GFX_Library_for_Arduino Arduino_DriveBus SensorLib Adafruit_BusIO Adafruit_XCA9554; do
  rm -rf "$LIBDIR/$lib"
  cp -R "$TMP/ws/examples/arduino-v2/libraries/$lib" "$LIBDIR/$lib"
  echo "    $lib"
done
rm -rf "$TMP"

# --- secrets ----------------------------------------------------------
if [ ! -f firmware/secrets.h ]; then
  cp firmware/secrets.example.h firmware/secrets.h
  echo "==> created firmware/secrets.h -- FILL IN your wifi + API keys"
fi

# --- verify -----------------------------------------------------------
echo "==> compile check"
arduino-cli compile --fqbn "esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app" firmware \
  && echo "    OK -- now: ./flash.sh" \
  || echo "    FAILED"
