#pragma once
// =====================================================================
//  ui_lvgl.h -- the LVGL 9 path. Same three screens as ui_simple.h and
//  the same public API (uiBegin / uiTick / uiSplash), so flipping
//  USE_LVGL in config.h swaps engines with no other edits.
//
//  Requires lv_conf.h to be visible to the compiler. setup.sh installs
//  it into the libraries folder and enables LV_CONF_INCLUDE_SIMPLE.
// =====================================================================
#include "display.h"
#include "net.h"
#include <lvgl.h>

static lv_display_t* lvDisp = nullptr;
static lv_obj_t* lblStatus = nullptr;
static lv_obj_t* lblCounter = nullptr;
static lv_obj_t* lblHttp = nullptr;
static lv_obj_t* listScan = nullptr;
static int counter = 0;

// --- glue: LVGL -> LovyanGFX ------------------------------------------
static void lvFlush(lv_display_t* d, const lv_area_t* area, uint8_t* px) {
  const int32_t w = area->x2 - area->x1 + 1;
  const int32_t h = area->y2 - area->y1 + 1;
  tft.startWrite();
  tft.setAddrWindow(area->x1, area->y1, w, h);
  tft.pushPixels((uint16_t*)px, w * h, LVGL_SWAP_BYTES);
  tft.endWrite();
  lv_display_flush_ready(d);
}

static void lvTouchRead(lv_indev_t*, lv_indev_data_t* data) {
  uint16_t x, y;
  if (tft.getTouch(&x, &y)) {
    data->point.x = x;
    data->point.y = y;
    data->state = LV_INDEV_STATE_PRESSED;
  } else {
    data->state = LV_INDEV_STATE_RELEASED;
  }
}

// --- callbacks ---------------------------------------------------------
static void onCount(lv_event_t*) {
  counter++;
  lv_label_set_text_fmt(lblCounter, "counter: %d", counter);
}

static void onFetch(lv_event_t*) {
  String body;
  lv_label_set_text(lblHttp, "fetching...");
  lv_refr_now(nullptr);                  // paint before we block
  httpGet(HTTP_TEST_URL, body);
  lv_label_set_text(lblHttp, body.substring(0, 120).c_str());
}

static void onScan(lv_event_t*) {
  lv_obj_clean(listScan);
  lv_list_add_text(listScan, "scanning...");
  lv_refr_now(nullptr);
  netScan();
  lv_obj_clean(listScan);
  char row[80];
  for (int i = 0; i < scanCount; i++) {
    snprintf(row, sizeof(row), "%-20s %d dBm",
             scanRows[i].ssid.substring(0, 20).c_str(), scanRows[i].rssi);
    lv_list_add_button(listScan, nullptr, row);
  }
}

// --- build -------------------------------------------------------------
inline void uiSplash(const char* msg) {
  // Raw LovyanGFX -- safe to call before uiBegin().
  tft.fillScreen(C_BG);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(msg, tft.width() / 2, tft.height() / 2);
}

inline void uiBegin() {
  lv_init();
  lv_tick_set_cb((lv_tick_get_cb_t)millis);

  const int32_t w = tft.width(), h = tft.height();
  const size_t bufBytes = w * LVGL_BUF_LINES * 2;      // RGB565
  uint8_t* buf = (uint8_t*)heap_caps_malloc(bufBytes, MALLOC_CAP_DMA);
  if (!buf) { buf = (uint8_t*)malloc(bufBytes); }      // no DMA-capable RAM
  if (!buf) { Serial.println("[lvgl] OUT OF MEMORY - lower LVGL_BUF_LINES"); return; }

  lvDisp = lv_display_create(w, h);
  lv_display_set_flush_cb(lvDisp, lvFlush);
  lv_display_set_buffers(lvDisp, buf, nullptr, bufBytes,
                         LV_DISPLAY_RENDER_MODE_PARTIAL);

  lv_indev_t* indev = lv_indev_create();
  lv_indev_set_type(indev, LV_INDEV_TYPE_POINTER);
  lv_indev_set_read_cb(indev, lvTouchRead);

  lv_obj_t* tv = lv_tabview_create(lv_screen_active());
  lv_tabview_set_tab_bar_size(tv, 36);

  // -- Home --
  lv_obj_t* tabHome = lv_tabview_add_tab(tv, "Home");
  lblCounter = lv_label_create(tabHome);
  lv_label_set_text(lblCounter, "counter: 0");
  lv_obj_align(lblCounter, LV_ALIGN_TOP_LEFT, 0, 0);

  lv_obj_t* bCount = lv_button_create(tabHome);
  lv_obj_align(bCount, LV_ALIGN_TOP_LEFT, 0, 28);
  lv_obj_add_event_cb(bCount, onCount, LV_EVENT_CLICKED, nullptr);
  lv_label_set_text(lv_label_create(bCount), "Count +1");

  lv_obj_t* bFetch = lv_button_create(tabHome);
  lv_obj_align(bFetch, LV_ALIGN_TOP_LEFT, 110, 28);
  lv_obj_add_event_cb(bFetch, onFetch, LV_EVENT_CLICKED, nullptr);
  lv_label_set_text(lv_label_create(bFetch), "Fetch");

  lblHttp = lv_label_create(tabHome);
  lv_label_set_long_mode(lblHttp, LV_LABEL_LONG_WRAP);
  lv_obj_set_width(lblHttp, w - 30);
  lv_obj_align(lblHttp, LV_ALIGN_TOP_LEFT, 0, 80);
  lv_label_set_text(lblHttp, "(no request yet)");

  // -- Scan --
  lv_obj_t* tabScan = lv_tabview_add_tab(tv, "Scan");
  lv_obj_t* bScan = lv_button_create(tabScan);
  lv_obj_align(bScan, LV_ALIGN_TOP_RIGHT, 0, 0);
  lv_obj_add_event_cb(bScan, onScan, LV_EVENT_CLICKED, nullptr);
  lv_label_set_text(lv_label_create(bScan), "Scan");

  listScan = lv_list_create(tabScan);
  lv_obj_set_size(listScan, w - 20, h - 120);
  lv_obj_align(listScan, LV_ALIGN_BOTTOM_MID, 0, 0);

  // -- Net --
  lv_obj_t* tabNet = lv_tabview_add_tab(tv, "Net");
  lblStatus = lv_label_create(tabNet);
  lv_label_set_text(lblStatus, "...");
  lv_obj_align(lblStatus, LV_ALIGN_TOP_LEFT, 0, 0);
}

inline void uiTick() {
  static uint32_t last = 0;
  if (lblStatus && millis() - last > 1000) {
    last = millis();
    lv_label_set_text_fmt(lblStatus, "%s\nssid: %s\nip: %s\nrssi: %d dBm\nheap: %u k",
                          netStateName(),
                          netSsid.length() ? netSsid.c_str() : "-",
                          netIp.toString().c_str(),
                          (int)WiFi.RSSI(),
                          (unsigned)(ESP.getFreeHeap() / 1024));
  }
  lv_timer_handler();
}
