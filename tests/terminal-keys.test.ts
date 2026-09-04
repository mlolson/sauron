import { describe, expect, it } from 'vitest'
import { overrideKeySequence, type KeyEventLike } from '../src/shared/terminal-keys'

const event = (over: Partial<KeyEventLike> = {}): KeyEventLike =>
  ({ type: 'keydown', key: 'Enter', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over })

describe('overrideKeySequence', () => {
  it('sends ESC+CR for Shift+Enter so agents and shells insert a newline', () => {
    expect(overrideKeySequence(event({ shiftKey: true }))).toBe('\x1b\r')
  })

  it('leaves plain Enter alone, so it still submits', () => {
    expect(overrideKeySequence(event())).toBeNull()
  })

  it('leaves Shift+Enter with another modifier to xterm', () => {
    expect(overrideKeySequence(event({ shiftKey: true, ctrlKey: true }))).toBeNull()
    expect(overrideKeySequence(event({ shiftKey: true, altKey: true }))).toBeNull()
    expect(overrideKeySequence(event({ shiftKey: true, metaKey: true }))).toBeNull()
  })

  it('ignores other keys and non-keydown events', () => {
    expect(overrideKeySequence(event({ key: 'a', shiftKey: true }))).toBeNull()
    expect(overrideKeySequence(event({ type: 'keyup', shiftKey: true }))).toBeNull()
    expect(overrideKeySequence(event({ type: 'keypress', shiftKey: true }))).toBeNull()
  })
})
