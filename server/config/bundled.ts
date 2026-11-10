/**
 * The MCP servers TinyWebUI ships: the TinySuite packages it starts when
 * there is no mcp.json (see defaultMcpServers in config.ts).
 *
 * Its own module, apart from config.ts, because mcp.ts needs isBundled and
 * config.ts must not load early: it reads $TINYWEBUI_CONFIG and $TINYWEBUI_MCP
 * once, when it loads, so a file that imports mcp.ts before setting them (as
 * the tests do) would have it settle on the real files in the working folder.
 * Nothing here reads the environment or imports a value.
 */
import type { McpServerSpec } from './config.ts';

// The version floors are the first releases with the proxy token (and, for
// TinyContext, own views open without the operator's management token,
// which TinyWebUI sends on its server-wide connection only); raise them when
// either ships a security fix.
export const TINYSEARCH = 'tinysuite-search[server]>=0.6.8';
export const TINYCONTEXT = 'tinysuite-context[server]>=0.5.4';

// A requirement's bare package name: "tinysuite-search[server]>=0.6.8" -> "tinysuite-search".
const packageName = (req: string) => req.split(/[[<>=~!;\s]/)[0].toLowerCase();
const BUNDLED = new Set([TINYSEARCH, TINYCONTEXT].map(packageName));

/**
 * Whether a server is one TinyWebUI ships: launched by uvx from a TinySuite
 * package above. Read off the package, not the name, so a renamed copy still
 * counts, a raised version floor still counts, and something else called
 * "tinysearch" does not. A label for the MCP page, not a permission.
 */
export function isBundled(spec: McpServerSpec): boolean {
  if (spec.command !== 'uvx' || !Array.isArray(spec.args)) return false;
  const from = spec.args[spec.args.indexOf('--from') + 1];
  return spec.args.includes('--from') && typeof from === 'string' && BUNDLED.has(packageName(from));
}
