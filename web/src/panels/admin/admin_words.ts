/** How the admin panel words roles, features and times. */
import { FEATURE } from '../../../../shared/features.ts';
import { ROLE_SETTINGS, type RoleSettingKey } from '../../../../shared/settings.ts';

/** 'team-lead' -> 'Team lead': role names are handles, this is how they read. */
export const roleLabel = (name: string) => {
  const words = String(name).replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ago(ts: number | null | undefined) {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${plural(Math.floor(s / 86400), 'day')} ago`;
  return new Date(ts).toLocaleDateString();
}
export const when = (ts: number | null | undefined) => (ts ? new Date(ts).toLocaleString() : 'never');

// The features a role can be given, in the words the Roles tab uses. The
// admin feature is not among them: it belongs to the admin role alone.
export const FEATURE_INFO: Record<string, [string, string]> = {
  [FEATURE.CHAT]: ['Chat', 'Talk to the models'],
  [FEATURE.ATTACHMENTS]: ['Attach files', 'Add documents to a chat'],
  [FEATURE.IMAGES]: ['Images', 'Send pictures to models that can see'],
  [FEATURE.SEARCH]: ['Search', 'Search their past chats'],
  [FEATURE.FOLDERS]: ['Folders', 'Sort chats into folders'],
  [FEATURE.MODEL_PICKER]: ['Pick a model', 'Choose among the models allowed below'],
  [FEATURE.TOOLS]: ['Tools menu', 'Turn tools on and off from the composer'],
  [FEATURE.AUTOMATIONS]: ['Automations', 'Schedule prompts that run on their own'],
  [FEATURE.STATISTICS]: ['Usage', 'See their own usage and cost'],
  [FEATURE.INTEGRATIONS]: ['MCP pages', 'Use the management pages MCP servers offer: their own data in connected services'],
  [FEATURE.SETTINGS]: ['Settings', 'Change shared settings (never keys or endpoints)'],
  [FEATURE.MCP]: ['Manage MCP servers', 'Add and edit tool servers and their tools for everyone'],
  [FEATURE.OVERSIGHT]: ['Oversight', "Read other people's chats; every look is audited"]
};
export const FEATURE_GROUPS: [string, string[]][] = [
  ['In a chat', [FEATURE.CHAT, FEATURE.ATTACHMENTS, FEATURE.IMAGES, FEATURE.SEARCH, FEATURE.FOLDERS, FEATURE.MODEL_PICKER, FEATURE.TOOLS]],
  ['Their own space', [FEATURE.AUTOMATIONS, FEATURE.STATISTICS, FEATURE.INTEGRATIONS]],
  ['Running the place', [FEATURE.SETTINGS, FEATURE.MCP, FEATURE.OVERSIGHT]]
];
export const CUSTOMIZE_INFO: Record<string, [string, string]> = { theme: ['Theme', 'Pick or import their own look instead of the default'], instructions: ['Personal instructions', 'Add their own instructions for the model'] };
export const featureName = (f: string) => FEATURE_INFO[f]?.[0] || f;

/**
 * What a role may set for its people, in the words the role editor uses.
 * Typed against ROLE_SETTINGS, so a key added there does not compile here
 * until it reads as something.
 */
export const ROLE_SETTING_INFO: Record<RoleSettingKey, [string, string]> = {
  systemPrompt: ['Prompt', "Replaces the system prompt (and any model's own) for this role. Blank: use the system prompt."],
  model: ['Default model', "What new chats start with. A person's own pick still wins."],
  temperature: ['Temperature', 'Over the global value and any model\'s own.'],
  maxTokens: ['Max output tokens', 'Over the global value and any model\'s own.'],
  maxToolRounds: ['Max tool turns', 'Tool calls allowed per reply.'],
  askUserTimeoutSeconds: ['Question timeout (s)', 'How long a question from the model waits. 0: until answered.'],
  toolApproval: ['Ask before running', 'Whether their MCP tool calls wait for approval.']
};

/** "custom prompt · default: fast · temperature 0.3": what a role sets, for its card. */
export function roleSettingsSummary(settings: Partial<Record<RoleSettingKey, unknown>> | undefined): string {
  if (!settings) return '';
  const parts: string[] = [];
  for (const k of ROLE_SETTINGS) {
    const v = settings[k];
    if (v === undefined || v === null || v === '') continue;
    if (k === 'systemPrompt') parts.push('own prompt');
    else if (k === 'model') parts.push(`default: ${v}`);
    else parts.push(`${ROLE_SETTING_INFO[k][0].toLowerCase()}: ${v}`);
  }
  return parts.join(' · ');
}
