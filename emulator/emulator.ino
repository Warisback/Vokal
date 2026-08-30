// =====================================================================
//  emulator.ino -- flash this to a SECOND ESP32.
//
//  Advertises a payload shaped like an Apple Find My "separated from
//  owner" beacon so you have something to detect and, more importantly,
//  something you CONTROL: hide it, move it, switch it off on cue.
//  Do not rely on a stranger's keys being in the room at demo time.
//
//  Press BOOT (GPIO0) to toggle advertising on/off.
// =====================================================================
#include <NimBLEDevice.h>

#define BTN_PIN 0

static NimBLEAdvertising* adv = nullptr;
static bool advertising = false;

// 4C 00 = Apple, 12 = Find My offline finding, 19 = 25 byte payload,
// then a status byte and a stand-in for the rotating public key.
static uint8_t payload[] = {
  0x4C, 0x00, 0x12, 0x19,
  0x10,                                            // status (battery bits)
  0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x11, 0x22, 0x33,  // fake key material
  0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xAA, 0xBB,
  0xCC, 0xDD, 0xEE, 0xFF, 0x01, 0x02, 0x03, 0x04,
  0x00, 0x00
};

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(BTN_PIN, INPUT_PULLUP);

  NimBLEDevice::init("");
  NimBLEDevice::setPower(3);          // dBm; lower it to shrink the hunt radius

  NimBLEAdvertisementData data;
  data.setFlags(0x06);                // LE General Discoverable, BR/EDR not supported
  data.setManufacturerData(payload, sizeof(payload));

  adv = NimBLEDevice::getAdvertising();
  adv->setAdvertisementData(data);
  adv->setMinInterval(160);           // 100 ms
  adv->setMaxInterval(240);
  adv->enableScanResponse(false);
  adv->start();
  advertising = true;

  Serial.println("[emu] advertising a fake Find My beacon");
  Serial.println("[emu] press BOOT to toggle");
}

void loop() {
  static bool last = HIGH;
  bool now = digitalRead(BTN_PIN);
  if (last == HIGH && now == LOW) {
    advertising = !advertising;
    if (advertising) adv->start(); else adv->stop();
    Serial.printf("[emu] advertising %s\n", advertising ? "ON" : "OFF");
    delay(200);
  }
  last = now;
  delay(20);
}
