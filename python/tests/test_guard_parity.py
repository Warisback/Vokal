"""The app's guard (app/js/guard.js) and this package's guard give the same results.

Node runs the app's own guard module on 30,000 seeded random strings, and the output
of tidy, normalise and guard_text is compared with the Python versions. Skipped when
Node is not on the path. Random characters are drawn from those assigned in Python's
Unicode database, so characters added to Unicode after that version are not covered.
"""

from __future__ import annotations

import json
import random
import shutil
import subprocess
import unicodedata
from dataclasses import asdict
from pathlib import Path

import pytest

from vokal.guard import FILLER_PHRASES, guard_text, normalise, tidy

GUARD_JS = Path(__file__).resolve().parents[2] / "app" / "js" / "guard.js"
COUNT = 30_000
SEED = 20261014

# Reads a JSON list of strings on stdin and prints what the app's guard makes of each.
NODE_SCRIPT = """
const { tidy, normalise, guardText } = await import(process.argv[1]);
let input = '';
for await (const chunk of process.stdin) input += chunk;
const out = JSON.parse(input).map((text) => ({
  tidy: tidy(text),
  norm: normalise(text.normalize('NFC')),
  guard: guardText(text),
}));
process.stdout.write(JSON.stringify(out));
"""

# Pieces the guard has rules for, plus case, accent and script edge cases.
WORDS = list(FILLER_PHRASES) + [
    "I want water", "help", "www.", "amara.org", "Subtitles by", "Music", "laughs",
    "BLANK_AUDIO", "Thank you very much",
    "ΟΔΟΣ",  # Greek capitals, final sigma when lower-cased
    "İstanbul",  # dotted capital I
    "Straße", "ﬁne", "水", "Ⅻ", "²", "café", "café",
]
MARKS = list(".!?…,;:'\"-()[]♪♫♬¡¿。") + ["...", "!!", "?!"]
SPACES = [
    " ", "  ", "\t", "\n", "\r\n", " ", "　", " ", "\u0085",
    "\u001c", "\u001f", "﻿", "​", " ", "\u000b",
]


def random_strings(count: int, seed: int) -> list[str]:
    rng = random.Random(seed)

    def any_character() -> str:
        while True:
            point = rng.randrange(0x20, 0x30000)
            if 0xD800 <= point <= 0xDFFF or unicodedata.category(chr(point)) == "Cn":
                continue
            return chr(point)

    strings = []
    for _ in range(count):
        parts = []
        for _ in range(rng.randint(1, 8)):
            roll = rng.random()
            if roll < 0.35:
                word = rng.choice(WORDS)
                parts.append(word if rng.random() < 0.7 else word.upper())
            elif roll < 0.6:
                parts.append(rng.choice(MARKS))
            elif roll < 0.85:
                parts.append(rng.choice(SPACES))
            else:
                parts.append("".join(any_character() for _ in range(rng.randint(1, 4))))
        strings.append("".join(parts))
    return strings


def python_result(text: str) -> dict:
    result = guard_text(text)
    return {
        "tidy": tidy(text),
        "norm": normalise(unicodedata.normalize("NFC", text)),
        "guard": {"text": result.text, "removed": [asdict(entry) for entry in result.removed]},
    }


@pytest.mark.skipif(shutil.which("node") is None, reason="Node is not on the path")
def test_javascript_and_python_guards_agree():
    inputs = random_strings(COUNT, SEED)
    completed = subprocess.run(
        ["node", "--input-type=module", "-e", NODE_SCRIPT, GUARD_JS.as_uri()],
        input=json.dumps(inputs, ensure_ascii=True),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
        check=True,
    )
    from_js = json.loads(completed.stdout)
    assert len(from_js) == len(inputs)

    differences = [
        (text, mine, theirs)
        for text, theirs in zip(inputs, from_js)
        if (mine := python_result(text)) != theirs
    ]
    assert not differences, (
        f"{len(differences)} of {len(inputs)} strings differ "
        f"(Python's Unicode database is {unicodedata.unidata_version}). First: {differences[0]!r}"
    )
