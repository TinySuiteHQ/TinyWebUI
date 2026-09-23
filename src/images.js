import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import heicConvert from 'heic-convert';
import decodeAvif, { init as initAvif } from '@jsquash/avif/decode.js';
import jpeg from 'jpeg-js';

// @jsquash/avif is built for the browser and fetches its own .wasm by URL on
// init; Node's fetch can't load a file: URL, so the module is compiled and
// handed to it directly instead. Compiled once, lazily, and reused.
let avifReady;
function ensureAvif() {
  if (!avifReady) {
    const wasmPath = fileURLToPath(import.meta.resolve('@jsquash/avif/codec/dec/avif_dec.wasm'));
    avifReady = WebAssembly.compile(readFileSync(wasmPath)).then((mod) => initAvif(mod));
  }
  return avifReady;
}

/** Formats every OpenAI-compatible vision endpoint accepts on the wire. */
const WIRE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Browser-reported mime for HEIC/AVIF is unreliable -- Chrome often reports
 * an empty string for HEIC, and some pickers report generic octet-stream for
 * both. Sniffing the ISO-BMFF ftyp brand is what actually tells them apart.
 */
function sniff(buf) {
  if (buf.length < 12 || buf.toString('ascii', 4, 8) !== 'ftyp') return null;
  const brand = buf.toString('ascii', 8, 12);
  if (['avif', 'avis'].includes(brand)) return 'avif';
  if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1'].includes(brand)) return 'heic';
  return null;
}

async function fromHeic(buf) {
  const out = await heicConvert({ buffer: buf, format: 'JPEG', quality: 0.9 });
  return Buffer.from(out);
}

async function fromAvif(buf) {
  await ensureAvif();
  const image = await decodeAvif(buf);
  const out = jpeg.encode(image, 90);
  return Buffer.from(out.data);
}

/**
 * Normalizes one uploaded image to a wire-safe mime, converting HEIC/AVIF to
 * JPEG in place. Returns null for anything else unrecognized rather than
 * forwarding a format the provider can't decode.
 */
export async function normalizeImage(buf, reportedMime) {
  const declared = String(reportedMime || '').toLowerCase();
  if (WIRE_MIMES.has(declared)) return { mime: declared, data: buf };

  const kind = sniff(buf) || (declared === 'image/heic' || declared === 'image/heif' ? 'heic'
    : declared === 'image/avif' ? 'avif' : null);

  if (kind === 'heic') return { mime: 'image/jpeg', data: await fromHeic(buf) };
  if (kind === 'avif') return { mime: 'image/jpeg', data: await fromAvif(buf) };
  return null;
}
