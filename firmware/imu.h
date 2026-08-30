#pragma once
// =====================================================================
//  imu.h -- QMI8658 gestures for the puck.
//
//    flip face-down  -> pause recording   (physical consent, visible to
//                                          everyone at the table)
//    double-tap      -> log a mark        (eyes-free; you are looking at
//                                          people, not at the screen)
//    orientation     -> rotate the UI     (shared device, passed around)
//
//  Detection is done here from raw accelerometer reads rather than the
//  chip's hardware tap engine: fewer unknowns, and the thresholds are
//  ours to tune on the day.
// =====================================================================
#include "config.h"
#include <Wire.h>
#include "SensorQMI8658.hpp"

static SensorQMI8658 qmi;
static bool  imuOk = false;
static float imuX = 0, imuY = 0, imuZ = 1.0f;   // last good reading, for diagnostics

// --- flip ---------------------------------------------------------------
static bool  imuFaceDown   = false;
static uint32_t faceDownSince = 0;
// Separate enter/exit thresholds: a single threshold chatters when the
// board rests near it, which pauses recording at random.
// Measured on this board: Z reads about -1.0 g resting FACE UP, so
// face-down is positive Z. Hysteretic: enter and exit differ.
#define FLIP_ENTER_Z    (0.70f)    // must exceed this to count as face down
#define FLIP_EXIT_Z     (0.35f)    // must fall below this to count as face up
#define FLIP_HOLD_MS    400        // and hold it, so a passing hand is ignored

// --- double tap ---------------------------------------------------------
// A tap is a short, sharp jerk: |accel| spikes well past 1g then settles.
#define TAP_G_THRESH     1.9f
#define TAP_REFRACTORY   140       // ignore ringing from the same strike
#define TAP_WINDOW_MS    450       // max gap between the two taps
static uint32_t lastTapMs = 0, firstTapMs = 0;
static bool     imuDoubleTap = false;   // consumed by the UI, one shot

// --- orientation --------------------------------------------------------
// 0 = upright, 1 = rotated left, 2 = upside down, 3 = rotated right
static uint8_t imuOrient = 0, imuOrientStable = 0;
static uint32_t orientSince = 0;
#define ORIENT_HOLD_MS  600

inline bool imuBegin() {
  imuOk = qmi.begin(Wire, QMI8658_L_SLAVE_ADDRESS, IIC_SDA, IIC_SCL);
  if (!imuOk) { Serial.println("[imu] QMI8658 not found"); return false; }
  qmi.configAccelerometer(SensorQMI8658::ACC_RANGE_4G,
                          SensorQMI8658::ACC_ODR_125Hz);
  qmi.enableAccelerometer();
  Serial.println("[imu] QMI8658 ready");
  return true;
}

// Call every loop. Cheap: one I2C read at ~50 Hz.
inline void imuTick() {
  if (!imuOk) return;
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < 20) return;
  last = now;

  // Reading without checking data-ready returns stale/garbage registers,
  // which is what made the flip detector oscillate.
  if (!qmi.getDataReady()) return;
  float x, y, z;
  if (!qmi.getAccelerometer(x, y, z)) return;
  imuX = x; imuY = y; imuZ = z;

  // ---- flip, hysteretic + held ----
  bool down = imuFaceDown ? (z > FLIP_EXIT_Z) : (z > FLIP_ENTER_Z);
  if (down != imuFaceDown) {
    if (!faceDownSince) faceDownSince = now;
    else if (now - faceDownSince > FLIP_HOLD_MS) {
      imuFaceDown = down;
      faceDownSince = 0;
      Serial.printf("[imu] %s\n", down ? "face down" : "face up");
    }
  } else faceDownSince = 0;

  // ---- double tap ----
  float mag = sqrtf(x*x + y*y + z*z);
  if (mag > TAP_G_THRESH && now - lastTapMs > TAP_REFRACTORY) {
    lastTapMs = now;
    if (firstTapMs && now - firstTapMs < TAP_WINDOW_MS) {
      imuDoubleTap = true;
      firstTapMs = 0;
    } else {
      firstTapMs = now;
    }
  }
  if (firstTapMs && now - firstTapMs > TAP_WINDOW_MS) firstTapMs = 0;

  // ---- orientation, debounced ----
  uint8_t o = imuOrient;
  if (fabsf(x) > fabsf(y)) o = (x > 0) ? 1 : 3;
  else                     o = (y > 0) ? 0 : 2;
  if (o != imuOrientStable) {
    if (!orientSince) orientSince = now;
    else if (now - orientSince > ORIENT_HOLD_MS) {
      imuOrientStable = o; imuOrient = o; orientSince = 0;
    }
  } else orientSince = 0;
}

// One-shot read; clears the flag.
inline bool imuTakeDoubleTap() {
  if (!imuDoubleTap) return false;
  imuDoubleTap = false;
  return true;
}
