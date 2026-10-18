import { describe, expect, it } from 'vitest'
import { dripQuota, fillParams, greetingName, inWindow, localDayStart, tagExcluded, type DripConfig } from './broadcast-drip'

const ist = (iso: string) => new Date(`${iso}+05:30`)
const cfg: DripConfig = {
  per_tick: 1,
  every_minutes: 2,
  window: { timezone: 'Asia/Kolkata', start: '10:00', end: '19:00' },
  daily_cap: 250,
  templates: { en: { name: 'inv', language: 'en_US' }, hi: { name: 'inv_hi', language: 'hi' } },
  params: ['{first_name}'],
  audience: {},
}

describe('drip pacing', () => {
  it('sends only inside 10:00–19:00 IST', () => {
    expect(inWindow(ist('2026-10-19T09:59:00'), cfg)).toBe(false)
    expect(inWindow(ist('2026-10-19T10:00:00'), cfg)).toBe(true)
    expect(inWindow(ist('2026-10-19T18:59:00'), cfg)).toBe(true)
    expect(inWindow(ist('2026-10-19T19:00:00'), cfg)).toBe(false)
  })
  it('one message every 2 minutes', () => {
    const now = ist('2026-10-19T11:00:00')
    expect(dripQuota(now, cfg, 10, null)).toBe(1)
    expect(dripQuota(now, cfg, 10, new Date(now.getTime() - 60000))).toBe(0)
    expect(dripQuota(now, cfg, 10, new Date(now.getTime() - 118000))).toBe(1)
  })
  it('stops at the daily cap', () => {
    expect(dripQuota(ist('2026-10-19T15:00:00'), cfg, 250, null)).toBe(0)
    expect(dripQuota(ist('2026-10-19T15:00:00'), { ...cfg, per_tick: 5 }, 248, null)).toBe(2)
  })
  it('the local day starts at midnight IST', () => {
    expect(localDayStart(ist('2026-10-19T15:42:17'), 'Asia/Kolkata').toISOString()).toBe(ist('2026-10-19T00:00:00').toISOString())
  })
})

describe('drip audience + params', () => {
  it('excludes by tag, with Lost:* as a prefix', () => {
    expect(tagExcluded(['Lost: Price'], ['Lost:*'])).toBe(true)
    expect(tagExcluded(['not interested'], ['Not Interested'])).toBe(true)
    expect(tagExcluded(['Contacted'], ['Lost:*', 'Not Interested'])).toBe(false)
  })
  it('greets by first name, or politely when the name is unusable', () => {
    expect(greetingName('amit dhiman', 'en')).toBe('Amit')
    expect(greetingName('😊😊', 'en')).toBe('there')
    expect(greetingName('', 'hi')).toBe('जी')
    expect(fillParams(['{first_name}', 'https://x.y'], 'Ravi K', 'en')).toEqual(['Ravi', 'https://x.y'])
  })
})
