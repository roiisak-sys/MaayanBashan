// Certificate PDF generation.
//
// Takes the designer's original certificate PDF as the visual base and only
// stamps the participant-specific values into the two slots the design already
// reserves for them:
//
//   - an empty text placeholder (size 27, colour #f5f0e6) on the name line
//   - the "מס׳ תעודת זהות: ______" underscore run
//
// Nothing else about the template is touched.

import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { splitDirectionalRuns, formatIdForDisplay } from './text.mjs';

/** #rrggbb -> pdf-lib rgb() */
function hexToRgb(hex) {
  const clean = String(hex).replace('#', '');
  return rgb(
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255
  );
}

function num(envValue, fallback) {
  const parsed = Number(envValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Text placement, measured from the supplied template
 * (A4 portrait, 595.92 x 841.92 pt).
 *
 * Coordinates are pdf-lib style: origin at the BOTTOM-left, y increasing
 * upward. The source measurements were taken top-down, hence the conversion
 * already applied below (y = 841.92 - topDownBaseline).
 *
 * Every value can be overridden with an env var so the positions can be nudged
 * in production without touching this file.
 */
export function getLayout(env = process.env) {
  return {
    name: {
      page: 0,
      // Horizontal centre of the page — matches the template's own centred
      // placeholder and the gold rule beneath it.
      centerX: num(env.CERT_NAME_CENTER_X, 297.96),
      baselineY: num(env.CERT_NAME_BASELINE_Y, 497.67),
      fontSize: num(env.CERT_NAME_FONT_SIZE, 27),
      // The gold rule under the name is ~259pt wide; keep the name inside it.
      maxWidth: num(env.CERT_NAME_MAX_WIDTH, 259),
      minFontSize: num(env.CERT_NAME_MIN_FONT_SIZE, 14),
      color: env.CERT_NAME_COLOR || '#f5f0e6',
      bold: true,
    },
    id: {
      page: 0,
      // Centre of the 14-underscore run (x 227.5 -> 294.9).
      centerX: num(env.CERT_ID_CENTER_X, 261.2),
      baselineY: num(env.CERT_ID_BASELINE_Y, 454.17),
      fontSize: num(env.CERT_ID_FONT_SIZE, 9.9),
      maxWidth: num(env.CERT_ID_MAX_WIDTH, 67),
      minFontSize: num(env.CERT_ID_MIN_FONT_SIZE, 7),
      color: env.CERT_ID_COLOR || '#f5f0e6',
      bold: false,
    },
  };
}

/**
 * Draw text centred on `centerX`, shrinking the font if it would exceed
 * `maxWidth`, so that unusually long names stay inside the design instead of
 * bleeding past the rule.
 *
 * The text is drawn one directional run at a time, left to right. Handing the
 * whole string to pdf-lib in one call would let fontkit apply a single global
 * reversal, which is right for pure Hebrew but silently corrupts any embedded
 * Latin word or multi-digit number.
 */
function drawCentered(page, text, font, slot) {
  const runs = splitDirectionalRuns(text);
  if (runs.length === 0) return { size: slot.fontSize, width: 0 };

  const totalWidth = (size) =>
    runs.reduce((sum, run) => sum + font.widthOfTextAtSize(run.text, size), 0);

  let size = slot.fontSize;
  let width = totalWidth(size);

  while (width > slot.maxWidth && size > slot.minFontSize) {
    size -= 0.5;
    width = totalWidth(size);
  }

  let x = slot.centerX - width / 2;
  const color = hexToRgb(slot.color);

  for (const run of runs) {
    page.drawText(run.text, { x, y: slot.baselineY, size, font, color });
    x += font.widthOfTextAtSize(run.text, size);
  }

  return { size, width };
}

/**
 * Generate a personalised certificate.
 *
 * @param {object} args
 * @param {Uint8Array|Buffer} args.templateBytes  original certificate PDF
 * @param {Uint8Array|Buffer} args.regularFontBytes  Hebrew-capable TTF
 * @param {Uint8Array|Buffer} [args.boldFontBytes]   optional heavier weight
 * @param {string} args.name       participant name, logical order
 * @param {string} args.idNumber   participant ID
 * @param {object} [args.env]      env used for layout overrides
 * @returns {Promise<Uint8Array>} the generated PDF
 */
export async function generateCertificate({
  templateBytes,
  regularFontBytes,
  boldFontBytes,
  name,
  idNumber,
  env = process.env,
}) {
  const pdf = await PDFDocument.load(templateBytes);
  pdf.registerFontkit(fontkit);

  // subset: true keeps the embedded font to only the glyphs actually used,
  // which keeps the generated file close to the original's size.
  const regular = await pdf.embedFont(regularFontBytes, { subset: true });
  const bold = boldFontBytes
    ? await pdf.embedFont(boldFontBytes, { subset: true })
    : regular;

  const layout = getLayout(env);
  const pages = pdf.getPages();

  const namePage = pages[layout.name.page];
  const idPage = pages[layout.id.page];
  if (!namePage || !idPage) {
    throw new Error('Certificate template is missing the expected page');
  }

  drawCentered(namePage, name, layout.name.bold ? bold : regular, layout.name);

  // The ID is digits only, so it stays left-to-right; formatting pads it back
  // to the canonical 9 digits without ever treating it as a number.
  drawCentered(idPage, formatIdForDisplay(idNumber), regular, layout.id);

  // Defence in depth: the certificate carries personal data, so make sure the
  // generated file cannot be indexed or trivially harvested if it is ever
  // re-shared. (Metadata only — not a substitute for access control.)
  pdf.setTitle('תעודת סיום - ניתוח גוף פתוח');
  pdf.setProducer('maayanbashan.co.il');
  pdf.setCreator('maayanbashan.co.il');

  return pdf.save();
}

// Rough Hebrew -> Latin map, used only to build a readable ASCII filename.
// It does not need to be a faithful transliteration; it needs to be stable and
// to keep different participants' files distinguishable.
const HEBREW_TRANSLITERATION = {
  א: 'a', ב: 'b', ג: 'g', ד: 'd', ה: 'h', ו: 'v', ז: 'z', ח: 'ch',
  ט: 't', י: 'y', כ: 'k', ך: 'k', ל: 'l', מ: 'm', ם: 'm', נ: 'n',
  ן: 'n', ס: 's', ע: 'a', פ: 'p', ף: 'f', צ: 'ts', ץ: 'ts', ק: 'k',
  ר: 'r', ש: 'sh', ת: 't',
};

/**
 * ASCII-safe download filename. Hebrew filenames break in several
 * WhatsApp/Android download paths, so the name is transliterated.
 * The ID number is deliberately never part of the filename.
 */
export function buildFilename(name) {
  const slug = Array.from(String(name ?? ''))
    .map((char) => HEBREW_TRANSLITERATION[char] ?? char)
    .join('')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40)
    .replace(/-+$/g, '');

  return slug ? `certificate-${slug}.pdf` : 'certificate.pdf';
}
