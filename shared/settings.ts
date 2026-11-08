/**
 * The values of the settings that are a choice from a fixed list. The server
 * validates against these (config/config.ts, config/models.ts, the schema in
 * cli.ts) and the harness acts on them; the page's settings editor labels
 * each one, typed against these lists, so a value added here will not compile
 * on the page until it has a label there.
 */
export const CACHE_MODES = Object.freeze(['auto', 'implicit', 'explicit', 'rolling', 'off'] as const);
export const CACHE_TTLS = Object.freeze(['5m', '1h'] as const);
export const REASONING_REPLAYS = Object.freeze(['auto', 'omit', 'reasoning_content', 'reasoning_details'] as const);
/** How hard a model thinks before it answers, on one scale whatever the provider calls it. */
export const THINKING_LEVELS = Object.freeze(['off', 'low', 'medium', 'high'] as const);
/** A level, or `provider`: send nothing, so the provider's own default applies. */
export const THINKING_CHOICES = Object.freeze(['provider', ...THINKING_LEVELS] as const);
/** Which request field carries the level; see thinkingStyle in src/harness/provider.ts. */
export const THINKING_SENDS = Object.freeze(['auto', 'effort', 'openrouter', 'anthropic', 'switch'] as const);

/** When a tool call waits for the person's allow / deny; see src/config/approval.ts. */
export const TOOL_APPROVALS = Object.freeze(['writes', 'all', 'off'] as const);

export type CacheMode = typeof CACHE_MODES[number];
export type CacheTtl = typeof CACHE_TTLS[number];
export type ReasoningReplay = typeof REASONING_REPLAYS[number];
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type ThinkingChoice = typeof THINKING_CHOICES[number];
export type ThinkingSend = typeof THINKING_SENDS[number];
export type ToolApproval = typeof TOOL_APPROVALS[number];
