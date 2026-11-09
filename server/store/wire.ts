/* Row <-> message shapes: what the model is sent (toWire) and what the UI shows (toView). */

import type { ChatMessage, ContentPart, ReasoningDetail } from '../harness/types.ts';
import type { MessageImage, MessageRow } from './messages.ts';

/** A stored row, or a message about to be stored as one (the tool executor's). */
export type WireRow = Pick<MessageRow, 'role' | 'content'> & Partial<Omit<MessageRow, 'role' | 'content'>>;

/** A row as the transcript shows it. */
export interface ViewMessage extends ChatMessage {
  seq: number;
  usage?: Record<string, unknown>;
  compacted?: true;
  origin?: Record<string, unknown>;
  images?: MessageImage[];
}

/**
 * A JSON column read back, or undefined when it does not parse or is not the
 * shape asked for. One damaged row must not take its whole chat down with it
 * (no transcript, no model call): the field is left off instead, and what the
 * history needs to stay valid (an orphaned tool result, say) is repaired
 * downstream, by harness/history.ts, as it is for a turn cut short.
 */
export function parseColumn(text: string | null | undefined, shape: 'array'): unknown[] | undefined;
export function parseColumn(text: string | null | undefined, shape: 'object'): Record<string, unknown> | undefined;
export function parseColumn(text: string | null | undefined, shape: 'array' | 'object'): unknown {
  if (!text) return undefined;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (shape === 'array') return Array.isArray(value) ? value : undefined;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** A tool call the provider can be sent: the shape the harness relies on. */
const isToolCall = (c: unknown): boolean => {
  const call = c as { id?: unknown, function?: { name?: unknown, arguments?: unknown } } | null;
  return Boolean(call && typeof call.id === 'string' && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string');
};

function base(row: WireRow): ChatMessage & { images?: MessageImage[] } {
  // content is set by each caller, after these, so the key order stays as it was.
  const msg = { role: row.role } as ChatMessage & { images?: MessageImage[] };
  if (row.tool_call_id) msg.tool_call_id = row.tool_call_id;
  const calls = parseColumn(row.tool_calls_json, 'array')?.filter(isToolCall);
  if (calls?.length) msg.tool_calls = calls as ChatMessage['tool_calls'];
  const details = parseColumn(row.reasoning_details_json, 'array');
  if (details) msg.reasoning_details = details as ReasoningDetail[];
  const images = parseColumn(row.images_json, 'array');
  if (images) msg.images = images as MessageImage[];
  return msg;
}

/**
 * What the model sees. A demoted tool message sends its stub; everything else
 * sends its content verbatim. Reasoning text rides along; `buildMessages` in
 * harness/provider.js decides whether the provider gets it back.
 */
export function toWire(row: WireRow): ChatMessage {
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
  // is what most of the caching machinery in harness/provider.js assumes.
  if (msg.images?.length) {
    const parts: ContentPart[] = [];
    // Still the row's own text here: parts are only built below.
    if (msg.content) parts.push({ type: 'text', text: msg.content as string });
    for (const img of msg.images) {
      parts.push({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } });
    }
    msg.content = parts;
  }
  delete msg.images;
  return msg;
}

/** What the transcript shows: always the full text, stub or not. */
export function toView(row: MessageRow): ViewMessage {
  const msg = base(row) as ViewMessage;
  // The client needs a handle on each message to be able to rewind to one.
  msg.seq = row.seq;
  msg.content = row.content ?? null;
  if (row.reasoning) msg.reasoning = row.reasoning;
  const usage = parseColumn(row.usage_json, 'object');
  if (usage) msg.usage = usage;
  if (row.stub_text) msg.compacted = true;
  const origin = parseColumn(row.origin_json, 'object');
  if (origin) msg.origin = origin;
  return msg;
}
