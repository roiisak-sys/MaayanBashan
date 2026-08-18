import { PDFDocument } from 'pdf-lib';
import fs from 'node:fs';
const bytes = fs.readFileSync('templates/certificate-template.pdf');
const doc = await PDFDocument.load(bytes);
console.log('Pages:', doc.getPageCount());
doc.getPages().forEach((p, i) => {
  const { width, height } = p.getSize();
  console.log(`Page ${i}: ${width.toFixed(1)} x ${height.toFixed(1)} pt (${width>height?'landscape':'portrait'})`);
  console.log(`  = ${(width/72*25.4).toFixed(1)} x ${(height/72*25.4).toFixed(1)} mm, rotation ${p.getRotation().angle}`);
});
