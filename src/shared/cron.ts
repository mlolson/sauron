/**
 * Five-field cron: minute hour day-of-month month day-of-week. Supports `*`, values, lists,
 * ranges, steps (every fifth minute, or every tenth within a range), and month and weekday
 * names. Standard semantics apply: when both day-of-month and day-of-week are restricted,
 * either matching is enough.
 */

export interface CronSpec {
  minute: Set<number>
  hour: Set<number>
  dayOfMonth: Set<number>
  month: Set<number>
  dayOfWeek: Set<number>
  /** Whether the day fields were `*`, which changes how they combine. */
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error(`Cron expression needs five fields, got ${fields.length}: "${expression}"`)
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string]
  return {
    minute: parseField(minute, 0, 59, []),
    hour: parseField(hour, 0, 23, []),
    dayOfMonth: parseField(dom, 1, 31, []),
    month: parseField(month, 1, 12, MONTHS),
    // 7 is Sunday too, as in most crons.
    dayOfWeek: new Set([...parseField(dow, 0, 7, DAYS)].map((d) => (d === 7 ? 0 : d))),
    anyDayOfMonth: dom === '*',
    anyDayOfWeek: dow === '*',
  }
}

function parseField(field: string, min: number, max: number, names: string[]): Set<number> {
  const out = new Set<number>()
  for (const part of field.split(',')) {
    const [rangeText, stepText] = part.split('/')
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in cron field "${field}"`)
    let lo: number
    let hi: number
    if (rangeText === '*' || rangeText === '') {
      lo = min
      hi = max
    } else if (rangeText!.includes('-')) {
      const [a, b] = rangeText!.split('-')
      lo = value(a!, min, max, names)
      hi = value(b!, min, max, names)
      if (lo > hi) throw new Error(`Reversed range in cron field "${field}"`)
    } else {
      lo = value(rangeText!, min, max, names)
      // A bare value with a step means "from here to the end".
      hi = stepText === undefined ? lo : max
    }
    for (let v = lo; v <= hi; v += step) out.add(v)
  }
  return out
}

function value(text: string, min: number, max: number, names: string[]): number {
  const named = names.indexOf(text.toLowerCase())
  const n = named >= 0 ? named + (names === MONTHS ? 1 : 0) : Number(text)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`"${text}" is out of range ${min}-${max} in a cron field`)
  return n
}

/** Whether a minute (local time) matches the spec. */
export function cronMatches(spec: CronSpec, at: Date): boolean {
  if (!spec.minute.has(at.getMinutes()) || !spec.hour.has(at.getHours()) || !spec.month.has(at.getMonth() + 1)) return false
  const domOk = spec.dayOfMonth.has(at.getDate())
  const dowOk = spec.dayOfWeek.has(at.getDay())
  if (spec.anyDayOfMonth && spec.anyDayOfWeek) return true
  if (spec.anyDayOfMonth) return dowOk
  if (spec.anyDayOfWeek) return domOk
  return domOk || dowOk
}

/**
 * The most recent minute at or before `now` that the schedule names, looking back at most
 * `lookbackMinutes`; null when there is none in that window. Walking minute by minute is
 * plenty fast for a bounded window and avoids the classic off-by-one traps of computing
 * next-fire times.
 */
export function previousFireTime(spec: CronSpec, now: Date, lookbackMinutes: number): Date | null {
  const at = new Date(now)
  at.setSeconds(0, 0)
  for (let i = 0; i <= lookbackMinutes; i++) {
    if (cronMatches(spec, at)) return at
    at.setMinutes(at.getMinutes() - 1)
  }
  return null
}
