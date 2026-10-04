/**
 * The inline note that tells the model a document's id ("read_document" needs
 * it). It lives in the stored message text, so the page strips it back out to
 * draw a chip instead. One module for both directions: the server writes the
 * note, the transcript reads it, and they cannot drift apart.
 */

export function attachmentNote(doc) {
  return `\n\n[Attached document: "${doc.filename}" (id: ${doc.id}, ${doc.char_len.toLocaleString('en-US')} chars). Use read_document to search or read it.]`;
}

// Only notes at the very end count: the server appends them after the user's
// text, so one the user typed mid-message is left alone.
const NOTES_AT_END = /(?:\n\n\[Attached document: ".*?" \(id: ([\w.-]+), [\d,]+ chars\)\. Use read_document to search or read it\.\])+$/;
const ONE_NOTE = /\[Attached document: ".*?" \(id: ([\w.-]+), /g;

/** A stored message's text without its notes, and the document ids they named. */
export function splitAttachmentNotes(content) {
  const text = String(content ?? '');
  const tail = NOTES_AT_END.exec(text);
  if (!tail) return { text, ids: [] };
  return { text: text.slice(0, tail.index), ids: [...tail[0].matchAll(ONE_NOTE)].map((m) => m[1]) };
}
