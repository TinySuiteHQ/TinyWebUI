/**
 * What kind of file a name (and type, when known) is, for the label and icon
 * the Files page and the attachment cards show. One place, so a file reads the
 * same in the composer, the transcript and the list.
 */
export type FileKind = { label: string, icon: string };

const BY_EXT: Record<string, FileKind> = {};
function kind(label: string, icon: string, exts: string[]) { for (const e of exts) BY_EXT[e] = { label, icon }; }
kind('PDF', 'filePdf', ['pdf']);
kind('Word', 'doc', ['docx', 'doc']);
kind('Text', 'doc', ['txt', 'log']);
kind('Markdown', 'doc', ['md', 'markdown']);
kind('Spreadsheet', 'fileSheet', ['csv', 'tsv']);
kind('JSON', 'fileCode', ['json']);
kind('Code', 'fileCode', ['js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'xml', 'yaml', 'yml', 'sh', 'sql']);
kind('Image', 'image', ['png', 'jpg', 'jpeg', 'webp', 'gif', 'heic', 'heif', 'avif']);

export const IMAGE_KIND: FileKind = BY_EXT.png;

export function fileKind(name: string | null | undefined, mime?: string | null): FileKind {
  if (mime?.startsWith('image/')) return IMAGE_KIND;
  const i = name ? name.lastIndexOf('.') : -1;
  const ext = name && i !== -1 ? name.slice(i + 1).toLowerCase() : '';
  return BY_EXT[ext] || { label: ext ? ext.toUpperCase() : 'File', icon: 'doc' };
}
