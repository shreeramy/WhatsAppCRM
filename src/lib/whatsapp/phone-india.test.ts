import { describe, expect, it } from 'vitest'
import {
  formatPhoneDisplay,
  parseInternationalPhone,
  withIndiaCountryCode,
} from './phone-utils'

describe('formatPhoneDisplay', () => {
  it('hides +91 and adds a space after five digits', () => {
    expect(formatPhoneDisplay('+919876543210')).toBe('98765 43210')
    expect(formatPhoneDisplay('919876543210')).toBe('98765 43210')
    expect(formatPhoneDisplay('+91 98765-43210')).toBe('98765 43210')
  })

  it('can return the number without the space (for copying)', () => {
    expect(formatPhoneDisplay('919876543210', { spaced: false })).toBe('9876543210')
  })

  it('leaves non-Indian numbers alone', () => {
    expect(formatPhoneDisplay('+14155551212')).toBe('+14155551212')
    expect(formatPhoneDisplay('37063949836')).toBe('37063949836')
  })

  it('handles empty values', () => {
    expect(formatPhoneDisplay('')).toBe('')
    expect(formatPhoneDisplay(null)).toBe('')
  })
})

describe('withIndiaCountryCode', () => {
  it('adds +91 to a bare 10-digit mobile, with or without spaces or a leading 0', () => {
    expect(withIndiaCountryCode('9876543210')).toBe('+919876543210')
    expect(withIndiaCountryCode('98765 43210')).toBe('+919876543210')
    expect(withIndiaCountryCode('09876543210')).toBe('+919876543210')
    expect(withIndiaCountryCode('919876543210')).toBe('+919876543210')
  })

  it('leaves numbers that already have a country code or are not Indian mobiles', () => {
    expect(withIndiaCountryCode('+14155551212')).toBe('+14155551212')
    expect(withIndiaCountryCode('+919876543210')).toBe('+919876543210')
    expect(withIndiaCountryCode('12345')).toBe('12345')
  })

  it('produces numbers the existing validator accepts', () => {
    expect(parseInternationalPhone(withIndiaCountryCode('98765 43210'))).toBe('919876543210')
  })
})
