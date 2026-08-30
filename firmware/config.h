#pragma once
// Secrets (wifi creds, API keys) live in secrets.h, which is gitignored.
#if __has_include("secrets.h")
  #include "secrets.h"
#else
  #error "Copy firmware/secrets.example.h to firmware/secrets.h and fill it in"
#endif

// =====================================================================
//  config.h -- EVERY knob you will need to turn tomorrow lives here.
//  Nothing else in this project should need editing to bring up a board.
// =====================================================================

// ---------------------------------------------------------------------
// 1. WHICH BOARD?
//    Start on AUTODETECT. LovyanGFX knows ~40 common dev boards (M5Stack,
//    TTGO T-Display, WT32-SC01, Sunton "cheap yellow display", ...) and
//    will configure panel + touch + backlight for you.
//    If the screen stays black, drop to CYD or CUSTOM.
// ---------------------------------------------------------------------
#define BOARD_AUTODETECT    1
#define BOARD_CYD_2432S028  2   // Sunton ESP32-2432S028R, the common cheap
                                // 2.8" ILI9341 + XPT2046 resistive combo
#define BOARD_CUSTOM        3   // fill in the pin block at the bottom

#define BOARD_TYPE  BOARD_AUTODETECT

// ---------------------------------------------------------------------
// 1b. WHICH APP?
//    1 = BLE sweep instrument (tracker.h + ui_tracker.h)
//    0 = generic wifi scaffold (net.h + ui_simple.h) -- the fallback if
//        BLE will not cooperate by the 1:30 gate
// ---------------------------------------------------------------------
#define APP_TRACKER  1

// Stream raw IMU samples over serial for tools/imuplot.py. Costs ~8 KB/s
// of serial bandwidth; turn off once the tap thresholds are settled.
#define IMU_STREAM   0   // 1 = 500 Hz stream for tools/imuplot.py; costs serial bandwidth

// Log every raw touch coordinate so the mapping can be checked against
// where you actually pressed.
#define TOUCH_DEBUG  0   // log every raw touch coordinate

// ---------------------------------------------------------------------
// 2. WHICH UI ENGINE?
//    0 = ui_simple.h  -- ~150 lines of LovyanGFX. Buttons, labels, lists.
//                        No external deps. Cannot fail to build.
//    1 = ui_lvgl.h    -- LVGL 9. Real widgets, scrolling, animation.
//                        Needs lv_conf.h placed correctly (setup.sh does it).
//
//    NOTE: only applies to the FALLBACK app (APP_TRACKER 0). The sweep
//    instrument is raw LovyanGFX -- hunt mode is a full-screen custom
//    render, which is less work without a widget toolkit, not more.
// ---------------------------------------------------------------------
#define USE_LVGL  0

// ---------------------------------------------------------------------
// 3. DISPLAY
// ---------------------------------------------------------------------
#define SCREEN_ROTATION   1     // 0..3. 1 = landscape, USB on the left.
#define BACKLIGHT_LEVEL   200   // 0..255
#define LVGL_BUF_LINES    40    // LVGL draw buffer height. Lower if you OOM.

// If LVGL colours look psychedelic (blues where reds should be), flip this.
#define LVGL_SWAP_BYTES   true

// ---------------------------------------------------------------------
// 4. WIFI
//    Tried in order, first one that connects wins. Put your PHONE HOTSPOT
//    first -- venue wifi is usually a captive portal the ESP32 cannot log
//    into. iPhone: Settings > Personal Hotspot > Maximize Compatibility ON,
//    or the ESP32 will never even see the network (it is 2.4GHz only).
// ---------------------------------------------------------------------
//    WifiCred and WIFI_NETWORKS are defined in secrets.h (gitignored).
#define WIFI_CONNECT_TIMEOUT_MS  12000   // per network, then move on
#define WIFI_REQUIRED            false   // true = block boot until online

// Fallback: if every network fails, come up as an access point so you can
// still demo something. Connect your laptop to this SSID.
#define AP_FALLBACK_SSID  "hackathon-device"
#define AP_FALLBACK_PASS  "12345678"      // >= 8 chars or the AP won't start

// ---------------------------------------------------------------------
// 5. HTTP
// ---------------------------------------------------------------------
#define HTTP_TIMEOUT_MS   8000
#define HTTP_TEST_URL     "https://worldtimeapi.org/api/ip"

// ---------------------------------------------------------------------
// 6. CUSTOM PIN MAP  (only read when BOARD_TYPE == BOARD_CUSTOM)
//    Fill these from your board's schematic or silkscreen.
// ---------------------------------------------------------------------
#if BOARD_TYPE == BOARD_CUSTOM
  #define PANEL_DRIVER   Panel_ILI9341   // or Panel_ST7789, Panel_ST7796, ...
  #define PIN_TFT_SCLK   14
  #define PIN_TFT_MOSI   13
  #define PIN_TFT_MISO   12
  #define PIN_TFT_DC      2
  #define PIN_TFT_CS     15
  #define PIN_TFT_RST    -1
  #define PIN_TFT_BL     21
  #define TFT_WIDTH     240
  #define TFT_HEIGHT    320
  #define TFT_INVERT    false
  #define TFT_RGB_ORDER false          // true if red and blue are swapped

  #define TOUCH_ENABLED  1
  // Resistive panels are SPI (XPT2046). Capacitive ones are I2C
  // (FT5x06 / GT911) and are a completely different chip -- if taps do
  // nothing at all, this is the first thing to change.
  #define TOUCH_XPT2046  1
  #define TOUCH_FT5X06   2
  #define TOUCH_GT911    3
  #define TOUCH_DRIVER   TOUCH_XPT2046

  #define PIN_TCH_SCLK   25   // SPI touch only
  #define PIN_TCH_MOSI   32
  #define PIN_TCH_MISO   39
  #define PIN_TCH_CS     33
  #define PIN_TCH_IRQ    36

  #define PIN_TCH_SDA    33   // I2C touch only
  #define PIN_TCH_SCL    32
  #define TCH_I2C_ADDR   0x38 // FT5x06 0x38, GT911 0x5D or 0x14
#endif
