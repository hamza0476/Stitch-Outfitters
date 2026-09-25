'use strict'

const { parentPort } = require('worker_threads')
const path = require('path')
const fs = require('fs')

parentPort.on('message', async (msg) => {
  if (msg.type === 'verifyAll') {
    const results = []
    const dirs = msg.dirs || []

    for (const dir of dirs) {
      try {
        const files = fs.readdirSync(dir).filter(f => f.endsWith('.db'))
        for (const f of files) {
          const fp = path.join(dir, f)
          const v = verifyFile(fp)
          let size = 0
          try { size = fs.statSync(fp).size } catch (_) {}
          results.push({
            file: f,
            path: fp,
            size,
            verified: v.ok,
            error: v.error || null,
            isCloud: dir === msg.cloudDir
          })
          parentPort.postMessage({ type: 'progress', file: f, current: results.length, total: files.length * dirs.length })
        }
      } catch (e) {
        results.push({ file: '(read error)', path: dir, size: 0, verified: false, error: e.message, isCloud: dir === msg.cloudDir })
      }
    }
    parentPort.postMessage({ type: 'done', results })
  }
})

function verifyFile (filePath) {
  let handle
  try {
    const Database = require('better-sqlite3')
    handle = new Database(filePath, { readonly: true })
    const result = handle.pragma('quick_check', { simple: true })
    if (result !== 'ok') return { ok: false, error: 'Integrity check returned: ' + result }
    const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    if (!tables.length) return { ok: false, error: 'Backup contains no tables' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (handle) { try { handle.close() } catch (_) {} }
  }
}
