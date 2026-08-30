#Requires -Version 5.1
# =====================================================================
#  Find the board and open a serial monitor.
#
#    powershell -ExecutionPolicy Bypass -File .\tools\serial.ps1
#    .\tools\serial.ps1 -Port COM7
#    .\tools\serial.ps1 -List
#
#  Windows sibling of tools\serial.sh (which globs /dev/cu.* and can only
#  ever print its failure branch here). Windows PowerShell 5.1: no &&,
#  no ternary.
# =====================================================================
[CmdletBinding()]
param(
  # Serial port, e.g. COM7. Omitted = auto-detect.
  [string]$Port,
  # The firmware does Serial.begin(115200).
  [int]$Baud = 115200,
  # Just enumerate what is plugged in and exit.
  [switch]$List
)

$ErrorActionPreference = 'Stop'

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
#  BOARD DETECTION -- KEEP IN SYNC WITH flash.ps1
#
#  Never GetPortNames()[0]. On a typical Windows laptop COM3 and COM4 are
#  "Standard Serial over Bluetooth link" and first-port-wins would open
#  the Bluetooth stack instead of the board. `arduino-cli board list`
#  reports USB VID/PID and board identity, so filter on those:
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
  Warn 'No board found.'
  Note 'Checklist:'
  Note '  1. Is the cable a DATA cable? Charge-only USB cables enumerate nothing.'
  Note '  2. Hold BOOT, tap RESET, release BOOT, then retry.'
  Note '  3. Nothing else may hold the port -- close the Arduino IDE serial'
  Note '     monitor, PuTTY, flash.ps1, and any other serial.ps1 window.'
  Note '  4. Device Manager > Ports (COM & LPT): a yellow triangle means a'
  Note '     missing driver. These are the WINDOWS drivers:'
  Note '       CP210x -> https://www.silabs.com/developers/usb-to-uart-bridge-vcp-drivers'
  Note '       CH34x  -> https://www.wch-ic.com/downloads/CH341SER_ZIP.html'
  if ($others -and $others.Count -gt 0) {
    Note ''
    Note 'Serial ports that ARE present, and why each was not used:'
    foreach ($o in $others) {
      $why = $o.Reason
      if (-not $why) { $why = "USB serial (vid=$($o.Vid) pid=$($o.Pid)), but not an ESP32-S3" }
      Note ("  {0,-6} {1,-14} {2}" -f $o.Address, $o.Label, $why)
    }
    Note 'If one of those really is the board: .\tools\serial.ps1 -Port COMx'
  }
}

# ---------------------------------------------------------------------
$cli = Get-Cli
if (-not $cli) { Fail 'arduino-cli not found. Run .\setup.ps1 first.' }

if ($List) {
  Say 'ports arduino-cli can see'
  & $cli board list
  Write-Host ''
  Say 'after ranking (0 = Espressif native USB, 1 = usb-serial bridge, 9 = rejected)'
  $all = @(Get-BoardCandidates $cli)
  if ($all.Count -eq 0) { Note '(no serial ports at all)' }
  foreach ($a in $all) {
    $tail = $a.Board
    if ($a.Reason) { $tail = 'REJECTED: ' + $a.Reason }
    Note ("  rank {0}  {1,-6} vid={2,-4} pid={3,-4} {4,-14} {5}" -f $a.Rank, $a.Address, $a.Vid, $a.Pid, $a.Label, $tail)
  }
  exit 0
}

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
      Note ("  .\tools\serial.ps1 -Port {0}    # vid={1} pid={2}  {3}" -f $g.Address, $g.Vid, $g.Pid, $desc)
    }
    exit 1
  } else {
    Show-NoBoardHelp @($cands | Where-Object { $_.Rank -ge 2 })
    exit 1
  }
}

Say "monitoring $Port at $Baud (ctrl-C to quit)"
& $cli monitor -p $Port -c "baudrate=$Baud"
