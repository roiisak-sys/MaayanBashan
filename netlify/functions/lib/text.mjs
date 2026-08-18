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
 * Order-insensitive key for a person's name.
 *
 * People routinely enter "ידידים תמר" when the CRM holds "תמר ידידים", and
 * either is a legitimate way to write their own name. Sorting the tokens makes
 * both forms compare equal.
 *
 * This is safe here because the name is never the sole factor — the phone
 * number must match the same record too — and an ambiguous match (more than
 * one participant resolving to the same key) is still refused rather than
 * guessed.
 */
export function nameSortKey(value) {
  return normalizeName(value).split(' ').filter(Boolean).sort().join(' ');
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
 * Split text into directional runs, ordered left-to-right for drawing.
 *
 * Each run's text stays in LOGICAL order. This matters: pdf-lib hands text to
 * fontkit, and fontkit reverses a string by itself when it detects an RTL
 * script — but it does so for the whole string at once, without proper bidi
 * segmentation. So a pure-Hebrew run comes out right, while embedded Latin or
 * multi-digit numbers come out backwards ("Cohen" -> "nehoC", "25" -> "52").
 *
 * Drawing run-by-run sidesteps that: every run is single-direction, so
 * fontkit's own handling is correct for each one, and we control the order the
 * runs are placed in. Pre-reversing the characters here would fight fontkit
 * and produce doubly-reversed, unreadable text.
 *
 * @returns {{dir: 'rtl'|'ltr', text: string}[]} runs in visual (drawing) order
 */
export function splitDirectionalRuns(text) {
  const input = String(text ?? '');
  if (!input) return [];

  // Paragraph direction: RTL only if it actually contains RTL characters.
  const rtlParagraph = RTL_CHAR.test(input);
  if (!rtlParagraph) return [{ dir: 'ltr', text: input }];

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

  // RTL paragraph: the first logical run belongs at the RIGHT, so the drawing
  // order (left to right) is the reverse of the logical run order. Each run's
  // characters are left untouched — fontkit reverses RTL runs itself.
  return runs.reverse();
}
