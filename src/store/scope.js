/* Helpers every area of the store shares: whose rows a query sees, and safe FTS5 queries. */

/**
 * Every read of user-owned rows names whose rows it wants. There is no
 * default: `undefined` throws, so a caller that forgot to pass the
 * authenticated user fails loudly instead of silently seeing everyone's data.
 *   string     that user's rows
 *   null       rows with no owner (legacy / pre-auth rows)
 *   ALL_USERS  no filter -- authMode 'none', admin views, internal plumbing
 */
export const ALL_USERS = Symbol('all-users');

export function scope(userId, col = 'user_id') {
  if (userId === ALL_USERS) return { sql: '1=1', params: [] };
  if (userId === null) return { sql: `${col} IS NULL`, params: [] };
  if (typeof userId === 'string' && userId) return { sql: `${col} = ?`, params: [userId] };
  throw new TypeError('store: a user scope is required (pass a user id, null, or ALL_USERS)');
}

/** The owner to write onto a new row: ALL_USERS (no auth) owns as null. */
export function ownerOf(userId) {
  if (userId === ALL_USERS || userId === null || userId === undefined) return null;
  return String(userId);
}

/**
 * Turns free text from a search box into an FTS5 MATCH expression that cannot
 * fail to parse. FTS5's own query grammar has ANDs, ORs, dashes, colons and
 * parens in it, and a search box is not a query language -- a user typing
 * "what's tuition cost?" should search for those words, not hit a syntax
 * error. Quoting every token as its own phrase turns that grammar off entirely
 * and leaves only AND-of-words, plus a trailing "*" on the last token so a
 * query still narrows results while it is being typed rather than only once
 * a whole word is finished.
 */
export function ftsQuery(raw, { any = false } = {}) {
  const tokens = String(raw ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 12);
  if (!tokens.length) return '';
  const esc = (t) => t.replace(/"/g, '""');
  return tokens
    .map((t, i) => (i === tokens.length - 1 ? `"${esc(t)}"*` : `"${esc(t)}"`))
    .join(any ? ' OR ' : ' ');
}
