#pragma once
// =====================================================================
//  tracker.h -- BLE sweep engine.
//
//    * continuous passive scan, duplicate filtering OFF so RSSI updates
//    * per-device ring buffer of RSSI history + EMA smoothing
//    * "continuity" = how much of the time a device has been present,
//      which is the honest proxy for "is this following me"
//    * baseline learn -> anything NEW afterwards is an anomaly
//    * signature matching only labels what it already found
//
//  Identity is a hash of the current BLE address. Addresses rotate
//  (AirTags roughly every 15 min when separated), so all correlation
//  here is SESSION-SCOPED. Say that in the demo.
// =====================================================================
#include "config.h"
#include <Arduino.h>

#define MAX_SIGHTINGS  40
#define RSSI_HISTORY   120        // ~2 min at 1 Hz
#define RSSI_ABSENT    (-128)     // sentinel: not seen this cycle
#define CYCLE_MS       1000

enum TrackerKind : uint8_t {
  KIND_UNKNOWN = 0,
  KIND_APPLE_FINDMY,      // separated from owner -- the interesting one
  KIND_APPLE_OTHER,
  KIND_TILE,
  KIND_SAMSUNG,
  KIND_GOOGLE,
};

static const char* KIND_NAMES[] = {
  "unknown", "FIND MY", "apple", "TILE", "SMARTTAG", "GOOGLE"
};

struct Sighting {
  uint32_t key;                    // hash of address == session identity
  uint16_t idHash;                 // short form for the UI (#A3F2)
  uint8_t  addrType;
  TrackerKind kind;
  int8_t   rssi[RSSI_HISTORY];
  uint8_t  head;
  int8_t   lastRssi;
  float    ema;
  bool     seenThisCycle;
  bool     inBaseline;
  bool     active;
  uint32_t firstSeenMs;
  uint32_t lastSeenMs;
  uint16_t sightings;
  uint16_t cycles;                 // cycles elapsed since first contact
  uint8_t  raw[31];                // max legacy advertisement payload
  uint8_t  rawLen;
};

static Sighting sight[MAX_SIGHTINGS];
static int      sightCount = 0;

enum LearnState : uint8_t { LEARN_NONE, LEARN_RUNNING, LEARN_DONE };
static LearnState learnState   = LEARN_NONE;
static uint32_t   learnStartMs = 0;
static uint32_t   learnRoomMs  = 0;
#define LEARN_WINDOW_MS  30000    // 30s baseline; long enough, short enough to demo

// A device counts as flagged when it is NOT in the baseline and has been
// around long enough to not be someone walking past.
#define FLAG_MIN_CYCLES     8
#define FLAG_MIN_CONTINUITY 40    // percent

inline uint8_t continuityPct(const Sighting& s) {
  if (s.cycles == 0) return 0;
  uint32_t c = (uint32_t)s.sightings * 100 / s.cycles;
  return c > 100 ? 100 : (uint8_t)c;
}

inline bool isFlagged(const Sighting& s) {
  if (!s.active || s.inBaseline) return false;
  if (learnState != LEARN_DONE)  return false;
  return s.cycles >= FLAG_MIN_CYCLES && continuityPct(s) >= FLAG_MIN_CONTINUITY;
}

// ---------------------------------------------------------------------
// ESP32-S2 has wifi but NO Bluetooth. Everything below is stubbed there
// so the sketch still builds and boots -- and tells you why.
// ---------------------------------------------------------------------
#if !defined(CONFIG_BT_ENABLED)
  #warning "This chip has no Bluetooth (ESP32-S2?) -- tracker disabled, use the wifi scanner"
  #define TRACKER_AVAILABLE 0
  inline void trackerBegin() {
    Serial.println("[trk] !! NO BLUETOOTH ON THIS CHIP -- fall back to the wifi scanner");
  }
  inline void trackerTick() {}
  inline void trackerLearn() {}
#else
  #define TRACKER_AVAILABLE 1
  #include <NimBLEDevice.h>

static uint32_t fnv1a(const char* s) {
  uint32_t h = 2166136261u;
  while (*s) { h ^= (uint8_t)*s++; h *= 16777619u; }
  return h;
}

// Signature matching. Verify these against a real tracker with nRF
// Connect before trusting the labels -- they are community-derived,
// not documented, and Google's in particular is a guess.
static TrackerKind classify(const NimBLEAdvertisedDevice* d) {
  for (uint8_t i = 0; i < d->getManufacturerDataCount(); i++) {
    std::string m = d->getManufacturerData(i);
    if (m.size() >= 3) {
      uint16_t cid = (uint8_t)m[0] | ((uint16_t)(uint8_t)m[1] << 8);
      if (cid == 0x004C) {                       // Apple
        uint8_t type = (uint8_t)m[2];
        return (type == 0x12) ? KIND_APPLE_FINDMY : KIND_APPLE_OTHER;
      }
    }
  }
  for (uint8_t i = 0; i < d->getServiceDataCount(); i++) {
    NimBLEUUID u = d->getServiceDataUUID(i);
    if (u == NimBLEUUID((uint16_t)0xFEED)) return KIND_TILE;
    if (u == NimBLEUUID((uint16_t)0xFD5A)) return KIND_SAMSUNG;
    if (u == NimBLEUUID((uint16_t)0xFD44)) return KIND_APPLE_FINDMY;
    if (u == NimBLEUUID((uint16_t)0xFEAA)) return KIND_GOOGLE;
  }
  return KIND_UNKNOWN;
}

// Apple Find My status byte: upper bits carry battery level. Community
// reverse-engineering, NOT documented -- check it against a tracker whose
// battery level you actually know before putting a number on screen.
inline int appleBatteryPct(const Sighting& s) {
  if (s.kind != KIND_APPLE_FINDMY || s.rawLen < 7) return -1;
  for (int i = 0; i + 3 < s.rawLen; i++) {
    if (s.raw[i] == 0x4C && s.raw[i + 1] == 0x00 && s.raw[i + 2] == 0x12) {
      uint8_t status = s.raw[i + 4];
      switch ((status >> 6) & 0x03) {
        case 0: return 100; case 1: return 60; case 2: return 30; default: return 10;
      }
    }
  }
  return -1;
}

static Sighting* findOrCreate(uint32_t key) {
  for (int i = 0; i < sightCount; i++) if (sight[i].active && sight[i].key == key) return &sight[i];

  int slot = -1;
  if (sightCount < MAX_SIGHTINGS) { slot = sightCount++; }
  else {
    // Table full: evict the stalest device that isn't flagged.
    uint32_t oldest = 0xFFFFFFFF;
    for (int i = 0; i < MAX_SIGHTINGS; i++) {
      if (isFlagged(sight[i])) continue;
      if (sight[i].lastSeenMs < oldest) { oldest = sight[i].lastSeenMs; slot = i; }
    }
    if (slot < 0) return nullptr;
  }

  Sighting& s = sight[slot];
  memset(&s, 0, sizeof(s));
  memset(s.rssi, RSSI_ABSENT, sizeof(s.rssi));
  s.key         = key;
  s.idHash      = (uint16_t)(key ^ (key >> 16));
  s.active      = true;
  s.firstSeenMs = millis();
  s.ema         = -100.0f;
  // Anything discovered during the learn window belongs to the room.
  s.inBaseline  = (learnState == LEARN_RUNNING);
  return &s;
}

class SweepCallbacks : public NimBLEScanCallbacks {
  void onResult(const NimBLEAdvertisedDevice* d) override {
    uint32_t key = fnv1a(d->getAddress().toString().c_str());
    Sighting* s = findOrCreate(key);
    if (!s) return;

    s->addrType     = d->getAddressType();
    s->lastRssi     = d->getRSSI();
    s->lastSeenMs   = millis();
    s->seenThisCycle = true;
    s->sightings++;
    // EMA: raw RSSI jitters +-10 dBm even when nothing moves.
    s->ema = (s->ema <= -100.0f) ? s->lastRssi : (0.2f * s->lastRssi + 0.8f * s->ema);

    TrackerKind k = classify(d);
    if (k != KIND_UNKNOWN) s->kind = k;
    if (learnState == LEARN_RUNNING) s->inBaseline = true;

    const std::vector<uint8_t>& p = d->getPayload();
    s->rawLen = p.size() > sizeof(s->raw) ? sizeof(s->raw) : p.size();
    if (s->rawLen) memcpy(s->raw, p.data(), s->rawLen);
  }
};

static SweepCallbacks sweepCb;

inline void trackerBegin() {
  NimBLEDevice::init("");
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setScanCallbacks(&sweepCb, true);   // wantDuplicates: we need RSSI updates
  scan->setActiveScan(false);               // passive: lower power, less conspicuous
  scan->setInterval(100);
  scan->setWindow(99);                      // ~100% duty cycle
  scan->setDuplicateFilter(false);
  scan->setMaxResults(0);                   // callback-only, no internal table
  scan->start(0, false, true);              // 0 = run forever
  Serial.println("[trk] scanning");
}

// Advance one cycle: push a sample (or a gap) into every ring buffer.
inline void trackerTick() {
  static uint32_t last = 0;
  if (millis() - last < CYCLE_MS) return;
  last = millis();

  for (int i = 0; i < sightCount; i++) {
    Sighting& s = sight[i];
    if (!s.active) continue;
    s.rssi[s.head] = s.seenThisCycle ? s.lastRssi : RSSI_ABSENT;
    s.head = (s.head + 1) % RSSI_HISTORY;
    s.cycles++;
    s.seenThisCycle = false;
    // Gone for 3 minutes and never interesting -> reclaim the slot.
    if (!isFlagged(s) && millis() - s.lastSeenMs > 180000) s.active = false;
  }

  if (learnState == LEARN_RUNNING && millis() - learnStartMs >= LEARN_WINDOW_MS) {
    learnState  = LEARN_DONE;
    learnRoomMs = millis();
    int n = 0;
    for (int i = 0; i < sightCount; i++) if (sight[i].inBaseline) n++;
    Serial.printf("[trk] baseline locked: %d devices\n", n);
  }
}

inline void trackerLearn() {
  learnState   = LEARN_RUNNING;
  learnStartMs = millis();
  for (int i = 0; i < sightCount; i++) sight[i].inBaseline = false;
  Serial.println("[trk] learning baseline...");
}
#endif  // CONFIG_BT_ENABLED

inline int flaggedCount() {
  int n = 0;
  for (int i = 0; i < sightCount; i++) if (isFlagged(sight[i])) n++;
  return n;
}
