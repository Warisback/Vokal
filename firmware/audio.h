#pragma once
// =====================================================================
//  audio.h -- ES8311 capture + playback for the meeting puck.
//
//    * 16 kHz / 16-bit mono into a PSRAM buffer
//    * capture runs in its own FreeRTOS task on core 0 so the UI never
//      stutters and we never drop samples
//    * per-chunk RMS feeds the live waveform
//    * chirps out of the speaker for eyes-free confirmation
// =====================================================================
#include "config.h"
#include <Arduino.h>
#include <Wire.h>
#include "ESP_I2S.h"

extern "C" {
  #include "es8311.h"
}

#define AUD_RATE        16000
#define AUD_I2C_NUM     0
#define PIN_I2S_MCK     16
#define PIN_I2S_BCK      9
#define PIN_I2S_DI      10
#define PIN_I2S_WS      45
#define PIN_I2S_DO       8
#define PIN_PA          46          // speaker power amp enable

#define AUD_MIC_GAIN    6           // 0-7; 3 measured too quiet on this mic
#define AUD_VOLUME     85           // 0-100

// 16 kHz * 2 bytes = 32 KB/s. 2 MB of PSRAM ~= 65 seconds.
#define AUD_BUF_BYTES   (2 * 1024 * 1024)
#define AUD_CHUNK       2048        // I2S read size (stereo frames)
#define WAVE_SLOTS      160         // waveform history for the UI

static I2SClass i2s;
static uint8_t* audBuf     = nullptr;
static volatile size_t audLen = 0;          // bytes of mono PCM captured
static volatile bool   audRecording = false;
static volatile bool   audPaused    = false;

static uint8_t  waveLvl[WAVE_SLOTS];        // 0-255 RMS, ring
static volatile uint8_t waveHead = 0;
static volatile uint16_t audPeak = 0;       // most recent RMS, for "too quiet"

// --- codec ------------------------------------------------------------
static bool audCodecInit() {
  es8311_handle_t h = es8311_create(AUD_I2C_NUM, ES8311_ADDRRES_0);
  if (!h) { Serial.println("[aud] es8311_create FAILED"); return false; }
  const es8311_clock_config_t clk = {
    .mclk_inverted = false,
    .sclk_inverted = false,
    .mclk_from_mclk_pin = true,
    .mclk_frequency = AUD_RATE * 256,
    .sample_frequency = AUD_RATE,
  };
  if (es8311_init(h, &clk, ES8311_RESOLUTION_16, ES8311_RESOLUTION_16) != ESP_OK) {
    Serial.println("[aud] es8311_init FAILED"); return false;
  }
  es8311_sample_frequency_config(h, clk.mclk_frequency, clk.sample_frequency);
  es8311_microphone_config(h, false);              // false = single-ended mic
  es8311_voice_volume_set(h, AUD_VOLUME, NULL);
  es8311_microphone_gain_set(h, (es8311_mic_gain_t)AUD_MIC_GAIN);
  return true;
}

// --- capture task -----------------------------------------------------
// The codec runs stereo slots but the mic is mono, so we keep the left
// sample of each frame. If audio comes back silent, try SLOT_RIGHT.
#define AUD_SLOT_LEFT 1

static void audTask(void*) {
  static int16_t raw[AUD_CHUNK];
  for (;;) {
    if (!audRecording || audPaused) { vTaskDelay(pdMS_TO_TICKS(20)); continue; }

    size_t got = i2s.readBytes((char*)raw, sizeof(raw));
    if (!got) { vTaskDelay(pdMS_TO_TICKS(2)); continue; }

    int frames = got / 4;                       // 2 ch * 2 bytes
    int16_t* dst = (int16_t*)(audBuf + audLen);
    size_t room = (AUD_BUF_BYTES - audLen) / 2;
    if ((size_t)frames > room) { frames = room; }
    if (frames <= 0) { audRecording = false; Serial.println("[aud] buffer full"); continue; }

    uint64_t sum = 0;
    for (int i = 0; i < frames; i++) {
      int16_t s = raw[i * 2 + (AUD_SLOT_LEFT ? 0 : 1)];
      dst[i] = s;
      sum += (int32_t)s * s;
    }
    audLen += frames * 2;

    uint32_t rms = frames ? (uint32_t)sqrt((double)(sum / frames)) : 0;
    audPeak = rms;
    uint8_t lvl = (uint8_t)(rms > 2500 ? 255 : (rms * 255) / 2500);
    waveLvl[waveHead] = lvl;
    waveHead = (waveHead + 1) % WAVE_SLOTS;
  }
}

inline bool audioBegin() {
  audBuf = (uint8_t*)heap_caps_malloc(AUD_BUF_BYTES, MALLOC_CAP_SPIRAM);
  if (!audBuf) { Serial.println("[aud] PSRAM alloc FAILED"); return false; }
  memset(waveLvl, 0, sizeof(waveLvl));

  pinMode(PIN_PA, OUTPUT);
  digitalWrite(PIN_PA, HIGH);                    // speaker amp on

  i2s.setPins(PIN_I2S_BCK, PIN_I2S_WS, PIN_I2S_DO, PIN_I2S_DI, PIN_I2S_MCK);
  if (!i2s.begin(I2S_MODE_STD, AUD_RATE, I2S_DATA_BIT_WIDTH_16BIT,
                 I2S_SLOT_MODE_STEREO, I2S_STD_SLOT_BOTH)) {
    Serial.println("[aud] i2s.begin FAILED"); return false;
  }
  if (!audCodecInit()) return false;

  // Core 0: keep capture off the UI core so neither can starve the other.
  xTaskCreatePinnedToCore(audTask, "aud", 4096, nullptr, 5, nullptr, 0);
  Serial.printf("[aud] ready, %d KB buffer (%ds)\n",
                AUD_BUF_BYTES / 1024, AUD_BUF_BYTES / (AUD_RATE * 2));
  return true;
}

inline void audioStart() { audLen = 0; audPaused = false; audRecording = true; }
inline void audioStop()  { audRecording = false; }
inline void audioPause(bool p) { audPaused = p; }
inline uint32_t audioMs() { return (audLen / 2) * 1000UL / AUD_RATE; }
inline int audioPct() { return (int)(audLen * 100 / AUD_BUF_BYTES); }

// --- speaker: eyes-free confirmation ---------------------------------
// You are looking at people in a meeting, not at the screen.
inline void audioChirp(int freq, int ms, uint8_t vol = 40) {
  int n = AUD_RATE * ms / 1000;
  int16_t* t = (int16_t*)malloc(n * 2 * sizeof(int16_t));
  if (!t) return;
  for (int i = 0; i < n; i++) {
    float env = 1.0f;                                   // fade the tail so it doesn't click
    if (i > n * 3 / 4) env = (float)(n - i) / (n / 4);
    int16_t s = (int16_t)(sinf(2.0f * PI * freq * i / AUD_RATE) * 300 * vol * env);
    t[i * 2] = s; t[i * 2 + 1] = s;
  }
  i2s.write((uint8_t*)t, n * 2 * sizeof(int16_t));
  free(t);
}
inline void chirpStart()  { audioChirp(880, 90); }
inline void chirpStop()   { audioChirp(440, 120); }
inline void chirpMark()   { audioChirp(1320, 60); }
inline void chirpErr()    { audioChirp(220, 200); }

// --- WAV ---------------------------------------------------------------
// 44-byte RIFF header written in front of the PCM so the STT API can take
// the buffer as-is.
inline void wavHeader(uint8_t* h, uint32_t pcmBytes) {
  uint32_t chunk = 36 + pcmBytes, byteRate = AUD_RATE * 2;
  memcpy(h, "RIFF", 4);            memcpy(h + 4, &chunk, 4);
  memcpy(h + 8, "WAVEfmt ", 8);
  uint32_t sub1 = 16; uint16_t fmt = 1, ch = 1, bits = 16, align = 2;
  memcpy(h + 16, &sub1, 4);        memcpy(h + 20, &fmt, 2);
  memcpy(h + 22, &ch, 2);          memcpy(h + 24, (uint32_t[]){AUD_RATE}, 4);
  memcpy(h + 28, &byteRate, 4);    memcpy(h + 32, &align, 2);
  memcpy(h + 34, &bits, 2);        memcpy(h + 36, "data", 4);
  memcpy(h + 40, &pcmBytes, 4);
}

// --- marks -------------------------------------------------------------
enum MarkType : uint8_t { MARK_IMPORTANT, MARK_DECISION, MARK_ACTION, MARK_QUESTION };
static const char* MARK_NAMES[] = { "important", "decision", "action", "question" };
static const char* MARK_GLYPH[] = { "*", "OK", "->", "?" };

struct Mark { uint32_t ms; MarkType type; };
#define MAX_MARKS 64
static Mark  marks[MAX_MARKS];
static int   markCount = 0;

inline void addMark(MarkType t) {
  if (!audRecording || markCount >= MAX_MARKS) { chirpErr(); return; }
  marks[markCount++] = { audioMs(), t };
  chirpMark();
  Serial.printf("[mark] %s @ %lums\n", MARK_NAMES[t], (unsigned long)marks[markCount-1].ms);
}
