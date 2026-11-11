/**
 * The backup file: a person's chats, folders, automations and preferences as
 * one JSON document, and the way back in.
 *
 * What it leaves out, on purpose: uploaded documents and images (a backup is
 * text, and stays small enough to keep), search indexes and vectors (rebuilt
 * from the text), and anything of the server's (settings, keys, other people).
 * A message that had files keeps its words; the notes that pointed the model at
 * the files go, as in a fork without files, so it is never told of a document
 * it cannot open.
 *
 * Import never overwrites. A chat whose id is already one of yours is taken to
 * be the same chat and skipped, so importing a file twice changes nothing; an
 * id someone else holds gets a new one. The whole file is checked before
 * anything is written, so a malformed one writes nothing.
 */
import { randomUUID } from 'node:crypto';
import { splitAttachmentNotes } from '../../shared/attachment_note.ts';
import { validateSchedule } from '../automations/automation.ts';
import type { Store } from '../store/index.ts';
import type { ChatRow, RestoredChat, TaskStatus } from '../store/chats.ts';
import type { RestoredMessage } from '../store/messages.ts';
import type { Scope } from '../store/scope.ts';
import type { Role } from '../harness/types.ts';

export const BACKUP_FORMAT = 'tinywebui-backup';
export const BACKUP_VERSION = 1;

const ROLES: readonly Role[] = ['system', 'user', 'assistant', 'tool'];
const TASK_STATUSES: readonly TaskStatus[] = ['pending', 'in_progress', 'completed'];
const CHAT_ID = /^[\w.-]{1,64}$/;
const MAX_CHATS = 10000;
const MAX_MESSAGES = 50000;
const MAX_TEXT = 5 * 1024 * 1024;

/** The file as it is written; on import every field is checked, never trusted. */
export interface Backup {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: string;
  app: string;
  chats: BackupChat[];
  folders?: { name: string; prompt: string }[];
  automations?: BackupAutomation[];
  preferences?: { instructions: string | null; theme: string | null };
}

interface BackupChat {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  folder: string | null;
  tags: string[];
  parentId: string | null;
  forkSeq: number | null;
  epoch: number;
  windowSeq: number;
  checkpoint: unknown;
  /** When it was pinned; absent from files written before pinning existed. */
  pinnedAt?: number | null;
  tasks: { title: string; status: TaskStatus; createdAt: number; updatedAt: number; createdSeq: number }[];
  messages: BackupMessage[];
}

interface BackupMessage {
  seq: number;
  role: Role;
  content: string | null;
  toolCallId: string | null;
  toolCalls: unknown;
  reasoning: string | null;
  reasoningDetails: unknown;
  artifact: { toolName: string; args: unknown; content: string; createdAt: number } | null;
  stubText: string | null;
  usage: unknown;
  model: string | null;
  createdAt: number | null;
  origin: unknown;
  /** Informational: the files it carried, which the backup does not. */
  attachments?: string[];
  images?: number;
}

interface BackupAutomation { chatId: string; name: string; prompt: string; cron: string; timezone: string; enabled: boolean }

/** A file that is not a backup this version can read; the message says why, for the person importing it. */
export class BackupError extends Error {}

const parsed = (s: string | null): unknown => {
  if (s == null) return null;
  try { return JSON.parse(s); } catch { return null; }
};

/* ---------- export ---------- */

/** One chat as the backup carries it. */
export function chatRecord(store: Store, chat: ChatRow): BackupChat {
  const messages = store.messages.list(chat.id).map((r): BackupMessage => {
    let content = r.content;
    let attachments: string[] = [];
    if (r.role === 'user' && content != null) {
      const split = splitAttachmentNotes(content);
      content = split.text;
      attachments = split.names;
    }
    const artifact = r.artifact_id ? store.messages.getArtifact(r.artifact_id, chat.id) : null;
    const images = (parsed(r.images_json) as unknown[] | null)?.length || 0;
    return {
      seq: r.seq, role: r.role, content, toolCallId: r.tool_call_id, toolCalls: parsed(r.tool_calls_json),
      reasoning: r.reasoning, reasoningDetails: parsed(r.reasoning_details_json),
      artifact: artifact ? { toolName: artifact.tool_name, args: parsed(artifact.args_json), content: artifact.content, createdAt: artifact.created_at } : null,
      stubText: r.stub_text, usage: parsed(r.usage_json), model: r.model, createdAt: r.created_at, origin: parsed(r.origin_json),
      ...(attachments.length ? { attachments } : {}), ...(images ? { images } : {})
    };
  });
  return {
    id: chat.id, title: chat.title, createdAt: chat.created_at, updatedAt: chat.updated_at,
    folder: chat.folder || null, tags: (parsed(chat.tags_json) as string[] | null) || [],
    parentId: chat.parent_id, forkSeq: chat.fork_seq, epoch: chat.epoch,
    windowSeq: chat.window_seq, checkpoint: parsed(chat.checkpoint_json), pinnedAt: chat.pinned_at ?? null,
    tasks: store.chats.taskRecords(chat.id).map((t) => ({ title: t.title, status: t.status, createdAt: t.created_at, updatedAt: t.updated_at, createdSeq: t.created_seq })),
    messages
  };
}

/** What to put in a full backup beyond the chats; each part is only there when the person may use it. */
export interface BackupParts {
  folders: boolean;
  automations: boolean;
  preferences: { instructions: string | null; theme: string | null } | null;
}

export function buildBackup(store: Store, chats: ChatRow[], { userId, app, parts }: { userId: Scope; app: string; parts: BackupParts | null }): Backup {
  const backup: Backup = { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), app, chats: chats.map((c) => chatRecord(store, c)) };
  if (parts?.folders) {
    const prompts = store.chats.folderPrompts(userId);
    backup.folders = store.chats.listFolders(userId).map((name) => ({ name, prompt: prompts[name] || '' }));
  }
  if (parts?.automations) {
    // Only the ones whose chat is in the file: an automation posts into its chat and means nothing without it.
    const ids = new Set(chats.map((c) => c.id));
    backup.automations = store.automations.list(userId).filter((a) => ids.has(a.chatId))
      .map((a) => ({ chatId: a.chatId, name: a.name, prompt: a.prompt, cron: a.cron, timezone: a.timezone, enabled: a.enabled }));
  }
  if (parts?.preferences) backup.preferences = parts.preferences;
  return backup;
}

/* ---------- reading a file ---------- */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const int = (v: unknown, min = -Infinity): v is number => Number.isInteger(v) && (v as number) >= min;

function text(v: unknown, where: string, max = MAX_TEXT): string | null {
  if (v == null) return null;
  if (typeof v !== 'string') throw new BackupError(`${where} must be text`);
  if (v.length > max) throw new BackupError(`${where} is too long`);
  return v;
}
function requiredText(v: unknown, where: string, max: number): string {
  const t = text(v, where, max)?.trim();
  if (!t) throw new BackupError(`${where} is missing`);
  return t;
}
const time = (v: unknown, fallback: number): number => (int(v, 0) ? v : fallback);
/** A JSON column: stored again exactly as it was written, or null. */
const column = (v: unknown): string | null => (v == null ? null : JSON.stringify(v));

/** What the harness sends back to the provider, so nothing else gets past. */
const isToolCall = (c: unknown): boolean => isObj(c) && typeof c.id === 'string' && c.id.length <= 200
  && isObj(c.function) && typeof c.function.name === 'string' && typeof c.function.arguments === 'string';

/** A token attribution snapshot (harness/attribution.ts) as the Usage page sums it, or null when it is not one. */
function attribution(v: unknown): Obj | null {
  if (!isObj(v)) return null;
  const side = (s: unknown) => {
    if (!isObj(s) || !Array.isArray(s.buckets)) return null;
    const buckets = s.buckets.filter((b): b is Obj => isObj(b) && typeof b.category === 'string' && typeof b.source === 'string'
      && typeof b.tokens === 'number' && Number.isFinite(b.tokens) && (b.capability === undefined || typeof b.capability === 'string'));
    return { total: typeof s.total === 'number' ? s.total : null, source: s.source === 'provider' ? 'provider' : 'unreported', buckets };
  };
  const input = side(v.input);
  const output = side(v.output);
  if (!input || !output) return null;
  return { version: 1, estimator: typeof v.estimator === 'string' ? v.estimator : '', input, output, cached: typeof v.cached === 'number' ? v.cached : null };
}

/**
 * Usage feeds the Usage page's sums: numbers, short text (provider names, the
 * cost's source) and one level of token details, plus the attribution snapshot
 * checked field by field, so a stray value cannot turn a total into NaN.
 */
const COUNTED = /tokens|cost|count|total|requests/i;
function usageColumn(v: unknown): string | null {
  if (!isObj(v)) return null;
  const clean = (o: Obj, depth: number): Obj => Object.fromEntries(Object.entries(o).flatMap(([k, x]): [string, unknown][] => {
    if (depth === 0 && k === 'attribution') { const a = attribution(x); return a ? [[k, a]] : []; }
    if (typeof x === 'number' && Number.isFinite(x)) return [[k, x]];
    if (typeof x === 'boolean' || x === null) return [[k, x]];
    if (depth === 0 && isObj(x)) return [[k, clean(x, 1)]];
    // Text is for names (a provider, where a cost came from); a count or a cost is a number or nothing.
    if (typeof x === 'string' && x.length <= 200 && !COUNTED.test(k)) return [[k, x]];
    return [];
  }));
  return JSON.stringify(clean(v, 0));
}

function readMessage(v: unknown, where: string): RestoredMessage {
  if (!isObj(v)) throw new BackupError(`${where} is not a message`);
  if (!int(v.seq, 0)) throw new BackupError(`${where} has no valid seq`);
  if (!ROLES.includes(v.role as Role)) throw new BackupError(`${where} has an unknown role`);
  if (v.toolCalls != null && !(Array.isArray(v.toolCalls) && v.toolCalls.every(isToolCall))) {
    throw new BackupError(`${where}: toolCalls must be a list of calls, each with an id, a function name and its arguments as text`);
  }
  let artifact: RestoredMessage['artifact'] = null;
  if (v.artifact != null) {
    const a = v.artifact;
    if (!isObj(a)) throw new BackupError(`${where}: artifact is malformed`);
    artifact = {
      toolName: requiredText(a.toolName, `${where}: artifact tool name`, 200),
      argsJson: column(a.args ?? {}),
      content: text(a.content, `${where}: artifact`) ?? '',
      createdAt: time(a.createdAt, Date.now())
    };
  }
  return {
    seq: v.seq, role: v.role as Role, content: text(v.content, where),
    toolCallId: text(v.toolCallId, `${where}: toolCallId`, 200), toolCallsJson: column(v.toolCalls),
    reasoning: text(v.reasoning, `${where}: reasoning`), reasoningDetailsJson: column(v.reasoningDetails),
    artifact, stubText: text(v.stubText, `${where}: stub`),
    usageJson: usageColumn(v.usage), model: text(v.model, `${where}: model`, 200),
    createdAt: int(v.createdAt, 0) ? v.createdAt : null, originJson: isObj(v.origin) ? column(v.origin) : null
  };
}

type ReadChat = Omit<RestoredChat, 'id' | 'parentId'> & { originalId: string; originalParent: string | null };

function readChat(v: unknown, i: number): ReadChat {
  const where = `chat ${i + 1}`;
  if (!isObj(v)) throw new BackupError(`${where} is not a chat`);
  if (typeof v.id !== 'string' || !CHAT_ID.test(v.id)) throw new BackupError(`${where} has no valid id`);
  if (!Array.isArray(v.messages)) throw new BackupError(`${where} has no messages list`);
  if (v.messages.length > MAX_MESSAGES) throw new BackupError(`${where} has too many messages`);
  const messages = v.messages.map((m, j) => readMessage(m, `${where}, message ${j + 1}`));
  for (let j = 1; j < messages.length; j++) {
    if (messages[j]!.seq <= messages[j - 1]!.seq) throw new BackupError(`${where}: messages are out of order`);
  }
  const createdAt = time(v.createdAt, Date.now());
  const tags = Array.isArray(v.tags) ? v.tags.filter((t): t is string => typeof t === 'string').slice(0, 32) : [];
  const tasks = (Array.isArray(v.tasks) ? v.tasks : []).filter(isObj).map((t) => ({
    title: requiredText(t.title, `${where}: task`, 500),
    status: TASK_STATUSES.includes(t.status as TaskStatus) ? t.status as TaskStatus : 'pending',
    createdAt: time(t.createdAt, createdAt), updatedAt: time(t.updatedAt, createdAt),
    createdSeq: int(t.createdSeq, -1) ? t.createdSeq : -1
  }));
  // A summary is only valid with the window it summarised, so the two travel together or not at all.
  const windowSeq = int(v.windowSeq, -1) ? v.windowSeq : -1;
  const checkpointJson = windowSeq >= 0 && isObj(v.checkpoint) && typeof v.checkpoint.summary === 'string' ? column(v.checkpoint) : null;
  return {
    originalId: v.id, title: requiredText(v.title, `${where}: title`, 500).slice(0, 200), createdAt, updatedAt: time(v.updatedAt, createdAt),
    folder: text(v.folder, `${where}: folder`, 200)?.trim().slice(0, 40) || null, tagsJson: JSON.stringify(tags),
    originalParent: typeof v.parentId === 'string' && CHAT_ID.test(v.parentId) ? v.parentId : null,
    forkSeq: int(v.forkSeq, 0) ? v.forkSeq : null, epoch: int(v.epoch, 0) ? v.epoch : 0,
    windowSeq: checkpointJson ? windowSeq : -1, checkpointJson,
    pinnedAt: v.pinnedAt == null ? null : time(v.pinnedAt, createdAt), tasks, messages
  };
}

/** The file checked through, or a BackupError saying what is wrong with it. Writes nothing. */
export function readBackup(doc: unknown) {
  if (!isObj(doc) || doc.format !== BACKUP_FORMAT) throw new BackupError('this is not a TinyWebUI backup file');
  if (!int(doc.version, 1)) throw new BackupError('the backup has no version');
  if (doc.version > BACKUP_VERSION) throw new BackupError(`the backup is version ${doc.version}, newer than this TinyWebUI reads (${BACKUP_VERSION}); upgrade TinyWebUI`);
  if (!Array.isArray(doc.chats)) throw new BackupError('the backup has no chats list');
  if (doc.chats.length > MAX_CHATS) throw new BackupError(`the backup has more than ${MAX_CHATS} chats`);
  const chats = doc.chats.map(readChat);
  const ids = new Set<string>();
  for (const c of chats) {
    if (ids.has(c.originalId)) throw new BackupError(`chat id ${c.originalId} appears twice`);
    ids.add(c.originalId);
  }
  const folders = (Array.isArray(doc.folders) ? doc.folders : []).filter(isObj)
    .map((f) => ({ name: text(f.name, 'a folder name', 200)?.trim().slice(0, 40) || '', prompt: text(f.prompt, 'a folder prompt', 20000)?.trim() || '' }))
    .filter((f) => f.name);
  const automations = (Array.isArray(doc.automations) ? doc.automations : []).filter(isObj).map((a, i) => ({
    chatId: String(a.chatId ?? ''), name: requiredText(a.name, `automation ${i + 1}: name`, 120),
    prompt: requiredText(a.prompt, `automation ${i + 1}: prompt`, 12000), cron: String(a.cron ?? ''), timezone: String(a.timezone ?? '')
  }));
  const p = isObj(doc.preferences) ? doc.preferences : {};
  const preferences = {
    instructions: text(p.instructions, 'your instructions', 4000)?.trim() || null,
    theme: typeof p.theme === 'string' ? p.theme : null
  };
  return { chats, folders, automations, preferences };
}

/* ---------- import ---------- */

export interface ImportOptions {
  userId: Scope;
  /** What this person may bring in; the rest of the file is left out and said so. */
  folders: boolean;
  automations: boolean;
  instructions: boolean;
  /** Null when themes are kept in the browser (sign-in off): the page applies it. */
  themeAllowed: ((id: string) => boolean) | null;
}

export interface ImportResult {
  chats: number;
  /** Already here (the same id is one of yours): left as they are. */
  skipped: number;
  folders: number;
  automations: number;
  instructions: 'set' | 'kept' | null;
  /** For the page to apply when themes live in the browser. */
  theme: string | null;
  notes: string[];
  /** The new chats, for the caller to index for search. */
  chatIds: string[];
}

export function importBackup(store: Store, doc: unknown, opts: ImportOptions): ImportResult {
  const data = readBackup(doc);
  const { userId } = opts;
  const result: ImportResult = { chats: 0, skipped: 0, folders: 0, automations: 0, instructions: null, theme: null, notes: [], chatIds: [] };

  // Old id -> the id it has here: a new chat's own, or a skipped one's (which is already here under it).
  const idMap = new Map<string, string>();
  const toWrite: ReadChat[] = [];
  for (const c of data.chats) {
    if (store.chats.get(c.originalId, userId)) { idMap.set(c.originalId, c.originalId); result.skipped++; continue; }
    idMap.set(c.originalId, store.chats.byId(c.originalId) ? randomUUID() : c.originalId);
    toWrite.push(c);
  }

  const knownFolders = new Set(store.chats.listFolders(userId));
  if (opts.folders) {
    const prompts = store.chats.folderPrompts(userId);
    for (const f of data.folders) {
      const name = store.chats.createFolder(f.name, userId);
      if (!name) continue;
      if (!knownFolders.has(name)) result.folders++;
      knownFolders.add(name);
      // A folder's own instructions are never overwritten, only filled in where it has none.
      if (f.prompt && !prompts[name]) store.chats.updateFolder(name, { prompt: f.prompt }, userId);
    }
  } else if (data.folders.length || toWrite.some((c) => c.folder)) {
    result.notes.push('Folders were left out: your role does not include folders.');
  }

  for (const c of toWrite) {
    let folder = opts.folders ? c.folder : null;
    if (folder && !knownFolders.has(folder)) {
      folder = store.chats.createFolder(folder, userId);
      if (folder) { knownFolders.add(folder); result.folders++; }
    }
    const parent = c.originalParent;
    // A fork stays under its original when that came along or is already here; otherwise it stands alone.
    const parentId = parent ? idMap.get(parent) ?? (store.chats.get(parent, userId) ? parent : null) : null;
    const { originalId, originalParent, ...rest } = c;
    const id = idMap.get(originalId)!;
    store.chats.restore({ ...rest, id, folder, parentId, forkSeq: parentId ? c.forkSeq : null }, userId);
    result.chats++;
    result.chatIds.push(id);
  }

  if (data.automations.length && !opts.automations) result.notes.push('Automations were left out: your role does not include automations.');
  if (opts.automations) {
    const written = new Set(result.chatIds);
    for (const a of data.automations) {
      const chatId = idMap.get(a.chatId);
      // Skipped with its chat: an automation of a chat already here is already here too.
      if (!chatId || !written.has(chatId)) continue;
      let schedule;
      try { schedule = validateSchedule(a.cron, a.timezone); } catch (err) {
        result.notes.push(`Automation "${a.name}" was left out: ${(err as Error).message}.`);
        continue;
      }
      // Paused: nothing should start running the moment a file is imported.
      store.automations.create({ ...schedule, chatId, name: a.name, prompt: a.prompt, enabled: false, source: 'user' }, userId);
      result.automations++;
    }
    if (result.automations) result.notes.push('Imported automations are paused; switch them on under Automations.');
  }

  const { instructions, theme } = data.preferences;
  if (instructions && opts.instructions && typeof userId === 'string') {
    const current = store.users.getPrefs(userId).instructions;
    if (!current) { store.users.setPref(userId, 'instructions', instructions); result.instructions = 'set'; }
    else if (current !== instructions) result.instructions = 'kept';
  }
  if (theme !== null) {
    if (opts.themeAllowed === null) result.theme = theme;
    else if (typeof userId === 'string' && opts.themeAllowed(theme)) store.users.setPref(userId, 'theme', theme);
  }
  return result;
}
