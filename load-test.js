/**
 * Load test — Stitch Outfitters
 * Tests performance at scale: 10K, 50K, 100K clients with orders.
 * Run: node load-test.js
 */
'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')

// Use a temp test DB to avoid touching the real one
const tmpDir = path.join(os.tmpdir(), 'so-load-test-' + Date.now())
fs.mkdirSync(tmpDir, { recursive: true })
const dbFile = path.join(tmpDir, 'test.db')

// ── Helpers ───────────────────────────────────────────────────────────────
const rand = () => Math.random().toString(36).slice(2, 10)
const rng = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
const pick = arr => arr[rng(0, arr.length - 1)]

const firstNames = ['Ahmad','Ali','Sana','Fatima','Omar','Zainab','Hassan','Noor','Bilal','Aisha',
  'Usman','Mariam','Tariq','Khadija','Rayan','Hira','Imran','Sara','Farhan','Zara',
  'Kamran','Lubna','Naveed','Rabia','Shahid','Yasmin','Asif','Tahira','Junaid','Parveen',
  'Danish','Shabnam','Fahad','Nasreen','Waqar','Shazia','Adnan','Saima','Shoaib','Mehwish']
const lastNames = ['Khan','Ahmed','Ali','Hussain','Iqbal','Malik','Shah','Mirza','Butt','Hashmi',
  'Sheikh','Siddiqui','Qureshi','Ansari','Syed','Rana','Farooqi','Niazi','Gill','Chaudhry']
const cities = ['Karachi','Lahore','Islamabad','Peshawar','Quetta','Multan','Faisalabad','Rawalpindi','Sialkot','Gujranwala']
const garments = ['Shalwar Kameez','Lehenga','Sherwani','Kurta','Waistcoat','Suit','Dress','Kameez','Nehru Jacket','Trousers']
const statuses = ['pending','completed','delivered']
const payStatuses = ['unpaid','partial','paid']
const tags = ['regular','physical','online']

function generateClient(id) {
  const fn = pick(firstNames)
  const ln = pick(lastNames)
  return {
    uid: `so-${1000 + id}`,
    name: `${fn} ${ln}`,
    phone: `+92${String(300 + rng(0, 999)).padStart(3, '0')}${String(rng(1000000, 9999999))}`,
    email: `${fn.toLowerCase()}.${ln.toLowerCase()}.${id}@email.com`,
    age: String(rng(18, 70)),
    city: pick(cities),
    address: `${rng(1, 999)}, ${pick(['Main St','Market Rd','Hospital Rd','College Rd','Mall Rd'])}`,
    tag: pick(tags),
    addedDate: `202${rng(3,6)}-${String(rng(1,12)).padStart(2,'0')}-${String(rng(1,28)).padStart(2,'0')}`,
    measurements: null,
    orderList: []
  }
}

function generateOrder(cId, oId) {
  const qty = rng(1, 5)
  const price = rng(500, 15000)
  const disc = rng(0, Math.round(price * 0.3))
  const daysAgo = rng(0, 365)
  const d = new Date()
  d.setDate(d.getDate() - daysAgo + rng(7, 90))
  const del = d.toISOString().split('T')[0]
  return {
    id: `ORD-${oId}`,
    orders: qty,
    price,
    discount: disc,
    delivery: del,
    status: pick(statuses),
    payStatus: pick(payStatuses),
    advance: Math.round(price * (Math.random() * 0.5)),
    paidDate: null,
    garment: pick(garments),
    fabric: pick(['Cotton','Silk','Wool','Linen','Polyester','Velvet','Chiffon','Georgette']),
    design: pick(['Traditional','Modern','Simple','Embroidery','Digital Print']),
    images: [],
    invFabricId: null,
    invFabricUsed: 0
  }
}

// ── Database schema (mirrors main.js openDB) ─────────────────────────────
let db
function openDB() {
  const Database = require('better-sqlite3')
  db = new Database(dbFile, { timeout: 5000 })
  db.pragma('journal_mode = DELETE')
  db.pragma('cache_size = -32768')
  db.pragma('synchronous = FULL')
  db.pragma('temp_store = MEMORY')
  db.pragma('mmap_size = 268435456')

  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      uid TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
      email TEXT DEFAULT '', age TEXT DEFAULT '', city TEXT DEFAULT '', address TEXT DEFAULT '',
      tag TEXT DEFAULT 'regular', added_date TEXT DEFAULT '', measurements TEXT DEFAULT NULL,
      extra TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, client_uid TEXT NOT NULL REFERENCES clients(uid) ON DELETE CASCADE,
      orders INTEGER DEFAULT 1, price REAL DEFAULT 0, discount REAL DEFAULT 0,
      delivery TEXT DEFAULT '', status TEXT DEFAULT 'pending', pay_status TEXT DEFAULT 'unpaid',
      advance REAL DEFAULT 0, paid_date TEXT DEFAULT NULL, garment TEXT DEFAULT '',
      fabric TEXT DEFAULT '', design TEXT DEFAULT '', images TEXT DEFAULT '[]',
      inv_fabric_id TEXT DEFAULT NULL, inv_fabric_used REAL DEFAULT 0, extra TEXT DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS expenses (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS inventory (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS inv_history (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS salary_payments (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS commission_logs (id TEXT PRIMARY KEY, data TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS counters (id INTEGER PRIMARY KEY CHECK (id = 1), uid_c INTEGER DEFAULT 1000,
      ord_c INTEGER DEFAULT 1, wrk_c INTEGER DEFAULT 1, ass_c INTEGER DEFAULT 1, exp_c INTEGER DEFAULT 1,
      inv_c INTEGER DEFAULT 1, sal_c INTEGER DEFAULT 1, comm_c INTEGER DEFAULT 1);
    INSERT OR IGNORE INTO counters (id) VALUES (1);
    CREATE INDEX IF NOT EXISTS idx_orders_client_uid ON orders(client_uid);
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_pay_status ON orders(pay_status);
    CREATE INDEX IF NOT EXISTS idx_orders_delivery ON orders(delivery);
    CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
    CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
    CREATE INDEX IF NOT EXISTS idx_clients_added_date ON clients(added_date);
    CREATE INDEX IF NOT EXISTS idx_orders_status_pay ON orders(status, pay_status);
    CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery, status);
  `)
}

// ── Progress bar ─────────────────────────────────────────────────────────
function progress(current, total, label) {
  const pct = ((current / total) * 100).toFixed(1)
  const barLen = 30
  const filled = Math.round((current / total) * barLen)
  const bar = '█'.repeat(filled) + '░'.repeat(barLen - filled)
  process.stdout.write(`\r${label}: [${bar}] ${pct}% (${current}/${total})`)
}

// ── Batch insert ─────────────────────────────────────────────────────────
function populateData(numClients, avgOrdersPerClient) {
  console.log(`\n=== Populating ${numClients.toLocaleString()} clients × ~${avgOrdersPerClient} orders ===\n`)

  const iC = db.prepare(`INSERT INTO clients (uid,name,phone,email,age,city,address,tag,added_date,measurements,extra)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(uid) DO NOTHING`)
  const iO = db.prepare(`INSERT INTO orders (id,client_uid,orders,price,discount,delivery,status,pay_status,advance,paid_date,garment,fabric,design,images,inv_fabric_id,inv_fabric_used,extra)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`)

  const batchSize = 500
  let totalOrders = 0

  for (let start = 0; start < numClients; start += batchSize) {
    const end = Math.min(start + batchSize, numClients)

    db.transaction(() => {
      for (let i = start; i < end; i++) {
        const c = generateClient(i + 1)
        iC.run(c.uid, c.name, c.phone, c.email, c.age, c.city, c.address, c.tag, c.addedDate, null, '{}')
        // Generate variable number of orders per client
        const numOrders = Math.random() < 0.15 ? 0 : rng(1, avgOrdersPerClient * 2)
        for (let j = 0; j < numOrders; j++) {
          const o = generateOrder(c.uid, ++totalOrders)
          iO.run(o.id, c.uid, o.orders, o.price, o.discount, o.delivery, o.status, o.payStatus, o.advance,
            o.paidDate, o.garment, o.fabric, o.design, JSON.stringify([]), null, 0, '{}')
        }
      }
    })()

    progress(end, numClients, 'Inserting')
  }

  // Update counters
  db.prepare('UPDATE counters SET uid_c=?,ord_c=? WHERE id=1').run(1000 + numClients, totalOrders + 1)
  console.log(`\nDone. ${numClients.toLocaleString()} clients, ${totalOrders.toLocaleString()} orders`)

  // Show DB file size
  const stat = fs.statSync(dbFile)
  const mb = (stat.size / 1024 / 1024).toFixed(1)
  console.log(`DB file size: ${mb} MB`)

  return totalOrders
}

// ── Benchmark queries ────────────────────────────────────────────────────
function runBenchmarks(label) {
  console.log(`\n── Benchmarks: ${label} ──`)

  // 1. SELECT clients ORDER BY rowid (as readData does)
  let start = Date.now()
  const allClients = db.prepare('SELECT * FROM clients ORDER BY rowid').all()
  const clientMs = Date.now() - start
  console.log(`  SELECT * FROM clients ORDER BY rowid:         ${clientMs} ms (${allClients.length} rows)`)

  // 2. SELECT orders with client_uid sort (as readData does)
  start = Date.now()
  const allOrders = db.prepare('SELECT * FROM orders ORDER BY client_uid, rowid').all()
  const orderMs = Date.now() - start
  console.log(`  SELECT * FROM orders ORDER BY client_uid:      ${orderMs} ms (${allOrders.length} rows)`)

  // 3. Counts
  start = Date.now()
  const cnt = db.prepare('SELECT COUNT(*) as n FROM clients').get()
  console.log(`  COUNT clients:                                 ${Date.now() - start} ms (${cnt.n})`)

  start = Date.now()
  const ocnt = db.prepare('SELECT COUNT(*) as n FROM orders').get()
  console.log(`  COUNT orders:                                  ${Date.now() - start} ms (${ocnt.n})`)

  // 4. Indexed query — active clients
  start = Date.now()
  const active = db.prepare(`SELECT COUNT(*) as n FROM orders WHERE status='pending'
    AND pay_status IN ('unpaid','partial')`).get()
  console.log(`  Active orders query (composite index):          ${Date.now() - start} ms (${active.n})`)

  // 5. Indexed query — overdue
  start = Date.now()
  const overdue = db.prepare(`SELECT COUNT(*) as n FROM orders WHERE delivery < '2026-05-23'
    AND status='pending'`).get()
  console.log(`  Overdue orders query (composite index):         ${Date.now() - start} ms (${overdue.n})`)

  // 6. Phone lookup (indexed)
  start = Date.now()
  if (allClients.length > 0) {
    const samplePhone = allClients[rng(0, allClients.length - 1)].phone
    const found = db.prepare('SELECT uid,name FROM clients WHERE phone = ?').get(samplePhone)
    console.log(`  Phone lookup (indexed):                         ${Date.now() - start} ms (found: ${found?.name || 'none'})`)
  }

  // 7. Client name search (like + index)
  start = Date.now()
  const search = db.prepare("SELECT uid,name FROM clients WHERE name LIKE ? LIMIT 20").all('%Khan%')
  console.log(`  Name search LIKE (indexed):                     ${Date.now() - start} ms (${search.length} results)`)

  // 8. writeData simulation: single target save
  start = Date.now()
  const tx = db.transaction(() => {
    if (allClients.length > 0) {
      const c = allClients[0]
      db.prepare("UPDATE clients SET name = ? WHERE uid = ?").run(c.name + '.', c.uid)
      db.prepare("UPDATE clients SET name = ? WHERE uid = ?").run(c.name.replace(/\.$/, ''), c.uid)
    }
  })
  tx()
  console.log(`  Single-row update (targeted save):              ${Date.now() - start} ms`)

  // 9. Memory usage
  const mem = process.memoryUsage()
  console.log(`  Heap used:                                     ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  Heap total:                                    ${(mem.heapTotal / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  RSS:                                           ${(mem.rss / 1024 / 1024).toFixed(1)} MB`)
}

// ── Test readData (mirrors main.js readData) ──────────────────────────────
function testReadDataSimulation() {
  console.log(`\n── readData() simulation (full load) ──`)
  const start = Date.now()

  // Build orders by client
  const ordersByClient = {}
  const oStart = Date.now()
  for (const o of db.prepare('SELECT * FROM orders ORDER BY client_uid, rowid').all()) {
    ;(ordersByClient[o.client_uid] ||= []).push({
      id: o.id, orders: o.orders, price: o.price, discount: o.discount,
      delivery: o.delivery, status: o.status, payStatus: o.pay_status,
      advance: o.advance, garment: o.garment, fabric: o.fabric, design: o.design,
      images: [], invFabricId: null, invFabricUsed: 0
    })
  }
  console.log(`  Build orders map: ${Date.now() - oStart} ms (${Object.keys(ordersByClient).length} clients with orders)`)

  // Map clients
  const cStart = Date.now()
  const clients = db.prepare('SELECT * FROM clients ORDER BY rowid').all().map(c => ({
    uid: c.uid, name: c.name, phone: c.phone, email: c.email,
    age: c.age, city: c.city, address: c.address, tag: c.tag,
    addedDate: c.added_date,
    orderList: ordersByClient[c.uid] || []
  }))
  console.log(`  Map clients: ${Date.now() - cStart} ms (${clients.length} clients)`)

  // Read blob tables
  const bStart = Date.now()
  const workers = db.prepare('SELECT data FROM workers ORDER BY rowid').all()
  const expenses = db.prepare('SELECT data FROM expenses ORDER BY rowid').all()
  console.log(`  Blob tables: ${Date.now() - bStart} ms`)

  const total = Date.now() - start
  console.log(`  TOTAL readData() simulation: ${total} ms`)

  // Estimated memory for JS objects
  const estimatedMB = (Buffer.byteLength(JSON.stringify(clients.slice(0, 1000)), 'utf8') / 1024 / 1024 * (clients.length / 1000)).toFixed(1)
  console.log(`  Estimated JSON size of full data: ~${estimatedMB} MB`)
}

// ── Test IPC serialization ───────────────────────────────────────────────
function testIPCSerialization(numClients) {
  console.log(`\n── IPC Serialization test ──`)
  const sample = db.prepare('SELECT * FROM clients LIMIT ?').all(Math.min(numClients, 50000))

  const start = Date.now()
  const json = JSON.stringify(sample)
  const jsonMB = (Buffer.byteLength(json, 'utf8') / 1024 / 1024).toFixed(1)
  console.log(`  Serialize ${sample.length} clients to JSON: ${Date.now() - start} ms (${jsonMB} MB)`)

  // Extrapolate for full dataset
  const total = db.prepare('SELECT COUNT(*) as n FROM clients').get().n
  const estMB = (parseFloat(jsonMB) / sample.length * total).toFixed(1)
  console.log(`  Estimated full serialize (${total} clients): ~${estMB} MB`)
}

// ── Verify index usage ────────────────────────────────────────────────────
function verifyIndexUsage() {
  console.log(`\n── Index verification (EXPLAIN QUERY PLAN) ──`)
  const queries = [
    ['SELECT * FROM orders WHERE status=?', ['pending']],
    ['SELECT * FROM orders WHERE client_uid=?', ['so-1001']],
    ['SELECT * FROM orders WHERE status=? AND pay_status=?', ['pending', 'unpaid']],
    ['SELECT * FROM orders WHERE delivery<? AND status=?', ['2026-01-01', 'pending']],
    ['SELECT * FROM clients WHERE phone=?', ['+923001234567']],
    ['SELECT * FROM clients WHERE name LIKE ?', ['%Khan%']],
  ]
  for (const [sql, params] of queries) {
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params)
    const detail = plan.map(r => r.detail).join(' | ')
    const usesIndex = detail.includes('USING INDEX') || detail.includes('USING COVERING INDEX')
    console.log(`  ${usesIndex ? '✅' : '❌'} ${sql.slice(0, 60)}... → ${detail.slice(0, 120)}`)
  }
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(70))
  console.log('  STITCH OUTFITTERS — LOAD TEST')
  console.log('='.repeat(70))
  console.log(`Temp DB: ${dbFile}`)

  openDB()
  console.log('Database opened')

  // Track times
  const levels = [
    { clients: 10000, avgOrders: 3, label: '10K clients' },
    { clients: 50000, avgOrders: 3, label: '50K clients' },
  ]

  for (const level of levels) {
    populateData(level.clients, level.avgOrders)
    runBenchmarks(level.label)
    testIPCSerialization(level.clients)
    verifyIndexUsage()
    testReadDataSimulation()

    // Clean DB between levels for clean timing
    if (level !== levels[levels.length - 1]) {
      console.log('\n--- Clearing for next level ---')
      db.exec('DELETE FROM orders')
      db.exec('DELETE FROM clients')
      db.exec('UPDATE counters SET uid_c=1000, ord_c=1 WHERE id=1')
    }
  }

  // Summary
  console.log('\n' + '='.repeat(70))
  console.log('  SUMMARY')
  console.log('='.repeat(70))

  const finalStat = fs.statSync(dbFile)
  console.log(`Final DB size: ${(finalStat.size / 1024 / 1024).toFixed(1)} MB`)
  const mem = process.memoryUsage()
  console.log(`Process RSS: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`)
  console.log(`Heap used: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`)

  const totalClients = db.prepare('SELECT COUNT(*) as n FROM clients').get().n
  const totalOrders = db.prepare('SELECT COUNT(*) as n FROM orders').get().n
  console.log(`Total clients: ${totalClients.toLocaleString()}`)
  console.log(`Total orders: ${totalOrders.toLocaleString()}`)

  // Extrapolation for 1M clients / 5M orders
  const dbMB = finalStat.size / 1024 / 1024
  const estDBSize1M = (dbMB / totalClients * 1000000).toFixed(1)
  const estRSS1M = (mem.rss / 1024 / 1024 / totalClients * 1000000).toFixed(1)
  console.log(`\n── Extrapolation for 1M clients / 5M orders ──`)
  console.log(`Estimated DB size: ~${estDBSize1M} MB`)
  console.log(`Estimated RSS: ~${estRSS1M} MB`)
  console.log(`Note: readData() loads ALL rows into JS memory.
  At 1M clients the heap will exceed available RAM and crash.
  The scalable v5 architecture (npm run start:scalable)
  uses paginated queries and virtual scrolling for this scale.`)

  // Cleanup
  db.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log('\nTemp DB cleaned up.')
}

main().catch(e => { console.error('Test error:', e); process.exit(1) })
