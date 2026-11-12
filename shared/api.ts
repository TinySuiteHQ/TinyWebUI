/**
 * The shapes of API replies that both sides read. The server builds each
 * reply typed against one of these (`satisfies`), and the page reads it typed,
 * so a renamed or dropped field fails to compile on both sides instead of
 * showing as a blank on the page at runtime.
 *
 * The page asks for a reply by its type: `api.get<ToolsReply>('/api/tools')`.
 * Not every reply is here yet: the rest (chats, sign-in, files, themes) are
 * still read as loose JSON, api.ts's default, and move here as their area is
 * next touched.
 */
import type { CacheMode, CacheTtl, ReasoningReplay, RoleModelSettingKey, RoleSettingKey, ThinkingChoice, ThinkingSend, ToolApproval } from './settings.ts';

/* ---------- tools: GET /api/tools, and every route that answers with it ---------- */

/** One tool, as the tools panel and the composer's + menu list it (McpHub.inventory). */
export interface ToolView {
  name: string;
  /** true, false, or 'partly' for a tool that only reads for some arguments. */
  readOnly: boolean | 'partly';
  description?: string;
  /** The tool's JSON Schema, as its server sent it. */
  parameters?: Record<string, unknown>;
  disabled: boolean;
}

/** A tool's own approval: 'default' follows the global toolApproval. */
export type ToolOverride = 'ask' | 'auto' | 'default';

/** An MCP server's connection, as the tools panel shows it. */
export interface McpServerStatus {
  name: string;
  status: 'ok' | 'disabled' | 'error';
  error: string | null;
  /** What to install when the server's launcher is missing. */
  install: { name: string, url: string } | null;
  instructions: string | null;
  /** Which header carries the user (never a value): a per-user server. */
  identity: { header: string, claim: string } | null;
  /** How often it has failed, and when it is tried again on its own (null: only by hand). */
  retry: { attempts: number, nextAt: number | null } | null;
  /** Shipped with TinyWebUI rather than added by someone. */
  bundled: boolean;
}

export interface ToolsReply {
  internal: ToolView[];
  servers: (McpServerStatus & { tools: (ToolView & { approval: ToolOverride })[] })[];
  disabledTools: string[];
  toolApproval: ToolApproval;
}

/** A tool as the model is offered it: GET /api/config and POST /api/mcp list these. */
export interface ToolBrief {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/* ---------- mcp.json: GET and POST /api/mcp ---------- */

export interface McpFileReply {
  path: string | null;
  text: string;
  /** Set in code or frozen: shown, not saved. */
  locked: boolean;
}

export interface McpSaveReply {
  tools: ToolBrief[];
  mcpErrors: string[];
}

/* ---------- settings: GET and POST /api/config ---------- */

/** A model in the catalog (config/models.ts ModelEntry). */
export interface ModelEntryView {
  id: string;
  model?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
  connector?: string;
  images?: boolean;
  tools?: boolean;
  /** Older form of images/tools; still read. */
  tags?: string[];
  systemPrompt?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  maxToolRounds?: number;
  cacheMode?: CacheMode;
  cacheTtl?: CacheTtl;
  extraBody?: Record<string, unknown>;
  reasoningReplay?: ReasoningReplay;
  thinking?: { default?: ThinkingChoice, choices?: ThinkingChoice[], send?: ThinkingSend };
}

/** An endpoint other than the default one; its key is write-only, so only whether one is set. */
export interface ConnectorView {
  id: string;
  label?: string;
  baseUrl: string;
  models?: ModelEntryView[];
  hasApiKey: boolean;
  keyHint: string | null;
}

/**
 * The deployment's settings as this person may see them (configFor in
 * server.ts): an admin gets all of it, anyone else the same without the keys,
 * endpoints and trust settings, so every field is optional.
 */
export interface ConfigReply {
  model?: string;
  modelLabel?: string;
  models?: ModelEntryView[];
  connectors?: ConnectorView[];
  baseUrl?: string;
  hasApiKey?: boolean;
  keyHint?: string | null;
  /** Whether the default model's turns have an endpoint to go to. */
  ready?: boolean;
  usesDefaultEndpoint?: boolean;
  systemPrompt?: string;
  temperature?: number | null;
  maxTokens?: number | null;
  maxToolRounds?: number;
  askUserTimeoutSeconds?: number;
  extraBody?: Record<string, unknown>;
  cache?: boolean;
  cacheMode?: CacheMode;
  cacheTtl?: CacheTtl;
  reasoningReplay?: ReasoningReplay;
  compactThreshold?: number;
  keepTurns?: number;
  compactMinSaved?: number;
  maxInlineChars?: number;
  maxTurnChars?: number;
  maxHistoryTokens?: number;
  llmCompaction?: boolean;
  autoTitle?: boolean;
  compactionMaxTokens?: number;
  expandCharBudget?: number;
  timezone?: string;
  toolApproval?: ToolApproval;
  disabledTools?: string[];
  frozen?: boolean;
  /** Keys set in code: shown, never posted. */
  lockedKeys?: string[];
  /** Someone without the settings feature: they see the settings but cannot change them. */
  readOnly?: true;
  /** GET only: the tools the model is offered, and the MCP servers that failed. */
  tools?: ToolBrief[];
  mcpErrors?: string[];
}

/* ---------- MCP servers' management pages: /api/integrations ---------- */

export type FieldFormat = 'text' | 'multiline' | 'number' | 'datetime';
export interface ViewParam { name: string, label: string, type: 'text' | 'enum', maxLength?: number, values?: string[] }
export interface ViewColumn { key: string, label: string, format: FieldFormat }
export interface ActionInput { label: string, initial: string | null, maxLength: number, multiline: boolean }

/** A management view as the browser may know it: never the tools or resources behind it (management.ts publicView). */
export interface ViewInfo {
  id: string;
  title: string;
  kind: 'stats' | 'table';
  scope: 'user' | 'instance';
  pageSize: number;
  params: ViewParam[];
  columns: ViewColumn[];
  rowKey: string | null;
  hasDetail: boolean;
  actions: { id: string, label: string, target: 'row' | 'view', input: ActionInput | null, destructive: boolean, confirm: string | null }[];
}
export type ViewAction = ViewInfo['actions'][number];

/** One connected MCP server on the MCP page, with its management page when it offers one. */
export interface IntegrationServer {
  name: string;
  status: McpServerStatus['status'];
  error: string | null;
  perUser: boolean;
  shared: boolean;
  tools: number;
  bundled: boolean;
  managed: boolean;
  manifest: {
    id: string, title: string, description: string, icon: string, version: string,
    views: (ViewInfo & { available: boolean, reason: string | null })[]
  } | null;
  manageError?: string;
}

export interface IntegrationsReply {
  multiUser: boolean;
  servers: IntegrationServer[];
}

/** What a server says about a value: scalars only, bounded (management.ts). */
export type Scalar = string | number | boolean | null;
export type ViewRow = Record<string, Scalar>;

export interface StatsData {
  items: { label: string, value: Scalar, unit: string | null, hint: string | null, format: FieldFormat | null }[];
  notice: string | null;
}
export interface TableData {
  rows: ViewRow[];
  total: number | null;
  offset: number;
  limit: number;
  hasMore: boolean;
  notice: string | null;
}
/** A view's data: stats or a table, as its view's `kind` says. */
export type ViewData = (StatsData & { rows?: undefined }) | (TableData & { items?: undefined });

/** One row opened: labelled fields, and the row its actions bind to. */
export interface DetailData {
  fields: { label: string, value: Scalar, format: FieldFormat }[];
  row: ViewRow | null;
}

export interface ActionReply { ok: boolean, message: string }

/* ---------- admin: /api/admin/* ---------- */

export type UserStatusView = 'pending' | 'approved' | 'disabled';

/** A person on People & roles (adminUserView in routes/admin.ts). */
export interface AdminUserView {
  id: string;
  email: string | null;
  name: string | null;
  role: string;
  status: UserStatusView;
  createdAt: number;
  lastLoginAt: number | null;
  chatCount: number | null;
  /** A local account an admin can set a password for. */
  hasPassword: boolean;
  /** What they wrote when asking for access, while the request waits. */
  note: string | null;
}

export interface AdminUsersReply {
  fingerprint: string;
  users: (AdminUserView & { pinnedInCode: 'bootstrapAdmins' | 'access.users' | null })[];
}

export interface InviteView { id: string, email: string | null, createdAt: number, expiresAt: number }
export interface InviteCreatedReply { invite: InviteView, token: string, path: string }

/** What a role grants, spelled out, and how many people hold it. */
export interface RoleView {
  name: string;
  builtin: boolean;
  /** The admin role: always everything, only its settings change. */
  fixed: boolean;
  features: string[];
  models?: string[] | '*';
  customize?: string[];
  settings?: Partial<Record<RoleSettingKey, unknown>>;
  modelSettings?: Record<string, Partial<Record<RoleModelSettingKey, unknown>>>;
  users: number;
}

export interface AdminPolicyReply {
  features: string[];
  customizable: string[];
  models: string[];
  roles: RoleView[];
  newUsers: 'approved' | 'pending';
  allowRequests: boolean;
  /** Set in code or frozen: shown, not changed. */
  locked: boolean;
}

/** A chat in oversight's list of someone's chats. */
export interface AdminChatRow { id: string, title: string, updated_at: number, running: boolean }

export interface AdminChatsReply {
  user: AdminUserView;
  chats: AdminChatRow[];
  summary: { rounds: number, pricedRounds: number, reportedCost: number | null };
}

/** A stored message as oversight shows it: read only, drawn as text or through Markdown. */
export interface AdminMessageView {
  role: string;
  /** Text, or parts (text and images) as the provider takes them. */
  content?: string | { type: string, text?: string }[] | null;
  compacted?: true;
  images?: unknown[];
  tool_calls?: { function?: { name?: string, arguments?: string } }[];
}

export interface AdminChatReply {
  id: string;
  title: string;
  updatedAt: number;
  owner: AdminUserView | null;
  running: boolean;
  messages: AdminMessageView[];
  documents: { id: string, filename: string }[];
}

/** One server as oversight lists another person's connectors: their views, or why there are none. */
export interface OverseenServer { name: string, perUser: boolean, title: string, icon: string | null, views: ViewInfo[], reason: string | null }

export interface AdminConnectorsReply {
  user: { id: string, name: string | null, email: string | null };
  servers: OverseenServer[];
}

export interface DocumentTextReply { filename: string, mime: string | null, content: string }

/* ---------- usage: GET /api/usage ---------- */

/** Where a share of a request's tokens went (harness/attribution.ts), summed over requests. */
export interface AttributionTotal {
  requests: number;
  input: AttributionSide;
  output: AttributionSide;
  cached: number;
}
export interface AttributionSide { total: number, reported: number, buckets: { category: string, tokens: number, source: string, capability?: string }[] }

/** One model's tokens on one day. */
export interface DayModelUsage {
  model: string;
  in: number;
  out: number;
  cached: number;
  requests?: number;
  cost?: number;
  pricedRounds?: number;
  attribution?: AttributionTotal;
}

export interface DayUsage {
  day: string;
  in: number;
  out: number;
  cached: number;
  cost?: number;
  pricedRounds?: number;
  models: DayModelUsage[];
}

export type CacheMissReason = 'prefix' | 'switch' | 'expired' | 'stub' | 'provider';

export interface UsageStatistics {
  /** Every model (and the upstreams serving it) there is usage for: what the filter offers. */
  targets: { model: string, providers: string[] }[];
  auxiliary: { requests: number, cost: number | null };
  cache: {
    reportedRounds: number;
    input: number;
    cached: number;
    written: number;
    hitShare: number | null;
    saved: number | null;
    savedShare: number | null;
    rates: { model: string, provider: string | null, full: number, cache: number }[];
    savedRounds: number;
    judged: number;
    misses: Record<CacheMissReason, number>;
  };
  rounds: number;
  pricedRounds: number;
  unpricedRounds: number;
  reportedCost: number | null;
  averageRoundCost: number | null;
  completedAnswers: number;
  pricedAnswers: number;
  averageAnswerCost: number | null;
  averageAnswerTokens: number | null;
  averageRoundsPerAnswer: number | null;
  toolCalls: number;
  models: { model: string, in: number, out: number, cached: number, rounds: number, pricedRounds: number, cost: number | null }[];
  tools: { name: string, calls: number }[];
}

export interface UsageReply {
  days: DayUsage[];
  statistics: UsageStatistics;
}

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
