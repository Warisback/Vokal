#!/usr/bin/env python3
"""
Live 6-DoF IMU scope for tuning double-tap detection.

    python3 tools/imuplot.py [port]

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
channels of different lengths. No pyserial needed.
"""
import sys, os, threading, collections, subprocess, time
import matplotlib
matplotlib.use("MacOSX" if sys.platform == "darwin" else "TkAgg")
import matplotlib.pyplot as plt
from matplotlib.animation import FuncAnimation

PORT   = sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbmodem1101"
WINDOW = 6.0
NMAX   = 6000
MARKS  = 16

buf  = collections.deque(maxlen=NMAX)   # (t,ax,ay,az,gx,gy,gz,mag,hpz,slowA,quiet)
taps = collections.deque(maxlen=MARKS)
rej  = collections.deque(maxlen=MARKS)
stats = {"last": "-", "widths": collections.deque(maxlen=8)}
cfg  = {"thresh": 1.4, "refractory": 100, "window": 500}
t0   = None
LOG  = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "serial-debug.log"),
            "w", buffering=1)

def reader():
    global t0
    subprocess.run(["stty", "-f", PORT, "115200", "raw", "-echo"], check=False)
    while True:
        try:
            f = open(PORT, "rb", buffering=0)
        except OSError:
            time.sleep(0.3); continue
        pend = b""
        while True:
            try:
                chunk = f.read(512)
            except OSError:
                break
            if not chunk:
                continue
            pend += chunk
            while b"\n" in pend:
                line, pend = pend.split(b"\n", 1)
                s = line.decode("utf-8", "replace").strip()
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
                            stats["last"] = f"ACCEPT w={p[3]}ms pk={p[4]}"
                    elif s.startswith("$R,"):
                        p = s.split(","); ms = int(p[1])
                        if t0 is None: t0 = ms
                        rej.append(((ms - t0) / 1000.0, p[4] if len(p) > 4 else "?"))
                        stats["last"] = f"REJECT w={p[2]}ms pk={p[3]} ({p[4] if len(p)>4 else '?'})"
                    elif s.startswith("$C,"):
                        p = s.split(",")
                        cfg.update(thresh=float(p[1]), refractory=int(p[2]), window=int(p[3]))
                    elif s.startswith("["):
                        print(s, flush=True); LOG.write(s + "\n")
                except (ValueError, IndexError):
                    pass

threading.Thread(target=reader, daemon=True).start()

fig, (axA, axG, axQ) = plt.subplots(3, 1, figsize=(12, 8.5), sharex=True,
                                    gridspec_kw={"height_ratios": [3, 2, 1.4]})
fig.canvas.manager.set_window_title("Vokal - 6-DoF IMU scope")

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
print(f"reading {PORT} -- tap the device; close the window to quit", flush=True)
plt.show()
