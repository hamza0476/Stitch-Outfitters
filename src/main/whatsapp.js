'use strict'

/**
 * whatsapp.js — Stitch Outfitters WhatsApp Manager
 *
 * Session persistence architecture:
 * - LocalAuth stores session data in userData/wa-session/
 * - Client.destroy() stops Puppeteer WITHOUT touching session data
 * - Client.logout() INVALIDATES the session (only used on explicit logout or auth failure)
 * - Normal disconnect, reconnect, timeout, and app restart preserve the session
 * - QR is only shown when there is genuinely no valid session
 */

const { app } = require('electron')
const path = require('path')
const fs = require('fs')
const os = require('os')
const qrcode = require('qrcode-terminal')
const QRCode = require('qrcode')
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js')

// ── Connection States ───────────────────────────────────────────────────

const WA_STATE = {
  DISCONNECTED: 'DISCONNECTED',
  INITIALIZING: 'INITIALIZING',
  QR_REQUIRED: 'QR_REQUIRED',
  AUTHENTICATING: 'AUTHENTICATING',
  CONNECTING: 'CONNECTING',
  CONNECTED: 'CONNECTED',
  DISCONNECTING: 'DISCONNECTING',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  ERROR: 'ERROR'
}

// ── Message Queue Statuses ──────────────────────────────────────────────

const MQ_STATUS = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING'
}

// ── Timeouts (ms) ──────────────────────────────────────────────────────

const INIT_TIMEOUT = 20000
const SEND_TIMEOUT = 18000          // user-facing budget (soft recover kicks in after)
const HEALTH_TIMEOUT = 3000
const HEALTH_SKIP_MS = 10000        // skip getState if last healthy < 10s ago
const PAGE_BUSY_MS = 15000          // after a timed-out send, hold the page this long
const MAX_INIT_RETRIES = 3
const RETRY_DELAYS_MS = [1500, 3000, 6000]

// ── Browser Discovery (Enhanced — 20+ paths, cross-platform, cached) ─────

const _browserCache = { path: null, checked: false }

function _exists (p) {
  try { return fs.existsSync(p) } catch (_) { return false }
}

function _isValidBrowser (p) {
  if (!_exists(p)) return false
  try {
    const stat = fs.statSync(p)
    // Must be > 1MB to be a real browser (not a stub or shortcut)
    return stat.isFile() && stat.size > 1024 * 1024
  } catch (_) { return false }
}

function _findInPath (executables) {
  const pathDirs = (process.env.PATH || '').split(path.delimiter)
  for (const dir of pathDirs) {
    for (const exe of executables) {
      const full = path.join(dir, exe)
      if (_isValidBrowser(full)) return full
    }
  }
  return null
}

function findChromeExecutable () {
  const home = os.homedir()
  const platform = process.platform

  const candidates = []

  if (platform === 'win32') {
    candidates.push(
      // Chrome — user profile
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      // Chrome — Program Files
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      // Chrome Beta
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome Beta', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe',
      // Chrome Dev
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome Dev', 'Application', 'chrome.exe'),
      // Chrome Canary
      path.join(home, 'AppData', 'Local', 'Google', 'Chrome SxS', 'Application', 'chrome.exe'),
      // Edge — Program Files
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      // Edge Beta
      'C:\\Program Files (x86)\\Microsoft\\Edge Beta\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge Beta\\Application\\msedge.exe',
      // Edge Dev
      'C:\\Program Files (x86)\\Microsoft\\Edge Dev\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge Dev\\Application\\msedge.exe',
      // Edge — user profile
      path.join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      // Brave Browser
      path.join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      'C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      'C:\\Program Files (x86)\\BraveSoftware\\Brave-Browser\\Application\\brave.exe',
      // Chromium
      path.join(home, 'AppData', 'Local', 'Chromium', 'Application', 'chrome.exe'),
      'C:\\Program Files\\Chromium\\Application\\chrome.exe',
      // Opera
      path.join(home, 'AppData', 'Local', 'Programs', 'Opera', 'opera.exe'),
      'C:\\Program Files\\Opera\\opera.exe'
    )
  } else if (platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Opera.app/Contents/MacOS/Opera',
      path.join(home, 'Applications', 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome')
    )
  } else {
    // Linux
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-stable',
      '/opt/google/chrome/chrome',
      '/opt/microsoft/msedge/msedge'
    )
  }

  for (const p of candidates) {
    if (_isValidBrowser(p)) return p
  }

  // PATH-based detection as final fallback
  if (platform === 'win32') {
    const pathBrowser = _findInPath(['chrome.exe', 'msedge.exe', 'brave.exe', 'chromium.exe'])
    if (pathBrowser) return pathBrowser
    // Use 'where' command as last resort
    try {
      const { execSync } = require('child_process')
      for (const exe of ['chrome', 'msedge', 'brave', 'chromium']) {
        try {
          const result = execSync(`where ${exe}`, { encoding: 'utf8', timeout: 3000 }).trim()
          const first = result.split(/\r?\n/)[0]
          if (first && _isValidBrowser(first)) return first
        } catch (_) {}
      }
    } catch (_) {}
  } else {
    const pathBrowser = _findInPath(['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'brave-browser', 'microsoft-edge'])
    if (pathBrowser) return pathBrowser
    // Try 'which' command
    try {
      const { execSync } = require('child_process')
      for (const exe of ['google-chrome', 'chromium', 'brave-browser', 'microsoft-edge']) {
        try {
          const result = execSync(`which ${exe}`, { encoding: 'utf8', timeout: 3000 }).trim()
          if (result && _isValidBrowser(result)) return result
        } catch (_) {}
      }
    } catch (_) {}
  }

  return null
}

function bundledChromiumPath () {
  try {
    const p = path.join(process.resourcesPath, 'chromium', 'chrome.exe')
    return _isValidBrowser(p) ? p : null
  } catch (e) {
    return null
  }
}

/**
 * Find the best available browser, with caching.
 * Priority: bundled Chromium → system Chrome/Edge/Brave → PATH → Puppeteer default.
 */
function findBrowser () {
  if (_browserCache.checked) return _browserCache.path
  _browserCache.checked = true

  const forceSystem = process.env.SO_WA_USE_SYSTEM_CHROME === '1'
  let browserPath = null

  if (!forceSystem) browserPath = bundledChromiumPath()
  if (!browserPath) browserPath = findChromeExecutable()

  _browserCache.path = browserPath
  if (browserPath) log('Browser found:', browserPath)
  else warn('No browser found — Puppeteer will use its own bundled Chromium')

  return browserPath
}

/**
 * Get a browser for a specific retry attempt.
 * Attempt 0: cached path (bundled → system) — NEVER resets the cache
 *            (resetting caused up to 12s of sync PATH scans on every connect).
 * Attempt 1: force system Chrome (skip bundled)
 * Attempt 2: null (let Puppeteer use its own)
 */
function getBrowserForAttempt (attempt) {
  if (attempt === 0) {
    // Use the pre-cached value if available; only scan if never scanned
    if (_browserCache.checked) return _browserCache.path
    return findBrowser()
  }
  if (attempt === 1) {
    return findChromeExecutable()
  }
  return null
}

// ── Internal State ──────────────────────────────────────────────────────

const state = {
  client: null,
  clientGen: 0,              // generation token — events from old clients are ignored
  status: WA_STATE.DISCONNECTED,
  winRef: null,
  db: null,
  qrDataUrl: null,
  initTimer: null,
  connectionPromise: null,
  reconnectLock: Promise.resolve(), // serializes destroy+connect outside connectionPromise
  sendLock: Promise.resolve(),      // FIFO mutex: invoice send + queue never overlap
  inflightSend: null,               // real evaluate promise still running after timeout
  pageBusyUntil: 0,                 // Date.now() gate after a timed-out send
  lastHealthyAt: 0,                 // last successful getState / send
  eventListenersAttached: false,
  queueRunning: false,
  sessionPath: null,
  webCachePath: null,
  retryAttempt: 0,
  lastInitError: null,
  readyPromise: null,
  readyResolver: null
}

// ── Helpers ─────────────────────────────────────────────────────────────

function setWinRef (win) { state.winRef = win }
function setDatabase (db) {
  state.db = db
  resetStuckSendingRows()
}

function send (channel, payload) {
  if (state.winRef && !state.winRef.isDestroyed()) {
    try { state.winRef.webContents.send(channel, payload) } catch (_) {}
  }
}

function setStatus (newStatus, extra) {
  state.status = newStatus
  send('WA_STATUS', { status: newStatus, ready: newStatus === WA_STATE.CONNECTED, ...extra })
}

function clearInitTimer () {
  if (state.initTimer) { clearTimeout(state.initTimer); state.initTimer = null }
}

function withTimeout (promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) }
    )
  })
}

/**
 * Run fn exclusively — invoice sends and processQueue share this FIFO chain
 * so two pupPage.evaluate sends never interleave on a busy WhatsApp Web page.
 */
function withSendLock (fn) {
  const next = state.sendLock.then(fn, fn)
  state.sendLock = next.then(() => {}, () => {})
  return next
}

/** Mark page healthy (health skip window + clear busy after success). */
function markHealthy () {
  state.lastHealthyAt = Date.now()
  state.pageBusyUntil = 0
  state.inflightSend = null
}

/**
 * Soft page recovery — cheap ping first; light reload if evaluate is dead.
 * Full reconnect() only when this returns false.
 */
async function softRecoverPage () {
  if (!state.client || state.status !== WA_STATE.CONNECTED) return false
  // 1) ping
  try {
    await withTimeout(state.client.getState(), 2500, 'ping timeout')
    markHealthy()
    return true
  } catch (e) {
    const fatal = /target closed|session closed|Execution context|Protocol error/i.test(e.message)
    if (!fatal) {
      // busy but alive — treat as recoverable without reload
      markHealthy()
      return true
    }
    warn('softRecover: ping fatal:', e.message)
  }
  // 2) light reload of the WA Web page
  try {
    const page = state.client.pupPage
    if (page && !page.isClosed()) {
      log('softRecover: reloading WhatsApp Web page…')
      await withTimeout(page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 }), 10000, 'reload timeout')
      await new Promise(r => setTimeout(r, 2500))
      await withTimeout(state.client.getState(), 4000, 'post-reload ping')
      markHealthy()
      log('softRecover: page reload OK')
      return true
    }
  } catch (e) {
    warn('softRecover: reload failed:', e.message)
  }
  return false
}

/** Recover page for the next send: soft first, full reconnect only if needed. */
async function recoverForSend () {
  if (await softRecoverPage()) return true
  warn('recoverForSend: soft recover failed — full reconnect')
  await reconnect()
  return !!(state.client && state.status === WA_STATE.CONNECTED)
}

function log (...args) { console.log('[SO][WA]', ...args) }
function warn (...args) { console.warn('[SO][WA]', ...args) }
function error (...args) { console.error('[SO][WA]', ...args) }

// ── Session Path ────────────────────────────────────────────────────────

function resolveSessionPaths () {
  if (!state.sessionPath) {
    state.sessionPath = path.join(app.getPath('userData'), 'wa-session')
    state.webCachePath = path.join(app.getPath('userData'), 'wa-webcache')
  }
  return { sessionPath: state.sessionPath, webCachePath: state.webCachePath }
}

function sessionExists () {
  const { sessionPath } = resolveSessionPaths()
  try {
    return fs.existsSync(sessionPath) && fs.readdirSync(sessionPath).length > 0
  } catch (_) {
    return false
  }
}

// Junk that slows Chromium startup massively. Auth lives in
// session/session/Default/{IndexedDB,Local Storage,Network} — those are KEPT.
const _PROFILE_PRUNE_DIRS = [
  'Cache', 'Code Cache', 'GPUCache', 'GPUPersistentCache',
  'ShaderCache', 'GrShaderCache', 'Service Worker', 'Crashpad',
  'component_crx_cache', 'extensions_crx_cache', 'optimization_guide_model_store',
  'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
  'BrowserMetrics-spare.pma'
]
const _PROFILE_PRUNE_FILES = ['DevToolsActivePort', 'SingletonLock', 'SingletonCookie', 'SingletonSocket', 'Last Browser', 'Last Session']

/**
 * Delete Chromium cache/lock junk before launch so profile load is fast
 * and orphan locks from an unclean quit cannot brick initialization.
 * Keeps auth data (IndexedDB/Cookies/Local Storage) untouched.
 */
function pruneSessionProfile () {
  const { sessionPath } = resolveSessionPaths()
  const profileDir = path.join(sessionPath, 'session')
  if (!_exists(profileDir)) return
  for (const name of _PROFILE_PRUNE_DIRS) {
    try { fs.rmSync(path.join(profileDir, name), { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(path.join(profileDir, 'Default', name), { recursive: true, force: true }) } catch (_) {}
  }
  for (const name of _PROFILE_PRUNE_FILES) {
    try { fs.rmSync(path.join(profileDir, name), { force: true }) } catch (_) {}
    try { fs.rmSync(path.join(profileDir, 'Default', name), { force: true }) } catch (_) {}
  }
}

// ── Phone Normalization ─────────────────────────────────────────────────

const COUNTRY_DIAL_CODES = {
  AF: '93', AL: '355', DZ: '213', AD: '376', AO: '244', AG: '1268',
  AR: '54', AM: '374', AU: '61', AT: '43', AZ: '994', BS: '1268',
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

// Reverse map: dialCode -> countryCode (for auto-detection)
const DIAL_CODE_TO_COUNTRY = {}
for (const [country, code] of Object.entries(COUNTRY_DIAL_CODES)) {
  if (!DIAL_CODE_TO_COUNTRY[code]) DIAL_CODE_TO_COUNTRY[code] = country
}

// Known dial codes sorted by length (longest first) for prefix matching
const KNOWN_DIAL_CODES = Object.values(COUNTRY_DIAL_CODES)
  .filter((v, i, a) => a.indexOf(v) === i) // unique
  .sort((a, b) => b.length - a.length)

function detectCountryFromPhone (cleanedPhone) {
  if (cleanedPhone.startsWith('0')) return null
  
  for (const code of KNOWN_DIAL_CODES) {
    if (cleanedPhone.startsWith(code)) {
      // Skip 1-digit dial codes (US=1, Canada=1, Russia=7, Kazakhstan=7) 
      // as they're too ambiguous with local numbers
      if (code.length === 1) continue
      
      // For multi-digit codes, require sufficient length for international format
      if (cleanedPhone.length >= code.length + 8) {
        return DIAL_CODE_TO_COUNTRY[code] || null
      }
    }
  }
  return null
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

  // Auto-detect country from phone pattern ONLY if:
  // 1. No explicit country provided, AND
  // 2. Number has + prefix (user explicitly entered international format)
  // For local numbers without + prefix, require explicit country to avoid false positives
  let dialCode = null
  let detectedCountry = null
  let usedAutoDetect = false

  if (countryCode && countryCode !== '') {
    // Explicit country provided
    if (COUNTRY_DIAL_CODES[countryCode]) dialCode = COUNTRY_DIAL_CODES[countryCode]
    else if (/^\d{1,4}$/.test(countryCode)) dialCode = countryCode
    log('normalizeWhatsAppNumber: using explicit countryCode', countryCode, '-> dialCode', dialCode)
  } else if (hadPlus) {
    // Auto-detect ONLY for numbers with + prefix (explicit international format)
    detectedCountry = detectCountryFromPhone(cleaned)
    if (detectedCountry) {
      dialCode = COUNTRY_DIAL_CODES[detectedCountry]
      usedAutoDetect = true
      log('normalizeWhatsAppNumber: auto-detected country', detectedCountry, 'from + prefix -> dialCode', dialCode)
    } else {
      log('normalizeWhatsAppNumber: could not auto-detect country from + number', cleaned)
    }
  } else {
    log('normalizeWhatsAppNumber: no countryCode and no + prefix - requires explicit country or + format')
  }

  let normalized = cleaned
  if (hadPlus || (dialCode && cleaned.startsWith(dialCode))) {
    normalized = cleaned
  } else if (cleaned.startsWith('0')) {
    if (dialCode) normalized = dialCode + cleaned.slice(1)
    else return { normalized: '', valid: false, error: 'Phone starts with 0 but no country could be determined. Please ensure country is set or use international format (+CC...).' }
  } else {
    if (dialCode) {
      if (cleaned.startsWith(dialCode) && cleaned.length > dialCode.length + 4) normalized = cleaned
      else normalized = dialCode + cleaned
    } else {
      if (cleaned.length >= 10) normalized = cleaned
      else return { normalized: '', valid: false, error: 'Phone number too short and no country could be determined. Use international format (+CC...).' }
    }
  }
  if (normalized.length < 7 || normalized.length > 15) {
    return { normalized: '', valid: false, error: `Phone has ${normalized.length} digits — expected 7-15 for a valid international number` }
  }
  if (normalized.startsWith('0')) {
    return { normalized: '', valid: false, error: 'Phone still has a leading 0 — enter the full international number' }
  }

  log('normalizeWhatsAppNumber result:', { rawPhone, countryCode, dialCode, detectedCountry, usedAutoDetect, normalized, valid: true })
  return { normalized, valid: true, detectedCountry, usedAutoDetect }
}

function toChatId (normalizedPhone) {
  const digits = (normalizedPhone || '').replace(/\D/g, '')
  if (!digits || digits.length < 7) {
    log('toChatId: invalid normalizedPhone', normalizedPhone, '-> digits:', digits)
    return null
  }
  const chatId = `${digits}@c.us`
  // Validate chatId format matches WhatsApp Web expectations
  if (!/^\d{7,15}@c\.us$/.test(chatId)) {
    log('toChatId: generated chatId does not match expected format', chatId)
    return null
  }
  log('toChatId: generated', chatId)
  return chatId
}

// ── Client Lifecycle ────────────────────────────────────────────────────

/**
 * Stops the WhatsApp client WITHOUT logging out.
 * The LocalAuth session data on disk is PRESERVED.
 * This is used for: normal disconnect, reconnect, timeout, init failure.
 */
async function destroyClient () {
  clearInitTimer()
  state.clientGen++           // invalidate all event handlers from the old client
  const c = state.client
  state.client = null
  state.eventListenersAttached = false
  state.readyPromise = null
  state.readyResolver = null
  if (c) {
    try { c.removeAllListeners && c.removeAllListeners() } catch (_) {}
    try { await c.destroy().catch(() => {}) } catch (_) {}
  }
}

/**
 * Logs out AND destroys the WhatsApp client.
 * This INVALIDATES the LocalAuth session — the user will need to scan QR again.
 * Only used for: explicit user logout, genuine authentication failure.
 */
async function logoutClient () {
  clearInitTimer()
  state.clientGen++
  const c = state.client
  state.client = null
  state.eventListenersAttached = false
  state.readyPromise = null
  state.readyResolver = null
  if (c) {
    try { c.removeAllListeners && c.removeAllListeners() } catch (_) {}
    try { await c.logout().catch(() => {}) } catch (_) {}
    try { await c.destroy().catch(() => {}) } catch (_) {}
  }
}

/**
 * Attaches event listeners to a WhatsApp client.
 * Only attaches once per client instance.
 */
function attachEventListeners (client) {
  if (state.eventListenersAttached) return
  state.eventListenersAttached = true
  // Capture the generation this listener belongs to — if a new client is
  // installed (gen bumped), all events from this old client are ignored.
  const myGen = state.clientGen
  const stale = () => state.clientGen !== myGen

  client.on('qr', async (qr) => {
    if (stale()) return
    if (state.status !== WA_STATE.AUTHENTICATING && state.status !== WA_STATE.CONNECTED) {
      setStatus(WA_STATE.QR_REQUIRED)
    }
    log('QR received — scan with WhatsApp > Linked Devices > Link a Device')
    qrcode.generate(qr, { small: true })
    try {
      const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 })
      state.qrDataUrl = dataUrl
      send('WA_QR', dataUrl)
    } catch (e) {
      error('Failed to render QR image:', e.message)
    }
  })

  client.on('loading_screen', (percent, message) => {
    if (stale()) return
    log(`Loading: ${percent}% - ${message}`)
    if (state.status !== WA_STATE.CONNECTED && state.status !== WA_STATE.QR_REQUIRED) {
      setStatus(WA_STATE.CONNECTING, { percent })
    }
  })

  client.on('authenticated', () => {
    if (stale()) return
    log('Authenticated')
    setStatus(WA_STATE.AUTHENTICATING)
  })

  client.on('auth_failure', (msg) => {
    if (stale()) return
    error('Auth failure:', msg)
    clearInitTimer()
    setStatus(WA_STATE.SESSION_EXPIRED, { reason: 'auth_failure', detail: msg })
    // Genuine auth failure — invalidate the session so next connect shows QR.
    // Only touch THIS client (never state.client — could be a newer one).
    const failedClient = client
    if (state.client === client) {
      state.clientGen++
      state.client = null
      state.eventListenersAttached = false
    }
    try { failedClient.removeAllListeners && failedClient.removeAllListeners() } catch (_) {}
    try { failedClient.logout().catch(() => {}) } catch (_) {}
    try { failedClient.destroy().catch(() => {}) } catch (_) {}
  })

  client.on('ready', () => {
    if (stale()) return
    clearInitTimer()
    state.qrDataUrl = null
    setStatus(WA_STATE.CONNECTED)
    markHealthy() // first send after connect skips getState
    log('Client ready — session restored:', sessionExists() ? 'yes' : 'no')
    processQueue()

    if (state.readyResolver) {
      state.readyResolver()
      state.readyPromise = null
      state.readyResolver = null
    }
  })

  client.on('disconnected', async (reason) => {
    if (stale()) return
    warn('Disconnected:', reason)
    clearInitTimer()
    state.qrDataUrl = null

    // LOGOUT means the session is gone — next connect needs QR scan
    if (reason === 'LOGOUT') {
      setStatus(WA_STATE.SESSION_EXPIRED, { reason: 'LOGOUT' })
      return
    }

    setStatus(WA_STATE.DISCONNECTED, { reason })

    // Auto-reconnect: wwjs destroys the browser on bad socket state
    // (Client.js:853 this.destroy()), so there is NO internal reconnection
    // to wait for — go straight to destroy+reconnect. Max 2 attempts.
    if (reason !== 'NAVIGATION') {
      const myGen = state.clientGen
      for (let i = 0; i < 2; i++) {
        const delay = [2000, 5000][i]
        log(`Auto-reconnect: attempt ${i + 1}/2 in ${delay}ms...`)
        await new Promise(r => setTimeout(r, delay))
        // Abort if another path already connected, or a new client took over
        if (state.status === WA_STATE.CONNECTED || state.status === WA_STATE.INITIALIZING) return
        if (state.clientGen !== myGen) return
        try {
          if (state.client) {
            state.eventListenersAttached = false
            try { await state.client.destroy().catch(() => {}) } catch (_) {}
            if (state.client) state.client = null
          }
          const result = await connect()
          if (result.ok && state.status === WA_STATE.CONNECTED) { log('Auto-reconnect: succeeded on attempt', i + 1); return }
        } catch (e) {
          warn('Auto-reconnect attempt', i + 1, 'failed:', e.message)
        }
      }
      warn('Auto-reconnect failed after 2 attempts — manual reconnection required')
    }
  })
}

/**
 * Initialize and connect the WhatsApp client.
 * All calls share the same promise — no duplicate clients.
 *
 * If a valid LocalAuth session exists in userData/wa-session/,
 * the client will authenticate automatically without QR.
 *
 * Auto-recovery: retries up to MAX_INIT_RETRIES times with exponential
 * backoff and browser fallback (bundled → system → Puppeteer default).
 */
async function connect () {
  if (state.connectionPromise) return state.connectionPromise

  state.connectionPromise = (async () => {
    try {
      // Already connected — return immediately
      if (state.status === WA_STATE.CONNECTED && state.client) {
        return { ok: true, status: WA_STATE.CONNECTED }
      }
      // Already initializing — reuse in-progress attempt (ok reflects REAL state)
      if (state.client && state.status === WA_STATE.INITIALIZING) {
        return { ok: false, status: WA_STATE.INITIALIZING }
      }

      // For any other state (DISCONNECTED, CONNECTING, AUTHENTICATING, QR_REQUIRED, etc.),
      // clean up and create a fresh connection
      if (state.client) {
        log('Client exists but not connected (status:', state.status, ') — destroying and reconnecting')
        await destroyClient()
      }

      const { sessionPath, webCachePath } = resolveSessionPaths()
      const hasSession = sessionExists()

      log('Initializing — session path:', sessionPath, '| existing session:', hasSession ? 'YES' : 'NO')

      // Prune Chromium cache/lock junk BEFORE launch: dramatically faster
      // profile load (433MB → ~60MB) and prevents orphan-lock brick (GH #3976)
      try { pruneSessionProfile() } catch (_) {}

      setStatus(WA_STATE.INITIALIZING)

      // Auto-recovery loop: try up to MAX_INIT_RETRIES times with different browsers
      let lastError = null
      for (let attempt = 0; attempt < MAX_INIT_RETRIES; attempt++) {
        state.retryAttempt = attempt

        // Get browser for this attempt (bundled → system → Puppeteer default)
        const chromePath = getBrowserForAttempt(attempt)
        if (chromePath) log(`Attempt ${attempt + 1}/${MAX_INIT_RETRIES} — using:`, chromePath)
        else log(`Attempt ${attempt + 1}/${MAX_INIT_RETRIES} — using Puppeteer default Chromium`)

        try {
          state.client = new Client({
            authStrategy: new LocalAuth({ dataPath: sessionPath }),
            webVersionCache: { type: 'local', path: webCachePath },
            qrMaxRetries: 10,
            authTimeoutMs: 60000,
            puppeteer: {
              headless: true,
              pipe: true,   // stdio pipe instead of WebSocket — faster + more reliable CDP
              protocolTimeout: 90000, // CDP won't kill mid-upload; app SEND_TIMEOUT still governs UX
              ...(chromePath ? { executablePath: chromePath } : {}),
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-gpu',
                '--disable-dev-shm-usage',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-features=site-per-process,TranslateUI,Translate,BlinkGenPropertyTrees,IsolateOrigins',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--disable-sync',
                '--disable-translate',
                '--metrics-recording-only',
                '--no-first-run',
                '--renderer-process-limit=2',
                '--window-position=-10000,-10000',
                '--window-size=1280,720'
              ]
            }
          })

          attachEventListeners(state.client)

          // Init timeout — fires if we're still in INITIALIZING when it expires.
          // Also bumped clientGen so a late initialize() can't recover into stale state.
          state.initTimer = setTimeout(() => {
            if (state.status === WA_STATE.INITIALIZING) {
              error('Init timeout — WhatsApp Web did not respond')
              state.lastInitError = 'timeout'
              setStatus(WA_STATE.ERROR, { reason: 'timeout', detail: 'WhatsApp Web did not respond. Check your internet connection and that Chrome/Edge is installed, then try again.' })
              state.clientGen++
              const stuckClient = state.client
              state.client = null
              state.eventListenersAttached = false
              if (stuckClient) {
                try { stuckClient.removeAllListeners && stuckClient.removeAllListeners() } catch (_) {}
                try { stuckClient.destroy().catch(() => {}) } catch (_) {}
              }
            }
          }, INIT_TIMEOUT)

          // Create ready promise to wait for 'ready' event
          state.readyPromise = new Promise(resolve => { state.readyResolver = resolve })

          // Wrap initialize() in a timeout so a hung page.goto (timeout:0 in
          // wwjs) can never brick connectionPromise forever.
          await withTimeout(state.client.initialize(), INIT_TIMEOUT, 'initialize() timed out')

          // Wait for ready event (with timeout) - ensures WhatsApp Web is fully connected
          try {
            await Promise.race([
              state.readyPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Ready timeout')), 10000))
            ])
            log('Ready event received — WhatsApp fully connected')
          } catch (e) {
            warn('Ready event timeout, but initialize succeeded — proceeding:', e.message)
          } finally {
            state.readyPromise = null
            state.readyResolver = null
          }

          // Reset retry state
          state.retryAttempt = 0
          state.lastInitError = null
          clearInitTimer()
          // ok is TRUE only if we actually reached CONNECTED (QR scan still pending
          // or loading still in-flight must NOT report success to callers)
          const connected = state.status === WA_STATE.CONNECTED
          if (connected) setStatus(WA_STATE.CONNECTED) // ensure UI has fresh status
          return { ok: connected, status: state.status }

        } catch (e) {
          lastError = e
          state.lastInitError = e.message
          error(`Attempt ${attempt + 1} failed:`, e.message)
          clearInitTimer()

          // Clean up failed client — bump gen so its listeners go dead
          state.clientGen++
          const failedClient = state.client
          state.client = null
          state.eventListenersAttached = false
          if (failedClient) {
            try { failedClient.removeAllListeners && failedClient.removeAllListeners() } catch (_) {}
            try { failedClient.destroy().catch(() => {}) } catch (_) {}
          }

          // If this was not the last attempt, wait before retrying
          if (attempt < MAX_INIT_RETRIES - 1) {
            const delay = RETRY_DELAYS_MS[attempt] || 5000
            log(`Retrying in ${delay}ms...`)
            setStatus(WA_STATE.INITIALIZING, { retryAttempt: attempt + 1, maxRetries: MAX_INIT_RETRIES })
            await new Promise(r => setTimeout(r, delay))

            // Only show QR if we have a session — don't show stale QR between retries
            state.qrDataUrl = null
          }
        }
      }

      // All retries exhausted — report final error
      const errorMsg = lastError ? lastError.message : 'Unknown error'
      const isBrowserIssue = errorMsg.includes('Failed to launch') || errorMsg.includes('ENOENT') || errorMsg.includes('not found') || errorMsg.includes('Could not find')
      const friendlyDetail = isBrowserIssue
        ? `No browser could start. Please install Google Chrome or Microsoft Edge.\n\nDetail: ${errorMsg}`
        : `WhatsApp failed to initialize after ${MAX_INIT_RETRIES} attempts.\n\nDetail: ${errorMsg}`
      setStatus(WA_STATE.ERROR, { reason: 'init_failed', detail: friendlyDetail })
      state.retryAttempt = 0
      return { ok: false, status: WA_STATE.ERROR, error: errorMsg }

    } catch (e) {
      error('Connect error:', e.message)
      setStatus(WA_STATE.ERROR, { reason: 'error', detail: e.message })
      await destroyClient()
      return { ok: false, status: WA_STATE.ERROR, error: e.message }
    } finally {
      state.connectionPromise = null
    }
  })()

  return state.connectionPromise
}

/**
 * Disconnect gracefully — preserves the session.
 * The user can reconnect later without scanning QR.
 */
async function disconnect () {
  clearInitTimer()
  setStatus(WA_STATE.DISCONNECTING)
  await destroyClient()
  state.qrDataUrl = null
  setStatus(WA_STATE.DISCONNECTED)
}

/**
 * Reconnect — stops current client and reinitializes.
 * Serialized through a lock so two concurrent reconnect() calls
 * (e.g. health-check + auto-reconnect) cannot interleave destroy/create.
 */
function reconnect () {
  const run = async () => {
    clearInitTimer()
    await destroyClient()
    state.qrDataUrl = null
    return connect()
  }
  const next = state.reconnectLock.then(run, run)
  // Keep the chain alive even if this reconnect rejects
  state.reconnectLock = next.catch(() => {})
  return next
}

/**
 * Explicit logout — invalidates the session.
 * Next connect will require QR scan.
 */
async function logout () {
  clearInitTimer()
  setStatus(WA_STATE.DISCONNECTING)
  await logoutClient()
  state.qrDataUrl = null
  // Delete the session directory so LocalAuth starts fresh
  const { sessionPath } = resolveSessionPaths()
  try {
    if (fs.existsSync(sessionPath)) {
      fs.rmSync(sessionPath, { recursive: true, force: true })
      log('Session directory deleted:', sessionPath)
    }
  } catch (e) {
    warn('Could not delete session directory:', e.message)
  }
  setStatus(WA_STATE.DISCONNECTED)
}

function getStatus () {
  return {
    status: state.status,
    ready: state.status === WA_STATE.CONNECTED,
    qrAvailable: !!state.qrDataUrl,
    sessionExists: sessionExists(),
    retryAttempt: state.retryAttempt,
    maxRetries: MAX_INIT_RETRIES,
    lastError: state.lastInitError
  }
}

function getQR () {
  return state.qrDataUrl
}

// ── Sending ─────────────────────────────────────────────────────────────

// Per-chat retry tracking — a global boolean let concurrent sends stomp
// each other's retry state (send A consumes retry, send B unlocks it, etc.)
const sendRetryAttempted = new Map() // chatId -> true

function _retryKey (chatId, hasImage) {
  return (chatId || 'unknown') + (hasImage ? ':img' : ':txt')
}

async function sendMessage (payload) {
  // FIFO: invoice IPC + processQueue never interleave evaluates
  return withSendLock(() => sendMessageLocked(payload))
}

async function sendMessageLocked ({
  phone, countryCode, imageBase64, caption, mime, message,
  _skipHealth, _asDocument, _fromRetry
}) {
  // ── Wait out a timed-out predecessor (zombie evaluate still on page) ──
  if (state.inflightSend) {
    log('sendMessage: waiting for in-flight send to settle…')
    // Cap wait: hang zombies must not block forever — 20s then force-clear
    try { await withTimeout(state.inflightSend, 20000, 'inflight wait') } catch (_) {}
    if (state.inflightSend) state.inflightSend = null
  }
  if (state.pageBusyUntil > Date.now()) {
    const waitMs = state.pageBusyUntil - Date.now()
    log('sendMessage: page busy, waiting', waitMs, 'ms…')
    await new Promise(r => setTimeout(r, waitMs))
    state.pageBusyUntil = 0
  }

  // Auto-connect if not ready (for queue processing and direct calls)
  if (!state.client || state.status !== WA_STATE.CONNECTED) {
    log('sendMessage: not connected, attempting to connect...')
    await connect()
    if (!state.client || state.status !== WA_STATE.CONNECTED) {
      log('sendMessage: still not connected after connect()', { status: state.status, hasClient: !!state.client })
      return { ok: false, error: 'NOT_READY' }
    }
  }

  // Health check — skipped when: retry already verified, or last healthy < HEALTH_SKIP_MS ago
  const healthFresh = (Date.now() - state.lastHealthyAt) < HEALTH_SKIP_MS
  if (!_skipHealth && !healthFresh) {
    const DEAD_STATES = ['UNPAIRED', 'UNPAIRED_IDLE', 'DEPRECATED_VERSION', 'TOS_BLOCK', 'PROXYBLOCK', 'SMB_TOS_BLOCK', 'CONFLICT']
    let healthOk = false
    try {
      const waState = await withTimeout(state.client.getState(), HEALTH_TIMEOUT, 'Health check timeout')
      if (waState == null || !DEAD_STATES.includes(waState)) {
        healthOk = true
        markHealthy()
      } else {
        warn('sendMessage: health check dead state:', waState)
      }
    } catch (e) {
      const fatal = /target closed|session closed|Execution context|Protocol error/i.test(e.message)
      if (!fatal) {
        healthOk = true // busy page is not fatal
      } else {
        warn('sendMessage: health check fatal:', e.message)
      }
    }
    if (!healthOk) {
      warn('sendMessage: connection dead — soft recover before send')
      if (!(await recoverForSend())) {
        return { ok: false, error: 'NOT_READY' }
      }
    }
  } else if (_skipHealth || healthFresh) {
    // cheap trust path — still clear any stale busy from earlier success
    if (state.pageBusyUntil && state.pageBusyUntil <= Date.now()) state.pageBusyUntil = 0
  }

  log('sendMessage: sending to', { phone, countryCode, hasImage: !!imageBase64, hasMessage: !!message })

  const { normalized, valid, error: normError, detectedCountry, usedAutoDetect } = normalizeWhatsAppNumber(phone, countryCode)
  if (!valid) {
    log('sendMessage: invalid phone', { phone, countryCode, normError })
    return { ok: false, error: 'INVALID_PHONE', detail: normError }
  }

  const chatId = toChatId(normalized)
  if (!chatId) {
    log('sendMessage: invalid chatId', { normalized })
    return { ok: false, error: 'INVALID_PHONE', detail: 'Could not create valid WhatsApp chat ID' }
  }

  log('sendMessage: sending', { chatId, normalized, detectedCountry, usedAutoDetect, asDocument: !!_asDocument })
  const rKey = _retryKey(chatId, !!imageBase64)

  // Build the real evaluate promise — we keep a reference so a timeout
  // does NOT orphan it: inflightSend/pageBusyUntil gate the next send.
  let sendPromise
  try {
    if (imageBase64) {
      log('sendMessage: creating MessageMedia, base64 length:', imageBase64.length)
      const ext = (mime || 'image/jpeg').includes('png') ? 'png' : 'jpg'
      const media = new MessageMedia(mime || 'image/jpeg', imageBase64, `invoice.${ext}`)
      const opts = { caption: caption || '', sendSeen: false }
      if (_asDocument) opts.sendMediaAsDocument = true
      sendPromise = state.client.sendMessage(chatId, media, opts)
    } else if (message) {
      sendPromise = state.client.sendMessage(chatId, message, { sendSeen: false })
    } else {
      return { ok: false, error: 'NO_CONTENT' }
    }
  } catch (e) {
    // synchronous construction failure — no zombie
    return _classifySendError(e, { phone, countryCode, imageBase64, caption, mime, message, chatId, rKey, _fromRetry, _asDocument, sendPromise: null, timedOut: false })
  }

  // Track zombie: resolve/reject of the REAL promise clears inflight
  state.inflightSend = sendPromise
  sendPromise.then(
    () => {
      sendPromise.__waSettled = true
      if (state.inflightSend === sendPromise) markHealthy()
    },
    () => {
      sendPromise.__waSettled = true
      if (state.inflightSend === sendPromise) {
        state.inflightSend = null
        state.pageBusyUntil = Date.now() + PAGE_BUSY_MS
      }
    }
  )

  try {
    await withTimeout(sendPromise, SEND_TIMEOUT, 'Send timed out')
    log('sendMessage: sent successfully', { chatId })
    sendRetryAttempted.delete(rKey)
    markHealthy()
    return { ok: true }
  } catch (e) {
    // On timeout the evaluate keeps running — mark page busy so send #2/#3 wait
    const timedOut = (e.message || '').includes('Send timed out')
    if (timedOut) {
      state.pageBusyUntil = Date.now() + PAGE_BUSY_MS
      // leave inflightSend set — next call waits on it
    }
    return _classifySendError(e, { phone, countryCode, imageBase64, caption, mime, message, chatId, rKey, _fromRetry, _asDocument, sendPromise, timedOut })
  }
}

/**
 * Shared error handling for media/text sends.
 * Recovery ladder:
 *   internal wwjs error → soft recover → retry once (skip health)
 *   timeout/hang        → if zombie ok → success; if hung image → reload + document retry
 *   fatal page          → soft recover / reconnect → retry once
 */
function _isSettled (p) {
  if (!p) return true
  // Promise.race trick: if already settled, microtask runs before 0ms timer callback order isn't reliable —
  // use a flag attached in sendMessageLocked instead when available.
  return !!p.__waSettled
}

async function _classifySendError (e, ctx) {
  const { phone, countryCode, imageBase64, caption, mime, message, chatId, rKey, _fromRetry, _asDocument, sendPromise, timedOut } = ctx
  const msg = e.message || ''
  log('sendMessage: error caught', { chatId, error: msg })

  const isMemoizeError = msg.includes('Data passed to getter must include an id property') ||
                         msg.includes('memoize') ||
                         msg.includes('undefined s')
  const isWhatsAppInternalError = isMemoizeError ||
                                  msg.includes('Cannot read propert') ||
                                  msg.includes('Cannot read properties of undefined') ||
                                  msg.includes('getter must include') ||
                                  msg.includes('Store.getId')
  const isTimeout = !!timedOut || msg.includes('Send timed out')
  const isFatalPage = /target closed|session closed|Execution context|Protocol error/i.test(msg)

  if (msg.includes('not registered') || msg.includes('not on WhatsApp') || (msg.includes('invalid') && !isWhatsAppInternalError)) {
    sendRetryAttempted.delete(rKey)
    return { ok: false, error: 'NOT_ON_WHATSAPP' }
  }

  if (_fromRetry) {
    sendRetryAttempted.delete(rKey)
    if (isTimeout) return { ok: false, error: 'SEND_FAILED', detail: 'Send timed out — check your internet connection and try again' }
    error('sendMessage failed:', msg)
    return { ok: false, error: 'SEND_FAILED', detail: msg }
  }

  // ── Timeout: brief zombie wait; if IT succeeded, report success (no double-send) ──
  if (isTimeout) {
    warn('sendMessage: timed out — brief wait for in-flight evaluate…')
    let zombieOk = false
    let zombieStillRunning = false
    const inflight = sendPromise || state.inflightSend
    if (inflight) {
      // Hang case: zombie never settles — only wait 3s before declaring hung
      try {
        await withTimeout(inflight, 3000, 'zombie wait')
        zombieOk = true
      } catch (_) {
        zombieStillRunning = !_isSettled(inflight)
      }
    }
    if (state.inflightSend === sendPromise || state.inflightSend === inflight) state.inflightSend = null
    state.pageBusyUntil = 0

    if (zombieOk) {
      log('sendMessage: zombie send completed OK after timeout', { chatId })
      sendRetryAttempted.delete(rKey)
      markHealthy()
      return { ok: true }
    }

    // Hung zombie: force page reload (kills the stuck evaluate), then document fallback
    if (zombieStillRunning && imageBase64 && !_asDocument) {
      warn('sendMessage: zombie hung — force reload + document fallback')
      state.inflightSend = null // reload orphans it
      try {
        const page = state.client && state.client.pupPage
        if (page && !page.isClosed()) {
          await withTimeout(page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 }), 10000, 'reload timeout')
          await new Promise(r => setTimeout(r, 2500))
        }
      } catch (reloadErr) {
        warn('sendMessage: force reload failed:', reloadErr.message)
      }
      if (!(state.client && state.status === WA_STATE.CONNECTED) || !(await softRecoverPage())) {
        if (!(await recoverForSend())) {
          sendRetryAttempted.delete(rKey)
          return { ok: false, error: 'NOT_READY' }
        }
      }
      sendRetryAttempted.set(rKey, true)
      return sendMessageLocked({ phone, countryCode, imageBase64, caption, mime, message, _skipHealth: true, _asDocument: true, _fromRetry: true })
    }

    // Zombie still running (text or document path): leave busy gate for next send
    if (zombieStillRunning) {
      state.inflightSend = inflight
      state.pageBusyUntil = Date.now() + PAGE_BUSY_MS
      sendRetryAttempted.delete(rKey)
      return { ok: false, error: 'SEND_FAILED', detail: 'Send timed out — check your internet connection and try again' }
    }

    warn('sendMessage: zombie dead — soft recover, then document fallback')
    if (!(await recoverForSend())) {
      sendRetryAttempted.delete(rKey)
      return { ok: false, error: 'NOT_READY' }
    }
    if (imageBase64 && !_asDocument) {
      warn('sendMessage: retrying as document (image pipeline hang workaround)')
      sendRetryAttempted.set(rKey, true)
      return sendMessageLocked({ phone, countryCode, imageBase64, caption, mime, message, _skipHealth: true, _asDocument: true, _fromRetry: true })
    }
    sendRetryAttempted.delete(rKey)
    return { ok: false, error: 'SEND_FAILED', detail: 'Send timed out — check your internet connection and try again' }
  }

  // ── WhatsApp Web internal error — soft recover + one retry ──
  if (isWhatsAppInternalError && !sendRetryAttempted.get(rKey)) {
    warn('sendMessage: WhatsApp Web internal error, recovering and retrying:', msg)
    sendRetryAttempted.set(rKey, true)
    try {
      if (!(await recoverForSend())) {
        sendRetryAttempted.delete(rKey)
        return { ok: false, error: 'NOT_READY' }
      }
      log('sendMessage: recovered, retrying send...')
      return sendMessageLocked({ phone, countryCode, imageBase64, caption, mime, message, _skipHealth: true, _fromRetry: true })
    } catch (retryErr) {
      error('sendMessage: retry after recover failed:', retryErr.message)
    }
  }

  // ── Fatal page error (closed target etc.) — recover once ──
  if (isFatalPage && !sendRetryAttempted.get(rKey)) {
    warn('sendMessage: fatal page error, recovering and retrying:', msg)
    sendRetryAttempted.set(rKey, true)
    try {
      if (!(await recoverForSend())) {
        sendRetryAttempted.delete(rKey)
        return { ok: false, error: 'NOT_READY' }
      }
      return sendMessageLocked({ phone, countryCode, imageBase64, caption, mime, message, _skipHealth: true, _fromRetry: true })
    } catch (retryErr) {
      error('sendMessage: retry after fatal recover failed:', retryErr.message)
    }
  }

  sendRetryAttempted.delete(rKey)
  error('sendMessage failed:', msg)
  return { ok: false, error: 'SEND_FAILED', detail: msg }
}

async function sendInvoiceImage ({ phone, countryCode, imageBase64, caption, mime }) {
  if (!imageBase64) return { ok: false, error: 'NO_IMAGE' }
  // Connection handling lives solely in sendMessage() — no redundant gate here
  return sendMessage({ phone, countryCode, imageBase64, caption, mime })
}

// ── Message Queue ───────────────────────────────────────────────────────

function queueMessage ({ invoiceId, customerId, phone, countryCode, imageBase64, mime, caption, message }) {
  if (!state.db) return { ok: false, error: 'NO_DATABASE' }
  const { normalized, valid, error: normError } = normalizeWhatsAppNumber(phone, countryCode)
  if (!valid) return { ok: false, error: 'INVALID_PHONE', detail: normError }
  const now = new Date().toISOString()
  try {
    const result = state.db.prepare(`
      INSERT INTO wa_message_queue (invoice_id, customer_id, phone_original, phone_normalized, message, image_base64, mime, status, attempts, max_attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 3, ?)
    `).run(invoiceId || null, customerId || null, phone || '', normalized, message || '', imageBase64 || null, mime || 'image/jpeg', MQ_STATUS.PENDING, now)
    processQueue()
    return { ok: true, queueId: result.lastInsertRowid }
  } catch (e) {
    error('queueMessage failed:', e.message)
    return { ok: false, error: 'DB_ERROR', detail: e.message }
  }
}

function getQueueStatus () {
  if (!state.db) return { total: 0, pending: 0, sending: 0, sent: 0, failed: 0 }
  try {
    const rows = state.db.prepare('SELECT status, COUNT(*) as cnt FROM wa_message_queue GROUP BY status').all()
    const counts = { total: 0, pending: 0, sending: 0, sent: 0, failed: 0 }
    for (const r of rows) {
      counts.total += r.cnt
      const key = r.status.toLowerCase()
      if (key in counts) counts[key] = r.cnt
    }
    return counts
  } catch (_) {
    return { total: 0, pending: 0, sending: 0, sent: 0, failed: 0 }
  }
}

async function processQueue () {
  if (state.queueRunning) return
  if (state.status !== WA_STATE.CONNECTED || !state.client) return
  if (!state.db) return
  state.queueRunning = true
  try {
    let items
    try {
      items = state.db.prepare(`
        SELECT id, phone_original, phone_normalized, message, image_base64, mime, attempts, max_attempts, status
        FROM wa_message_queue WHERE status IN (?, ?) AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY created_at ASC LIMIT 5
      `).all(MQ_STATUS.PENDING, MQ_STATUS.RETRYING, new Date().toISOString())
    } catch (_) { state.queueRunning = false; return }
    if (!items || items.length === 0) { state.queueRunning = false; return }
    for (const item of items) {
      state.db.prepare('UPDATE wa_message_queue SET status = ? WHERE id = ?').run(MQ_STATUS.SENDING, item.id)
      const result = await sendMessage({ phone: item.phone_normalized, imageBase64: item.image_base64, mime: item.mime, caption: item.message })
      const now = new Date().toISOString()
      if (result.ok) {
        state.db.prepare('UPDATE wa_message_queue SET status = ?, attempts = attempts + 1, sent_at = ? WHERE id = ?').run(MQ_STATUS.SENT, now, item.id)
      } else {
        const newAttempts = item.attempts + 1
        const isPermanent = result.error === 'NOT_ON_WHATSAPP' || result.error === 'INVALID_PHONE'
        if (isPermanent || newAttempts >= item.max_attempts) {
          state.db.prepare('UPDATE wa_message_queue SET status = ?, attempts = ?, last_error = ? WHERE id = ?').run(MQ_STATUS.FAILED, newAttempts, result.detail || result.error, item.id)
        } else {
          const backoffMs = 30000 * Math.pow(3, newAttempts - 1)
          const nextRetry = new Date(Date.now() + backoffMs).toISOString()
          state.db.prepare('UPDATE wa_message_queue SET status = ?, attempts = ?, last_error = ?, next_retry_at = ? WHERE id = ?').run(MQ_STATUS.RETRYING, newAttempts, result.detail || result.error, nextRetry, item.id)
        }
      }
      send('WA_QUEUE_UPDATED', getQueueStatus())
    }
  } catch (e) {
    error('Queue error:', e.message)
  } finally {
    state.queueRunning = false
    if (items && items.length > 0) setTimeout(() => processQueue(), 2000)
  }
}

// ── IPC Handlers ────────────────────────────────────────────────────────

function registerHandlers (ipcMain) {
  ipcMain.handle('WA_INIT', async () => {
    const result = await connect()
    return result
  })
  ipcMain.handle('SEND_INVOICE_WHATSAPP', async (e, payload) => sendInvoiceImage(payload))
  ipcMain.handle('WA_GET_STATUS', async () => getStatus())
  ipcMain.handle('WA_RECONNECT', async () => {
    const result = await reconnect()
    // Return the REAL connect result — callers need ok=false when QR is
    // still pending or init failed (a hardcoded ok:true hid failures).
    return result && typeof result === 'object' ? result : { ok: false, status: state.status }
  })
  ipcMain.handle('WA_CONNECT', async () => connect())
  ipcMain.handle('WA_DISCONNECT', async () => { await disconnect(); return { ok: true } })
  ipcMain.handle('WA_LOGOUT', async () => { await logout(); return { ok: true } })
  ipcMain.handle('WA_GET_QR', async () => ({ qr: state.qrDataUrl }))
  ipcMain.handle('WA_SEND_MESSAGE', async (e, payload) => sendMessage(payload))
  ipcMain.handle('WA_QUEUE_MESSAGE', async (e, payload) => queueMessage(payload))
  ipcMain.handle('WA_GET_QUEUE_STATUS', async () => getQueueStatus())
}

// Pre-cache browser path at module load time so first connect() is faster
setTimeout(() => { try { findBrowser() } catch (_) {} }, 0)

// Reset rows stuck in SENDING from a previous unclean shutdown — processQueue
// only picks PENDING/RETRYING, so orphaned SENDING rows would never send again.
function resetStuckSendingRows () {
  if (!state.db) return
  try {
    const n = state.db.prepare(`UPDATE wa_message_queue SET status = ? WHERE status = ?`)
      .run(MQ_STATUS.RETRYING, MQ_STATUS.SENDING)
    if (n && n.changes > 0) log('Reset', n.changes, 'stuck SENDING queue row(s) → RETRYING')
  } catch (_) {}
}

module.exports = {
  WA_STATE, MQ_STATUS,
  normalizeWhatsAppNumber, toChatId,
  setWinRef, setDatabase, registerHandlers,
  getStatus, getQR,
  connect, disconnect, reconnect, logout,
  sendMessage, sendInvoiceImage,
  queueMessage, getQueueStatus, processQueue,
  initWhatsApp: connect,
  ensureReady: () => { if (!state.client && state.status !== WA_STATE.INITIALIZING) connect() }
}
