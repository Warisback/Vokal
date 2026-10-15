// Downloads the pinned transformers.js build into app/vendor/ and checks it byte for byte.
// The file is not committed: it is a 580 KB third-party build, and GitHub's secret scanner
// misreads one of its minified strings as an API key. Run it once after cloning:
//   npm run vendor --prefix app
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const VERSION = '4.3.0';
const SHA256 = '1475fd440e9932ab206682ee42cb18f6097403e9ee77ea62084c592d0f83597d';
const URL_ = `https://cdn.jsdelivr.net/npm/@huggingface/transformers@${VERSION}/dist/transformers.min.js`;
const TARGET = fileURLToPath(new URL('../app/vendor/transformers.min.js', import.meta.url));

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

if (existsSync(TARGET) && sha256(readFileSync(TARGET)) === SHA256) {
  console.log(`transformers.js ${VERSION} is already in app/vendor/ (SHA-256 matches).`);
  process.exit(0);
}

const response = await fetch(URL_);
if (!response.ok) {
  console.error(`Download failed: HTTP ${response.status} from ${URL_}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
const digest = sha256(bytes);
if (digest !== SHA256) {
  console.error(`SHA-256 mismatch for ${URL_}\n  expected ${SHA256}\n  got      ${digest}`);
  process.exit(1);
}
mkdirSync(path.dirname(TARGET), { recursive: true });
writeFileSync(TARGET, bytes);
console.log(`Saved transformers.js ${VERSION} to app/vendor/ (${bytes.length} bytes, SHA-256 checked).`);
