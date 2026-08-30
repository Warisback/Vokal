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
// Raw-body POST -- how an utterance gets off the board.
//
// httpPostJson cannot do this job at all. It hardcodes application/json,
// and it takes a `const String&`: an Arduino String lives in INTERNAL heap,
// of which this chip has ~300 KB total, and one 3-second utterance is
// ~96 KB with a 65-second buffer able to reach 2 MB. Copying PSRAM into a
// String to post it would fail outright.
//
// HTTPClient already has POST(uint8_t*, size_t) and streams the payload out
// in chunks, so we hand it the PSRAM pointer and it never materialises a
// second copy anywhere.
//
// `extra` carries the headers PROTOCOL.md requires on /utterance
// (X-Sample-Rate, X-Utterance-Id). A little array beats varargs: the call
// site then shows exactly what went on the wire.
// ---------------------------------------------------------------------
struct HttpHeader { const char* name; const char* value; };

inline int httpPostRaw(const char* url, const uint8_t* body, size_t len,
                       const char* contentType, String& out,
                       const HttpHeader* extra = nullptr, int extraCount = 0) {
  if (netState != NET_ONLINE) { out = "offline"; return -1; }
  HTTPClient http;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setConnectTimeout(HTTP_TIMEOUT_MS);

  bool ok;
  WiFiClientSecure tls;
  if (strncmp(url, "https", 5) == 0) { tls.setInsecure(); ok = http.begin(tls, url); }
  else                               { ok = http.begin(url); }
  if (!ok) { out = "begin failed"; return -1; }

  http.addHeader("Content-Type", contentType);
  for (int i = 0; i < extraCount; i++) http.addHeader(extra[i].name, extra[i].value);

  // The upload is the one stage of PROTOCOL.md's latency budget the board
  // can measure by itself, and it is the stage most likely to blow it on
  // venue wifi. Time it every single time, and print the throughput too --
  // "600 ms" alone does not tell you whether the network or the size is
  // the problem. (bytes/ms is within 2.4% of KB/s; close enough to read.)
  uint32_t t0 = millis();
  int code = http.POST((uint8_t*)body, len);
  uint32_t ms = millis() - t0;

  out = (code > 0) ? http.getString() : http.errorToString(code);
  Serial.printf("[http] POST %s %u B -> %d in %lums (~%lu KB/s)\n",
                url, (unsigned)len, code, (unsigned long)ms,
                (unsigned long)(ms ? (len / ms) : 0));
  http.end();
  return code;
}

// ---------------------------------------------------------------------
// Small-response GET, for a body that is polled.
//
// Two things it does that httpGet does not:
//
//  * its own SHORT timeout. HTTP_TIMEOUT_MS is 8 s because that is what a
//    480 KB upload can need. Reusing it here means that the moment the
//    laptop goes away, every poll parks the UI core in lwIP for 8 seconds
//    and the device looks dead on stage. PROTOCOL.md promises /state
//    answers in under 50 ms, so anything past ~1 s is already a failure
//    and waiting longer buys nothing.
//
//  * no per-call log line. /state is polled three times a second; those
//    logs would bury the once-per-utterance timings we actually read.
//    Failures still print, because a silent failure is worse than noise.
//
// Plain http only -- these are our own laptop's endpoints and PROTOCOL.md
// says no TLS. An https URL here just fails begin().
// ---------------------------------------------------------------------
inline int httpGetSmall(const char* url, String& out,
                        uint32_t timeoutMs = 1200, size_t maxBytes = 1024) {
  if (netState != NET_ONLINE) { out = "offline"; return -1; }
  HTTPClient http;
  http.setTimeout(timeoutMs);
  http.setConnectTimeout(timeoutMs);
  if (!http.begin(url)) { out = "begin failed"; return -1; }

  int code = http.GET();
  if (code > 0) {
    out = http.getString();
    // Truncate rather than trust. getString() allocates in internal heap,
    // this runs for the whole demo, and a runaway body must not be able to
    // walk us into an OOM ninety seconds before we go on.
    if (out.length() > maxBytes) out.remove(maxBytes);
  } else {
    out = http.errorToString(code);
    Serial.printf("[http] GET %s -> %d %s\n", url, code, out.c_str());
  }
  http.end();
  return code;
}

// ---------------------------------------------------------------------
// Just enough JSON to read /state and /health.
//
// THIS IS NOT A PARSER, and saying so is the point. It is a substring
// search that happens to be correct for one exact shape: the flat,
// five-field object PROTOCOL.md specifies, generated by a server we also
// write -- no nesting, no arrays, no unicode escapes, no duplicate keys.
// It is a deliberate shortcut. ArduinoJson would be right, but it is not
// installed, setup.sh does not fetch it, and a new dependency on the
// morning of a demo costs more than twenty lines do.
//
// The failure mode is the ugly one: if /state ever grows a nested object,
// a key from inside it can match here and this returns quiet nonsense
// instead of an error. So /state's shape and these functions change
// together, or neither changes.
// ---------------------------------------------------------------------

// Index of the first byte of the value for `key`, or -1.
inline int jsonFind(const String& src, const char* key) {
  String pat = String("\"") + key + "\"";
  int k = src.indexOf(pat);
  if (k < 0) return -1;
  int c = k + pat.length();
  while (c < (int)src.length() && (src[c] == ' ' || src[c] == '\t')) c++;
  if (c >= (int)src.length() || src[c] != ':') return -1;   // a value, not a key
  c++;
  while (c < (int)src.length() && (src[c] == ' ' || src[c] == '\t')) c++;
  return c;
}

inline bool jsonStr(const String& src, const char* key, String& out) {
  int i = jsonFind(src, key);
  if (i < 0 || src[i] != '"') return false;      // missing, or not a string
  i++;
  String v = "";
  while (i < (int)src.length() && src[i] != '"') {
    if (src[i] == '\\' && i + 1 < (int)src.length()) {
      char c = src[++i];
      // Captions are painted with the built-in 6x8 font, which has no
      // concept of a newline -- it would draw a glyph for one and shove
      // the rest of the line out of its datum box. Whitespace escapes
      // become spaces; \" and \\ pass through as themselves.
      v += (c == 'n' || c == 't' || c == 'r') ? ' ' : c;
    } else {
      v += src[i];
    }
    i++;
  }
  out = v;
  return true;
}

inline long jsonInt(const String& src, const char* key, long def) {
  int i = jsonFind(src, key);
  if (i < 0) return def;
  bool neg = (src[i] == '-');
  if (neg) i++;
  if (src[i] < '0' || src[i] > '9') return def;   // null, "", or absent
  long v = 0;
  while (i < (int)src.length() && src[i] >= '0' && src[i] <= '9') {
    v = v * 10 + (src[i] - '0');
    i++;
  }
  return neg ? -v : v;
}

// /health is nothing but booleans.
inline bool jsonBool(const String& src, const char* key, bool def) {
  int i = jsonFind(src, key);
  if (i < 0) return def;
  if (src[i] == 't') return true;     // "true"  -- the first byte decides it
  if (src[i] == 'f') return false;    // "false"
  return def;
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
