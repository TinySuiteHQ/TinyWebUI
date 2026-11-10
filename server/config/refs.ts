/*
 * `${NAME}` references to the environment, so a file can say where a secret
 * comes from without holding it: mcp.json headers and env, and the keys in
 * tinywebui.config.json.
 */

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** True when a value names at least one environment variable. */
export const hasRef = (value: unknown): value is string => typeof value === 'string' && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);

/** The names a value refers to that the environment does not set. */
export function missingRefs(value: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  if (typeof value !== 'string') return [];
  return [...value.matchAll(REF)].map((m) => m[1]).filter((name) => env[name] === undefined);
}

/**
 * Fills `${NAME}` from the environment. A name that is not set is left as
 * written, so validation can say which one; it never becomes an empty
 * string, which reads as "unauthorised" and sends people looking in the
 * wrong place.
 */
export function fillRefs<T>(value: T, env: NodeJS.ProcessEnv = process.env): T | string {
  if (typeof value !== 'string') return value;
  return value.replace(REF, (ref, name: string) => env[name] ?? ref);
}

/** fillRefs, but a name that is not set is an error naming it and `where` it was written. */
export function expandRefs<T>(value: T, env: NodeJS.ProcessEnv = process.env, where = 'mcp.json'): T | string {
  const [missing] = missingRefs(value, env);
  if (missing) throw new Error(`${where} refers to \${${missing}}, which is not set in TinyWebUI's environment`);
  return fillRefs(value, env);
}
