// ─────────────────────────────────────────────────────────────────────────────
// OAC WEEK CALENDAR (church week numbering) — ported from f6145ff1 capture page.
// Week 1 = the 2nd Sunday of the month. The final week = the 1st Sunday of the
// NEXT month. weekKey format: YYYY-MM-Wn. Pure functions (property-tested).
// ─────────────────────────────────────────────────────────────────────────────

export interface OacWeek {
  weekKey: string; // e.g. "2024-03-W1"
  weekNum: number;
  date: Date; // the Sunday that opens this OAC week
  label: string; // e.g. "Mar 2024 - Week 1 [09 Mar]"
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Compute the OAC weeks for a given year/month.
 * Internally: collect every Sunday in the month, then append the 1st Sunday of the
 * next month. Week n opens on the (n+1)-th collected Sunday, so Week 1 opens on the
 * 2nd Sunday of the month and the final week opens on the 1st Sunday of next month.
 */
export function getOacWeeks(year: number, month: number): OacWeek[] {
  const sundays: Date[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    if (new Date(year, month - 1, d).getDay() === 0) sundays.push(new Date(year, month - 1, d));
  }
  // Append the 1st Sunday of the next month.
  const nm = month === 12 ? 1 : month + 1;
  const ny = month === 12 ? year + 1 : year;
  for (let d = 1; d <= 7; d++) {
    if (new Date(ny, nm - 1, d).getDay() === 0) {
      sundays.push(new Date(ny, nm - 1, d));
      break;
    }
  }

  const weeks: OacWeek[] = [];
  for (let i = 1; i < sundays.length; i++) {
    const dt = sundays[i];
    weeks.push({
      weekKey: `${year}-${String(month).padStart(2, "0")}-W${i}`,
      weekNum: i,
      date: dt,
      label: `${MONTHS[month - 1]} ${year} - Week ${i} [${String(dt.getDate()).padStart(2, "0")} ${MONTHS[dt.getMonth()]}]`,
    });
  }
  return weeks;
}

/** The current OAC week (the latest week whose opening Sunday is on/before `now`). */
export function getCurrentOacWeek(now: Date = new Date()): { year: number; month: number; weekKey: string } {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const weeks = getOacWeeks(year, month);
  let current = weeks[0];
  for (const w of weeks) {
    if (now >= w.date) current = w;
  }
  return {
    year,
    month,
    weekKey: current?.weekKey ?? `${year}-${String(month).padStart(2, "0")}-W1`,
  };
}
