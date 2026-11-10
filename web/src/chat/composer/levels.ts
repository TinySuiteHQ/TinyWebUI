import type { ThinkingChoice } from '../../../../shared/settings.ts';

/** How the thinking levels read, in the model menu, the chip and the model editor. */
export const LEVEL_NAMES: Record<ThinkingChoice, string> = { provider: 'Default', off: 'Off', low: 'Low', medium: 'Medium', high: 'High' };

/** A level as the server sent it, by name; an unknown one (a newer server) reads as itself. */
export const levelName = (level: string): string => LEVEL_NAMES[level as ThinkingChoice] ?? level;
