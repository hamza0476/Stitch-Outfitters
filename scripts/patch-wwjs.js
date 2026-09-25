'use strict'
// Patches whatsapp-web.js media-send bug (PR #201923) after install.
// Safe to run repeatedly — no-ops if already applied or file missing.
const fs = require('fs')
const path = require('path')

const target = path.join(
  __dirname, '..', 'node_modules', 'whatsapp-web.js',
  'src', 'util', 'Injected', 'Utils.js'
)

const MARKER = 'delete message.__x_id;'
const ANCHOR = '...extraOptions,\n        };'

try {
  if (!fs.existsSync(target)) {
    console.log('[patch-wwjs] Utils.js not found — skipped')
    process.exit(0)
  }
  let src = fs.readFileSync(target, 'utf8')
  if (src.includes(MARKER)) {
    console.log('[patch-wwjs] already applied')
    process.exit(0)
  }
  if (!src.includes(ANCHOR)) {
    console.log('[patch-wwjs] anchor not found — skipped (library version may have changed)')
    process.exit(0)
  }
  const insert = ANCHOR + `

        // MediaData __x_id collides with Msg id — PR #201923
        ${MARKER}`
  src = src.replace(ANCHOR, insert)
  fs.writeFileSync(target, src, 'utf8')
  console.log('[patch-wwjs] applied PR #201923 (delete message.__x_id)')
} catch (e) {
  console.error('[patch-wwjs] failed:', e.message)
  process.exit(0) // never break install over this
}
