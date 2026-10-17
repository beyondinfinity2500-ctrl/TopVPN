/**
 * One-off generator for the real image fixtures used by worker/test/fixtures.ts.
 * Run manually with: node worker/test/generate-fixtures.mjs
 * Not part of the test suite; output is committed as base64 constants.
 *
 * The animated fixtures are built byte-exact rather than via sharp: this sharp
 * build (0.34.5) cannot emit animation, and the animation detector runs at the
 * chunk level before any decoding, so structurally valid containers are exactly
 * what the check sees.
 */
import sharp from 'sharp';
import { crc32 } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const out = {};

function svg(w, h, label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1d4ed8"/><stop offset="1" stop-color="#0ea5e9"/>
    </linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <text x="${w / 2}" y="${h / 2}" font-family="sans-serif" font-size="${Math.round(h / 5)}" fill="white" text-anchor="middle">${label}</text>
  </svg>`;
}

const add = async (key, buffer) => {
  out[key] = buffer.toString('base64');
  console.log(`${key}: ${buffer.length} bytes`);
};

/* ---- static raster images in the three allowed formats ---- */
await add('PNG_WIDE', await sharp(Buffer.from(svg(2000, 600, 'Wide PNG'))).png().toBuffer()); // wider than 1600 -> downscale
await add('PNG_SMALL', await sharp(Buffer.from(svg(300, 200, 'Small PNG'))).png().toBuffer()); // smaller than 1600 -> no upscale
await add('PNG_TALL', await sharp(Buffer.from(svg(600, 1800, 'Tall PNG'))).png().toBuffer()); // tall: height is the constraint
await add('JPEG_WIDE', await sharp(Buffer.from(svg(2000, 600, 'Wide JPEG'))).jpeg().toBuffer());
await add('WEBP_WIDE', await sharp(Buffer.from(svg(2000, 600, 'Wide WebP'))).webp().toBuffer());

/* ---- animated WebP: RIFF/WEBP + VP8X(animation flag) + ANIM + ANMF ---- */
function animatedWebp() {
  const chunk = (fourcc, payload) => {
    const head = Buffer.from(fourcc, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(payload.length);
    return Buffer.concat([head, len, payload]);
  };
  // VP8X: 1 byte flags (bit 1 = animation), 3 reserved, 4-byte canvas size.
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02; // animation flag
  // Canvas width/height are 24-bit, stored as value-1, at offsets 4 and 7.
  const w24 = 400 - 1;
  const h24 = 200 - 1;
  vp8x[4] = w24 & 0xff;
  vp8x[5] = (w24 >> 8) & 0xff;
  vp8x[6] = (w24 >> 16) & 0xff;
  vp8x[7] = h24 & 0xff;
  vp8x[8] = (h24 >> 8) & 0xff;
  vp8x[9] = (h24 >> 16) & 0xff;
  // ANIM: 4-byte background color + 2-byte loop count.
  const anim = Buffer.alloc(6);
  anim.writeUInt16LE(1, 4); // loop once
  // ANMF: frame header (x, y, w, h as 24-bit, duration 16-bit, flags) + payload.
  const anmf = Buffer.alloc(16 + 1);
  return Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.alloc(4),
    Buffer.from('WEBP', 'ascii'),
    chunk('VP8X', vp8x),
    chunk('ANIM', anim),
    chunk('ANMF', anmf),
  ]);
}

/* ---- APNG: PNG signature + IHDR + acTL (+fcTL+fdAT) ---- */
function animatedPng() {
  const pngChunk = (type, payload) => {
    const head = Buffer.from(type, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(payload.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head, payload])) >>> 0);
    return Buffer.concat([head, len, payload, crc]);
  };
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(400, 0);
  ihdr.writeUInt32BE(200, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  // acTL: num_frames (4) + num_plays (4).
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  actl.writeUInt32BE(0, 4);
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('acTL', actl)]);
}

add('WEBP_ANIMATED', animatedWebp());
add('PNG_ANIMATED', animatedPng());

/* ---- unsupported / corrupt inputs ---- */
// SVG (unsupported vector format) — must be rejected.
add('SVG', Buffer.from(svg(400, 200, 'SVG')));

// Corrupt PNG: valid 8-byte magic followed by garbage.
const corrupt = Buffer.alloc(512);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(corrupt);
for (let i = 8; i < corrupt.length; i++) corrupt[i] = (i * 37) & 0xff;
add('PNG_CORRUPT', corrupt);

const json = `/* eslint-disable */
/**
 * Real image fixtures for the advertising tests, generated once with sharp by
 * worker/test/generate-fixtures.mjs. Base64 keeps the file portable and avoids
 * binary-path issues across machines.
 */
export const FIXTURES: Record<string, string> = ${JSON.stringify(out, null, 2)};
`;

writeFileSync('worker/test/fixtures.ts', json);
console.log('\nwrote worker/test/fixtures.ts');
