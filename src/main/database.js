'use strict'

const path  = require('path')
const fs    = require('fs')
const { app, dialog, shell } = require('electron')
const { state: paths, ensureDirs } = require('./paths')
const { doBackup } = require('./backup')

let db = null
let _stmts = null
let winRef = null
let _backupDone = false

const MAX_IMAGE_B64_LEN = 8 * 1024 * 1024

function setWinRef (w) { winRef = w }
function isOpen () { return !!db }
function backupDone () { return _backupDone }
function setBackupDone (v) { _backupDone = v }

function rand () { return Math.random().toString(36).slice(2, 10) }

function safeJSON (str, fallback) {
  if (str == null) return fallback
  try { return JSON.parse(str) } catch (_) { return fallback }
}

function saveImageFile (base64Str, orderId, index) {
  if (!base64Str || base64Str.length > MAX_IMAGE_B64_LEN) {
    throw new Error(`Image too large or empty (max ${MAX_IMAGE_B64_LEN / 1024 / 1024} MB)`)
  }
  const match = base64Str.match(/^data:(image\/\w+);base64,/)
  const ext = (match?.[1] === 'image/png') ? 'png' : (match?.[1] === 'image/webp') ? 'webp' : 'jpg'
  const fname = `${String(orderId).replace(/[^a-zA-Z0-9_-]/g, '_')}_${index}.${ext}`
  fs.writeFileSync(
    path.join(paths.imagesDir, fname),
    Buffer.from(base64Str.replace(/^data:image\/\w+;base64,/, ''), 'base64')
  )
  return fname
}

function deleteImageFile (fname) {
  if (!fname) return
  try { fs.unlinkSync(path.join(paths.imagesDir, fname)) } catch (_) {}
}

// ── Migrations ──────────────────────────────────────────────────────────
function importDataObject (d) {
  db.transaction(() => {
    const iC  = db.prepare('INSERT OR REPLACE INTO clients (uid,name,phone,email,age,city,address,tag,added_date,measurements,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    const iO  = db.prepare('INSERT OR REPLACE INTO orders (id,client_uid,orders,price,discount,delivery,status,pay_status,advance,paid_date,garment,fabric,design,images,inv_fabric_id,inv_fabric_used,extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const iW  = db.prepare('INSERT OR REPLACE INTO workers (id,data) VALUES (?,?)')
    const iA  = db.prepare('INSERT OR REPLACE INTO assignments (id,data) VALUES (?,?)')
    const iE  = db.prepare('INSERT OR REPLACE INTO expenses (id,data) VALUES (?,?)')
    const iI  = db.prepare('INSERT OR REPLACE INTO inventory (id,data) VALUES (?,?)')
    const iIH = db.prepare('INSERT INTO inv_history (data) VALUES (?)')
    const iS  = db.prepare('INSERT OR REPLACE INTO salary_payments (id,data) VALUES (?,?)')
    const iCL = db.prepare('INSERT OR REPLACE INTO commission_logs (id,data) VALUES (?,?)')
    const iST = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)')

    for (const c of (d.clients||[])) {
      const { orderList, measurements, uid, name, phone, email, age, city, address, tag, addedDate, ...rest } = c
      const extra = Object.fromEntries(Object.entries(rest).filter(([k]) =>
        !['uid','name','phone','email','age','city','address','tag','addedDate','orderList','measurements'].includes(k)))
      iC.run(uid||'', name||'', phone||'', email||'', age||'', city||'', address||'', tag||'regular', addedDate||'',
        measurements != null ? JSON.stringify(measurements) : null, JSON.stringify(extra))
      for (const o of (orderList||[])) {
        iO.run(o.id||'', uid||'', o.orders||1, o.price||0, o.discount||0, o.delivery||'', o.status||'pending',
          o.payStatus||'unpaid', o.advance||0, o.paidDate||null, o.garment||'', o.fabric||'', o.design||'',
          JSON.stringify(o.images||[]), o.invFabricId||null, o.invFabricUsed||0, '{}')
      }
    }
    for (const w of (d.workers||[]))        iW.run(w.id||rand(), JSON.stringify(w))
    for (const a of (d.assignments||[]))    iA.run(a.id||rand(), JSON.stringify(a))
    for (const e of (d.expenses||[]))       iE.run(e.id||rand(), JSON.stringify(e))
    for (const i of (d.inventory||[]))      iI.run(i.id||rand(), JSON.stringify(i))
    for (const h of (d.invHistory||[]))     iIH.run(JSON.stringify(h))
    for (const s of (d.salaryPayments||[])) iS.run(s.id||rand(), JSON.stringify(s))
    for (const l of (d.commissionLogs||[])) iCL.run(l.id||rand(), JSON.stringify(l))
    if (d.settings) {
      for (const [k,v] of Object.entries(d.settings))
        iST.run(k, typeof v === 'string' ? v : JSON.stringify(v))
    }
    db.prepare('UPDATE counters SET uid_c=?,ord_c=?,wrk_c=?,ass_c=?,exp_c=?,inv_c=?,sal_c=?,comm_c=? WHERE id=1')
      .run(d.uidC||1000, d.ordC||1, d.wrkC||1, d.assC||1, d.expC||1, d.invC||1, d.salC||1, d.commC||1)
  })()
}

function migrateFromBlob () {
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='store'").get()) return
  if (db.prepare('SELECT COUNT(*) as n FROM clients').get().n > 0) return
  const row = db.prepare('SELECT data FROM store WHERE id = 1').get()
  if (!row?.data) return
  const d = JSON.parse(row.data)
  if (!d?.clients && !d?.uidC) return
  console.log('[SO] Migrating v2 blob → v3…')
  importDataObject(d)
  db.exec('ALTER TABLE store RENAME TO store_migrated_v2')
  console.log('[SO] v2→v3 done.')
}

function migrateFromJSON () {
  if (db.prepare('SELECT COUNT(*) as n FROM clients').get().n > 0) return
  const f = path.join(paths.dataDir, 'database.json')
  if (!fs.existsSync(f)) return
  const d = JSON.parse(fs.readFileSync(f, 'utf8'))
  if (!d) return
  console.log('[SO] Migrating v1 JSON → v3…')
  importDataObject(d)
  fs.renameSync(f, f + '.migrated')
  console.log('[SO] v1→v3 done.')
}

// ── Open DB ────────────────────────────────────────────────────────────
function openDB () {
  let Database
  try {
    Database = require('better-sqlite3')
  } catch (e) {
    const msg = `Cannot load better-sqlite3.\n\nRun "npm run rebuild" in the app folder and restart.\n\nDetail: ${e.message}`
    console.error('[SO] better-sqlite3 load failed:', e.message)
    setImmediate(() => { dialog.showErrorBox('Database Error', msg) })
    throw e
  }

  db = new Database(paths.dbFile, { timeout: 5000, verbose: null })

  db.pragma('journal_mode = DELETE')
  db.pragma('foreign_keys = ON')
  db.pragma('cache_size = -32768')
  db.pragma('synchronous = FULL')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456')

  try {
    const oldWorkers = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='workers_old'").get()
    if (oldWorkers) {
      console.log('[SO] Detected v5 partial migration — restoring old tables')
      const pairs = [
        ['workers_old','workers'], ['assignments_old','assignments'], ['expenses_old','expenses'],
        ['inventory_old','inventory'], ['salary_payments_old','salary_payments'], ['commission_logs_old','commission_logs'],
        ['orders_old','orders']
      ]
      for (const [oldName, newName] of pairs) {
        const exists = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='${oldName}'`).get()
        if (exists) {
          db.exec(`DROP TABLE IF EXISTS ${newName}`)
          db.exec(`ALTER TABLE ${oldName} RENAME TO ${newName}`)
        }
      }
      console.log('[SO] Rollback complete')
    }
  } catch (_) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      uid          TEXT PRIMARY KEY,
      name         TEXT NOT NULL DEFAULT '',
      phone        TEXT NOT NULL DEFAULT '',
      email        TEXT DEFAULT '',
      age          TEXT DEFAULT '',
      city         TEXT DEFAULT '',
      address      TEXT DEFAULT '',
      tag          TEXT DEFAULT 'regular',
      added_date   TEXT DEFAULT '',
      measurements TEXT DEFAULT NULL,
      extra        TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS orders (
      id              TEXT PRIMARY KEY,
      client_uid      TEXT NOT NULL REFERENCES clients(uid) ON DELETE CASCADE,
      orders          INTEGER DEFAULT 1,
      price           REAL DEFAULT 0,
      discount        REAL DEFAULT 0,
      delivery        TEXT DEFAULT '',
      status          TEXT DEFAULT 'pending',
      pay_status      TEXT DEFAULT 'unpaid',
      advance         REAL DEFAULT 0,
      paid_date       TEXT DEFAULT NULL,
      garment         TEXT DEFAULT '',
      fabric          TEXT DEFAULT '',
      design          TEXT DEFAULT '',
      images          TEXT DEFAULT '[]',
      inv_fabric_id   TEXT DEFAULT NULL,
      inv_fabric_used REAL DEFAULT 0,
      extra           TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS workers          (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS assignments      (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS expenses         (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS inventory        (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS inv_history      (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS salary_payments  (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS commission_logs  (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS settings         (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS counters (
      id     INTEGER PRIMARY KEY CHECK (id = 1),
      uid_c  INTEGER DEFAULT 1000,
      ord_c  INTEGER DEFAULT 1,
      wrk_c  INTEGER DEFAULT 1,
      ass_c  INTEGER DEFAULT 1,
      exp_c  INTEGER DEFAULT 1,
      inv_c  INTEGER DEFAULT 1,
      sal_c  INTEGER DEFAULT 1,
      comm_c INTEGER DEFAULT 1
    );
    INSERT OR IGNORE INTO counters (id) VALUES (1);
    CREATE INDEX IF NOT EXISTS idx_orders_client_uid       ON orders(client_uid);
    CREATE INDEX IF NOT EXISTS idx_orders_status           ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_pay_status       ON orders(pay_status);
    CREATE INDEX IF NOT EXISTS idx_orders_delivery         ON orders(delivery);
    CREATE INDEX IF NOT EXISTS idx_clients_phone           ON clients(phone);
    CREATE INDEX IF NOT EXISTS idx_clients_name            ON clients(name);
    CREATE INDEX IF NOT EXISTS idx_clients_added_date      ON clients(added_date);
    CREATE INDEX IF NOT EXISTS idx_orders_status_pay       ON orders(status, pay_status);
    CREATE INDEX IF NOT EXISTS idx_orders_delivery_status  ON orders(delivery, status);
  `)

  _stmts = null
  try { migrateFromBlob() }  catch (e) { console.warn('[SO] v2 migration error:', e.message) }
  try { migrateFromJSON() }  catch (e) { console.warn('[SO] v1 migration error:', e.message) }
}

function closeDB () {
  if (!db) return
  try { db.close() } catch (_) {}
  db = null
  _stmts = null
}

// ── Read ─────────────────────────────────────────────────────────────
function readData () {
  const ordersByClient = {}
  for (const o of db.prepare('SELECT * FROM orders ORDER BY client_uid, rowid').all()) {
    ;(ordersByClient[o.client_uid] ||= []).push({
      id: o.id, orders: o.orders, price: o.price, discount: o.discount,
      delivery: o.delivery, status: o.status, payStatus: o.pay_status,
      advance: o.advance, paidDate: o.paid_date||undefined,
      garment: o.garment, fabric: o.fabric, design: o.design,
      images: safeJSON(o.images, []),
      invFabricId: o.inv_fabric_id||undefined, invFabricUsed: o.inv_fabric_used||0,
      ...safeJSON(o.extra, {})
    })
  }

  const clients = db.prepare('SELECT * FROM clients ORDER BY rowid').all().map(c => ({
    uid: c.uid, name: c.name, phone: c.phone, email: c.email,
    age: c.age, city: c.city, address: c.address, tag: c.tag,
    addedDate: c.added_date,
    measurements: c.measurements ? safeJSON(c.measurements, null) : undefined,
    orderList: ordersByClient[c.uid] || [],
    ...safeJSON(c.extra, {})
  }))

  const settings = {}
  for (const s of db.prepare('SELECT key,value FROM settings').all()) {
    try { settings[s.key] = JSON.parse(s.value) } catch (_) { settings[s.key] = s.value }
  }

  const ctr = db.prepare('SELECT * FROM counters WHERE id=1').get() || {}
  return {
    clients,
    workers:        db.prepare('SELECT data FROM workers ORDER BY rowid').all().map(r => safeJSON(r.data, {})),
    assignments:    db.prepare('SELECT data FROM assignments ORDER BY rowid').all().map(r => safeJSON(r.data, {})),
    expenses:       db.prepare('SELECT data FROM expenses ORDER BY rowid').all().map(r => safeJSON(r.data, {})),
    inventory:      db.prepare('SELECT data FROM inventory ORDER BY rowid').all().map(r => safeJSON(r.data, {})),
    invHistory:     db.prepare('SELECT data FROM inv_history ORDER BY id').all().map(r => safeJSON(r.data, {})),
    salaryPayments: db.prepare('SELECT data FROM salary_payments ORDER BY rowid').all().map(r => safeJSON(r.data, {})),
    commissionLogs: db.prepare('SELECT data FROM commission_logs ORDER BY rowid').all().map(r => safeJSON(r.data, {})),
    settings,
    uidC:  ctr.uid_c  || 1000,
    ordC:  ctr.ord_c  || 1,
    wrkC:  ctr.wrk_c  || 1,
    assC:  ctr.ass_c  || 1,
    expC:  ctr.exp_c  || 1,
    invC:  ctr.inv_c  || 1,
    salC:  ctr.sal_c  || 1,
    commC: ctr.comm_c || 1
  }
}

// ── Write ────────────────────────────────────────────────────────────
function writeData (data) {
  if (!_stmts) {
    _stmts = {
      uC: db.prepare(`INSERT INTO clients (uid,name,phone,email,age,city,address,tag,added_date,measurements,extra)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET
        name=excluded.name,phone=excluded.phone,email=excluded.email,age=excluded.age,
        city=excluded.city,address=excluded.address,tag=excluded.tag,
        added_date=excluded.added_date,measurements=excluded.measurements,extra=excluded.extra`),

      uO: db.prepare(`INSERT INTO orders (id,client_uid,orders,price,discount,delivery,status,pay_status,
        advance,paid_date,garment,fabric,design,images,inv_fabric_id,inv_fabric_used,extra)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        client_uid=excluded.client_uid,orders=excluded.orders,price=excluded.price,
        discount=excluded.discount,delivery=excluded.delivery,status=excluded.status,
        pay_status=excluded.pay_status,advance=excluded.advance,paid_date=excluded.paid_date,
        garment=excluded.garment,fabric=excluded.fabric,design=excluded.design,
        images=excluded.images,inv_fabric_id=excluded.inv_fabric_id,
        inv_fabric_used=excluded.inv_fabric_used,extra=excluded.extra`),

      uBlob: {
        workers:          db.prepare('INSERT OR REPLACE INTO workers (id,data) VALUES (?,?)'),
        assignments:      db.prepare('INSERT OR REPLACE INTO assignments (id,data) VALUES (?,?)'),
        expenses:         db.prepare('INSERT OR REPLACE INTO expenses (id,data) VALUES (?,?)'),
        inventory:        db.prepare('INSERT OR REPLACE INTO inventory (id,data) VALUES (?,?)'),
        salary_payments:  db.prepare('INSERT OR REPLACE INTO salary_payments (id,data) VALUES (?,?)'),
        commission_logs:  db.prepare('INSERT OR REPLACE INTO commission_logs (id,data) VALUES (?,?)'),
      },

      uCtr: db.prepare('UPDATE counters SET uid_c=?,ord_c=?,wrk_c=?,ass_c=?,exp_c=?,inv_c=?,sal_c=?,comm_c=? WHERE id=1'),
      uSet: db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)'),
      iIH:  db.prepare('INSERT INTO inv_history (data) VALUES (?)'),

      selClients: db.prepare('SELECT uid FROM clients'),
      selOrders:  db.prepare('SELECT id FROM orders'),
    }
  }

  const tx = db.transaction(() => {
    const { uC, uO, uBlob, uCtr, uSet, iIH, selClients, selOrders } = _stmts

    const cUids = new Set()
    const oIds  = new Set()

    for (const c of (data.clients||[])) {
      cUids.add(c.uid)
      const { orderList, measurements, uid, name, phone, email, age, city, address, tag, addedDate, ...rest } = c
      const extra = Object.fromEntries(Object.entries(rest).filter(([k]) =>
        !['uid','name','phone','email','age','city','address','tag','addedDate','orderList','measurements'].includes(k)))
      uC.run(uid||'', name||'', phone||'', email||'', age||'', city||'', address||'',
        tag||'regular', addedDate||'',
        measurements != null ? JSON.stringify(measurements) : null, JSON.stringify(extra))

      for (const o of (orderList||[])) {
        oIds.add(o.id)
        const { id, orders, price, discount, delivery, status, payStatus, advance, paidDate,
                garment, fabric, design, images, invFabricId, invFabricUsed, ...oRest } = o
        uO.run(id||'', uid||'', orders||1, price||0, discount||0, delivery||'', status||'pending',
          payStatus||'unpaid', advance||0, paidDate||null, garment||'', fabric||'', design||'',
          JSON.stringify(images||[]), invFabricId||null, invFabricUsed||0, JSON.stringify(oRest))
      }
    }

    const _bulkDelete = (stmt_prefix, existingRows, keepSet) => {
      const toDelete = existingRows.filter(r => {
        const key = r.uid || r.id
        return !keepSet.has(key)
      }).map(r => r.uid || r.id)

      for (let i = 0; i < toDelete.length; i += 900) {
        const chunk = toDelete.slice(i, i + 900)
        if (!chunk.length) break
        const ph = chunk.map(() => '?').join(',')
        db.prepare(`${stmt_prefix} (${ph})`).run(...chunk)
      }
    }

    _bulkDelete('DELETE FROM clients WHERE uid IN', selClients.all(), cUids)
    _bulkDelete('DELETE FROM orders WHERE id IN',   selOrders.all(),  oIds)

    const blobTables = [
      ['workers',         'workers',         data.workers||[]],
      ['assignments',     'assignments',     data.assignments||[]],
      ['expenses',        'expenses',        data.expenses||[]],
      ['inventory',       'inventory',       data.inventory||[]],
      ['salary_payments', 'salary_payments', data.salaryPayments||[]],
      ['commission_logs', 'commission_logs', data.commissionLogs||[]],
    ]
    for (const [tbl, stmtKey, rows] of blobTables) {
      const ins = uBlob[stmtKey]
      const keepIds = new Set()
      for (const r of rows) {
        const id = r.id || rand()
        keepIds.add(id)
        ins.run(id, JSON.stringify(r))
      }
      if (keepIds.size === 0) {
        db.prepare(`DELETE FROM ${tbl}`).run()
      } else {
        const existingIds = db.prepare(`SELECT id FROM ${tbl}`).all().map(r => r.id)
        const orphans = existingIds.filter(id => !keepIds.has(id))
        for (let i = 0; i < orphans.length; i += 900) {
          const chunk = orphans.slice(i, i + 900)
          if (!chunk.length) break
          const ph = chunk.map(() => '?').join(',')
          db.prepare(`DELETE FROM ${tbl} WHERE id IN (${ph})`).run(...chunk)
        }
      }
    }

    const existingH = db.prepare('SELECT COUNT(*) as n FROM inv_history').get().n
    const inH = data.invHistory || []
    if (inH.length > existingH) {
      for (let i = existingH; i < inH.length; i++) iIH.run(JSON.stringify(inH[i]))
    } else if (inH.length < existingH) {
      db.prepare('DELETE FROM inv_history').run()
      for (const h of inH) iIH.run(JSON.stringify(h))
    }

    if (data.settings) {
      for (const [k,v] of Object.entries(data.settings))
        uSet.run(k, typeof v === 'string' ? v : JSON.stringify(v))
    }

    uCtr.run(data.uidC||1000, data.ordC||1, data.wrkC||1, data.assC||1,
             data.expC||1,   data.invC||1, data.salC||1, data.commC||1)
  })

  try {
    tx()
  } catch (err) {
    console.error('[SO] writeData transaction error:', err.message)
    return { ok: false, error: err.message }
  }

  setImmediate(() => { doBackup(db) })
  return { ok: true }
}

// ── Targeted single-client save ─────────────────────────────────────
function saveClient (clientUid, client, deleted) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    if (deleted) {
      db.prepare('DELETE FROM clients WHERE uid = ?').run(deleted)
      return { ok: true }
    }
    if (!client) return { ok: false, error: 'No client data' }
    const { uid, name, phone, email, age, city, address, tag, addedDate, measurements, orderList, ...rest } = client
    const extra = Object.fromEntries(
      Object.entries(rest).filter(([k]) =>
        !['uid','name','phone','email','age','city','address','tag','addedDate','orderList','measurements','defaultDiscount'].includes(k))
    )
    if (rest.defaultDiscount !== undefined) extra.defaultDiscount = rest.defaultDiscount
    db.transaction(() => {
      db.prepare(`INSERT INTO clients (uid,name,phone,email,age,city,address,tag,added_date,measurements,extra)
        VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET
        name=excluded.name,phone=excluded.phone,email=excluded.email,age=excluded.age,
        city=excluded.city,address=excluded.address,tag=excluded.tag,
        added_date=excluded.added_date,measurements=excluded.measurements,extra=excluded.extra`)
        .run(uid||'', name||'', phone||'', email||'', age||'', city||'', address||'',
          tag||'regular', addedDate||'',
          measurements != null ? JSON.stringify(measurements) : null,
          JSON.stringify(extra))
      for (const o of (orderList || [])) {
        const { id, orders, price, discount, delivery, status, payStatus, advance, paidDate,
                garment, fabric, design, images, invFabricId, invFabricUsed, ...oRest } = o
        db.prepare(`INSERT INTO orders (id,client_uid,orders,price,discount,delivery,status,pay_status,
          advance,paid_date,garment,fabric,design,images,inv_fabric_id,inv_fabric_used,extra)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(id) DO UPDATE SET client_uid=excluded.client_uid,orders=excluded.orders,
          price=excluded.price,discount=excluded.discount,delivery=excluded.delivery,
          status=excluded.status,pay_status=excluded.pay_status,advance=excluded.advance,
          paid_date=excluded.paid_date,garment=excluded.garment,fabric=excluded.fabric,
          design=excluded.design,images=excluded.images,inv_fabric_id=excluded.inv_fabric_id,
          inv_fabric_used=excluded.inv_fabric_used,extra=excluded.extra`)
          .run(id||'', uid||'', orders||1, price||0, discount||0, delivery||'', status||'pending',
            payStatus||'unpaid', advance||0, paidDate||null, garment||'', fabric||'', design||'',
            JSON.stringify(images||[]), invFabricId||null, invFabricUsed||0, JSON.stringify(oRest))
      }
      const keepIds = (orderList || []).map(o => o.id).filter(Boolean)
      if (keepIds.length === 0) {
        db.prepare('DELETE FROM orders WHERE client_uid = ?').run(uid||'')
      } else {
        const existing = db.prepare('SELECT id FROM orders WHERE client_uid = ?').all(uid||'').map(r => r.id)
        const toDelete = existing.filter(id => !keepIds.includes(id))
        for (let i = 0; i < toDelete.length; i += 900) {
          const chunk = toDelete.slice(i, i + 900)
          if (!chunk.length) break
          db.prepare(`DELETE FROM orders WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk)
        }
      }
    })()
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

// ── Targeted single-order save ──────────────────────────────────────
function saveOrder (clientUid, order) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    const { id, orders, price, discount, delivery, status, payStatus,
            advance, paidDate, garment, fabric, design, images,
            invFabricId, invFabricUsed, ...oRest } = order
    db.prepare(`INSERT INTO orders (id,client_uid,orders,price,discount,delivery,status,pay_status,
      advance,paid_date,garment,fabric,design,images,inv_fabric_id,inv_fabric_used,extra)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET status=excluded.status,pay_status=excluded.pay_status,
      paid_date=excluded.paid_date,orders=excluded.orders,price=excluded.price,
      discount=excluded.discount,delivery=excluded.delivery,advance=excluded.advance,
      garment=excluded.garment,fabric=excluded.fabric,design=excluded.design,
      images=excluded.images,inv_fabric_id=excluded.inv_fabric_id,
      inv_fabric_used=excluded.inv_fabric_used,extra=excluded.extra`
    ).run(id||'', clientUid||'', orders||1, price||0, discount||0, delivery||'', status||'pending',
      payStatus||'unpaid', advance||0, paidDate||null, garment||'', fabric||'', design||'',
      JSON.stringify(images||[]), invFabricId||null, invFabricUsed||0, JSON.stringify(oRest))
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

// ── Counters-only save ──────────────────────────────────────────────
function saveCounters (c) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    db.prepare('UPDATE counters SET uid_c=?,ord_c=?,wrk_c=?,ass_c=?,exp_c=?,inv_c=?,sal_c=?,comm_c=? WHERE id=1')
      .run(c.uidC||1000, c.ordC||1, c.wrkC||1, c.assC||1, c.expC||1, c.invC||1, c.salC||1, c.commC||1)
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

// ── Single-row blob table saves ─────────────────────────────────────
function saveExpense (expense, deletedId) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    if (deletedId) { db.prepare('DELETE FROM expenses WHERE id = ?').run(deletedId); return { ok: true } }
    if (!expense) return { ok: false, error: 'No expense data' }
    db.prepare('INSERT OR REPLACE INTO expenses (id, data) VALUES (?, ?)').run(expense.id || rand(), JSON.stringify(expense))
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

function saveWorker (worker, deletedId) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    if (deletedId) {
      db.transaction(() => {
        db.prepare('DELETE FROM workers WHERE id = ?').run(deletedId)
        const aIds = db.prepare('SELECT id, data FROM assignments').all()
          .filter(r => { try { return JSON.parse(r.data).workerId === deletedId } catch (_) { return false } })
          .map(r => r.id)
        for (let i = 0; i < aIds.length; i += 900) {
          const chunk = aIds.slice(i, i + 900)
          if (!chunk.length) break
          db.prepare(`DELETE FROM assignments WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk)
        }
        const sIds = db.prepare('SELECT id, data FROM salary_payments').all()
          .filter(r => { try { return JSON.parse(r.data).workerId === deletedId } catch (_) { return false } })
          .map(r => r.id)
        for (let i = 0; i < sIds.length; i += 900) {
          const chunk = sIds.slice(i, i + 900)
          if (!chunk.length) break
          db.prepare(`DELETE FROM salary_payments WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk)
        }
        const cIds = db.prepare('SELECT id, data FROM commission_logs').all()
          .filter(r => { try { return JSON.parse(r.data).workerId === deletedId } catch (_) { return false } })
          .map(r => r.id)
        for (let i = 0; i < cIds.length; i += 900) {
          const chunk = cIds.slice(i, i + 900)
          if (!chunk.length) break
          db.prepare(`DELETE FROM commission_logs WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk)
        }
      })()
      return { ok: true }
    }
    if (!worker) return { ok: false, error: 'No worker data' }
    db.prepare('INSERT OR REPLACE INTO workers (id, data) VALUES (?, ?)').run(worker.id || rand(), JSON.stringify(worker))
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

function saveAssignment (assignment, deletedId) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    if (deletedId) { db.prepare('DELETE FROM assignments WHERE id = ?').run(deletedId); return { ok: true } }
    if (!assignment) return { ok: false, error: 'No assignment data' }
    db.prepare('INSERT OR REPLACE INTO assignments (id, data) VALUES (?, ?)').run(assignment.id || rand(), JSON.stringify(assignment))
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

function saveSalaryPayment (payment, deletedId) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    if (deletedId) { db.prepare('DELETE FROM salary_payments WHERE id = ?').run(deletedId); return { ok: true } }
    if (!payment) return { ok: false, error: 'No payment data' }
    db.prepare('INSERT OR REPLACE INTO salary_payments (id, data) VALUES (?, ?)').run(payment.id || rand(), JSON.stringify(payment))
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

function saveCommLog (log, deletedId) {
  if (!db) return { ok: false, error: 'Database not open' }
  try {
    if (deletedId) { db.prepare('DELETE FROM commission_logs WHERE id = ?').run(deletedId); return { ok: true } }
    if (!log) return { ok: false, error: 'No log data' }
    db.prepare('INSERT OR REPLACE INTO commission_logs (id, data) VALUES (?, ?)').run(log.id || rand(), JSON.stringify(log))
    return { ok: true }
  } catch (err) { return { ok: false, error: err.message } }
}

// ── IPC handler registration ────────────────────────────────────────
function registerHandlers (ipcMain) {
  ipcMain.handle('LOAD', () => {
    if (!db) return null
    try { return readData() }
    catch (e) { console.error('[SO] LOAD error:', e.message); return null }
  })

  ipcMain.handle('SAVE', (e, data) => {
    if (!db) return { ok: false, error: 'Database not open' }
    try { return writeData(data) }
    catch (err) { console.error('[SO] SAVE error:', err.message); return { ok: false, error: err.message } }
  })

  ipcMain.handle('SAVE_IMAGES', (e, { orderId, images }) => {
    try {
      ensureDirs()
      const filenames = (images||[]).map((img, i) => {
        if (!img) return null
        if (img.startsWith('data:')) {
          if (img.length > MAX_IMAGE_B64_LEN) {
            console.warn(`[SO] SAVE_IMAGES: image ${i} skipped — too large (${(img.length/1024/1024).toFixed(1)} MB)`)
            return null
          }
          return saveImageFile(img, orderId, i)
        }
        return img
      }).filter(Boolean)
      return { ok: true, filenames }
    } catch (err) { return { ok: false, error: err.message, filenames: [] } }
  })

  ipcMain.handle('LOAD_IMAGE', (e, filename) => {
    try {
      if (!filename) return null
      const fpath = path.join(paths.imagesDir, filename)
      if (!fs.existsSync(fpath)) return null
      const ext  = path.extname(filename).toLowerCase().slice(1)
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
      return `data:${mime};base64,${fs.readFileSync(fpath).toString('base64')}`
    } catch (_) { return null }
  })

  ipcMain.handle('LOAD_IMAGES', (e, filenames) => {
    const result = {}
    for (const fname of (filenames||[])) {
      if (!fname) continue
      try {
        const fpath = path.join(paths.imagesDir, fname)
        if (!fs.existsSync(fpath)) continue
        const stat = fs.statSync(fpath)
        if (stat.size > MAX_IMAGE_B64_LEN) { console.warn(`[SO] LOAD_IMAGES: skipping large file ${fname} (${(stat.size/1024/1024).toFixed(1)} MB)`); continue }
        const ext  = path.extname(fname).toLowerCase().slice(1)
        const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg'
        result[fname] = `data:${mime};base64,${fs.readFileSync(fpath).toString('base64')}`
      } catch (_) {}
    }
    return result
  })

  ipcMain.handle('DELETE_IMAGES', (e, filenames) => {
    ;(filenames||[]).forEach(deleteImageFile)
    return { ok: true }
  })

  ipcMain.handle('SAVE_CLIENT', (e, data) => {
    return saveClient(data?.clientUid, data?.client, data?.deleted)
  })

  ipcMain.handle('SAVE_ORDER', (e, { clientUid, order }) => {
    return saveOrder(clientUid, order)
  })

  ipcMain.handle('SAVE_COUNTERS', (e, c) => {
    return saveCounters(c)
  })

  ipcMain.handle('SAVE_EXPENSE', (e, { expense, deletedId }) => {
    return saveExpense(expense, deletedId)
  })

  ipcMain.handle('SAVE_WORKER', (e, { worker, deletedId }) => {
    return saveWorker(worker, deletedId)
  })

  ipcMain.handle('SAVE_ASSIGNMENT', (e, { assignment, deletedId }) => {
    return saveAssignment(assignment, deletedId)
  })

  ipcMain.handle('SAVE_SALARY_PAYMENT', (e, { payment, deletedId }) => {
    return saveSalaryPayment(payment, deletedId)
  })

  ipcMain.handle('SAVE_COMM_LOG', (e, { log, deletedId }) => {
    return saveCommLog(log, deletedId)
  })

  ipcMain.handle('DO_BACKUP', () => {
    doBackup(db)
    return { ok: true }
  })

  ipcMain.handle('BACKUP', async () => {
    if (!db) return { ok: false, error: 'Database not open' }
    try {
      const parent = winRef || null
      const r = await dialog.showSaveDialog(parent, {
        title: 'Save Backup',
        defaultPath: path.join(app.getPath('documents'), `SO_Backup_${new Date().toISOString().split('T')[0]}.db`),
        filters: [{ name: 'SQLite Database', extensions: ['db'] }]
      })
      if (!r.canceled && r.filePath) {
        try {
          const buf = db.serialize()
          fs.writeFileSync(r.filePath, buf)
          return { ok: true, path: r.filePath }
        } catch (backupErr) {
          return { ok: false, error: `Backup failed: ${backupErr.message}` }
        }
      }
      return { ok: false }
    } catch (e) { return { ok: false, error: e.message } }
  })

  ipcMain.handle('RESTORE', async () => {
    const parent = winRef || null
    try {
      const r = await dialog.showOpenDialog(parent, {
        title: 'Choose Backup File',
        filters: [{ name: 'SQLite Database', extensions: ['db'] }],
        properties: ['openFile']
      })
      if (!r.canceled && r.filePaths[0]) {
        const Database = require('better-sqlite3')
        let tmp
        try { tmp = new Database(r.filePaths[0], { readonly: true }) } catch (e) {
          return { ok: false, error: `Cannot open backup file: ${e.message}` }
        }
        const ok1 = tmp.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='clients'").get()
        const ok2 = tmp.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='store'").get()
        tmp.close()
        if (!ok1 && !ok2) return { ok: false, error: 'Not a valid Stitch Outfitters backup' }

        if (db) { try { db.close() } catch (_) {}; db = null; _stmts = null }

        try { fs.copyFileSync(r.filePaths[0], paths.dbFile) } catch (copyErr) {
          try { openDB() } catch (_) {}
          return { ok: false, error: `Copy failed: ${copyErr.message}` }
        }

        try { openDB(); return { ok: true } } catch (openErr) {
          return { ok: false, error: `Restore succeeded but DB re-open failed: ${openErr.message}` }
        }
      }
      return { ok: false }
    } catch (e) {
      if (!db) { try { openDB() } catch (_) {} }
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('READY', () => ({ ready: !!db }))
}

function triggerBackup () { doBackup(db) }

module.exports = {
  openDB, closeDB, readData, writeData, isOpen, triggerBackup,
  saveClient, saveOrder, saveCounters,
  saveExpense, saveWorker, saveAssignment, saveSalaryPayment, saveCommLog,
  registerHandlers, setWinRef,
  backupDone, setBackupDone
}
