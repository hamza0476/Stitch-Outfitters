'use strict'

const path = require('path')
const fs   = require('fs')
const { state } = require('./paths')

function doBackup (db) {
  if (!db) return
  try {
    const today = new Date().toISOString().split('T')[0]
    const bakName = `backup_${today}.db`

    const localBak = path.join(state.backupDir, bakName)
    try {
      const buf = db.serialize()
      fs.writeFileSync(localBak, buf)
      console.log('[SO] Local backup updated:', localBak, `(${(buf.length / 1024 / 1024).toFixed(1)} MB)`)
    } catch (e) { console.warn('[SO] Local backup error:', e.message) }

    try {
      const allLocal = fs.readdirSync(state.backupDir).filter(f => f.endsWith('.db')).sort()
      while (allLocal.length > 30) {
        const old = allLocal.shift()
        try { fs.unlinkSync(path.join(state.backupDir, old)); console.log('[SO] Removed old local backup:', old) } catch (_) {}
      }
    } catch (_) {}

    if (state.cloudBackupDir) {
      try {
        if (!fs.existsSync(state.cloudBackupDir)) fs.mkdirSync(state.cloudBackupDir, { recursive: true })
        const cloudBak = path.join(state.cloudBackupDir, bakName)
        fs.copyFileSync(localBak, cloudBak)
        console.log('[SO] Cloud backup updated:', cloudBak)
        const allCloud = fs.readdirSync(state.cloudBackupDir).filter(f => f.endsWith('.db')).sort()
        while (allCloud.length > 30) {
          const old = allCloud.shift()
          try { fs.unlinkSync(path.join(state.cloudBackupDir, old)); console.log('[SO] Removed old cloud backup:', old) } catch (_) {}
        }
      } catch (e) { console.warn('[SO] Cloud backup error:', e.message) }
    }
  } catch (_) {}
}

module.exports = { doBackup }
