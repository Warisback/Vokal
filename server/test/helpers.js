// Shared test helpers: temp folders, a fake provider, an in-process server and a raw HTTP
// client (node:http sends the path exactly as given, which the traversal tests need).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

export function tempDir(t, prefix = 'vokal-server-') {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, ...name.split('/'));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
}

// Answers in order; an Error in the list is thrown instead. Records every request.
export function fakeProvider(answers = [], { configured = true, model = 'fake-model' } = {}) {
  const calls = [];
  return {
    name: 'fake',
    model,
    configured,
    calls,
    async generate(request) {
      calls.push(request);
      const answer = answers[calls.length - 1];
      if (answer instanceof Error) throw answer;
      if (answer === undefined) throw new Error('unexpected provider call');
      return answer;
    },
  };
}

export function proposal(suggested, uncertain = false) {
  return JSON.stringify({ suggested, uncertain });
}

export async function startServer(t, options = {}) {
  const logs = [];
  const server = createServer({ env: {}, log: (line) => logs.push(line), ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections();
  }));
  return { port: server.address().port, logs };
}

export function request(port, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          // Not every reply is JSON.
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
