'use strict'

const { app } = require('electron')
const path   = require('path')
const fs     = require('fs')
const os     = require('os')

const state = {
  dataDir: null,
  dbFile: null,
  imagesDir: null,
  backupDir: null,
  cloudBackupDir: null,
  cloudInfo: null
}

function findCloudBackupFolder () {
  const home = os.homedir()
  const googlePaths = [
    'G:\\My Drive', 'H:\\My Drive', 'I:\\My Drive', 'G:\\', 'H:\\',
    path.join(home, 'Google Drive', 'My Drive'),
    path.join(home, 'Google Drive'),
    path.join(home, 'GoogleDrive'),
    path.join(home, 'My Drive'),
    path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-Personal', 'My Drive'),
  ]
  const oneDrivePaths = [
    process.env.OneDrive,
    process.env.OneDriveConsumer,
    process.env.OneDriveCommercial,
    path.join(home, 'OneDrive'),
    path.join(home, 'OneDrive - Personal'),
    path.join(home, 'OneDrive - Business'),
    path.join(home, 'Library', 'CloudStorage', 'OneDrive-Personal'),
  ]
  for (const p of googlePaths) {
    if (p && fs.existsSync(p)) return { base: p, provider: 'Google Drive' }
  }
  for (const p of oneDrivePaths) {
    if (p && fs.existsSync(p)) return { base: p, provider: 'OneDrive' }
  }
  return null
}

function initPaths () {
  const appDataDir = app.getPath('appData')
  const docsDir = app.getPath('documents')

  state.dataDir   = path.join(appDataDir, 'Stitch Outfitters')
  state.dbFile    = path.join(state.dataDir, 'database.db')
  state.imagesDir = path.join(state.dataDir, 'images')

  console.log(`[SO] Docs path: ${docsDir}`)
  console.log(`[SO] AppData path: ${appDataDir}`)

  state.backupDir = path.join(docsDir, 'StitchOutfitters_Backups')

  const cloud = findCloudBackupFolder()
  if (cloud) {
    state.cloudBackupDir = path.join(cloud.base, 'StitchOutfitters_Backups')
    state.cloudInfo = { provider: cloud.provider, base: cloud.base }
    console.log(`[SO] Cloud backup: ${cloud.provider} -> ${state.cloudBackupDir}`)
  } else {
    state.cloudBackupDir = null
    state.cloudInfo = { provider: 'Local', base: state.dataDir }
    console.log('[SO] No cloud storage found — local backups only')
  }

  console.log(`[SO] Live DB: ${state.dbFile}`)
}

function ensureDirs () {
  const dirs = [state.dataDir, state.imagesDir, state.backupDir]
  if (state.cloudBackupDir) dirs.push(state.cloudBackupDir)
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      try { fs.mkdirSync(d, { recursive: true }) }
      catch (e) { console.error('[SO] ensureDirs failed for', d, e.message) }
    }
  }
}

function migrateDataFromDocuments () {
  const oldDataDir = path.join(app.getPath('documents'), 'Stitch Outfitters')
  const oldDbFile  = path.join(oldDataDir, 'database.db')

  if (!fs.existsSync(oldDbFile)) {
    console.log('[SO] Migration: no old database found in Documents')
    return
  }

  if (fs.existsSync(state.dbFile)) {
    console.log('[SO] Migration: new DB already exists at', state.dbFile, '— keeping it')
    return
  }

  console.log('[SO] Migration: copying database from', oldDbFile, 'to', state.dbFile)
  try {
    if (!fs.existsSync(state.dataDir)) fs.mkdirSync(state.dataDir, { recursive: true })
    fs.copyFileSync(oldDbFile, state.dbFile)
    console.log('[SO] Migration: database copied successfully')

    const oldImagesDir = path.join(oldDataDir, 'images')
    if (fs.existsSync(oldImagesDir)) {
      if (!fs.existsSync(state.imagesDir)) fs.mkdirSync(state.imagesDir, { recursive: true })
      let count = 0
      for (const f of fs.readdirSync(oldImagesDir)) {
        const src = path.join(oldImagesDir, f)
        if (fs.statSync(src).isFile()) {
          fs.copyFileSync(src, path.join(state.imagesDir, f))
          count++
        }
      }
      console.log(`[SO] Migration: copied ${count} images`)
    }
  } catch (e) {
    console.error('[SO] Migration failed:', e.message)
  }
}

module.exports = { state, initPaths, ensureDirs, migrateDataFromDocuments, findCloudBackupFolder }
