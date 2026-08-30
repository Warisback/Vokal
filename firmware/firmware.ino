// =====================================================================
//  Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2) -- two apps, one board.
//
//  APP_VOKAL 1 (config.h) -> Vokal: a voice for people who have lost
//    theirs. Hold the pad, whisper, release; the laptop speaks the
//    sentence out loud in a local Piper voice. See PROTOCOL.md.
//  APP_VOKAL 0 -> the meeting puck: captures a conversation and lets a
//    human mark what mattered as it happens. Unchanged, still builds.
//
//  Both UI heads export the same three symbols -- uiSplash(const char*),
//  uiBegin(), uiTick() -- so nothing below this include block cares which
//  one was compiled in.
//
//  Boot order: serial -> panel -> audio -> imu -> wifi.
// =====================================================================
#include "config.h"
#include <WiFi.h>
#include "display.h"
// net.h MUST come after display.h: netStateColor() uses C_OK / C_WARN /
// C_ERR / C_MUTED, and net.h itself only includes config.h.
#include "net.h"
#include "audio.h"
#include "imu.h"
#if APP_VOKAL
#include "ui_vokal.h"
#else
#include "ui_puck.h"
#endif

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

#if APP_VOKAL
  // The radio was never brought up by the puck build -- it was not that
  // something turned it off, there was simply nothing that turned it on.
  // Vokal is useless without it, so this is where it happens.
  //
  // Guarded, because netConnect() BLOCKS: WIFI_CONNECT_TIMEOUT_MS per
  // network in WIFI_NETWORKS, ~24 s of frozen board for two of them. That
  // is why it lives in setup() and must never be called from a button
  // handler -- and why the puck, which never uses the radio, does not pay
  // for it. uiSplash's signature is void(const char*), which is precisely
  // netConnect's progress callback, so the user watches each SSID being
  // tried instead of staring at a dead panel wondering.
  netConnect(uiSplash);
#endif

  uiBegin();
  Serial.println("[main] ready");
}

void loop() {
  uiTick();
  // A WiFi.status() check every 5 s and nothing else -- and an immediate
  // no-op unless netState is NET_ONLINE, so the puck build, which never
  // connects, pays one comparison per loop for it.
  netTick();

  // Heartbeat: the S3's native USB re-enumerates on reset, so a boot-only
  // banner is easy to miss. This prints regardless of when you attach.
  static uint32_t hb = 0;
  if (millis() - hb > (IMU_STREAM ? 5000 : 2000)) {
    hb = millis();
#if APP_VOKAL
    Serial.printf("[hb] vk=%s net=%s ip=%s rec=%d idle=%d pcm=%luKB peak=%u utt=%lu | imu=%d z=%.2f down=%d\n",
                  vkStateName(), netStateName(), netIp.toString().c_str(),
                  (int)audRecording, (int)audIdle,
                  (unsigned long)(audLen/1024), (unsigned)audPeak,
                  (unsigned long)vkUttId,
                  (int)imuOk, imuZ, (int)imuFaceDown);
#else
    Serial.printf("[hb] state=%d rec=%d paused=%d pcm=%luKB peak=%u marks=%d | imu=%d z=%.2f down=%d orient=%d\n",
                  (int)pstate, (int)audRecording, (int)audPaused,
                  (unsigned long)(audLen/1024), (unsigned)audPeak, markCount,
                  (int)imuOk, imuZ, (int)imuFaceDown, (int)imuOrientStable);
#endif
    Serial.printf("[hb] touch samples=%lu hits=%lu last=(%d,%d)\n",
                  (unsigned long)touchSamples, (unsigned long)touchHits, touchX, touchY);
  }
  delay(5);
}
