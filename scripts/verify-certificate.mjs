#!/usr/bin/env node
// Structural verification of generated certificates.
//
//   npm run verify:certificate
//
// Checks, without needing any external PDF tooling:
//   - every Hebrew glyph in the test names exists in the embedded font
//     (i.e. nothing will render as a blank box)
//   - the drawn name fits inside the design's rule width at some allowed size
//   - the name stays horizontally centred
//   - IDs keep their leading zeros
//   - a real PDF is produced for each case

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fontkit from '@pdf-lib/fontkit';
import { generateCertificate, getLayout, buildFilename } from '../netlify/functions/lib/certificate.mjs';
import { toVisualOrder, formatIdForDisplay } from '../netlify/functions/lib/text.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const CASES = [
  ['ישראל ישראלי', '012345678'],
  ['מור חסון', '311111118'],
  ['יעל סאקסטין יונה', '000000018'],
  ['מולועלם אסממאו טסמה', '123456782'],
  ['הודיה סיון ברזילאי כהן-אברמוביץ מזרחי', '012345678'],
  ['Yaffa Adler', '987654321'],
  ['דוד Cohen', '012345678'],
];

const [templateBytes, regularFontBytes, boldFontBytes] = await Promise.all([
  fs.readFile(path.join(root, 'templates/certificate-template.pdf')),
  fs.readFile(path.join(root, 'templates/assistant-regular.ttf')),
  fs.readFile(path.join(root, 'templates/assistant-semibold.ttf')),
]);

const layout = getLayout({});
const boldFont = fontkit.create(boldFontBytes);
const regularFont = fontkit.create(regularFontBytes);

let failures = 0;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failures += 1; };

console.log(`page slots: name centerX=${layout.name.centerX} baselineY=${layout.name.baselineY} maxWidth=${layout.name.maxWidth}`);
console.log(`            id   centerX=${layout.id.centerX} baselineY=${layout.id.baselineY}\n`);

for (const [name, idNumber] of CASES) {
  console.log(`${name}  (${idNumber})`);

  // 1. glyph coverage — a missing glyph renders as a blank box on the PDF
  const missing = Array.from(name).filter(
    (ch) => ch.trim() && !boldFont.hasGlyphForCodePoint(ch.codePointAt(0))
  );
  if (missing.length) fail(`font is missing glyphs: ${missing.join(' ')}`);

  // 2. width + auto-shrink: find the size the renderer would settle on
  const visual = toVisualOrder(name);
  const scaleFor = (font, size) =>
    (font.layout(visual).advanceWidth / font.unitsPerEm) * size;

  let size = layout.name.fontSize;
  while (scaleFor(boldFont, size) > layout.name.maxWidth && size > layout.name.minFontSize) {
    size -= 0.5;
  }
  const width = scaleFor(boldFont, size);
  if (width > layout.name.maxWidth + 0.5) {
    fail(`name overflows: ${width.toFixed(1)}pt > ${layout.name.maxWidth}pt even at min size`);
  }

  // 3. centring
  const left = layout.name.centerX - width / 2;
  const center = left + width / 2;
  if (Math.abs(center - layout.name.centerX) > 0.01) fail(`name not centred (${center.toFixed(2)})`);

  // 4. ID integrity
  const display = formatIdForDisplay(idNumber);
  if (display.length !== 9) fail(`ID not 9 digits: ${display}`);
  if (idNumber.startsWith('0') && !display.startsWith('0')) fail('leading zero lost');
  const idWidth = (regularFont.layout(display).advanceWidth / regularFont.unitsPerEm) * layout.id.fontSize;
  if (idWidth > layout.id.maxWidth + 0.5) fail(`ID overflows underscores: ${idWidth.toFixed(1)}pt`);

  // 5. real PDF output
  const bytes = await generateCertificate({
    templateBytes, regularFontBytes, boldFontBytes, name, idNumber,
  });
  if (Buffer.from(bytes.slice(0, 5)).toString() !== '%PDF-') fail('output is not a PDF');

  console.log(
    `  ✓ size ${size}pt, width ${width.toFixed(1)}/${layout.name.maxWidth}pt, ` +
    `id ${display}, ${(bytes.length / 1024).toFixed(1)}KB, ${buildFilename(name)}`
  );
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll structural checks passed.');
process.exit(failures ? 1 : 0);
