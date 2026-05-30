'use strict'

/**
 * main.js — Stitch Outfitters
 *
 * Thin entry point. All database/backup/path logic lives in src/main/.
 */

const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron')
const path = require('path')
const fs   = require('fs')

const { state: paths, initPaths, ensureDirs, migrateDataFromDocuments } = require('./src/main/paths')
const db = require('./src/main/database')
const { autoUpdater } = require('electron-updater')
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

let win = null

// ══════════════════════════════════════════════════════════════════════════════
// APP WINDOW
// ══════════════════════════════════════════════════════════════════════════════
app.whenReady().then(() => {
  try {
    initPaths()
    ensureDirs()
    migrateDataFromDocuments()
    db.openDB()
  } catch (e) {
    console.error('[SO] Startup error:', e.message)
  }

  win = new BrowserWindow({
    width: 1300, height: 820, minWidth: 1024, minHeight: 680,
    title: 'Stitch Outfitters',
    show: false,
    backgroundColor: '#1A1916',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  })

  win.loadFile('index.html')
  win.setMenu(null)
  win.once('ready-to-show', () => win.show())

  autoUpdater.on('checking-for-update', () => win?.webContents.send('UPDATE_STATUS', 'checking'))
  autoUpdater.on('update-available', (info) => win?.webContents.send('UPDATE_STATUS', { status: 'available', info }))
  autoUpdater.on('update-not-available', () => win?.webContents.send('UPDATE_STATUS', 'not-available'))
  autoUpdater.on('download-progress', (p) => win?.webContents.send('UPDATE_STATUS', { status: 'downloading', progress: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', () => win?.webContents.send('UPDATE_STATUS', 'downloaded'))

  db.setWinRef(win)
  db.registerHandlers(ipcMain)

  // ── Path / storage info handlers ────────────────────────────────────
  ipcMain.handle('GET_PATH',         () => paths.dbFile   || '')
  ipcMain.handle('GET_IMAGES_DIR',   () => paths.imagesDir || '')

  ipcMain.handle('GET_STORAGE_INFO', () => {
    try {
      let dbSize = '0 KB', imgCount = 0, bakCount = 0
      if (paths.dbFile && fs.existsSync(paths.dbFile))
        dbSize = (fs.statSync(paths.dbFile).size / 1024).toFixed(1) + ' KB'
      if (paths.imagesDir && fs.existsSync(paths.imagesDir))
        try { imgCount = fs.readdirSync(paths.imagesDir).length } catch (_) {}
      if (paths.backupDir && fs.existsSync(paths.backupDir))
        try { bakCount = fs.readdirSync(paths.backupDir).filter(f => f.endsWith('.db')).length } catch (_) {}
      let cloudBakCount = 0
      if (paths.cloudBackupDir && fs.existsSync(paths.cloudBackupDir))
        try { cloudBakCount = fs.readdirSync(paths.cloudBackupDir).filter(f => f.endsWith('.db')).length } catch (_) {}
      return {
        provider: paths.cloudInfo?.provider || 'Local',
        dataDir:  paths.dataDir  || '', dbFile: paths.dbFile || '',
        imagesDir: paths.imagesDir || '', backupDir: paths.backupDir || '',
        cloudBackupDir: paths.cloudBackupDir || '',
        dbSize, imgCount, bakCount, cloudBakCount, syncing: !!paths.cloudBackupDir
      }
    } catch (e) {
      return { provider: 'Local', syncing: false, dbSize: '?', imgCount: 0, bakCount: 0 }
    }
  })

  ipcMain.handle('OPEN_DATA_FOLDER',   () => { shell.openPath(paths.dataDir || '');  return { ok: true } })
  ipcMain.handle('OPEN_BACKUP_FOLDER', () => { shell.openPath(paths.backupDir || ''); return { ok: true } })

  ipcMain.handle('CHECK_FOR_UPDATE',  () => autoUpdater.checkForUpdates())
  ipcMain.handle('DOWNLOAD_UPDATE',   () => autoUpdater.downloadUpdate())
  ipcMain.handle('RESTART_APP',       () => autoUpdater.quitAndInstall())

  // ── Check for updates on startup ──────────────────────────────────
  setTimeout(() => autoUpdater.checkForUpdates(), 5000)

  // ── Print handlers ─────────────────────────────────────────────────
  ipcMain.handle('PRINT_HTML', async (e, { html, title, landscape, paperSize }) => {
    try {
      const printWin = new BrowserWindow({
        show: false, width: 1024, height: 768,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      })
      const meta = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
        (title || 'Print') + '</title><style>' +
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'body{font-family:\'Segoe UI\',Arial,sans-serif;background:#fff;padding:20px;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        'table{border-collapse:collapse;width:100%}@page{margin:10mm}' +
        '</style></head><body>' + html + '</body></html>'
      await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(meta))
      printWin.webContents.print({
        printBackground: true, landscape: !!landscape, pageSize: paperSize || 'A4', silent: false
      }, (success, failureReason) => {
        if (!success) console.error('[MAIN] Print failed:', failureReason)
        if (!printWin.isDestroyed()) printWin.close()
      })
      return { ok: true }
    } catch (err) {
      console.error('[MAIN] PRINT_HTML error:', err.message)
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('PRINT_TO_PDF', async (e, { html, title, landscape, paperSize }) => {
    try {
      const printWin = new BrowserWindow({
        show: false, width: 1024, height: 768,
        webPreferences: { nodeIntegration: false, contextIsolation: true }
      })
      const meta = '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' +
        (title || 'Print') + '</title><style>' +
        '*{margin:0;padding:0;box-sizing:border-box}' +
        'body{font-family:\'Segoe UI\',Arial,sans-serif;background:#fff;padding:20px;color:#000;-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
        'table{border-collapse:collapse;width:100%}@page{margin:10mm}' +
        '</style></head><body>' + html + '</body></html>'
      await printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(meta))
      const pdfData = await printWin.webContents.printToPDF({
        printBackground: true, landscape: !!landscape, pageSize: paperSize || 'A4'
      })
      if (!printWin.isDestroyed()) printWin.close()
      const r = await dialog.showSaveDialog({
        title: 'Save PDF',
        defaultPath: (title || 'document').replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      })
      if (!r.canceled && r.filePath) { fs.writeFileSync(r.filePath, pdfData); return { ok: true, filePath: r.filePath } }
      return { ok: false, canceled: true }
    } catch (err) {
      console.error('[MAIN] PRINT_TO_PDF error:', err.message)
      return { ok: false, error: err.message }
    }
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// APP LIFECYCLE
// ══════════════════════════════════════════════════════════════════════════════
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (!db.isOpen() || db.backupDone()) return
  console.log('[SO] before-quit: backing up...')
  db.triggerBackup()
  db.setBackupDone(true)
})

app.on('will-quit', () => {
  if (!db.isOpen()) return
  if (!db.backupDone()) {
    console.log('[SO] will-quit: backing up...')
    db.triggerBackup()
  }
  db.closeDB()
})
