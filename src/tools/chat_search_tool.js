/**
 * search_chats -- lets the model look up the user's earlier conversations:
 * what they asked and the answer they finally got. Ranked by the same
 * retrieval engine as read_document (retrieval.js, 'chats' corpus), so it is
 * lexical, dense or hybrid with retrieval.mode. Only the asking chat's owner's
 * chats are searched, and never the asking chat itself -- that one is already
 * in context (and context_expand reads what compaction folded away).
 */

export const SEARCH_CHATS = 'search_chats';

const MAX_RESULTS = 10;

export function chatSearchToolDef() {
  return {
    type: 'function',
    function: {
      name: SEARCH_CHATS,
      description: [
        "Search the user's earlier conversations (not this one) for what they asked and the answers they got.",
        'Use it when the user refers to something discussed before ("like last time", "what did we decide about..."),',
        'or when an earlier answer would save redoing work. Returns the best-matching question/answer pairs,',
        'each with the chat it came from. Phrase the query as the topic, not as a question to the user.'
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to look for, in plain words.' },
          limit: { type: 'integer', description: `How many turns to return, 1-${MAX_RESULTS} (default 5).` }
        },
        required: ['query']
      }
    }
  };
}

const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : 'undated');

function clip(text, max) {
  const t = String(text || '').trim();
  return t.length > max ? `${t.slice(0, max)}… [${(t.length - max).toLocaleString('en-US')} more chars]` : t;
}

/** Runs one search. Returns a string, like every other tool result. */
export async function callSearchChats(args, { store, retrieval, chatId, budget = 8000 }) {
  const query = String(args?.query || '').trim();
  if (!query) return 'Error: query is required.';
  const limit = Math.min(MAX_RESULTS, Math.max(1, Number.parseInt(args?.limit, 10) || 5));
  const owner = chatId ? store.chatById(chatId)?.user_id ?? null : null;
  const hits = await retrieval.search('chats', { userId: owner, excludeChatId: chatId ?? null }, query, limit);
  if (!hits.length) return `[search_chats · no earlier conversation matches "${query}"]\nTry other words for the same topic.`;

  const out = [`[search_chats · ${hits.length} turn(s) matching "${query}"]`];
  const share = Math.max(400, Math.floor((budget - out[0].length) / hits.length) - 120);
  for (const h of hits) {
    const q = clip(h.question, Math.min(600, Math.floor(share / 3)));
    const a = h.answer ? clip(h.answer, share - q.length) : '(no answer recorded)';
    out.push(`--- "${h.chatTitle}" · ${day(h.createdAt)} · chat ${h.chatId} ---\nQ: ${q}\nA: ${a}`);
  }
  return out.join('\n\n');
}
