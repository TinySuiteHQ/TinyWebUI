import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import heicConvert from 'heic-convert';
import decodeAvif, { init as initAvif } from '@jsquash/avif/decode.js';
import jpeg from 'jpeg-js';

// Node has WebAssembly, but its types live in the DOM lib, which a server must not load.
declare const WebAssembly: { compile(bytes: Uint8Array): Promise<unknown> };

// @jsquash/avif is built for the browser and fetches its own .wasm by URL on
// init; Node's fetch can't load a file: URL, so the module is compiled and
// handed to it directly instead. Compiled once, lazily, and reused.
let avifReady: Promise<unknown> | undefined;
function ensureAvif() {
  if (!avifReady) {
    const wasmPath = fileURLToPath(import.meta.resolve('@jsquash/avif/codec/dec/avif_dec.wasm'));
    // The typings describe browser init options; handing it the compiled module works the same.
    avifReady = WebAssembly.compile(readFileSync(wasmPath)).then((mod) => initAvif(mod as Parameters<typeof initAvif>[0]));
  }
  return avifReady;
}

/** Formats every OpenAI-compatible vision endpoint accepts on the wire. */
const WIRE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
/** True for the raster types normalizing produces; never SVG, which would be a script on this origin. */
export const isWireMime = (mime: string) => WIRE_MIMES.has(mime);

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Browser-reported mime for HEIC/AVIF is unreliable -- Chrome often reports
 * an empty string for HEIC, and some pickers report generic octet-stream for
 * both. Sniffing the ISO-BMFF ftyp brand is what actually tells them apart.
 */
function sniff(buf: Buffer) {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return null;
  const brand = buf.toString('ascii', 8, 12);
  if (['avif', 'avis'].includes(brand)) return 'avif';
  if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'heic';
  return null;
}

async function fromHeic(buf: Buffer) {
  const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.9 });
  return Buffer.from(out);
}

async function fromAvif(buf: Buffer) {
  await ensureAvif();
  const image = await decodeAvif(buf as unknown as ArrayBuffer);
  const out = jpeg.encode(image, 90);
  return Buffer.from(out.data);
}

/**
 * Normalizes one uploaded image to a wire-safe mime, converting HEIC/AVIF to
 * JPEG in place. Returns null for anything else unrecognized rather than
 * forwarding a format the provider can't decode.
 */
export async function normalizeImage(buf: Buffer, reportedMime: unknown): Promise<{ mime: string; data: Buffer } | null> {
  const declared = String(reportedMime || '').toLowerCase();
  if (WIRE_MIMES.has(declared)) return { mime: declared, data: buf };

  const kind = sniff(buf) || (declared === 'image/heic' || declared === 'image/heif' ? 'heic'
    : declared === 'image/avif' ? 'avif' : null);

  if (kind === 'heic') return { mime: 'image/jpeg', data: await fromHeic(buf) };
  if (kind === 'avif') return { mime: 'image/jpeg', data: await fromAvif(buf) };
  return null;
}

/** Decodes and normalizes one uploaded image (base64 from a request body); null on anything unusable. */
export async function normalizeUpload(mimeRaw: unknown, dataBase64: unknown): Promise<{ mime: string; data: string } | null> {
  const mime = String(mimeRaw || '');
  if (!mime.startsWith('image/') && mime !== '') return null;
  let buf;
  try { buf = Buffer.from(String(dataBase64 || ''), 'base64'); } catch { return null; }
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
  try {
    const normalized = await normalizeImage(buf, mime);
    return normalized && { mime: normalized.mime, data: normalized.data.toString('base64') };
  } catch {
    return null;
  }
}
