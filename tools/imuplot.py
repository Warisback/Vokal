#!/usr/bin/env python3
"""
Live 6-DoF IMU scope for tuning double-tap detection.

    python  tools/imuplot.py [PORT]      # Windows
    python3 tools/imuplot.py [PORT]      # macOS / Linux
    python  tools/imuplot.py --list      # show every serial port it can see

Needs `pip install pyserial matplotlib`, and IMU_STREAM 1 in firmware/config.h.

Port is argv[1]; omit it and the port is auto-detected by USB VID.

Firmware stream (IMU_STREAM 1):
    $I,<ms>,<ax>,<ay>,<az>,<gx>,<gy>,<gz>,<mag>,<hpz>,<slowA>,<quiet>
    $T,<ms>,1|2,<width_ms>,<peak>   1 = first tap, 2 = double accepted
    $R,<ms>,<width_ms>,<peak>,<why> pulse REJECTED (too wide / stuck)
    $C,<thresh>,<refractory_ms>,<window_ms>

Top    : raw az, and the HIGH-PASSED az that detection actually runs on,
         with the +/- threshold. A finger strike shows as a sharp spike in
         hpz; sliding or lifting the puck barely moves it at all.
Middle : gyroscope x/y/z.
Bottom : the movement gate -- slow |a| envelope, and a shaded band
         wherever the puck is NOT quiet enough to accept a tap.

Markers: solid red = double-tap accepted, orange = first tap,
         dotted grey = pulse REJECTED (too wide, i.e. a pickup not a tap).
The readout prints the width of every accepted tap -- set TAP_MAX_WIDTH_MS
just above the widest real tap you can produce.

Samples are kept in ONE deque of tuples so the draw thread can never see
channels of different lengths.

WHY PYSERIAL. The first version boasted "no pyserial needed": it shelled out
to `stty -f <port> 115200` and then did open(PORT,"rb"). Both are Unix-isms.
On Windows a COM port is not a file you can open() and Git Bash's stty drives
an MSYS pty, not the port -- and the subprocess call passed check=False, so
the baud rate silently never got set and the plot just stayed empty forever.
pyserial is cross-platform, so this is a strict improvement on macOS too.
"""
import sys, os, threading, collections, time

try:
    import serial
    import serial.tools.list_ports
except ImportError:
    sys.exit("pyserial is missing.  pip install pyserial matplotlib")

try:
    import matplotlib
except ImportError:
    sys.exit("matplotlib is missing.  pip install pyserial matplotlib")

# MacOSX is the nicest backend on a Mac but does not exist elsewhere; TkAgg is
# the one that ships with a stock python.org install on Windows.
for _backend in (["MacOSX", "TkAgg", "QtAgg"] if sys.platform == "darwin"
                 else ["TkAgg", "QtAgg", "Qt5Agg"]):
    try:
        matplotlib.use(_backend, force=True)
        break
    except Exception:
        continue

import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation

BAUD   = 115200
WINDOW = 6.0
NMAX   = 6000
MARKS  = 16

# USB vendor IDs, best first. 0x303A is Espressif's own -- this board talks
# native USB, so that is what you should see. The bridges are here for the
# older dev boards knocking about in the same box.
VID_RANK = {
    0x303A: 0,   # Espressif (ESP32-S3 native USB / USB-JTAG-serial)
    0x1A86: 1,   # WCH CH340 / CH9102
    0x10C4: 1,   # Silicon Labs CP210x
    0x0403: 1,   # FTDI
    0x067B: 1,   # Prolific
}


def candidates():
    """USB serial ports that could plausibly be the board, best first.

    A port with no VID is not a USB device at all: on Windows that is the
    "Standard Serial over Bluetooth link" pair sitting on COM3/COM4, and
    first-port-wins would happily try to read the Bluetooth stack.
    """
    rows = []
    for p in serial.tools.list_ports.comports():
        desc = (p.description or "") + " " + (p.manufacturer or "")
        if p.vid is None:
            continue
        if "bluetooth" in desc.lower():
            continue
        rows.append((VID_RANK.get(p.vid, 2), p.device, p))
    rows.sort(key=lambda r: (r[0], r[1]))
    return rows


def describe(p):
    vid = "----" if p.vid is None else "%04X" % p.vid
    pid = "----" if p.pid is None else "%04X" % p.pid
    return "%-10s vid=%s pid=%s  %s" % (p.device, vid, pid, p.description or "")


def list_ports_and_exit():
    print("all serial ports:")
    ports = list(serial.tools.list_ports.comports())
    if not ports:
        print("  (none)")
    for p in ports:
        print("  " + describe(p))
    print("\nboard candidates (rank 0 = Espressif native USB):")
    rows = candidates()
    if not rows:
        print("  (none -- every port was Bluetooth or non-USB)")
    for rank, dev, p in rows:
        print("  rank %d  %s" % (rank, describe(p)))
    sys.exit(0)


def pick_port():
    rows = [r for r in candidates() if r[0] <= 1]
    if len(rows) == 1:
        print("auto-detected %s" % describe(rows[0][2]), flush=True)
        return rows[0][1]
    if len(rows) > 1:
        print("more than one board-looking port. Pass one:")
        for _, dev, p in rows:
            print("  python tools/imuplot.py %s    # %s" % (dev, describe(p)))
        sys.exit(1)
    print("No board found.")
    print("  1. Is the cable a DATA cable? Charge-only cables enumerate nothing.")
    print("  2. Hold BOOT, tap RESET, release BOOT, then retry.")
    print("  3. Close anything else holding the port (arduino-cli monitor,")
    print("     flash.ps1, tools/serial.ps1, Arduino IDE, PuTTY).")
    print("  4. Run  python tools/imuplot.py --list  to see everything.")
    sys.exit(1)


if len(sys.argv) > 1 and sys.argv[1] in ("--list", "-l"):
    list_ports_and_exit()
PORT = sys.argv[1] if len(sys.argv) > 1 else pick_port()

buf  = collections.deque(maxlen=NMAX)   # (t,ax,ay,az,gx,gy,gz,mag,hpz,slowA,quiet)
taps = collections.deque(maxlen=MARKS)
rej  = collections.deque(maxlen=MARKS)
stats = {"last": "-", "widths": collections.deque(maxlen=8)}
cfg  = {"thresh": 1.4, "refractory": 100, "window": 500}
t0   = None
try:
    LOG = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "serial-debug.log"),
               "w", buffering=1)
except OSError:
    LOG = None


def handle(s):
    """Parse one line of the $I/$T/$R/$C wire protocol. Unchanged from v1."""
    global t0
    try:
        if s.startswith("$I,"):
            p = s.split(",")
            ms = int(p[1])
            if t0 is None: t0 = ms
            buf.append(((ms - t0) / 1000.0,
                        float(p[2]), float(p[3]), float(p[4]),
                        float(p[5]), float(p[6]), float(p[7]),
                        float(p[8]),
                        float(p[9])  if len(p) > 9  else 0.0,
                        float(p[10]) if len(p) > 10 else 0.0,
                        int(p[11])   if len(p) > 11 else 1))
        elif s.startswith("$T,"):
            p = s.split(","); ms = int(p[1])
            if t0 is None: t0 = ms
            taps.append(((ms - t0) / 1000.0, int(p[2])))
            if len(p) > 4:
                stats["widths"].append(int(p[3]))
                stats["last"] = "ACCEPT w=%sms pk=%s" % (p[3], p[4])
        elif s.startswith("$R,"):
            p = s.split(","); ms = int(p[1])
            if t0 is None: t0 = ms
            rej.append(((ms - t0) / 1000.0, p[4] if len(p) > 4 else "?"))
            stats["last"] = "REJECT w=%sms pk=%s (%s)" % (
                p[2], p[3], p[4] if len(p) > 4 else "?")
        elif s.startswith("$C,"):
            p = s.split(",")
            cfg.update(thresh=float(p[1]), refractory=int(p[2]), window=int(p[3]))
        elif s.startswith("["):
            print(s, flush=True)
            if LOG: LOG.write(s + "\n")
    except (ValueError, IndexError):
        pass


def reader(port):
    """Reconnecting reader. The S3 re-enumerates its native USB on every
    reset, so the port vanishes mid-session every time you press RESET --
    reopening in a loop is the whole reason this is a thread."""
    announced = False
    while True:
        try:
            ser = serial.Serial(port, BAUD, timeout=0.05)
        except (serial.SerialException, OSError) as e:
            if not announced:
                print("waiting for %s (%s)" % (port, e), flush=True)
                announced = True
            time.sleep(0.4)
            continue
        announced = False
        try:
            # The CDC endpoint comes up before the sketch has printed anything;
            # dropping whatever is already queued avoids a burst of half-lines.
            time.sleep(0.2)
            ser.reset_input_buffer()
            pend = b""
            while True:
                n = ser.in_waiting
                chunk = ser.read(n if n else 1)
                if not chunk:
                    continue
                pend += chunk
                while b"\n" in pend:
                    line, pend = pend.split(b"\n", 1)
                    handle(line.decode("utf-8", "replace").strip())
        except (serial.SerialException, OSError):
            pass
        finally:
            try:
                ser.close()
            except Exception:
                pass
        time.sleep(0.4)


threading.Thread(target=reader, args=(PORT,), daemon=True).start()

fig, (axA, axG, axQ) = plt.subplots(3, 1, figsize=(12, 8.5), sharex=True,
                                    gridspec_kw={"height_ratios": [3, 2, 1.4]})
try:
    fig.canvas.manager.set_window_title("Vokal - 6-DoF IMU scope")
except Exception:
    pass

laz, = axA.plot([], [], lw=0.9, color="#9aa4b2", label="az raw")
lhp, = axA.plot([], [], lw=1.5, color="#1f6feb", label="hp(az)  <- detector")
thr  = axA.axhline(cfg["thresh"], color="#f2545b", ls="--", lw=1.2, label="threshold")
thrn = axA.axhline(-cfg["thresh"], color="#f2545b", ls="--", lw=1.2)
axA.set_ylabel("g"); axA.set_ylim(-2.5, 2.5); axA.grid(alpha=0.25)
axA.legend(loc="upper left", fontsize=8, ncol=4)

lgx, = axG.plot([], [], lw=0.9, color="#e0554f", label="gx")
lgy, = axG.plot([], [], lw=0.9, color="#4caf6d", label="gy")
lgz, = axG.plot([], [], lw=0.9, color="#4a90e2", label="gz")
axG.set_ylabel("gyro (dps)")
axG.set_ylim(-300, 300); axG.grid(alpha=0.25)
axG.legend(loc="upper left", fontsize=8, ncol=3)

# Fixed pool of markers, reused each frame. Creating and destroying
# artists every frame is what made the window flash.
lsl, = axQ.plot([], [], lw=1.3, color="#7a5af8", label="slow |a| envelope")
qthr = axQ.axhline(0.08, color="#f5b43c", ls="--", lw=1.0, label="QUIET_ACCEL")
axQ.set_ylabel("motion"); axQ.set_xlabel("seconds")
axQ.set_ylim(0, 0.4); axQ.grid(alpha=0.25)
axQ.legend(loc="upper left", fontsize=8, ncol=2)
notquiet = [axQ.axvspan(0, 0, color="#f2545b", alpha=0.0) for _ in range(60)]

markA = [axA.axvline(0, lw=1.0, alpha=0.0) for _ in range(MARKS)]
markG = [axG.axvline(0, lw=1.0, alpha=0.0) for _ in range(MARKS)]
markR = [axA.axvline(0, lw=1.0, ls=":", color="#8a8a8a", alpha=0.0) for _ in range(MARKS)]

txt = axA.text(0.995, 0.96, "", transform=axA.transAxes, ha="right", va="top",
               fontsize=9, family="monospace")
state = {"gmax": 300.0}


def update(_):
    snap = list(buf)                      # one atomic snapshot, all channels aligned
    if not snap:
        return
    xs  = [r[0] for r in snap]
    now = xs[-1]; lo = max(0.0, now - WINDOW)
    laz.set_data(xs, [r[3] for r in snap])
    lhp.set_data(xs, [r[8] for r in snap])
    lsl.set_data(xs, [r[9] for r in snap])
    lgx.set_data(xs, [r[4] for r in snap])
    lgy.set_data(xs, [r[5] for r in snap])
    lgz.set_data(xs, [r[6] for r in snap])
    thr.set_ydata([cfg["thresh"], cfg["thresh"]])
    thrn.set_ydata([-cfg["thresh"], -cfg["thresh"]])
    axA.set_xlim(lo, max(WINDOW, now))

    vis = [r for r in snap if r[0] > lo]
    gpk = max((max(abs(r[4]), abs(r[5]), abs(r[6])) for r in vis), default=0.0)
    want = max(120.0, gpk * 1.35)
    if want > state["gmax"] * 1.15 or want < state["gmax"] * 0.6:
        state["gmax"] = want
        axG.set_ylim(-want, want)         # only rescale when it really changed

    rl = list(rej)
    for k in range(MARKS):
        if k < len(rl) and rl[k][0] >= lo:
            markR[k].set_xdata([rl[k][0], rl[k][0]]); markR[k].set_alpha(0.5)
        else:
            markR[k].set_alpha(0.0)

    tl = list(taps)
    for k in range(MARKS):
        if k < len(tl) and tl[k][0] >= lo:
            tt, kind = tl[k]
            for pool in (markA, markG):
                pool[k].set_xdata([tt, tt])
                pool[k].set_alpha(0.9 if kind == 2 else 0.5)
                pool[k].set_color("#f2545b" if kind == 2 else "#f5b43c")
                pool[k].set_linewidth(2.0 if kind == 2 else 1.0)
        else:
            markA[k].set_alpha(0.0); markG[k].set_alpha(0.0)

    # shade every stretch where the puck was too active to accept a tap
    for s in notquiet: s.set_alpha(0.0)
    k = 0; run = None
    for r in vis:
        if r[10] == 0 and run is None:
            run = r[0]
        elif r[10] == 1 and run is not None:
            if k < len(notquiet):
                notquiet[k].set_xy([[run, 0], [run, 1], [r[0], 1], [r[0], 0]])
                notquiet[k].set_alpha(0.13); k += 1
            run = None
    if run is not None and k < len(notquiet):
        notquiet[k].set_xy([[run, 0], [run, 1], [now, 1], [now, 0]])
        notquiet[k].set_alpha(0.13)

    rec = [r for r in snap if r[0] > now - 1.0]
    hpk = max((abs(r[8]) for r in rec), default=0.0)
    gp1 = max((max(abs(r[4]), abs(r[5]), abs(r[6])) for r in rec), default=0.0)
    slw = max((r[9] for r in rec), default=0.0)
    doubles = sum(1 for _, k2 in tl if k2 == 2)
    ws = list(stats["widths"])
    txt.set_text(f"peak hp(az) {hpk:6.2f} g   <- set threshold from this\n"
                 f"peak gyro   {gp1:6.1f} dps\n"
                 f"slow env    {slw:6.3f}\n"
                 f"threshold   {cfg['thresh']:6.2f} g\n"
                 f"doubles     {doubles}\n"
                 f"widths      {ws if ws else '-'}\n"
                 f"{stats['last']}")


anim = FuncAnimation(fig, update, interval=60, cache_frame_data=False)
plt.tight_layout()
print(f"reading {PORT} at {BAUD} -- tap the device; close the window to quit", flush=True)
plt.show()
