// Arranque de la versión para celular: abre la base desde el almacenamiento privado de la cuenta,
// guarda automáticamente después de cada operación y permite importar/exportar respaldos.
(function () {
  'use strict';
  const CHUNK = 190000; // caracteres por documento (límite del almacén: 256 KiB)
  let resolveReady, rejectReady;
  window.CBM_LOCAL_READY = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });

  // sessionStorage puede no estar disponible dentro del visor: se reemplaza por memoria
  try { window.sessionStorage.getItem('x'); } catch {
    const mem = new Map();
    try { Object.defineProperty(window, 'sessionStorage', { configurable: true, value: { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) } }); } catch { /* sin reemplazo */ }
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const root = () => document.getElementById('root');
  function screen(html) { const r = root(); if (r) r.innerHTML = `<div class="login"><div class="card" style="max-width:460px">${html}</div></div>`; }

  // ---------- Empaquetado: gzip + base64 ----------
  async function gzip(bytes) {
    if (typeof CompressionStream === 'undefined') return { gz: false, bytes };
    const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return { gz: true, bytes: new Uint8Array(await new Response(s).arrayBuffer()) };
  }
  async function gunzip(bytes) {
    const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  function toB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
  function fromB64(b64) { const s = atob(b64); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
  async function pack(bytes) { const z = await gzip(bytes); return { gz: z.gz, data: toB64(z.bytes) }; }
  async function unpack(p) { const raw = fromB64(p.data); return p.gz ? gunzip(raw) : raw; }

  // ---------- Copia en este navegador (respaldo secundario) ----------
  function idb() {
    return new Promise((res, rej) => { try { const r = indexedDB.open('cbm', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); } catch (e) { rej(e); } });
  }
  async function idbGet(k) { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }); }
  async function idbSet(k, v) { const d = await idb(); return new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = () => res(); t.onerror = () => rej(t.error); }); }

  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

  // ---------- Estado de guardado ----------
  let pill;
  function setStatus(kind, text) {
    if (!pill) { pill = document.createElement('div'); pill.className = 'save-pill'; pill.setAttribute('role', 'status'); document.body.appendChild(pill); }
    pill.dataset.kind = kind; pill.textContent = text; pill.hidden = false;
    clearTimeout(pill._t);
    if (kind === 'ok') pill._t = setTimeout(() => { pill.hidden = true; }, 3000); // el aviso de "guardado" se oculta solo
  }

  async function main() {
    screen('<div class="brand-mark">D</div><h1>Chocolate Business Manager</h1><p class="muted" style="text-align:center">Abriendo tus datos…</p>');
    const SQL = await window.initSqlJs();
    let store = null, uid = null;
    try {
      if (window.claude && window.claude.use) {
        store = await window.claude.use('db');
        const user = await window.claude.use('user');
        uid = user ? await user.id() : null;
        if (!uid) store = null;
      }
    } catch { store = null; }
    const col = store ? store.collection('data/users/' + uid) : null;
    let prev = null; // {ver, n} del último guardado en la cuenta
    let bytes = null; let source = null;

    if (col) {
      try {
        const meta = await withTimeout(col.doc('meta').get(), 12000);
        if (meta.exists) {
          const m = meta.data(); const parts = [];
          for (let i = 0; i < m.n; i++) { const d = await withTimeout(col.doc(`c_${m.ver}_${i}`).get(), 12000); if (!d.exists) throw new Error('Falta una parte del guardado.'); parts.push(d.data().d); }
          bytes = await unpack({ gz: m.gz, data: parts.join('') }); prev = { ver: m.ver, n: m.n }; source = 'cuenta';
        }
      } catch (e) { console.warn('No se pudo leer el guardado de la cuenta', e); source = 'error-cuenta'; }
    }
    if (!bytes) {
      try { const local = await idbGet('db'); if (local) { bytes = await unpack(local); source = source === 'error-cuenta' ? 'equipo-sin-cuenta' : 'equipo'; } } catch { /* sin copia local */ }
    }
    if (!bytes && source !== 'error-cuenta') bytes = await onboarding(SQL);
    if (!bytes && source === 'error-cuenta') {
      screen(`<h1>No se pudo abrir tu información</h1><p class="muted">No hubo respuesta del guardado de tu cuenta. Revisa tu conexión a internet y vuelve a abrir la página. No se ha perdido nada.</p>`);
      return;
    }

    const engine = window.CBM_ENGINE.createEngine(SQL, bytes);
    let saving = false, again = false, timer = null;
    async function save() {
      if (saving) { again = true; return; }
      saving = true; setStatus('busy', 'Guardando…');
      try {
        const p = await pack(engine.exportBytes());
        try { await idbSet('db', p); } catch { /* sin copia local */ }
        if (col) {
          const ver = Date.now().toString(36); const n = Math.max(1, Math.ceil(p.data.length / CHUNK));
          for (let i = 0; i < n; i++) await col.doc(`c_${ver}_${i}`).set({ d: p.data.slice(i * CHUNK, (i + 1) * CHUNK) });
          await col.doc('meta').set({ ver, n, gz: p.gz, saved_at: new Date().toISOString(), size: p.data.length });
          const old = prev; prev = { ver, n };
          if (old) for (let i = 0; i < old.n; i++) { try { await col.doc(`c_${old.ver}_${i}`).delete(); } catch { /* se limpia luego */ } }
          setStatus('ok', 'Guardado en tu cuenta');
        } else setStatus('warn', 'Guardado solo en este equipo');
      } catch (e) {
        console.error(e);
        setStatus('bad', e && e.code === 'quota_exceeded' ? 'Sin espacio para guardar: descarga un respaldo' : 'No se pudo guardar. Revisa tu conexión.');
      } finally {
        saving = false;
        if (again) { again = false; save(); }
      }
    }
    const scheduleSave = () => { clearTimeout(timer); setStatus('busy', 'Cambios sin guardar…'); timer = setTimeout(save, 500); };

    window.CBM_LOCAL = {
      account: !!col,
      async request(method, url, body) { const r = await engine.request(method, url, body); if (r.mutated && !r.error) scheduleSave(); return r; },
      async backup() {
        const p = await pack(engine.exportBytes());
        return JSON.stringify({ cbm_backup: 1, saved_at: new Date().toISOString(), gz: p.gz, data: p.data });
      },
      async importFile(file) { const b = await readImport(SQL, file); engine.replace(b); await save(); },
      async download(filename, data) {
        const dl = window.claude && window.claude.use ? await window.claude.use('downloads') : null;
        if (!dl) throw new Error('Este visor no permite descargar archivos.');
        try { await dl.save({ filename, data }); } catch (e) { if (e && e.code === 'declined') return false; throw new Error(e && e.message ? e.message : 'No se pudo descargar.'); }
        return true;
      },
    };
    if (source === 'importado' || source === 'nuevo') await save();
    else setStatus(col ? 'ok' : 'warn', col ? 'Guardado en tu cuenta' : 'Guardado solo en este equipo');
    if (source === 'equipo-sin-cuenta') setStatus('warn', 'Sin conexión con tu cuenta: usando la copia de este equipo');
    resolveReady();

    function onboarding(SQLx) {
      return new Promise(resolve => {
        screen(`<div class="brand-mark">D</div><h1>Bienvenida</h1>
          <p class="muted" style="text-align:center;margin:0 0 16px">Tus datos se guardan de forma privada en tu cuenta de Claude, y los ves desde el celular o la computadora.</p>
          <div class="grid">
            <label class="btn primary" style="justify-content:center;cursor:pointer">Importar mis datos de la laptop<input type="file" id="imp" accept=".db,.json,.sqlite,application/json,application/octet-stream" hidden></label>
            <p class="small muted" style="margin:0">Elige el archivo de respaldo que descargaste en la app de la laptop (Configuración → Datos → Descargar respaldo), o el archivo <b>chocolate.db</b> de la carpeta <b>data</b> con la app apagada.</p>
            <div class="note bad" id="imp-err" hidden></div>
            <button class="btn" id="fresh" type="button" style="justify-content:center">Empezar sin datos</button>
          </div>`);
        const r = root();
        r.querySelector('#imp').addEventListener('change', async e => {
          const f = e.target.files[0]; if (!f) return;
          try { const b = await readImport(SQLx, f); source = 'importado'; resolve(b); }
          catch (err) { const el = r.querySelector('#imp-err'); el.hidden = false; el.textContent = err.message; }
        });
        r.querySelector('#fresh').addEventListener('click', () => { source = 'nuevo'; resolve(null); });
      });
    }
  }

  async function readImport(SQL, file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bytes = buf;
    if (buf[0] === 0x7b) { // respaldo .json de esta versión
      const j = JSON.parse(new TextDecoder().decode(buf));
      if (!j.cbm_backup || !j.data) throw new Error('El archivo no es un respaldo de la app.');
      bytes = await unpack(j);
    }
    return window.CBM_ENGINE.checkBytes(SQL, bytes);
  }

  main().catch(e => { console.error(e); screen(`<h1>No se pudo iniciar</h1><p class="muted">${esc(e.message)}</p>`); rejectReady(e); });
})();
