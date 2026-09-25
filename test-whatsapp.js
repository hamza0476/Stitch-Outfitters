/**
 * test-whatsapp.js — Stitch Outfitters WhatsApp Tests
 *
 * Tests for:
 * - International phone normalization (PK, US, UK, UAE, DE, FR, SA, etc.)
 * - toChatId conversion
 * - Edge cases (invalid numbers, empty input, etc.)
 *
 * Run: node test-whatsapp.js
 *
 * NOTE: better-sqlite3 is compiled for Electron's Node.js version (NODE_MODULE_VERSION 130),
 * not the system Node.js (127). Message queue tests that require SQLite are run separately
 * inside the Electron app. This file tests the pure functions only.
 */

'use strict'

// ── Pure function extraction ────────────────────────────────────────────
// These are copied directly from src/main/whatsapp.js to test without
// requiring Electron or native modules.

const COUNTRY_DIAL_CODES = {
  AF: '93', AL: '355', DZ: '213', AD: '376', AO: '244', AG: '1268',
  AR: '54', AM: '374', AU: '61', AT: '43', AZ: '994', BS: '1242',
  BH: '973', BD: '880', BB: '1246', BY: '375', BE: '32', BZ: '501',
  BJ: '229', BT: '975', BO: '591', BA: '387', BW: '267', BR: '55',
  BN: '673', BG: '359', BF: '226', BI: '257', CV: '238', KH: '855',
  CM: '237', CA: '1', CF: '236', TD: '235', CL: '56', CN: '86',
  CO: '57', KM: '269', CG: '242', CD: '243', CR: '506', CI: '225',
  HR: '385', CU: '53', CY: '357', CZ: '420', DK: '45', DJ: '253',
  DM: '1767', DO: '1809', EC: '593', EG: '20', SV: '503', GQ: '240',
  ER: '291', EE: '372', SZ: '268', ET: '251', FJ: '679', FI: '358',
  FR: '33', GA: '241', GM: '220', GE: '995', DE: '49', GH: '233',
  GR: '30', GD: '1473', GT: '502', GN: '224', GW: '245', GY: '592',
  HT: '509', HN: '504', HU: '36', IS: '354', IN: '91', ID: '62',
  IR: '98', IQ: '964', IE: '353', IL: '972', IT: '39', JM: '1876',
  JP: '81', JO: '962', KZ: '7', KE: '254', KI: '686', KP: '850',
  KR: '82', XK: '383', KW: '965', KG: '996', LA: '856', LV: '371',
  LB: '961', LS: '266', LR: '231', LY: '218', LI: '423', LT: '370',
  LU: '352', MG: '261', MW: '265', MY: '60', MV: '960', ML: '223',
  MT: '356', MH: '692', MR: '222', MU: '230', MX: '52', FM: '691',
  MD: '373', MC: '377', MN: '976', ME: '382', MA: '212', MZ: '258',
  MM: '95', NA: '264', NR: '674', NP: '977', NL: '31', NZ: '64',
  NI: '505', NE: '227', NG: '234', MK: '389', NO: '47', OM: '968',
  PK: '92', PW: '680', PS: '970', PA: '507', PG: '675', PY: '595',
  PE: '51', PH: '63', PL: '48', PT: '351', QA: '974', RO: '40',
  RU: '7', RW: '250', KN: '1869', LC: '1758', VC: '1784', WS: '685',
  SM: '378', ST: '239', SA: '966', SN: '221', RS: '381', SC: '248',
  SL: '232', SG: '65', SK: '421', SI: '386', SB: '677', SO: '252',
  ZA: '27', SS: '211', ES: '34', LK: '94', SD: '249', SR: '597',
  SE: '46', CH: '41', SY: '963', TW: '886', TJ: '992', TZ: '255',
  TH: '66', TL: '670', TG: '228', TO: '767', TT: '1868', TN: '216',
  TR: '90', TM: '993', TV: '688', UG: '256', UA: '380', AE: '971',
  GB: '44', US: '1', UY: '598', UZ: '998', VU: '678', VA: '39',
  VE: '58', VN: '84', YE: '967', ZM: '260', ZW: '263'
}

function normalizeWhatsAppNumber (rawPhone, countryCode) {
  if (!rawPhone || typeof rawPhone !== 'string') {
    return { normalized: '', valid: false, error: 'No phone number provided' }
  }
  let cleaned = rawPhone.trim()
  const hadPlus = cleaned.startsWith('+')
  cleaned = cleaned.replace(/[^\d+]/g, '')
  if (cleaned.startsWith('+')) cleaned = cleaned.slice(1)
  cleaned = cleaned.replace(/\D/g, '')
  if (!cleaned) {
    return { normalized: '', valid: false, error: 'Phone number contains no digits' }
  }
  let dialCode = null
  if (countryCode) {
    if (COUNTRY_DIAL_CODES[countryCode]) dialCode = COUNTRY_DIAL_CODES[countryCode]
    else if (/^\d{1,4}$/.test(countryCode)) dialCode = countryCode
  }
  let normalized = cleaned
  if (hadPlus || (dialCode && cleaned.startsWith(dialCode))) {
    normalized = cleaned
  } else if (cleaned.startsWith('0')) {
    if (dialCode) {
      normalized = dialCode + cleaned.slice(1)
    } else {
      return { normalized: '', valid: false, error: 'Phone starts with 0 but no country is set. Please select a country for this client.' }
    }
  } else {
    if (dialCode) {
      if (cleaned.startsWith(dialCode) && cleaned.length > dialCode.length + 4) {
        normalized = cleaned
      } else {
        normalized = dialCode + cleaned
      }
    } else {
      if (cleaned.length >= 10) {
        normalized = cleaned
      } else {
        return { normalized: '', valid: false, error: 'Phone number too short and no country is set. Please select a country for this client.' }
      }
    }
  }
  if (normalized.length < 7 || normalized.length > 15) {
    return { normalized: '', valid: false, error: `Phone has ${normalized.length} digits — expected 7-15 for a valid international number` }
  }
  if (normalized.startsWith('0')) {
    return { normalized: '', valid: false, error: 'Phone still has a leading 0 — enter the full international number' }
  }
  return { normalized, valid: true }
}

function toChatId (normalizedPhone) {
  const digits = (normalizedPhone || '').replace(/\D/g, '')
  if (!digits || digits.length < 7) return null
  return `${digits}@c.us`
}

// ── Test Framework ──────────────────────────────────────────────────────

let passed = 0
let failed = 0
let total = 0

function test (name, fn) {
  total++
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    Error: ${e.message}`)
  }
}

function assert (condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed')
}

function assertEq (actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ── Tests ───────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log('  WHATSAPP PHONE NORMALIZATION TESTS')
console.log('='.repeat(60))

console.log('\n── Pakistan (+92) ──')
test('PK: +923001234567', () => {
  const r = normalizeWhatsAppNumber('+923001234567', 'PK')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567')
})
test('PK: 03001234567 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('03001234567', 'PK')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567')
})
test('PK: 3001234567 (local without 0)', () => {
  const r = normalizeWhatsAppNumber('3001234567', 'PK')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567')
})
test('PK: +92 300 1234567 (with spaces)', () => {
  const r = normalizeWhatsAppNumber('+92 300 1234567', 'PK')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567')
})
test('PK: 923001234567 (already has 92 prefix)', () => {
  const r = normalizeWhatsAppNumber('923001234567', 'PK')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567')
})

console.log('\n── United States (+1) ──')
test('US: +12025550123', () => {
  const r = normalizeWhatsAppNumber('+12025550123', 'US')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})
test('US: 2025550123 (local)', () => {
  const r = normalizeWhatsAppNumber('2025550123', 'US')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})
test('US: +1 202 555 0123 (with spaces)', () => {
  const r = normalizeWhatsAppNumber('+1 202 555 0123', 'US')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})
test('US: (202) 555-0123 (with formatting)', () => {
  const r = normalizeWhatsAppNumber('(202) 555-0123', 'US')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})

console.log('\n── United Kingdom (+44) ──')
test('UK: +447700900123', () => {
  const r = normalizeWhatsAppNumber('+447700900123', 'GB')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '447700900123')
})
test('UK: 07700900123 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('07700900123', 'GB')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '447700900123')
})
test('UK: 7700900123 (local without 0)', () => {
  const r = normalizeWhatsAppNumber('7700900123', 'GB')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '447700900123')
})

console.log('\n── UAE (+971) ──')
test('UAE: +971501234567', () => {
  const r = normalizeWhatsAppNumber('+971501234567', 'AE')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '971501234567')
})
test('UAE: 0501234567 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('0501234567', 'AE')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '971501234567')
})
test('UAE: 501234567 (local without 0)', () => {
  const r = normalizeWhatsAppNumber('501234567', 'AE')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '971501234567')
})

console.log('\n── Germany (+49) ──')
test('DE: +491701234567', () => {
  const r = normalizeWhatsAppNumber('+491701234567', 'DE')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '491701234567')
})
test('DE: 01701234567 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('01701234567', 'DE')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '491701234567')
})

console.log('\n── France (+33) ──')
test('FR: +33612345678', () => {
  const r = normalizeWhatsAppNumber('+33612345678', 'FR')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '33612345678')
})
test('FR: 0612345678 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('0612345678', 'FR')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '33612345678')
})

console.log('\n── Saudi Arabia (+966) ──')
test('SA: +966501234567', () => {
  const r = normalizeWhatsAppNumber('+966501234567', 'SA')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '966501234567')
})
test('SA: 0501234567 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('0501234567', 'SA')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '966501234567')
})

console.log('\n── India (+91) ──')
test('IN: +919876543210', () => {
  const r = normalizeWhatsAppNumber('+919876543210', 'IN')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '919876543210')
})
test('IN: 09876543210 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('09876543210', 'IN')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '919876543210')
})

console.log('\n── Japan (+81) ──')
test('JP: +819012345678', () => {
  const r = normalizeWhatsAppNumber('+819012345678', 'JP')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '819012345678')
})
test('JP: 09012345678 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('09012345678', 'JP')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '819012345678')
})

console.log('\n── Australia (+61) ──')
test('AU: +61412345678', () => {
  const r = normalizeWhatsAppNumber('+61412345678', 'AU')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '61412345678')
})
test('AU: 0412345678 (local with 0)', () => {
  const r = normalizeWhatsAppNumber('0412345678', 'AU')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '61412345678')
})

console.log('\n── Canada (+1) ──')
test('CA: +14165551234', () => {
  const r = normalizeWhatsAppNumber('+14165551234', 'CA')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '14165551234')
})

console.log('\n── Brazil (+55) ──')
test('BR: +5511987654321', () => {
  const r = normalizeWhatsAppNumber('+5511987654321', 'BR')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '5511987654321')
})

console.log('\n── No country context ──')
test('No country: +12025550123 (has + prefix, trusted)', () => {
  const r = normalizeWhatsAppNumber('+12025550123')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})
test('No country: 12025550123 (long number, assumed international)', () => {
  const r = normalizeWhatsAppNumber('12025550123')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})
test('No country: 03001234567 (starts with 0, no context → error)', () => {
  const r = normalizeWhatsAppNumber('03001234567')
  assert(!r.valid, 'should be invalid')
  assert(r.error.includes('country'), 'should mention country')
})
test('No country: 12345 (too short → error)', () => {
  const r = normalizeWhatsAppNumber('12345')
  assert(!r.valid, 'should be invalid')
  assert(r.error.includes('short'), 'should mention short')
})

console.log('\n── Invalid/malformed numbers ──')
test('Empty string', () => {
  const r = normalizeWhatsAppNumber('')
  assert(!r.valid, 'should be invalid')
})
test('null', () => {
  const r = normalizeWhatsAppNumber(null)
  assert(!r.valid, 'should be invalid')
})
test('undefined', () => {
  const r = normalizeWhatsAppNumber(undefined)
  assert(!r.valid, 'should be invalid')
})
test('Only spaces', () => {
  const r = normalizeWhatsAppNumber('   ')
  assert(!r.valid, 'should be invalid')
})
test('Only letters', () => {
  const r = normalizeWhatsAppNumber('abcdef')
  assert(!r.valid, 'should be invalid')
})
test('Too many digits (16+)', () => {
  const r = normalizeWhatsAppNumber('1234567890123456', 'US')
  assert(!r.valid, 'should be invalid')
  assert(r.error.includes('16'), 'should mention digit count')
})
test('Too few digits (5)', () => {
  const r = normalizeWhatsAppNumber('12345', 'US')
  assert(!r.valid, 'should be invalid')
})

console.log('\n── Edge cases ──')
test('Dial code as countryCode argument', () => {
  const r = normalizeWhatsAppNumber('3001234567', '92')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567')
})
test('Country with + prefix', () => {
  const r = normalizeWhatsAppNumber('+447700900123', 'GB')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '447700900123')
})
test('Double prefix protection: 923001234567 with PK', () => {
  const r = normalizeWhatsAppNumber('923001234567', 'PK')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567') // not 92923001234567
})
test('Whitespace trimming', () => {
  const r = normalizeWhatsAppNumber('  +92 300 1234567  ', 'PK')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '923001234567')
})
test('Hyphens removed', () => {
  const r = normalizeWhatsAppNumber('+1-202-555-0123', 'US')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})
test('Parentheses removed', () => {
  const r = normalizeWhatsAppNumber('+1 (202) 555-0123', 'US')
  assert(r.valid, 'should be valid')
  assertEq(r.normalized, '12025550123')
})

// ── toChatId Tests ──────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log('  TO CHAT ID TESTS')
console.log('='.repeat(60))

test('toChatId: 923001234567 → 923001234567@c.us', () => {
  assertEq(toChatId('923001234567'), '923001234567@c.us')
})
test('toChatId: 12025550123 → 12025550123@c.us', () => {
  assertEq(toChatId('12025550123'), '12025550123@c.us')
})
test('toChatId: 447700900123 → 447700900123@c.us', () => {
  assertEq(toChatId('447700900123'), '447700900123@c.us')
})
test('toChatId: 971501234567 → 971501234567@c.us', () => {
  assertEq(toChatId('971501234567'), '971501234567@c.us')
})
test('toChatId: 491701234567 → 491701234567@c.us', () => {
  assertEq(toChatId('491701234567'), '491701234567@c.us')
})
test('toChatId: 33612345678 → 33612345678@c.us', () => {
  assertEq(toChatId('33612345678'), '33612345678@c.us')
})
test('toChatId: 966501234567 → 966501234567@c.us', () => {
  assertEq(toChatId('966501234567'), '966501234567@c.us')
})
test('toChatId: too short → null', () => {
  assertEq(toChatId('12345'), null)
})
test('toChatId: empty → null', () => {
  assertEq(toChatId(''), null)
})
test('toChatId: null → null', () => {
  assertEq(toChatId(null), null)
})
test('toChatId: strips non-digits', () => {
  assertEq(toChatId('+92 300 1234567'), '923001234567@c.us')
})
test('toChatId: exactly 7 digits → valid', () => {
  assertEq(toChatId('1234567'), '1234567@c.us')
})
test('toChatId: 6 digits → null', () => {
  assertEq(toChatId('123456'), null)
})

// ── State Machine Constants Tests ───────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log('  STATE MACHINE CONSTANTS TESTS')
console.log('='.repeat(60))

const WA_STATE = {
  DISCONNECTED: 'DISCONNECTED', INITIALIZING: 'INITIALIZING', QR_REQUIRED: 'QR_REQUIRED',
  AUTHENTICATING: 'AUTHENTICATING', CONNECTING: 'CONNECTING', CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING', SESSION_EXPIRED: 'SESSION_EXPIRED', ERROR: 'ERROR'
}

test('9 connection states defined', () => {
  assertEq(Object.keys(WA_STATE).length, 9)
})
test('All state values are unique strings', () => {
  const values = Object.values(WA_STATE)
  const unique = new Set(values)
  assertEq(unique.size, 9, 'all 9 values should be unique')
})
test('CONNECTED state is "CONNECTED"', () => {
  assertEq(WA_STATE.CONNECTED, 'CONNECTED')
})
test('DISCONNECTED state is "DISCONNECTED"', () => {
  assertEq(WA_STATE.DISCONNECTED, 'DISCONNECTED')
})

const MQ_STATUS = {
  PENDING: 'PENDING', SENDING: 'SENDING', SENT: 'SENT',
  FAILED: 'FAILED', RETRYING: 'RETRYING'
}

test('5 queue statuses defined', () => {
  assertEq(Object.keys(MQ_STATUS).length, 5)
})
test('All queue status values are unique strings', () => {
  const values = Object.values(MQ_STATUS)
  const unique = new Set(values)
  assertEq(unique.size, 5, 'all 5 values should be unique')
})

// ── Country Dial Codes Tests ────────────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log('  COUNTRY DIAL CODES TESTS')
console.log('='.repeat(60))

test('Pakistan dial code is 92', () => {
  assertEq(COUNTRY_DIAL_CODES.PK, '92')
})
test('US dial code is 1', () => {
  assertEq(COUNTRY_DIAL_CODES.US, '1')
})
test('UK dial code is 44', () => {
  assertEq(COUNTRY_DIAL_CODES.GB, '44')
})
test('UAE dial code is 971', () => {
  assertEq(COUNTRY_DIAL_CODES.AE, '971')
})
test('Germany dial code is 49', () => {
  assertEq(COUNTRY_DIAL_CODES.DE, '49')
})
test('France dial code is 33', () => {
  assertEq(COUNTRY_DIAL_CODES.FR, '33')
})
test('Saudi Arabia dial code is 966', () => {
  assertEq(COUNTRY_DIAL_CODES.SA, '966')
})
test('India dial code is 91', () => {
  assertEq(COUNTRY_DIAL_CODES.IN, '91')
})
test('190+ countries defined', () => {
  assert(Object.keys(COUNTRY_DIAL_CODES).length >= 190, `Expected >=190, got ${Object.keys(COUNTRY_DIAL_CODES).length}`)
})

// ── Summary ─────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(60))
console.log(`  RESULTS: ${passed}/${total} passed, ${failed} failed`)
console.log('='.repeat(60))

if (failed > 0) {
  process.exit(1)
} else {
  console.log('\nAll tests passed!')
  process.exit(0)
}
