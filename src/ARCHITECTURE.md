# Stitch Outfitters v5.0 — Architecture

## Directory Structure

```
src/
├── preload.js              # IPC bridge (compression, batching, channel whitelist)
├── main/
│   ├── main.js             # Electron main process (window, IPC handlers)
│   ├── database.js         # SQLite layer (schema, migrations, queries, transactions)
│   ├── backup.js           # Incremental/daily backup, auto-repair
│   └── workers/
│       └── report-generator.js  # Background worker thread for reports
└── renderer/
    ├── index.html          # App shell (651 lines, modular)
    ├── styles/
    │   └── main.css        # Core styles (sidebar trimmed, virtual scroll, modals)
    └── scripts/
        ├── virtual-scroller.js  # VirtualScroll for 1M+ rows
        ├── hot-cache.js         # LRU HotCache + QueryCache
        ├── auto-save.js         # Debounced save with backoff
        └── db-client.js         # Client-side DB abstraction
```

## Database

- **Engine:** SQLite via `better-sqlite3`
- **Journal:** WAL (with checkpoint truncation for cloud sync)
- **Cache:** 128MB page cache + 512MB mmap
- **Sync:** NORMAL (sufficient with WAL)
- **Indexes:** 22 composite/single-column indexes
- **Migrations:** Auto-migration from v3/v4 JSON-column schemas

## Data Flow

```
Renderer (VirtualScroller + HotCache)
    ↓ IPC (paginated queries, 50 rows/request)
Main Process (SQLite with prepared statements)
    ↓
SQLite (WAL, 22 indexes, materialized stats)
```

## Key Numbers

| Metric | v4 (old) | v5 (new) |
|--------|----------|----------|
| RAM at 5M orders | ~1.5-2GB (crash) | ~80-150MB |
| DOM nodes | All rows | ~300 (virtual) |
| Search | Array.filter (seconds) | SQL LIKE (5ms) |
| Save | Full serialize (3-5s) | Targeted upsert (10ms) |
| Integrity | None | `quick_check` every 4h |
| Backup | Daily only | Incremental every 15min |
