/**
 * One JSON line per security-relevant event, on stdout for the deployment's
 * log collector. Never pass content, prompts, tokens or raw header values.
 */
export function audit(event: string, fields: Record<string, unknown> = {}): void {
  console.log(`[tinywebui:audit] ${JSON.stringify({ ts: new Date().toISOString(), event, ...fields })}`);
}
