'use strict';
const path = require('path');
const fs = require('fs');
const { createApp } = require('./app');

const DATA = process.env.CBM_DATA_DIR || path.join(__dirname, '..', 'data');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const backupDir = path.join(DATA, 'backups');
const dbFile = path.join(DATA, 'chocolate.db');

const isNew = !fs.existsSync(dbFile);
const { server, db } = createApp({ dbFile, backupDir });
// Respaldo automático al iniciar (si la base ya existía)
if (!isNew) {
  try { fs.mkdirSync(backupDir, { recursive: true }); const stamp = new Date().toISOString().slice(0, 10); const f = path.join(backupDir, `cbm-auto-${stamp}.db`); if (!fs.existsSync(f)) db.backupTo(f); } catch (e) { console.warn('No se pudo crear respaldo automático:', e.message); }
}
server.listen(PORT, HOST, () => console.log(`Chocolate Business Manager en http://${HOST}:${PORT}  (datos: ${dbFile})`));
const stop = () => { server.close(); try { db.close(); } catch {} process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
