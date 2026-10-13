// Cycle copy is derived from a course's session dates, so opening a new cohort
// means changing the dates and nothing else — every label, heading, schema date
// and WhatsApp message follows from them.
//
// All reads use UTC getters. Frontmatter carries bare `YYYY-MM-DD`, which parses
// to midnight UTC; local getters would roll the day back for anyone building
// west of Greenwich and quietly print the wrong date.

const HE_MONTHS = [
  'ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני',
  'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר',
];

/** Session order in the CMS is whatever the editor typed; the site needs it chronological. */
export const sortSessions = (sessions: Date[] = []): Date[] =>
  [...sessions].sort((a, b) => a.valueOf() - b.valueOf());

/** "18.12" — the form used on the schedule tickets. */
export const shortDate = (d: Date): string => `${d.getUTCDate()}.${d.getUTCMonth() + 1}`;

/** "18.12.26" — the compact form used in the hero price tag. */
export const shortDateWithYear = (d: Date): string =>
  `${shortDate(d)}.${String(d.getUTCFullYear()).slice(-2)}`;

/** "2026-12-18" — schema.org expects a plain ISO date, not a timestamp. */
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * A human label for the cohort, widening only as far as the dates require:
 *   crosses a year  → "דצמבר 2026 – ינואר 2027"
 *   spans months    → "אוקטובר–נובמבר 2026"
 *   single month    → "דצמבר 2026"
 */
export function cycleLabel(sessions: Date[] = []): string {
  const sorted = sortSessions(sessions);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first) return '';

  const firstMonth = HE_MONTHS[first.getUTCMonth()];
  const firstYear = first.getUTCFullYear();
  const lastMonth = HE_MONTHS[last.getUTCMonth()];
  const lastYear = last.getUTCFullYear();

  if (firstYear !== lastYear) return `${firstMonth} ${firstYear} – ${lastMonth} ${lastYear}`;
  if (firstMonth !== lastMonth) return `${firstMonth}–${lastMonth} ${firstYear}`;
  return `${firstMonth} ${firstYear}`;
}
