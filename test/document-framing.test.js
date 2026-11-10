// The file viewer frames a PDF from the app's own origin. That one response
// may be framed by the app; every other response may not be framed at all.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'tinywebui-framing-'));
writeFileSync(join(dir, 'mcp.json'), '{ "mcpServers": {} }');
const dbPath = join(dir, 'chats.db');
const { start } = await import('../server/server.ts');
const srv = await start({
  port: 0, host: '127.0.0.1', configFile: false, mcpServers: {}, dbPath,
  config: { authMode: 'local', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm', retrieval: { mode: 'lexical' } }
});
test.after(() => srv.shutdown());
const base = `http://127.0.0.1:${srv.address().port}`;

const { Store } = await import('../server/store/index.ts');
const side = new Store(dbPath);
const chat = side.chats.create({ title: 'files' });
const pdf = side.documents.add(chat.id, { filename: 'report.pdf', content: 'text', original: new Uint8Array([37, 80, 68, 70]) });
const docx = side.documents.add(chat.id, { filename: 'notes.docx', content: 'text', original: new Uint8Array([80, 75, 3, 4]) });
side.close();

const headers = async (path) => {
  const res = await fetch(`${base}${path}`);
  await res.arrayBuffer();
  return { csp: res.headers.get('content-security-policy'), xfo: res.headers.get('x-frame-options'), status: res.status };
};

test('a PDF the viewer frames may be framed by the app, and only by it', async () => {
  const h = await headers(`/api/documents/${pdf.id}/original`);
  assert.equal(h.status, 200);
  assert.match(h.csp, /frame-ancestors 'self'/);
  assert.equal(h.xfo, 'SAMEORIGIN');
});

test('everything else still refuses to be framed', async () => {
  for (const path of [`/api/documents/${docx.id}/original`, '/api/chats', '/']) {
    const h = await headers(path);
    assert.match(h.csp, /frame-ancestors 'none'/, path);
    assert.equal(h.xfo, 'DENY', path);
  }
});
