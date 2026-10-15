# Test audio

`short-16k.wav` is synthetic speech, not a person's voice. It says "Could you pass me the water, please?" (3.16 s, 16 kHz, 16-bit mono PCM). It was made on Windows 11 with System.Speech and the voice Microsoft David Desktop:

```powershell
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.SelectVoice('Microsoft David Desktop')
$s.SetOutputToWaveFile("$PWD\short-16k.wav", $format)
$s.Speak('Could you pass me the water, please?')
$s.Dispose()
```

The browser test (`tests/e2e.mjs`) makes its other audio when it runs: a longer sentence with the same command, and 3 s of near-silence (seeded noise at about -55 dBFS).

Recordings of real people are not added to this repo.
