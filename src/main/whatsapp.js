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

const INIT_TIMEOUT = 45000
const SEND_TIMEOUT = 30000
const MAX_INIT_RETRIES = 3
const RETRY_DELAYS_MS = [2000, 5000, 10000]

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
 * Attempt 0: cached path (bundled → system)
 * Attempt 1: force system Chrome (skip bundled)
 * Attempt 2: null (let Puppeteer use its own)
 */
function getBrowserForAttempt (attempt) {
  if (attempt === 0) {
    _browserCache.checked = false
    _browserCache.path = null
    return findBrowser()
  }
  if (attempt === 1) {
    // Skip bundled, try system browsers only
    return findChromeExecutable()
  }
  // Attempt 2: let Puppeteer decide (no executablePath)
  return null
}

// ── Internal State ──────────────────────────────────────────────────────

const state = {
  client: null,
  status: WA_STATE.DISCONNECTED,
  winRef: null,
  db: null,
  qrDataUrl: null,
  initTimer: null,
  connectionPromise: null,
  eventListenersAttached: false,
  queueRunning: false,
  sessionPath: null,
  webCachePath: null,
  retryAttempt: 0,
  lastInitError: null
}

// ── Helpers ─────────────────────────────────────────────────────────────

function setWinRef (win) { state.winRef = win }
function setDatabase (db) { state.db = db }

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

function log (...args) { console.log('[SO][WA]', ...args) }
function warn (...args) { console.warn('[SO][WA]', ...args) }
function error (...args) { console.error('[SO][WA]', ...args) }

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
  const c = state.client
  state.client = null
  state.eventListenersAttached = false
  if (c) {
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
  const c = state.client
  state.client = null
  state.eventListenersAttached = false
  if (c) {
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

  client.on('qr', async (qr) => {
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
    log(`Loading: ${percent}% - ${message}`)
    if (state.status !== WA_STATE.CONNECTED && state.status !== WA_STATE.QR_REQUIRED) {
      setStatus(WA_STATE.CONNECTING, { percent })
    }
  })

  client.on('authenticated', () => {
    log('Authenticated')
    setStatus(WA_STATE.AUTHENTICATING)
  })

  client.on('auth_failure', (msg) => {
    error('Auth failure:', msg)
    clearInitTimer()
    setStatus(WA_STATE.SESSION_EXPIRED, { reason: 'auth_failure', detail: msg })
    // Genuine auth failure — invalidate the session so next connect shows QR
    const failedClient = state.client
    state.client = null
    state.eventListenersAttached = false
    if (failedClient) {
      try { failedClient.logout().catch(() => {}) } catch (_) {}
      try { failedClient.destroy().catch(() => {}) } catch (_) {}
    }
  })

  client.on('ready', () => {
    clearInitTimer()
    state.qrDataUrl = null
    setStatus(WA_STATE.CONNECTED)
    log('Client ready — session restored:', sessionExists() ? 'yes' : 'no')
    processQueue()
  })

  client.on('disconnected', (reason) => {
    warn('Disconnected:', reason)
    clearInitTimer()
    state.qrDataUrl = null
    state.eventListenersAttached = false
    // DO NOT destroy the client or clear the session here.
    // Temporary disconnects (network, WhatsApp Web) should preserve the session.
    // whatsapp-web.js may attempt internal reconnection.
    setStatus(WA_STATE.DISCONNECTED, { reason })
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
      // Already initializing — reuse in-progress attempt
      if (state.client && state.status === WA_STATE.INITIALIZING) {
        return { ok: true, status: state.status }
      }

      // If we have an existing client that's actually CONNECTED, reuse it
      if (state.client && state.status === WA_STATE.CONNECTED) {
        log('Reusing existing connected client')
        return { ok: true, status: WA_STATE.CONNECTED }
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
            puppeteer: {
              headless: true,
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
                '--disable-features=site-per-process',
                '--disable-renderer-backgrounding',
                '--disable-ipc-flooding-protection',
                '--window-position=-10000,-10000',
                '--window-size=1280,720'
              ]
            }
          })

          attachEventListeners(state.client)

          // Init timeout — if neither QR nor ready fires, the launch is stuck.
          state.initTimer = setTimeout(() => {
            if (state.status === WA_STATE.INITIALIZING) {
              error('Init timeout — WhatsApp Web did not respond')
              state.lastInitError = 'timeout'
              setStatus(WA_STATE.ERROR, { reason: 'timeout', detail: 'WhatsApp Web did not respond. Check your internet connection and that Chrome/Edge is installed, then try again.' })
              const stuckClient = state.client
              state.client = null
              state.eventListenersAttached = false
              if (stuckClient) {
                try { stuckClient.destroy().catch(() => {}) } catch (_) {}
              }
            }
          }, INIT_TIMEOUT)

          // Start initialization — events update state asynchronously
          await state.client.initialize()

          // If we get here, initialization succeeded — reset retry state
          state.retryAttempt = 0
          state.lastInitError = null
          return { ok: true, status: state.status }

        } catch (e) {
          lastError = e
          state.lastInitError = e.message
          error(`Attempt ${attempt + 1} failed:`, e.message)
          clearInitTimer()

          // Clean up failed client
          const failedClient = state.client
          state.client = null
          state.eventListenersAttached = false
          if (failedClient) {
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
 * Preserves the session — does NOT log out.
 */
async function reconnect () {
  clearInitTimer()
  await destroyClient()
  state.qrDataUrl = null
  return connect()
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

// Track if we've already attempted a retry for the current send
let sendRetryAttempted = false

async function sendMessage ({ phone, countryCode, imageBase64, caption, mime, message }) {
  // Auto-connect if not ready (for queue processing and direct calls)
  if (!state.client || state.status !== WA_STATE.CONNECTED) {
    log('sendMessage: not connected, attempting to connect...')
    await connect()
    if (!state.client || state.status !== WA_STATE.CONNECTED) {
      log('sendMessage: still not connected after connect()', { status: state.status, hasClient: !!state.client })
      return { ok: false, error: 'NOT_READY' }
    }
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

  log('sendMessage: sending', { chatId, normalized, detectedCountry, usedAutoDetect })

  try {
    if (imageBase64) {
      log('sendMessage: creating MessageMedia, base64 length:', imageBase64.length)
      const ext = (mime || 'image/jpeg').includes('png') ? 'png' : 'jpg'
      const media = new MessageMedia(mime || 'image/jpeg', imageBase64, `invoice.${ext}`)
      await withTimeout(state.client.sendMessage(chatId, media, { caption: caption || '' }), SEND_TIMEOUT, 'Send timed out after 30 seconds')
    } else if (message) {
      await withTimeout(state.client.sendMessage(chatId, message), SEND_TIMEOUT, 'Send timed out after 30 seconds')
    } else {
      return { ok: false, error: 'NO_CONTENT' }
    }
    log('sendMessage: sent successfully', { chatId })
    sendRetryAttempted = false // Reset on success
    return { ok: true }
  } catch (e) {
    const msg = e.message || ''
    log('sendMessage: error caught', { chatId, error: msg })

    // Check for specific WhatsApp Web internal error: "Data passed to getter must include an id property"
    const isMemoizeError = msg.includes('Data passed to getter must include an id property') ||
                           msg.includes('memoize') ||
                           msg.includes('undefined s')

    // Check for other common WhatsApp Web internal errors
    const isWhatsAppInternalError = isMemoizeError ||
                                    msg.includes('Cannot read propert') ||
                                    msg.includes('Cannot read properties of undefined') ||
                                    msg.includes('getter must include') ||
                                    msg.includes('Store.getId')

    if (msg.includes('not registered') || msg.includes('not on WhatsApp') || msg.includes('invalid')) {
      sendRetryAttempted = false
      return { ok: false, error: 'NOT_ON_WHATSAPP' }
    }

    // If it's a WhatsApp Web internal error and we haven't retried yet, attempt reconnect + retry
    if (isWhatsAppInternalError && !sendRetryAttempted) {
      warn('sendMessage: WhatsApp Web internal error detected, attempting auto-reconnect and retry:', msg)
      sendRetryAttempted = true

      try {
        await reconnect()
        log('sendMessage: reconnected, retrying send...')
        return sendMessage({ phone, countryCode, imageBase64, caption, mime, message })
      } catch (retryErr) {
        error('sendMessage: retry after reconnect failed:', retryErr.message)
      }
    }

    sendRetryAttempted = false
    error('sendMessage failed:', msg)
    return { ok: false, error: 'SEND_FAILED', detail: msg }
  }
}

async function sendInvoiceImage ({ phone, countryCode, imageBase64, caption, mime }) {
  // Ensure WhatsApp is connected before sending
  if (!state.client || state.status !== WA_STATE.CONNECTED) {
    log('sendInvoiceImage: not connected, initiating connection...', { status: state.status, hasClient: !!state.client })
    await connect()  // Wait for connection to complete

    // Check again after connection attempt
    if (!state.client || state.status !== WA_STATE.CONNECTED) {
      log('sendInvoiceImage: still not connected after connect()', { status: state.status, hasClient: !!state.client })
      return { ok: false, error: 'NOT_READY' }
    }
  }
  if (!imageBase64) return { ok: false, error: 'NO_IMAGE' }
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
    connect()
    return { ok: true }
  })
  ipcMain.handle('SEND_INVOICE_WHATSAPP', async (e, payload) => sendInvoiceImage(payload))
  ipcMain.handle('WA_GET_STATUS', async () => getStatus())
  ipcMain.handle('WA_RECONNECT', async () => {
    await reconnect()
    return { ok: true }
  })
  ipcMain.handle('WA_CONNECT', async () => connect())
  ipcMain.handle('WA_DISCONNECT', async () => { await disconnect(); return { ok: true } })
  ipcMain.handle('WA_LOGOUT', async () => { await logout(); return { ok: true } })
  ipcMain.handle('WA_GET_QR', async () => ({ qr: state.qrDataUrl }))
  ipcMain.handle('WA_SEND_MESSAGE', async (e, payload) => sendMessage(payload))
  ipcMain.handle('WA_QUEUE_MESSAGE', async (e, payload) => queueMessage(payload))
  ipcMain.handle('WA_GET_QUEUE_STATUS', async () => getQueueStatus())
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
