#pragma once
// =====================================================================
//  display.h -- Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2)
//
//  CO5300 AMOLED 368x448 over QSPI + CST816/CST820 capacitive touch,
//  driven by the vendor's Arduino_GFX / Arduino_DriveBus libraries
//  (proven on this exact board; LovyanGFX's QSPI path is not).
//
//  `tft` is a thin shim exposing the LovyanGFX-shaped calls the UI uses,
//  so ui_kit.h / ui_tracker.h did not have to be rewritten.
// =====================================================================
#include "config.h"
#include <Arduino.h>
#include <Wire.h>
#include "Arduino_GFX_Library.h"
#include "Arduino_DriveBus_Library.h"

// ---- pins (from the vendor's pin_config.h for the V2 board) ----------
#define LCD_SDIO0  4
#define LCD_SDIO1  5
#define LCD_SDIO2  6
#define LCD_SDIO3  7
#define LCD_SCLK  11
#define LCD_CS    12
#define LCD_W    368
#define LCD_H    448
#define IIC_SDA   15
#define IIC_SCL   14
#define TP_INT    21

static Arduino_DataBus* lcdBus = new Arduino_ESP32QSPI(
    LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);
static Arduino_CO5300*  panel = new Arduino_CO5300(
    lcdBus, GFX_NOT_DEFINED /*RST*/, 0 /*rotation*/, LCD_W, LCD_H, 16, 0, 0, 0);
// Full-screen framebuffer in PSRAM (368*448*2 = 322KB, far past internal
// RAM). Every frame is composed off-screen and blitted in one flush, so
// clearing and redrawing never shows as a flash.
static Arduino_Canvas*  gfx = new Arduino_Canvas(LCD_W, LCD_H, panel, 0, 0);

static std::shared_ptr<Arduino_IIC_DriveBus> iicBus =
    std::make_shared<Arduino_HWIIC>(IIC_SDA, IIC_SCL, &Wire);
static void touchISR(void);
static std::unique_ptr<Arduino_IIC> touchDev(
    new Arduino_CST816x(iicBus, CST816T_DEVICE_ADDRESS,
                        DRIVEBUS_DEFAULT_VALUE, TP_INT, touchISR));
static volatile bool touchIrq = false;
static uint32_t tchReads = 0, tchFingers = 0, tchBadCoord = 0;
static volatile uint16_t tchX = 0, tchY = 0;
static volatile uint32_t tchHoldMs = 0;
static void touchISR(void) { touchIrq = true; }

// ---- colours ---------------------------------------------------------
#define RGB565(r,g,b) ((uint16_t)((((r)&0xF8)<<8)|(((g)&0xFC)<<3)|((b)>>3)))
static const uint16_t C_BG     = RGB565(  0,  0,  0);   // AMOLED: true black is free
static const uint16_t C_PANEL  = RGB565( 26, 32, 46);
static const uint16_t C_TEXT   = RGB565(236,240,248);
static const uint16_t C_MUTED  = RGB565(130,140,160);
static const uint16_t C_ACCENT = RGB565( 74,160,255);
static const uint16_t C_OK     = RGB565( 64,200,128);
static const uint16_t C_WARN   = RGB565(245,180, 60);
static const uint16_t C_ERR    = RGB565(245, 86, 86);

static int SCR_W = LCD_W;
static int SCR_H = LCD_H;
// 368x448 on a 1.8" panel is ~300dpi: the 6x8 base font is unreadable at
// 1x. Everything in the UI scales off this.
static int UI_S = 2;

// ---- LovyanGFX-shaped shim ------------------------------------------
enum class textdatum_t : uint8_t {
  top_left, top_center, top_right, middle_left, middle_center, middle_right
};

struct TftShim {
  uint16_t fg = 0xFFFF, bg = 0;
  bool     hasBg = false;
  uint8_t  tsize = 1;
  textdatum_t datum = textdatum_t::top_left;

  int16_t width()  { return gfx->width();  }
  int16_t height() { return gfx->height(); }

  void fillScreen(uint16_t c)                       { gfx->fillScreen(c); }
  void fillRect(int x,int y,int w,int h,uint16_t c)  { gfx->fillRect(x,y,w,h,c); }
  void drawRect(int x,int y,int w,int h,uint16_t c)  { gfx->drawRect(x,y,w,h,c); }
  void fillRoundRect(int x,int y,int w,int h,int r,uint16_t c){ gfx->fillRoundRect(x,y,w,h,r,c); }
  void drawRoundRect(int x,int y,int w,int h,int r,uint16_t c){ gfx->drawRoundRect(x,y,w,h,r,c); }
  void drawLine(int x0,int y0,int x1,int y1,uint16_t c){ gfx->drawLine(x0,y0,x1,y1,c); }
  void drawPixel(int x,int y,uint16_t c)             { gfx->drawPixel(x,y,c); }
  void fillCircle(int x,int y,int r,uint16_t c)      { gfx->fillCircle(x,y,r,c); }
  void drawFastHLine(int x,int y,int w,uint16_t c)   { gfx->drawFastHLine(x,y,w,c); }
  void setBrightness(uint8_t b)                      { panel->setBrightness(b); }
  void flush()                                       { gfx->flush(); }

  void setTextColor(uint16_t f)            { fg=f; hasBg=false; }
  void setTextColor(uint16_t f,uint16_t b) { fg=f; bg=b; hasBg=true; }
  void setTextSize(uint8_t s)              { tsize=s; }
  void setTextDatum(textdatum_t d)         { datum=d; }

  // Built-in 5x7 font advances 6x8 per glyph -- exact, no bounds call.
  void drawString(const char* s, int x, int y) {
    uint8_t sc = tsize ? tsize : 1;
    int w = (int)strlen(s) * 6 * sc, h = 8 * sc;
    int px = x, py = y;
    switch (datum) {
      case textdatum_t::top_center:    px = x - w/2;             break;
      case textdatum_t::top_right:     px = x - w;               break;
      case textdatum_t::middle_left:   py = y - h/2;             break;
      case textdatum_t::middle_center: px = x - w/2; py = y-h/2; break;
      case textdatum_t::middle_right:  px = x - w;   py = y-h/2; break;
      default: break;
    }
    if (hasBg) { gfx->setTextColor(fg, bg); gfx->fillRect(px,py,w,h,bg); }
    else       { gfx->setTextColor(fg); }
    gfx->setTextSize(sc);
    gfx->setCursor(px, py);
    gfx->print(s);
  }
  void drawString(const String& s, int x, int y) { drawString(s.c_str(), x, y); }

  // The CST816 asserts TP_INT on touch activity. Polling its registers
  // blind competes with the IMU on the same I2C bus and mostly returns
  // "no finger", so read only when the interrupt says there is something
  // to read, and hold the contact briefly so a press is not missed
  // between UI frames.
  bool getTouch(uint16_t* x, uint16_t* y) {
    if (tchHoldMs && millis() - tchHoldMs < 80) { *x = tchX; *y = tchY; return true; }
    return false;
  }
  bool touch() { return true; }
};
static TftShim tft;

// Runs on the sensor task, never on the render core: a full paint blocks
// for ~65 ms, and polling touch from that same loop left the device blind
// to presses for most of every frame.
inline void touchPoll() {
  {
    static uint32_t lastPollMs = 0;
    // Read on interrupt, but also poll as a backstop: if the controller's
    // periodic interrupt fails to re-arm, presses vanish entirely.
    bool doRead = touchIrq || (millis() - lastPollMs > 10);
    if (doRead) {
      touchIrq = false;
      lastPollMs = millis();
      tchReads++;
      int32_t n = touchDev->IIC_Read_Device_Value(
            touchDev->Arduino_IIC_Touch::Value_Information::TOUCH_FINGER_NUMBER);
      if (n > 0) {
        tchFingers++;
        int32_t tx = touchDev->IIC_Read_Device_Value(
              touchDev->Arduino_IIC_Touch::Value_Information::TOUCH_COORDINATE_X);
        int32_t ty = touchDev->IIC_Read_Device_Value(
              touchDev->Arduino_IIC_Touch::Value_Information::TOUCH_COORDINATE_Y);
        if (tx >= 0 && ty >= 0) {
          tchX = (uint16_t)tx; tchY = (uint16_t)ty; tchHoldMs = millis();
#if TOUCH_DEBUG
          if (Serial.availableForWrite() > 40)
            Serial.printf("[touch] n=%ld raw=%ld,%ld\n", (long)n, (long)tx, (long)ty);
#endif
        } else {
          tchBadCoord++;
#if TOUCH_DEBUG
          if (Serial.availableForWrite() > 40)
            Serial.printf("[touch] n=%ld BAD COORDS %ld,%ld\n", (long)n, (long)tx, (long)ty);
#endif
        }
      }
    }
  }
}

inline void displayBegin() {
  Wire.begin(IIC_SDA, IIC_SCL);
  if (!gfx->begin(80000000)) {
    Serial.println("[disp] canvas begin FAILED - no PSRAM? check PSRAM=opi in the FQBN");
  }
  gfx->fillScreen(C_BG);
  gfx->flush();
  panel->setBrightness(BACKLIGHT_LEVEL);
  Serial.printf("[disp] psram free %u KB\n", (unsigned)(ESP.getFreePsram()/1024));

  int tries = 0;
  while (!touchDev->begin() && ++tries < 10) { Serial.println("[disp] touch retry"); delay(200); }
  if (tries >= 10) Serial.println("[disp] !! CST816 not responding -- check I2C 15/14");
  else touchDev->IIC_Write_Device_State(
         touchDev->Arduino_IIC_Touch::Device::TOUCH_DEVICE_INTERRUPT_MODE,
         touchDev->Arduino_IIC_Touch::Device_Mode::TOUCH_DEVICE_INTERRUPT_PERIODIC);

  SCR_W = gfx->width();
  SCR_H = gfx->height();
  UI_S  = (SCR_W >= 320) ? 2 : 1;
  Serial.printf("[disp] %dx%d scale=%d touch=%s\n",
                SCR_W, SCR_H, UI_S, tries < 10 ? "ok" : "FAILED");
}

// Capacitive panels are factory-aligned; nothing to calibrate.
inline void displayCalibrateTouch() {
  Serial.println("[disp] capacitive touch - no calibration needed");
}
