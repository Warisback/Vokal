#Requires -Version 5.1
# =====================================================================
#  Vokal -- build + flash + monitor on Windows.
#  Waveshare ESP32-S3-Touch-AMOLED-1.8 V2, arduino-cli.
#
#    powershell -ExecutionPolicy Bypass -File .\flash.ps1
#    .\flash.ps1 -Port COM7
#    .\flash.ps1 -Sketch emulator -NoMonitor
#
#  Windows sibling of flash.sh. Windows PowerShell 5.1: no &&, no ternary.
# =====================================================================
[CmdletBinding()]
param(
  # Serial port, e.g. COM7. Omitted = auto-detect.
  [string]$Port,
  # Sketch folder. arduino-cli wants folder name == .ino name.
  [string]$Sketch = 'firmware',
  # Flash and exit instead of dropping into the serial monitor.
  [switch]$NoMonitor,
  # Baud for the monitor. The firmware does Serial.begin(115200).
  [int]$Baud = 115200
)

$ErrorActionPreference = 'Stop'

# DUPLICATED in setup.sh, setup.ps1 and flash.sh -- keep all four identical.
$FQBN = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app'

$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Note ($m) { Write-Host "    $m" }
function Warn ($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "XX  $m" -ForegroundColor Red; exit 1 }

function Get-Cli {
  # An installer that edits the MACHINE or USER PATH does not touch a shell
  # that is already open, so re-read both scopes before deciding arduino-cli is
  # missing. Without this the tool is "not found" in the very shell that just
  # installed it.
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts   = @()
  if ($machine) { $parts += $machine }
  if ($user)    { $parts += $user }
  if ($parts.Count -gt 0) { $env:Path = ($parts -join ';') }

  $c = Get-Command arduino-cli -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }

  # Known install locations. "Arduino CLI" WITH A SPACE is the official Windows
  # installer's folder and is where it actually is on this machine -- do not
  # trim this list back to the winget path.
  $guesses = @()
  if ($env:LOCALAPPDATA) {
    $guesses += (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\arduino-cli.exe')
    $guesses += (Join-Path $env:LOCALAPPDATA 'Programs\arduino-cli\arduino-cli.exe')
    $guesses += (Join-Path $env:LOCALAPPDATA 'Programs\Arduino CLI\arduino-cli.exe')
  }
  # ${env:ProgramFiles(x86)} is unset on a 32-bit host and Join-Path throws on
  # a null path under -ErrorAction Stop, so filter before joining.
  $pfRoots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  foreach ($r in $pfRoots) {
    $guesses += (Join-Path $r 'Arduino CLI\arduino-cli.exe')
    $guesses += (Join-Path $r 'arduino-cli\arduino-cli.exe')
  }
  foreach ($g in $guesses) { if (Test-Path -LiteralPath $g) { return $g } }
  return $null
}

# =====================================================================
#  BOARD DETECTION -- KEEP IN SYNC WITH tools\serial.ps1
#
#  Never GetPortNames()[0]. On a typical Windows laptop COM3 and COM4 are
#  "Standard Serial over Bluetooth link" and first-port-wins cheerfully
#  tries to flash the Bluetooth stack. `arduino-cli board list` reports
#  USB VID/PID and board identity, so filter on those:
#    - no VID at all  -> not a USB device -> Bluetooth/virtual, rank 9, rejected
#    - 303A           -> Espressif native USB (this board), rank 0
#    - 1A86/10C4/0403 -> CH34x / CP210x / FTDI bridge, rank 1
#    - anything else  -> some other USB serial gadget, rank 2, never auto-picked
# =====================================================================
function Get-JsonBody ([string]$s) {
  if (-not $s) { return '' }
  $i = $s.IndexOfAny([char[]]@('{', '['))
  if ($i -lt 0) { return '' }
  return $s.Substring($i)
}

function Get-BoardCandidates ($cli) {
  $raw = (& $cli board list --format json) -join "`n"
  $body = Get-JsonBody $raw
  if (-not $body) { return @() }
  $data = $body | ConvertFrom-Json

  # arduino-cli 1.x wraps the list in .detected_ports with .port/.matching_boards;
  # 0.x returned a bare array with .address/.boards. Accept both.
  $rows = $null
  if ($data -and ($data.PSObject.Properties.Name -contains 'detected_ports')) {
    $rows = $data.detected_ports
  } else {
    $rows = $data
  }
  if (-not $rows) { return @() }

  $ranks = @{ '303A' = 0; '1A86' = 1; '10C4' = 1; '0403' = 1; '067B' = 1 }
  $out = @()
  foreach ($row in $rows) {
    $p = $row
    $boards = $null
    if ($row.PSObject.Properties.Name -contains 'port') { $p = $row.port }
    if ($row.PSObject.Properties.Name -contains 'matching_boards') { $boards = $row.matching_boards }
    elseif ($row.PSObject.Properties.Name -contains 'boards') { $boards = $row.boards }
    if (-not $p) { continue }
    if ($p.protocol -and ($p.protocol -ne 'serial')) { continue }

    # NOT $vid/$pid: $PID is a read-only AUTOMATIC variable (this shell's own
    # process id). Assigning to it throws, and under -ErrorAction Stop that
    # kills the script -- and the error text reports the PowerShell pid, which
    # sends you hunting for a board that never had that id.
    $usbVid = ''
    $usbPid = ''
    if ($p.PSObject.Properties.Name -contains 'properties' -and $p.properties) {
      if ($p.properties.PSObject.Properties.Name -contains 'vid') { $usbVid = "$($p.properties.vid)" }
      if ($p.properties.PSObject.Properties.Name -contains 'pid') { $usbPid = "$($p.properties.pid)" }
    }
    $usbVid = ($usbVid -replace '^0[xX]', '').ToUpper()
    $usbPid = ($usbPid -replace '^0[xX]', '').ToUpper()

    $label = "$($p.protocol_label)"

    # Record WHY a port was rejected instead of silently `continue`-ing.
    # On this machine COM3 and COM4 are both Bluetooth, and arduino-cli 1.5.1
    # labels them plain "Serial Port" with an EMPTY properties object:
    #   {"port":{"address":"COM3","protocol_label":"Serial Port","properties":{}}}
    # so the 'Bluetooth' label test never fires -- the no-USB-VID test is the
    # one actually stopping us from flashing the Bluetooth stack. Dropping them
    # silently left the human staring at "board not detected" with two COM
    # ports plainly visible in Device Manager, so keep them and say why.
    $reason = ''
    if ($label -match 'Bluetooth') { $reason = 'Bluetooth serial link' }
    elseif (-not $usbVid)          { $reason = 'no USB VID -- Bluetooth or virtual COM port' }

    $rank = 9
    if (-not $reason) {
      $rank = 2
      if ($ranks.ContainsKey($usbVid)) { $rank = $ranks[$usbVid] }
    }

    $name = ''
    if ($boards) {
      foreach ($b in $boards) {
        if (-not $name) { $name = "$($b.name)" }
        # An explicit esp32s3 FQBN match outranks everything else.
        if ("$($b.fqbn)" -match 'esp32s3') { $rank = 0; $reason = ''; $name = "$($b.name)" }
      }
    }

    $out += [pscustomobject]@{
      Address = "$($p.address)"
      Label   = $label
      Vid     = $usbVid
      Pid     = $usbPid
      Board   = $name
      Rank    = $rank
      Reason  = $reason
    }
  }
  return ($out | Sort-Object Rank, Address)
}

function Show-NoBoardHelp ($others) {
  Warn 'board not detected.'
  Note 'Checklist:'
  Note '  1. Is the cable a DATA cable? Charge-only USB cables enumerate nothing.'
  Note '  2. Hold BOOT, tap RESET, release BOOT, then retry.'
  Note '  3. Nothing else may hold the port -- close the Arduino IDE serial'
  Note '     monitor, PuTTY, and any tools\serial.ps1 window.'
  Note '  4. Check Device Manager > Ports (COM & LPT) for a yellow warning.'
  Note '     CP210x -> https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers'
  Note '     CH34x  -> https://www.wch-ic.com/downloads/CH341SER_ZIP.html'
  if ($others -and $others.Count -gt 0) {
    Note ''
    Note 'Serial ports that ARE present, and why each was not used:'
    foreach ($o in $others) {
      $why = $o.Reason
      if (-not $why) { $why = "USB serial (vid=$($o.Vid) pid=$($o.Pid)), but not an ESP32-S3" }
      Note ("  {0,-6} {1,-14} {2}" -f $o.Address, $o.Label, $why)
    }
    Note 'If one of those really is the board, pass it: .\flash.ps1 -Port COMx'
  }
}

# ---------------------------------------------------------------------
$cli = Get-Cli
if (-not $cli) { Fail 'arduino-cli not found. Run .\setup.ps1 first.' }

$sketchDir = Join-Path $Root $Sketch
if (-not (Test-Path -LiteralPath $sketchDir)) { Fail "no such sketch folder: $sketchDir" }

if (-not $Port) {
  Say 'detecting board'
  $cands = @(Get-BoardCandidates $cli)
  $good = @($cands | Where-Object { $_.Rank -le 1 })
  if ($good.Count -eq 1) {
    $Port = $good[0].Address
    $desc = $good[0].Board
    if (-not $desc) { $desc = $good[0].Label }
    Note "$Port  vid=$($good[0].Vid) pid=$($good[0].Pid)  $desc"
  } elseif ($good.Count -gt 1) {
    Warn 'more than one board-looking port. Pick one:'
    foreach ($g in $good) {
      $desc = $g.Board
      if (-not $desc) { $desc = $g.Label }
      Note ("  .\flash.ps1 -Port {0}    # vid={1} pid={2}  {3}" -f $g.Address, $g.Vid, $g.Pid, $desc)
    }
    exit 1
  } else {
    Show-NoBoardHelp @($cands | Where-Object { $_.Rank -ge 2 })
    exit 1
  }
}

Say "$Sketch -> $Port"
Note $FQBN

# =====================================================================
#  SAY WHAT IS ABOUT TO BE BAKED IN
#
#  The FQBN above is a constant and has never once been wrong. VOKAL_HOST is
#  the opposite: the hotspot hands out a new lease every time it comes up, so
#  firmware\secrets.h is the line being edited thirty seconds before the demo
#  and THIS script is the reflash that follows (config.h:171-174, setup.ps1's
#  secrets step). A stale or mistyped IP compiles clean, uploads clean and
#  prints "flashed OK" in green -- and then every POST /utterance sits there
#  until HTTP_TIMEOUT_MS (8 s) and the pipeline just looks dead, with nothing
#  on screen saying the laptop address is wrong. One line of output, before
#  the ~40 s build rather than after it.
#
#  Only the firmware sketch reads secrets.h -- emulator\ does not include
#  config.h at all -- so this must not fire for -Sketch emulator.
# =====================================================================
$fwDir = Join-Path $Root 'firmware'
$isFirmware = $false
if (Test-Path -LiteralPath $fwDir) {
  $a = (Resolve-Path -LiteralPath $sketchDir).Path.TrimEnd('\')
  $b = (Resolve-Path -LiteralPath $fwDir).Path.TrimEnd('\')
  if ($a -ieq $b) { $isFirmware = $true }
}
if ($isFirmware) {
  $sec = Join-Path $fwDir 'secrets.h'
  if (-not (Test-Path -LiteralPath $sec)) { Fail 'firmware\secrets.h is missing -- run .\setup.ps1' }
  $body = Get-Content -LiteralPath $sec -Raw
  # Anchored at the line start so a commented-out example line cannot be
  # mistaken for the live value.
  if ($body -match '(?m)^\s*#define\s+VOKAL_HOST\s+"([^"]+)"') {
    Note "VOKAL_HOST = $($Matches[1])"
    if ($Matches[1] -eq '192.168.1.100') {
      Warn 'VOKAL_HOST is still the placeholder -- the board will never reach the laptop.'
      Note 'Put the LAPTOP''s LAN IP in firmware\secrets.h (ipconfig -> the Wi-Fi'
      Note 'adapter''s IPv4 Address), check http://<that IP>:8000/health from a'
      Note 'browser on the same network, then rerun this script.'
    }
  } else {
    Warn 'no VOKAL_HOST in firmware\secrets.h -- config.h will #error out of the build.'
  }
}

& $cli compile --fqbn $FQBN $sketchDir -u -p $Port
if ($LASTEXITCODE -ne 0) {
  Write-Host ''
  Warn 'compile/upload failed.'
  Note 'If it compiled but the UPLOAD failed:'
  Note '  1. Hold BOOT, tap RESET, release BOOT -- that forces the download'
  Note '     ROM. Then rerun this script immediately.'
  Note "  2. Something else may own ${Port}: close the Arduino IDE serial monitor,"
  Note '     PuTTY, or a tools\serial.ps1 window and try again.'
  Note '  3. Try a different USB port / a known-good DATA cable.'
  Note 'If it failed to COMPILE, rerun .\setup.ps1 -ForceLibs -- the vendor'
  Note 'libraries are the usual suspect, and -ForceLibs is what re-copies a'
  Note 'half-written one (see tools\README.md).'
  exit 1
}

if ($NoMonitor) {
  Write-Host '    flashed OK' -ForegroundColor Green
  exit 0
}

Write-Host '    flashed OK' -ForegroundColor Green
Say "monitor $Port @ $Baud (ctrl-C to quit)"
# The S3's native USB re-enumerates after a reset, so the port can be gone for
# a beat right after upload; give it a moment before grabbing it.
Start-Sleep -Milliseconds 800
& $cli monitor -p $Port -c "baudrate=$Baud"
