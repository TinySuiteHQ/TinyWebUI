import { randomBytes } from 'node:crypto';

// The transcript: messages in order, and the tool-result artifacts behind them.
// Methods of Store; see index.js.

export class MessageStore {
  nextSeq(chatId) {
    const row = this.db.prepare('SELECT MAX(seq) AS m FROM messages WHERE chat_id = ?').get(chatId);
    return (row?.m ?? -1) + 1;
  }

  /** Appends one message. Append-only by design: rows are never reordered. */
  addMessage(chatId, msg) {
    const seq = this.nextSeq(chatId);
    this.db.prepare(`
      INSERT INTO messages
        (chat_id, seq, role, content, tool_call_id, tool_calls_json,
         reasoning, reasoning_details_json, artifact_id, stub_text, usage_json,
         model, created_at, images_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      chatId, seq, msg.role,
      msg.content ?? null,
      msg.tool_call_id ?? null,
      msg.tool_calls ? JSON.stringify(msg.tool_calls) : null,
      msg.reasoning ?? null,
      msg.reasoning_details ? JSON.stringify(msg.reasoning_details) : null,
      msg.artifact_id ?? null,
      msg.stub_text ?? null,
      msg.usage ? JSON.stringify(msg.usage) : null,
      msg.model ?? null,
      Date.now(),
      msg.images ? JSON.stringify(msg.images) : null
    );
    return seq;
  }

  updateMessageUsage(chatId, seq, usage) {
    this.db.prepare('UPDATE messages SET usage_json = ? WHERE chat_id = ? AND seq = ?')
      .run(JSON.stringify(usage), chatId, seq);
  }

  messages(chatId) {
    return this.db.prepare(
      'SELECT * FROM messages WHERE chat_id = ? ORDER BY seq ASC'
    ).all(chatId);
  }

  /**
   * Writes a stub onto an already-stored tool message. This is the ONE place
   * history is rewritten, and it happens only at an epoch boundary. `content`
   * is left untouched so the human transcript keeps the full output -- only
   * what goes to the model shrinks.
   */
  setStub(messageId, stubText) {
    this.db.prepare('UPDATE messages SET stub_text = ? WHERE id = ?').run(stubText, messageId);
  }

  /** Takes a message's images off the wire at an epoch; the transcript keeps them. */
  dropImages(messageId) {
    this.db.prepare('UPDATE messages SET images_dropped = 1 WHERE id = ?').run(messageId);
  }

  addArtifact(chatId, { toolName, args, content }) {
    const id = randomBytes(12).toString('hex');
    this.db.prepare(`
      INSERT INTO artifacts (id, chat_id, tool_name, args_json, content, char_len, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, chatId, toolName, JSON.stringify(args ?? {}), content, content.length, Date.now());
    return id;
  }

  getArtifact(id, chatId) {
    return this.db.prepare('SELECT * FROM artifacts WHERE id = ? AND chat_id = ?').get(id, chatId) || null;
  }
}
