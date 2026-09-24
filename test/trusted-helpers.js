// Shared setup for the trusted-header suites: a server in trusted-header mode
// on loopback (the "gateway"), and a client that speaks as a given identity.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function trustedServer(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tinywebui-trusted-'));
  const { start } = await import('../src/server.js');
  const srv = await start({
    port: 0, host: '127.0.0.1', configFile: false, mcpServers: {},
    dbPath: join(dir, 'chats.db'),
    config: {
      authMode: 'trusted-header',
      trustedProxyCidrs: ['127.0.0.1/32', '::1/128'],
      baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'm',
      ...extra
    }
  });
  const base = `http://127.0.0.1:${srv.address().port}`;

  /** fetch as an identity: { id, email?, name?, role? } or null for no headers. */
  const as = (who) => async (path, { method = 'GET', body } = {}) => {
    const headers = { 'content-type': 'application/json' };
    if (who?.id) headers['x-tinysuite-user-id'] = who.id;
    if (who?.email) headers['x-tinysuite-email'] = who.email;
    if (who?.name) headers['x-tinysuite-name'] = who.name;
    if (who?.role) headers['x-tinysuite-role'] = who.role;
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  };
  return { srv, base, as, dir };
}
