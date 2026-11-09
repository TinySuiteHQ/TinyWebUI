/*
 * Export and import: one chat as Markdown or a backup file, everything of a
 * person's as one backup file, and a backup file back in (transfer/backup.ts
 * has the format and its rules).
 */
import { json, readJson, BACKUP_LIMIT } from '../http.ts';
import { customizeFor } from '../access/policy.ts';
import { CORPUS } from '../store/index.ts';
import { FEATURE } from '../../shared/features.ts';
import { BackupError, buildBackup, importBackup } from '../transfer/backup.ts';
import { chatMarkdown } from '../transfer/markdown.ts';
import { builtInIds, THEME_ID } from './themes.ts';
import { logger } from '../log.ts';
import type { ServerResponse } from 'node:http';
import type { SignedIn } from '../access/auth_gate.ts';
import type { Route, RouteDeps } from './types.ts';
import type { ImportReply } from '../../shared/api.ts';

const log = logger('transfer');

/** A name a file system takes: the title's words, never a path. */
const fileName = (title: string) => title.normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 60).toLowerCase() || 'chat';
const today = () => new Date().toISOString().slice(0, 10);

/** Sent as a file to save, not a page to show; the name in both forms so a non-ASCII title survives. */
function download(res: ServerResponse, name: string, type: string, body: string) {
  res.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'cache-control': 'no-store'
  });
  res.end(body);
}

export function transferRoutes({ config, multiUser, retrieval, store, version }: Pick<RouteDeps, 'config' | 'multiUser' | 'retrieval' | 'store' | 'version'>): Route[] {
  const F = FEATURE.CHAT;
  /** Instructions and theme are per account: with sign-in off there is no one to keep them for (the theme lives in the browser). */
  const preferencesOf = (auth: SignedIn) => {
    if (!multiUser() || !auth.user) return null;
    const prefs = store.users.getPrefs(auth.user.id);
    return { instructions: prefs.instructions || null, theme: prefs.theme ?? null };
  };

  return [
    { method: 'GET', path: /^\/api\/chats\/([\w.-]+)\/export$/, feature: F, handle: ({ res, auth, url, params: [id] }) => {
      const chat = store.chats.get(id, auth.userId);
      if (!chat) return json(res, 404, { error: 'no such chat' });
      if (url.searchParams.get('format') === 'md') {
        return download(res, `${fileName(chat.title)}.md`, 'text/markdown; charset=utf-8', chatMarkdown(chat, store.messages.list(chat.id)));
      }
      const backup = buildBackup(store, [chat], { userId: auth.userId, app: version, parts: null });
      return download(res, `${fileName(chat.title)}.tinywebui.json`, 'application/json', JSON.stringify(backup, null, 2));
    } },

    { method: 'GET', path: /^\/api\/export$/, feature: F, handle: ({ res, auth }) => {
      const chats = store.chats.allFor(auth.userId);
      const backup = buildBackup(store, chats, {
        userId: auth.userId, app: version,
        parts: { folders: auth.features.has(FEATURE.FOLDERS), automations: auth.features.has(FEATURE.AUTOMATIONS), preferences: preferencesOf(auth) }
      });
      log.info(`export: ${chats.length} chats`);
      return download(res, `tinywebui-backup-${today()}.json`, 'application/json', JSON.stringify(backup));
    } },

    { method: 'POST', path: /^\/api\/import$/, feature: F, handle: async ({ req, res, auth }) => {
      const doc = await readJson(req, BACKUP_LIMIT);
      const cfg = config();
      const account = multiUser() && auth.user ? auth.user.id : null;
      const customize = account ? customizeFor(cfg, auth.role) : [];
      let result;
      try {
        result = importBackup(store, doc, {
          userId: auth.userId,
          folders: auth.features.has(FEATURE.FOLDERS),
          automations: auth.features.has(FEATURE.AUTOMATIONS),
          instructions: customize.includes('instructions'),
          themeAllowed: account
            ? (theme) => customize.includes('theme') && (theme === '' || (THEME_ID.test(theme) && (builtInIds().has(theme) || Boolean(store.themes.get(theme, account)))))
            : null
        });
      } catch (err) {
        if (err instanceof BackupError) return json(res, 400, { error: err.message });
        throw err;
      }
      // Search over earlier chats reads their vectors; new chats get theirs in the background.
      for (const id of result.chatIds) retrieval.ingest(CORPUS.CHATS, id).catch(() => {});
      log.info(`import: ${result.chats} chats, ${result.skipped} already here`);
      const { chatIds, ...summary } = result;
      return json(res, 200, summary satisfies ImportReply);
    } }
  ];
}
