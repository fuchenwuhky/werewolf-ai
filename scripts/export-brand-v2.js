/** Export the hand-authored v2 SVG into a staging asset pack; never overwrites production icons.
 * Build-only renderer: set WW_SHARP_MODULE to an installed sharp module path, or install it in a separate tooling environment.
 * node scripts/export-brand-v2.js
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'design', 'brand', 'v2');
const OUT = path.join(DIR, 'export');
const sharp = require(process.env.WW_SHARP_MODULE || 'sharp');
const source = fs.readFileSync(path.join(DIR, 'wolf-emblem.svg'), 'utf8');
const content = source.slice(source.indexOf('<defs>'), source.lastIndexOf('</svg>'));
function svg({ background = true, scale = 1 } = {}) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 1024 1024" width="1024" height="1024">' +
    (background ? '<rect width="1024" height="1024" fill="#080d17"/>' : '') +
    `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)">${content}</g></svg>`
  );
}
function ico(frames) {
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, buffer }, i) => {
    const at = 6 + 16 * i;
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(buffer.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += buffer.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.buffer)]);
}
async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const appSvg = Buffer.from(svg());
  fs.writeFileSync(path.join(OUT, 'app-icon.svg'), appSvg);
  const manifest = {
    source: 'design/brand/v2/wolf-emblem.svg',
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    renderer: 'sharp ' + sharp.versions.sharp,
    files: [{ name: 'app-icon.svg', width: 1024, height: 1024, bytes: appSvg.length, sha256: crypto.createHash('sha256').update(appSvg).digest('hex') }],
  };
  async function png(name, size, options = {}) {
    const pipeline = sharp(Buffer.from(svg(options))).resize(size, size);
    if (options.background !== false) pipeline.removeAlpha();
    const buffer = await pipeline.png().toBuffer();
    fs.writeFileSync(path.join(OUT, name), buffer);
    manifest.files.push({ name, width: size, height: size, bytes: buffer.length, sha256: crypto.createHash('sha256').update(buffer).digest('hex') });
    return buffer;
  }
  for (const size of [16, 24, 32, 48, 64, 72, 96, 128, 144, 180, 192, 256, 512, 1024]) await png(`icon-${size}.png`, size);
  await png('wolf-decal-1024.png', 1024, { background: false });
  await png('icon-maskable-512.png', 512, { scale: 0.82 });
  // 108 dp adaptive canvas: all important content inside the central 66 dp safe circle.
  for (const size of [108, 162, 216, 324, 432]) await png(`adaptive-foreground-${size}.png`, size, { background: false, scale: 0.69 });
  const frames = [];
  for (const size of [16, 24, 32, 48, 64, 128, 256]) frames.push({ size, buffer: fs.readFileSync(path.join(OUT, `icon-${size}.png`)) });
  const win = ico(frames);
  fs.writeFileSync(path.join(OUT, 'app.ico'), win);
  manifest.files.push({ name: 'app.ico', sizes: frames.map((f) => f.size), bytes: win.length, sha256: crypto.createHash('sha256').update(win).digest('hex') });
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Exported ${manifest.files.length} SVG/raster/icon files to ${OUT}`);
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
