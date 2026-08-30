#pragma once
// =====================================================================
//  ui_tracker.h -- the sweep instrument.
//
//    SWEEP  : what is around me, what is new since the baseline
//    HUNT   : walk me to the physical device  <- the headline
//    DETAIL : raw bytes and stats, the credibility screen
// =====================================================================
#include "ui_kit.h"
#include "tracker.h"

enum TScreen { T_SWEEP = 0, T_HUNT = 1, T_DETAIL = 2, T__COUNT = 3 };
static const char* T_NAMES[] = { "Sweep", "Hunt", "Detail" };
static TScreen tscreen = T_SWEEP;
static bool    tDirty  = true;
static int     target  = -1;          // index into sight[]

inline void tGoto(TScreen s) { if (s != tscreen) { tscreen = s; tDirty = true; } }

// --- helpers ----------------------------------------------------------
// Trend from the EMA-equivalent: mean of the last 4 valid samples vs the
// 4 before them. Returns +1 approaching, -1 receding, 0 steady.
inline int trendOf(const Sighting& s) {
  int sums[2] = {0, 0}, n[2] = {0, 0};
  for (int back = 1; back <= 8; back++) {
    int idx = (s.head - back + RSSI_HISTORY * 2) % RSSI_HISTORY;
    int8_t v = s.rssi[idx];
    if (v == RSSI_ABSENT) continue;
    int bucket = (back <= 4) ? 0 : 1;
    sums[bucket] += v; n[bucket]++;
  }
  if (!n[0] || !n[1]) return 0;
  int recent = sums[0] / n[0], older = sums[1] / n[1];
  if (recent - older >= 4)  return 1;
  if (older - recent >= 4)  return -1;
  return 0;
}

// Buckets, not metres. Indoor RSSI->distance is not defensible.
inline const char* proxWord(float ema) {
  if (ema > -55) return "HOT";
  if (ema > -70) return "WARM";
  if (ema > -85) return "COLD";
  return "FAINT";
}
inline uint16_t proxColor(float ema) {
  if (ema > -55) return C_ERR;
  if (ema > -70) return C_WARN;
  if (ema > -85) return C_ACCENT;
  return C_MUTED;
}
inline int proxPct(float ema) {
  int p = (int)((ema + 100.0f) * 100.0f / 70.0f);
  return p < 0 ? 0 : (p > 100 ? 100 : p);
}

// Real trackers only. A room full of phones and laptops is all
// KIND_APPLE_OTHER / KIND_UNKNOWN and drowns the list.
inline bool isTrackerKind(TrackerKind k) {
  return k == KIND_APPLE_FINDMY || k == KIND_TILE ||
         k == KIND_SAMSUNG      || k == KIND_GOOGLE;
}

static bool showAll = false;

// Flagged first, then strongest signal.
//
// Two stability rules, because a list that reshuffles every frame is
// unreadable and impossible to tap accurately:
//   1. only re-sort every 2s, never while a finger is down
//   2. 3 dB dead band, so EMA jitter alone cannot swap two rows
static int      order[MAX_SIGHTINGS];
static int      orderCount = 0;
static uint32_t lastOrderMs = 0;

inline void buildOrder(bool force = false) {
  if (!force && (touchDown || millis() - lastOrderMs < 2000)) return;
  lastOrderMs = millis();
  orderCount = 0;
  for (int i = 0; i < sightCount; i++) {
    if (!sight[i].active) continue;
    if (!showAll && !isTrackerKind(sight[i].kind) && !isFlagged(sight[i])) continue;
    order[orderCount++] = i;
  }
  for (int a = 0; a < orderCount; a++)
    for (int b = a + 1; b < orderCount; b++) {
      const Sighting &A = sight[order[a]], &B = sight[order[b]];
      bool swap = (isFlagged(B) && !isFlagged(A)) ||
                  (isFlagged(B) == isFlagged(A) && B.ema > A.ema + 3.0f);
      if (swap) { int t = order[a]; order[a] = order[b]; order[b] = t; }
    }
}

// --- SWEEP ------------------------------------------------------------
#define ROW_H (16*UI_S)
inline void screenSweep() {
  int top = TABBAR_H + 1;
  int16_t by = (int16_t)(SCR_H - STATUS_H - 20*UI_S - 8);
  int16_t bw = (int16_t)((SCR_W - 24) / 2);
  Button bLearn  = { 8, by, bw, (int16_t)(20*UI_S), "Learn 30s", C_PANEL };
  Button bFilter = { (int16_t)(16 + bw), by, bw, (int16_t)(20*UI_S),
                     showAll ? "Showing: ALL" : "Trackers only", C_PANEL };

  buildOrder();
  clearBody();

  // header: what the baseline currently means
  tft.setTextDatum(textdatum_t::top_left);
  char hdr[64];
  if (learnState == LEARN_RUNNING) {
    tft.setTextColor(C_WARN, C_BG);
    snprintf(hdr, sizeof(hdr), "LEARNING  %lus left",
             (unsigned long)((LEARN_WINDOW_MS - (millis() - learnStartMs)) / 1000));
  } else if (learnState == LEARN_DONE) {
    tft.setTextColor(C_TEXT, C_BG);
    snprintf(hdr, sizeof(hdr), "%d flagged / %d shown / %d seen",
             flaggedCount(), orderCount, sightCount);
  } else {
    tft.setTextColor(C_MUTED, C_BG);
    snprintf(hdr, sizeof(hdr), "%d shown / %d seen - no baseline", orderCount, sightCount);
  }
  tft.setTextSize(UI_S); tft.drawString(hdr, 8, top + 4);

  int y = top + 14*UI_S;
  int maxRows = (SCR_H - STATUS_H - 22*UI_S - 12 - y) / ROW_H;
  for (int r = 0; r < orderCount && r < maxRows; r++) {
    Sighting& s = sight[order[r]];
    bool flag = isFlagged(s);
    if (order[r] == target) tft.fillRect(0, y, SCR_W, ROW_H, C_PANEL);
    if (flag) tft.fillCircle(6*UI_S, y + ROW_H/2, 3*UI_S, C_ERR);

    tft.setTextDatum(textdatum_t::middle_left);
    tft.setTextColor(flag ? C_ERR : C_TEXT, order[r] == target ? C_PANEL : C_BG);
    char id[32];
    snprintf(id, sizeof(id), "#%04X %s", s.idHash, KIND_NAMES[s.kind]);
    tft.setTextSize(UI_S); tft.drawString(id, 13*UI_S, y + ROW_H/2);

    int barX = SCR_W - 60*UI_S, barW = 28*UI_S;
    int pct = proxPct(s.ema);
    tft.drawRect(barX, y + ROW_H/2 - 4*UI_S, barW, 8*UI_S, C_MUTED);
    tft.fillRect(barX+1, y + ROW_H/2 - 4*UI_S + 1, (barW-2)*pct/100, 8*UI_S-2, proxColor(s.ema));

    tft.setTextDatum(textdatum_t::middle_right);
    tft.setTextColor(C_MUTED, order[r] == target ? C_PANEL : C_BG);
    char rt[16]; snprintf(rt, sizeof(rt), "%d%%", continuityPct(s));
    tft.setTextSize(UI_S); tft.drawString(rt, SCR_W - 8, y + ROW_H/2);

    if (touchReleased && touchY >= y && touchY < y + ROW_H) {
      target = order[r];
      tGoto(T_HUNT);
    }
    y += ROW_H;
  }

  if (orderCount == 0) {
    tft.setTextDatum(textdatum_t::middle_center);
    tft.setTextColor(C_MUTED, C_BG);
    tft.drawString(showAll ? "no devices - is BLE running?"
                            : "no trackers - tap Trackers only", SCR_W / 2, SCR_H / 2);
  }
  if (btnUpdate(bLearn))  trackerLearn();
  if (btnUpdate(bFilter)) { showAll = !showAll; buildOrder(true); }
}

// --- HUNT (the headline) ----------------------------------------------
inline void screenHunt() {
  clearBody();
  int top = TABBAR_H + 1;

  if (target < 0 || !sight[target].active) {
    tft.setTextDatum(textdatum_t::middle_center);
    tft.setTextColor(C_MUTED, C_BG);
    tft.drawString("pick a device on Sweep", SCR_W / 2, SCR_H / 2);
    return;
  }
  Sighting& s = sight[target];

  tft.setTextDatum(textdatum_t::top_left);
  tft.setTextColor(C_MUTED, C_BG);
  char id[40]; snprintf(id, sizeof(id), "#%04X  %s", s.idHash, KIND_NAMES[s.kind]);
  tft.setTextSize(UI_S); tft.drawString(id, 10, top + 6);

  // the big word
  uint16_t c = proxColor(s.ema);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(c, C_BG);
  tft.setTextSize(UI_S*3);
  tft.drawString(proxWord(s.ema), SCR_W/2, top + 30*UI_S);
  tft.setTextSize(UI_S);

  // the big bar
  int bx = 20, bw = SCR_W - 40, by = top + 52*UI_S, bh = 20*UI_S;
  int pct = proxPct(s.ema);
  tft.drawRect(bx, by, bw, bh, C_MUTED);
  tft.fillRect(bx + 2, by + 2, (bw - 4) * pct / 100, bh - 4, c);

  // number + trend
  int tr = trendOf(s);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_TEXT, C_BG);
  char l[48];
  snprintf(l, sizeof(l), "%d dBm   %s", (int)s.ema,
           tr > 0 ? "^ closer" : tr < 0 ? "v further" : "- steady");
  tft.setTextSize(UI_S); tft.drawString(l, SCR_W/2, by + bh + 12*UI_S);

  drawSparkline(20, by + bh + 24*UI_S, SCR_W - 40, 34*UI_S, s.rssi, RSSI_HISTORY, s.head);
}

// --- DETAIL -----------------------------------------------------------
inline void screenDetail() {
  clearBody();
  int top = TABBAR_H + 1;
  if (target < 0 || !sight[target].active) {
    tft.setTextDatum(textdatum_t::middle_center);
    tft.setTextColor(C_MUTED, C_BG);
    tft.drawString("pick a device on Sweep", SCR_W / 2, SCR_H / 2);
    return;
  }
  Sighting& s = sight[target];
  tft.setTextDatum(textdatum_t::top_left);
  tft.setTextColor(C_TEXT, C_BG);

  char l[80];
  int y = top + 6; tft.setTextSize(UI_S);
  snprintf(l, sizeof(l), "#%04X  %s  addrtype %d", s.idHash, KIND_NAMES[s.kind], s.addrType);
  tft.drawString(l, 6, y); y += 10*UI_S;
  snprintf(l, sizeof(l), "first seen %lus   sightings %u",
           (unsigned long)((millis() - s.firstSeenMs) / 1000), s.sightings);
  tft.drawString(l, 6, y); y += 10*UI_S;
  snprintf(l, sizeof(l), "continuity %u%%   %s",
           continuityPct(s), s.inBaseline ? "in baseline" : "NEW since baseline");
  tft.setTextColor(s.inBaseline ? C_MUTED : C_ERR, C_BG);
  tft.drawString(l, 6, y); y += 11*UI_S;

#if TRACKER_AVAILABLE
  int batt = appleBatteryPct(s);
  if (batt >= 0) {
    tft.setTextColor(C_WARN, C_BG);
    snprintf(l, sizeof(l), "battery ~%d%% (unverified decode)", batt);
    tft.drawString(l, 6, y);
  }
  y += 11*UI_S;
#endif

  // raw advertisement -- the credibility element
  tft.setTextColor(C_MUTED, C_BG);
  tft.drawString("raw advertisement:", 6, y); y += 9*UI_S;
  char hex[64]; int col = 0;
  hex[0] = 0;
  for (int i = 0; i < s.rawLen; i++) {
    char b[4]; snprintf(b, sizeof(b), "%02X ", s.raw[i]);
    strncat(hex, b, sizeof(hex) - strlen(hex) - 1);
    if (++col == (SCR_W/(18*UI_S))) {
      tft.setTextColor(C_TEXT, C_BG); tft.drawString(hex, 6, y);
      y += 9*UI_S; col = 0; hex[0] = 0;
    }
  }
  if (col) { tft.setTextColor(C_TEXT, C_BG); tft.drawString(hex, 6, y); }
}

// --- driver -----------------------------------------------------------
inline void uiSplash(const char* msg) {
  tft.fillScreen(C_BG);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_TEXT, C_BG);
  tft.drawString(msg, tft.width() / 2, tft.height() / 2);
  tft.flush();
}

inline void uiBegin() { tDirty = true; }

inline void uiTick() {
  static uint32_t lastPaint = 0;
  touchTick();
  int t = tabBarTouched(T__COUNT);
  if (t >= 0) tGoto((TScreen)t);

  // repaint on interaction, otherwise ~4 Hz (hunt needs to feel live)
  bool repaint = tDirty || touchReleased || touchDown || (millis() - lastPaint > 250);
  if (!repaint) return;
  lastPaint = millis();

  if (tDirty) tft.fillScreen(C_BG);
  drawTabBar(T_NAMES, T__COUNT, tscreen);

  switch (tscreen) {
    case T_SWEEP:  screenSweep();  break;
    case T_HUNT:   screenHunt();   break;
    case T_DETAIL: screenDetail(); break;
    default: break;
  }

  char right[32];
  snprintf(right, sizeof(right), "heap %uk", (unsigned)(ESP.getFreeHeap() / 1024));
#if TRACKER_AVAILABLE
  drawStatusBar("BLE scanning - wifi OFF", C_OK, right);
#else
  drawStatusBar("NO BLUETOOTH ON THIS CHIP", C_ERR, right);
#endif
  tft.flush();
  tDirty = false;
}
