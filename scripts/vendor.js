// Copia librerías de cliente desde node_modules a public/vendor (sin CDN).
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });
const src = path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, 'chart.umd.js'));
