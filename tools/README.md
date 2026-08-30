# Vokal — build, flash and debug tooling

Everything here drives one board: **Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2)**,
built with **arduino-cli**. This is an `.ino` project, not ESP-IDF.

Every script exists twice — a `.sh` for macOS and a `.ps1` for Windows. They do
the same thing. Change one, change the other.

| what | macOS | Windows |
|---|---|---|
| one-time setup | `./setup.sh` | `.\setup.ps1` |
| build + flash + monitor | `./flash.sh` | `.\flash.ps1` |
| just a serial monitor | `./tools/serial.sh` | `.\tools\serial.ps1` |
| live IMU scope | `python3 tools/imuplot.py` | `python tools\imuplot.py` |

---

## Two things that MUST be kept in sync

### 1. The FQBN

    esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app

It is written out in **four** places, once per script:

- `setup.sh`
- `setup.ps1`
- `flash.sh`
- `flash.ps1`

`PROTOCOL.md` is the source of truth for it. There is no shared config file:
each script carries its own copy, because each script has to stay a single file
you can hand to somebody. **Change it in one, change it in all four.**

If they drift you get a board that flashes and then boot-loops, or a sketch that
will not fit the partition — both of which look like a firmware bug and are not.
Grep before and after you edit; the four lines must come back byte-identical:

```bash
grep -rn "PartitionScheme=huge_app" setup.sh setup.ps1 flash.sh flash.ps1
```

### 2. The board detector

`Get-BoardCandidates` is duplicated verbatim in `flash.ps1` and
`tools\serial.ps1` (both carry a `KEEP IN SYNC` banner). It is copied rather
than dot-sourced so each script stays a single file you can hand somebody.

---

## setup.ps1 / setup.sh

Idempotent. Rerun as often as you like.

1. **arduino-cli** — winget (`ArduinoSA.CLI`), else the official Windows zip
   unpacked into `%LOCALAPPDATA%\Programs\arduino-cli` and added to the user
   PATH. If it still is not on PATH the script prints the exact one-liner.
2. **git check** — needed for step 4. Git for Windows frequently installs
   without putting `C:\Program Files\Git\cmd` on PATH; setup falls back to the
   full path and prints the permanent fix.
3. **esp32 core** — board-manager URL, `core update-index`, `core install
   esp32:esp32`. About 1 GB, so it takes a while the first time.
4. **Vendor libraries** — shallow-clones
   `waveshareteam/ESP32-S3-Touch-AMOLED-1.8` and copies five libraries out of
   `examples/arduino-v2/libraries/`:
   `GFX_Library_for_Arduino`, `Arduino_DriveBus`, `SensorLib`,
   `Adafruit_BusIO`, `Adafruit_XCA9554`.
   The skip-if-present test checks each folder actually *holds* a library —
   `library.properties`, or failing that at least one header — not merely that
   the folder exists. The copy is `Remove-Tree` then `Copy-Item -Recurse` and
   those are not atomic, so a ctrl-C or a OneDrive lock can leave a directory
   that exists and is empty; that used to be reported as "already present" and
   the compile then died on a header that is supposedly on disk. Anything
   incomplete is now re-copied automatically, and `-ForceLibs` re-copies all
   five regardless.
5. **secrets** — creates `firmware/secrets.h` from `secrets.example.h` if it is
   missing, and warns while it still holds the placeholders. It never writes a
   key. `firmware/secrets.h` is gitignored; keep it that way.
   Two separate warnings, because they fail differently: `WIFI_NETWORKS`
   (board never joins) and `VOKAL_HOST` (board joins, then cannot reach the
   laptop). `VOKAL_HOST` is the laptop's **LAN IP**, and a hotspot hands out a
   new lease every time it is switched on — expect to edit that line and
   reflash minutes before the demo, and check it first with
   `http://<that IP>:8000/health` from any browser on the same network.
6. **compile check** — `arduino-cli compile --fqbn <FQBN> firmware`.

Flags: `-ForceLibs` re-clones and re-copies the vendor libraries;
`-SkipCompileCheck` stops before the slow bit.

### Do not swap the vendor libraries for Library Manager versions

`GFX_Library_for_Arduino`, `Arduino_DriveBus` and `SensorLib` are
**board-specific Waveshare forks**. The same-named releases in the Arduino
Library Manager do **not** drive this board's CO5300 QSPI AMOLED or its CST816
touch controller. Swap them "to get the latest" and the screen goes black with
a clean compile and no error. The upstream repo is unpinned, so setup prints
the cloned commit SHA and stores it in `<libraries>/.vokal-waveshare-sha`.

### The libraries directory is NOT `~/Documents/Arduino/libraries`

`setup.sh` hardcodes `$HOME/Documents/Arduino/libraries`. On this Windows box
**OneDrive Documents redirection is active**, so `$HOME\Documents\Arduino` does
not exist at all and the real path is

    C:\Users\yussu\OneDrive\Documents\Arduino\libraries

which is why `setup.ps1` resolves it at runtime instead of hardcoding it:

```powershell
arduino-cli config get directories.user   # + "\libraries"
```

Hardcoding it puts the vendor libraries somewhere arduino-cli never looks, and
the failure is silent and baffling: the compile dies on a missing header that is
plainly sitting on disk.

### The `config get` array bug — read this before touching `setup.ps1`

Resolving that path at runtime is right, but the obvious way to read it is
**wrong**, and it already bit us: it dumped all five Waveshare vendor libraries
into the root of this repo.

A native command's stdout reaches PowerShell as an **array of lines**, and
arduino-cli appends a trailing blank one. Measured on arduino-cli 1.5.1:

```powershell
$out = arduino-cli config get directories.user
$out.GetType().FullName   # System.Object[]   <- NOT a string
@($out).Count             # 2
$out[0]                   # C:\Users\yussu\OneDrive\Documents\Arduino
$out[1]                   # '' (empty)
```

`$out.Trim()` *looks* like it cleans that up. It does not — on an array,
`.Trim()` is **member enumeration**, so it hands back another 2-element array
with the blank still in it. Feed that to `Join-Path` and you get:

```
Join-Path : Cannot bind argument to parameter 'Path' because it is an empty string.
```

...and the destination variable is left `$null`. **`Copy-Item -Destination $null`
does not fail.** It silently falls back to the *current directory*. That is the
whole bug: five vendor libraries copied into the repo root, and a green "OK" at
the end of the run.

The fix, and the shape every scalar read in `setup.ps1` now uses — drop the
blank lines **first**, take one line, and only then trim:

```powershell
$userDir = ((arduino-cli config get directories.user) |
            Where-Object { $_ -and $_.Trim() } |
            Select-Object -First 1).Trim()
```

`setup.ps1` wraps exactly that in `Get-CliLine` and routes `config get`,
`version` and `git rev-parse` through it. On top of that sit three hard guards,
none of which should ever be softened into a warning:

1. empty `directories.user` -> **throw**, naming the two commands to run by hand;
2. a non-absolute `directories.user` -> **throw** (a relative destination is
   exactly how files end up in the repo);
3. a resolved libraries dir that is *inside the repo* -> **throw**.

Plus a fourth at the point of damage: the per-library `Copy-Item` refuses any
destination that is not an absolute path.

**Rule of thumb: never call `.Trim()` on the output of a native command, and
never let a path variable reach `Copy-Item` as `$null`.**

### Where arduino-cli actually lives, and stale PATH

On this machine arduino-cli is at

    C:\Program Files\Arduino CLI\arduino-cli.exe

— note the **space** in "Arduino CLI". That is the official Windows installer's
folder, and it is neither the winget path nor the zip path, so all three scripts
list it explicitly in their fallback search.

It is on the *machine* PATH, but an already-open shell keeps the environment it
started with, so `Get-Command arduino-cli` can come back empty in the very shell
that just installed it. `setup.ps1` therefore calls `Sync-Path` (re-read the
machine + user PATH into this process) **before** it probes, and `flash.ps1` and
`tools\serial.ps1` do the same at the top of `Get-Cli`. Without it, setup
cheerfully reinstalls a tool that is already there.

### Idempotency: a rerun has to be a fast no-op

`setup.ps1` is safe to rerun, and on an already-set-up machine it must not touch
the network at all. Two things make that true:

- **`core update-index` runs only when the core is missing.** It re-downloads
  the package index every single time it is called, and it has nothing to say
  about a core that is already installed — so the `core list` check happens
  *first*, and the index refresh is inside the install branch.
- **`config init` only reports.** Once a config exists it writes a red error
  block to stderr on every rerun; both streams are swallowed and the exit code
  read instead, so a rerun stays quiet. (The `try/catch` around it is not
  decoration: in PowerShell 5.1, redirecting a native command's stderr under
  `$ErrorActionPreference = 'Stop'` turns it into a terminating
  `NativeCommandError`.)

The vendor-library step already skipped correctly, and still does: it checks
each folder actually *holds* a library rather than merely existing.

Nothing in any of these scripts prompts — no `Read-Host`, no `Out-GridView`, and
`winget` is invoked with all four `--accept*` / `--silent` flags. Keep it that
way: a script that blocks on a prompt is a script that hangs the demo.

---

## flash.ps1 / flash.sh

```powershell
.\flash.ps1                          # auto-detect port, flash firmware, monitor
.\flash.ps1 -Port COM7               # explicit port
.\flash.ps1 -Sketch emulator         # a different sketch folder
.\flash.ps1 -NoMonitor               # flash and exit
```

Before it starts the ~40 s build it reads `firmware/secrets.h` and prints the
`VOKAL_HOST` it is about to bake in, warning if that is still the
`192.168.1.100` placeholder. That value is the one thing that changes on the
day — a hotspot hands out a new lease every time it comes up — and a stale one
compiles clean, uploads clean, prints "flashed OK" in green, and then times out
at 8 s on every `POST /utterance` with nothing on screen to say why. (Only
`-Sketch firmware` is checked; `emulator/` never reads `secrets.h`.)

On failure it prints the recovery drill: data cable, then **hold BOOT, tap
RESET, release BOOT** to force the download ROM, then check nothing else owns
the port. A COMPILE failure points at `.\setup.ps1 -ForceLibs`, the flag that
actually replaces a half-written vendor library.

### Port detection: never first-port-wins

`flash.sh` globs `/dev/cu.usbmodem*`, which is macOS-only and matches nothing on
Windows. The obvious Windows "fix" — `[IO.Ports.SerialPort]::GetPortNames()[0]`
— is **worse**: on a typical Windows laptop `COM3` and `COM4` are *Standard
Serial over Bluetooth link*, so first-port-wins tries to flash the Bluetooth
stack.

The Windows scripts use `arduino-cli board list --format json`, which reports
USB VID/PID and board identity, and rank the results:

| rank | what | auto-picked |
|---|---|---|
| 0 | VID `303A` (Espressif native USB) or an `esp32s3` FQBN match | yes |
| 1 | VID `1A86` / `10C4` / `0403` / `067B` (CH34x, CP210x, FTDI, Prolific) | yes |
| 2 | some other USB serial device | no — listed, never chosen |
| 9 | **no USB VID at all** (Bluetooth, virtual COM) | never — rejected |

If several rank-0/1 ports match, it lists them and exits so you can pass
`-Port`. If none do, it prints the checklist plus every port it *did* see, with
the reason each one was passed over.

**Watch out: the Bluetooth ports are not labelled "Bluetooth".** On this laptop
`COM3` and `COM4` are both *Standard Serial over Bluetooth link*, and this is
all arduino-cli 1.5.1 will tell you about them:

```json
{ "port": { "address": "COM3", "protocol_label": "Serial Port", "properties": {} } }
```

`protocol_label` is a bland `"Serial Port"`, so a filter that greps the label
for "Bluetooth" matches nothing and lets both through. The rule that actually
saves you is **empty `properties` -> no USB VID -> reject**. Keep it. (The
label test stays as a cheap second net for drivers that do say "Bluetooth".)

Rejected ports are kept in the candidate list at rank 9 rather than dropped, so
`flash.ps1` and `serial.ps1 -List` can print *why* each was passed over.
Discarding them silently left you reading "board not detected" while Device
Manager plainly showed two COM ports.

---

## tools/serial.ps1 — serial monitor only

```powershell
.\tools\serial.ps1                   # auto-detect, monitor at 115200
.\tools\serial.ps1 -Port COM7
.\tools\serial.ps1 -List             # enumerate ports and show the ranking
.\tools\serial.ps1 -Baud 115200
```

`-List` is the first thing to run when the board "is not there".

`tools/serial.sh` is the macOS original. It globs four `/dev/cu.*` names and
prints the **macOS** CH34x driver link, so on Windows it can only ever reach its
failure branch — use the `.ps1`.

Only one process can hold a COM port. `flash.ps1`'s monitor, `serial.ps1`,
`imuplot.py`, the Arduino IDE and PuTTY all fight over it, and the loser gets
"Access is denied" or an upload that fails at the handshake. Close the others.

---

## tools/imuplot.py — live 6-DoF IMU scope

Tuning tool for the double-tap detector. Needs `IMU_STREAM 1` in
`firmware/config.h`; set it back to `0` afterwards, it costs ~8 KB/s of serial
bandwidth.

```bash
pip install pyserial matplotlib

python  tools/imuplot.py             # Windows, auto-detect port
python3 tools/imuplot.py             # macOS / Linux
python  tools/imuplot.py COM7        # explicit port
python  tools/imuplot.py --list      # every serial port, with the ranking
```

It reads the firmware's `$I` / `$T` / `$R` / `$C` lines (documented in the
script's docstring and emitted by `firmware/imu.h`) and plots raw `az` against
the high-passed signal the detector actually runs on, the gyro, and the
movement gate, with markers for accepted taps and rejected pulses. Everything
it logs also lands in `tools/serial-debug.log` (gitignored).

It now uses **pyserial**. The first version advertised "no pyserial needed" and
that was precisely the bug: it shelled out to `stty -f <port>` (BSD syntax, and
Git Bash's `stty` drives an MSYS pty, not a Windows COM port) with
`check=False`, so on Windows the baud rate silently never got set — and then it
did `open(PORT, "rb")`, treating a COM port as a plain file, which is a Unix-ism
that cannot work at all. pyserial is cross-platform, so the rewrite is a strict
improvement on macOS too.

### Python on Windows

`python.exe` / `python3.exe` may be Microsoft Store **alias stubs** that just
print "Python was not found" and open the Store. If you see that:

1. Install real Python from <https://www.python.org/downloads/windows/> with
   "Add python.exe to PATH" ticked, then
2. Settings → Apps → Advanced app settings → **App execution aliases** → turn
   off `python.exe` and `python3.exe`.

Check with `python --version`; it must print a version, not an advert.

---

## Known gap: emulator/ does not build after a clean setup

`emulator/emulator.ino` `#include <NimBLEDevice.h>`, and **neither `setup.sh`
nor `setup.ps1` installs NimBLE-Arduino**, so that sketch fails to compile on a
fresh machine with "NimBLEDevice.h: No such file or directory".

This is deliberate and not a bug to fix in setup. `emulator/` belongs to the
**shelved attic BLE-tracker prototype** (see `attic/`), not to Vokal — nothing
in the Vokal build path touches it. If you actually want it:

```bash
arduino-cli lib install NimBLE-Arduino
```

The same applies to the dead knobs in `firmware/config.h` (`BOARD_TYPE`,
`APP_TRACKER`, `USE_LVGL`, `SCREEN_ROTATION`, the `BOARD_CUSTOM` pin block) and
to `firmware/ui_simple.h` / `firmware/ui_lvgl.h`: leftovers from that
prototype, not part of what is compiled.

---

## What the repo-root `.gitignore` is protecting

Two entries are load-bearing and neither is obvious:

- **`laptop/demo_clips/` is deliberately NOT ignored.** It holds the
  pre-rendered clip beat (`clip1_source.wav`, `clip1_rendered.wav`,
  `clip1.txt`). That beat plays a cached WAV — no STT, no TTS, no network at
  run time — so it cannot fail on stage. It is the demo's safety net, and a
  safety net that is not committed is not a safety net.
  Note the tension: `laptop/captures/*.wav` **is** ignored (recordings of real
  people, kept local) while `laptop/demo_clips/*.wav` is not. Do not "tidy" the
  two into one blanket `*.wav`.
- **The five vendor library names are ignored at the repo root** —
  `/GFX_Library_for_Arduino/`, `/Arduino_DriveBus/`, `/SensorLib/`,
  `/Adafruit_BusIO/`, `/Adafruit_XCA9554/` — purely as a tripwire. That is
  where the `config get` bug above dumped them. The guards in `setup.ps1` are
  the real fix; this only means a regression cannot be committed by accident.
  If one of those directories ever turns up in the repo root again, do not
  commit it: something re-broke.

`laptop/` also carries its own `.gitignore`. Remember that a nested `.gitignore`
**overrides** the repo-root one for paths beneath it, so a negation at the root
cannot rescue a file the nested one ignores — check with
`git check-ignore -v <path>` rather than assuming.

---

## Running .ps1 scripts at all

Windows blocks unsigned scripts by default. Either prefix each run:

```powershell
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

or allow local scripts once, for your user only:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

If a script was downloaded rather than cloned, Windows may also mark it
blocked — `Unblock-File .\setup.ps1`.

These are written for **Windows PowerShell 5.1**, the one that ships with
Windows: no `&&`, no ternary, no `??`. Keep it that way unless the whole team
moves to PowerShell 7.
