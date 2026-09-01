#!/usr/bin/env node
/*
 * Linux Leptocline — brand asset renderer.
 *
 * Zero dependencies. Rasterises the same geometry the SVG uses, so the shipped
 * PNGs and branding/logo.svg can never drift apart, and the build host does not
 * need librsvg / inkscape / imagemagick installed.
 */
'use strict';

const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');

/* ------------------------------------------------------------------ PNG out */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// rgba: Uint8Array, straight (non-premultiplied) alpha
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride)
      .copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ------------------------------------------------------------------- canvas */

// Supersampled premultiplied-alpha canvas. All public coordinates are logical.
class Canvas {
  constructor(w, h, ss) {
    this.w = w; this.h = h; this.ss = ss;
    this.sw = w * ss; this.sh = h * ss;
    this.buf = new Uint8ClampedArray(this.sw * this.sh * 4); // premultiplied
  }

  blend(i, r, g, b, a) {
    if (a <= 0) return;
    const inv = 1 - a;
    const buf = this.buf;
    buf[i]     = r * 255 * a + buf[i] * inv;
    buf[i + 1] = g * 255 * a + buf[i + 1] * inv;
    buf[i + 2] = b * 255 * a + buf[i + 2] * inv;
    buf[i + 3] = 255 * a + buf[i + 3] * inv;
  }

  // shade(x, y) -> [r, g, b, a] in 0..1, over the whole surface
  shade(fn) {
    for (let y = 0; y < this.sh; y++) {
      const ly = (y + 0.5) / this.ss;
      for (let x = 0; x < this.sw; x++) {
        const c = fn((x + 0.5) / this.ss, ly);
        if (c) this.blend((y * this.sw + x) * 4, c[0], c[1], c[2], c[3]);
      }
    }
  }

  // polys: array of [[x,y],...].
  // rule 'nonzero' unions overlapping subpaths (holes must wind backwards);
  // rule 'evenodd' punches every overlap out. Unions default to nonzero so
  // abutting shapes do not leave a half-covered seam between them.
  fillPath(polys, color, alpha = 1, rule = 'nonzero') {
    const ss = this.ss;
    const [r, g, b] = color;
    const edges = [];
    let minY = Infinity, maxY = -Infinity;
    for (const poly of polys) {
      for (let i = 0; i < poly.length; i++) {
        const [x0, y0] = poly[i];
        const [x1, y1] = poly[(i + 1) % poly.length];
        if (y0 === y1) continue;
        edges.push([x0 * ss, y0 * ss, x1 * ss, y1 * ss, y1 > y0 ? 1 : -1]);
        minY = Math.min(minY, y0 * ss, y1 * ss);
        maxY = Math.max(maxY, y0 * ss, y1 * ss);
      }
    }
    const yStart = Math.max(0, Math.floor(minY));
    const yEnd = Math.min(this.sh - 1, Math.ceil(maxY));
    const xs = [];
    for (let y = yStart; y <= yEnd; y++) {
      const sy = y + 0.5;
      xs.length = 0;
      for (const [x0, y0, x1, y1, w] of edges) {
        if ((sy >= y0 && sy < y1) || (sy >= y1 && sy < y0)) {
          xs.push([x0 + ((sy - y0) / (y1 - y0)) * (x1 - x0), w]);
        }
      }
      if (xs.length < 2) continue;
      xs.sort((a, c) => a[0] - c[0]);
      let wind = 0;
      for (let k = 0; k + 1 < xs.length; k++) {
        wind += xs[k][1];
        const inside = rule === 'evenodd' ? (k % 2 === 0) : wind !== 0;
        if (!inside) continue;
        const from = Math.max(0, Math.ceil(xs[k][0] - 0.5));
        const to = Math.min(this.sw - 1, Math.floor(xs[k + 1][0] - 0.5));
        let i = (y * this.sw + from) * 4;
        for (let x = from; x <= to; x++, i += 4) this.blend(i, r, g, b, alpha);
      }
    }
  }
  rect(x, y, w, h, color, alpha = 1) {
    this.fillPath([[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]], color, alpha);
  }

  text(str, x, y, px, color, alpha = 1) {
    let cx = x;
    for (const ch of str.toUpperCase()) {
      const glyph = FONT[ch] || FONT[' '];
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] === '#') {
            this.rect(cx + col * px, y + row * px, px, px, color, alpha);
          }
        }
      }
      cx += px * 6;
    }
    return cx - px; // right edge
  }

  static textWidth(str, px) { return str.length * px * 6 - px; }

  // box-downsample and un-premultiply
  resolve() {
    const { w, h, ss, sw, buf } = this;
    const out = new Uint8ClampedArray(w * h * 4);
    const n = ss * ss;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let dy = 0; dy < ss; dy++) {
          let i = ((y * ss + dy) * sw + x * ss) * 4;
          for (let dx = 0; dx < ss; dx++, i += 4) {
            r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; a += buf[i + 3];
          }
        }
        r /= n; g /= n; b /= n; a /= n;
        const o = (y * w + x) * 4;
        if (a > 0) {
          const s = 255 / a;
          out[o] = r * s; out[o + 1] = g * s; out[o + 2] = b * s;
        }
        out[o + 3] = a;
      }
    }
    return out;
  }

  write(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, encodePNG(this.w, this.h, this.resolve()));
    const kb = (fs.statSync(file).size / 1024).toFixed(0);
    console.log(`  ${String(this.w + 'x' + this.h).padEnd(11)} ${String(kb + 'K').padStart(6)}  ${rel(file)}`);
  }
}

/* --------------------------------------------------------------- pixel font */

// 5x7 stencil face. Blocky on purpose: the wordmark should read as a console.
const FONT = (() => {
  const src = {
    A: '.###.|#...#|#...#|#####|#...#|#...#|#...#',
    B: '####.|#...#|#...#|####.|#...#|#...#|####.',
    C: '.###.|#...#|#....|#....|#....|#...#|.###.',
    D: '####.|#...#|#...#|#...#|#...#|#...#|####.',
    E: '#####|#....|#....|####.|#....|#....|#####',
    F: '#####|#....|#....|####.|#....|#....|#....',
    G: '.###.|#...#|#....|#.###|#...#|#...#|.###.',
    H: '#...#|#...#|#...#|#####|#...#|#...#|#...#',
    I: '#####|..#..|..#..|..#..|..#..|..#..|#####',
    J: '..###|...#.|...#.|...#.|...#.|#..#.|.##..',
    K: '#...#|#..#.|#.#..|##...|#.#..|#..#.|#...#',
    L: '#....|#....|#....|#....|#....|#....|#####',
    M: '#...#|##.##|#.#.#|#...#|#...#|#...#|#...#',
    N: '#...#|##..#|#.#.#|#..##|#...#|#...#|#...#',
    O: '.###.|#...#|#...#|#...#|#...#|#...#|.###.',
    P: '####.|#...#|#...#|####.|#....|#....|#....',
    Q: '.###.|#...#|#...#|#...#|#.#.#|#..#.|.##.#',
    R: '####.|#...#|#...#|####.|#.#..|#..#.|#...#',
    S: '.####|#....|#....|.###.|....#|....#|####.',
    T: '#####|..#..|..#..|..#..|..#..|..#..|..#..',
    U: '#...#|#...#|#...#|#...#|#...#|#...#|.###.',
    V: '#...#|#...#|#...#|#...#|#...#|.#.#.|..#..',
    W: '#...#|#...#|#...#|#.#.#|#.#.#|##.##|#...#',
    X: '#...#|#...#|.#.#.|..#..|.#.#.|#...#|#...#',
    Y: '#...#|#...#|.#.#.|..#..|..#..|..#..|..#..',
    Z: '#####|....#|...#.|..#..|.#...|#....|#####',
    0: '.###.|#...#|#..##|#.#.#|##..#|#...#|.###.',
    1: '..#..|.##..|..#..|..#..|..#..|..#..|.###.',
    2: '.###.|#...#|....#|...#.|..#..|.#...|#####',
    3: '#####|...#.|..#..|...#.|....#|#...#|.###.',
    4: '...#.|..##.|.#.#.|#..#.|#####|...#.|...#.',
    5: '#####|#....|####.|....#|....#|#...#|.###.',
    6: '..##.|.#...|#....|####.|#...#|#...#|.###.',
    7: '#####|....#|...#.|..#..|.#...|.#...|.#...',
    8: '.###.|#...#|#...#|.###.|#...#|#...#|.###.',
    9: '.###.|#...#|#...#|.####|....#|...#.|.##..',
    ' ': '.....|.....|.....|.....|.....|.....|.....',
    '.': '.....|.....|.....|.....|.....|.##..|.##..',
    '-': '.....|.....|.....|#####|.....|.....|.....',
    '_': '.....|.....|.....|.....|.....|.....|#####',
    ':': '.....|.##..|.##..|.....|.##..|.##..|.....',
    '/': '....#|....#|...#.|..#..|.#...|#....|#....',
  };
  const out = {};
  for (const [k, v] of Object.entries(src)) out[k] = v.split('|');
  return out;
})();

/* ------------------------------------------------------------------ palette */

const hex = (s) => [
  parseInt(s.slice(1, 3), 16) / 255,
  parseInt(s.slice(3, 5), 16) / 255,
  parseInt(s.slice(5, 7), 16) / 255,
];

// The mark sets the palette. Swap ACCENT here and every rendered asset follows.
const WHITE      = hex('#FFFFFF');
const BLACK      = hex('#080808');
const ACCENT     = hex('#19C6D6'); // cyan — beak, shoes, accents
const ACCENT_DIM = hex('#0E8C99');
const GOLD       = hex('#F7CB45'); // crown
const GOLD_DEEP  = hex('#C9971E');
// Deep, low-saturation teal — cyan-family but dark enough not to tire the eye.
const INK_TOP    = hex('#0B2024');
const INK_BOTTOM = hex('#05100F');

const CSS = {
  accent: '#19C6D6',
  accentDim: '#0E8C99',
  white: '#FFFFFF',
  black: '#080808',
};

/* --------------------------------------------------------------- primitives */

// Everything is expressed as primitives so one definition feeds both the
// rasteriser and the SVG writer. y grows downward; angles are degrees, with
// 0 at the right and 90 at the top.
const TAU = Math.PI * 2;

function ellipsePts(cx, cy, rx, ry, rot = 0, steps = 128) {
  const c = Math.cos((rot * Math.PI) / 180);
  const s = Math.sin((rot * Math.PI) / 180);
  const pts = [];
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * TAU;
    const x = rx * Math.cos(a);
    const y = ry * Math.sin(a);
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}

function arcPts(cx, cy, r, a0, a1, steps = 96) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = ((a0 + ((a1 - a0) * i) / steps) * Math.PI) / 180;
    pts.push([cx + r * Math.cos(a), cy - r * Math.sin(a)]);
  }
  return pts;
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i];
    const [x1, y1] = poly[(i + 1) % poly.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

// Force a known winding: outers positive, holes negative. Without this the
// nonzero fill cancels a shape against its neighbour wherever the two were
// generated in opposite directions (bottom arches and back-slanted bars).
const orient = (poly, positive) =>
  (signedArea(poly) >= 0) === positive ? poly : poly.slice().reverse();

// Flatten one primitive into closed polygons.
function flatten(p) {
  switch (p.t) {
    case 'ellipse':
      return [orient(ellipsePts(p.cx, p.cy, p.rx, p.ry, p.rot || 0), !p.hole)];
    case 'ring':
      return [
        orient(ellipsePts(p.cx, p.cy, p.rx, p.ry), true),
        orient(ellipsePts(p.cx, p.cy, p.rxi, p.ryi), false),
      ];
    case 'rect':
      return [orient([[p.x, p.y], [p.x + p.w, p.y], [p.x + p.w, p.y + p.h], [p.x, p.y + p.h]], true)];
    case 'arch':
      return [orient(arcPts(p.cx, p.cy, p.ro, p.a0, p.a1)
        .concat(arcPts(p.cx, p.cy, p.ri, p.a1, p.a0)), true)];
    case 'poly':
      return [orient(p.pts, !p.hole)];
    default:
      throw new Error('unknown primitive: ' + p.t);
  }
}
const mapPts = (polys, f) => polys.map((poly) => poly.map(f));

/* ------------------------------------------------------------- the penguin */

// Design space is 256x256, matching the SVG viewBox.
const DESIGN = 256;

const BODY = [
  { t: 'ellipse', cx: 128, cy: 80, rx: 50, ry: 48 },              // head
  { t: 'ellipse', cx: 128, cy: 152, rx: 70, ry: 66 },             // torso
  { t: 'ellipse', cx: 63, cy: 158, rx: 18, ry: 42, rot: 12 },     // flipper, left
  { t: 'ellipse', cx: 193, cy: 158, rx: 18, ry: 42, rot: -12 },   // flipper, right
];

const FEET = [
  { t: 'ellipse', cx: 84, cy: 216, rx: 41, ry: 19, rot: -18 },
  { t: 'ellipse', cx: 172, cy: 216, rx: 41, ry: 19, rot: 18 },
];

// The white keyline that makes it read as a sticker on any background.
const swell = (parts, d) =>
  parts.map((p) => ({ ...p, rx: p.rx + d, ry: p.ry + d }));

const EYE = (cx, grow = 0) => ({ t: 'ellipse', cx, cy: 73, rx: 12 + grow, ry: 15 + grow });

// Scale a polygon about a point — used to draw a keyline behind the crown.
const scalePoly = (pts, s, cx, cy) => pts.map(([x, y]) => [cx + (x - cx) * s, cy + (y - cy) * s]);

// A three-point crown resting on the head. One zigzag silhouette: up the left
// side, over peak/valley/peak/valley/peak, down the right side, along the band.
const CROWN_SILHOUETTE = [
  [92, 50], [92, 40], [104, 21], [116, 39], [128, 14], [140, 39], [152, 21], [164, 40], [164, 50],
];
const CROWN_CX = 128, CROWN_CY = 40;

const CROWN = [
  // white keyline so the crown reads on any background, like the body does
  { fill: WHITE,     parts: [{ t: 'poly', pts: scalePoly(CROWN_SILHOUETTE, 1.15, CROWN_CX, CROWN_CY) }] },
  { fill: GOLD,      parts: [{ t: 'poly', pts: CROWN_SILHOUETTE }] },
  // band shadow to separate the points from the base
  { fill: GOLD_DEEP, parts: [{ t: 'rect', x: 92, y: 44, w: 72, h: 2.6 }] },
  // jewels along the band
  { fill: ACCENT,    parts: [
      { t: 'ellipse', cx: 128, cy: 47, rx: 3.2, ry: 3.2 },
      { t: 'ellipse', cx: 108, cy: 47, rx: 2.6, ry: 2.6 },
      { t: 'ellipse', cx: 148, cy: 47, rx: 2.6, ry: 2.6 },
  ] },
  // gold beads on the peak tips
  { fill: GOLD,      parts: [
      { t: 'ellipse', cx: 128, cy: 13, rx: 3.8, ry: 3.8 },
      { t: 'ellipse', cx: 104, cy: 20, rx: 3.1, ry: 3.1 },
      { t: 'ellipse', cx: 152, cy: 20, rx: 3.1, ry: 3.1 },
  ] },
];

const PENGUIN = [
  { fill: WHITE,      parts: swell(FEET, 7) },
  { fill: ACCENT,     parts: FEET },
  { fill: WHITE,      parts: swell(BODY, 7) },
  { fill: BLACK,      parts: BODY },
  { fill: WHITE,      parts: [
      { t: 'ellipse', cx: 128, cy: 158, rx: 49, ry: 55 },         // belly
      { t: 'ellipse', cx: 128, cy: 103, rx: 35, ry: 27 },         // face
  ] },
  { fill: BLACK,      parts: [EYE(110, 1.5), EYE(146, 1.5)] },
  { fill: WHITE,      parts: [EYE(110), EYE(146),
      { t: 'ellipse', cx: 128, cy: 88, rx: 6, ry: 17 },           // brow wedge
  ] },
  { fill: BLACK,      parts: [
      { t: 'ellipse', cx: 114, cy: 76, rx: 5.2, ry: 7.5 },
      { t: 'ellipse', cx: 142, cy: 76, rx: 5.2, ry: 7.5 },
  ] },
  { fill: ACCENT,     parts: [{ t: 'ellipse', cx: 128, cy: 101, rx: 21, ry: 12.5 }] },
  { fill: ACCENT_DIM, parts: [{ t: 'ellipse', cx: 128, cy: 107, rx: 15, ry: 3.5 }] },
  ...CROWN,
];

/* ------------------------------------------------------------- the wordmark */

// A bold geometric italic, built from the same primitives. Eight unique
// letterforms is cheaper than shipping and licensing a display face.
const TRACK = 3;
const rect = (x, y, w, h) => ({ t: 'rect', x, y, w, h });
const ring = (cx, cy, r, ri) => ({ t: 'ring', cx, cy, rx: r, ry: r, rxi: ri, ryi: ri });
const arch = (cx, cy, ro, ri, a0, a1) => ({ t: 'arch', cx, cy, ro, ri, a0, a1 });

const GLYPHS = {
  L: { adv: 54, parts: [rect(0, -70, 16, 70), rect(0, -16, 46, 16)] },
  a: { adv: 58, parts: [ring(26, -26, 26, 12), rect(36, -52, 16, 52)] },
  r: { adv: 44, parts: [rect(0, -52, 16, 52), arch(26, -26, 26, 10, 180, 55)] },
  p: { adv: 58, parts: [rect(0, -52, 16, 77), ring(28, -26, 26, 12)] },
  i: { adv: 24, parts: [rect(0, -52, 16, 52), rect(0, -74, 16, 16)] },
  n: { adv: 58, parts: [rect(0, -52, 16, 52), arch(26, -26, 26, 10, 180, 0), rect(36, -26, 16, 26)] },
  u: { adv: 58, parts: [rect(0, -52, 16, 26), arch(26, -26, 26, 10, 180, 360), rect(36, -52, 16, 52)] },
  x: { adv: 54, parts: [
    { t: 'poly', pts: [[0, 0], [16, 0], [52, -52], [36, -52]] },
    { t: 'poly', pts: [[36, 0], [52, 0], [16, -52], [0, -52]] },
  ] },
  // lowercase l — a plain full-height stem
  l: { adv: 24, parts: [rect(0, -70, 16, 70)] },
  // o — a ring
  o: { adv: 58, parts: [ring(26, -26, 26, 12)] },
  // c — an open ring, gap on the right
  c: { adv: 54, parts: [arch(26, -26, 26, 12, 40, 320)] },
  // e — open ring with a crossbar; gap at the lower right
  e: { adv: 58, parts: [arch(26, -26, 26, 12, 22, 312), rect(3, -31, 44, 11)] },
  // t — ascending stem with a crossbar
  t: { adv: 40, parts: [rect(12, -66, 16, 66), rect(0, -50, 40, 12)] },
  ' ': { adv: 26, parts: [] },
};

const SLANT = 0.19; // ~11 degrees

function wordmarkPolys(text, x, baseline, capHeight) {
  const s = capHeight / 70;
  const polys = [];
  let pen = 0;
  for (const ch of text) {
    const g = GLYPHS[ch];
    if (!g) throw new Error('no glyph for ' + JSON.stringify(ch));
    for (const part of g.parts) {
      for (const poly of flatten(part)) {
        polys.push(poly.map(([px, py]) => [
          x + (pen + px - py * SLANT) * s,
          baseline + py * s,
        ]));
      }
    }
    pen += g.adv + TRACK;
  }
  return polys;
}

function wordmarkWidth(text, capHeight) {
  let pen = 0;
  for (const ch of text) pen += GLYPHS[ch].adv + TRACK;
  return (pen - TRACK + 70 * SLANT) * (capHeight / 70);
}

/* -------------------------------------------------------- draw + svg output */

function drawShapes(cv, shapes, tf, alpha = 1) {
  for (const layer of shapes) {
    const polys = [];
    for (const part of layer.parts) for (const poly of flatten(part)) polys.push(poly.map(tf));
    cv.fillPath(polys, layer.fill, alpha, 'nonzero');
  }
}

const toHex = (c) =>
  '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();

const n = (v) => Number(v.toFixed(2));

// Curves are flattened far finer than an SVG needs; drop any point landing
// within a third of a unit of the last one kept.
function dPath(poly, tol = 0.34) {
  const out = [];
  let last = null;
  for (const [x, y] of poly) {
    if (last && Math.hypot(x - last[0], y - last[1]) < tol) continue;
    out.push(`${n(x)} ${n(y)}`);
    last = [x, y];
  }
  return out.join('L');
}

function partToSVG(p) {
  switch (p.t) {
    case 'ellipse': {
      const rot = p.rot ? ` transform="rotate(${n(p.rot)} ${n(p.cx)} ${n(p.cy)})"` : '';
      return `<ellipse cx="${n(p.cx)}" cy="${n(p.cy)}" rx="${n(p.rx)}" ry="${n(p.ry)}"${rot}/>`;
    }
    case 'rect':
      return `<rect x="${n(p.x)}" y="${n(p.y)}" width="${n(p.w)}" height="${n(p.h)}"/>`;
    default:
      return flatten(p).map((poly) => `<path d="M${dPath(poly)}Z"/>`).join('');
  }
}

function shapesToSVG(shapes, w, h, viewBox, title) {
  const body = shapes
    .map((l) => `  <g fill="${toHex(l.fill)}"${l.transform ? ` transform="${l.transform}"` : ''}>${l.parts.map(partToSVG).join('')}</g>`)
    .join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${w}" height="${h}" role="img" aria-label="${title}">
  <title>${title}</title>
${body}
</svg>\n`;
}

/* -------------------------------------------------------------- composition */

function shapesBBox(shapes) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const layer of shapes) {
    for (const part of layer.parts) {
      for (const poly of flatten(part)) {
        for (const [x, y] of poly) {
          if (x < x0) x0 = x; if (y < y0) y0 = y;
          if (x > x1) x1 = x; if (y > y1) y1 = y;
        }
      }
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

const MARK_BOX = shapesBBox(PENGUIN);

function backdrop(cv) {
  const { w, h } = cv;
  const cx = w / 2, cy = h / 2;
  const maxD = Math.hypot(cx, cy);
  cv.shade((x, y) => {
    const t = y / h;
    const r = INK_TOP[0] + (INK_BOTTOM[0] - INK_TOP[0]) * t;
    const g = INK_TOP[1] + (INK_BOTTOM[1] - INK_TOP[1]) * t;
    const b = INK_TOP[2] + (INK_BOTTOM[2] - INK_TOP[2]) * t;
    const v = 1 - 0.5 * Math.pow(Math.hypot(x - cx, y - cy) / maxD, 2.2);
    return [r * v, g * v, b * v, 1];
  });
}
function grid(cv, step) {
  const t = Math.max(1, cv.h / 1440);
  for (let x = step; x < cv.w; x += step) {
    cv.rect(x, 0, t, cv.h, ACCENT, Math.round(x / step) % 5 === 0 ? 0.10 : 0.05);
  }
  for (let y = step; y < cv.h; y += step) {
    cv.rect(0, y, cv.w, t, ACCENT, Math.round(y / step) % 5 === 0 ? 0.10 : 0.05);
  }
}

// One composition, reused for the desktop wallpaper and both boot splashes.
// The boot splashes are top-weighted: GRUB draws its menu across the middle
// left of the screen, and centred art ends up with menu entries on top of it.
function compose(w, h, ss, topWeighted = false) {
  const cv = new Canvas(w, h, ss);
  const markH = h * (topWeighted ? 0.30 : 0.44);
  const k = markH / MARK_BOX.h;
  const mx = w / 2, my = h * (topWeighted ? 0.21 : 0.37);

  backdrop(cv);
  grid(cv, Math.max(24, Math.round(h / 18)));

  const tf = ([x, y]) => [mx + (x - MARK_BOX.cx) * k, my + (y - MARK_BOX.cy) * k];
  drawShapes(cv, PENGUIN, tf);
  const markBottom = my + (MARK_BOX.y + MARK_BOX.h - MARK_BOX.cy) * k;

  const cap = h * (topWeighted ? 0.055 : 0.070);
  const baseline = markBottom + h * (topWeighted ? 0.07 : 0.115);
  cv.fillPath(wordmarkPolys('Linux Leptocline', mx - wordmarkWidth('Linux Leptocline', cap) / 2, baseline, cap),
    WHITE, 1, 'nonzero');

  const spx = Math.round(h * 0.0032);
  if (spx >= 2) {
    const sub = '1.0 UNDERSTUDY';
    const ruleW = wordmarkWidth('Linux Leptocline', cap) * 0.5;
    cv.rect(mx - ruleW / 2, baseline + cap * 0.42, ruleW, Math.max(1, spx * 0.5), ACCENT, 0.8);
    cv.text(sub, mx - Canvas.textWidth(sub, spx) / 2, baseline + cap * 0.42 + spx * 5, spx,
      WHITE, 0.55);
  }
  return cv;
}

function icon(size, ss) {
  const cv = new Canvas(size, size, ss);
  const k = (size * 0.94) / MARK_BOX.h;
  drawShapes(cv, PENGUIN, ([x, y]) => [
    size / 2 + (x - MARK_BOX.cx) * k,
    size / 2 + (y - MARK_BOX.cy) * k,
  ]);
  return cv;
}

/* ---------------------------------------------------- svg wallpaper ---- */

// xfdesktop falls back to a compiled-in path when it cannot match the
// backdrop property to a monitor name, so the surest way to own the desktop
// background is to *be* that file rather than to configure our way to it.
function pixelTextParts(str, x, y, px) {
  const parts = [];
  let cx = x;
  for (const ch of str.toUpperCase()) {
    const g = FONT[ch] || FONT[" "];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (g[row][col] === "#") parts.push(rect(cx + col * px, y + row * px, px, px));
      }
    }
    cx += px * 6;
  }
  return parts;
}

function wallpaperSVG(w, h) {
  const NL = String.fromCharCode(10);
  const markH = h * 0.44;
  const k = markH / MARK_BOX.h;
  const mx = w / 2, my = h * 0.37;
  const tx = mx - MARK_BOX.cx * k, ty = my - MARK_BOX.cy * k;
  const markBottom = my + (MARK_BOX.y + MARK_BOX.h - MARK_BOX.cy) * k;
  const cap = h * 0.070;
  const baseline = markBottom + h * 0.115;
  const wmW = wordmarkWidth("Linux Leptocline", cap);
  const wm = wordmarkPolys("Linux Leptocline", mx - wmW / 2, baseline, cap);

  const step = Math.max(24, Math.round(h / 18));
  let grid = "";
  for (let x = step; x < w; x += step) {
    const o = Math.round(x / step) % 5 === 0 ? 0.10 : 0.05;
    grid += `<rect x="${n(x)}" y="0" width="1.5" height="${h}" opacity="${o}"/>`;
  }
  for (let y = step; y < h; y += step) {
    const o = Math.round(y / step) % 5 === 0 ? 0.10 : 0.05;
    grid += `<rect x="0" y="${n(y)}" width="${w}" height="1.5" opacity="${o}"/>`;
  }

  const ruleW = wmW * 0.5;
  const ruleY = baseline + cap * 0.42;
  const spx = Math.max(2, Math.round(h * 0.0032));
  const sub = "1.0 UNDERSTUDY";
  const subParts = pixelTextParts(sub, mx - Canvas.textWidth(sub, spx) / 2, ruleY + spx * 5, spx);

  const mark = PENGUIN.map((l) =>
    `<g fill="${toHex(l.fill)}" transform="translate(${n(tx)} ${n(ty)}) scale(${n(k)})">` +
    l.parts.map(partToSVG).join("") + "</g>").join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid slice">`,
    "  <defs>",
    `    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">`,
    `      <stop offset="0" stop-color="${toHex(INK_TOP)}"/>`,
    `      <stop offset="1" stop-color="${toHex(INK_BOTTOM)}"/>`,
    "    </linearGradient>",
    `    <radialGradient id="vig" cx="50%" cy="50%" r="78%">`,
    `      <stop offset="0.4" stop-color="#000000" stop-opacity="0"/>`,
    `      <stop offset="1" stop-color="#000000" stop-opacity="0.5"/>`,
    "    </radialGradient>",
    "  </defs>",
    `  <rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    `  <g fill="${CSS.accent}">${grid}</g>`,
    `  <rect width="${w}" height="${h}" fill="url(#vig)"/>`,
    `  ${mark}`,
    `  <g fill="#FFFFFF">` + wm.map((p) => `<path d="M${dPath(p)}Z"/>`).join("") + "</g>",
    `  <rect x="${n(mx - ruleW / 2)}" y="${n(ruleY)}" width="${n(ruleW)}" height="${n(Math.max(1, spx * 0.5))}" fill="${CSS.accent}" opacity="0.8"/>`,
    `  <g fill="#FFFFFF" opacity="0.55">` + subParts.map(partToSVG).join("") + "</g>",
    "</svg>",
  ].join(NL) + NL;
}

/* --------------------------------------------------------------------- main */

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'branding', 'out');
const CHROOT = path.join(ROOT, 'config', 'includes.chroot');
const BINARY = path.join(ROOT, 'config', 'includes.binary');

function put(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  console.log(`  ${rel(file)}`);
}

function main() {
  console.log('leptocline :: rendering brand assets\n');

  console.log(' vector');
  const pad = 8;
  const vb = `${n(MARK_BOX.x - pad)} ${n(MARK_BOX.y - pad)} ${n(MARK_BOX.w + pad * 2)} ${n(MARK_BOX.h + pad * 2)}`;
  put(path.join(ROOT, 'branding/logo.svg'),
    shapesToSVG(PENGUIN, 256, 256, vb, 'Linux Leptocline'));

  const cap = 62;
  const lockW = 520;
  const wm = [{ fill: WHITE, parts: wordmarkPolys(
    'Linux Leptocline', (lockW - wordmarkWidth('Linux Leptocline', cap)) / 2, 610, cap)
    .map((pts) => ({ t: 'poly', pts })) }];
  const lockK = 440 / MARK_BOX.h;
  const lockShapes = [
    { fill: INK_TOP, parts: [rect(0, 0, lockW, 680)] },
    ...PENGUIN.map((l) => ({
      ...l,
      transform: `translate(${n(lockW / 2 - MARK_BOX.cx * lockK)} ${n(250 - MARK_BOX.cy * lockK)}) scale(${n(lockK)})`,
    })),
    ...wm,
  ];
  put(path.join(ROOT, 'branding/logo-lockup.svg'),
    shapesToSVG(lockShapes, lockW, 680, `0 0 ${lockW} 680`, 'Linux Leptocline'));

  console.log('\n wallpapers');
  const wall = compose(2560, 1440, 2);
  wall.write(path.join(OUT, 'wallpaper-2560x1440.png'));
  fs.mkdirSync(path.join(CHROOT, 'usr/share/backgrounds/leptocline'), { recursive: true });
  fs.copyFileSync(path.join(OUT, 'wallpaper-2560x1440.png'),
    path.join(CHROOT, 'usr/share/backgrounds/leptocline/leptocline-wallpaper.png'));
  const wsvg = wallpaperSVG(2560, 1440);
  put(path.join(ROOT, 'branding/wallpaper.svg'), wsvg);
  put(path.join(CHROOT, 'usr/share/backgrounds/leptocline/leptocline-wallpaper.svg'), wsvg);
  // xfdesktop falls back to this exact path when it cannot match a monitor
  // name, so owning the file makes our background the default outright.
  put(path.join(CHROOT, 'usr/share/backgrounds/xfce/xfce-x.svg'), wsvg);

  compose(1920, 1080, 2).write(path.join(OUT, 'wallpaper-1920x1080.png'));

  console.log('\n boot splashes');
  compose(1024, 768, 2, true).write(path.join(BINARY, 'boot/grub/splash.png'));
  compose(640, 480, 3, true).write(path.join(BINARY, 'isolinux/splash.png'));

  console.log('\n icons');
  for (const size of [512, 256, 128, 64, 48, 32, 16]) {
    const cv = icon(size, size <= 64 ? 8 : 4);
    cv.write(path.join(OUT, `logo-${size}.png`));
    const dir = path.join(CHROOT, `usr/share/icons/hicolor/${size}x${size}/apps`);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(OUT, `logo-${size}.png`), path.join(dir, 'leptocline.png'));
  }

  console.log('\n installed copies');
  for (const [src, dst] of [
    ['logo-256.png', 'usr/share/plymouth/themes/leptocline/logo.png'],
    ['logo-128.png', 'usr/share/pixmaps/leptocline.png'],
    ['logo-512.png', 'usr/share/leptocline/logo.png'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(CHROOT, dst)), { recursive: true });
    fs.copyFileSync(path.join(OUT, src), path.join(CHROOT, dst));
    console.log(`  ${dst}`);
  }
  fs.copyFileSync(path.join(ROOT, 'branding/logo.svg'), path.join(CHROOT, 'usr/share/leptocline/logo.svg'));
  fs.copyFileSync(path.join(OUT, 'wallpaper-2560x1440.png'),
    path.join(CHROOT, 'usr/share/leptocline/wallpaper.png'));

  console.log('\ndone.');
}

if (require.main === module) main();
module.exports = { Canvas, PENGUIN, GLYPHS, wordmarkPolys, wordmarkWidth, drawShapes, MARK_BOX, WHITE, BLACK, ACCENT };
