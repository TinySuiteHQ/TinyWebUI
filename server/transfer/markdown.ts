/**
 * A chat as a Markdown transcript, for reading and sharing rather than for
 * importing back: each question, then the answer to it, with the tools the
 * answer used named under it. Reasoning, raw tool output and usage are left
 * out; the backup file keeps those.
 */
import { splitAttachmentNotes } from '../../shared/attachment_note.ts';
import { ORIGIN } from '../../shared/origins.ts';
import type { ChatRow } from '../store/chats.ts';
import type { MessageRow } from '../store/messages.ts';

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : '');

function origin(r: MessageRow): { type?: string; name?: string } | null {
  if (!r.origin_json) return null;
  try { return JSON.parse(r.origin_json); } catch { return null; }
}

function toolNames(r: MessageRow): string[] {
  if (!r.tool_calls_json) return [];
  try {
    const calls: unknown = JSON.parse(r.tool_calls_json);
    return Array.isArray(calls) ? calls.map((c) => c?.function?.name).filter((n): n is string => typeof n === 'string') : [];
  } catch { return []; }
}

export function chatMarkdown(chat: ChatRow, rows: MessageRow[]): string {
  const out: string[] = [`# ${chat.title}`, '', `Exported from TinyWebUI on ${when(Date.now())}. Created ${when(chat.created_at)}.`];
  // One answer can be many rows (text, tool calls, tool results, more text): gathered until the next question.
  let answer: { texts: string[]; tools: string[]; model: string | null } | null = null;
  const flush = () => {
    if (!answer) return;
    const tools = [...new Set(answer.tools)];
    if (answer.texts.length || tools.length) {
      out.push('', `## Assistant${answer.model ? ` (${answer.model})` : ''}`, '');
      if (tools.length) out.push(`*Used ${tools.map((t) => `\`${t}\``).join(', ')}*`, '');
      out.push(answer.texts.join('\n\n') || '*(no text)*');
    }
    answer = null;
  };
  for (const r of rows) {
    if (r.role === 'system') continue;
    if (r.role === 'user') {
      flush();
      const o = origin(r);
      const { text, names } = splitAttachmentNotes(r.content);
      const images = r.images_json ? (JSON.parse(r.images_json) as unknown[]).length : 0;
      out.push('', o?.type === ORIGIN.AUTOMATION ? `## Automation: ${o.name || 'run'} · ${when(r.created_at)}` : `## You · ${when(r.created_at)}`, '');
      out.push(text.trim() || '*(no text)*');
      const files = [...names, ...(images ? [`${images} image${images === 1 ? '' : 's'}`] : [])];
      if (files.length) out.push('', `*Attached: ${files.join(', ')}*`);
      continue;
    }
    answer ??= { texts: [], tools: [], model: null };
    if (r.role === 'assistant') {
      if (r.content?.trim()) answer.texts.push(r.content.trim());
      answer.tools.push(...toolNames(r));
      answer.model = r.model || answer.model;
    }
  }
  flush();
  return out.join('\n') + '\n';
}
