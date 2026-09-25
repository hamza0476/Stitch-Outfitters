'use strict'

const path = require('path')
const fs   = require('fs')
const fsp  = fs.promises
const { Worker } = require('worker_threads')
const { state } = require('./paths')

const MAX_RETRIES = 2
const RETRY_DELAY_MS = 1000
const MAX_STATUS_HISTORY = 30
const STATUS_FILE = 'backup_status.json'

let backupHistory = []
let winRef = null

function setWinRef (w) { winRef = w }

function getStatusPath () {
  return path.join(state.backupDir, STATUS_FILE)
}

async function loadStatus () {
  try {
    const raw = await fsp.readFile(getStatusPath(), 'utf8')
    backupHistory = JSON.parse(raw)
  } catch (_) {
    backupHistory = []
  }
}

async function saveStatus () {
  try {
    await fsp.writeFile(getStatusPath(), JSON.stringify(backupHistory, null, 2))
  } catch (e) {
    console.warn('[SO] Could not save backup status:', e.message)
  }
}

function recordResult (entry) {
  backupHistory.push(entry)
  if (backupHistory.length > MAX_STATUS_HISTORY) {
    backupHistory = backupHistory.slice(-MAX_STATUS_HISTORY)
  }
  saveStatus()
}

async function verifyBackup (filePath) {
  let handle
  try {
    const Database = require('better-sqlite3')
    handle = new Database(filePath, { readonly: true })
    const result = handle.pragma('quick_check', { simple: true })
    if (result !== 'ok') return { ok: false, error: `Integrity check returned: ${result}` }
    const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    if (!tables.length) return { ok: false, error: 'Backup contains no tables' }
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (handle) { try { handle.close() } catch (_) {} }
  }
}

function notifyRenderer (channel, data) {
  try {
    if (winRef && !winRef.isDestroyed()) {
      winRef.webContents.send(channel, data)
    }
  } catch (_) {}
}

async function rotateDir (dir, maxFiles) {
  try {
    const all = (await fsp.readdir(dir)).filter(f => f.endsWith('.db')).sort()
    while (all.length > maxFiles) {
      const old = all.shift()
      try { await fsp.unlink(path.join(dir, old)); console.log('[SO] Removed old backup:', old) } catch (e) { console.warn('[SO] Rotation delete failed:', old, e.message) }
    }
  } catch (e) {
    console.warn('[SO] Rotation read failed for', dir, e.message)
  }
}

async function doBackup (db) {
  if (!db) return { ok: false, error: 'No database' }

  if (!backupHistory.length) await loadStatus()

  const timestamp = new Date().toISOString()
  const today = timestamp.split('T')[0]
  const bakName = `backup_${today}.db`
  let localOk = false
  let cloudOk = false
  let localSize = 0
  let error = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`[SO] Backup retry ${attempt}/${MAX_RETRIES}...`)
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt))
    }

    // Local backup
    const localBak = path.join(state.backupDir, bakName)
    try {
      const buf = db.serialize()
      await fsp.writeFile(localBak, buf)
      localSize = buf.length

      const verify = await verifyBackup(localBak)
      if (!verify.ok) throw new Error(`Verification failed: ${verify.error}`)

      localOk = true
      console.log('[SO] Local backup OK:', localBak, `(${(localSize / 1024 / 1024).toFixed(1)} MB)`)
      break
    } catch (e) {
      error = e.message
      console.warn('[SO] Local backup attempt', attempt + 1, 'failed:', e.message)
      if (attempt === MAX_RETRIES) {
        notifyRenderer('BACKUP_FAILED', {
          error: `Local backup failed: ${e.message}`,
          timestamp,
          location: 'local'
        })
      }
    }
  }

  if (localOk) {
    await rotateDir(state.backupDir, 30)

    // Cloud backup
    if (state.cloudBackupDir) {
      try {
        await fsp.mkdir(state.cloudBackupDir, { recursive: true })
        const localBak = path.join(state.backupDir, bakName)
        const cloudBak = path.join(state.cloudBackupDir, bakName)
        await fsp.copyFile(localBak, cloudBak)
        cloudOk = true
        console.log('[SO] Cloud backup OK:', cloudBak)
        await rotateDir(state.cloudBackupDir, 30)
      } catch (e) {
        console.warn('[SO] Cloud backup error:', e.message)
        notifyRenderer('BACKUP_FAILED', {
          error: `Cloud backup failed: ${e.message}`,
          timestamp,
          location: 'cloud'
        })
      }
    }
  }

  const entry = {
    timestamp,
    local: localOk,
    cloud: cloudOk,
    size: localSize,
    error: localOk ? null : error,
    verified: localOk
  }
  recordResult(entry)

  return { ok: localOk, cloud: cloudOk, error: entry.error }
}

function getBackupStatus () {
  return {
    history: backupHistory,
    lastSuccess: [...backupHistory].reverse().find(e => e.local)?.timestamp || null,
    lastError: [...backupHistory].reverse().find(e => !e.local)?.timestamp || null,
    cloudProvider: state.cloudInfo?.provider || 'Local',
    cloudAvailable: !!state.cloudBackupDir,
    backupDir: state.backupDir,
    cloudBackupDir: state.cloudBackupDir || null,
    totalBackups: backupHistory.filter(e => e.local).length,
    failedBackups: backupHistory.filter(e => !e.local).length
  }
}

async function verifyAllBackups (onProgress) {
  const dirs = [state.backupDir]
  if (state.cloudBackupDir) dirs.push(state.cloudBackupDir)

  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'verify-worker.js')
    const worker = new Worker(workerPath, {
      workerData: { dirs, cloudDir: state.cloudBackupDir }
    })

    worker.on('message', (msg) => {
      if (msg.type === 'progress' && onProgress) {
        onProgress(msg)
      } else if (msg.type === 'done') {
        resolve(msg.results)
      }
    })

    worker.on('error', (err) => {
      reject(err)
    })

    worker.postMessage({
      type: 'verifyAll',
      dirs,
      cloudDir: state.cloudBackupDir
    })
  })
}

async function clearHistory () {
  backupHistory = []
  await saveStatus()
}

module.exports = { doBackup, getBackupStatus, verifyAllBackups, clearHistory, setWinRef, loadStatus }
