/** How the admin panel words roles, features and times. */
import { FEATURE } from '../../../../shared/features.ts';

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
  [FEATURE.STATISTICS]: ['Statistics', 'See their own usage and cost'],
  [FEATURE.INTEGRATIONS]: ['Integrations', 'Their own data in connected services'],
  [FEATURE.SETTINGS]: ['Settings', 'Change shared settings (never keys or endpoints)'],
  [FEATURE.MCP]: ['MCP servers', 'Add and edit tool servers for everyone'],
  [FEATURE.OVERSIGHT]: ['Oversight', "Read other people's chats; every look is audited"]
};
export const FEATURE_GROUPS: [string, string[]][] = [
  ['In a chat', [FEATURE.CHAT, FEATURE.ATTACHMENTS, FEATURE.IMAGES, FEATURE.SEARCH, FEATURE.FOLDERS, FEATURE.MODEL_PICKER, FEATURE.TOOLS]],
  ['Their own space', [FEATURE.AUTOMATIONS, FEATURE.STATISTICS, FEATURE.INTEGRATIONS]],
  ['Running the place', [FEATURE.SETTINGS, FEATURE.MCP, FEATURE.OVERSIGHT]]
];
export const CUSTOMIZE_INFO: Record<string, [string, string]> = { theme: ['Theme', 'Pick their own look'], instructions: ['Personal instructions', 'Add their own instructions for the model'] };
export const featureName = (f: string) => FEATURE_INFO[f]?.[0] || f;
