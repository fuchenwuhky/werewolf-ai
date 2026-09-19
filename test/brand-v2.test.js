'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const dir = path.join(root, 'design/brand/v2');
const out = path.join(dir, 'export');
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const digest = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const read = (name) => fs.readFileSync(path.join(out, name));
const pngSize = (buffer) => {
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(buffer.toString('ascii', 12, 16), 'IHDR');
  return [buffer.readUInt32BE(16), buffer.readUInt32BE(20)];
};

test('brand v2: editable SVG master and app variant are self-contained vectors', () => {
  for (const file of [path.join(dir, 'wolf-emblem.svg'), path.join(out, 'app-icon.svg')]) {
    const source = fs.readFileSync(file, 'utf8');
    assert.match(source, /viewBox="0 0 1024 1024"/);
    assert.match(source, /<path\s/);
    assert.doesNotMatch(source, /<(?:image|script|foreignObject)\b/i);
    assert.doesNotMatch(source, /(?:href|src)\s*=\s*["'](?!#)/i);
    assert.doesNotMatch(source, /url\(\s*["']?(?!#)[a-z]/i);
  }
});

test('brand v2: manifest pins source and every raster/icon export by SHA-256', () => {
  assert.equal(manifest.source, 'design/brand/v2/wolf-emblem.svg');
  assert.equal(digest(fs.readFileSync(path.join(root, manifest.source))), manifest.sourceSha256);
  assert.match(manifest.renderer, /^sharp \d+\.\d+\.\d+$/);
  assert.equal(manifest.files.length, 23);
  assert.equal(new Set(manifest.files.map((f) => f.name)).size, 23);
  for (const file of manifest.files) {
    assert.equal(path.basename(file.name), file.name);
    const buffer = read(file.name);
    assert.equal(buffer.length, file.bytes, file.name);
    assert.equal(digest(buffer), file.sha256, file.name);
    if (file.name.endsWith('.png')) assert.deepEqual(pngSize(buffer), [file.width, file.height]);
  }
});

test('brand v2: ordinary icons and maskable PNG have opaque RGB channels', () => {
  for (const size of [16, 24, 32, 48, 64, 72, 96, 128, 144, 180, 192, 256, 512, 1024]) {
    const buffer = read(`icon-${size}.png`);
    assert.deepEqual(pngSize(buffer), [size, size]);
    assert.equal(buffer[25], 2, 'RGB with no alpha');
  }
  const maskable = read('icon-maskable-512.png');
  assert.deepEqual(pngSize(maskable), [512, 512]);
  assert.equal(maskable[25], 2);
});

test('brand v2: decal and Android adaptive foregrounds retain alpha channels', () => {
  const decal = read('wolf-decal-1024.png');
  assert.deepEqual(pngSize(decal), [1024, 1024]);
  assert.equal(decal[25], 6);
  for (const size of [108, 162, 216, 324, 432]) {
    const buffer = read(`adaptive-foreground-${size}.png`);
    assert.deepEqual(pngSize(buffer), [size, size]);
    assert.equal(buffer[25], 6, 'RGBA');
  }
});

test('brand v2: Windows ICO contains seven valid, contiguous, matching PNG frames', () => {
  const buffer = read('app.ico');
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  assert.equal(buffer.readUInt16LE(0), 0);
  assert.equal(buffer.readUInt16LE(2), 1);
  assert.equal(buffer.readUInt16LE(4), sizes.length);
  let expectedOffset = 6 + 16 * sizes.length;
  sizes.forEach((size, index) => {
    const at = 6 + index * 16;
    assert.equal(buffer[at] || 256, size);
    assert.equal(buffer[at + 1] || 256, size);
    assert.equal(buffer.readUInt16LE(at + 4), 1);
    assert.equal(buffer.readUInt16LE(at + 6), 32);
    const length = buffer.readUInt32LE(at + 8);
    const offset = buffer.readUInt32LE(at + 12);
    assert.equal(offset, expectedOffset);
    const frame = buffer.subarray(offset, offset + length);
    assert.deepEqual(pngSize(frame), [size, size]);
    assert.deepEqual(frame, read(`icon-${size}.png`));
    expectedOffset += length;
  });
  assert.equal(expectedOffset, buffer.length);
});
