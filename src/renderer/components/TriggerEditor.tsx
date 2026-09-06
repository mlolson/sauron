import { useState } from 'react'
import type { IntervalUnit, JobTrigger } from '@shared/types'

/**
 * Edits when a background agent runs. Each kind keeps its own draft while another is
 * selected, so switching to look at cron and back does not lose an interval.
 */
export function TriggerEditor({ value, onChange }: { value: JobTrigger; onChange: (trigger: JobTrigger) => void }) {
  const [every, setEvery] = useState(value.kind === 'interval' ? value.every : 1)
  const [unit, setUnit] = useState<IntervalUnit>(value.kind === 'interval' ? value.unit : 'days')
  const [schedule, setSchedule] = useState(value.kind === 'cron' ? value.schedule : '0 3 * * *')
  const [cooldown, setCooldown] = useState(value.kind === 'commit' ? value.cooldownMinutes : 30)

  const compose = (kind: JobTrigger['kind'], draft: { every?: number; unit?: IntervalUnit; schedule?: string; cooldown?: number } = {}): JobTrigger => {
    switch (kind) {
      case 'manual':
        return { kind }
      case 'interval':
        return { kind, every: Math.max(1, Math.floor(draft.every ?? every)), unit: draft.unit ?? unit }
      case 'cron':
        return { kind, schedule: (draft.schedule ?? schedule).trim() }
      case 'commit':
        return { kind, cooldownMinutes: Math.max(0, draft.cooldown ?? cooldown) }
    }
  }

  return (
    <>
      <label className="pref-row">
        <span>Trigger</span>
        <select value={value.kind} onChange={(e) => onChange(compose(e.target.value as JobTrigger['kind']))}>
          <option value="manual">Manual only</option>
          <option value="interval">Every N minutes, hours or days</option>
          <option value="commit">After commits</option>
          <option value="cron">Cron expression</option>
        </select>
      </label>
      {value.kind === 'interval' && (
        <label className="pref-row">
          <span>Every</span>
          <span className="interval-fields">
            <input className="text" type="number" min={1} step={1} value={every} onChange={(e) => { const n = Number(e.target.value); setEvery(n); onChange(compose('interval', { every: n })) }} />
            <select value={unit} onChange={(e) => { const u = e.target.value as IntervalUnit; setUnit(u); onChange(compose('interval', { unit: u })) }}>
              <option value="minutes">minutes</option>
              <option value="hours">hours</option>
              <option value="days">days</option>
            </select>
          </span>
        </label>
      )}
      {value.kind === 'interval' && <p className="muted small">Counted from when the last run began. Runs the first time as soon as it is attached, then keeps the spacing, also while the app is closed.</p>}
      {value.kind === 'cron' && <label className="pref-row"><span>Schedule</span><input className="text" value={schedule} onChange={(e) => { setSchedule(e.target.value); onChange(compose('cron', { schedule: e.target.value })) }} placeholder="0 3 * * *" /></label>}
      {value.kind === 'cron' && <p className="muted small">Five fields, local time: minute, hour, day of month, month, day of week. For example <code>0 3 * * 1-5</code> is 03:00 on weekdays.</p>}
      {value.kind === 'commit' && <label className="pref-row"><span>Cooldown (minutes)</span><input className="text" type="number" min={0} value={cooldown} onChange={(e) => { const n = Number(e.target.value); setCooldown(n); onChange(compose('commit', { cooldown: n })) }} /></label>}
      {value.kind === 'commit' && <p className="muted small">Runs after a commit on the project's main checkout, at most once per cooldown. Commits made by a background run do not count.</p>}
    </>
  )
}
