#pragma once
// =====================================================================
//  Copy this file to secrets.h and fill it in. secrets.h is gitignored.
//    cp firmware/secrets.example.h firmware/secrets.h
// =====================================================================

// --- wifi -------------------------------------------------------------
// Tried in order. Put a PHONE HOTSPOT first: venue wifi is usually a
// captive portal the ESP32 cannot log into. iPhone users must enable
// "Maximize Compatibility" -- the ESP32 is 2.4 GHz only.
struct WifiCred { const char* ssid; const char* pass; };
static const WifiCred WIFI_NETWORKS[] = {
  { "YOUR_HOTSPOT", "hotspotpassword" },
  { "YOUR_HOME",    "homepassword"    },
};

// --- speech to text ---------------------------------------------------
#define STT_URL      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true"
#define STT_AUTH_HDR "Authorization"
#define STT_AUTH_VAL "Token YOUR_DEEPGRAM_KEY"

// --- structuring (transcript -> notes) --------------------------------
#define LLM_API_KEY  "YOUR_KEY_HERE"
