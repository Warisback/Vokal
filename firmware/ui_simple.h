#pragma once
// =====================================================================
//  ui_simple.h -- the FALLBACK app (APP_TRACKER 0).
//  Wifi scanner + HTTP, on the shared widget kit. If BLE will not
//  cooperate by the 1:30 gate tomorrow, flip APP_TRACKER to 0 and demo
//  this instead -- it is a complete, working handheld wifi analyser.
// =====================================================================
#include "ui_kit.h"
#include "net.h"

enum Screen { SCR_HOME = 0, SCR_SCAN = 1, SCR_NET = 2, SCR__COUNT = 3 };
static const char* SCREEN_NAMES[] = { "Home", "Scan", "Net" };
static Screen screen = SCR_HOME;
static bool   screenDirty = true;
static int    counter = 0;
static String lastHttp = "(no request yet)";

inline void uiGoto(Screen s) { if (s != screen) { screen = s; screenDirty = true; } }

// Buttons are laid out as thirds of the actual panel width, so this
// works on a 240px portrait panel as well as a 320px landscape one.
inline Button thirdButton(int i, int y, const char* label) {
  int m = 8, w = (SCR_W - m * 4) / 3;
  return Button{ (int16_t)(m + i * (w + m)), (int16_t)y, (int16_t)w, 40, label, C_PANEL };
}

inline void screenHome() {
  int top = TABBAR_H + 1;
  clearBody();
  tft.setTextDatum(textdatum_t::top_left);
  tft.setTextColor(C_TEXT, C_BG);
  char line[64];
  snprintf(line, sizeof(line), "counter: %d", counter);
  tft.drawString(line, 12, top + 12);
  snprintf(line, sizeof(line), "uptime:  %lus", (unsigned long)(millis() / 1000));
  tft.drawString(line, 12, top + 30);

  Button a = thirdButton(0, top + 56, "Count +1");
  Button b = thirdButton(1, top + 56, "Fetch");
  Button c = thirdButton(2, top + 56, "Scan");
  if (btnUpdate(a)) counter++;
  if (btnUpdate(b)) httpGet(HTTP_TEST_URL, lastHttp);
  if (btnUpdate(c)) { netScan(); uiGoto(SCR_SCAN); }

  tft.setTextColor(C_MUTED, C_BG);
  tft.setTextDatum(textdatum_t::top_left);
  tft.drawString(lastHttp.substring(0, SCR_W / 7), 12, top + 108);
}

inline void screenScan() {
  int top = TABBAR_H + 1;
  clearBody();
  tft.setTextColor(C_MUTED, C_BG);
  tft.setTextDatum(textdatum_t::top_left);
  char hdr[48];
  snprintf(hdr, sizeof(hdr), "%d networks (2.4GHz only)", scanCount);
  tft.drawString(hdr, 10, top + 6);

  int y = top + 26, rowH = 16;
  int rows = (SCR_H - STATUS_H - 34 - y) / rowH;
  for (int i = 0; i < scanCount && i < rows; i++) {
    int pct = constrain(map(scanRows[i].rssi, -90, -30, 0, 100), 0, 100);
    uint16_t c = pct > 60 ? C_OK : pct > 30 ? C_WARN : C_ERR;
    tft.drawRect(10, y + 4, 44, 8, C_MUTED);
    tft.fillRect(11, y + 5, 42 * pct / 100, 6, c);
    tft.setTextColor(scanRows[i].open ? C_WARN : C_TEXT, C_BG);
    tft.setTextDatum(textdatum_t::top_left);
    tft.drawString(scanRows[i].ssid.substring(0, (SCR_W - 130) / 6), 62, y + 2);
    tft.setTextDatum(textdatum_t::top_right);
    tft.setTextColor(C_MUTED, C_BG);
    char db[10]; snprintf(db, sizeof(db), "%d", scanRows[i].rssi);
    tft.drawString(db, SCR_W - 8, y + 2);
    y += rowH;
  }
  Button r = { (int16_t)(SCR_W - 86), (int16_t)(SCR_H - STATUS_H - 30), 78, 26, "Rescan", C_PANEL };
  if (btnUpdate(r)) netScan();
}

inline void screenNet() {
  int top = TABBAR_H + 1;
  clearBody();
  tft.setTextDatum(textdatum_t::top_left);
  tft.setTextColor(C_TEXT, C_BG);
  char l[72]; int y = top + 12;
  snprintf(l, sizeof(l), "ssid: %s", netSsid.length() ? netSsid.c_str() : "-");
  tft.drawString(l, 12, y); y += 18;
  snprintf(l, sizeof(l), "ip:   %s", netIp.toString().c_str());
  tft.drawString(l, 12, y); y += 18;
  snprintf(l, sizeof(l), "rssi: %d dBm", (int)WiFi.RSSI());
  tft.drawString(l, 12, y); y += 18;
  snprintf(l, sizeof(l), "mac:  %s", WiFi.macAddress().c_str());
  tft.drawString(l, 12, y);

  int by = SCR_H - STATUS_H - 38, m = 8, w = (SCR_W - m * 3) / 2;
  Button rc = { (int16_t)m, (int16_t)by, (int16_t)w, 34, "Reconnect", C_PANEL };
  Button cal = { (int16_t)(m * 2 + w), (int16_t)by, (int16_t)w, 34, "Calib touch", C_PANEL };
  if (btnUpdate(rc))  netConnect(nullptr);
  if (btnUpdate(cal)) displayCalibrateTouch();
}

inline void uiSplash(const char* msg) {
  tft.fillScreen(C_BG);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(msg, tft.width() / 2, tft.height() / 2);
  tft.flush();
}

inline void uiBegin() { screenDirty = true; }

inline void uiTick() {
  static uint32_t lastPaint = 0;
  touchTick();
  int t = tabBarTouched(SCR__COUNT);
  if (t >= 0) uiGoto((Screen)t);

  bool repaint = screenDirty || touchDown || touchReleased || (millis() - lastPaint > 400);
  if (!repaint) return;
  lastPaint = millis();

  if (screenDirty) tft.fillScreen(C_BG);
  drawTabBar(SCREEN_NAMES, SCR__COUNT, screen);
  switch (screen) {
    case SCR_HOME: screenHome(); break;
    case SCR_SCAN: screenScan(); break;
    case SCR_NET:  screenNet();  break;
    default: break;
  }
  char right[40];
  if (netState == NET_ONLINE || netState == NET_AP_MODE)
    snprintf(right, sizeof(right), "%s", netIp.toString().c_str());
  else
    snprintf(right, sizeof(right), "heap %uk", (unsigned)(ESP.getFreeHeap() / 1024));
  drawStatusBar(netStateName(), netStateColor(), right);
  tft.flush();
  screenDirty = false;
}
