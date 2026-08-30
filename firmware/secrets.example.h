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

// --- the Vokal laptop -------------------------------------------------
// The laptop's LAN IP on whatever network you both just joined, as a
// STRING -- config.h pastes it straight into a URL literal.
// It is in here rather than config.h because a hotspot hands out a new
// lease every time it is switched on, so this is the field you will be
// editing thirty seconds before you go on stage.
//
// Find it on the laptop:
//    macOS/Linux   ipconfig getifaddr en0   /   hostname -I
//    Windows       ipconfig  -> IPv4 Address of the Wi-Fi adapter
// Sanity check from any browser on the same network before you flash:
//    http://<that IP>:8000/health
//
// NOT localhost, NOT 127.0.0.1 -- from the board those mean the board.
#define VOKAL_HOST  "192.168.1.100"

// Optional. config.h defaults this to 8000, which is what PROTOCOL.md
// says the server binds; only set it if you moved the server.
// #define VOKAL_PORT  8000

// --- speech to text ---------------------------------------------------
// VESTIGIAL. No compiled file reads any of these three. Vokal does STT on
// the laptop (faster-whisper, local) and the board never holds an API key
// -- it posts raw PCM to VOKAL_HOST and that is the whole of its secret
// life. Left here for the meeting-puck build, which may still grow into
// them. If you fill them in, they are a real key in a real file: keep
// secrets.h gitignored.
#define STT_URL      "https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true"
#define STT_AUTH_HDR "Authorization"
#define STT_AUTH_VAL "Token YOUR_DEEPGRAM_KEY"

// --- structuring (transcript -> notes) --------------------------------
// VESTIGIAL, same as above. Vokal itself needs NO key of any kind: speech
// to text and text to speech both run locally on the laptop.
#define LLM_API_KEY  "YOUR_KEY_HERE"
