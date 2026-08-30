# Vokal demo launcher.
#
#   .\run-vokal.ps1
#
# Run this BEFORE joining the puck's wifi. It warms the models on internet,
# then tells you when to switch. Whisper and Piper are local, so once warm it
# never needs the network again -- which is the only reason this demo can work
# on an access point with no internet.
$ErrorActionPreference = "Stop"
$py   = "C:\vokal-venv\Scripts\python.exe"
$repo = Split-Path -Parent $MyInvocation.MyCommand.Definition

Write-Host ""
Write-Host "  VOKAL" -ForegroundColor Cyan
Write-Host "  board mic -> wifi -> speech-to-text -> voice -> LAPTOP SPEAKERS" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  1. Models load now (needs ~5s, no network once loaded)"
Write-Host "  2. THEN join wifi 'vokal-puck', password 'vokal1234'"
Write-Host "  3. Press RECORD on the puck, speak, press STOP"
Write-Host ""
Write-Host "  Ctrl+C to stop." -ForegroundColor DarkGray
Write-Host ""

& $py -u (Join-Path $repo "tools\vokal_client.py")
