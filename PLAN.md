# Sweep instrument — build plan

**One-liner:** *Everything else tells you a tracker is nearby. This one walks you to it — and it flags the ones it has no signature for.*

Two ideas doing the work:

- **Hunt mode.** Existing tools (iOS built-in, AirGuard) tell you a tracker *exists*. Almost nothing helps you physically *find* one — Apple's Precision Finding needs UWB and only works for AirTags on an iPhone. For a Tile, a SmartTag, or something unknown, you're on your own.
- **Baseline + anomaly.** Signature matching only finds trackers you already have bytes for. Learning the room's normal BLE population and flagging what's *new* catches the ones you don't — and it's the answer to "what about custom hardware?"

Signatures are a labelling layer on top, not the product.

---

## Built already (compile-verified, no hardware)

| file | what |
|---|---|
| `tracker.h` | NimBLE scan, sighting table, RSSI ring buffers, EMA, continuity, baseline learn, signature match |
| `ui_kit.h` | touch, buttons, tab bar, status bar, sparkline |
| `ui_tracker.h` | Sweep / Hunt / Detail screens |
| `emulator/` | second ESP32 advertising a fake Find My beacon, BOOT toggles it |
| `ui_simple.h` | the fallback wifi-analyser app (`APP_TRACKER 0`) |

Wifi is explicitly `WIFI_OFF` in the tracker app: frees ~40KB heap, removes radio coexistence contention, and makes *"this device has no internet connection"* a true statement in the demo.

## Do tonight (only you can)

- **Borrow an AirTag or Tile.** Without one — and without a second board for the emulator — the demo is an empty list.
- **Ground-truth the signatures.** nRF Connect → look at your tracker's raw advertisement → confirm the bytes match `classify()` in `tracker.h`. The table is community-derived, not documented; Google's `0xFEAA` entry in particular is a guess.
- **Ask the organisers for a second board** for the emulator.

---

## Tomorrow — risk-ordered, every gate leaves a demoable state

| time | goal | gate |
|---|---|---|
| 0:00–0:45 | bring-up: screen lit, touch landing, sketch flashed | chip info prints first — check `bluetooth: yes` |
| 0:45–1:30 | real advertisements arriving; devices appear on Sweep | **nothing by 1:30 → `APP_TRACKER 0`, demo the wifi analyser** |
| 1:30–2:15 | tune: scan window, `FLAG_MIN_*` thresholds, EMA alpha | — |
| 2:15–3:00 | Sweep list readable at arm's length | — |
| 3:00–3:45 | **Hunt mode reads well while walking** | **demo complete here; everything after is upside** |
| 3:45–4:30 | baseline learn → flagging behaves in a real room | the differentiator |
| 4:30–5:00 | signature labels verified against the real tracker | *cuttable* |
| 5:00–5:30 | battery run, unplugged, walking | non-negotiable |
| 5:30–6:00 | rehearse twice, record video | non-negotiable |

Most of the build is done, so tomorrow is tuning and demo craft. Resist adding features — spend the slack on making hunt mode feel good, because that is the demo.

## Knobs you will actually turn

| in `tracker.h` | |
|---|---|
| `LEARN_WINDOW_MS` | 30s. Long enough to be real, short enough to run live |
| `FLAG_MIN_CYCLES` | 8. Lower = twitchier, more false flags |
| `FLAG_MIN_CONTINUITY` | 40%. The "is it actually following me" bar |
| EMA alpha (`0.2f`) | Lower = smoother hunt bar, slower response |
| `NimBLEDevice::setPower` *(emulator)* | Drop it to shrink the hunt radius so the demo fits in a room |

## Demo, ~90 seconds

1. "Wifi is off — this device has no internet connection." *(point at the status bar)*
2. **Learn** a 30s baseline — pre-run this before you present, don't burn demo time
3. A judge hides the emulator in the room
4. Sweep flags it: **NEW since baseline**
5. **Hunt** — walk toward it, bar climbs, HOT, you find it
6. Close on limits (below)

Step 5 is the demo. Everything else is setup.

## Say the limits out loud

Stating these is stronger than being caught by them:

- **MACs rotate** (AirTags roughly every 15 min when separated) specifically to defeat this. All correlation here is **session-scoped**.
- **Baseline is per-space.** Walk to another room and everything is new. There's a re-learn button and a visible "baseline Nm ago" label for exactly this.
- **Can't distinguish a planted tracker from someone's own keys** in the same room. Continuity is a proxy, not proof.
- **Apple's own detection has privileged access** to rotation keys. You're detecting a *class* of device, not tracking an individual one.
- **Battery decode is unverified** community reverse-engineering — verify it or don't show the number.
