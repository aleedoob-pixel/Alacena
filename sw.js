/* Libreta del hogar — service worker.
   Guarda los archivos de la app en el teléfono para que abra aunque no haya conexión (en un almacén sin
   señal, por ejemplo). Los datos del hogar no pasan por acá: de esos se ocupa Firebase, que tiene su propia
   copia en el teléfono. El mapa tampoco: sin conexión no hay mapa, y la lista de comercios queda igual. */
const CACHE = 'libreta-v18';
const APP = ['./', 'index.html', 'estilos.css', 'app.js', 'config.js', 'manifest.webmanifest', 'privacidad.html', 'promos-bancos.json', 'iconos/icono-192.png', 'iconos/icono-512.png', 'iconos/logo-96.png'];
// De otros sitios solo se guarda lo que la app necesita para arrancar (la biblioteca de Firebase y las tipografías) y las fotos de los productos.
const AJENOS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com', 'images.openfoodfacts.org'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(APP.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// La página avisa qué más conviene guardar (la biblioteca de Firebase que cargó).
self.addEventListener('message', e => {
  const urls = e.data && e.data.guardar;
  if (!Array.isArray(urls)) return;
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(urls.map(u => c.match(u).then(hay => hay || c.add(u)).catch(() => {})))));
});

// Lo propio: primero la red, para tener siempre la última versión; si no contesta pronto, lo guardado.
async function redOGuardado(pedido) {
  const cache = await caches.open(CACHE);
  // `no-cache`: se le pregunta siempre al servidor si el archivo cambió, sin fiarse de la copia del navegador;
  // así, cuando se sube una versión nueva, llega en la próxima apertura y no quedan archivos de dos versiones.
  const red = fetch(pedido.url, { cache: 'no-cache', credentials: 'same-origin' }).then(async r => {
    // una respuesta que llegó tras una redirección no sirve para contestar una navegación: se arma una limpia
    if (r && r.redirected) r = new Response(await r.blob(), { status: r.status, statusText: r.statusText, headers: r.headers });
    if (r && r.ok) cache.put(pedido, r.clone()).catch(() => {});
    return r;
  });
  try {
    return await Promise.race([red, new Promise((_, no) => setTimeout(() => no(new Error('la red tarda')), 3500))]);
  } catch (e) {
    red.catch(() => {});
    const guardado = await cache.match(pedido, { ignoreSearch: pedido.mode === 'navigate' }) || (pedido.mode === 'navigate' ? await cache.match('./') : undefined);
    return guardado || red;
  }
}
// Lo ajeno: lo guardado y, si no está, se busca y se guarda.
async function guardadoORed(pedido) {
  const cache = await caches.open(CACHE), guardado = await cache.match(pedido);
  if (guardado) return guardado;
  const r = await fetch(pedido);
  if (r && (r.ok || r.type === 'opaque')) cache.put(pedido, r.clone()).catch(() => {});
  return r;
}
self.addEventListener('fetch', e => {
  const pedido = e.request;
  if (pedido.method !== 'GET') return;
  const u = new URL(pedido.url);
  // las ilustraciones no cambian nunca: lo guardado primero (no se le pregunta al servidor por cada una)
  if (u.origin === location.origin && u.pathname.includes('/iconos/3d/')) e.respondWith(guardadoORed(pedido));
  else if (u.origin === location.origin) e.respondWith(redOGuardado(pedido));
  else if (AJENOS.includes(u.hostname)) e.respondWith(guardadoORed(pedido));
});

// Las notificaciones: llegan por Firebase Cloud Messaging (las manda la tarea herramientas/avisos.js) y se muestran
// acá, aunque la app esté cerrada. Al tocarlas se abre la libreta en la pestaña que corresponde.
self.addEventListener('push', e => {
  let j = {};
  try { j = e.data ? e.data.json() : {}; } catch (x) { j = { data: { cuerpo: e.data ? e.data.text() : '' } }; }
  const d = Object.assign({}, j.notification || {}, j.data || {});
  const titulo = d.titulo || d.title || 'Libreta del hogar', cuerpo = d.cuerpo || d.body || '';
  e.waitUntil(self.registration.showNotification(titulo, {
    body: cuerpo, tag: d.tag || undefined, renotify: !!d.tag, icon: 'iconos/icono-192.png', badge: 'iconos/icono-192.png',
    lang: 'es', data: { url: d.url || './' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const destino = new URL((e.notification.data && e.notification.data.url) || './', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => {
    const abierta = l.find(c => c.url.startsWith(self.registration.scope)), d = e.notification.data || {};
    // las que avisa la misma app (al entrar a un comercio): si está abierta, se le dice qué mostrar, sin recargarla
    if (abierta && d.accion) { abierta.postMessage({ accion: d.accion, k: d.k || '' }); return abierta.focus(); }
    if (abierta) { abierta.navigate(destino).catch(() => {}); return abierta.focus(); }
    return self.clients.openWindow(destino);
  }));
});
