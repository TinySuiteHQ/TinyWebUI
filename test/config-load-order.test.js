// config.ts reads $TINYWEBUI_CONFIG and $TINYWEBUI_MCP once, when it loads.
// Tests import the hub and tools at the top, then point those variables at a
// temporary folder before starting a server. If importing the hub loaded
// config.ts on the way, it would settle on the real files in the working
// folder first, and that server would run against the developer's own config
// and mcp.json (it did once, and hung). So: importing them must not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('importing the MCP hub and its tool leaves config.ts to read the paths set after', () => {
  const dir = mkdtempSync(join(tmpdir(), 'twui-load-order-'));
  const script = `
    await import('./server/mcp.ts');
    await import('./server/tools/mcp_tool.ts');
    process.env.TINYWEBUI_CONFIG = ${JSON.stringify(join(dir, 'config.json'))};
    process.env.TINYWEBUI_MCP = ${JSON.stringify(join(dir, 'mcp.json'))};
    const { configPath, mcpPath } = await import('./server/config/config.ts');
    console.log(JSON.stringify({ config: configPath(), mcp: mcpPath() }));
  `;
  const env = { ...process.env };
  delete env.TINYWEBUI_CONFIG;
  delete env.TINYWEBUI_MCP;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { config: join(dir, 'config.json'), mcp: join(dir, 'mcp.json') });
});
