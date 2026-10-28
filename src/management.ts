/**
 * MCP management views: the `tinysuite.manage/1` contract.
 *
 * A server that wants a management page in TinyWebUI lists an MCP resource
 * with the media type MANIFEST_MIME. Its manifest names views (stats or a
 * paged table, each read from one of the server's resources) and actions
 * (each one of the server's own tools). TinyWebUI draws every view itself
 * from plain data; nothing the server sends is ever run or rendered as HTML.
 *
 * Everything here treats the server as untrusted: the manifest is checked
 * field by field against fixed limits, view data is cut down to scalars, and
 * neither can grant anything. What a view needs (admin, a per-user
 * connection) is decided by routes/integrations.ts from the view's declared
 * scope, which can only narrow who sees it. Resources are read over the MCP
 * connection, so no URL in a manifest is ever fetched.
 *
 * The full contract, for server authors: docs/mcp-management.md.
 */

export const MANIFEST_MIME = 'application/vnd.tinysuite.manage+json';
export const CONTRACT = 'tinysuite.manage/1';

export type ViewKind = 'stats' | 'table';
export type ViewScope = 'user' | 'instance';
export type Format = 'text' | 'multiline' | 'number' | 'datetime';

export interface Param { name: string; label: string; type: 'text' | 'enum'; maxLength?: number; values?: string[] }
export interface Column { key: string; label: string; format: Format }
export interface ActionInput { label: string; initial: string | null; maxLength: number; multiline: boolean }
export interface Action {
  id: string; label: string; tool: string; target: 'row' | 'view';
  args: Record<string, string | number | boolean>;
  input: ActionInput | null; destructive: boolean; confirm: string | null;
}
export interface View {
  id: string; title: string; kind: ViewKind; scope: ViewScope; resource: string;
  pageSize: number; params: Param[]; columns: Column[]; rowKey: string | null;
  detail: string | null; actions: Action[];
}
export interface Manifest { id: string; title: string; description: string; icon: string; version: string; views: View[] }

// Icons TinyWebUI has; anything else is drawn as a plug.
export const ICONS = new Set(['memory', 'search', 'plug', 'database', 'globe', 'tool']);

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const KEY = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const TOOL = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const FORMATS: Format[] = ['text', 'multiline', 'number', 'datetime'];
// Resources are read over MCP, never fetched; schemes that name the web or
// the disk are still refused so a manifest cannot even look like it points there.
const NOT_A_RESOURCE = /^(?:https?|file|data|javascript|ftp|wss?):/i;
const ARG_REF = /^\$row\.([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})$/;

export const LIMITS = Object.freeze({
  views: 12, params: 8, columns: 12, actions: 6, values: 24, label: 80, text: 300,
  pageSize: 100, inputMax: 20000, uri: 512, rows: 100, cell: 20000, fields: 40, items: 40, notice: 500
});

class ManifestError extends Error {}

const fail = (where: string, what: string): never => { throw new ManifestError(`${where}: ${what}`); };
const isObj = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function str(v: unknown, where: string, { max = LIMITS.label, pattern, optional = false }: { max?: number; pattern?: RegExp; optional?: boolean } = {}): string {
  if (v === undefined && optional) return '';
  if (typeof v !== 'string' || !v.length || v.length > max || /[\x00-\x1f\x7f]/.test(v)) fail(where, `must be text of 1-${max} characters`);
  if (pattern && !pattern.test(v as string)) fail(where, 'has characters that are not allowed');
  return v as string;
}

function list(v: unknown, where: string, max: number): unknown[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) fail(where, `must be a list of at most ${max}`);
  return v as unknown[];
}

function template(v: unknown, where: string, placeholder: string): string {
  const uri = str(v, where, { max: LIMITS.uri });
  if (NOT_A_RESOURCE.test(uri)) fail(where, 'must be an MCP resource URI, not a web or file address');
  if (uri.split(placeholder).length !== 2) fail(where, `must contain ${placeholder} exactly once`);
  return uri;
}

function parseParam(v: unknown, where: string): Param {
  if (!isObj(v)) fail(where, 'must be an object');
  const p = v as Record<string, unknown>;
  const name = str(p.name, `${where}.name`, { pattern: KEY });
  if (['offset', 'limit'].includes(name)) fail(`${where}.name`, 'is reserved for paging');
  const label = str(p.label, `${where}.label`);
  if (p.type === 'text') {
    const maxLength = Number.isInteger(p.maxLength) ? Math.min(Math.max(1, p.maxLength as number), 500) : 200;
    return { name, label, type: 'text', maxLength };
  }
  if (p.type === 'enum') {
    const values = list(p.values, `${where}.values`, LIMITS.values).map((x, i) => str(x, `${where}.values[${i}]`, { pattern: KEY }));
    if (!values.length) fail(`${where}.values`, 'must not be empty');
    return { name, label, type: 'enum', values };
  }
  return fail(`${where}.type`, 'must be "text" or "enum"');
}

function parseAction(v: unknown, where: string, tools: Set<string>): Action {
  if (!isObj(v)) fail(where, 'must be an object');
  const a = v as Record<string, unknown>;
  const tool = str(a.tool, `${where}.tool`, { max: 128, pattern: TOOL });
  // An action can only be something the server already offers as a tool.
  if (!tools.has(tool)) fail(`${where}.tool`, `"${tool}" is not one of this server's tools`);
  const target = a.target === undefined || a.target === 'row' ? 'row' : a.target === 'view' ? 'view' : fail(`${where}.target`, 'must be "row" or "view"');
  let input: ActionInput | null = null;
  if (a.input !== undefined) {
    if (!isObj(a.input)) fail(`${where}.input`, 'must be an object');
    const i = a.input as Record<string, unknown>;
    input = {
      label: str(i.label, `${where}.input.label`),
      initial: i.initial === undefined ? null : str(i.initial, `${where}.input.initial`, { pattern: KEY }),
      maxLength: Number.isInteger(i.maxLength) ? Math.min(Math.max(1, i.maxLength as number), LIMITS.inputMax) : 2000,
      multiline: i.multiline === true
    };
  }
  if (!isObj(a.args)) fail(`${where}.args`, 'must be an object');
  const args: Record<string, string | number | boolean> = {};
  const entries = Object.entries(a.args as Record<string, unknown>);
  if (entries.length > 16) fail(`${where}.args`, 'has too many arguments');
  for (const [name, value] of entries) {
    if (!KEY.test(name)) fail(`${where}.args`, `"${name}" is not a valid argument name`);
    if (typeof value === 'string') {
      if (value === '$input' && !input) fail(`${where}.args.${name}`, 'uses $input but the action has no input');
      if (value.startsWith('$row.') && (target !== 'row' || !ARG_REF.test(value))) fail(`${where}.args.${name}`, 'is not a usable $row reference');
      if (value.startsWith('$') && value !== '$input' && !value.startsWith('$row.')) fail(`${where}.args.${name}`, 'unknown reference');
      args[name] = str(value, `${where}.args.${name}`, { max: 500 });
    } else if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') {
      args[name] = value as number | boolean;
    } else {
      fail(`${where}.args.${name}`, 'must be text, a number, or true/false');
    }
  }
  return {
    id: str(a.id, `${where}.id`, { pattern: ID }),
    label: str(a.label, `${where}.label`),
    tool, target, args, input,
    destructive: a.destructive === true,
    confirm: a.confirm === undefined ? null : str(a.confirm, `${where}.confirm`, { max: LIMITS.text })
  };
}

function parseView(v: unknown, where: string, tools: Set<string>): View {
  if (!isObj(v)) fail(where, 'must be an object');
  const w = v as Record<string, unknown>;
  const kind = w.kind === 'stats' || w.kind === 'table' ? w.kind : fail(`${where}.kind`, 'must be "stats" or "table"');
  const scope = w.scope === 'user' || w.scope === 'instance' ? w.scope : fail(`${where}.scope`, 'must be "user" or "instance"');
  const view: View = {
    id: str(w.id, `${where}.id`, { pattern: ID }),
    title: str(w.title, `${where}.title`),
    kind, scope,
    resource: template(w.resource, `${where}.resource`, '{params}'),
    pageSize: Number.isInteger(w.pageSize) ? Math.min(Math.max(1, w.pageSize as number), LIMITS.pageSize) : 50,
    params: list(w.params, `${where}.params`, LIMITS.params).map((p, i) => parseParam(p, `${where}.params[${i}]`)),
    columns: [], rowKey: null, detail: null, actions: []
  };
  if (new Set(view.params.map((p) => p.name)).size !== view.params.length) fail(`${where}.params`, 'repeats a name');
  if (kind === 'table') {
    view.columns = list(w.columns, `${where}.columns`, LIMITS.columns).map((c, i) => {
      if (!isObj(c)) fail(`${where}.columns[${i}]`, 'must be an object');
      const col = c as Record<string, unknown>;
      const format = col.format === undefined ? 'text' : FORMATS.includes(col.format as Format) ? col.format as Format : fail(`${where}.columns[${i}].format`, `must be one of ${FORMATS.join(', ')}`);
      return { key: str(col.key, `${where}.columns[${i}].key`, { pattern: KEY }), label: str(col.label, `${where}.columns[${i}].label`), format };
    });
    if (!view.columns.length) fail(`${where}.columns`, 'a table needs at least one column');
    view.rowKey = w.rowKey === undefined ? null : str(w.rowKey, `${where}.rowKey`, { pattern: KEY });
    if (w.detail !== undefined) {
      if (!isObj(w.detail)) fail(`${where}.detail`, 'must be an object');
      if (!view.rowKey) fail(`${where}.detail`, 'needs rowKey to know which row to open');
      view.detail = template((w.detail as Record<string, unknown>).resource, `${where}.detail.resource`, '{id}');
    }
    view.actions = list(w.actions, `${where}.actions`, LIMITS.actions).map((a, i) => parseAction(a, `${where}.actions[${i}]`, tools));
    if (new Set(view.actions.map((a) => a.id)).size !== view.actions.length) fail(`${where}.actions`, 'repeats an id');
  } else if (w.actions !== undefined && list(w.actions, `${where}.actions`, LIMITS.actions).length) {
    fail(`${where}.actions`, 'only table views take actions');
  }
  return view;
}

/**
 * A manifest as TinyWebUI will use it, or a thrown error naming the first
 * problem. `tools` are the server's own tool names: actions may name only those.
 */
export function parseManifest(raw: unknown, tools: Set<string>): Manifest {
  let m = raw;
  if (typeof m === 'string') {
    if (m.length > 200_000) fail('manifest', 'is too large');
    try { m = JSON.parse(m); } catch { fail('manifest', 'is not JSON'); }
  }
  if (!isObj(m)) fail('manifest', 'must be a JSON object');
  const o = m as Record<string, unknown>;
  if (o.contract !== CONTRACT) fail('manifest.contract', `must be "${CONTRACT}" (this TinyWebUI supports no other version)`);
  const views = list(o.views, 'manifest.views', LIMITS.views).map((v, i) => parseView(v, `views[${i}]`, tools));
  if (new Set(views.map((v) => v.id)).size !== views.length) fail('manifest.views', 'repeats an id');
  const icon = typeof o.icon === 'string' && ICONS.has(o.icon) ? o.icon : 'plug';
  return {
    id: str(o.id, 'manifest.id', { pattern: ID }),
    title: str(o.title, 'manifest.title'),
    description: str(o.description, 'manifest.description', { max: LIMITS.text, optional: true }),
    icon,
    version: str(o.version, 'manifest.version', { max: 40, optional: true }),
    views
  };
}

export { ManifestError };

/* ---------- requests: what the browser may ask for ---------- */

/**
 * The view's resource URI for these query values, or a thrown error. Only
 * declared parameters pass, each checked against its declaration; paging is
 * clamped to the view's page size. The querystring is percent-encoded into
 * the single {params} segment ("-" when empty).
 */
export function viewUri(view: View, query: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const p of view.params) {
    const value = query.get(p.name);
    if (value === null || value === '') continue;
    if (p.type === 'enum' && !p.values!.includes(value)) throw new ManifestError(`"${p.name}" must be one of ${p.values!.join(', ')}`);
    if (p.type === 'text' && (value.length > p.maxLength! || /[\x00-\x1f\x7f]/.test(value))) throw new ManifestError(`"${p.name}" is too long`);
    out.set(p.name, value);
  }
  if (view.kind === 'table') {
    const offset = Number.parseInt(query.get('offset') || '0', 10);
    const limit = Number.parseInt(query.get('limit') || String(view.pageSize), 10);
    out.set('offset', String(Number.isFinite(offset) ? Math.min(Math.max(0, offset), 10_000_000) : 0));
    out.set('limit', String(Number.isFinite(limit) ? Math.min(Math.max(1, limit), view.pageSize) : view.pageSize));
  }
  const qs = out.toString();
  return view.resource.replace('{params}', qs ? encodeURIComponent(qs) : '-');
}

/** The detail resource URI for one row id, or a thrown error. */
export function detailUri(view: View, id: string): string {
  if (!view.detail) throw new ManifestError('this view has no detail');
  if (!id || id.length > 200 || /[\x00-\x1f\x7f]/.test(id)) throw new ManifestError('invalid id');
  return view.detail.replace('{id}', encodeURIComponent(id));
}

/**
 * The tool arguments for one action, built only from the manifest's binding:
 * constants, `$row.<key>` from the row the browser sent back, and `$input`.
 * The row is the browser's word, so it is checked for shape only -- the
 * server applies the caller's own identity to whatever it names.
 */
export function actionArgs(action: Action, row: unknown, input: unknown): Record<string, unknown> {
  const r = isObj(row) ? row : {};
  const args: Record<string, unknown> = {};
  for (const [name, bound] of Object.entries(action.args)) {
    if (bound === '$input') {
      if (typeof input !== 'string' || !input.trim() || input.length > action.input!.maxLength) {
        throw new ManifestError(`${action.input!.label} must be 1-${action.input!.maxLength} characters`);
      }
      args[name] = input;
    } else if (typeof bound === 'string' && bound.startsWith('$row.')) {
      const value = r[bound.slice(5)];
      if (!(typeof value === 'string' && value.length && value.length <= 2000) && !(typeof value === 'number' && Number.isFinite(value))) {
        throw new ManifestError(`the selected row has no usable "${bound.slice(5)}"`);
      }
      args[name] = value;
    } else {
      args[name] = bound;
    }
  }
  return args;
}

/* ---------- responses: what reaches the browser ---------- */

const scalar = (v: unknown, max: number = LIMITS.cell) => {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.length > max ? `${v.slice(0, max)}…` : v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  return null; // nested values are not shown
};
const text = (v: unknown, max: number) => (typeof v === 'string' && v ? v.slice(0, max) : null);

/** View data cut down to what the panel draws: scalars only, bounded. */
export function shapeViewData(view: View, data: unknown): Record<string, unknown> {
  const d = isObj(data) ? data : {};
  const notice = text(d.notice, LIMITS.notice);
  if (view.kind === 'stats') {
    const items = (Array.isArray(d.items) ? d.items : []).slice(0, LIMITS.items).filter(isObj).map((i) => ({
      label: text(i.label, LIMITS.label) || '',
      value: scalar(i.value, 2000),
      unit: text(i.unit, 20),
      hint: text(i.hint, LIMITS.text),
      format: FORMATS.includes(i.format as Format) ? i.format : null
    }));
    return { items, notice };
  }
  const keys = new Set([...view.columns.map((c) => c.key), ...(view.rowKey ? [view.rowKey] : []),
    ...view.actions.flatMap((a) => Object.values(a.args).filter((b): b is string => typeof b === 'string' && b.startsWith('$row.')).map((b) => b.slice(5))),
    ...view.actions.map((a) => a.input?.initial).filter((k): k is string => Boolean(k))]);
  const rows = (Array.isArray(d.rows) ? d.rows : []).slice(0, LIMITS.rows).filter(isObj)
    .map((row) => Object.fromEntries([...keys].map((k) => [k, scalar(row[k])])));
  const int = (v: unknown, fallback: number | null) => (Number.isInteger(v) && (v as number) >= 0 ? v as number : fallback);
  return { rows, total: int(d.total, null), offset: int(d.offset, 0), limit: int(d.limit, view.pageSize), hasMore: d.hasMore === true, notice };
}

/** Detail data for one row: labelled fields, plus the row the actions bind to. */
export function shapeDetail(view: View, data: unknown): Record<string, unknown> {
  const d = isObj(data) ? data : {};
  const fields = (Array.isArray(d.fields) ? d.fields : []).slice(0, LIMITS.fields).filter(isObj).map((f) => ({
    label: text(f.label, LIMITS.label) || '',
    value: scalar(f.value),
    format: FORMATS.includes(f.format as Format) ? f.format : 'text'
  }));
  const { rows } = shapeViewData(view, { rows: isObj(d.row) ? [d.row] : [] }) as { rows: Record<string, unknown>[] };
  return { fields, row: rows[0] || null };
}

/** What the browser is told about a view and its actions: never tool names or URIs. */
export function publicView(view: View) {
  return {
    id: view.id, title: view.title, kind: view.kind, scope: view.scope, pageSize: view.pageSize,
    params: view.params, columns: view.columns, rowKey: view.rowKey, hasDetail: Boolean(view.detail),
    actions: view.actions.map((a) => ({ id: a.id, label: a.label, target: a.target, input: a.input, destructive: a.destructive, confirm: a.confirm }))
  };
}
