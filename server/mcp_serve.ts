/**
 * Local MCP servers that TinyWebUI starts over HTTP rather than stdio.
 *
 * A server entry in mcp.json with a `command` may carry
 *
 *   "serve": {
 *     "proxyToken": { "env": "TINYCONTEXT_TRUSTED_PROXY_TOKEN", "header": "X-TinyContext-Proxy-Token" },
 *     "managementToken": "TINYCONTEXT_MANAGEMENT_TOKEN",
 *     "secrets": ["TINYCONTEXT_TENANT_SECRET"]
 *   }
 *
 * which means: start the command as an HTTP server on a free loopback port
 * (MCP_TRANSPORT=streamable-http, MCP_HOST=127.0.0.1, MCP_PORT, the TinySuite
 * convention) and connect to it there. Over HTTP a server can tell its
 * callers apart, so such an entry may take an `identity` (mcp_identity.ts)
 * and one process serves every user, each on a connection of their own --
 * the separation is the server's own (TinyContext's hosted tenancy,
 * TinySearch's trusted identity), TinyWebUI only proves who is calling.
 *
 * - `proxyToken`: a fresh random token for each launch, given to the server in
 *   that env var and sent by TinyWebUI as that header on every request, so
 *   that nothing else on the machine can pose as TinyWebUI.
 * - `managementToken`: likewise fresh per launch, sent as a bearer token on
 *   the server-wide connection only (the one that reads instance views),
 *   never on a user's own.
 * - `secrets`: env vars that must survive restarts (TinyContext names each
 *   user's store with its tenant secret), generated once and kept in
 *   tinywebui.secrets.json.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createConnection, createServer } from 'node:net';
import type { McpServerSpec } from './config/config.ts';

export interface ServeSpec {
  proxyToken?: { env: string; header: string };
  managementToken?: string;
  secrets?: string[];
}

/** A launched server: where it listens and what every request to it carries. */
export interface Served {
  url: string;
  /** Headers for every connection (the proxy token). */
  headers: Record<string, string>;
  /** Headers for the server-wide connection only (the management token). */
  sharedHeaders: Record<string, string>;
  child: ChildProcess;
  /** Resolves when the process has exited, for whatever reason. */
  exited: Promise<void>;
  stop(): void;
}

// The first start of a uvx server downloads it and its models.
export const SERVE_START_MS = 10 * 60_000;
const ENV = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// Set by TinyWebUI on every launch; a server's env may not override them.
const OWNED_ENV = ['MCP_TRANSPORT', 'MCP_HOST', 'MCP_PORT'];

/** Every problem with one server's `serve` setting. Empty when it has none or it is valid. */
export function serveProblems(name: string, spec: McpServerSpec): string[] {
  const serve = spec.serve as unknown;
  if (serve === undefined) return [];
  const where = `mcpServers.${name}.serve`;
  if (!serve || typeof serve !== 'object' || Array.isArray(serve)) return [`${where} must be an object`];
  const { proxyToken, managementToken, secrets, ...rest } = serve as Record<string, unknown>;
  const problems = Object.keys(rest).map((key) => `${where}.${key} is not a known setting`);
  if (!spec.command) problems.push(`${where} needs a "command": TinyWebUI starts the server itself`);
  if (spec.url) problems.push(`${where} cannot be used with "url": TinyWebUI picks the address`);
  const envName = (v: unknown, at: string) => {
    if (typeof v !== 'string' || !ENV.test(v)) problems.push(`${at} must be an environment variable name`);
    else if (OWNED_ENV.includes(v)) problems.push(`${at} cannot be ${v}: TinyWebUI sets it`);
  };
  if (proxyToken !== undefined) {
    if (!proxyToken || typeof proxyToken !== 'object' || Array.isArray(proxyToken)) {
      problems.push(`${where}.proxyToken must be { "env": ..., "header": ... }`);
    } else {
      const { env, header } = proxyToken as Record<string, unknown>;
      envName(env, `${where}.proxyToken.env`);
      if (typeof header !== 'string' || !HEADER.test(header)) problems.push(`${where}.proxyToken.header must be an HTTP header name`);
      else if (spec.identity && header.toLowerCase() === spec.identity.header?.toLowerCase()) {
        problems.push(`${where}.proxyToken.header cannot be the identity header`);
      }
    }
  }
  if (managementToken !== undefined) envName(managementToken, `${where}.managementToken`);
  if (secrets !== undefined) {
    if (!Array.isArray(secrets)) problems.push(`${where}.secrets must be a list of environment variable names`);
    else secrets.forEach((s, i) => envName(s, `${where}.secrets[${i}]`));
  }
  for (const key of OWNED_ENV) {
    if (spec.env && key in spec.env) problems.push(`mcpServers.${name}.env.${key} is set by TinyWebUI for a served server`);
  }
  return problems;
}

/** A loopback port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

const accepts = (port: number) => new Promise<boolean>((resolve) => {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

// Children still running when this process exits, however it exits.
const live = new Set<ChildProcess>();
let exitHook = false;

/** Ends a child and everything it started: uvx runs the server as a child of its own. */
function stopTree(child: ChildProcess): void {
  live.delete(child);
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  }
}

/**
 * Starts `spec.command` as an HTTP MCP server and resolves once it accepts
 * connections. `env` is the server's own env, already expanded; `secret(name)`
 * returns a stored secret, generating it on first use. Rejects with the
 * server's last lines of output if it exits first, or after SERVE_START_MS.
 */
export async function launchServed(spec: McpServerSpec & { serve: ServeSpec }, {
  env, args, secret, onLine, startMs = SERVE_START_MS
}: {
  env: Record<string, string>;
  args: string[];
  secret: (name: string) => string;
  onLine: (line: string) => void;
  startMs?: number;
}): Promise<Served> {
  const port = await freePort();
  const serve = spec.serve;
  const token = () => randomBytes(32).toString('hex');
  const proxy = serve.proxyToken ? token() : null;
  const management = serve.managementToken ? token() : null;
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...env,
    ...Object.fromEntries((serve.secrets || []).map((name) => [name, secret(name)])),
    ...(proxy ? { [serve.proxyToken!.env]: proxy } : {}),
    ...(management ? { [serve.managementToken!]: management } : {}),
    MCP_TRANSPORT: 'streamable-http',
    MCP_HOST: '127.0.0.1',
    MCP_PORT: String(port)
  };
  const child = spawn(spec.command!, args, {
    env: childEnv,
    cwd: spec.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Its own process group on POSIX, so stopTree can end the whole tree.
    detached: process.platform !== 'win32'
  });
  live.add(child);
  if (!exitHook) {
    exitHook = true;
    process.once('exit', () => { for (const c of [...live]) stopTree(c); });
  }

  const recent: string[] = [];
  for (const stream of [child.stdout, child.stderr]) {
    let buf = '';
    stream?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines.map((l) => l.trimEnd()).filter(Boolean)) {
        recent.push(line);
        if (recent.length > 8) recent.shift();
        onLine(line);
      }
    });
    stream?.on('error', () => { /* the child is going away */ });
  }
  let exitInfo: string | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => { live.delete(child); exitInfo = signal ? `signal ${signal}` : `code ${code}`; resolve(); });
    child.once('error', (err) => { live.delete(child); exitInfo = err.message; resolve(); });
  });

  const deadline = Date.now() + startMs;
  while (!(await accepts(port))) {
    if (exitInfo !== null) {
      const tail = recent.length ? `: ${recent.slice(-3).join(' | ')}` : '';
      throw new Error(`exited before it was ready (${exitInfo})${tail}`);
    }
    if (Date.now() > deadline) {
      stopTree(child);
      throw new Error(`did not start listening within ${Math.round(startMs / 1000)}s`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: proxy ? { [serve.proxyToken!.header]: proxy } : {},
    sharedHeaders: management ? { Authorization: `Bearer ${management}` } : {},
    child,
    exited,
    stop: () => stopTree(child)
  };
}
