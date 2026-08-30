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
static float imuX = 0, imuY = 0, imuZ = 1.0f;   // accel, g
static float imuGX = 0, imuGY = 0, imuGZ = 0;  // gyro, dps
static float imuHpZ = 0;                       // high-passed az
static float imuSlowA = 0, imuSlowG = 0;       // handling estimates
static bool  imuQuiet = true;

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
// Detection runs on a HIGH-PASSED Z axis, not on |accel|.
//
// A finger strike is a high-frequency transient normal to the table
// (a few ms, tens of Hz). Sliding the puck, tugging its cable or picking
// it up are low-frequency and often lateral. Keying off |a| makes all of
// those look like taps; keying off high-passed az does not.
//
// TWO cascaded first-order HPFs = second order, -40 dB/decade, so slow
// handling is attenuated far harder than a single stage managed.
// y = A*(y + x - x_prev); at 500 Hz sampling:
//     A = 0.76 -> ~25 Hz     A = 0.61 -> ~50 Hz     A = 0.52 -> ~75 Hz
#define HP_ALPHA         0.61f
#define TAP_HP_THRESH    0.35f   // g of high-passed az; tune from the plot

// DURATION is the real discriminator. A finger strike crosses the
// threshold and comes back within tens of ms. A pickup can reach the same
// amplitude but never that briefly, so amplitude alone cannot separate
// them and no corner frequency will fix that -- pulse width will.
#define TAP_MIN_WIDTH_MS 1
#define TAP_MAX_WIDTH_MS 30
#define PULSE_ABORT_MS   250     // stuck above threshold => sustained motion

// Movement gate. A tap only counts while the puck is otherwise at rest,
// which is what kills false positives from being carried or nudged.
#define QUIET_ACCEL      0.08f   // slow |a| deviation from 1 g
#define QUIET_GYRO       12.0f   // slow gyro magnitude, dps
#define SETTLE_MS        250     // and it must have been quiet this long
#define TAP_REFRACTORY   100       // ignore ringing from the same strike
#define TAP_WINDOW_MS    500       // max gap between the two taps
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
  // LPF_MODE_0 is 2.66% of ODR -- at 125 Hz that is a 3.3 Hz low-pass,
  // which erases a tap transient entirely. Filter off, ODR way up, and
  // 8 g range because a knock on the case easily clips 4 g.
  qmi.configAccelerometer(SensorQMI8658::ACC_RANGE_8G,
                          SensorQMI8658::ACC_ODR_1000Hz,
                          SensorQMI8658::LPF_OFF);
  qmi.enableAccelerometer();
  qmi.configGyroscope(SensorQMI8658::GYR_RANGE_1024DPS,
                      SensorQMI8658::GYR_ODR_896_8Hz,
                      SensorQMI8658::LPF_OFF);
  qmi.enableGyroscope();
  Serial.println("[imu] QMI8658 ready");
  return true;
}

// Call every loop. Cheap: one I2C read at ~50 Hz.
inline void imuTick() {
  if (!imuOk) return;
  static uint32_t last = 0;
  uint32_t now = millis();
  if (now - last < (IMU_STREAM ? 2 : 20)) return;
  last = now;

  // Reading without checking data-ready returns stale/garbage registers,
  // which is what made the flip detector oscillate.
  if (!qmi.getDataReady()) return;
  float x, y, z, gx = 0, gy = 0, gz = 0;
  if (!qmi.getAccelerometer(x, y, z)) return;
  qmi.getGyroscope(gx, gy, gz);
  imuX = x;  imuY = y;  imuZ = z;
  imuGX = gx; imuGY = gy; imuGZ = gz;

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

  // High-pass az twice: strips gravity and slow movement, leaving only the
  // sharp transient a finger strike produces.
  static float prevZ = 0, hp1 = 0, prevHp1 = 0;
  hp1 = HP_ALPHA * (hp1 + z - prevZ);
  prevZ = z;
  imuHpZ = HP_ALPHA * (imuHpZ + hp1 - prevHp1);
  prevHp1 = hp1;

  // Slow envelopes: is the puck being handled right now?
  float gmag = sqrtf(gx*gx + gy*gy + gz*gz);
  imuSlowA = 0.98f * imuSlowA + 0.02f * fabsf(mag - 1.0f);
  imuSlowG = 0.98f * imuSlowG + 0.02f * gmag;

  static uint32_t unquietSince = 0;
  bool nowQuiet = (imuSlowA < QUIET_ACCEL) && (imuSlowG < QUIET_GYRO);
  if (!nowQuiet) unquietSince = now;
  imuQuiet = nowQuiet && (now - unquietSince > SETTLE_MS);

#if IMU_STREAM
  // Sample fast for detection, transmit slow. Emitting every sample at
  // 500 Hz is ~35 KB/s, which overruns USB CDC and BLOCKS the loop the
  // moment the host stops draining -- the board goes silent and the UI
  // freezes. Instead hold the largest-magnitude sample of each window
  // and send only that, so peaks survive at a fifth of the bandwidth.
  static float  pk = 0, pax = 0, pay = 0, paz = 0, pgx = 0, pgy = 0, pgz = 0, phz = 0;
  static uint32_t lastTx = 0;
  if (fabsf(imuHpZ) > fabsf(phz)) phz = imuHpZ;   // hold the sharpest transient
  if (mag > pk) { pk = mag; pax = x; pay = y; paz = z; pgx = gx; pgy = gy; pgz = gz; }
  if (now - lastTx >= 10) {
    lastTx = now;
    // Never block: if the CDC buffer is backed up, drop this sample.
    if (Serial.availableForWrite() > 96) {
      Serial.printf("$I,%lu,%.3f,%.3f,%.3f,%.2f,%.2f,%.2f,%.3f,%.3f,%.3f,%d\n",
                    (unsigned long)now, pax, pay, paz, pgx, pgy, pgz, pk,
                    phz, imuSlowA, (int)imuQuiet);
    }
    pk = 0; phz = 0;
  }
#endif
  // Pulse tracking: measure how long the excursion stays above threshold.
  static bool     inPulse = false;
  static uint32_t pulseStart = 0;
  static float    pulsePeak = 0;
  bool tapNow = false;
  uint32_t tapWidth = 0;

  float ahp = fabsf(imuHpZ);
  if (!inPulse) {
    if (ahp > TAP_HP_THRESH) { inPulse = true; pulseStart = now; pulsePeak = ahp; }
  } else {
    if (ahp > pulsePeak) pulsePeak = ahp;
    if (ahp < TAP_HP_THRESH * 0.3f) {                 // excursion finished
      inPulse = false;
      tapWidth = now - pulseStart;
      if (tapWidth >= TAP_MIN_WIDTH_MS && tapWidth <= TAP_MAX_WIDTH_MS) {
        tapNow = true;
      } else {
#if IMU_STREAM
        // report rejects too -- seeing WHY something was dropped is most
        // of what makes these thresholds tunable
        if (Serial.availableForWrite() > 48)
          Serial.printf("$R,%lu,%lu,%.2f,wide\n",
                        (unsigned long)now, (unsigned long)tapWidth, pulsePeak);
#endif
      }
    } else if (now - pulseStart > PULSE_ABORT_MS) {
      inPulse = false;                                 // sustained motion
#if IMU_STREAM
      if (Serial.availableForWrite() > 48)
        Serial.printf("$R,%lu,%lu,%.2f,stuck\n",
                      (unsigned long)now, (unsigned long)(now - pulseStart), pulsePeak);
#endif
    }
  }

  if (tapNow && imuQuiet && now - lastTapMs > TAP_REFRACTORY) {
    lastTapMs = now;
    if (firstTapMs && now - firstTapMs < TAP_WINDOW_MS) {
      imuDoubleTap = true;
      firstTapMs = 0;
#if IMU_STREAM
      if (Serial.availableForWrite() > 48) Serial.printf("$T,%lu,2,%lu,%.2f\n", (unsigned long)now, (unsigned long)tapWidth, pulsePeak);
#endif
    } else {
      firstTapMs = now;
#if IMU_STREAM
      if (Serial.availableForWrite() > 48) Serial.printf("$T,%lu,1,%lu,%.2f\n", (unsigned long)now, (unsigned long)tapWidth, pulsePeak);
#endif
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

// --- debug stream -----------------------------------------------------
// tools/imuplot.py renders these live so tap thresholds can be set from
// what your hand actually produces rather than from a guess.
//   $I,<ms>,<x>,<y>,<z>,<mag>     every sample
//   $T,<ms>,1                     first tap of a possible pair
//   $T,<ms>,2                     double-tap accepted
inline void imuStreamThresholds() {
  Serial.printf("$C,%.2f,%d,%d\n", TAP_HP_THRESH, TAP_REFRACTORY, TAP_WINDOW_MS);
}

// One-shot read; clears the flag.
inline bool imuTakeDoubleTap() {
  if (!imuDoubleTap) return false;
  imuDoubleTap = false;
  return true;
}
