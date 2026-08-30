#!/usr/bin/env bash
# End-to-end check of the puck's HTTP API.
# Join the "vokal-puck" wifi first (password vokal1234).
P=http://192.168.4.1
say() { printf "\n\033[1m== %s\033[0m\n" "$1"; }

say "reachable?"
curl -s -m 3 $P/status >/dev/null || { echo "NOT REACHABLE - join the vokal-puck wifi"; exit 1; }

say "set the RTC from this laptop (no internet on the AP)"
curl -s -X POST --data-binary "$(date +%Y-%m-%dT%H:%M:%S)" $P/time; echo

say "status"
curl -s $P/status; echo

say "marks"
curl -s $P/marks.json; echo

say "download audio"
TAKE=$(curl -s $P/status | sed 's/.*"take":\([0-9]*\).*/\1/')
STARTED=$(curl -s $P/status | sed 's/.*"started":"\([^"]*\)".*/\1/')
NAME="take${TAKE}_${STARTED//:/-}.wav"
[ -z "$STARTED" ] && NAME="take${TAKE}.wav"
curl -s -o "$NAME" $P/audio.wav && ls -lh "$NAME"
say "file type (should say WAVE audio, 16000 Hz, mono)"
file "$NAME"

say "post a fake transcript back to the puck"
curl -s -X POST --data-binary "This is a test transcript posted from the laptop. It should appear on the review screen." $P/transcript; echo

echo ""
echo "Now: press RECORD then STOP on the puck, and run this again."
echo "The take number must increase. Play $NAME to check the audio."
