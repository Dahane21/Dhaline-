// Genera dist-mobile/index.html: la app completa en un solo archivo que corre dentro del navegador
// (para publicarla como página y usarla desde el celular, sin servidor propio).
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-mobile');
fs.mkdirSync(out, { recursive: true });

// Reemplaza el acceso a SQLite de Node por sql.js y usa la versión de navegador de ExcelJS
const browserShims = {
  name: 'browser-shims',
  setup(b) {
    b.onResolve({ filter: /^(\.\.?\/)+db$/ }, () => ({ path: path.join(root, 'server', 'db-browser.js') }));
    b.onResolve({ filter: /^exceljs$/ }, () => ({ path: path.join(root, 'node_modules', 'exceljs', 'dist', 'exceljs.min.js') }));
  },
};

async function bundle(entry, opts = {}) {
  const r = await esbuild.build({ entryPoints: [entry], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2020', minify: true, charset: 'ascii', legalComments: 'none', logLevel: 'warning', ...opts });
  return r.outputFiles[0].text;
}
const safe = js => js.replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--');

(async () => {
  const engine = await bundle(path.join(root, 'mobile', 'engine.js'), { plugins: [browserShims] });
  const ui = await bundle(path.join(root, 'public', 'js', 'app.js'));
  const boot = await bundle(path.join(root, 'mobile', 'boot.js'));
  const ascii = async f => (await esbuild.transform(fs.readFileSync(f, 'utf8'), { charset: 'ascii', minifyWhitespace: true })).code;
  const sql = await ascii(path.join(root, 'node_modules', 'sql.js', 'dist', 'sql-asm-memory-growth.js'));
  const chart = await ascii(path.join(root, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'));
  const css = fs.readFileSync(path.join(root, 'public', 'css', 'app.css'), 'utf8').replace(/[^\x00-\x7f]/g, c => '\\' + c.codePointAt(0).toString(16) + ' ');
  const html = `<title>Dhaline &middot; Gesti&oacute;n</title>
<meta name="description" content="Compras, inventario, producci&oacute;n, ventas y finanzas de Dhaline.">
<style>${css}</style>
<div id="root"><div class="empty">Cargando&hellip;</div></div>
<script>${safe(sql)}</script>
<script>${safe(chart)}</script>
<script>${safe(engine)}</script>
<script>${safe(boot)}</script>
<script>${safe(ui)}</script>
`;
  fs.writeFileSync(path.join(out, 'index.html'), html);
  console.log(`dist-mobile/index.html ${(html.length / 1024 / 1024).toFixed(2)} MB`);
})().catch(e => { console.error(e); process.exit(1); });
