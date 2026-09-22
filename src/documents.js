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
    const { extractText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  }

  if (ext === '.docx') {
    const { extractRawText } = await import('mammoth');
    const { value } = await extractRawText({ buffer: buf });
    return value;
  }

  if (TEXT_EXTS.has(ext) || ext === '') {
    return buf.toString('utf8');
  }

  throw new Error(`unsupported file type "${ext || filename}"`);
}
