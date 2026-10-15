# Vokal server

An optional local server for Vokal. It is plain Node with no dependencies, and it does three things:

1. Serves `app/` for local development, from `/` or from a sub-path such as `/Vokal/`.
2. Serves local model folders, so a fine-tuned speech model can be tried in the app without uploading it anywhere.
3. Offers text suggestions. `POST api/correct` asks a language model whether the words on screen contain a recognition mistake that matches one of the person's saved phrases.

Speech to text is not here. It runs on the device, in the browser. The app works without this server, and suggestions stay off until a server address is set in the app's Settings.

The server is meant for one person's own computer. It has not been built or reviewed for public hosting.

## Run it

Node 22.9 or later. There is nothing to install.

```
npm start --prefix server
```

This reads `server/.env` if it exists and prints one line:

```
Vokal server: http://127.0.0.1:3210/
```

To serve the app under the same sub-path GitHub Pages uses:

```
node server/server.mjs --base /Vokal/
```

| Flag | Default | Meaning |
|---|---|---|
| `--port` | `PORT`, else 3210 | `0` picks a free port; the startup line shows the real one |
| `--host` | `127.0.0.1` | address to listen on |
| `--base` | `/` | sub-path for everything; must start and end with `/` |
| `--app` | `../app` next to `server.mjs` | folder with the web app |
| `--models` | `<app>/models` | folder served at `<base>models/` |
| `--isolate` | off | adds COOP, COEP and CORP headers so WebAssembly can use several threads |

Phones only allow the microphone on HTTPS pages, so opening the app over plain HTTP on the local network will not record. Use the GitHub Pages build, or an HTTPS tunnel after reading the tunnel section below.

## Settings

Copy `server/.env.example` to `server/.env` and fill in what you use. `npm start` reads that file. Running `node server/server.mjs` directly does not, so use `node --env-file=server/.env server/server.mjs` instead. `.env` is ignored by git.

| Variable | Meaning |
|---|---|
| `VOKAL_LLM_PROVIDER` | `google` (default) or `openai-compatible` |
| `VOKAL_LLM_MODEL` | model name; Google default `gemma-4-26b-a4b-it`; required for `openai-compatible` |
| `GOOGLE_API_KEY` | key for the Gemini API |
| `VOKAL_LLM_BASE_URL` | for `openai-compatible`, for example `http://127.0.0.1:8080/v1` (llama.cpp or Ollama) |
| `VOKAL_LLM_API_KEY` | for `openai-compatible`; optional for a local server |
| `VOKAL_LLM_TIMEOUT_MS` | limit on one provider call, 1000 to 45000, default 45000 |
| `VOKAL_ALLOWED_ORIGINS` | comma-separated web origins allowed to call the API from a browser, for example `https://warisback.github.io` |
| `VOKAL_ACCESS_TOKEN` | server key, at least 24 characters; required for any request that does not come from this computer |
| `PORT` | port when `--port` is not given |

With no provider key the server still serves the app. `GET api/health` then reports `configured: false` and the app turns suggestions off. A value that is present but wrong, such as a short token or a timeout out of range, turns the API off (503 `INVALID_CONFIGURATION`) and the log names the variable, never its value.

## What it sends, and where

- The app sends the words on screen (`text`) and up to 20 saved phrases (`heard` and `intended`) that were recorded with the speech model in use. No audio.
- With `google`, the server sends the prompt and that data to the Gemini API at `generativelanguage.googleapis.com`, with the key in the `x-goog-api-key` header. Google's terms for the Gemini API apply to the text from there.
- With `openai-compatible`, it sends the same to the base URL you set. With a model server running on this computer, such as llama.cpp or Ollama, the text never leaves the computer. Neither has been tried with this server yet.
- The log has one startup line, then status and error code only. It never holds the words, the suggestion, a key or the token. Provider error bodies are never read, because they can echo the request.

## Suggestions

Request, `Content-Type: application/json`, at most 64 KB:

```json
{ "text": "I need wader", "phrases": [ { "heard": "I need wader", "intended": "I need water" } ] }
```

`text` is 1 to 2000 characters after trimming. `phrases` is optional: at most 20 items with exactly `heard` and `intended`, each 1 to 300 characters. Control characters are refused, except tabs and line breaks in `text`. Any other field is refused.

Reply, HTTP 200 (example values):

```json
{ "raw": "I need wader", "suggested": "I need water", "changed": true, "uncertain": false, "degraded": false,
  "reason": null, "note": "Suggested fix only. Check the words before speaking.",
  "model": "gemma-4-26b-a4b-it", "timing": { "correction_ms": 9210 } }
```

When the provider fails, times out, answers in the wrong shape or proposes an unsafe change, the reply is still 200 with `degraded: true`, `suggested` equal to `raw` and a `reason`: `PROVIDER_TIMEOUT`, `PROVIDER_QUOTA`, `PROVIDER_AUTH`, `PROVIDER_REJECTED`, `PROVIDER_UNAVAILABLE`, `MODEL_UNAVAILABLE`, `INVALID_MODEL_OUTPUT` or `UNSAFE_CORRECTION`. The person's words are always still usable.

A suggestion is a proposal. The app shows it beside the person's words and never applies or speaks it on its own. Before replying, the server rejects a suggestion that adds or removes a negation, changes a number word or a digit group, or changes more than 30% of the words (one changed word is always allowed). These checks do not catch everything: names, pronouns and tense are asked for in the prompt but not checked, and a single swapped word ("water" to "warfarin") passes. The person's review is the real safeguard. `ml/README.md` lists these as open questions.

Errors end the request before any provider call, as `{ "error": { "code", "message" } }`:

| Code | Status |
|---|---|
| `INVALID_REQUEST`, `INVALID_JSON` | 400 |
| `UNAUTHORIZED` | 401, with `WWW-Authenticate: Bearer` |
| `FORBIDDEN_ORIGIN`, `REMOTE_NOT_ALLOWED` | 403 |
| `NOT_FOUND` | 404 |
| `METHOD_NOT_ALLOWED` | 405, with `Allow` |
| `REQUEST_TIMEOUT` | 408 (the body took more than 8 s) |
| `BODY_TOO_LARGE` | 413 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 |
| `INTERNAL_ERROR` | 500 |
| `NOT_CONFIGURED`, `INVALID_CONFIGURATION` | 503 |

`GET api/health` answers `{ "ok": true, "correction": { "configured": true, "provider": "google", "model": "gemma-4-26b-a4b-it" } }`. It makes no provider call.

Speed: the earlier prototype took 9 to 25 s per suggestion with hosted Gemma (`gemma-4-26b-a4b-it`), measured in September 2026 from a laptop on localhost. This server has not made a live call yet. The provider call stops at 45 s, before the app's own 50 s limit, so the app never gives up while the server is still spending quota. There is no retry.

## Who may call the API

These rules apply to `api/*`, in this order:

1. Origin. A browser request is same-origin when it says `Sec-Fetch-Site: same-origin`, or when the host in its `Origin` header matches the `Host` header (the scheme is ignored, so a page opened through an HTTPS tunnel can still call its own server). Any other origin must be listed in `VOKAL_ALLOWED_ORIGINS`, else 403 `FORBIDDEN_ORIGIN`. Requests without `Origin`, such as curl, skip this step.
2. CORS. A listed origin gets CORS headers, including `Authorization` in the allowed headers and `Access-Control-Allow-Private-Network: true` when a preflight asks for it. Chrome is replacing that header with a Local Network Access permission prompt, so test in current Chrome rather than rely on it.
3. Locality and the server key. A request counts as local only when it comes from a loopback address, its `Host` is `localhost`, `127.0.0.1` or `[::1]`, and it has no forwarding header (`Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Real-IP`, `CF-Connecting-IP`). Local requests need no key. Every other request needs `Authorization: Bearer <VOKAL_ACCESS_TOKEN>`. Without a token set, they get 403 `REMOTE_NOT_ALLOWED`; with a missing or wrong key, 401 `UNAUTHORIZED`.

The rule looks at each request, not at the listening address, because a tunnel runs on the same computer and connects from loopback. The `Host` check also blocks DNS rebinding.

## Using it from a phone through a tunnel

A tunnel publishes the suggestion endpoint to the internet, with your provider key behind it. If you use one:

1. Make a token: `node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"`
2. Put it in `server/.env` as `VOKAL_ACCESS_TOKEN` and start the server.
3. Start the tunnel, for example `cloudflared tunnel --url http://127.0.0.1:3210`.
4. In the app, Settings, Suggestions: set the server address to the tunnel URL and the server key to the same token. If the app itself is opened from GitHub Pages, also add `https://warisback.github.io` to `VOKAL_ALLOWED_ORIGINS`.
5. Stop the tunnel when you are done.

Static files and everything under `--models` are served without a key to anyone who can reach the server. Do not point `--models` at weights you are not allowed to share while a tunnel is open.

## Local models

`--models <dir>` serves `<base>models/<name>/...` from that folder, so model files can live outside the repository (and outside OneDrive). In the app, choose Settings, Custom model, and enter `models/<name>`. The folder layout and export steps are in `ml/README.md`. This only works with this server; GitHub Pages has no model files.

## Headers

Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `Permissions-Policy: microphone=(self), camera=(), geolocation=()`. Static files are sent with `Cache-Control: no-cache`, API replies with `no-store`.

`Content-Security-Policy` depends on the file:

- HTML gets the same policy as the meta tag in `app/index.html`, plus `frame-ancestors 'none'`, which a meta tag cannot set. A test fails if the two drift apart.
- JavaScript gets the policy a worker runs under, because a worker does not inherit the page's meta tag. It allows scripts from this server, `blob:` and WebAssembly compilation (the ONNX Runtime is fetched from `cdn.jsdelivr.net` and started from a `blob:` URL), and connections only to this server, `cdn.jsdelivr.net`, `huggingface.co` and its CDN hosts under `hf.co`.
- Everything else, including API replies, gets `default-src 'none'`.

Checked on 2026-10-14 in headless Edge 155 on Windows 11: with these headers, `onnx-community/whisper-tiny.en` loaded from the Hub (through `us.aws.cdn.hf.co`) and from a local folder, and transcribed a synthetic sentence with no policy violation. A fetch from the worker to a host not on the list was blocked. With `--isolate` the runtime used 4 threads.

Only files with a known extension are served (`.html .js .mjs .css .json .webmanifest .svg .png .ico .wav .onnx .txt`). Dotfiles, `..` segments (plain or encoded), backslashes, colons and links that lead outside the folder give 404. There are no directory listings.

## Tests

```
npm test --prefix server
```

The tests need no network and no install. Providers are replaced by fakes, and no test calls a real language model.

## Files

| File | Purpose |
|---|---|
| `server.mjs` | flags, `createServer`, routing |
| `lib/correct.js` | request validation, prompt, parsing the model's answer, `correctionIsSafe`, the result |
| `lib/providers.js` | Google and OpenAI-compatible clients, timeout, status mapping, model settings |
| `lib/http.js` | JSON bodies with limits, origin rule, CORS, locality and the server key |
| `lib/static.js` | static files, models folder, MIME types, path checks, headers and policies |
| `lib/errors.js` | fixed error codes, statuses and messages |
