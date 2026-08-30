#pragma once
// =====================================================================
//  ui_kit.h -- shared touch widgets on raw LovyanGFX. No dependencies.
//  Used by both ui_simple.h (generic scaffold) and ui_tracker.h (app).
// =====================================================================
#include "display.h"

// --- touch, debounced, with edges -------------------------------------
static bool touchDown = false, touchPressed = false, touchReleased = false;
static int  touchX = 0, touchY = 0;

// Touch is sampled every loop (~200 Hz) but buttons are only evaluated
// during a repaint (~10 Hz). A one-frame release flag is therefore almost
// always missed. Latch the click and hand it to the next paint pass.
static bool touchClickPending = false;
static int  clickX = 0, clickY = 0;

inline void touchTick() {
  uint16_t x, y;
  bool now = tft.getTouch(&x, &y);
  touchPressed  = (now && !touchDown);
  bool rel      = (!now && touchDown);
  if (now) { touchX = x; touchY = y; }
  if (rel) { touchClickPending = true; clickX = touchX; clickY = touchY; }
  touchReleased = false;          // only a paint pass may see a release
  touchDown = now;
}

// Call at the start of a paint pass; exposes any latched click.
inline void touchBeginFrame() {
  touchReleased = touchClickPending;
  if (touchClickPending) { touchX = clickX; touchY = clickY; }
}
// Call at the end; consumes it.
inline void touchEndFrame() { touchClickPending = false; touchReleased = false; }

// --- buttons ----------------------------------------------------------
struct Button { int16_t x, y, w, h; const char* label; uint16_t fill; };

inline bool btnHit(const Button& b, int px, int py) {
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}
inline void btnDraw(const Button& b, bool active = false) {
  uint16_t fill = active ? C_ACCENT : b.fill;
  tft.fillRoundRect(b.x, b.y, b.w, b.h, 6, fill);
  tft.drawRoundRect(b.x, b.y, b.w, b.h, 6, active ? C_TEXT : C_MUTED);
  tft.setTextColor(C_TEXT, fill);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextSize(UI_S);
  tft.drawString(b.label, b.x + b.w / 2, b.y + b.h / 2);
}
inline bool btnUpdate(const Button& b) {
  bool active = touchDown && btnHit(b, touchX, touchY);
  btnDraw(b, active);
  return touchReleased && btnHit(b, touchX, touchY);
}

// --- chrome -----------------------------------------------------------
#define TABBAR_H  (22*UI_S)
#define STATUS_H  (14*UI_S)

inline void drawTabBar(const char* const* names, int count, int current) {
  int w = SCR_W / count;
  for (int i = 0; i < count; i++) {
    bool sel = (i == current);
    tft.fillRect(i * w, 0, w, TABBAR_H, sel ? C_ACCENT : C_PANEL);
    tft.setTextColor(sel ? C_BG : C_MUTED);
    tft.setTextDatum(textdatum_t::middle_center);
    tft.setTextSize(UI_S);
    tft.drawString(names[i], i * w + w / 2, TABBAR_H / 2);
  }
  tft.drawFastHLine(0, TABBAR_H, SCR_W, C_MUTED);
}

inline int tabBarTouched(int count) {
  if (!touchReleased || touchY >= TABBAR_H) return -1;
  int i = touchX / (SCR_W / count);
  return (i >= 0 && i < count) ? i : -1;
}

inline void clearBody() {
  tft.fillRect(0, TABBAR_H + 1, SCR_W, SCR_H - TABBAR_H - STATUS_H - 1, C_BG);
}

inline void drawStatusBar(const char* left, uint16_t leftColor, const char* right) {
  int y = SCR_H - STATUS_H;
  tft.fillRect(0, y, SCR_W, STATUS_H, C_PANEL);
  tft.setTextDatum(textdatum_t::middle_left);
  tft.setTextColor(leftColor, C_PANEL);
  tft.setTextSize(UI_S);
  tft.drawString(left, 6, y + STATUS_H / 2);
  tft.setTextDatum(textdatum_t::middle_right);
  tft.setTextColor(C_MUTED, C_PANEL);
  tft.drawString(right, SCR_W - 6, y + STATUS_H / 2);
}

// --- RSSI sparkline ---------------------------------------------------
// Fixed -100..-30 dBm scale so devices are comparable. Gaps (RSSI_ABSENT)
// render as nothing, which is itself information: a solid trace means the
// device is with you, a broken one means you passed it.
inline void drawSparkline(int x, int y, int w, int h,
                          const int8_t* ring, int len, int head) {
  tft.drawRect(x, y, w, h, C_PANEL);
  tft.setTextDatum(textdatum_t::top_left);
  tft.setTextColor(C_MUTED, C_BG);
  int prevY = -1, prevX = -1;
  for (int i = 0; i < len; i++) {
    int idx = (head + i) % len;
    int8_t v = ring[idx];
    int px = x + (i * (w - 2)) / len + 1;
    if (v == -128) { prevY = -1; continue; }          // gap
    int clamped = v < -100 ? -100 : (v > -30 ? -30 : v);
    int py = y + h - 2 - ((clamped + 100) * (h - 4)) / 70;
    tft.drawPixel(px, py, C_MUTED);                    // raw sample
    if (prevY >= 0) tft.drawLine(prevX, prevY, px, py, C_ACCENT);
    prevX = px; prevY = py;
  }
}
