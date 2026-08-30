#pragma once
// =====================================================================
//  ui_puck.h -- meeting puck UI.
//
//  Designed to be read from across a table, not held in the hand:
//  large type, unmistakable recording state, big touch targets.
// =====================================================================
#include "ui_kit.h"
#include "audio.h"
#include "imu.h"

enum PuckState { ST_IDLE, ST_REC, ST_REVIEW };
static PuckState pstate = ST_IDLE;
static bool wasFaceDown = false;

// --- live waveform ----------------------------------------------------
inline void drawWave(int x, int y, int w, int h) {
  tft.fillRect(x, y, w, h, C_BG);
  int mid = y + h / 2;
  int bars = w / 3;
  if (bars > WAVE_SLOTS) bars = WAVE_SLOTS;
  for (int i = 0; i < bars; i++) {
    int idx = (waveHead + WAVE_SLOTS - bars + i) % WAVE_SLOTS;
    int lvl = waveLvl[idx];
    int hh  = (lvl * (h / 2 - 2)) / 255;
    if (hh < 1) hh = 1;
    uint16_t c = lvl > 200 ? C_WARN : lvl > 20 ? C_OK : C_PANEL;
    tft.fillRect(x + i * 3, mid - hh, 2, hh * 2, c);
  }
  tft.drawFastHLine(x, mid, w, C_PANEL);
}

// --- IDLE -------------------------------------------------------------
inline void screenIdle() {
  clearBody();
  int top = 0;
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_MUTED, C_BG);
  tft.setTextSize(UI_S);
  tft.drawString("meeting puck", SCR_W / 2, 40);

  char l[48];
  snprintf(l, sizeof(l), "%d entr%s captured", 0, "ies");
  tft.setTextColor(C_PANEL, C_BG);
  tft.drawString(l, SCR_W / 2, SCR_H - 90);

  Button rec = { (int16_t)(SCR_W/2 - 90), (int16_t)(SCR_H/2 - 90), 180, 180, "", C_PANEL };
  bool active = touchDown && btnHit(rec, touchX, touchY);
  tft.fillCircle(SCR_W/2, SCR_H/2, 88, active ? C_ERR : C_PANEL);
  tft.fillCircle(SCR_W/2, SCR_H/2, 62, C_ERR);
  tft.setTextColor(C_TEXT, C_ERR);
  tft.setTextSize(UI_S);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.drawString("RECORD", SCR_W/2, SCR_H/2);

  if (touchReleased && btnHit(rec, touchX, touchY)) {
    markCount = 0;
    audioStart();
    chirpStart();
    pstate = ST_REC;
  }
}

// --- RECORDING --------------------------------------------------------
inline void screenRec() {
  clearBody();
  bool paused = audPaused;

  // consent banner: readable from two metres, unambiguous
  uint16_t bc = paused ? C_WARN : C_ERR;
  tft.fillRect(0, 0, SCR_W, 76, bc);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_BG, bc);
  tft.setTextSize(UI_S * 2);
  tft.drawString(paused ? "PAUSED" : "RECORDING", SCR_W / 2, 30);
  tft.setTextSize(UI_S);
  tft.drawString(paused ? "face down - not listening" : "everyone can see this",
                 SCR_W / 2, 60);

  // clock + buffer
  char l[48];
  uint32_t ms = audioMs();
  snprintf(l, sizeof(l), "%02lu:%02lu   buffer %d%%   marks %d",
           (unsigned long)(ms/60000), (unsigned long)((ms/1000)%60),
           audioPct(), markCount);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_MUTED, C_BG);
  tft.setTextSize(UI_S);
  tft.drawString(l, SCR_W / 2, 96);

  drawWave(10, 112, SCR_W - 20, 76);

  // honest capture feedback
  tft.setTextDatum(textdatum_t::middle_center);
  if (paused)              { tft.setTextColor(C_WARN, C_BG);  tft.drawString("paused", SCR_W/2, 200); }
  else if (audPeak < 250)  { tft.setTextColor(C_WARN, C_BG);  tft.drawString("too quiet - move closer", SCR_W/2, 200); }
  else                     { tft.setTextColor(C_OK, C_BG);    tft.drawString("hearing you", SCR_W/2, 200); }

  // 2x2 mark grid
  int gx = 10, gy = 214, gw = (SCR_W - 30) / 2, gh = 62;
  const char* labels[4] = { "* important", "OK decision", "-> action", "? question" };
  for (int i = 0; i < 4; i++) {
    Button b = { (int16_t)(gx + (i % 2) * (gw + 10)), (int16_t)(gy + (i / 2) * (gh + 10)),
                 (int16_t)gw, (int16_t)gh, labels[i], C_PANEL };
    if (btnUpdate(b) && !paused) addMark((MarkType)i);
  }

  // recent marks
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_MUTED, C_BG);
  if (markCount) {
    uint32_t m = marks[markCount-1].ms;
    snprintf(l, sizeof(l), "last: %s @ %02lu:%02lu",
             MARK_NAMES[marks[markCount-1].type],
             (unsigned long)(m/60000), (unsigned long)((m/1000)%60));
    tft.drawString(l, SCR_W/2, gy + 2*gh + 22);
  } else {
    tft.drawString("double-tap the table to mark", SCR_W/2, gy + 2*gh + 22);
  }

  // Kept clear of the bottom edge: the panel reads unreliably within a
  // few mm of the border, and this is the one control that must work.
  Button stop = { 12, (int16_t)(SCR_H - 96), (int16_t)(SCR_W - 24), 68, "STOP", C_PANEL };
  tft.fillRect(stop.x, stop.y, stop.w, stop.h, C_BG);
  bool stopActive = touchDown && btnHit(stop, touchX, touchY);
  tft.fillRoundRect(stop.x, stop.y, stop.w, stop.h, 10, stopActive ? C_ERR : C_PANEL);
  tft.drawRoundRect(stop.x, stop.y, stop.w, stop.h, 10, C_ERR);
  tft.setTextColor(C_TEXT, stopActive ? C_ERR : C_PANEL);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextSize(UI_S * 2);
  tft.drawString("STOP", stop.x + stop.w / 2, stop.y + stop.h / 2);
  tft.setTextSize(UI_S);
  if (touchReleased && btnHit(stop, touchX, touchY)) {
    audioStop(); chirpStop(); pstate = ST_REVIEW;
  }
}

// --- REVIEW -----------------------------------------------------------
inline void screenReview() {
  clearBody();
  tft.setTextDatum(textdatum_t::top_left);
  tft.setTextColor(C_TEXT, C_BG);
  tft.setTextSize(UI_S);
  char l[64];
  uint32_t ms = audioMs();
  snprintf(l, sizeof(l), "%02lu:%02lu captured, %d marks",
           (unsigned long)(ms/60000), (unsigned long)((ms/1000)%60), markCount);
  tft.drawString(l, 12, 16);
  tft.setTextColor(C_MUTED, C_BG);
  snprintf(l, sizeof(l), "%lu KB pcm - not yet transcribed", (unsigned long)(audLen/1024));
  tft.drawString(l, 12, 42);

  int y = 80;
  for (int i = 0; i < markCount && y < SCR_H - 130; i++) {
    uint32_t m = marks[i].ms;
    snprintf(l, sizeof(l), "%02lu:%02lu  %s",
             (unsigned long)(m/60000), (unsigned long)((m/1000)%60), MARK_NAMES[marks[i].type]);
    tft.setTextColor(C_ACCENT, C_BG);
    tft.drawString(l, 12, y);
    y += 22 * UI_S / 2 + 8;
  }

  Button again = { 12, (int16_t)(SCR_H - 96), (int16_t)(SCR_W - 24), 68, "NEW RECORDING", C_PANEL };
  if (btnUpdate(again)) pstate = ST_IDLE;
}

// --- driver -----------------------------------------------------------
inline void uiSplash(const char* msg) {
  tft.fillScreen(C_BG);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(C_TEXT, C_BG);
  tft.setTextSize(UI_S);
  tft.drawString(msg, tft.width() / 2, tft.height() / 2);
  tft.flush();
  touchEndFrame();
}

inline void uiBegin() {}

inline void uiTick() {
  touchTick();
  imuTick();

  // flip face-down pauses; face-up resumes
  if (pstate == ST_REC && imuFaceDown != wasFaceDown) {
    wasFaceDown = imuFaceDown;
    audioPause(imuFaceDown);
    audioChirp(imuFaceDown ? 330 : 660, 80);
  }
  // double-tap marks, eyes-free
  if (imuTakeDoubleTap() && pstate == ST_REC && !audPaused) addMark(MARK_IMPORTANT);

  static uint32_t last = 0;
  if (millis() - last < 100) return;     // 10 fps is plenty and keeps I2C quiet
  last = millis();

  touchBeginFrame();
  tft.fillScreen(C_BG);
  switch (pstate) {
    case ST_IDLE:   screenIdle();   break;
    case ST_REC:    screenRec();    break;
    case ST_REVIEW: screenReview(); break;
  }
  tft.flush();
  touchEndFrame();
}
