/**
 * The shapes of API replies that both sides read. The server builds each
 * reply typed against one of these (`satisfies`), and the page reads it typed,
 * so a renamed or dropped field fails to compile on both sides instead of
 * showing as a blank on the page at runtime.
 *
 * Not every reply is here yet: the rest are read as loose JSON on the page
 * (`type Json = any`) and move here as their area is next touched.
 */

/**
 * One chat in the sidebar's search results: its best-matching message, with
 * the match marked between ‹ and ›, and how many of its messages matched.
 */
export interface SearchHitView {
  chatId: string;
  chatTitle: string;
  role: string;
  snippet: string;
  matches: number;
}

/** One automation, as /api/automations lists it. */
export interface AutomationView {
  id: string;
  userId: string | null;
  chatId: string;
  chatTitle: string;
  name: string;
  prompt: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastStatus: string | null;
  lastResult: string | null;
  source: string;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/automations: the person's automations, and the chats one can post into. */
export interface AutomationsReply {
  automations: AutomationView[];
  chats: { id: string, title: string }[];
}

/** One past run, as GET /api/automations/:id/runs lists it. */
export interface AutomationRunView {
  id: string;
  scheduled_at: number;
  started_at: number | null;
  finished_at: number | null;
  status: string;
  trigger_type: string;
  result: string | null;
  error: string | null;
}

/** POST /api/import: what a backup brought in (server/transfer/backup.ts). */
export interface ImportReply {
  chats: number;
  /** Already here: left as they are. */
  skipped: number;
  folders: number;
  automations: number;
  instructions: 'set' | 'kept' | null;
  /** For the page to apply when themes are kept in the browser (sign-in off). */
  theme: string | null;
  notes: string[];
}
