/**
 * read_document -- lets the model read text the user attached to the chat.
 *
 * Same shape as context_expand: a document is an opaque blob (extracted text
 * of whatever the user dropped in), scoped to the chat that owns it, read
 * either by a narrowing query or by paging through raw offsets. `query`
 * ranks the document's own pre-split chunks with FTS5's bm25() -- the
 * "chunking and retrieval" this needs, without a vector index or embeddings.
 */

export const READ_DOCUMENT = 'read_document';

export function documentToolDef() {
  return {
    type: 'function',
    function: {
      name: READ_DOCUMENT,
      description: [
        'Read an attached document. Documents appear as',
        '"[Attached document: ... (id: <id>, ...)]" notes in the conversation.',
        '',
        'Give a query to search the document\'s chunks for relevant passages (best for',
        'long documents and specific questions), or use offset/limit to page through the',
        'raw text from the start. With neither, returns the beginning of the document.'
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          document_id: {
            type: 'string',
            description: 'The id shown in the "[Attached document: ...]" note, e.g. "a1b2c3d4".'
          },
          query: {
            type: 'string',
            description: 'Free-text query. Returns the best-matching passages, ranked by relevance.'
          },
          offset: {
            type: 'integer',
            description: 'Character offset to start reading from. Ignored when query is given.'
          },
          limit: {
            type: 'integer',
            description: 'Maximum characters to return. Capped by the server budget.'
          }
        },
        required: ['document_id']
      }
    }
  };
}

function header(doc, note) {
  return `[document ${doc.id} · ${doc.filename} · ${doc.char_len.toLocaleString('en-US')} chars · ${note}]`;
}

function queryView(store, doc, query, budget) {
  const hits = store.searchDocumentChunks(doc.id, query, 5);
  if (!hits.length) {
    return `${header(doc, `no match for "${query}"`)}\nTry a broader query, or read from the start with offset/limit.`;
  }
  const out = [header(doc, `${hits.length} passage(s) matching "${query}"`)];
  let used = out[0].length;
  for (const hit of hits) {
    const block = `--- chunk ${hit.chunkIdx} (offset ${hit.charStart.toLocaleString('en-US')}) ---\n${hit.body}`;
    if (used + block.length > budget) {
      out.push('… remaining matches omitted; narrow the query.');
      break;
    }
    out.push(block);
    used += block.length + 2;
  }
  return out.join('\n\n');
}

function windowView(doc, offset, limit, budget) {
  const text = doc.content;
  const start = Math.max(0, Math.min(offset, text.length));
  const size = Math.min(limit > 0 ? limit : budget, budget);
  const slice = text.slice(start, start + size);
  const end = start + slice.length;
  const note = `chars ${start.toLocaleString('en-US')}–${end.toLocaleString('en-US')}`;
  const more = end < text.length
    ? `\n[… ${(text.length - end).toLocaleString('en-US')} chars remain; continue with offset=${end}.]`
    : '';
  return `${header(doc, note)}\n${slice}${more}`;
}

/** Runs one read. Returns a string, like every other tool result. */
export function callReadDocument(args, { store, chatId, budget = 8000 }) {
  const id = String(args?.document_id || '').trim();
  if (!id) return 'Error: document_id is required.';

  const doc = store.getDocument(id);
  if (!doc) return `Error: no document "${id}". Ids appear in the "[Attached document: ...]" note.`;
  if (doc.chat_id !== chatId) return `Error: document "${id}" does not belong to this conversation.`;

  if (args.query) return queryView(store, doc, String(args.query), budget);
  return windowView(doc, Number(args.offset) || 0, Number(args.limit) || 0, budget);
}
