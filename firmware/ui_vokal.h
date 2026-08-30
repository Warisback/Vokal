#pragma once
// =====================================================================
//  ui_vokal.h -- Vokal UI head.
//
//  A voice for people who have lost theirs. Hold the pad, say the
//  sentence however faintly you can manage, let go; the laptop runs
//  speech-to-text -> text-to-speech in a local Piper voice and speaks
//  it out loud. The board captures and triggers, nothing more.
//
//  This is an ADDITIONAL head, not a replacement: ui_puck.h is untouched
//  and still builds. config.h's APP_VOKAL picks which one firmware.ino
//  compiles in, and both export the same three symbols -- uiSplash(),
//  uiBegin(), uiTick(). Do not include ui_puck.h from here; it defines
//  those too.
//
//  The wire format is frozen in PROTOCOL.md. Read it before changing a
//  URL, a header or a status word in this file.
//
//  TWO THINGS THAT SHAPE EVERYTHING BELOW:
//
//   1. Every HTTP call here BLOCKS the UI core for hundreds of ms. So no
//      screen function ever makes one. A screen sets a pending flag, the
//      frame is painted and flushed, and only then does uiTick service
//      it -- the user is looking at an honest "SENDING" screen while the
//      board is deaf. Paint first, block second, always.
//
//   2. Touch is sampled at ~200 Hz and painted at 10 Hz. touchReleased is
//      a latched CLICK and touchPressed is gone by the next sample, so
//      neither can drive push-to-talk. Only touchDown is a live held
//      level, and the edge has to be found against our own previous
//      frame.
// =====================================================================
#include "ui_kit.h"      // -> display.h: tft, colours, SCR_W/SCR_H, UI_S
#include "audio.h"
#include "imu.h"
#include "net.h"         // after ui_kit.h: netStateColor() needs the colours

// ---------------------------------------------------------------------
//  Layout. Portrait 368x448, hand-tuned, top to bottom:
//
//     0..28    status strip   wifi | latency
//    66..270   the ring       PTT pad, status colour, state word inside
//   286..362   the body       level meter while listening, else caption
//   372..418   two buttons    CLIP DEMO | REPLAY
//   434        credit line
//
//  Interactive things stay >= 14 px in from the sides and 30 px up from
//  the bottom: ui_puck.h:121-123 records that this panel reads
//  unreliably within a few mm of its border, and every control here is
//  one somebody has to hit first time in front of an audience.
// ---------------------------------------------------------------------
#define VK_TOP_H     28
#define VK_CY       168          // ring centre
#define VK_R_OUT    102
#define VK_R_IN      80          // inner hole: 160 px of usable text width
#define VK_BODY_Y   286
#define VK_BTN_Y    372
#define VK_BTN_H     46
#define VK_CREDIT_Y 434

enum VokalState { VK_BOOT, VK_READY, VK_LISTENING, VK_SENDING, VK_WAITING, VK_ERROR };
static VokalState vstate = VK_BOOT;

// --- what the laptop last told us (PROTOCOL.md, GET /state) -----------
static String vkStatus  = "idle";   // idle|listening|processing|speaking|error
static String vkCaption = "";
static String vkSource  = "";       // "live" | "clip" | ""
static long   vkSeq     = -1;       // -1 = we have never seen a caption
static long   vkLatency = 0;        // ms to first audio, last utterance

// --- ours -------------------------------------------------------------
static bool     vkPrevDown     = false;  // last FRAME's pad state, for the edge
static bool     vkPrevFaceDown = false;  // imuFaceDown is a level, not an event
static bool     vkMuted        = false;
static uint32_t vkUttId        = 0;      // X-Utterance-Id, monotonic per boot
static uint32_t vkPressMs = 0, vkReleaseMs = 0;
static uint32_t vkWaitSince  = 0;
static uint32_t vkLastPoll   = 0;
static String   vkErr        = "";
static uint32_t vkErrClearMs = 0;        // 0 = sticky until something clears it

// Deferred blocking work. See note 1 in the banner.
static bool vkPendPost = false, vkPendDemo = false, vkPendReplay = false;

inline const char* vkStateName() {
  switch (vstate) {
    case VK_BOOT:      return "boot";
    case VK_READY:     return "ready";
    case VK_LISTENING: return "listening";
    case VK_SENDING:   return "sending";
    case VK_WAITING:   return "waiting";
    default:           return "error";
  }
}

inline void vkClearErr() { vkErr = ""; vkErrClearMs = 0; }

// A transient failure heals itself after VOKAL_ERR_HOLD_MS whether or not
// the laptop ever answers again -- long enough to read, short enough that
// a fumbled press does not cost you the stage. `sticky` is for the ones
// that are still true until something outside changes: no wifi, no laptop.
inline void vkFail(const char* why, bool sticky = false) {
  vkErr        = why;
  vkErrClearMs = sticky ? 0 : millis() + VOKAL_ERR_HOLD_MS;
  vstate       = VK_ERROR;
  Serial.printf("[vk] error: %s\n", why);
}

// ---------------------------------------------------------------------
//  Word wrap.
//
//  Nothing in this project can measure text: no getTextBounds, no
//  setFont, no wrap helper anywhere in the repo. It does not need one --
//  the built-in font is a fixed 6x8 cell, so a string's width IS
//  arithmetic: strlen * 6 * size. 30 chars a line at UI_S=2.
//
//  And do NOT let gfx->print wrap for you instead. drawString computes
//  its datum box from strlen alone, so any extra line print() invented
//  would be painted outside that box, on top of whatever is below it.
//
//  Returns the number of lines drawn.
// ---------------------------------------------------------------------
inline int vkWrap(const char* s, int cx, int top, int boxW, int lineH,
                  uint8_t size, int maxLines, uint16_t col) {
  char line[40];
  int cpl = boxW / (6 * size);                        // chars per line, exact
  if (cpl > (int)sizeof(line) - 4) cpl = (int)sizeof(line) - 4;  // room for "..."
  if (cpl < 4) return 0;

  tft.setTextColor(col, C_BG);
  tft.setTextSize(size);
  tft.setTextDatum(textdatum_t::top_center);

  int len = (int)strlen(s), pos = 0, drawn = 0;
  while (pos < len && drawn < maxLines) {
    while (pos < len && s[pos] == ' ') pos++;         // swallow the break itself
    if (pos >= len) break;

    int take = len - pos;
    if (take > cpl) {
      take = cpl;
      // If the character just past the cut is a space, the word ended
      // exactly on the boundary and a full line is the right answer.
      if (s[pos + take] != ' ') {
        int brk = -1;
        for (int i = 0; i < take; i++) if (s[pos + i] == ' ') brk = i;
        // brk < 0 means a single word longer than the line -- hard-break
        // it rather than dropping the rest of the sentence on the floor.
        if (brk > 0) take = brk;
      }
    }
    memcpy(line, s + pos, take);
    line[take] = 0;

    // Out of lines with words left. Say so: a caption that stops mid
    // sentence with no marker reads as the whole of what was said, and
    // this is a device whose entire job is saying what someone meant.
    if (drawn == maxLines - 1) {
      int rest = pos + take;
      while (rest < len && s[rest] == ' ') rest++;
      if (rest < len) {
        if (take > 3) line[take - 3] = 0;
        strcat(line, "...");
      }
    }

    tft.drawString(line, cx, top + drawn * lineH);
    pos += take;
    drawn++;
  }
  return drawn;
}

// ---------------------------------------------------------------------
//  Level meter -- the same ring walk as ui_puck.h:17-31.
//
//  This is the bar that proves to a room that a whisper is being heard,
//  so it is the one thing on this screen that must never flatter. The
//  green threshold is dropped from the puck's 20 to 8 because the voices
//  this device exists for do not clear 20.
// ---------------------------------------------------------------------
inline void vkWave(int x, int y, int w, int h) {
  int mid  = y + h / 2;
  int bars = w / 3;
  if (bars > WAVE_SLOTS) bars = WAVE_SLOTS;
  for (int i = 0; i < bars; i++) {
    int idx = (waveHead + WAVE_SLOTS - bars + i) % WAVE_SLOTS;
    int lvl = waveLvl[idx];
    int hh  = (lvl * (h / 2 - 2)) / 255;
    if (hh < 1) hh = 1;
    uint16_t c = lvl > 200 ? C_WARN : lvl > 8 ? C_OK : C_PANEL;
    tft.fillRect(x + i * 3, mid - hh, 2, hh * 2, c);
  }
  tft.drawFastHLine(x, mid, w, C_PANEL);
}

// PROTOCOL.md, "Status meanings". The board owns `listening` and paints
// it the instant the pad goes down -- it does not wait for a round trip
// to turn the ring red. Every other colour is the laptop's word.
inline uint16_t vkRingColor() {
  switch (vstate) {
    case VK_LISTENING: return C_ERR;                              // red
    case VK_SENDING:   return C_WARN;                             // amber
    case VK_WAITING:   return vkStatus == "speaking" ? C_OK : C_WARN;
    case VK_ERROR:     return ((millis() / 300) & 1) ? C_ERR : C_PANEL;  // flashing
    case VK_READY:     return C_MUTED;                            // dim white
    default:           return C_PANEL;
  }
}

// --- status strip -----------------------------------------------------
inline void vkTopBar() {
  tft.fillRect(0, 0, SCR_W, VK_TOP_H, C_PANEL);
  tft.setTextSize(UI_S);

  // 12 chars is 144 px at UI_S=2. An SSID can be 32 and would run clean
  // through the right-hand field, so it gets cut here rather than there.
  char l[24];
  snprintf(l, sizeof(l), "%.12s",
           netState == NET_ONLINE ? netSsid.c_str() : netStateName());
  tft.setTextDatum(textdatum_t::middle_left);
  tft.setTextColor(netStateColor(), C_PANEL);
  tft.drawString(l, 8, VK_TOP_H / 2);

  // Right: the number PROTOCOL.md's latency budget is about, in the one
  // place the presenter can see it without a serial console. Amber the
  // moment it crosses 3 s, because that is when the demo starts dying.
  char r[24];
  uint16_t rc = C_MUTED;
  if (vkMuted)             { snprintf(r, sizeof(r), "MUTED"); rc = C_WARN; }
  else if (vkLatency > 0)  { snprintf(r, sizeof(r), "%ld.%lds",
                                      vkLatency / 1000, (vkLatency % 1000) / 100);
                             rc = (vkLatency < 3000) ? C_OK : C_WARN; }
  else                     { snprintf(r, sizeof(r), "%.10s", vkStatus.c_str()); }
  tft.setTextDatum(textdatum_t::middle_right);
  tft.setTextColor(rc, C_PANEL);
  tft.drawString(r, SCR_W - 8, VK_TOP_H / 2);
}

// One line of ring text, transparent so it sits on whatever colour the
// hole happens to be. Size picked from length: the hole is 160 px wide,
// so 8 chars fit at size 3 (144 px) and 9 would not (162 px).
inline void vkRingText(const char* s, int y, uint16_t col) {
  tft.setTextSize(strlen(s) <= 8 ? 3 : 2);
  tft.setTextColor(col);                    // no bg: do not punch a hole
  tft.setTextDatum(textdatum_t::middle_center);
  tft.drawString(s, SCR_W / 2, y);
}

// --- the ring ---------------------------------------------------------
inline void vkRing(bool held) {
  // Two filled circles: the status colour, then the background punched
  // back out of the middle. There is no drawCircle on the TftShim, and
  // this is exactly what ui_puck.h:49-50 already does -- proven, and it
  // needs no new vendor-library surface to go wrong at 2 a.m.
  int rOut = VK_R_OUT + (vstate == VK_LISTENING ? 4 : 0);   // thickens on air
  tft.fillCircle(SCR_W / 2, VK_CY, rOut, vkRingColor());
  tft.fillCircle(SCR_W / 2, VK_CY, VK_R_IN, held ? C_PANEL : C_BG);

  char sub[24];
  const char* top = "";
  const char* bot = nullptr;

  switch (vstate) {
    case VK_BOOT:
      top = "STARTING"; break;
    case VK_READY:
      if (vkMuted) { top = "MUTED"; bot = "FACE UP"; }
      else         { top = "HOLD";  bot = "TO TALK"; }
      break;
    case VK_LISTENING: {
      uint32_t ms = audioMs();
      snprintf(sub, sizeof(sub), "%lu.%lus",
               (unsigned long)(ms / 1000), (unsigned long)((ms % 1000) / 100));
      top = "LISTENING"; bot = sub;
      break;
    }
    case VK_SENDING:
      snprintf(sub, sizeof(sub), "%luKB", (unsigned long)(audLen / 1024));
      top = "SENDING"; bot = sub;
      break;
    case VK_WAITING:
      if (vkStatus == "speaking") { top = "SPEAKING"; bot = "aloud"; }
      else                        { top = "THINKING"; bot = nullptr; }
      break;
    default:
      top = "ERROR"; break;
  }

  uint16_t tc = (vstate == VK_READY && !vkMuted) ? C_TEXT : vkRingColor();
  if (vstate == VK_ERROR) tc = C_ERR;          // never flash the WORD off
  if (bot) {
    vkRingText(top, VK_CY - 20, tc);
    tft.setTextSize(UI_S);
    tft.setTextColor(C_MUTED);
    tft.setTextDatum(textdatum_t::middle_center);
    tft.drawString(bot, SCR_W / 2, VK_CY + 24);
  } else {
    vkRingText(top, VK_CY, tc);
  }
}

// --- push to talk -----------------------------------------------------
// Returns whether the pad is being held, so the ring can show it in the
// same frame the press happened in.
inline bool vkPtt() {
  Button pad = { (int16_t)(SCR_W / 2 - VK_R_OUT), (int16_t)(VK_CY - VK_R_OUT),
                 (int16_t)(2 * VK_R_OUT), (int16_t)(2 * VK_R_OUT), "", C_BG };

  // A square hit box around a round pad. The corners are dead space with
  // nothing else in them, and a jab that lands near the rim should still
  // arm -- HIT_SLOP exists because a demo device gets jabbed at, not
  // aimed at.
  //
  // touchDown, not touchReleased (a latched click, fired on press) and
  // never touchPressed (set at 200 Hz, cleared on the next sample: a
  // 10 Hz paint pass would essentially never observe it).
  bool down    = touchDown && btnHit(pad, touchX, touchY);
  bool press   = down && !vkPrevDown;
  bool release = !down && vkPrevDown;
  vkPrevDown = down;

  if (press && !vkMuted && vstate != VK_SENDING && !vkPendPost) {
    vkClearErr();
    vstate    = VK_LISTENING;      // PROTOCOL.md: the BOARD owns this one
    vkPressMs = millis();
    vkUttId++;
    markCount = 0;                 // audioStart does not reset it (ui_puck.h:57)

    // Chirp BEFORE audioStart, never after. audioChirp is blocking and
    // plays out of a speaker a few centimetres from the mic, so a chirp
    // after capture opened would be the first thing in the utterance.
    // audioStart drains the DMA ring, which throws the echo away along
    // with the stale audio -- and the beep doubles as "start now".
    chirpStart();
    audioStart();
    Serial.printf("[vk] utt %lu t_press=%lu\n",
                  (unsigned long)vkUttId, (unsigned long)vkPressMs);
  }

  if (release && vstate == VK_LISTENING) {
    vkReleaseMs = millis();
    audioStop();
    // Deliberately NOT snapshotting audLen here, and deliberately no
    // chirp. audLen can still grow for ~64 ms (the capture task only
    // tests the flag at the top of its loop), and a 120 ms chirpStop
    // would come straight out of the latency budget for nothing -- the
    // laptop speaking IS the confirmation. Paint SENDING, then settle
    // and post from vkServiceNet() where stalling costs nobody anything.
    vstate     = VK_SENDING;
    vkPendPost = true;
  }

  return down;
}

// --- body: meter while listening, caption the rest of the time --------
inline void vkBody() {
  if (vstate == VK_LISTENING) {
    vkWave(14, VK_BODY_Y + 6, SCR_W - 28, 50);

    // Honest capture feedback -- and note where the bar is. The puck says
    // "too quiet - move closer" below an RMS of 250. This device is FOR
    // people whose voice is faint; telling them to speak up is the one
    // message it must never show. So the bar is VOKAL_HEARD_RMS, and the
    // fallback line blames the distance rather than the person.
    tft.setTextSize(UI_S);
    tft.setTextDatum(textdatum_t::top_center);
    if (audPeak >= VOKAL_HEARD_RMS) {
      tft.setTextColor(C_OK, C_BG);
      tft.drawString("hearing you", SCR_W / 2, VK_BODY_Y + 60);
    } else {
      tft.setTextColor(C_MUTED, C_BG);
      tft.drawString("closer to the mic", SCR_W / 2, VK_BODY_Y + 60);
    }
    return;
  }

  // A local failure is the fresher truth; on a server error PROTOCOL.md
  // puts the reason in the caption instead.
  if (vstate == VK_ERROR && vkErr.length()) {
    vkWrap(vkErr.c_str(), SCR_W / 2, VK_BODY_Y, SCR_W - 28, 25, UI_S, 3, C_ERR);
    return;
  }
  if (vkCaption.length()) {
    vkWrap(vkCaption.c_str(), SCR_W / 2, VK_BODY_Y, SCR_W - 28, 25, UI_S, 3,
           vstate == VK_ERROR ? C_ERR : C_TEXT);
  }
}

// --- buttons ----------------------------------------------------------
inline void vkButtons() {
  // 14 px in from each side, 30 px up from the bottom edge, and 32 px
  // apart -- which is the number that matters, because HIT_SLOP is 14 in
  // every direction: 166+14 = 180 falls short of 198-14 = 184, so neither
  // button can steal a press aimed at the other. Close that gap and the
  // clip beat starts firing replays.
  Button demo   = { 14,  VK_BTN_Y, 152, VK_BTN_H, "CLIP DEMO", C_PANEL };
  Button replay = { 198, VK_BTN_Y, 156, VK_BTN_H, "REPLAY",    C_PANEL };

  bool busy = (vstate == VK_LISTENING || vstate == VK_SENDING ||
               vkPendPost || vkPendDemo || vkPendReplay);

  // btnUpdate draws as well as tests, so both are called either way.
  if (btnUpdate(demo)   && !busy) vkPendDemo   = true;
  if (btnUpdate(replay) && !busy) vkPendReplay = true;

  // btnDraw leaves the datum at middle_center, the size at UI_S and the
  // colour at C_TEXT. Put back what the next caller assumes, exactly as
  // ui_puck.h:132 does.
  tft.setTextSize(UI_S);
}

// --- credit -----------------------------------------------------------
inline void vkCredit() {
  // PROTOCOL.md, "Voice ethics": the clip beat is spoken by the LOCAL
  // Piper voice, never a clone of whoever is in the source material, and
  // the source is credited ON SCREEN while it plays. Not in a README, not
  // in the spoken script -- here, where the room can read it.
  bool clip = (vkSource == "clip") && (vkCaption.length() > 0);
  tft.setTextSize(UI_S);
  tft.setTextDatum(textdatum_t::middle_center);
  tft.setTextColor(clip ? C_WARN : C_MUTED, C_BG);
  tft.drawString(clip ? VOKAL_CLIP_CREDIT : VOKAL_TAGLINE, SCR_W / 2, VK_CREDIT_Y);
}

// --- the screen -------------------------------------------------------
// Immediate mode, same contract as every screen in ui_puck.h: no args, no
// return, the framebuffer is already cleared, redraw 100% of the pixels,
// and NEVER call tft.flush() or touchEndFrame() -- uiTick owns those.
inline void screenVokal() {
  // Let a transient failure expire before anything is painted, so the
  // frame is consistent with the state the rest of the tick will see.
  if (vstate == VK_ERROR && vkErrClearMs && (int32_t)(millis() - vkErrClearMs) > 0) {
    vkClearErr();
    vstate = VK_READY;
  }

  vkTopBar();
  bool held = vkPtt();     // touch before paint: a press shows this frame
  vkRing(held);
  vkBody();
  vkButtons();
  vkCredit();
}

// =====================================================================
//  Everything below here BLOCKS. It runs from uiTick only after the
//  frame has been flushed to the panel.
// =====================================================================

// POST /utterance -- raw 16 kHz 16-bit mono LE PCM, straight out of
// PSRAM. No WAV header, no multipart, no base64: audBuf already holds
// precisely the bytes PROTOCOL.md asks for.
inline void vkDoPost() {
  // audRecording going false does not mean capture has finished. The task
  // only tests that flag at the top of its loop, so one already inside
  // i2s.readBytes() still commits its chunk -- up to ~64 ms, which is the
  // end of the last word. Wait for the flag it sets when it actually
  // parks, rather than guessing at a delay. Bounded, so a wedged task
  // cannot hang the demo.
  uint32_t t0 = millis();
  while (!audIdle && millis() - t0 < VOKAL_SETTLE_MS) delay(2);

  size_t   n  = audLen;
  uint32_t ms = (uint32_t)((n / 2) * 1000UL / AUD_RATE);

  if (ms < VOKAL_MIN_UTTER_MS) {
    // A fumbled press, not a sentence. Posting it makes the pipeline
    // invent a transcript out of room tone -- and putting invented words
    // into the mouth of someone who cannot correct them is the worst
    // thing this device could ever do.
    Serial.printf("[vk] utt %lu discarded: %lums of audio is too short\n",
                  (unsigned long)vkUttId, (unsigned long)ms);
    chirpErr();
    vkFail("too short - hold, then speak");
    return;
  }

  char idbuf[12];
  snprintf(idbuf, sizeof(idbuf), "%lu", (unsigned long)vkUttId);
  const HttpHeader hdr[2] = {
    { "X-Sample-Rate",  VK_STR(AUD_RATE) },   // stringified so it cannot
    { "X-Utterance-Id", idbuf },              // drift from the capture rate
  };

  String   resp;
  uint32_t tPost = millis();
  int code = httpPostRaw(VOKAL_URL_UTTERANCE, audBuf, n,
                         "application/octet-stream", resp, hdr, 2);
  uint32_t done = millis();

  // Once per utterance is not a hot loop, so this needs no
  // availableForWrite() guard -- and it is the line PROTOCOL.md's latency
  // budget gets read out of after every single take.
  Serial.printf("[vk] utt %lu hold=%lums bytes=%u http=%d | t_press=%lu t_release=%lu t_post_done=%lu post=%lums\n",
                (unsigned long)vkUttId, (unsigned long)ms, (unsigned)n, code,
                (unsigned long)vkPressMs, (unsigned long)vkReleaseMs,
                (unsigned long)done, (unsigned long)(done - tPost));

  if (code == 200 || code == 202) {
    vstate      = VK_WAITING;
    vkWaitSince = millis();
    vkStatus    = "processing";
  } else {
    chirpErr();
    char e[40];
    snprintf(e, sizeof(e), "upload failed (%d)", code);
    vkFail(e);
  }
}

// POST /demo/trigger -- the clip beat. Deterministic, and the one thing
// on stage that cannot fail on a bad mic or a quiet room.
inline void vkDoDemo() {
  String resp;
  int code = httpPostJson(VOKAL_URL_DEMO,
                          "{\"clip_id\":\"" VOKAL_DEMO_CLIP "\"}", resp);
  if (code == 200 || code == 202) {
    vstate      = VK_WAITING;
    vkWaitSince = millis();
    vkStatus    = "processing";
    // Claim the source NOW rather than a poll later: the credit line has
    // to be on screen for the whole of the clip, including the second
    // before /state catches up.
    vkSource    = "clip";
  } else {
    chirpErr();
    vkFail(code == 404 ? "unknown clip id" : "demo trigger failed");
  }
}

// POST /replay -- re-speak the last result with no STT and no TTS. The
// rehearsal path, and the fallback if the mic dies mid-demo.
inline void vkDoReplay() {
  // Empty body. httpPostJson still sends Content-Type: application/json
  // with Content-Length: 0, which is what PROTOCOL.md's "empty body"
  // means on the wire.
  String resp;
  int code = httpPostJson(VOKAL_URL_REPLAY, "", resp);
  if (code == 200 || code == 202) {
    vstate      = VK_WAITING;
    vkWaitSince = millis();
    vkStatus    = "processing";
  } else if (code == 409) {
    chirpErr();
    vkFail("nothing to replay yet");     // PROTOCOL.md: 409 = never spoken
  } else {
    chirpErr();
    vkFail("replay failed");
  }
}

// GET /state -- the laptop's half of the state machine.
inline void vkPollState() {
  String body;
  if (httpGetSmall(VOKAL_URL_STATE, body) != 200) {
    // Do not shout about it. An unreachable laptop for one poll is a
    // hotspot hiccup, not a state change, and flashing the ring red at
    // 3 Hz over it would be a lie. httpGetSmall already logged the code.
    return;
  }

  // seq is in PROTOCOL.md precisely so the board never has to diff
  // caption strings to notice the same words being said twice.
  long seq = jsonInt(body, "seq", vkSeq);
  if (seq != vkSeq) {
    vkSeq = seq;
    jsonStr(body, "caption", vkCaption);
    jsonStr(body, "source",  vkSource);
    Serial.printf("[vk] seq=%ld src=%s caption=\"%s\"\n",
                  seq, vkSource.c_str(), vkCaption.c_str());
  }
  vkLatency = jsonInt(body, "latency_ms", vkLatency);

  String st;
  if (!jsonStr(body, "status", st)) return;
  vkStatus = st;

  if (st == "error") {
    if (vstate != VK_ERROR) chirpErr();
    vkErr        = "";          // PROTOCOL.md: the caption holds the reason
    vkErrClearMs = 0;           // the server's error, so the server clears it
    vstate       = VK_ERROR;
  } else if (st == "processing" || st == "speaking") {
    vkClearErr();
    vstate      = VK_WAITING;
    vkWaitSince = millis();
  } else if (st == "idle") {
    // /utterance answers 202 BEFORE the pipeline starts, so "idle" here
    // can simply mean "has not begun yet". Without this hold the ring
    // blinks back to ready between every utterance and its processing.
    if (vstate != VK_WAITING || millis() - vkWaitSince > VOKAL_WAIT_HOLD_MS) {
      vkClearErr();
      vstate = VK_READY;
    }
  }
}

// One pending action per tick, at most. Two blocking calls in one frame
// would stall the UI for over a second and there is never a reason to.
inline void vkServiceNet() {
  if (vkPendPost)   { vkPendPost   = false; vkDoPost();   return; }
  if (vkPendDemo)   { vkPendDemo   = false; vkDoDemo();   return; }
  if (vkPendReplay) { vkPendReplay = false; vkDoReplay(); return; }

  // Never poll while the pad is down or a post is queued: what the
  // pipeline thinks is not the point mid-sentence, and an HTTP round trip
  // inside a listening frame would freeze the very meter that is proving
  // to the room we can hear them.
  if (vstate == VK_LISTENING || vstate == VK_SENDING) return;
  if (millis() - vkLastPoll < VOKAL_POLL_MS) return;
  vkLastPoll = millis();
  vkPollState();
}

// =====================================================================
//  The three symbols firmware.ino calls. ui_puck.h exports the same set.
// =====================================================================

// Signature is void(const char*), which is exactly netConnect()'s progress
// callback -- so `netConnect(uiSplash)` paints each SSID as it is tried.
inline void uiSplash(const char* msg) {
  tft.fillScreen(C_BG);

  // Wrapped rather than centred and quietly clipped: netConnect hands us
  // "Joining <ssid> ...", an SSID can be 32 characters, and a 368 px line
  // holds 30 at UI_S=2. The line count is only an estimate -- word breaks
  // can cost a line more than division predicts, which leaves the block
  // sitting slightly low. It is a splash screen; nobody will ever notice.
  int cpl   = (SCR_W - 24) / (6 * UI_S);
  int lines = ((int)strlen(msg) + cpl - 1) / cpl;
  if (lines < 1) lines = 1;
  if (lines > 4) lines = 4;
  vkWrap(msg, SCR_W / 2, (SCR_H - lines * 26) / 2, SCR_W - 24, 26, UI_S, 4, C_TEXT);

  tft.flush();
  touchEndFrame();
}

inline void uiBegin() {
  // imuFaceDown is a LEVEL, not an event. Seed the edge detector from
  // wherever the board is actually lying, or one that booted face down
  // chirps and mutes itself the first time somebody picks it up.
  vkPrevFaceDown = imuFaceDown;
  vkMuted        = imuFaceDown;

  if (netState != NET_ONLINE) {
    vkFail("no wifi - check secrets.h", true);
    return;
  }

  // Ask the laptop whether it is actually ready while nobody is watching.
  // GET /health is in PROTOCOL.md so that this question has an answer
  // before the demo, instead of during it.
  String b;
  int code = httpGetSmall(VOKAL_URL_HEALTH, b, 2000);
  if (code == 200) {
    bool w = jsonBool(b, "whisper", false);
    bool t = jsonBool(b, "tts", false);
    bool v = jsonBool(b, "voice_id_set", false);
    Serial.printf("[vk] health whisper=%d tts=%d voice_id_set=%d\n",
                  (int)w, (int)t, (int)v);
    // voice_id_set is a frozen field name from the old contract; it now
    // means "the local Piper voice is loaded". False is not fatal: the clip
    // beat plays a pre-rendered WAV, so only the live beat loses anything.
    if (!v) Serial.println("[vk] piper voice not loaded - live beat unavailable");
    if (w && t) { vstate = VK_READY; vkStatus = "idle"; }
    else        { vkFail(!w ? "laptop: no whisper" : "laptop: no tts", true); }
  } else {
    // Not fatal, and sticky rather than transient: the board almost always
    // boots before the laptop server does. The 3 Hz /state poll clears
    // this by itself the moment the laptop answers.
    Serial.printf("[vk] health check failed (%d) - waiting for the laptop\n", code);
    vkFail("waiting for laptop...", true);
  }
}

inline void uiTick() {
  touchTick();
  imuTick();

  // Read-and-clear, EXACTLY once per tick whatever we do with the answer.
  // It is a single-slot latch, not a counter: a second consumer anywhere
  // would steal taps from this one, and not reading it at all would leave
  // a stale tap to fire minutes later at the worst possible moment.
  bool dtap = imuTakeDoubleTap();

  // Face down = muted. A physical gesture rather than a menu, because
  // somebody who cannot speak should be able to disarm the mic one-handed
  // without looking at a screen. imuFaceDown is a level; edge it here.
  if (imuFaceDown != vkPrevFaceDown) {
    vkPrevFaceDown = imuFaceDown;
    vkMuted        = imuFaceDown;
    if (vkMuted && vstate == VK_LISTENING) {   // dropped mid-sentence: bin it
      audioStop();
      vstate     = VK_READY;
      vkPrevDown = false;
      vkPendPost = false;
    }
    audioChirp(vkMuted ? 330 : 660, 80);       // blocking, but once per flip
  }

  // Eyes-free "say that again" -- the same action as the REPLAY button,
  // for a hand that is holding the device rather than reading it. Only
  // from a resting state: replaying over the top of the laptop already
  // speaking would just make it stutter, and the tap detector is at its
  // least trustworthy while the board is being carried anyway.
  if (dtap && !vkMuted && (vstate == VK_READY || vstate == VK_ERROR)) {
    vkPendReplay = true;
  }

  static uint32_t last = 0;
  if (millis() - last < 100) return;   // 10 fps, same as the puck: plenty,
  last = millis();                     // and it keeps the I2C bus quiet

  touchBeginFrame();
  tft.fillScreen(C_BG);
  screenVokal();
  tft.flush();
  touchEndFrame();

  // AFTER the flush, never before. flush() is a synchronous QSPI blit, so
  // by the time it returns the frame explaining what is about to happen is
  // physically on the panel -- and only then do we go deaf for a while.
  vkServiceNet();
}
