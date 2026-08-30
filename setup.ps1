#Requires -Version 5.1
# =====================================================================
#  Vokal -- one-time Windows setup.
#  Target: Waveshare ESP32-S3-Touch-AMOLED-1.8 (V2), built with arduino-cli.
#
#    powershell -ExecutionPolicy Bypass -File .\setup.ps1
#
#  Windows sibling of setup.sh -- the co-founder is on macOS and still
#  needs that one. Keep the two in step; the FQBN especially (see
#  tools\README.md, which lists every place it is duplicated).
#
#  Written for Windows PowerShell 5.1: no && chaining, no ternary, no ??.
#  Every step is idempotent -- rerun it as often as you like.
# =====================================================================
[CmdletBinding()]
param(
  # Re-clone Waveshare and re-copy the vendor libraries even if they are
  # already in place (use after an upstream fix).
  [switch]$ForceLibs,
  # Skip the final compile check (it is the slow part).
  [switch]$SkipCompileCheck
)

$ErrorActionPreference = 'Stop'

# --- single source of truth -------------------------------------------
# DUPLICATED in setup.sh, flash.sh and flash.ps1. If you change it here,
# change it in all four or you will flash a partition layout the sketch
# does not fit in.
$FQBN     = 'esp32:esp32:esp32s3:USBMode=hwcdc,CDCOnBoot=cdc,FlashSize=16M,PSRAM=opi,PartitionScheme=huge_app'
$CORE_URL = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json'
$WS_REPO  = 'https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8.git'
$WS_LIBS  = @(
  'GFX_Library_for_Arduino',
  'Arduino_DriveBus',
  'SensorLib',
  'Adafruit_BusIO',
  'Adafruit_XCA9554'
)
$CLI_ZIP  = 'https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip'

$Root = $PSScriptRoot
if (-not $Root) { $Root = (Get-Location).Path }

# ---------------------------------------------------------------------
#  Small console helpers. Matching setup.sh's "==>" / four-space idiom so
#  the two scripts read the same in a terminal.
# ---------------------------------------------------------------------
function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Note ($m) { Write-Host "    $m" }
function Warn ($m) { Write-Host "!!  $m" -ForegroundColor Yellow }
function Fail ($m) { Write-Host "XX  $m" -ForegroundColor Red; exit 1 }

# An installer that edits the *user* PATH does not touch this already-running
# process, so re-read both scopes rather than telling the user to reopen a shell.
function Sync-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts   = @()
  if ($machine) { $parts += $machine }
  if ($user)    { $parts += $user }
  $env:Path = ($parts -join ';')
}

function Add-UserPath ($dir) {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not $user) { $user = '' }
  $has = $false
  foreach ($p in ($user -split ';')) {
    if ($p -and ($p.TrimEnd('\') -ieq $dir.TrimEnd('\'))) { $has = $true }
  }
  if (-not $has) {
    # NOT setx: setx silently truncates PATH at 1024 characters and people
    # have lost their whole PATH to it.
    [Environment]::SetEnvironmentVariable('Path', ($user.TrimEnd(';') + ';' + $dir).TrimStart(';'), 'User')
    Note "added to your user PATH: $dir"
  }
  Sync-Path
}

# Windows will not delete a read-only file, and git marks everything under
# .git\objects read-only -- so a plain Remove-Item on a fresh clone fails.
function Remove-Tree ($path) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  try {
    Get-ChildItem -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue |
      ForEach-Object { if ($_.Attributes -band [IO.FileAttributes]::ReadOnly) { $_.Attributes = 'Normal' } }
  } catch { }
  try { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop }
  catch {
    Start-Sleep -Milliseconds 300
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# arduino-cli prints progress on stderr but a stray banner can still land on
# stdout, so start the JSON at the first brace rather than trusting the line.
function Get-JsonBody ([string]$s) {
  if (-not $s) { return '' }
  $i = $s.IndexOfAny([char[]]@('{', '['))
  if ($i -lt 0) { return '' }
  return $s.Substring($i)
}

# ---------------------------------------------------------------------
#  THE BUG THIS FUNCTION EXISTS TO KILL. It cost us a polluted repo.
#
#  A native command's stdout reaches PowerShell as an ARRAY of lines, and
#  arduino-cli appends a trailing blank one. Measured on arduino-cli 1.5.1:
#
#     $out = arduino-cli config get directories.user
#     $out.GetType()  ->  System.Object[]     NOT a string
#     @($out).Count   ->  2                   [0] = the path, [1] = ''
#
#  `$out.Trim()` LOOKS like it cleans that up. It does not. On an array,
#  .Trim() is member enumeration: it returns another 2-element array with the
#  blank still in it. Hand that to Join-Path and you get
#
#     Join-Path : Cannot bind argument to parameter 'Path'
#                 because it is an empty string.
#
#  ...leaving the destination variable $null. Copy-Item -Destination $null does
#  not fail -- it silently falls back to the CURRENT DIRECTORY. That is how
#  five Waveshare vendor libraries ended up dumped in the root of this repo.
#
#  So: never .Trim() a command's output. Drop the blank lines FIRST, take a
#  single line, and only then trim. Every scalar this script reads out of a
#  native command goes through here.
# ---------------------------------------------------------------------
function Get-CliLine ($Output) {
  $line = @($Output) | Where-Object { $_ -and "$_".Trim() } | Select-Object -First 1
  if (-not $line) { return '' }
  return "$line".Trim()
}

# The installer that put arduino-cli on the MACHINE path did not touch this
# already-running process. Re-read PATH before concluding it is missing, or
# setup reinstalls a tool that is already here. On this machine it lives in
# "C:\Program Files\Arduino CLI\", which a stale PATH hides completely.
Sync-Path

Write-Host ''
Say "Vokal setup -- $Root"

# =====================================================================
#  1. arduino-cli
# =====================================================================
Say 'arduino-cli'
$cli = $null
$found = Get-Command arduino-cli -ErrorAction SilentlyContinue
if ($found) { $cli = $found.Source }

if (-not $cli) {
  # winget and the zip both drop it in predictable places; look before installing.
  # winget, the zip and the official Windows installer each drop it somewhere
  # different, so look in all of them before downloading anything.
  # "Arduino CLI" WITH A SPACE is the official installer's folder, and is where
  # it actually is on this machine -- do not trim this list back.
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
  foreach ($g in $guesses) {
    if ((-not $cli) -and (Test-Path -LiteralPath $g)) { $cli = $g }
  }
  if ($cli) { Note "found (not on PATH): $cli" }
}

if (-not $cli) {
  $winget = Get-Command winget -ErrorAction SilentlyContinue
  if ($winget) {
    Note 'installing via winget (ArduinoSA.CLI)'
    # All four --accept/--silent flags matter: without them winget stops on an
    # agreement prompt and the script hangs forever in CI or a piped shell.
    & winget install --id ArduinoSA.CLI --exact --source winget `
        --accept-package-agreements --accept-source-agreements --silent
    Sync-Path
    $found = Get-Command arduino-cli -ErrorAction SilentlyContinue
    if ($found) { $cli = $found.Source }
    if (-not $cli) {
      $link = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\arduino-cli.exe'
      if (Test-Path -LiteralPath $link) { $cli = $link }
    }
  } else {
    Note 'winget not available'
  }
}

if (-not $cli) {
  Note 'downloading the official Windows zip'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $dest = Join-Path $env:LOCALAPPDATA 'Programs\arduino-cli'
  $zip  = Join-Path $env:TEMP 'arduino-cli-windows.zip'
  try {
    Invoke-WebRequest -Uri $CLI_ZIP -OutFile $zip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Expand-Archive -LiteralPath $zip -DestinationPath $dest -Force
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  } catch {
    Fail "could not download arduino-cli: $($_.Exception.Message)"
  }
  $exe = Join-Path $dest 'arduino-cli.exe'
  if (Test-Path -LiteralPath $exe) {
    $cli = $exe
    Add-UserPath $dest
  }
}

if (-not $cli) {
  Warn 'arduino-cli is still not installed.'
  Note 'Do this by hand, then rerun setup.ps1:'
  Note '  1. download https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip'
  Note "  2. unzip it to $env:LOCALAPPDATA\Programs\arduino-cli"
  Note '  3. add that folder to your user PATH:'
  Note "     [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$env:LOCALAPPDATA\Programs\arduino-cli', 'User')"
  Note '  4. open a NEW PowerShell window'
  Fail 'stopping.'
}

$ver = Get-CliLine (& $cli version)
if ($LASTEXITCODE -ne 0) { Fail "arduino-cli found at $cli but it will not run." }
Note "$cli"
Note "$ver"

if (-not (Get-Command arduino-cli -ErrorAction SilentlyContinue)) {
  Warn 'arduino-cli is NOT on this shell''s PATH (setup will use the full path).'
  Note 'To fix it permanently:'
  Note "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$(Split-Path -Parent $cli)', 'User')"
  Note '  ...then open a NEW PowerShell window.'
}

# =====================================================================
#  2. git  (needed for the Waveshare clone)
# =====================================================================
Say 'git'
$git = $null
$found = Get-Command git -ErrorAction SilentlyContinue
if ($found) {
  $git = $found.Source
  Note "$git"
} else {
  # Git for Windows installs fine but its installer does not always put
  # cmd\ on PATH -- very common on this machine class.
  # Build the candidate list defensively: ${env:ProgramFiles(x86)} is unset on
  # a 32-bit host and Join-Path throws on a null path under -ErrorAction Stop.
  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }
  $guesses = @()
  foreach ($r in $roots) { $guesses += (Join-Path $r 'Git\cmd\git.exe') }
  if ($env:LOCALAPPDATA) { $guesses += (Join-Path $env:LOCALAPPDATA 'Programs\Git\cmd\git.exe') }
  foreach ($g in $guesses) {
    if ((-not $git) -and (Test-Path -LiteralPath $g)) { $git = $g }
  }
  if ($git) {
    $gitDir = Split-Path -Parent $git
    Warn "git is installed but NOT on this PowerShell's PATH."
    Note "found: $git  (setup will use the full path)"
    Note 'One-line permanent fix, then open a NEW PowerShell window:'
    Note "  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path','User') + ';$gitDir', 'User')"
  } else {
    Warn 'git is not installed. Install Git for Windows: https://git-scm.com/download/win'
    Note 'Then rerun setup.ps1. (git is only needed for the vendor libraries step.)'
  }
}

# =====================================================================
#  3. esp32 core
# =====================================================================
Say 'esp32 core'
# `config init` without --overwrite is the idempotent form: it errors out
# harmlessly if a config already exists instead of wiping the user's settings
# (setup.sh uses --overwrite; do not copy that here).
# It writes a red block to stderr when the config already exists, on every
# rerun, so swallow both streams and read the exit code instead. try/catch
# because PS 5.1 turns a native command's redirected stderr into a terminating
# NativeCommandError under $ErrorActionPreference = 'Stop'.
$didInit = $false
try {
  & $cli config init 2>&1 | Out-Null
  $didInit = ($LASTEXITCODE -eq 0)
} catch { $didInit = $false }
if ($didInit) { Note 'created arduino-cli config' } else { Note 'arduino-cli config already exists' }

# -join on the raw array would fold arduino-cli's trailing blank line into the
# string. Harmless for a -like test, but keep the blank-dropping habit.
$urls = ((& $cli config get board_manager.additional_urls) | Where-Object { $_ -and "$_".Trim() }) -join ' '
if ($urls -like "*$CORE_URL*") {
  Note 'board manager url already configured'
} else {
  & $cli config add board_manager.additional_urls $CORE_URL
  if (-not $?) { & $cli config set board_manager.additional_urls $CORE_URL }
  Note 'added esp32 board manager url'
}

# Ask whether the core is already here BEFORE touching the network.
# `core update-index` re-downloads the package index every time it runs, and it
# has nothing to tell us about a core that is already installed. Rerunning
# setup.ps1 on a working machine has to be a fast no-op, not a re-download.
$haveCore = $false
foreach ($line in (& $cli core list)) { if ("$line" -match '^\s*esp32:esp32\s') { $haveCore = $true } }

if ($haveCore) {
  Note 'esp32:esp32 already installed (skipping core update-index)'
} else {
  Note 'refreshing the board index'
  & $cli core update-index
  if ($LASTEXITCODE -ne 0) { Fail 'core update-index failed (no network?)' }
  Note 'installing esp32:esp32 (this is a ~1 GB download, be patient)'
  & $cli core install esp32:esp32
  if ($LASTEXITCODE -ne 0) { Fail 'core install esp32:esp32 failed' }
}

# =====================================================================
#  4. vendor libraries
#
#  Arduino_GFX (CO5300 QSPI AMOLED), Arduino_DriveBus (CST816 touch) and
#  SensorLib (QMI8658 IMU) are BOARD-SPECIFIC WAVESHARE FORKS. The Library
#  Manager versions of the same names will NOT drive this panel or this
#  touch controller -- do not "helpfully" swap them for the upstream
#  releases, the screen just stays black.
# =====================================================================
Say 'vendor libraries'

# Never hardcode Documents\Arduino\libraries. OneDrive Documents redirection is
# ACTIVE on this machine, so the real path is
#     C:\Users\<you>\OneDrive\Documents\Arduino
# and $HOME\Documents\Arduino does not exist at all. Ask arduino-cli where it
# actually looks -- and read the answer through Get-CliLine, because
# `config get` hands back a 2-element array whose second element is blank and
# .Trim() does not fix that. See the banner on Get-CliLine.
$userDir = Get-CliLine (& $cli config get directories.user)

if ($userDir -and $userDir.StartsWith('"') -and $userDir.EndsWith('"')) {
  # Some arduino-cli versions hand the value back as a JSON string literal,
  # i.e. "C:\\Users\\...". Unquote and unescape it.
  try { $userDir = "$($userDir | ConvertFrom-Json)".Trim() }
  catch { $userDir = $userDir.Trim('"').Replace('\\', '\') }
}
if (-not $userDir) {
  # Fallback: the structured dump. Same rule -- coerce to string and trim,
  # never assume a bare property is already a clean scalar.
  $raw = (& $cli config dump --format json) -join "`n"
  $body = Get-JsonBody $raw
  if ($body) {
    $j = $body | ConvertFrom-Json
    if ($j.PSObject.Properties.Name -contains 'config') { $userDir = "$($j.config.directories.user)".Trim() }
    else { $userDir = "$($j.directories.user)".Trim() }
  }
}

# --- HARD GUARD. Do not soften any of this into a warning. ------------
# Everything below builds a destination out of $userDir and copies ~5 MB into
# it. If $userDir is empty the destination collapses to $null, Copy-Item
# cheerfully writes into the CURRENT directory, and five vendor libraries land
# in the repo. Stop dead instead, and say what to run.
if (-not $userDir) {
  Warn 'could not resolve the Arduino user directory from arduino-cli.'
  Note '  arduino-cli config get directories.user   returned nothing usable.'
  Note 'Refusing to continue: without it the vendor-library copy below would'
  Note 'fall back to the current directory and dump five Waveshare libraries'
  Note 'into this repo. Check it by hand:'
  Note '  arduino-cli config get directories.user     # one absolute path'
  Note '  arduino-cli config init                     # if there is no config yet'
  throw 'directories.user did not resolve -- refusing to continue (see above).'
}
if (-not [IO.Path]::IsPathRooted($userDir)) {
  throw "arduino-cli returned a relative directories.user ('$userDir') -- refusing to continue; a relative destination is how files end up in the repo."
}

$libDir = Join-Path $userDir 'libraries'

# Assert the OUTCOME as well as the inputs: the repo is never the libraries
# directory. This is the exact accident the guards above exist to prevent, so
# check it directly rather than trusting that they did their job.
$rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
$libFull  = [IO.Path]::GetFullPath($libDir).TrimEnd('\')
if (($libFull -ieq $rootFull) -or $libFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
  throw "resolved libraries dir '$libFull' is inside the repo '$rootFull' -- refusing to continue."
}

Note "libraries dir: $libDir"
New-Item -ItemType Directory -Force -Path $libDir | Out-Null

$stamp = Join-Path $libDir '.vokal-waveshare-sha'

# The folder EXISTING is not proof the library is in it. The copy below is
# Remove-Tree then Copy-Item -Recurse over ~5 MB and those two statements are
# not atomic: a ctrl-C, a OneDrive lock or a long-path failure in between
# leaves a directory that exists and is empty or half-written. An
# existence-only test then printed 'all five already present -- skipping' on
# the next run, which was a lie, and the compile died on a header that is
# supposedly right there on disk with nothing pointing at -ForceLibs.
# Prove it is real: an Arduino library carries library.properties. Accept a
# fork that ships without one only if it at least has headers in it.
function Test-VendorLib ($dir) {
  if (-not (Test-Path -LiteralPath $dir)) { return $false }
  if (Test-Path -LiteralPath (Join-Path $dir 'library.properties')) { return $true }
  $hdrs = @(Get-ChildItem -LiteralPath $dir -Filter '*.h' -Recurse -File -ErrorAction SilentlyContinue)
  return ($hdrs.Count -gt 0)
}

$haveAll = $true
foreach ($lib in $WS_LIBS) {
  if (-not (Test-VendorLib (Join-Path $libDir $lib))) {
    $haveAll = $false
    if (Test-Path -LiteralPath (Join-Path $libDir $lib)) {
      Warn "$lib is present but incomplete (empty or half-copied)"
    }
  }
}

if ($haveAll -and (-not $ForceLibs)) {
  Note 'all five already present -- skipping (rerun with -ForceLibs to refresh)'
  if (Test-Path -LiteralPath $stamp) {
    Note "vendored from waveshare commit $(Get-Content -LiteralPath $stamp -TotalCount 1)"
  }
} elseif (-not $git) {
  Warn 'skipping vendor libraries: git is not available (see above).'
} else {
  $tmp = Join-Path $env:TEMP ('vokal-ws-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  Remove-Tree $tmp
  Note "cloning $WS_REPO"
  # core.longpaths: the Waveshare tree nests deep enough to blow past
  # MAX_PATH under %TEMP%, and the clone then dies on "Filename too long".
  & $git -c core.longpaths=true clone --depth 1 $WS_REPO $tmp
  if ($LASTEXITCODE -ne 0) { Remove-Tree $tmp; Fail 'git clone failed' }

  # Upstream is unpinned, so record exactly what we took.
  $sha = Get-CliLine (& $git -C $tmp rev-parse HEAD)
  if (-not $sha) { $sha = 'unknown' }
  Note "waveshare commit $sha"

  $src = Join-Path (Join-Path (Join-Path $tmp 'examples') 'arduino-v2') 'libraries'
  if (-not (Test-Path -LiteralPath $src)) {
    Remove-Tree $tmp
    Fail "upstream layout changed: $src does not exist"
  }
  foreach ($lib in $WS_LIBS) {
    $from = Join-Path $src $lib
    if (-not (Test-Path -LiteralPath $from)) { Warn "not in upstream: $lib"; continue }
    $to = Join-Path $libDir $lib
    # Belt and braces. An empty or relative destination does not make Copy-Item
    # fail, it makes it write into the current directory -- which is the repo.
    # Never let it get that far.
    if ((-not $to) -or (-not [IO.Path]::IsPathRooted($to))) {
      Remove-Tree $tmp
      throw "refusing to copy $lib -- destination did not resolve to an absolute path (got '$to')."
    }
    Remove-Tree $to
    Copy-Item -LiteralPath $from -Destination $to -Recurse -Force
    Note "    $lib"
  }
  Set-Content -LiteralPath $stamp -Value $sha -Encoding ascii
  Remove-Tree $tmp
}

# =====================================================================
#  5. secrets.h
# =====================================================================
Say 'secrets'
$secrets = Join-Path (Join-Path $Root 'firmware') 'secrets.h'
$example = Join-Path (Join-Path $Root 'firmware') 'secrets.example.h'
if (Test-Path -LiteralPath $secrets) {
  Note 'firmware\secrets.h already exists'
} else {
  if (-not (Test-Path -LiteralPath $example)) { Fail "missing $example" }
  Copy-Item -LiteralPath $example -Destination $secrets
  Note 'created firmware\secrets.h'
}
# config.h #errors without it, so an unfilled copy still compiles -- which is
# exactly how you end up on stage with a board that will not join the hotspot.
$secretsBody = Get-Content -LiteralPath $secrets -Raw
if ($secretsBody -match 'YOUR_HOTSPOT|hotspotpassword|YOUR_HOME|homepassword') {
  Warn 'firmware\secrets.h still holds the example WIFI_NETWORKS placeholders.'
  Note 'Phone hotspot FIRST -- venue wifi is usually a captive portal the'
  Note 'ESP32 cannot log into. iPhone: turn on "Maximise Compatibility",'
  Note 'the ESP32-S3 has no 5 GHz radio.'
}
if ($secretsBody -match 'VOKAL_HOST\s+"192\.168\.1\.100"') {
  Warn 'firmware\secrets.h still has the placeholder VOKAL_HOST (192.168.1.100).'
  Note 'Set it to the LAPTOP''s LAN IP on the network you both joined --'
  Note 'not localhost, not 127.0.0.1; from the board those mean the board.'
  Note '  ipconfig  ->  IPv4 Address of the Wi-Fi adapter'
  Note 'Check it from a browser first:  http://<that IP>:8000/health'
  Note 'A hotspot hands out a new lease every time it is switched on, so'
  Note 'this is the line you will be editing thirty seconds before the demo.'
}
Note 'firmware\secrets.h is gitignored. Never commit a key.'

# =====================================================================
#  6. compile check
# =====================================================================
if ($SkipCompileCheck) {
  Say 'compile check skipped (-SkipCompileCheck)'
  Write-Host ''
  Note 'next:  .\flash.ps1'
  exit 0
}

Say 'compile check'
Note $FQBN
$sketchDir = Join-Path $Root 'firmware'
& $cli compile --fqbn $FQBN $sketchDir
if ($LASTEXITCODE -eq 0) {
  Write-Host '    OK -- now: .\flash.ps1' -ForegroundColor Green
  exit 0
} else {
  Write-Host '    FAILED' -ForegroundColor Red
  Note 'Common causes:'
  Note '  - vendor libraries went to the wrong place (check the libraries dir printed above)'
  Note '  - vendor libraries are present but incomplete -- rerun: .\setup.ps1 -ForceLibs'
  Note '  - firmware\secrets.h missing or malformed'
  Note '  - esp32 core did not finish installing -- rerun setup.ps1'
  exit 1
}
