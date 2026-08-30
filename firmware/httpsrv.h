#pragma once
// =====================================================================
//  httpsrv.h -- the puck is its own access point and HTTP server.
//
//  The laptop joins the puck's wifi and PULLS the recording. Nothing
//  external is involved: no venue wifi, no hotspot, no captive portal,
//  no internet. Only viable because STT runs locally on the host.
//
//  The puck is always 192.168.4.1.
//
//    GET  /status       {"take":3,"started":"...","ms":12345,"bytes":...}
//                       poll this; `take` increments on every new recording
//    GET  /audio.wav    16 kHz mono 16-bit WAV of the last recording
//    GET  /marks.json   {"marks":[{"ms":4120,"type":"action"},...]}
//    POST /transcript   body = the text; shown on the puck's review screen
//    POST /time         body = "YYYY-MM-DDTHH:MM:SS"; sets the RTC.
//                       There is no internet on this AP, so the host is
//                       the only possible clock source.
//
//  Test with nothing but curl:
//    curl http://192.168.4.1/status
//    curl -o take.wav http://192.168.4.1/audio.wav
//    curl -X POST --data-binary @notes.txt http://192.168.4.1/transcript
// =====================================================================
#include "config.h"
#include "audio.h"
#include <WiFi.h>
#include <WebServer.h>

static WebServer srv(80);
static bool   apUp = false;
static String transcript = "";
static uint32_t lastPullMs = 0;      // when the host last fetched audio

inline void srvStatus() {
  char j[256];
  snprintf(j, sizeof(j),
    "{\"take\":%lu,\"started\":\"%s\",\"recording\":%d,\"paused\":%d,"
    "\"ms\":%lu,\"bytes\":%lu,\"marks\":%d,"
    "\"rate\":%d,\"channels\":1,\"bits\":16,\"pulled\":%lu}",
    (unsigned long)takeId, takeStarted,
    (int)audRecording, (int)audPaused, (unsigned long)audioMs(),
    (unsigned long)audLen, markCount, AUD_RATE, (unsigned long)lastPullMs);
  srv.send(200, "application/json", j);
}

// Streamed straight out of PSRAM in chunks -- a 60 s take is ~1.9 MB and
// will not fit anywhere else.
inline void srvAudio() {
  size_t n = audLen;
  if (!n) { srv.send(404, "text/plain", "no recording"); return; }
  uint8_t hdr[44];
  wavHeader(hdr, n);

  srv.setContentLength(44 + n);
  srv.send(200, "audio/wav", "");
  WiFiClient c = srv.client();
  c.write(hdr, sizeof(hdr));

  const size_t CH = 4096;
  for (size_t off = 0; off < n && c.connected(); off += CH) {
    size_t len = (n - off) < CH ? (n - off) : CH;
    if (c.write(audBuf + off, len) != len) break;
  }
  lastPullMs = millis();
  Serial.printf("[srv] served %lu bytes\n", (unsigned long)(44 + n));
}

inline void srvMarks() {
  String j = "{\"marks\":[";
  for (int i = 0; i < markCount; i++) {
    if (i) j += ",";
    j += "{\"ms\":" + String(marks[i].ms) +
         ",\"type\":\"" + String(MARK_NAMES[marks[i].type]) + "\"}";
  }
  j += "],\"take\":" + String(takeId) +
       ",\"duration_ms\":" + String(audioMs()) + "}";
  srv.send(200, "application/json", j);
}

// The host posts the finished transcript back so the puck can show it.
inline void srvTranscript() {
  transcript = srv.arg("plain");
  Serial.printf("[srv] transcript %u chars\n", transcript.length());
  srv.send(200, "application/json", "{\"ok\":true}");
}

// The host sets the clock: "YYYY-MM-DDTHH:MM:SS"
inline void srvTime() {
  String s = srv.arg("plain");
  int Y, M, D, h, m, sec;
  if (sscanf(s.c_str(), "%d-%d-%dT%d:%d:%d", &Y, &M, &D, &h, &m, &sec) == 6) {
    rtc.setDateTime(RTC_DateTime(Y, M, D, h, m, sec));
    Serial.printf("[srv] rtc set to %s\n", s.c_str());
    srv.send(200, "application/json", "{\"ok\":true}");
  } else {
    srv.send(400, "application/json", "{\"error\":\"want YYYY-MM-DDTHH:MM:SS\"}");
  }
}

inline void srvBegin() {
  WiFi.mode(WIFI_AP);
  // Channel 1, max 4 clients. Explicit channel avoids a scan at boot.
  if (!WiFi.softAP(AP_SSID, AP_PASS, 1, 0, 4)) {
    Serial.println("[srv] softAP FAILED");
    return;
  }
  apUp = true;
  srv.on("/status",     HTTP_GET,  srvStatus);
  srv.on("/audio.wav",  HTTP_GET,  srvAudio);
  srv.on("/marks.json", HTTP_GET,  srvMarks);
  srv.on("/transcript", HTTP_POST, srvTranscript);
  srv.on("/time",       HTTP_POST, srvTime);
  srv.onNotFound([]() { srv.send(404, "text/plain", "no"); });
  srv.begin();
  Serial.printf("[srv] AP \"%s\" up at %s\n",
                AP_SSID, WiFi.softAPIP().toString().c_str());
}

// Cheap when idle; only the /audio.wav transfer takes real time.
inline void srvTick() { if (apUp) srv.handleClient(); }

inline int srvClients() { return apUp ? WiFi.softAPgetStationNum() : 0; }
