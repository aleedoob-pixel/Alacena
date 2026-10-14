/* Los avisos de la Libreta del hogar: lo corre la tarea «Avisos» de GitHub cada ~10 minutos.
   Mira en Firestore lo nuevo desde la vez anterior y manda notificaciones con Firebase Cloud Messaging:
     · lo que pasó en un hogar (eventos/): alguien anotó algo en la lista, va al súper, dejó una nota, cargó un gasto
       o se sumó; le llega al resto de los integrantes;
     · lo nuevo de la zona: precios (precios/, campo ts) y promos (promos/, campo ts); a cada teléfono le llegan los de
       sus zonas, y con prioridad «más barato cerca» si es algo que su hogar compra y lo pagó más.
   Cada teléfono dice qué avisos quiere en su suscripción (suscripciones/).
   Necesita la cuenta de servicio del proyecto de Firebase (el JSON entero) en la variable FIREBASE_SA, que en GitHub
   es un «secret». Sin ella no hace nada. No usa paquetes: solo Node 20.
   Uso: FIREBASE_SA='{…}' node avisos.js */
'use strict';
const crypto = require('crypto');

const E = process.env;
const MIN = 60000, DIA = 86400000;
const MARGEN = 20000;                 // lo de los últimos 20 segundos queda para la vuelta siguiente (por si todavía se está guardando)
const TOPE_POR_TELEFONO = 5;          // avisos por teléfono en cada vuelta, como mucho
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const plata = n => '$ ' + new Intl.NumberFormat('es-AR', { maximumFractionDigits: 2 }).format(n);

/* ---------- la cuenta de servicio ---------- */
function cuenta() {
  let sa;
  try { sa = JSON.parse(E.FIREBASE_SA || ''); } catch (e) { sa = null; }
  if (!sa || !sa.project_id || !sa.client_email || !sa.private_key) return null;
  return sa;
}
const b64u = b => Buffer.from(b).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
async function acceso(sa) {
  if (E.AVISOS_SIN_TOKEN) return 'prueba';
  const ahora = Math.floor(Date.now() / 1000), url = E.AVISOS_TOKEN_URL || sa.token_uri || 'https://oauth2.googleapis.com/token';
  const cab = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const cuerpo = b64u(JSON.stringify({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase.messaging', aud: url, iat: ahora, exp: ahora + 3600 }));
  const firma = b64u(crypto.createSign('RSA-SHA256').update(`${cab}.${cuerpo}`).sign(sa.private_key));
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${cab}.${cuerpo}.${firma}` }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error('Google no dio el acceso: ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

/* ---------- Firestore por REST ---------- */
function valor(x) {
  if (!x || typeof x !== 'object') return null;
  if ('stringValue' in x) return x.stringValue;
  if ('integerValue' in x) return Number(x.integerValue);
  if ('doubleValue' in x) return Number(x.doubleValue);
  if ('booleanValue' in x) return x.booleanValue;
  if ('timestampValue' in x) return Date.parse(x.timestampValue);
  if ('nullValue' in x) return null;
  if ('mapValue' in x) return campos(x.mapValue.fields || {});
  if ('arrayValue' in x) return (x.arrayValue.values || []).map(valor);
  return null;
}
const campos = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, valor(v)]));
function crearFirestore(sa, token) {
  const raiz = (E.AVISOS_FIRESTORE || 'https://firestore.googleapis.com/v1') + `/projects/${sa.project_id}/databases/(default)/documents`;
  const cab = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const pedir = async (url, op) => {
    const r = await fetch(url, Object.assign({ headers: cab }, op));
    if (r.status === 404 && (!op || op.method !== 'DELETE')) return null;
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Firestore ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
    return j;
  };
  const doc = d => Object.assign({ _id: d.name.split('/').pop(), _ruta: d.name.split('/documents/')[1] }, campos(d.fields));
  return {
    // los de una colección con un campo de fecha dentro de (desde, hasta]
    async entre(col, campo, desde, hasta) {
      const where = { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: campo }, op: 'GREATER_THAN', value: { timestampValue: new Date(desde).toISOString() } } },
        { fieldFilter: { field: { fieldPath: campo }, op: 'LESS_THAN_OR_EQUAL', value: { timestampValue: new Date(hasta).toISOString() } } }] } };
      const j = await pedir(`${raiz}:runQuery`, { method: 'POST', body: JSON.stringify({ structuredQuery: { from: [{ collectionId: col }], where, orderBy: [{ field: { fieldPath: campo } }], limit: 1000 } }) });
      return (j || []).filter(x => x.document).map(x => doc(x.document));
    },
    async todos(col) {
      const out = [];
      let tk = '';
      for (let i = 0; i < 50; i++) {
        const j = await pedir(`${raiz}/${col}?pageSize=300${tk ? '&pageToken=' + encodeURIComponent(tk) : ''}`);
        for (const d of (j && j.documents) || []) out.push(doc(d));
        tk = j && j.nextPageToken;
        if (!tk) break;
      }
      return out;
    },
    async leer(ruta) { const j = await pedir(`${raiz}/${ruta}`); return j ? doc(j) : null; },
    async fecha(ruta, campo, ms) {
      await pedir(`${raiz}/${ruta}?updateMask.fieldPaths=${campo}`, { method: 'PATCH', body: JSON.stringify({ fields: { [campo]: { timestampValue: new Date(ms).toISOString() } } }) });
    },
    async texto(ruta, campo, v) {
      await pedir(`${raiz}/${ruta}?updateMask.fieldPaths=${campo}`, { method: 'PATCH', body: JSON.stringify({ fields: { [campo]: { stringValue: v } } }) });
    },
    async borrar(ruta) { try { await pedir(`${raiz}/${ruta}`, { method: 'DELETE' }); } catch (e) { log('no se pudo borrar', ruta, e.message); } },
  };
}

/* ---------- qué avisar a quién ----------
   Puro, para poder probarlo: recibe lo nuevo y las suscripciones y devuelve Map(id de suscripción → [aviso]). */
const TITULOS = { lista: ['Lista de compras', './#compras'], voy: ['Va al súper', './#compras'], nota: ['Nota del hogar', './'], gasto: ['Gastos del hogar', './#gastos'], miembro: ['Tu hogar', './'] };
const quiere = (s, tipo) => !s.prefs || s.prefs[tipo] !== false;
function armar({ eventos, precios, promos, subs, resumen }) {
  const out = new Map(), poner = (s, a) => { if (!out.has(s._id)) out.set(s._id, []); out.get(s._id).push(a); };
  for (const ev of eventos) {
    const [titulo, url] = TITULOS[ev.tipo] || [];
    if (!titulo || !ev.texto) continue;
    for (const s of subs) if (s.hogar && s.hogar === ev.h && s.uid !== ev.de && quiere(s, ev.tipo)) poner(s, { tipo: ev.tipo, titulo, cuerpo: ev.texto, url, tag: ev.tipo });
  }
  for (const p of precios) {
    if (typeof p.t !== 'string' || !(p.p > 0) || !(p.v >= Math.floor(Date.now() / DIA) - 1)) continue;
    for (const s of subs) {
      if (!Array.isArray(s.zonas) || !s.zonas.includes(p.z) || (s.propios || []).includes(p._id)) continue;
      const mio = s.claves && s.claves[p.e], tope = s.alertas && s.alertas[p.e];
      if (tope > 0 && p.p <= tope) {      // «avisame cuando baje»: lo pidió la persona, va siempre
        poner(s, { tipo: 'alerta', titulo: '¡Bajó!', cuerpo: `${p.t}: ${plata(p.p)} en ${p.n || 'un comercio'}. Pediste que te avise por debajo de ${plata(tope)}.`, url: './#novedades', tag: 'alerta-' + p.e });
      } else if (mio > 0 && p.p <= mio * 0.97 && quiere(s, 'baratos')) {
        poner(s, { tipo: 'baratos', titulo: 'Más barato cerca', cuerpo: `${p.t}: ${plata(p.p)} en ${p.n || 'un comercio'}. Tu hogar lo pagó ${plata(mio)}.`, url: './#novedades', tag: 'baratos-' + p.e });
      } else if (quiere(s, 'avisos')) {
        poner(s, { tipo: 'avisos', titulo: 'Precio nuevo en tu zona', cuerpo: `${p.t}: ${plata(p.p)} en ${p.n || 'un comercio'}${p.h ? ` · lo avisó ${p.h}` : ''}`, url: './#novedades', tag: 'avisos' });
      }
    }
  }
  for (const pr of promos) {
    if (!pr.t) continue;
    for (const s of subs) if (Array.isArray(s.zonas) && s.zonas.includes(pr.z) && quiere(s, 'promos')) poner(s, { tipo: 'promos', titulo: 'Promo nueva cerca', cuerpo: `${pr.n}: ${pr.t}`, url: './#novedades', tag: 'promos' });
  }
  // el resumen de la semana: cuánto ahorró cada hogar gracias a la comunidad (resumen: Map hogar → monto)
  for (const s of resumen ? subs : []) {
    const m = resumen.get(s.hogar);
    if (m > 0 && quiere(s, 'resumen')) poner(s, { tipo: 'resumen', titulo: 'Tu semana', cuerpo: `Esta semana tu hogar ahorró ${plata(m)} comprando donde otros hogares encontraron mejor precio. ¡Compartilo!`, url: './#novedades', tag: 'resumen' });
  }
  // muchos precios nuevos de la zona juntos: uno solo que los resume; y un tope por teléfono
  for (const [id, l] of out) {
    const av = l.filter(a => a.tipo === 'avisos');
    let r = l.filter(a => a.tipo !== 'avisos');
    if (av.length > 2) r.push({ tipo: 'avisos', titulo: 'Precios nuevos en tu zona', cuerpo: `${av.length} precios nuevos: ${av.slice(0, 3).map(a => a.cuerpo.split(':')[0]).join(', ')}…`, url: './#novedades', tag: 'avisos' });
    else r = r.concat(av);
    out.set(id, r.slice(0, TOPE_POR_TELEFONO));
  }
  return out;
}

/* ---------- mandar ---------- */
async function mandar(sa, token, s, a) {
  const url = (E.AVISOS_FCM || 'https://fcm.googleapis.com') + `/v1/projects/${sa.project_id}/messages:send`;
  const r = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { token: s.token, data: { titulo: a.titulo, cuerpo: a.cuerpo, url: a.url || './', tag: a.tag || '' }, webpush: { headers: { Urgency: 'high', TTL: '86400' } } } }) });
  if (r.ok) return 'ok';
  const j = await r.json().catch(() => ({})), t = JSON.stringify(j);
  return r.status === 404 || /UNREGISTERED|registration-token-not-registered|INVALID_ARGUMENT/.test(t) ? 'vencido' : 'error ' + r.status + ' ' + t.slice(0, 200);
}

async function principal() {
  const sa = cuenta();
  if (!sa) { console.log('::notice::Falta el secret FIREBASE_SA (la cuenta de servicio de Firebase). Sin él no se mandan avisos.'); return 0; }
  const token = await acceso(sa), fs = crearFirestore(sa, token);
  const ahora = E.AVISOS_AHORA ? +E.AVISOS_AHORA : Date.now(), hasta = ahora - MARGEN;
  const estado = await fs.leer('sistema/avisos');
  const desde = estado && estado.ultimo > hasta - 2 * DIA ? estado.ultimo : hasta - 15 * MIN;      // la primera vez (o tras mucho), solo lo último
  const [eventos, precios, promos, subs] = await Promise.all([fs.entre('eventos', 't', desde, hasta), fs.entre('precios', 'ts', desde, hasta), fs.entre('promos', 'ts', desde, hasta), fs.todos('suscripciones')]);
  log(`desde ${new Date(desde).toISOString()}: ${eventos.length} eventos, ${precios.length} precios, ${promos.length} promos; ${subs.length} teléfonos`);
  // los domingos, una vez, el resumen de la semana (a partir de las 11 de la Argentina)
  const ar = new Date(ahora - 3 * 3600e3), semana = `${ar.getUTCFullYear()}-${Math.floor((Date.UTC(ar.getUTCFullYear(), ar.getUTCMonth(), ar.getUTCDate()) - Date.UTC(ar.getUTCFullYear(), 0, 1)) / (7 * DIA))}`;
  let resumen = null;
  if (ar.getUTCDay() === 0 && ar.getUTCHours() >= 11 && !(estado && estado.semana === semana)) {
    resumen = new Map();
    const hoy = Math.floor(ar.getTime() / DIA);
    for (const h of new Set(subs.map(s => s.hogar).filter(Boolean))) {
      const d = await fs.leer('hogares/' + h), dias = (d && d.ajustes && d.ajustes.ahorroDias) || {};
      const m = Object.entries(dias).filter(([k]) => +k > hoy - 7).reduce((a, [, v]) => a + (+v || 0), 0);
      if (m > 0) resumen.set(h, Math.round(m));
    }
  }
  const avisos = armar({ eventos, precios, promos, subs, resumen }), porId = new Map(subs.map(s => [s._id, s]));
  let enviados = 0, vencidos = 0;
  for (const [id, l] of avisos) {
    const s = porId.get(id);
    for (const a of l) {
      const r = await mandar(sa, token, s, a);
      if (r === 'ok') enviados++;
      else if (r === 'vencido') { vencidos++; await fs.borrar(s._ruta); break; }
      else log('no salió un aviso:', r);
    }
  }
  // los eventos ya avisados se borran; y los viejos que hayan quedado
  for (const ev of eventos) await fs.borrar(ev._ruta);
  for (const ev of await fs.entre('eventos', 't', 0, hasta - 2 * DIA)) await fs.borrar(ev._ruta);
  await fs.fecha('sistema/avisos', 'ultimo', hasta);
  if (resumen) await fs.texto('sistema/avisos', 'semana', semana);
  log(`listo: ${enviados} avisos mandados${vencidos ? `, ${vencidos} teléfonos que ya no estaban` : ''}`);
  return 0;
}

if (require.main === module) principal().then(c => process.exit(c), e => { console.error('::error::' + (e && e.message)); process.exit(1); });
module.exports = { armar, valor, campos, principal };
