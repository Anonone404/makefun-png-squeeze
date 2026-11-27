// png-squeeze-01-run-20261127 entry: squeeze 1280x720 RGBA screenshots into
// the smallest lossless PNG. Pure Node 22 stdlib, no installs, no network,
// no environment secrets: everything the program runs is in this file.
// Pipeline per image: decode the stored PNG -> analyse colours -> try
// palette / grey / RGB / RGBA forms with several per-row filter strategies,
// screen each with zlib level 6 -> re-encode the winner with an
// optimal-parsing deflate (hash-chain LZ77 + shortest-path parse +
// iterated Huffman costs + fixed-size dynamic blocks). Deterministic:
// fixed work counts, no clock, no randomness.
import { inflateSync, deflateSync, constants as zlibConstants } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEBUG = process.env.PNG_DEBUG === '1';
const debug = (...a) => { if (DEBUG) console.error(...a); };

// ---------------------------------------------------------------- CRC/Adler

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------- PNG chunks

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function chunkBytes(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out[4] = type.charCodeAt(0); out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2); out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ---------------------------------------------------------------- filters

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Row `cur` (stride samples, bpp bytes a pixel, `prev` the row above or
// null) filtered by `type` into out[0, stride).
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) { out.set(cur); return; }
  if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// Sum of a filtered row's bytes read as signed values, absolute.
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// Distinct neighbouring byte pairs in a filtered row.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) { seen[pair] = stamp; n++; }
  }
  return n;
}

// Entropy estimate of a filtered row, in bits: sum over byte values of
// -count * log2(count / n), via a table of c * log2(stride / c).
function entropyOf(row, logTable) {
  const hist = new Uint16Array(256);
  for (let i = 0; i < row.length; i++) hist[row[i]]++;
  let e = 0;
  for (let b = 0; b < 256; b++) if (hist[b] > 0) e += logTable[hist[b]];
  return e;
}

function logTableFor(stride) {
  const t = new Float64Array(stride + 1);
  for (let c = 1; c <= stride; c++) t[c] = -c * Math.log2(c / stride);
  return t;
}

// ---------------------------------------------------------------- decode

// The image a PNG holds, as RGBA, or why it is not a PNG this program
// reads: 8-bit, non-interlaced, colour type 0, 2, 3, 4 or 6, chunks
// IHDR, PLTE, tRNS, IDAT, IEND only, each CRC correct.
function decodePng(bytes) {
  const fail = (why) => ({ ok: false, why });
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b))
    return fail('it does not start with the PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null, palette = null, trns = null;
  const idat = [];
  let idatDone = false, ended = false;
  while (at < bytes.length) {
    if (ended) return fail('it holds bytes after IEND');
    if (at + 12 > bytes.length) return fail('a chunk is cut short');
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail('a chunk claims bytes the file does not hold');
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail('a chunk has no chunk type');
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail(`the ${type} chunk fails its CRC`);
    if (!['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) return fail(`it holds a ${type} chunk`);
    if (header === null && type !== 'IHDR') return fail('its first chunk is not IHDR');
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      if (header !== null) return fail('it holds IHDR twice');
      if (len !== 13) return fail('its IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0) return fail('its width or height is 0');
      if (header.depth !== 8) return fail('its bit depth is not 8');
      if (!Object.hasOwn(CHANNELS, header.colourType)) return fail('its colour type is not 0, 2, 3, 4 or 6');
      if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) return fail('its compression, filter or interlace is not 0');
    } else if (type === 'PLTE') {
      if (palette !== null) return fail('it holds PLTE twice');
      if (header.colourType !== 3) return fail('it holds PLTE with a colour type other than 3');
      if (idat.length > 0) return fail('its PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('its PLTE is not 1 to 256 entries');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail('it holds tRNS twice');
      if (idat.length > 0) return fail('its tRNS follows IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) return fail('its tRNS comes before PLTE');
        if (len > palette.length / 3) return fail('its tRNS holds more entries than its palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail('its tRNS has the wrong length');
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail('its tRNS names a sample over 255');
      } else return fail('it holds tRNS with colour type 4 or 6');
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) return fail('its IDAT chunks are not in a row');
      if (header.colourType === 3 && palette === null) return fail('its IDAT comes before PLTE');
      idat.push(data);
    } else {
      if (len !== 0) return fail('its IEND is not empty');
      ended = true;
    }
  }
  if (!ended) return fail('it has no IEND');
  if (idat.length === 0) return fail('it has no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail(`its IDAT data is not one whole zlib stream (${String(err && err.message).split('\n')[0]})`);
  }
  if (raw.length !== expected) return fail(`its IDAT data inflates to ${raw.length} bytes, not ${expected}`);
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride, p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s]; rgba[d + 1] = samples[s + 1]; rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3]; lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail(`pixel ${i} names palette entry ${e} of ${entries}`);
      rgba[d] = lut[e * 4]; rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2]; rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}

// ---------------------------------------------------------------- analysis

// What the image holds: whether every pixel is opaque, whether every
// pixel is grey, and its colours (at most 256) with their counts.
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  let opaque = true, grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

// The one fully transparent value (grey or RGB) the image may key by
// tRNS instead of an alpha channel: every pixel opaque or that exact
// value at alpha 0, and no opaque pixel of the same value. Null when
// there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA.
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) { out[s] = rgba[d]; out[s + 1] = rgba[d + 3]; }
    else { out[s] = rgba[d]; out[s + 1] = rgba[d + 1]; out[s + 2] = rgba[d + 2]; }
  }
  return out;
}

// A palette's entries in the order a trial writes them: the transparent
// ones first (by alpha), then by `order` (count or luminance).
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

// The palette form: {plte, trns, indices}.
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0]; plte[i * 3 + 1] = c.rgba[1]; plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

// The forms an image can be written in: each {colourType, bpp, samples,
// plte, trns, filters}. Palette forms first (a palette holds a flat image
// in a third of the bytes of RGB or less); the channel form last.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', [0, 'minsum', 'entropy', 'brute']],
      ['luminance', [0, 'minsum', 'entropy', 'brute']],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct, trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: [0, 1, 2, 3, 4, 'minsum', 'pairs', 'entropy', 'brute'] });
  return forms;
}

// ---------------------------------------------------------------- filtering

const BRUTE_CONTEXT = 32768;
const BRUTE_LEVEL = 4;
const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: zlibConstants.Z_DEFAULT_STRATEGY });

// The raw data of an image of `samples` (height rows of width x bpp
// samples), each row behind its filter byte, by `choice`: a filter type
// (0 to 4) for every row, or 'minsum', 'pairs', 'entropy' (each row the
// type with the least cost by that heuristic, the lower type on a tie) or
// 'brute' (each row's five filters weighed by a zlib run after the 32 KiB
// written before it, the smallest kept).
function filtered(samples, width, height, bpp, choice) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  const logTable = choice === 'entropy' ? logTableFor(stride) : null;
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0, best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t]);
      else if (choice === 'pairs') cost = pairsOf(trial[t], seen, ++stamp);
      else if (choice === 'entropy') cost = entropyOf(trial[t], logTable);
      else cost = deflateSync(trial[t], before.length === 0
        ? { level: BRUTE_LEVEL, memLevel: 9 }
        : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) { best = cost; type = t; }
    }
    raw[at] = type;
    raw.set(trial[type], at + 1);
  }
  return raw;
}

// The bytes a form's PLTE and tRNS chunks take in its file.
const formChunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// Screen every form and filter choice with zlib level 6 and return the
// winner: {form, choice, data, bytes}. The first on a tie.
function screen(rgba, width, height) {
  let best = null;
  for (const form of formsOf(rgba)) {
    const chunks = formChunkBytes(form);
    for (const choice of form.filters) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const bytes = deflateSync(data, SCREEN).length + chunks;
      if (best === null || bytes < best.bytes) best = { form, choice, data, bytes };
    }
  }
  return best;
}

// ---------------------------------------------------------------- deflate
// Optimal-parsing DEFLATE (in the manner of zopfli): hash-chain LZ77
// match finding, shortest-path parse with iterated Huffman costs, fixed
// blocks of dynamic Huffman. Written here, in this file, from the
// DEFLATE format (RFC 1951).

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

// [code, extraBits, extraValue] for a match length (3..258) / distance.
function lengthCode(len) {
  let i = 0;
  while (i < 28 && LEN_BASE[i + 1] <= len) i++;
  return [257 + i, LEN_EXTRA[i], len - LEN_BASE[i]];
}
function distCode(d) {
  let i = 0;
  while (i < 29 && DIST_BASE[i + 1] <= d) i++;
  return [i, DIST_EXTRA[i], d - DIST_BASE[i]];
}

// Bit costs under the fixed Huffman code (the first parse's model).
function fixedCosts() {
  const litCost = new Float64Array(288);
  for (let s = 0; s < 288; s++) litCost[s] = s < 144 ? 8 : s < 256 ? 9 : s < 280 ? 7 : 8;
  const lenCost = new Float64Array(259);
  for (let L = 3; L <= 258; L++) { const [c, eb] = lengthCode(L); lenCost[L] = litCost[c] + eb; }
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) { const [c, eb] = distCode(d); distCost[d] = 5 + eb; }
  return { litCost, lenCost, distCost };
}

// Longest LZ77 match at every position (and the best match with distance
// at most 1024, which can be cheaper despite being shorter). Hash chains
// of 3-byte sequences, capped, with a good-match early exit.
function findMatches(data) {
  const n = data.length;
  const mLen = new Uint16Array(n), mDist = new Uint32Array(n);
  const mLen2 = new Uint16Array(n), mDist2 = new Uint32Array(n);
  const mLenA = new Uint16Array(n), mDistA = new Uint32Array(n);
  const HSIZE = 1 << 17;
  const head = new Int32Array(HSIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i + 3 <= n; i++) {
    // Multiplicative hash of the 3-byte sequence. Take the HIGH bits of
    // the product: the low bits only see the low bits of the input, so
    // masking them would ignore most of the first byte.
    const h = ((((data[i] << 16) ^ (data[i + 1] << 8) ^ data[i + 2]) * 2654435761) >>> 0) >>> 15;
    let cand = head[h];
    let bestLen = 0, bestDist = 0, bestLen2 = 0, bestDist2 = 0, bestLenA = 0, bestDistA = 0;
    const maxLen = Math.min(258, n - i);
    let chain = 0, chainLimit = 128;
    while (cand >= 0 && chain < chainLimit) {
      chain++;
      if (bestLen > 0 && data[cand + bestLen] !== data[i + bestLen]) { cand = prev[cand]; continue; }
      let l = 0;
      while (l < maxLen && data[cand + l] === data[i + l]) l++;
      const d = i - cand;
      if (l > bestLen) {
        bestLen = l; bestDist = d;
        if (l >= 32) chainLimit = 16;
      }
      if (d <= 1024 && l > bestLen2) { bestLen2 = l; bestDist2 = d; }
      if (d <= 64 && l > bestLenA) { bestLenA = l; bestDistA = d; }
      // Longest possible match reached: no later candidate can beat it,
      // and every closer candidate was already visited (the chain runs
      // in increasing distance order), so the bands are settled too.
      if (l >= maxLen) break;
      cand = prev[cand];
    }
    if (bestLen >= 3) { mLen[i] = bestLen; mDist[i] = bestDist; }
    if (bestLen2 >= 3) { mLen2[i] = bestLen2; mDist2[i] = bestDist2; }
    if (bestLenA >= 3) { mLenA[i] = bestLenA; mDistA[i] = bestDistA; }
    prev[i] = head[h];
    head[h] = i;
  }
  return { mLen, mDist, mLen2, mDist2, mLenA, mDistA };
}

// Huffman code lengths from frequencies, capped at maxLen. Heap-built,
// then a length-limit fix (the zlib overflow procedure), then verified:
// a bad result falls back to null so the caller can use fixed Huffman.
function huffmanLengths(freq, maxLen) {
  const n = freq.length;
  const lengths = new Array(n).fill(0);
  const syms = [];
  for (let s = 0; s < n; s++) if (freq[s] > 0) syms.push(s);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) { lengths[syms[0]] = 1; return lengths; }
  // Heap of tree nodes, smallest frequency first.
  const heap = syms.map((s) => ({ f: freq[s], sym: s, left: null, right: null }));
  heap.sort((a, b) => a.f - b.f || a.sym - b.sym);
  const push = (node) => {
    let i = heap.length;
    heap.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].f <= heap[i].f) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l].f < heap[m].f) m = l;
        if (r < heap.length && heap[r].f < heap[m].f) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length > 1) {
    const a = pop(), b = pop();
    push({ f: a.f + b.f, sym: -1, left: a, right: b });
  }
  const walk = (node, depth) => {
    if (node.sym >= 0) { lengths[node.sym] = depth; return; }
    walk(node.left, depth + 1);
    walk(node.right, depth + 1);
  };
  walk(heap[0], 0);
  let maxDepth = 0;
  for (const s of syms) maxDepth = Math.max(maxDepth, lengths[s]);
  if (maxDepth <= maxLen) return lengths;
  // Length-limit fix: count codes per length, then move codes down from
  // the longest length until none exceeds maxLen (zlib's procedure).
  const blCount = new Array(maxLen + 1).fill(0);
  let overflow = 0;
  for (const s of syms) {
    if (lengths[s] > maxLen) overflow++;
    else blCount[lengths[s]]++;
  }
  // Codes longer than maxLen are counted at maxLen for the fix.
  blCount[maxLen] += overflow;
  let bits = maxLen - 1;
  while (overflow > 0) {
    while (bits >= 1 && blCount[bits] === 0) bits--;
    if (bits < 1) return null;
    blCount[bits]--;
    blCount[bits + 1] += 2;
    blCount[maxLen]--;
    overflow -= 2;
  }
  // Reassign lengths by frequency: the shortest lengths to the most
  // frequent symbols.
  const byFreq = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
  let k = 0;
  for (let l = 1; l <= maxLen; l++) {
    for (let j = 0; j < blCount[l]; j++) lengths[byFreq[k++]] = l;
  }
  // Verify: a complete prefix code (Kraft sum exactly 1) and no length
  // over the cap. Anything else is rejected by the caller.
  let kraft = 0;
  for (const s of syms) kraft += 1 << (maxLen - lengths[s]);
  if (k !== syms.length || kraft !== (1 << maxLen)) return null;
  return lengths;
}

// Canonical Huffman codes from lengths: {codes, lengths} where codes[s]
// is the code value (MSB-first bits) for symbol s.
function canonicalCodes(lengths) {
  const maxLen = Math.max(0, ...lengths);
  const blCount = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) blCount[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let l = 1; l <= maxLen; l++) {
    code = (code + blCount[l - 1]) << 1;
    nextCode[l] = code;
  }
  const codes = new Array(lengths.length).fill(0);
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s] > 0) codes[s] = nextCode[lengths[s]]++;
  }
  return { codes, lengths };
}

// A complete prefix code for `symbols` (most frequent first), lengths
// as equal as possible (the fallback when an optimal tree cannot be
// capped). Returns lengths indexed by symbol value.
function balancedLengths(symbols, maxLen) {
  const k = symbols.length;
  const size = k === 0 ? 0 : Math.max(0, ...symbols) + 1;
  const lengths = new Array(size).fill(0);
  if (k === 0) return lengths;
  if (k === 1) { lengths[symbols[0]] = 1; return lengths; }
  // Complete tree: floor(log2 k) is the shallow depth, ceil(log2 k) the
  // deep one; a = 2^(m+1) - k leaves sit at the shallow depth.
  const m = Math.floor(Math.log2(k));
  if (m > maxLen) return null;
  const short = (1 << (m + 1)) - k; // symbols at length m
  symbols.forEach((sym, i) => { lengths[sym] = i < short ? m : m + 1; });
  return lengths;
}

// Bit costs from Huffman lengths (unused symbols cost the maximum, so
// the parse may still use them but never prefers them for free).
function costsOf(litLen, distLen) {
  const litCost = new Float64Array(288);
  for (let s = 0; s < 288; s++) litCost[s] = litLen[s] > 0 ? litLen[s] : 15;
  const lenCost = new Float64Array(259);
  for (let L = 3; L <= 258; L++) { const [c, eb] = lengthCode(L); lenCost[L] = litCost[c] + eb; }
  const distCost = new Float64Array(32769);
  for (let d = 1; d <= 32768; d++) { const [c, eb] = distCode(d); distCost[d] = (distLen[c] > 0 ? distLen[c] : 15) + eb; }
  return { litCost, lenCost, distCost };
}

// Shortest-path parse of `data` under the given bit costs: at each
// position the choice is a literal or the longest match found there (or
// the best short-distance match). Returns the symbol list: a literal is
// its byte value, a match is {len, dist}.
function optimalParse(data, m, litCost, lenCost, distCost) {
  const n = data.length;
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choice = new Int32Array(n + 1);
  const choiceDist = new Uint32Array(n + 1);
  cost[0] = 0;
  for (let i = 0; i < n; i++) {
    const c = cost[i];
    if (c === Infinity) continue;
    const lc = c + litCost[data[i]];
    if (lc < cost[i + 1]) { cost[i + 1] = lc; choice[i + 1] = 0; }
    const L = m.mLen[i];
    if (L >= 3) {
      const mc = c + lenCost[L] + distCost[m.mDist[i]];
      if (mc < cost[i + L]) { cost[i + L] = mc; choice[i + L] = L; choiceDist[i + L] = m.mDist[i]; }
    }
    const L2 = m.mLen2[i];
    if (L2 >= 3 && L2 !== L) {
      const mc = c + lenCost[L2] + distCost[m.mDist2[i]];
      if (mc < cost[i + L2]) { cost[i + L2] = mc; choice[i + L2] = L2; choiceDist[i + L2] = m.mDist2[i]; }
    }
    const LA = m.mLenA[i];
    if (LA >= 3 && LA !== L && LA !== L2) {
      const mc = c + lenCost[LA] + distCost[m.mDistA[i]];
      if (mc < cost[i + LA]) { cost[i + LA] = mc; choice[i + LA] = LA; choiceDist[i + LA] = m.mDistA[i]; }
    }
  }
  const syms = [];
  let i = n;
  while (i > 0) {
    const ch = choice[i];
    if (ch === 0) { syms.push(data[i - 1]); i--; }
    else { syms.push({ len: ch, dist: choiceDist[i] }); i -= ch; }
  }
  syms.reverse();
  return syms;
}

// LSB-first bit writer over a preallocated buffer.
class BitWriter {
  constructor(capacity) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  write(bits, len) {
    this.bitBuf |= (bits << this.bitCnt) >>> 0;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.buf[this.pos++] = this.bitBuf & 0xff;
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  // A Huffman code: its bits go out most-significant first, so reverse
  // the code and emit it least-significant first.
  writeCode(code, len) {
    let rev = 0;
    for (let i = 0; i < len; i++) rev = (rev << 1) | ((code >>> i) & 1);
    this.write(rev, len);
  }
  align() {
    if (this.bitCnt > 0) { this.buf[this.pos++] = this.bitBuf & 0xff; this.bitBuf = 0; this.bitCnt = 0; }
  }
  bytes() { return this.buf.subarray(0, this.pos); }
}

// Fixed Huffman codes (RFC 1951 section 3.2.6).
function fixedCodes() {
  const litCodes = new Array(288), litLens = new Array(288);
  for (let s = 0; s < 288; s++) {
    if (s < 144) { litCodes[s] = 0x30 + s; litLens[s] = 8; }
    else if (s < 256) { litCodes[s] = 0x190 + (s - 144); litLens[s] = 9; }
    else if (s < 280) { litCodes[s] = s - 256; litLens[s] = 7; }
    else { litCodes[s] = 0xc0 + (s - 280); litLens[s] = 8; }
  }
  const distCodes = new Array(32), distLens = new Array(32).fill(5);
  for (let s = 0; s < 32; s++) distCodes[s] = s;
  return { litCodes, litLens, distCodes, distLens };
}

// Run-length encode a code-length sequence into [symbol, extraBits,
// extraValue] tokens (16 repeat previous, 17 repeat 0, 18 repeat 0 long).
function rleLengths(lengths) {
  const tokens = [];
  let i = 0;
  while (i < lengths.length) {
    const v = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === v) run++;
    const total = run;
    if (v === 0) {
      while (run >= 11) {
        const take = Math.min(run, 138);
        tokens.push([18, 7, take - 11]);
        run -= take;
      }
      if (run >= 3) { tokens.push([17, 3, run - 3]); run = 0; }
      while (run-- > 0) tokens.push([0, 0, 0]);
    } else {
      tokens.push([v, 0, 0]);
      run--;
      while (run >= 3) {
        const take = Math.min(run, 6);
        tokens.push([16, 2, take - 3]);
        run -= take;
      }
      while (run-- > 0) tokens.push([v, 0, 0]);
    }
    i += total;
  }
  return tokens;
}

// ---------------------------------------------------------------- encode

const BLOCK_SYMBOLS = 32768;
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// One dynamic-Huffman block of `syms` (literals as byte values, matches
// as {len, dist}), or a fixed-Huffman block when the dynamic tree cannot
// be built. `isFinal` sets BFINAL.
function encodeBlock(syms, bw, isFinal) {
  const litFreq = new Array(288).fill(0);
  const distFreq = new Array(32).fill(0);
  for (const s of syms) {
    if (typeof s === 'number') litFreq[s]++;
    else {
      const [lc] = lengthCode(s.len);
      litFreq[lc]++;
      const [dc] = distCode(s.dist);
      distFreq[dc]++;
    }
  }
  litFreq[256]++;
  const litLen = huffmanLengths(litFreq, 15);
  let distLen = huffmanLengths(distFreq, 15);
  // A block with no matches still needs one distance code: a single
  // code of length 1 (the decoder rejects a distance table with no codes).
  if (distLen.every((l) => l === 0)) distLen = [1, ...new Array(31).fill(0)];
  if (litLen === null || distLen === null) {
    const f = fixedCodes();
    bw.write(isFinal ? 1 : 0, 1);
    bw.write(1, 2); // BTYPE 01, fixed Huffman
    for (const s of syms) writeSymbol(s, bw, f.litCodes, f.litLens, f.distCodes, f.distLens);
    bw.writeCode(f.litCodes[256], f.litLens[256]);
    return;
  }
  // Trim trailing zero lengths (at least 257 lit/len codes, 1 dist code).
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 32;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const lengths = [...litLen.slice(0, hlit), ...distLen.slice(0, hdist)];
  const tokens = rleLengths(lengths);
  const clFreq = new Array(19).fill(0);
  for (const [sym] of tokens) clFreq[sym]++;
  let clLen = huffmanLengths(clFreq, 7);
  if (clLen === null) {
    const used = [];
    for (let s = 0; s < 19; s++) if (clFreq[s] > 0) used.push(s);
    used.sort((a, b) => clFreq[b] - clFreq[a] || a - b);
    clLen = balancedLengths(used, 7);
  }
  if (clLen === null) {
    // Last resort: fixed-Huffman block (a valid code always exists).
    const f = fixedCodes();
    bw.write(isFinal ? 1 : 0, 1);
    bw.write(1, 2);
    for (const s of syms) writeSymbol(s, bw, f.litCodes, f.litLens, f.distCodes, f.distLens);
    bw.writeCode(f.litCodes[256], f.litLens[256]);
    return;
  }
  const cl = canonicalCodes(clLen);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  bw.write(isFinal ? 1 : 0, 1);
  bw.write(2, 2); // BTYPE 10, dynamic Huffman
  bw.write(hlit - 257, 5);
  bw.write(hdist - 1, 5);
  bw.write(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) bw.write(clLen[CL_ORDER[i]], 3);
  for (const [sym, eb, ev] of tokens) {
    bw.writeCode(cl.codes[sym], cl.lengths[sym]);
    if (eb > 0) bw.write(ev, eb);
  }
  const lit = canonicalCodes(litLen);
  const dist = canonicalCodes(distLen);
  for (const s of syms) writeSymbol(s, bw, lit.codes, lit.lengths, dist.codes, dist.lengths);
  bw.writeCode(lit.codes[256], lit.lengths[256]);
}

function writeSymbol(s, bw, litCodes, litLens, distCodes, distLens) {
  if (typeof s === 'number') {
    bw.writeCode(litCodes[s], litLens[s]);
    return;
  }
  const [lc, leb, lev] = lengthCode(s.len);
  bw.writeCode(litCodes[lc], litLens[lc]);
  if (leb > 0) bw.write(lev, leb);
  const [dc, deb, dev] = distCode(s.dist);
  bw.writeCode(distCodes[dc], distLens[dc]);
  if (deb > 0) bw.write(dev, deb);
}

// The optimal-parse deflate of `data`: match finding once, then three
// shortest-path parses with iterated Huffman costs, then fixed blocks.
function deflateOptimal(data) {
  const m = findMatches(data);
  let costs = fixedCosts();
  let syms = null;
  for (let iter = 0; iter < 8; iter++) {
    syms = optimalParse(data, m, costs.litCost, costs.lenCost, costs.distCost);
    const litFreq = new Array(288).fill(0);
    const distFreq = new Array(32).fill(0);
    for (const s of syms) {
      if (typeof s === 'number') litFreq[s]++;
      else {
        const [lc] = lengthCode(s.len);
        litFreq[lc]++;
        const [dc] = distCode(s.dist);
        distFreq[dc]++;
      }
    }
    litFreq[256]++;
    const litLen = huffmanLengths(litFreq, 15);
    const distLen = huffmanLengths(distFreq, 15);
    if (litLen === null || distLen === null) break;
    costs = costsOf(litLen, distLen);
  }
  const bw = new BitWriter(data.length + (data.length >> 3) + 65536);
  let i = 0;
  while (i < syms.length) {
    const block = syms.slice(i, i + BLOCK_SYMBOLS);
    i += block.length;
    encodeBlock(block, bw, i >= syms.length);
  }
  bw.align();
  return bw.bytes();
}

// A zlib stream (header 0x78 0xDA, deflate data, Adler-32) of `raw`.
function zlibWrap(deflateBytes, raw) {
  const out = new Uint8Array(2 + deflateBytes.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(deflateBytes, 2);
  new DataView(out.buffer).setUint32(2 + deflateBytes.length, adler32(raw));
  return out;
}

// ---------------------------------------------------------------- entry

// Encode one RGBA image as the smallest PNG this program can write:
// screen the forms with zlib level 6, re-encode the winner with the
// optimal-parse deflate (falling back to the zlib stream when it is
// smaller), and assemble the PNG.
function encodeImage(rgba, width, height, id) {
  const t0 = DEBUG ? Date.now() : 0;
  const best = screen(rgba, width, height);
  const t1 = DEBUG ? Date.now() : 0;
  const optimal = deflateOptimal(best.data);
  const t2 = DEBUG ? Date.now() : 0;
  const z6 = deflateSync(best.data, SCREEN);
  // zlib level 9 is a strong greedy compressor; the optimal parse should
  // beat it, but keep the better of the two so a weak parse never loses
  // to a plain library call.
  const z9 = deflateSync(best.data, { level: 9, memLevel: 8 });
  let idat = optimal.length <= z6.length ? zlibWrap(optimal, best.data) : z6;
  if (z9.length < idat.length) idat = z9;
  const chunks = [chunkBytes('IHDR', ihdrOf(width, height, best.form.colourType))];
  if (best.form.plte !== null) chunks.push(chunkBytes('PLTE', best.form.plte));
  if (best.form.trns !== null) chunks.push(chunkBytes('tRNS', best.form.trns));
  chunks.push(chunkBytes('IDAT', idat));
  chunks.push(chunkBytes('IEND', new Uint8Array(0)));
  const png = pngOf(chunks);
  if (DEBUG) {
    console.error(`${id}: form ct${best.form.colourType} filter ${best.choice} screen ${best.bytes} optimal ${optimal.length} zlib6 ${z6.length} -> ${png.length} bytes (screen ${t1 - t0}ms, parse ${t2 - t1}ms)`);
  }
  return png;
}

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  const png = encodeImage(image.rgba, image.width, image.height, id);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
