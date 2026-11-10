/**
 * Per-user identity for shared MCP servers.
 *
 * A server entry in mcp.json may carry
 *
 *   "identity": { "header": "X-TinyContext-User-Id", "claim": "id" }
 *
 * which means: this server keeps data per user, so every call to it goes out
 * on a connection of that user's own, with `header` set to the signed-in
 * user's `claim`. TinyWebUI is the trusted proxy here. The value comes from
 * the session that started the turn (the chat's owner), never from the
 * browser, the model's arguments or the server, and the connection that
 * carries it is never shared with another user -- so there is no mutable
 * header for two concurrent turns to race on. The server still has to check
 * that the header came from TinyWebUI (TinyContext's trusted-proxy CIDRs).
 *
 * Only HTTP servers can take an identity -- remote (url), or local ones
 * TinyWebUI starts over HTTP (serve, mcp_serve.ts): a stdio server is one
 * process, and in a multi-user deployment everyone shares it.
 */

import type { McpServerSpec } from '../config/config.ts';
import type { UserRow } from '../store/users.ts';

export type IdentityClaim = 'id' | 'externalId' | 'email';
export const IDENTITY_CLAIMS: readonly IdentityClaim[] = ['id', 'externalId', 'email'];

export interface IdentitySpec { header: string; claim?: IdentityClaim }

/**
 * Who the server-wide connection (tool listing, instructions, management
 * manifest) says it is. It is never used for a user's call: a bound server's
 * tools only run on a user's own connection.
 */
export const DISCOVERY_PRINCIPAL = 'urn:tinywebui:discovery';

/** What a no-login install, one person, identifies as. */
export const LOCAL_PRINCIPAL = 'local';

const HEADER = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// Headers the transport or HTTP itself owns: an identity there would be
// overwritten, or would overwrite something the connection depends on.
const RESERVED = new Set([
  'accept', 'authorization', 'connection', 'content-length', 'content-type', 'cookie', 'host',
  'last-event-id', 'mcp-protocol-version', 'mcp-session-id', 'proxy-authorization', 'transfer-encoding'
]);
const VALUE = /^[^\x00-\x1f\x7f]{1,256}$/;

/** Every problem with one server's identity setting. Empty when it has none or it is valid. */
export function identityProblems(name: string, spec: McpServerSpec): string[] {
  const identity = spec.identity as unknown;
  if (identity === undefined) return [];
  const where = `mcpServers.${name}.identity`;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return [`${where} must be an object`];
  const { header, claim, ...rest } = identity as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(rest)) problems.push(`${where}.${key} is not a known setting`);
  if (!spec.url && !spec.serve) {
    problems.push(`${where} needs an HTTP server ("url", or "serve" to start one locally): a stdio server is one process every user shares`);
  }
  if (typeof header !== 'string' || !HEADER.test(header)) {
    problems.push(`${where}.header must be an HTTP header name, e.g. "X-TinyContext-User-Id"`);
  } else {
    if (RESERVED.has(header.toLowerCase())) problems.push(`${where}.header cannot be "${header}": the connection itself uses it`);
    const clash = Object.keys(spec.headers || {}).find((h) => h.toLowerCase() === header.toLowerCase());
    if (clash) problems.push(`mcpServers.${name}.headers.${clash} would let a fixed value stand in for the user; remove it, identity sets that header`);
  }
  if (claim !== undefined && !IDENTITY_CLAIMS.includes(claim as IdentityClaim)) {
    problems.push(`${where}.claim must be one of ${IDENTITY_CLAIMS.join(', ')}`);
  }
  return problems;
}

/** Every identity problem across a whole mcp.json. */
export function serversIdentityProblems(servers: Record<string, McpServerSpec>): string[] {
  return Object.entries(servers).flatMap(([name, spec]) => (spec ? identityProblems(name, spec) : []));
}

/**
 * The value a bound server is told for one user, or null when there is none
 * to give -- no owner, not approved, or the claim is missing -- in which case
 * the call is refused rather than sent as anyone else.
 */
export function claimValue(user: Pick<UserRow, 'id' | 'external_id' | 'email' | 'status'> | null | undefined, claim: IdentityClaim = 'id'): string | null {
  if (!user || user.status !== 'approved') return null;
  const value = claim === 'externalId' ? user.external_id : claim === 'email' ? user.email : user.id;
  return typeof value === 'string' && VALUE.test(value) ? value : null;
}
