// =====================================================================
//  Meeting puck -- Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2)
//
//  Captures a conversation, lets a human mark what mattered as it
//  happens, and turns the result into structured notes.
//
//  Boot order: serial -> panel -> audio -> imu.
// =====================================================================
#include "config.h"
#include <WiFi.h>
#include "display.h"
#include "audio.h"
#include "imu.h"
#include "ui_puck.h"

static void printChipInfo() {
  Serial.println("\n================ BOARD ================");
  Serial.printf("chip      : %s rev %d\n", ESP.getChipModel(), ESP.getChipRevision());
  Serial.printf("flash     : %u MB\n", (unsigned)(ESP.getFlashChipSize()/(1024*1024)));
  Serial.printf("psram     : %u KB free\n", (unsigned)(ESP.getFreePsram()/1024));
  Serial.printf("heap      : %u KB free\n", (unsigned)(ESP.getFreeHeap()/1024));
  Serial.println("=======================================");
}

void setup() {
  Serial.begin(115200);
  delay(400);
  printChipInfo();

  displayBegin();
  uiSplash("starting audio...");

  if (!audioBegin()) uiSplash("AUDIO FAILED - check serial");
  imuBegin();
#if IMU_STREAM
  imuStreamThresholds();
#endif

  uiBegin();
  Serial.println("[main] ready");
}

void loop() {
  uiTick();

  // Heartbeat: the S3's native USB re-enumerates on reset, so a boot-only
  // banner is easy to miss. This prints regardless of when you attach.
  static uint32_t hb = 0;
  if (millis() - hb > (IMU_STREAM ? 5000 : 2000)) {
    hb = millis();
    Serial.printf("[hb] state=%d rec=%d paused=%d pcm=%luKB peak=%u marks=%d | imu=%d z=%.2f down=%d orient=%d\n",
                  (int)pstate, (int)audRecording, (int)audPaused,
                  (unsigned long)(audLen/1024), (unsigned)audPeak, markCount,
                  (int)imuOk, imuZ, (int)imuFaceDown, (int)imuOrientStable);
    Serial.printf("[hb] touch samples=%lu hits=%lu last=(%d,%d)\n",
                  (unsigned long)touchSamples, (unsigned long)touchHits, touchX, touchY);
  }
  delay(5);
}
