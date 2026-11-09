/**
 * The inline note that tells the model a document's id ("read_document" needs
 * it). It lives in the stored message text, so the page strips it back out to
 * draw a chip instead. One module for both directions: the server writes the
 * note, the transcript reads it, and they cannot drift apart.
 */

export function attachmentNote(doc: { id: string, filename: string, char_len: number }): string {
  return `\n\n[Attached document: "${doc.filename}" (id: ${doc.id}, ${doc.char_len.toLocaleString('en-US')} chars). Use read_document to search or read it.]`;
}

// Only notes at the very end count: the server appends them after the user's
// text, so one the user typed mid-message is left alone.
const NOTES_AT_END = /(?:\n\n\[Attached document: ".*?" \(id: ([\w.-]+), [\d,]+ chars\)\. Use read_document to search or read it\.\])+$/;
const ONE_NOTE = /\[Attached document: "(.*?)" \(id: ([\w.-]+), /g;

/** A stored message's text without its notes, and the documents they named (id and file name, in order). */
export function splitAttachmentNotes(content: unknown): { text: string, ids: string[], names: string[] } {
  const text = String(content ?? '');
  const tail = NOTES_AT_END.exec(text);
  if (!tail) return { text, ids: [], names: [] };
  const notes = [...tail[0].matchAll(ONE_NOTE)];
  return { text: text.slice(0, tail.index), ids: notes.map((m) => m[2] as string), names: notes.map((m) => m[1] as string) };
}
