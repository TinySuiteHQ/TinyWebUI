/* Row <-> message shapes: what the model is sent (toWire) and what the UI shows (toView). */

function base(row) {
  const msg = { role: row.role };
  if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
  if (row.tool_calls_json) msg.tool_calls = JSON.parse(row.tool_calls_json);
  if (row.reasoning_details_json) msg.reasoning_details = JSON.parse(row.reasoning_details_json);
  if (row.images_json) msg.images = JSON.parse(row.images_json);
  return msg;
}

/**
 * What the model sees. A demoted tool message sends its stub; everything else
 * sends its content verbatim. Reasoning is retained internally; the provider serializer decides which
 * fields belong on the wire.
 */
export function toWire(row) {
  const msg = base(row);
  if (row.reasoning) msg.reasoning = row.reasoning;
  msg.content = row.role === 'tool' ? (row.stub_text ?? row.content) : (row.content ?? null);
  // An epoch took these images off the wire. The note is a pure function of
  // the row, so every rebuild sends the same bytes.
  if (row.images_dropped && msg.images?.length) {
    const n = msg.images.length;
    msg.content = `${msg.content ?? ''}\n\n[${n} image${n === 1 ? '' : 's'} attached here ${n === 1 ? 'was' : 'were'} removed from context to save space. Ask the user to re-attach if you need to look again.]`;
    delete msg.images;
  }
  // A model that was sent images needs the OpenAI multimodal shape -- an array
  // of parts rather than a plain string. Built only when there are images, so
  // every text-only turn keeps sending the plain string it always has, which
  // is what most of the caching machinery in llm.js assumes.
  if (msg.images?.length) {
    const parts = [];
    if (msg.content) parts.push({ type: 'text', text: msg.content });
    for (const img of msg.images) {
      parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
    }
    msg.content = parts;
  }
  delete msg.images;
  return msg;
}

/** What the transcript shows: always the full text, stub or not. */
export function toView(row) {
  const msg = base(row);
  // The client needs a handle on each message to be able to rewind to one.
  msg.seq = row.seq;
  msg.content = row.content ?? null;
  if (row.reasoning) msg.reasoning = row.reasoning;
  if (row.usage_json) msg.usage = JSON.parse(row.usage_json);
  if (row.stub_text) msg.compacted = true;
  if (row.origin_json) msg.origin = JSON.parse(row.origin_json);
  return msg;
}
