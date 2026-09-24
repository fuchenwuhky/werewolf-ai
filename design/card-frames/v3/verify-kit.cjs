#!/usr/bin/env node
/* Read-only, zero-dependency verification of this isolated design kit.
 * Run: node design/card-frames/v3/verify-kit.cjs
 * DOM stubs check mount contracts; they do not verify browser layout, CSS
 * rendering, actual image decoding, transparency samples, or native WebViews.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = __dirname;
let assertions = 0;

function check(condition, message) {
  assertions++;
  assert.ok(condition, message);
}

function equal(actual, expected, message) {
  assertions++;
  assert.deepStrictEqual(actual, expected, message);
}

function filesIn(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? filesIn(file) : [file];
  }).sort();
}

function localResource(sourceFile, reference) {
  if (!reference || reference.startsWith('#') || /^(?:data:|https?:|mailto:)/i.test(reference)) return;
  check(!/^[a-z][\w+.-]*:/i.test(reference), `Unexpected resource scheme: ${reference}`);
  const clean = decodeURIComponent(reference.split(/[?#]/, 1)[0]);
  const resolved = path.resolve(path.dirname(sourceFile), clean);
  check(fs.existsSync(resolved) && fs.statSync(resolved).isFile(),
    `${path.relative(ROOT, sourceFile)} references a missing file: ${reference}`);
}

function inspectSvg(file) {
  const source = fs.readFileSync(file, 'utf8');
  const label = path.relative(ROOT, file);
  check(/^\s*<svg\b/.test(source) && /<\/svg>\s*$/.test(source), `${label}: missing SVG root`);
  check(!/<(?:script|foreignObject)\b|<!DOCTYPE/i.test(source), `${label}: not a passive, self-contained SVG`);
  const ids = [...source.matchAll(/\bid\s*=\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  equal(new Set(ids).size, ids.length, `${label}: duplicate IDs`);
  const references = [...source.matchAll(/url\(\s*['"]?#([^\s)'";]+)['"]?\s*\)|(?:\bxlink:)?\bhref\s*=\s*['"]#([^'"]+)['"]/g)];
  for (const match of references) {
    const id = match[1] || match[2];
    check(ids.includes(id), `${label}: unresolved #${id}`);
  }
  for (const match of source.matchAll(/(?:\bxlink:)?\bhref\s*=\s*['"]([^'"]+)['"]/g)) {
    check(match[1].startsWith('#'), `${label}: external SVG resource ${match[1]}`);
  }
  // A structural check for this kit's simple SVG subset, not a general XML parser.
  const stack = [];
  const tags = source.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<\s*(\/?)([\w:-]+)\b[^>]*?(\/?)>/g);
  for (const tag of tags) {
    if (tag[1]) equal(stack.pop(), tag[2], `${label}: mismatched closing tag ${tag[2]}`);
    else if (!tag[3]) stack.push(tag[2]);
  }
  equal(stack.length, 0, `${label}: unclosed elements`);
  return references.length;
}

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this.handlers = {};
  }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  addEventListener(type, callback) {
    (this.handlers[type] ||= []).push(callback);
  }
  emit(type) { for (const callback of this.handlers[type] || []) callback(); }
}

function walk(node) { return [node, ...node.children.flatMap(walk)]; }

function snapshot(node) {
  // Generated clip IDs must be unique, but their counter is not secret content.
  const normalize = (value) => typeof value === 'string' ? value.replace(/r3-window-\d+/g, 'r3-window-ID') : value;
  const plain = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  return {
    tag: node.tag, attrs: plain(node.attrs), dataset: plain(node.dataset),
    className: node.className, src: node.src, alt: node.alt,
    textContent: node.textContent, children: node.children.map(snapshot),
  };
}

function main() {
  const files = filesIn(ROOT);
  const scripts = files.filter((file) => /\.(?:js|cjs)$/.test(file));
  for (const file of scripts) {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
    assertions++;
  }
  console.log(`PASS JavaScript syntax: ${scripts.length} files (compiled, not executed)`);

  const svgs = files.filter((file) => file.endsWith('.svg'));
  check(svgs.length > 0, 'No SVG assets found');
  const references = svgs.reduce((total, file) => total + inspectSvg(file), 0);
  console.log(`PASS SVG structure / unique IDs / internal references: ${svgs.length} files, ${references} references`);

  for (const file of files.filter((item) => /\.(?:html|css)$/.test(item))) {
    const source = fs.readFileSync(file, 'utf8');
    const pattern = file.endsWith('.html')
      ? /\b(?:src|href)\s*=\s*['"]([^'"]+)['"]/g
      : /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'"\s)]+))\s*\)/g;
    for (const match of source.matchAll(pattern)) localResource(file, match[1] || match[2] || match[3]);
  }
  console.log('PASS HTML / CSS local resource references');

  const document = {
    createElement: (tag) => new Element(tag),
    createElementNS: (_, tag) => new Element(tag),
  };
  const context = { document, window: {} };
  vm.createContext(context);
  new vm.Script(fs.readFileSync(path.join(ROOT, 'frame-kit.js'), 'utf8'), { filename: 'frame-kit.js' })
    .runInContext(context, { timeout: 1000 });
  const kit = context.window.ReliquaryCards;
  check(kit && typeof kit.mount === 'function' && kit.roles, 'Missing design-kit mount API or role map');
  const roleIds = Object.keys(kit.roles);
  check(roleIds.length > 0, 'No roles declared');
  const baseHost = new Element('div');
  const hiddenBaseline = kit.mount(baseHost, {});
  const hiddenSnapshot = snapshot(hiddenBaseline);
  equal(hiddenBaseline.dataset.theme, 'neutral', 'Unknown identity must use the neutral theme');

  const seenClipIds = new Set();
  function mount(options) {
    const host = new Element('div');
    const shell = kit.mount(host, options);
    equal(host.children.length, 1, 'mount must replace the host content with one shell');
    equal(host.children[0], shell, 'mount must return its attached shell');
    const nodes = walk(shell);
    for (const clip of nodes.filter((node) => node.tag === 'clipPath')) {
      check(clip.attrs.id && !seenClipIds.has(clip.attrs.id), 'Clip IDs must be unique between cards');
      seenClipIds.add(clip.attrs.id);
      check(nodes.some((node) => node.attrs['clip-path'] === `url(#${clip.attrs.id})`), 'Generated clip is not referenced');
    }
    return { shell, nodes, card: nodes.find((node) => node.attrs.role === 'img') };
  }

  let privacyCases = 0;
  for (const roleId of roleIds) {
    for (const revealed of [false, undefined, 1, 'true']) {
      const { shell, nodes, card } = mount({ roleId, revealed });
      equal(snapshot(shell), hiddenSnapshot, `${roleId}: hidden output differs from the common card back`);
      equal(card.dataset.role, undefined, `${roleId}: hidden card exposes data-role`);
      for (const node of nodes) {
        const resource = node.src || (node.tag === 'image' && node.attrs.href);
        if (resource) localResource(path.join(ROOT, 'index.html'), resource);
      }
      privacyCases++;
    }
    const { shell, nodes, card } = mount({ roleId, revealed: true });
    equal(shell.dataset.theme, kit.roles[roleId][1], `${roleId}: revealed theme mismatch`);
    equal(card.dataset.role, roleId, `${roleId}: revealed identity mismatch`);
    check(card.attrs['aria-label'].includes(kit.roles[roleId][0]), `${roleId}: missing accessible role name`);
    for (const node of nodes) {
      const resource = node.src || (node.tag === 'image' && node.attrs.href);
      if (resource) localResource(path.join(ROOT, 'index.html'), resource);
    }
    privacyCases++;
  }
  console.log(`PASS hidden / revealed mount contracts: ${privacyCases} cases across ${roleIds.length} roles`);

  for (const roleId of ['not-a-role', '__proto__', 'constructor']) {
    equal(snapshot(mount({ roleId, revealed: true }).shell), hiddenSnapshot, 'Unknown role must remain neutral');
  }
  const fallback = mount({ roleId: roleIds[0], revealed: true });
  const picture = fallback.nodes.find((node) => node.tag === 'image');
  check(picture.handlers.error?.length, 'Missing illustration error handler');
  picture.emit('error');
  equal(fallback.card.dataset.artError, 'true', 'Illustration failure state missing');
  const failures = [
    ['r3-material', 'materialError', false],
    ['r3-vector', 'vectorError', true],
    ['r3-compact', 'compactError', true],
    ['r3-accent', 'accentError', true],
  ];
  for (const [className, errorKey, hidden] of failures) {
    const image = fallback.nodes.find((node) => node.className === className);
    check(image && image.handlers.error?.length, `${className}: missing failure handler`);
    image.emit('error');
    equal(fallback.card.dataset[errorKey], 'true', `${className}: failure state missing`);
    if (hidden) equal(image.hidden, true, `${className}: broken image must be hidden`);
  }
  equal(mount({ width: 52 }).shell.dataset.detail, 'compact', 'Small explicit width must select compact detail');
  equal(mount({ compact: true }).shell.dataset.detail, 'compact', 'Explicit compact fallback missing');
  equal(mount({ render: 'vector' }).shell.dataset.render, 'vector', 'Explicit vector mode missing');
  const custom = mount({ roleId: roleIds[0], revealed: true, assetBase: './custom-frame-assets', artBase: './custom-role-art' });
  for (const node of custom.nodes.filter((item) => item.tag === 'img')) {
    check(node.src.startsWith('./custom-frame-assets/'), 'assetBase must accept a missing trailing slash');
  }
  check(custom.nodes.find((node) => node.tag === 'image').attrs.href.startsWith('./custom-role-art/'),
    'artBase must accept a missing trailing slash');
  console.log('PASS unknown role / unique clips / error states / explicit compact / base-path contracts');

  const pngs = files.filter((file) => file.endsWith('.png'));
  const materialFile = path.join(ROOT, 'assets', 'reliquary-metal.png');
  check(pngs.includes(materialFile), 'Required transparent PNG material is missing');
  for (const file of pngs) {
    const bytes = fs.readFileSync(file);
    check(bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Invalid PNG signature');
    equal(bytes.toString('ascii', 12, 16), 'IHDR', 'PNG must start with IHDR');
    equal(bytes.readUInt32BE(8), 13, 'Unexpected IHDR size');
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    const colorType = bytes[25];
    const allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
    check(width > 0 && width <= 0x7fffffff && height > 0 && height <= 0x7fffffff, 'Invalid PNG dimensions');
    check(allowedDepths[colorType]?.includes(bytes[24]), 'Invalid PNG color type / bit depth combination');
    equal(bytes[26], 0, 'Unsupported PNG compression method');
    equal(bytes[27], 0, 'Unsupported PNG filter method');
    check(bytes[28] === 0 || bytes[28] === 1, 'Invalid PNG interlace method');
    if (file === materialFile) {
      equal(colorType, 6, 'Material PNG must declare RGBA color type');
      equal(width, 1024, 'Material PNG must be 1024 pixels wide');
      equal(height, 1536, 'Material PNG must be 1536 pixels tall');
    }
    const dimensions = `${width}x${height}`;
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    console.log(`PASS PNG IHDR (color type ${colorType}${file === materialFile ? ', required RGBA material' : ''}): ${path.relative(ROOT, file)} ${dimensions}; sha256=${sha}`);
  }
  console.log(`PASS ${assertions} assertions. Read-only; no server, browser, network, or file writes.`);
  console.log('LIMIT: DOM-stub and static checks only; no CSS rendering, full XML validation, PNG decoding, or alpha-pixel sampling.');
}

try { main(); } catch (error) {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
}
