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

// DEAD. Attic BLE-tracker leftover: the block above describes LovyanGFX's
// board autodetect, and this build does not use LovyanGFX at all. display.h
// hardcodes the Waveshare CO5300 QSPI panel. Nothing reads this.
#define BOARD_TYPE  BOARD_AUTODETECT

// ---------------------------------------------------------------------
// 1b. WHICH APP?
//    APP_VOKAL picks the UI head firmware.ino compiles in. Both heads
//    expose the same three symbols -- uiSplash(const char*), uiBegin(),
//    uiTick() -- so this line is the entire switch.
//
//      1 = Vokal (ui_vokal.h): the voice device. Push-to-talk, POSTs raw
//          PCM to the laptop, polls /state. See PROTOCOL.md.
//      0 = the meeting puck (ui_puck.h): the original app, untouched and
//          still buildable. Nothing about it was removed to make room.
// ---------------------------------------------------------------------
#define APP_VOKAL  1

// DEAD. Attic BLE-tracker leftover; neither tracker.h nor ui_tracker.h
// exists in this repo. Which app gets built is APP_VOKAL, above.
#define APP_TRACKER  1

// Stream raw IMU samples over serial for tools/imuplot.py. Costs ~8 KB/s
// of serial bandwidth; turn off once the tap thresholds are settled.
//
// TURNED OFF FOR VOKAL. 8 KB/s of samples buries the once-per-utterance
// t_press / t_release / t_post_done lines we read the latency budget from,
// and the USB CDC backpressure distorts the numbers it fails to bury.
// Set it back to 1 when you are retuning the tap thresholds, not before.
#define IMU_STREAM   0

// Log every raw touch coordinate so the mapping can be checked against
// where you actually pressed.
#define TOUCH_DEBUG  1

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
// DEAD. ui_lvgl.h is not in the build and there is no lv_conf.h on this
// machine; display.h is raw Arduino_GFX. Nothing reads this.
#define USE_LVGL  0

// ---------------------------------------------------------------------
// 3. DISPLAY
// ---------------------------------------------------------------------
// DEAD. Rotation is fixed at 0 in display.h's Arduino_CO5300 constructor.
// The panel is portrait 368x448 and Vokal's layout is built around that.
#define SCREEN_ROTATION   1     // 0..3. 1 = landscape, USB on the left.

// LIVE. Handed to panel->setBrightness() in displayBegin().
#define BACKLIGHT_LEVEL   200   // 0..255

// DEAD, both. LVGL knobs, and LVGL is not in this build.
#define LVGL_BUF_LINES    40    // LVGL draw buffer height. Lower if you OOM.
#define LVGL_SWAP_BYTES   true

// ---------------------------------------------------------------------
// 4. WIFI
//    Tried in order, first one that connects wins. Put your PHONE HOTSPOT
//    first -- venue wifi is usually a captive portal the ESP32 cannot log
//    into. iPhone: Settings > Personal Hotspot > Maximize Compatibility ON,
//    or the ESP32 will never even see the network (it is 2.4GHz only).
// ---------------------------------------------------------------------
//    WifiCred and WIFI_NETWORKS are defined in secrets.h (gitignored).
// LIVE (net.h). netConnect() spends up to this long on EACH network in
// WIFI_NETWORKS and blocks the entire boot while it does, so N networks is
// N x 12 s of frozen splash screen. Keep the list short on the day.
#define WIFI_CONNECT_TIMEOUT_MS  12000   // per network, then move on

// DEAD. Nothing tests it; netConnect() always falls through to the AP.
#define WIFI_REQUIRED            false   // true = block boot until online

// Fallback: if every network fails, come up as an access point so you can
// still demo something. Connect your laptop to this SSID.
#define AP_FALLBACK_SSID  "hackathon-device"
#define AP_FALLBACK_PASS  "12345678"      // >= 8 chars or the AP won't start

// ---------------------------------------------------------------------
// 5. HTTP
// ---------------------------------------------------------------------
// LIVE (net.h). This is also the ceiling on a /utterance POST: ~480 KB up
// a phone hotspot has to finish inside it or the board gives up mid-demo.
#define HTTP_TIMEOUT_MS   8000

// DEAD. Connectivity self-test from the scaffold; nothing calls it, and
// https would cost the TLS handshake Vokal deliberately refuses to pay.
#define HTTP_TEST_URL     "https://worldtimeapi.org/api/ip"

// ---------------------------------------------------------------------
// 6. CUSTOM PIN MAP  (only read when BOARD_TYPE == BOARD_CUSTOM)
//
//    DEAD, ALL OF IT. BOARD_TYPE is BOARD_AUTODETECT, so the preprocessor
//    throws this whole block away. The real pins for this board are in
//    display.h (panel + touch) and audio.h (I2S + codec). Editing anything
//    below will not change one line of the binary.
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

// ---------------------------------------------------------------------
// 7. VOKAL   (only read when APP_VOKAL == 1)
//    The contract these implement is PROTOCOL.md. Changing a URL or the
//    audio format here breaks it -- change both sides or neither.
// ---------------------------------------------------------------------
#if APP_VOKAL

// The laptop's LAN IP lives in secrets.h, which is gitignored: it changes
// every time the hotspot hands out a new lease, so it is not a constant.
#ifndef VOKAL_HOST
  #error "secrets.h has no VOKAL_HOST -- re-copy firmware/secrets.example.h and put the laptop's LAN IP in it"
#endif
#ifndef VOKAL_PORT
  #define VOKAL_PORT 8000        // PROTOCOL.md: the server binds 0.0.0.0:8000
#endif

// The two-step stringify dance: one level to expand the macro, one to
// quote what came out. It buys compile-time URL literals, so there is no
// runtime buffer to size and no snprintf that can silently truncate a host.
#define VK_STR2(x)  #x
#define VK_STR(x)   VK_STR2(x)

// Plain http, never https. PROTOCOL.md: a WiFiClientSecure handshake costs
// latency we do not have and there is nothing secret on this wire.
#define VOKAL_BASE           "http://" VOKAL_HOST ":" VK_STR(VOKAL_PORT)
#define VOKAL_URL_UTTERANCE  VOKAL_BASE "/utterance"
#define VOKAL_URL_DEMO       VOKAL_BASE "/demo/trigger"
#define VOKAL_URL_STATE      VOKAL_BASE "/state"
#define VOKAL_URL_HEALTH     VOKAL_BASE "/health"
#define VOKAL_URL_REPLAY     VOKAL_BASE "/replay"

// ~3 Hz, per PROTOCOL.md -- NOT once per UI frame. httpGet is synchronous,
// so polling at the 10 Hz paint rate would park the UI core in lwIP for a
// third of every second and flood the laptop for nothing.
#define VOKAL_POLL_MS        330

// Shorter than this is a fumbled press, not a sentence. Posting it just
// makes the pipeline hallucinate a transcript out of room tone.
#define VOKAL_MIN_UTTER_MS   300

// audLen keeps growing for up to one chunk (~64 ms) after audioStop(): the
// capture task only tests the flag at the top of its loop. We wait on
// audIdle instead of guessing, but not forever -- this is the ceiling.
#define VOKAL_SETTLE_MS      200

// A 202 comes back before the pipeline has started, so /state can still
// answer "idle" for a beat afterwards. Hold the waiting state this long
// before an idle reply may drop us back to ready, or the ring flickers
// ready->processing->speaking on every single utterance.
#define VOKAL_WAIT_HOLD_MS   1500

// How long a transient failure (too short, upload refused, unknown clip)
// stays on the ring before it heals itself back to ready. It clears on a
// timer rather than on a poll on purpose: if the laptop is the thing that
// died, no poll is ever coming, and a board stuck flashing red for the
// rest of the demo helps nobody. Long enough to read, short enough that a
// fumbled press does not cost you the stage.
#define VOKAL_ERR_HOLD_MS    2500

// The clip beat's clip_id. PROTOCOL.md: an unknown id gets a 404.
#define VOKAL_DEMO_CLIP      "clip1"

// "Hearing you" threshold, raw RMS on the audPeak scale (~2500 is full
// scale). Set far below the puck's 250 on purpose: this device is for
// people whose voice is faint, and "too quiet, speak up" is the one
// message it must never show them.
#define VOKAL_HEARD_RMS      40

// --- on-screen credit (PROTOCOL.md, "Voice ethics") -------------------
// The clip beat is spoken by the LOCAL Piper voice, never a clone of
// whoever is in the source material -- nothing in this project clones a
// voice -- and the source is credited on screen while it plays. /state
// carries no credit field, so the board owns this string.
// SET IT TO THE REAL SOURCE BEFORE THE DEMO. 30 chars max at UI_S=2.
#define VOKAL_CLIP_CREDIT    "sample clip - local voice"

// Shown on the same line when nothing is playing. 30 chars max at UI_S=2.
#define VOKAL_TAGLINE        "your words, your voice"

#endif  // APP_VOKAL
