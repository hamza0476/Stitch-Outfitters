/**
 * report-generator.js — Worker Thread
 * 
 * Generates reports in a background thread to avoid UI freeze.
 * Receives DB path + params via workerData, runs queries, returns aggregated result.
 */

const { workerData, parentPort } = require('worker_threads')

try {
  const Database = require('better-sqlite3')
  const db = new Database(workerData.dbFile, { readonly: true, timeout: 30000 })

  const { reportType, fromDate, toDate, filters } = workerData.data || {}
  let result = {}

  switch (reportType) {
    case 'revenue': {
      const rows = db.prepare(`
        SELECT 
          strftime('%Y-%m', paid_date) as month,
          COUNT(*) as order_count,
          SUM(CASE WHEN pay_status='paid' THEN price ELSE COALESCE(advance,0) END) as revenue
        FROM orders 
        WHERE paid_date IS NOT NULL 
          AND paid_date >= ? AND paid_date <= ?
        GROUP BY strftime('%Y-%m', paid_date)
        ORDER BY month
      `).all(fromDate || '2000-01-01', toDate || '2099-12-31')
      result = { rows }
      break
    }
    case 'expenses': {
      const rows = db.prepare(`
        SELECT 
          strftime('%Y-%m', date) as month,
          category,
          SUM(amount) as total
        FROM expenses
        WHERE date >= ? AND date <= ?
        GROUP BY strftime('%Y-%m', date), category
        ORDER BY month, category
      `).all(fromDate || '2000-01-01', toDate || '2099-12-31')
      result = { rows }
      break
    }
    case 'profit_loss': {
      const revenue = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN pay_status='paid' THEN price ELSE COALESCE(advance,0) END),0) as total
        FROM orders WHERE paid_date >= ? AND paid_date <= ?
      `).get(fromDate || '2000-01-01', toDate || '2099-12-31')
      const expenses = db.prepare(`
        SELECT COALESCE(SUM(amount),0) as total
        FROM expenses WHERE date >= ? AND date <= ?
      `).get(fromDate || '2000-01-01', toDate || '2099-12-31')
      result = {
        revenue: revenue.total,
        expenses: expenses.total,
        profit: revenue.total - expenses.total
      }
      break
    }
    case 'worker_performance': {
      const rows = db.prepare(`
        SELECT 
          w.id, w.name, w.specialty,
          COUNT(a.id) as total_assignments,
          SUM(CASE WHEN a.progress='completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN a.progress='pending' THEN 1 ELSE 0 END) as pending
        FROM workers w
        LEFT JOIN assignments a ON a.worker_id = w.id
        WHERE a.date >= ? AND a.date <= ?
        GROUP BY w.id
        ORDER BY completed DESC
      `).all(fromDate || '2000-01-01', toDate || '2099-12-31')
      result = { rows }
      break
    }
    case 'inventory_summary': {
      const rows = db.prepare(`
        SELECT 
          category,
          COUNT(*) as item_count,
          SUM(quantity) as total_quantity,
          SUM(CASE WHEN quantity <= min_stock THEN 1 ELSE 0 END) as low_stock_items
        FROM inventory
        GROUP BY category
        ORDER BY category
      `).all()
      result = { rows }
      break
    }
    default:
      result = { error: 'Unknown report type: ' + reportType }
  }

  db.close()
  parentPort.postMessage({ ok: true, data: result })
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message })
}
