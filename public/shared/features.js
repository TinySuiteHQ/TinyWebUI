// @ts-check
/**
 * Every feature a role can be granted (access.roles.*.features). Shared by
 * both sides: the server checks them on each API route (src/routes/*,
 * src/access/policy.js) and the page hides what the viewer cannot use
 * (core/access.js, chat/composer.js, app.js).
 */
export const FEATURE = Object.freeze({
  CHAT: 'chat',
  ATTACHMENTS: 'attachments',
  IMAGES: 'images',
  SEARCH: 'search',
  FOLDERS: 'folders',
  AUTOMATIONS: 'automations',
  STATISTICS: 'statistics',
  MODEL_PICKER: 'model-picker',
  TOOLS: 'tools',
  SETTINGS: 'settings',
  MCP: 'mcp',
  // The MCP management pages (the Integrations panel): a person's own data
  // in the servers that offer a page, and for admins the servers' own views.
  INTEGRATIONS: 'integrations',
  ADMIN: 'admin',
  OVERSIGHT: 'oversight'
});
