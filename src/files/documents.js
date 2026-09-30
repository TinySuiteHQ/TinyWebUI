/**
 * Turns an uploaded file's raw bytes into plain text.
 *
 * Parsers for anything beyond plain text are imported lazily -- most uploads
 * will be .txt/.md, and there's no reason to pay pdf-parse's or mammoth's
 * load cost on every server start for the rare PDF or docx.
 */

const TEXT_EXTS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log',
  '.js', '.ts', '.jsx', '.tsx', '.py', '.rb', '.go', '.rs', '.java', '.c', '.cpp', '.h',
  '.css', '.html', '.xml', '.yaml', '.yml', '.sh', '.sql'
]);

function extOf(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

/**
 * How to hand an uploaded file back to a browser. Decided from the name alone,
 * never the client-supplied type: this is served from the app's own origin, so
 * anything a browser would run (html, svg) goes out as inert text or a download.
 */
export function servingFor(filename) {
  const ext = extOf(filename);
  if (ext === '.pdf') return { type: 'application/pdf', inline: true };
  if (TEXT_EXTS.has(ext) || ext === '') return { type: 'text/plain; charset=utf-8', inline: true };
  return { type: 'application/octet-stream', inline: false };
}

/**
 * @param {Buffer} buf raw file bytes
 * @param {string} filename original filename, used only to pick a parser
 * @returns {Promise<string>} extracted plain text
 */
export async function extractText(buf, filename) {
  const ext = extOf(filename);

  if (ext === '.pdf') {
    // unpdf ships its own serverless PDF.js build and needs no native canvas
    // binary for plain text extraction, unlike pdf-parse v2 (which pulls in
    // @napi-rs/canvas even when nothing here ever renders a page).
    let text;
    try {
      const { extractText, getDocumentProxy } = await import('unpdf');
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      ({ text } = await extractText(pdf, { mergePages: true }));
    } catch (err) {
      // pdf.js's own exception names (PasswordException, and a handful of
      // "invalid structure" variants for anything that isn't a well-formed
      // PDF) are not something a user should have to decode -- the two cases
      // worth telling apart are password protection and a file that just
      // isn't a readable PDF at all.
      if (err?.name === 'PasswordException' || /password/i.test(err?.message || '')) {
        throw new Error('this PDF is password-protected -- remove the password and re-upload');
      }
      throw new Error(`could not read this PDF (${err?.message || 'corrupt file, or not actually a PDF'})`);
    }
    if (!text.trim()) {
      // Parsed cleanly but yielded nothing: near-certainly a scanned or
      // image-only PDF. There is no OCR here, so say that plainly instead of
      // leaving it to read like the upload itself failed.
      throw new Error(
        'no extractable text -- this looks like a scanned or image-only PDF, which needs OCR that this app does not do'
      );
    }
    return text;
  }

  if (ext === '.docx') {
    let value;
    try {
      const { extractRawText } = await import('mammoth');
      ({ value } = await extractRawText({ buffer: buf }));
    } catch (err) {
      throw new Error(`could not read this .docx (${err?.message || 'corrupt file, or not actually a .docx'})`);
    }
    return value;
  }

  if (ext === '.doc') {
    throw new Error('legacy .doc is not supported -- save it as .docx or .pdf and re-upload');
  }

  if (TEXT_EXTS.has(ext) || ext === '') {
    return buf.toString('utf8');
  }

  throw new Error(`unsupported file type "${ext || filename}"`);
}
