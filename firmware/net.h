#pragma once
// =====================================================================
//  net.h -- wifi with fallbacks, HTTP(S), and a wifi scan for the
//  "handheld scanner" demo. Never blocks the UI loop once connected.
// =====================================================================
#include "config.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

enum NetState { NET_IDLE, NET_CONNECTING, NET_ONLINE, NET_AP_MODE, NET_FAILED };

static NetState  netState = NET_IDLE;
static String    netSsid  = "";
static IPAddress netIp;

inline const char* netStateName() {
  switch (netState) {
    case NET_IDLE:       return "idle";
    case NET_CONNECTING: return "connecting";
    case NET_ONLINE:     return "online";
    case NET_AP_MODE:    return "AP mode";
    default:             return "failed";
  }
}
inline uint16_t netStateColor() {
  return netState == NET_ONLINE  ? C_OK
       : netState == NET_AP_MODE ? C_WARN
       : netState == NET_FAILED  ? C_ERR : C_MUTED;
}

// Tries each network in WIFI_NETWORKS, then falls back to being an AP.
// `progress` is called with a human-readable status so you can paint it.
inline bool netConnect(void (*progress)(const char*) = nullptr) {
  const int count = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);          // sleep adds latency and drops packets

  for (int i = 0; i < count; i++) {
    netState = NET_CONNECTING;
    char msg[96];
    snprintf(msg, sizeof(msg), "Joining %s ...", WIFI_NETWORKS[i].ssid);
    Serial.printf("[net] %s\n", msg);
    if (progress) progress(msg);

    WiFi.begin(WIFI_NETWORKS[i].ssid, WIFI_NETWORKS[i].pass);
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED &&
           millis() - start < WIFI_CONNECT_TIMEOUT_MS) {
      delay(200);
    }
    if (WiFi.status() == WL_CONNECTED) {
      netState = NET_ONLINE;
      netSsid  = WIFI_NETWORKS[i].ssid;
      netIp    = WiFi.localIP();
      Serial.printf("[net] online as %s\n", netIp.toString().c_str());
      if (progress) progress("Online");
      return true;
    }
    WiFi.disconnect(true);
    delay(100);
  }

  // Everything failed. Come up as an AP so the demo still has a story.
  Serial.println("[net] all networks failed -> AP fallback");
  if (progress) progress("No wifi - starting AP");
  WiFi.mode(WIFI_AP);
  if (WiFi.softAP(AP_FALLBACK_SSID, AP_FALLBACK_PASS)) {
    netState = NET_AP_MODE;
    netSsid  = AP_FALLBACK_SSID;
    netIp    = WiFi.softAPIP();
    return false;
  }
  netState = NET_FAILED;
  return false;
}

// Call from loop(). Reconnects if the link drops mid-demo.
inline void netTick() {
  static uint32_t last = 0;
  if (netState != NET_ONLINE) return;
  if (millis() - last < 5000) return;
  last = millis();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[net] link lost, reconnecting");
    netState = NET_CONNECTING;
    WiFi.reconnect();
  }
}

// ---------------------------------------------------------------------
// HTTP. setInsecure() skips certificate validation -- fine for a six-hour
// demo, not fine for anything that ships. Pin a root CA if it matters.
// ---------------------------------------------------------------------
inline int httpGet(const char* url, String& out) {
  if (netState != NET_ONLINE) { out = "offline"; return -1; }
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  bool ok;
  WiFiClientSecure tls;
  if (strncmp(url, "https", 5) == 0) { tls.setInsecure(); ok = http.begin(tls, url); }
  else                               { ok = http.begin(url); }
  if (!ok) { out = "begin failed"; return -1; }

  int code = http.GET();
  out = (code > 0) ? http.getString() : http.errorToString(code);
  Serial.printf("[http] GET %s -> %d (%d bytes)\n", url, code, out.length());
  http.end();
  return code;
}

inline int httpPostJson(const char* url, const String& body, String& out) {
  if (netState != NET_ONLINE) { out = "offline"; return -1; }
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  bool ok;
  WiFiClientSecure tls;
  if (strncmp(url, "https", 5) == 0) { tls.setInsecure(); ok = http.begin(tls, url); }
  else                               { ok = http.begin(url); }
  if (!ok) { out = "begin failed"; return -1; }

  http.addHeader("Content-Type", "application/json");
  int code = http.POST(body);
  out = (code > 0) ? http.getString() : http.errorToString(code);
  Serial.printf("[http] POST %s -> %d\n", url, code);
  http.end();
  return code;
}

// ---------------------------------------------------------------------
// Wifi scan -- the backbone of the "handheld scanner" demo, and a useful
// diagnostic when a network refuses to appear (if it is not in this list,
// it is 5GHz and the ESP32 will never see it).
// ---------------------------------------------------------------------
struct ScanRow { String ssid; int rssi; bool open; };
static ScanRow scanRows[16];
static int     scanCount = 0;

inline void netScan() {
  Serial.println("[net] scanning...");
  int n = WiFi.scanNetworks(false, true);   // blocking, include hidden
  scanCount = 0;
  for (int i = 0; i < n && scanCount < 16; i++) {
    scanRows[scanCount].ssid = WiFi.SSID(i);
    if (scanRows[scanCount].ssid.length() == 0) scanRows[scanCount].ssid = "<hidden>";
    scanRows[scanCount].rssi = WiFi.RSSI(i);
    scanRows[scanCount].open = (WiFi.encryptionType(i) == WIFI_AUTH_OPEN);
    scanCount++;
  }
  WiFi.scanDelete();
  Serial.printf("[net] %d networks (2.4GHz only)\n", scanCount);
}
