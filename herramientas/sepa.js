#!/usr/bin/env node
/* Precios oficiales (SEPA) para la Libreta del hogar.

   Baja el archivo del día de «Precios Claros - Base SEPA» (datos abiertos del Estado argentino:
   https://datos.produccion.gob.ar/dataset/sepa-precios) y lo deja listo para la app: un archivo comprimido por
   cuadro del mapa (una décima de grado, como los precios que comparten los hogares), con las sucursales del
   cuadro y, por código de barras, las dos más baratas.

     <salida>/indice.json              { fecha, generado, cadenas, celdas: { cuadro: bytes } }
     <salida>/celdas/<cuadro>.json.gz  { fecha, s: [[cadena, sucursal, dirección, lat, lon]], l: [leyendas],
                                         p: { código de 14 dígitos: [[sucursal, lista, promo1, promo2, leyenda], …] } }

   Uso: node sepa.js <carpeta de salida> [--zip archivo.zip] [--fecha AAAA-MM-DD] [--por-codigo 2]
   Sale con código 3 si el portal todavía no publicó el archivo (o no se pudo bajar): no es un error de la app.
   No usa paquetes: solo Node y el programa «unzip» del sistema. */
'use strict';
const fs = require('fs'), path = require('path'), https = require('https'), zlib = require('zlib');
const { execFileSync, spawn } = require('child_process'), readline = require('readline'), os = require('os');

const args = process.argv.slice(2), opcion = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const SALIDA = args[0] && !args[0].startsWith('--') ? args[0] : null;
if (!SALIDA) { console.error('uso: node sepa.js <carpeta de salida> [--zip archivo.zip] [--fecha AAAA-MM-DD]'); process.exit(1); }
const POR_CODIGO = Math.max(1, Math.min(5, +(opcion('--por-codigo') || 2)));
const CKAN = 'https://datos.produccion.gob.ar/api/3/action/package_show?id=sepa-precios';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------- lo mismo que la app ---------- */
const PASO = 0.1;
const indice = (v, corr) => Math.floor((v + corr) / PASO + 1e-9);
const celda = (lat, lon) => `${indice(lat, 90)}x${indice(lon, 180)}`;
function gtinValido(c) {
  if (!/^(\d{8}|\d{12,14})$/.test(c)) return false;
  const n = c.length;
  let s = 0;
  for (let i = 0; i < n - 1; i++) s += (c.charCodeAt(n - 2 - i) - 48) * (i % 2 === 0 ? 3 : 1);
  return (10 - (s % 10)) % 10 === c.charCodeAt(n - 1) - 48;
}
const canonico = c => c.padStart(14, '0');
const enArgentina = (lat, lon) => isFinite(lat) && isFinite(lon) && lat > -56 && lat < -21 && lon > -74 && lon < -53;

/* ---------- bajar el archivo del día ---------- */
function pedir(url, destino, intentos = 3) {
  return new Promise((ok, mal) => {
    const una = (u, saltos) => {
      const r = https.get(u, { headers: { 'user-agent': 'libreta-del-hogar (precios SEPA)' }, timeout: 60000 }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && saltos < 6) { res.resume(); una(new URL(res.headers.location, u).href, saltos + 1); return; }
        if (res.statusCode !== 200) { res.resume(); mal(new Error(`HTTP ${res.statusCode} en ${u}`)); return; }
        if (!destino) { let b = ''; res.setEncoding('utf8'); res.on('data', d => { b += d; }); res.on('end', () => ok(b)); return; }
        const f = fs.createWriteStream(destino);
        let quieto = setTimeout(() => r.destroy(new Error('sin datos durante 2 minutos')), 120000);
        res.on('data', () => { clearTimeout(quieto); quieto = setTimeout(() => r.destroy(new Error('sin datos durante 2 minutos')), 120000); });
        res.pipe(f);
        f.on('finish', () => { clearTimeout(quieto); f.close(() => ok(destino)); });
        res.on('error', e => { clearTimeout(quieto); mal(e); });
      });
      r.on('timeout', () => r.destroy(new Error('el portal no contesta')));
      r.on('error', mal);
    };
    una(url, 0);
  }).catch(e => (intentos > 1 ? new Promise(r => setTimeout(r, 5000)).then(() => pedir(url, destino, intentos - 1)) : Promise.reject(e)));
}
async function bajar(dir) {
  const j = JSON.parse(await pedir(CKAN));
  const recursos = ((j.result && j.result.resources) || []).filter(r => /zip/i.test(r.format || '') || /\.zip(\?|$)/i.test(r.url || ''));
  if (!recursos.length) throw new Error('el portal no tiene archivos .zip para este conjunto');
  const cuando = r => Date.parse(r.last_modified || r.created || r.metadata_modified || 0) || 0;
  recursos.sort((a, b) => cuando(b) - cuando(a));
  const r = recursos[0], fecha = opcion('--fecha') || new Date(cuando(r) || Date.now()).toISOString().slice(0, 10);
  log('archivo:', r.name || '', r.url, 'del', new Date(cuando(r)).toISOString());
  const destino = path.join(dir, 'sepa.zip');
  await pedir(r.url, destino);
  log('bajado:', (fs.statSync(destino).size / 1048576).toFixed(1), 'MB');
  return { zip: destino, fecha };
}

/* ---------- leer los CSV (separados por «|», con comillas) ---------- */
function partir(linea) {
  if (linea.indexOf('"') < 0) return linea.split('|');
  const out = [];
  let campo = '', comillas = false;
  for (let i = 0; i < linea.length; i++) {
    const ch = linea[i];
    if (comillas) {
      if (ch === '"') { if (linea[i + 1] === '"') { campo += '"'; i++; } else comillas = false; } else campo += ch;
    } else if (ch === '"') comillas = true;
    else if (ch === '|') { out.push(campo); campo = ''; }
    else campo += ch;
  }
  out.push(campo);
  return out;
}
// Recorre un CSV llamando a `fila(objeto)` con los nombres de las columnas (en minúsculas, sin espacios).
async function recorrer(archivo, fila) {
  const rl = readline.createInterface({ input: fs.createReadStream(archivo, { encoding: 'utf8' }), crlfDelay: Infinity });
  let cab = null, n = 0;
  for await (const crudo of rl) {
    const linea = crudo.replace(/^﻿/, '').replace(/\r$/, '');
    if (!linea.trim()) continue;
    const c = partir(linea);
    if (!cab) { cab = c.map(x => x.trim().toLowerCase()); continue; }
    if (c.length < Math.ceil(cab.length / 2)) continue;              // la línea final con la fecha de actualización
    const o = {};
    for (let i = 0; i < cab.length; i++) o[cab[i]] = (c[i] || '').trim();
    fila(o); n++;
  }
  return n;
}
const numero = s => { if (!s) return 0; const t = String(s).trim().replace(/\s/g, ''); const v = Number(/,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '')); return isFinite(v) ? v : 0; };
// Los archivos de una carpeta y sus subcarpetas, menos las «.dir» (los zip ya abiertos, que se procesan aparte).
function buscarArchivos(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/\.dir$/i.test(e.name)) out.push(...buscarArchivos(p)); } else out.push(p);
  }
  return out;
}

/* ---------- juntar por cuadro ---------- */
const cuadros = new Map();           // cuadro → { s: [sucursales], indice: Map(clave → i), l: [leyendas], li: Map, p: Map(código → filas) }
const cadenas = new Set();
let filas = 0, validas = 0;
function cuadroDe(z) {
  if (!cuadros.has(z)) cuadros.set(z, { s: [], indice: new Map(), l: [], li: new Map(), p: new Map() });
  return cuadros.get(z);
}
async function procesar(dir) {
  const archivos = buscarArchivos(dir), de = nombre => archivos.find(a => path.basename(a).toLowerCase() === nombre);
  const fc = de('comercio.csv'), fs_ = de('sucursales.csv'), fp = de('productos.csv');
  if (!fs_ || !fp) return;
  const banderas = new Map();
  if (fc) await recorrer(fc, o => { banderas.set(`${o.id_comercio}|${o.id_bandera}`, o.comercio_bandera_nombre || o.comercio_razon_social || ''); });
  const sucursales = new Map();
  await recorrer(fs_, o => {
    const lat = numero(o.sucursales_latitud), lon = numero(o.sucursales_longitud);
    if (!enArgentina(lat, lon)) return;
    const cadena = (banderas.get(`${o.id_comercio}|${o.id_bandera}`) || '').trim();
    const calle = [o.sucursales_calle, o.sucursales_numero && o.sucursales_numero !== '0' ? o.sucursales_numero : ''].filter(Boolean).join(' ');
    sucursales.set(`${o.id_comercio}|${o.id_bandera}|${o.id_sucursal}`, { cadena, nombre: (o.sucursales_nombre || '').trim(), dir: [calle, o.sucursales_localidad].filter(Boolean).join(', '), lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5, z: celda(lat, lon) });
    if (cadena) cadenas.add(cadena);
  });
  await recorrer(fp, o => {
    filas++;
    const suc = sucursales.get(`${o.id_comercio}|${o.id_bandera}|${o.id_sucursal}`);
    if (!suc) return;
    if (o.productos_ean === '0') return;                                 // un código interno del comercio, no de barras
    const ean = String(o.id_producto || '').replace(/\D/g, '');
    if (!gtinValido(ean)) return;
    const lista = numero(o.productos_precio_lista);
    if (!(lista > 0 && lista < 1e8)) return;
    let p1 = numero(o.productos_precio_unitario_promo1), p2 = numero(o.productos_precio_unitario_promo2);
    if (!(p1 > 0 && p1 < lista && p1 >= lista * 0.3)) p1 = 0;            // una promo de más del 70 % casi siempre está mal cargada
    const efectivo = p1 || lista;
    if (!(p2 > 0 && p2 < efectivo && p2 >= lista * 0.3)) p2 = 0;
    validas++;
    const C = cuadroDe(suc.z), clave = `${suc.cadena}|${suc.nombre}|${suc.lat},${suc.lon}`;
    let si = C.indice.get(clave);
    if (si === undefined) { si = C.s.length; C.indice.set(clave, si); C.s.push([suc.cadena, suc.nombre, suc.dir, suc.lat, suc.lon]); }
    let li = 0;
    if (p2) {
      const ley = (o.productos_leyenda_promo2 || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      li = C.li.get(ley);
      if (li === undefined) { li = C.l.length; C.li.set(ley, li); C.l.push(ley); }
    }
    const k = canonico(ean), fila = [si, Math.round(lista * 100) / 100, Math.round(p1 * 100) / 100, Math.round(p2 * 100) / 100, li];
    const l = C.p.get(k);
    if (!l) { C.p.set(k, [fila]); return; }
    if (l.some(x => x[0] === si)) return;                               // la misma sucursal, repetida
    const ef = x => x[2] || x[1];
    if (l.length < POR_CODIGO) { l.push(fila); l.sort((a, b) => ef(a) - ef(b)); return; }
    if (ef(fila) < ef(l[l.length - 1])) { l[l.length - 1] = fila; l.sort((a, b) => ef(a) - ef(b)); }
  });
}

/* ---------- escribir ---------- */
function escribir(fecha) {
  const tmp = SALIDA + '.nuevo';
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.join(tmp, 'celdas'), { recursive: true });
  const idx = { fecha, generado: new Date().toISOString(), fuente: 'Precios Claros - Base SEPA (datos.produccion.gob.ar)', cadenas: [...cadenas].sort(), celdas: {} };
  let total = 0;
  for (const [z, C] of [...cuadros].sort()) {
    if (!C.p.size) continue;
    // solo las sucursales que quedaron entre las más baratas de algún producto
    const usadas = new Map(), p = {};
    for (const [k, l] of C.p) p[k] = l.map(x => { if (!usadas.has(x[0])) usadas.set(x[0], usadas.size); return x[3] ? [usadas.get(x[0]), x[1], x[2], x[3], x[4]] : x[2] ? [usadas.get(x[0]), x[1], x[2]] : [usadas.get(x[0]), x[1]]; });
    const s = [];
    for (const [i, j] of usadas) s[j] = C.s[i];
    const b = zlib.gzipSync(Buffer.from(JSON.stringify({ fecha, s, l: C.l, p })), { level: 9 });
    fs.writeFileSync(path.join(tmp, 'celdas', z + '.json.gz'), b);
    idx.celdas[z] = b.length; total += b.length;
  }
  fs.writeFileSync(path.join(tmp, 'indice.json'), JSON.stringify(idx, null, 1));
  fs.rmSync(SALIDA, { recursive: true, force: true });
  fs.renameSync(tmp, SALIDA);
  log(`listo: ${Object.keys(idx.celdas).length} cuadros, ${(total / 1048576).toFixed(1)} MB, ${idx.cadenas.length} cadenas, ${validas} de ${filas} precios útiles`);
}

(async () => {
  const trabajo = fs.mkdtempSync(path.join(os.tmpdir(), 'sepa-'));
  let zip = opcion('--zip'), fecha = opcion('--fecha');
  try {
    if (!zip) { try { const b = await bajar(trabajo); zip = b.zip; fecha = fecha || b.fecha; } catch (e) { console.error('No se pudo bajar el archivo del día:', e.message); process.exitCode = 3; return; } }
    fecha = fecha || new Date().toISOString().slice(0, 10);
    const raiz = path.join(trabajo, 'raiz');
    fs.mkdirSync(raiz);
    execFileSync('unzip', ['-q', '-o', zip, '-d', raiz]);
    // el archivo trae un .zip por comercio (a veces anidados): se abren de a uno, para no llenar el disco
    const pendientes = [raiz];
    let n = 0;
    while (pendientes.length) {
      const dir = pendientes.shift();
      for (const a of buscarArchivos(dir).filter(x => /\.zip$/i.test(x))) {
        const d = a.replace(/\.zip$/i, '') + '.dir';
        try { execFileSync('unzip', ['-q', '-o', a, '-d', d]); } catch (e) { log('no se pudo abrir', path.basename(a)); continue; }
        fs.rmSync(a, { force: true });
        pendientes.push(d);
      }
      await procesar(dir);
      if (dir !== raiz) fs.rmSync(dir, { recursive: true, force: true });
      if (++n % 10 === 0) log(`${n} comercios · ${filas} precios leídos`);
    }
    if (!validas) { console.error('El archivo no trajo precios útiles.'); process.exitCode = 3; return; }
    escribir(fecha);
  } finally { fs.rmSync(trabajo, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exitCode = 1; });
