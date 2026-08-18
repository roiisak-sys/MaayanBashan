#!/usr/bin/env node
// Development-only certificate generator.
//
// Generates a certificate straight from the template without touching Airtable,
// so PDF coordinates and Hebrew rendering can be checked visually.
//
//   npm run test:certificate
//   npm run test:certificate -- "יעל סאקסטין יונה" 012345678
//
// Output: scripts/output/<filename>.pdf  (gitignored)

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCertificate, buildFilename } from '../netlify/functions/lib/certificate.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const name = process.argv[2] || 'ישראל ישראלי';
const idNumber = process.argv[3] || '012345678';

const [templateBytes, regularFontBytes, boldFontBytes] = await Promise.all([
  fs.readFile(path.join(root, 'templates/certificate-template.pdf')),
  fs.readFile(path.join(root, 'templates/assistant-regular.ttf')),
  fs.readFile(path.join(root, 'templates/assistant-semibold.ttf')),
]);

const pdfBytes = await generateCertificate({
  templateBytes,
  regularFontBytes,
  boldFontBytes,
  name,
  idNumber,
});

const outDir = path.join(here, 'output');
await fs.mkdir(outDir, { recursive: true });
const outPath = path.join(outDir, buildFilename(name));
await fs.writeFile(outPath, pdfBytes);

console.log(`name:  ${name}`);
console.log(`id:    ${idNumber}`);
console.log(`bytes: ${pdfBytes.length}`);
console.log(`saved: ${path.relative(root, outPath)}`);
