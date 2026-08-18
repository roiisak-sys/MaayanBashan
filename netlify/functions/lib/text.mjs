// Text normalization and RTL handling shared by the certificate endpoint,
// the dev generator script and the test suite.

const RTL_CHAR = /[֐-׿؀-ۿ܀-ݏיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏ]/;
const DIGIT_CHAR = /[0-9]/;

/**
 * Normalize a person's name for comparison.
 *
 * Deliberately conservative: we only collapse whitespace and normalize Unicode
 * form. We do NOT strip punctuation or diacritics, because doing so on Hebrew
 * names risks collapsing genuinely different people onto the same key.
 *
 * Latin text is lowercased so "Yaffa Adler" matches "yaffa adler". Hebrew has
 * no case, so this is a no-op there.
 */
export function normalizeName(value) {
  return String(value ?? '')
    .normalize('NFKC')
    // Strip bidi control marks that can be pasted in invisibly from WhatsApp.
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    // Any run of whitespace (incl. non-breaking space) becomes a single space.
    .replace(/[\s ]+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Normalize an Israeli ID number.
 *
 * Always returns a STRING, never a number — leading zeros are significant and
 * "012345678" must not become 12345678.
 */
export function normalizeId(value) {
  return String(value ?? '')
    .normalize('NFKC')
    // Invisible bidi controls ride along with anything pasted out of WhatsApp
    // or an RTL document. The separator rule below does not remove them, and
    // they would otherwise make a perfectly valid ID fail every check.
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[^0-9]/g, '')
    .trim();
}

/**
 * Is this plausibly an identity number we can print on a certificate?
 *
 * Deliberately permissive. The ID does NOT authenticate anyone - the name and
 * phone do that - it is only rendered onto the certificate. Refusing a genuine
 * graduate because their number is unusual (foreign resident, passport used at
 * registration, an older format) is a much worse outcome than an odd-looking
 * value on a PDF.
 */
export function isPlausibleIdNumber(value) {
  return /^[0-9]{4,10}$/.test(normalizeId(value));
}

/**
 * Israeli ID check-digit (Luhn-like) validation.
 * IDs are 9 digits; shorter input is zero-padded on the left, which is the
 * standard interpretation.
 */
export function isValidIsraeliId(value) {
  const id = normalizeId(value);
  if (!/^\d{1,9}$/.test(id)) return false;
  const padded = id.padStart(9, '0');
  let sum = 0;
  for (let i = 0; i < 9; i += 1) {
    let digit = Number(padded[i]) * ((i % 2) + 1);
    if (digit > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * Canonicalize an Israeli phone number for comparison.
 *
 * The stored data is not consistently formatted — the live table contains
 * bare 10-digit numbers, hyphenated ones, `+972 …` international forms wrapped
 * in Unicode bidi isolates, and at least one entry with a stray Hebrew letter
 * in front. So everything is reduced to digits first and then folded to the
 * local `0XXXXXXXXX` form, which makes all of those variants compare equal:
 *
 *   '0509482733'      -> '0509482733'
 *   '050-9482733'     -> '0509482733'
 *   '+972 50-948-2733'-> '0509482733'
 *   '972509482733'    -> '0509482733'
 *
 * Returns '' when the value cannot be a phone number.
 */
export function normalizePhone(value) {
  let digits = String(value ?? '').replace(/\D+/g, '');
  if (!digits) return '';

  if (digits.startsWith('00972')) digits = `0${digits.slice(5)}`;
  else if (digits.startsWith('972')) digits = `0${digits.slice(3)}`;
  else if (!digits.startsWith('0')) digits = `0${digits}`;

  // Israeli numbers are 9 (landline) or 10 (mobile) digits in local form.
  if (digits.length < 9 || digits.length > 10) return '';
  return digits;
}

/** Format an ID for display on the certificate: always 9 digits. */
export function formatIdForDisplay(value) {
  const id = normalizeId(value);
  return /^\d{1,9}$/.test(id) ? id.padStart(9, '0') : id;
}

function classify(char) {
  if (RTL_CHAR.test(char)) return 'rtl';
  if (LTR_CHAR.test(char)) return 'ltr';
  if (DIGIT_CHAR.test(char)) return 'digit';
  return 'neutral';
}

/**
 * Convert logical-order text into visual order for PDF drawing.
 *
 * pdf-lib draws glyphs strictly left-to-right in the order given; it performs
 * no bidi reordering. Hebrew is not a cursive script, so no glyph shaping is
 * needed — but the character ORDER must be reversed, and naively reversing the
 * whole string corrupts embedded Latin words and digit groups
 * (e.g. a phone number or an English surname would come out backwards).
 *
 * This is a reduced Unicode Bidi Algorithm sufficient for single-line personal
 * names: it segments the string into directional runs, reverses the run order
 * when the paragraph is RTL, and reverses characters only inside RTL runs.
 * Digits and Latin stay in their natural left-to-right order.
 */
export function toVisualOrder(text) {
  const input = String(text ?? '');
  if (!input) return '';

  // Paragraph direction: RTL only if it actually contains RTL characters.
  if (!RTL_CHAR.test(input)) return input;

  const chars = Array.from(input);
  const classes = chars.map(classify);

  // Resolve neutrals: a neutral run takes the direction of its surrounding
  // runs when both sides agree, otherwise it falls back to the base (RTL).
  // Digits behave as LTR for ordering purposes.
  const resolved = classes.map((cls) => (cls === 'digit' ? 'ltr' : cls));
  for (let i = 0; i < resolved.length; i += 1) {
    if (resolved[i] !== 'neutral') continue;
    let before = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (resolved[j] !== 'neutral') { before = resolved[j]; break; }
    }
    let after = null;
    let end = i;
    while (end < resolved.length && resolved[end] === 'neutral') end += 1;
    if (end < resolved.length) after = resolved[end];
    const direction = before && after && before === after ? before : 'rtl';
    for (let k = i; k < end; k += 1) resolved[k] = direction;
    i = end - 1;
  }

  // Group into contiguous runs.
  const runs = [];
  for (let i = 0; i < chars.length; i += 1) {
    const dir = resolved[i];
    const last = runs[runs.length - 1];
    if (last && last.dir === dir) last.text += chars[i];
    else runs.push({ dir, text: chars[i] });
  }

  // Base is RTL: emit runs right-to-left, reversing glyphs inside RTL runs.
  return runs
    .reverse()
    .map((run) => (run.dir === 'rtl' ? Array.from(run.text).reverse().join('') : run.text))
    .join('');
}
