/**
 * Dates as people write them in a Todo, read just well enough to check that a
 * date gate's quoted words name the date the walk cites. Not a general date
 * parser: it recognises the forms gates are written in and nothing more.
 *
 *   2026-11-01 · 1 November · 1st of November 2026 · 1 Nov · November 1 ·
 *   Nov 1st, 2026
 *
 * A numeric form like 01/11 is left out on purpose: whether it is the 1st of
 * November or the 11th of January is the writer's locale, and a gate the
 * gateway cannot read unambiguously is one it should not release on.
 */

export interface WrittenDate {
  year?: number;
  /** 1–12 */
  month: number;
  day: number;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
const DAY = "(\\d{1,2})(?:st|nd|rd|th)?";
const YEAR = "(?:,?\\s+(\\d{4}))?";

const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
const DAY_MONTH = new RegExp(`\\b${DAY}\\s+(?:of\\s+)?${MONTH}${YEAR}\\b`, "gi");
const MONTH_DAY = new RegExp(`\\b${MONTH}\\s+${DAY}${YEAR}\\b`, "gi");

function monthOf(name: string): number {
  return MONTHS.findIndex((month) => month.startsWith(name.toLowerCase().slice(0, 3))) + 1;
}

function valid(date: WrittenDate): boolean {
  return date.month >= 1 && date.month <= 12 && date.day >= 1 && date.day <= 31;
}

export function datesIn(text: string): WrittenDate[] {
  const found: WrittenDate[] = [];
  for (const match of text.matchAll(ISO)) found.push({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });
  for (const match of text.matchAll(DAY_MONTH)) {
    found.push({ day: Number(match[1]), month: monthOf(match[2]), ...(match[3] ? { year: Number(match[3]) } : {}) });
  }
  for (const match of text.matchAll(MONTH_DAY)) {
    found.push({ month: monthOf(match[1]), day: Number(match[2]), ...(match[3] ? { year: Number(match[3]) } : {}) });
  }
  return found.filter(valid);
}

/** Whether `text` names the calendar day `iso` (UTC), in any recognised form.
 *  A written date without a year matches on month and day. */
export function namesDate(text: string, iso: string): boolean {
  const at = new Date(Date.parse(iso));
  if (Number.isNaN(at.getTime())) return false;
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;
  const day = at.getUTCDate();
  return datesIn(text).some((date) => date.month === month && date.day === day && (date.year === undefined || date.year === year));
}
