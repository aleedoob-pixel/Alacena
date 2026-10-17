/* Libreta del hogar — la alacena, las compras y los gastos de la casa, compartidos con la familia.
   Va junto con index.html, estilos.css, config.js, sw.js, manifest.webmanifest, privacidad.html y la carpeta iconos.

   Partes de este archivo, en orden:
     1. Barras     lee códigos de barras EAN-13, UPC-A y EAN-8 mirando los píxeles de una imagen
     2. Nucleo     fechas, plata, consumo, lista de compras y totales por mes: la lógica, sin pantalla
     3. Ahorro     cuánto subió cada precio, la canasta de la casa y los consejos para gastar menos
     4. Imagen     abrir fotos, achicarlas y pasarlas a grises
     5. QR         dibuja el código QR de las invitaciones
     6. Fotos      las fotos de los tickets, guardadas en cada teléfono (IndexedDB)
     7. Datos      la cuenta de Google, el hogar y sus datos en Firebase (Cloud Firestore)
     8. IA         Gemini, de Google: lee fotos de promos y propone comidas con lo que hay en la alacena
     9. Lector     busca un producto por su código de barras en Open Food Facts
    10. Cerca      OpenStreetMap: los comercios, el mapa y los precios que comparten los hogares de la zona
    11. la pantalla: entrada, alacena, compras, gastos, novedades, escáner, tickets, notas y ajustes */

/* Lector de códigos de barras de producto (EAN-13, UPC-A y EAN-8) sobre una
   imagen en escala de grises.

   Recorre la imagen con líneas en varios ángulos. En cada línea:
   1. ubica los bordes entre máximos y mínimos locales y busca una secuencia
      con la estructura del código (guardas, zonas de silencio y dígitos de
      siete módulos cada uno);
   2. con esos bordes ajusta dónde cae cada módulo y decide cada dígito
      comparando el perfil de grises con las plantillas del estándar ya
      desenfocadas, que aguanta mucho más desenfoque que medir anchos.
   Solo devuelve un código si cada dígito gana con margen, el verificador
   cierra y dos líneas distintas leen lo mismo. */
const Barras = (() => {
  'use strict';

  // Anchos (en módulos) de los cuatro elementos de cada dígito.
  const L = [[3,2,1,1],[2,2,2,1],[2,1,2,2],[1,4,1,1],[1,1,3,2],[1,2,3,1],[1,1,1,4],[1,3,1,2],[1,2,1,3],[3,1,1,2]];
  const G = L.map(p => p.slice().reverse());
  const PARIDAD = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];

  const S = 4;                              // muestras por módulo
  const SIGMAS = [0.25, 0.4, 0.55, 0.7, 0.85, 1.0];   // desenfoque en módulos
  const VENT = 9 * S;                       // un módulo de contexto + 7 + un módulo
  const V0 = S / 2, V1 = VENT - S / 2;      // tramo que se compara

  function gtinValido(c) {
    if (typeof c !== 'string' || !/^(\d{8}|\d{12,14})$/.test(c)) return false;
    const n = c.length;
    let s = 0;
    for (let i = 0; i < n - 1; i++) s += (c.charCodeAt(n - 2 - i) - 48) * (i % 2 === 0 ? 3 : 1);
    return (10 - (s % 10)) % 10 === c.charCodeAt(n - 1) - 48;
  }

  // Forma común para comparar códigos leídos de distintas maneras (UPC-A de 12 = EAN-13 con 0 adelante).
  function canonico(c) {
    const d = String(c == null ? '' : c).replace(/\D/g, '');
    return d ? d.padStart(14, '0') : '';
  }

  /* ---------- plantillas ---------- */
  function nucleo(sigma) {
    const r = Math.max(1, Math.ceil(sigma * S * 3));
    const k = new Float32Array(2 * r + 1);
    let s = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma * S * S)); s += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= s;
    return k;
  }
  // Perfil ideal (1 = claro, 0 = barra) de un dígito con su contexto, desenfocado y centrado.
  function plantilla(patron, empiezaClaro, k) {
    const pad = 4, n = (9 + 2 * pad) * S, ideal = new Float32Array(n);
    let color = empiezaClaro ? 1 : 0, p = (pad + 1) * S;
    ideal.fill(1 - color, 0, p);
    for (const w of patron) { ideal.fill(color, p, p + w * S); p += w * S; color = 1 - color; }
    ideal.fill(color, p);
    const r = (k.length - 1) / 2, out = new Float32Array(VENT);
    let media = 0;
    for (let i = 0; i < VENT; i++) {
      let s = 0;
      for (let j = -r; j <= r; j++) s += ideal[pad * S + i + j] * k[j + r];
      out[i] = s;
      if (i >= V0 && i < V1) media += s;
    }
    media /= (V1 - V0);
    let e = 0;
    for (let i = 0; i < VENT; i++) { out[i] -= media; if (i >= V0 && i < V1) e += out[i] * out[i]; }
    const norma = Math.sqrt(e) || 1;
    for (let i = 0; i < VENT; i++) out[i] /= norma;
    return out;
  }
  // PL[sigma][0] = izquierda con paridad L, [1] = izquierda con paridad G, [2] = mitad derecha.
  const PL = SIGMAS.map(sg => {
    const k = nucleo(sg);
    return [L.map(p => plantilla(p, true, k)), G.map(p => plantilla(p, true, k)), L.map(p => plantilla(p, false, k))];
  });

  /* ---------- perfil y bordes ---------- */
  // Luminancia a lo largo de un segmento, promediando tres líneas paralelas.
  function perfil(lum, w, h, x0, y0, x1, y1) {
    const n = Math.max(2, Math.round(Math.hypot(x1 - x0, y1 - y0)));
    const dx = (x1 - x0) / (n - 1), dy = (y1 - y0) / (n - 1);
    const paso = Math.hypot(dx, dy), nx = -dy / paso, ny = dx / paso;
    const v = new Float32Array(n);
    const wm = w - 1, hm = h - 1;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let o = -1; o <= 1; o++) {
        let x = x0 + dx * i + nx * o * 1.3, y = y0 + dy * i + ny * o * 1.3;
        if (x < 0) x = 0; else if (x > wm) x = wm;
        if (y < 0) y = 0; else if (y > hm) y = hm;
        const xi = x | 0, yi = y | 0, fx = x - xi, fy = y - yi;
        const xj = xi < wm ? xi + 1 : xi, yj = yi < hm ? yi + 1 : yi;
        const a = lum[yi * w + xi], b = lum[yi * w + xj], c = lum[yj * w + xi], d = lum[yj * w + xj];
        s += (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
      }
      v[i] = s / 3;
    }
    return v;
  }
  function suavizar(v) {
    const n = v.length, o = new Float32Array(n);
    o[0] = v[0]; o[n - 1] = v[n - 1];
    for (let i = 1; i < n - 1; i++) o[i] = (v[i - 1] + 2 * v[i] + v[i + 1]) / 4;
    return o;
  }

  // Posición de cada borde: donde el perfil cruza el punto medio entre un máximo
  // y un mínimo locales separados por al menos `hist`. Devuelve las posiciones y
  // si el primer borde es de subida (oscuro → claro).
  function bordes(v, hist) {
    const n = v.length, pos = [];
    let primeraSube = false, dir = 0;
    let maxV = v[0], maxI = 0, minV = v[0], minI = 0, prevV = 0, prevI = -1;
    const cruce = (i0, v0, i1, v1) => {
      const medio = (v0 + v1) / 2, sube = v1 > v0;
      for (let j = i0 + 1; j <= i1; j++) {
        if (sube ? v[j] >= medio : v[j] <= medio) {
          const a = v[j - 1], b = v[j];
          const f = b === a ? 0.5 : (medio - a) / (b - a);
          return j - 1 + (f < 0 ? 0 : f > 1 ? 1 : f);
        }
      }
      return (i0 + i1) / 2;
    };
    for (let i = 1; i < n; i++) {
      const x = v[i];
      if (dir >= 0) {
        if (x > maxV) { maxV = x; maxI = i; }
        else if (maxV - x >= hist) {
          if (prevI >= 0) { if (!pos.length) primeraSube = true; pos.push(cruce(prevI, prevV, maxI, maxV)); }
          prevV = maxV; prevI = maxI; dir = -1; minV = x; minI = i;
          continue;
        }
      }
      if (dir <= 0) {
        if (x < minV) { minV = x; minI = i; }
        else if (x - minV >= hist) {
          if (prevI >= 0) { if (!pos.length) primeraSube = false; pos.push(cruce(prevI, prevV, minI, minV)); }
          prevV = minV; prevI = minI; dir = 1; maxV = x; maxI = i;
        }
      }
    }
    return { pos, primeraSube };
  }

  /* ---------- estructura ---------- */
  // Formatos: cantidad de dígitos por mitad. EAN-13 = 6 + 6 (95 módulos), EAN-8 = 4 + 4 (67).
  // pos[e] es el primer borde del código (claro → oscuro). Devuelve los bordes de referencia
  // [posición, módulo, signo] o null si la secuencia no tiene forma de código.
  function estructura(pos, e, nd, largo) {
    const nb = 12 + 8 * nd;                 // bordes que ocupa el código
    if (e + nb > pos.length) return null;
    const ini = pos[e], fin = pos[e + nb - 1];
    const mods = 6 + 14 * nd + 5, m = (fin - ini) / mods;
    if (m < 1.25) return null;
    // zonas de silencio (si la línea empieza o termina ahí mismo, vale lo que haya)
    const antes = e > 0 ? ini - pos[e - 1] : ini;
    const despues = e + nb < pos.length ? pos[e + nb] - fin : largo - 1 - fin;
    if (antes < 3 * m || despues < 3 * m) return null;
    // cada dígito ocupa siete módulos: los anchos tienen que ser parejos y cambiar de a poco
    let previo = 0;
    const b = e + 3, c = e + 3 + 4 * nd + 5;
    for (let j = 0; j < 2 * nd; j++) {
      const k = j < nd ? b + 4 * j : c + 4 * (j - nd);
      const mj = (pos[k + 4] - pos[k]) / 7;
      if (mj < 0.5 * m || mj > 1.55 * m) return null;
      if (previo && j !== nd && (mj < 0.76 * previo || mj > 1.32 * previo)) return null;
      previo = mj;
    }
    const m1 = (pos[b + 4] - pos[b]) / 7, mMed = (pos[b + 4 * nd] - pos[b + 4 * nd - 4] + pos[c + 4] - pos[c]) / 14,
      mFin = (pos[c + 4 * nd] - pos[c + 4 * nd - 4]) / 7;
    const g0 = (pos[e + 3] - ini) / m1, gm = (pos[c] - pos[b + 4 * nd]) / mMed, g1 = (fin - pos[c + 4 * nd]) / mFin;
    if (g0 < 1.8 || g0 > 4.4 || gm < 3.6 || gm > 6.4 || g1 < 1.8 || g1 > 4.4) return null;
    // bordes de referencia: signo +1 si es de subida (barra → espacio)
    const ref = [];
    for (let i = 0; i <= 3; i++) ref.push([pos[e + i], i, i % 2 ? 1 : -1]);
    for (let j = 1; j <= nd; j++) ref.push([pos[b + 4 * j], 3 + 7 * j, 1]);
    const um = 3 + 7 * nd;
    for (let i = 1; i <= 5; i++) ref.push([pos[b + 4 * nd + i], um + i, i % 2 ? -1 : 1]);
    for (let j = 1; j <= nd; j++) ref.push([pos[c + 4 * j], um + 5 + 7 * j, -1]);
    for (let i = 1; i <= 3; i++) ref.push([pos[c + 4 * nd + i], um + 5 + 7 * nd + i, i % 2 ? 1 : -1]);
    return { ref, mods, m };
  }

  // Ajuste por mínimos cuadrados de x(t) = c0 + c1·t + c2·t² + c3·t³ + g·signo, con t entre -1 y 1.
  // El término cúbico absorbe la perspectiva y la curva de un envase cilíndrico.
  function ajustar(ref, mods) {
    const N = 5, h = mods / 2, A = [];
    for (let i = 0; i < N; i++) A.push(new Float64Array(N + 1));
    const f = new Float64Array(N);
    for (const [x, u, s] of ref) {
      const t = (u - h) / h;
      f[0] = 1; f[1] = t; f[2] = t * t; f[3] = t * t * t; f[4] = s;
      for (let i = 0; i < N; i++) { for (let j = 0; j < N; j++) A[i][j] += f[i] * f[j]; A[i][N] += f[i] * x; }
    }
    for (let i = 0; i < N; i++) {
      let p = i;
      for (let r = i + 1; r < N; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
      if (Math.abs(A[p][i]) < 1e-9) return null;
      const t = A[i]; A[i] = A[p]; A[p] = t;
      for (let r = 0; r < N; r++) if (r !== i) {
        const q = A[r][i] / A[i][i];
        for (let j = i; j <= N; j++) A[r][j] -= q * A[i][j];
      }
    }
    const c = [];
    for (let i = 0; i < N; i++) c.push(A[i][N] / A[i][i]);
    const x = u => { const t = (u - h) / h; return c[0] + t * (c[1] + t * (c[2] + t * c[3])); };
    const dx = u => { const t = (u - h) / h; return (c[1] + t * (2 * c[2] + t * 3 * c[3])) / h; };
    let e = 0;
    for (const [px, u, s] of ref) { const d = x(u) + c[4] * s - px; e += d * d; }
    return { x, dx, g: c[4], rms: Math.sqrt(e / ref.length) };
  }

  /* ---------- decisión por plantillas ---------- */
  function decidir(v, est, nd, umbral) {
    const mods = est.mods, aj = ajustar(est.ref, mods);
    if (!aj) return null;
    // el ancho de módulo tiene que ser positivo en todo el código
    let mm = 0, minD = Infinity;
    for (let u = -2; u <= mods + 2; u += 3) { const d = aj.dx(u); if (d < minD) minD = d; }
    for (let u = 0; u <= mods; u += mods / 8) mm += aj.dx(u) / 9;
    if (!(minD > 0.5) || !(mm > 1.2)) return null;
    if (aj.rms > umbral.rms * mm || Math.abs(aj.g) > 0.75 * mm) return null;
    // perfil en coordenadas de módulo, desde -2 hasta mods + 2
    const n = (mods + 4) * S, O = new Float32Array(n), tope = v.length - 1;
    for (let i = 0; i < n; i++) {
      let x = aj.x(-2 + (i + 0.5) / S);
      if (x < 0) x = 0; else if (x > tope) x = tope;
      const xi = x | 0, f = x - xi;
      O[i] = xi < tope ? v[xi] + (v[xi + 1] - v[xi]) * f : v[xi];
    }
    // segmentos de cada dígito, centrados y normalizados
    const seg = [];
    for (let j = 0; j < 2 * nd; j++) {
      const u0 = j < nd ? 3 + 7 * j : 3 + 7 * nd + 5 + 7 * (j - nd);
      const i0 = (u0 + 1) * S, s = new Float32Array(VENT);
      let media = 0;
      for (let i = V0; i < V1; i++) media += O[i0 + i];
      media /= (V1 - V0);
      let e = 0;
      for (let i = V0; i < V1; i++) { s[i] = O[i0 + i] - media; e += s[i] * s[i]; }
      if (e < 1e-6) return null;
      const norma = Math.sqrt(e);
      for (let i = V0; i < V1; i++) s[i] /= norma;
      seg.push(s);
    }
    let mejor = null;
    for (let si = 0; si < SIGMAS.length; si++) {
      let suma = 0, minC = 2, minMargen = 2, cod = '', par = '';
      for (let j = 0; j < 2 * nd; j++) {
        const s = seg[j], tablas = j < nd ? (nd === 6 ? [PL[si][0], PL[si][1]] : [PL[si][0]]) : [PL[si][2]];
        let c1 = -2, c2b = -2, d = 0, esG = false;
        for (let t = 0; t < tablas.length; t++) for (let k = 0; k < 10; k++) {
          const p = tablas[t][k];
          let cc = 0;
          for (let i = V0; i < V1; i++) cc += s[i] * p[i];
          if (cc > c1) { c2b = c1; c1 = cc; d = k; esG = t === 1; } else if (cc > c2b) c2b = cc;
        }
        suma += c1; if (c1 < minC) minC = c1; if (c1 - c2b < minMargen) minMargen = c1 - c2b;
        cod += d; if (j < nd) par += esG ? 'G' : 'L';
      }
      if (!mejor || suma > mejor.suma) mejor = { suma, minC, minMargen, cod, par, sigma: SIGMAS[si] };
    }
    const media = mejor.suma / (2 * nd);
    if (media < umbral.media || mejor.minC < umbral.minC || mejor.minMargen < umbral.margen) return null;
    let codigo = mejor.cod;
    if (nd === 6) {
      const primero = PARIDAD.indexOf(mejor.par);
      if (primero < 0) return null;
      codigo = primero + codigo;
    }
    if (!gtinValido(codigo)) return null;
    return { codigo, media, minC: mejor.minC, margen: mejor.minMargen, sigma: mejor.sigma, rms: aj.rms / mm, modulo: mm };
  }

  const UMBRAL = { rms: 0.45, media: 0.9, minC: 0.78, margen: 0.09 };

  function enBordes(v, pos, primeraSube, umbral) {
    // el código empieza en un borde de bajada (claro → oscuro)
    for (let e = primeraSube ? 1 : 0; e + 44 <= pos.length; e += 2) {
      for (const nd of [6, 4]) {
        const est = estructura(pos, e, nd, v.length);
        if (!est) continue;
        const r = decidir(v, est, nd, umbral);
        if (r) return r;
      }
    }
    return null;
  }

  function leerPerfil(crudo, umbral) {
    const um = umbral || UMBRAL;
    const variantes = [crudo, suavizar(crudo)];
    for (const v of variantes) {
      let mn = 255, mx = 0;
      for (let i = 0; i < v.length; i++) { if (v[i] < mn) mn = v[i]; if (v[i] > mx) mx = v[i]; }
      const rango = mx - mn;
      if (rango < 28) return null;
      let alReves = null;
      for (const f of [0.2, 0.1, 0.05, 0.028]) {
        const { pos, primeraSube } = bordes(v, Math.max(4, rango * f));
        if (pos.length < 44) continue;
        let r = enBordes(crudo, pos, primeraSube, um);
        if (r) return r;
        // de derecha a izquierda
        if (!alReves) alReves = Float32Array.from(crudo).reverse();
        const n1 = v.length - 1, posR = new Array(pos.length);
        for (let i = 0; i < pos.length; i++) posR[i] = n1 - pos[pos.length - 1 - i];
        r = enBordes(alReves, posR, pos.length % 2 === 1 ? !primeraSube : primeraSube, um);
        if (r) return r;
      }
    }
    return null;
  }

  function leerLinea(lum, w, h, x0, y0, x1, y1, umbral) {
    return leerPerfil(perfil(lum, w, h, x0, y0, x1, y1), umbral);
  }

  const ANGULOS = [0, 90, 15, -15, 30, -30, 45, -45, 60, -60, 75, -75];

  /* Recorre la imagen con líneas paralelas en un ángulo. `votos` (un Map) junta las
     lecturas sueltas entre un ángulo y otro. Devuelve el código confirmado o null. */
  function leerAngulo(lum, w, h, grados, votos) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const ang = grados * Math.PI / 180, dx = Math.cos(ang), dy = Math.sin(ang);
    const segmento = d => {
      const px = cx - dy * d, py = cy + dx * d;
      let t0 = -Infinity, t1 = Infinity;
      if (Math.abs(dx) > 1e-9) {
        let a = -px / dx, b = (w - 1 - px) / dx;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
      } else if (px < 0 || px > w - 1) return null;
      if (Math.abs(dy) > 1e-9) {
        let a = -py / dy, b = (h - 1 - py) / dy;
        if (a > b) { const t = a; a = b; b = t; }
        if (a > t0) t0 = a; if (b < t1) t1 = b;
      } else if (py < 0 || py > h - 1) return null;
      if (!(t1 - t0 >= 80)) return null;
      return [px + dx * t0, py + dy * t0, px + dx * t1, py + dy * t1];
    };
    const probar = d => {
      const s = segmento(d);
      const r = s ? leerLinea(lum, w, h, s[0], s[1], s[2], s[3]) : null;
      return r ? r.codigo : null;
    };
    const medio = (Math.abs(dy) * w + Math.abs(dx) * h) / 2;
    const N = grados % 90 === 0 ? 27 : 15;
    const paso = (2 * medio * 0.94) / N;
    for (let i = 0; i < N; i++) {
      const d = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * paso;
      const c = probar(d);
      if (!c) continue;
      for (const dd of [5, -5, 11, -11, 19, -19]) if (probar(d + dd) === c) return c;
      const n = (votos.get(c) || 0) + 1;
      if (n >= 2) return c;
      votos.set(c, n);
    }
    return null;
  }

  /* lum: Uint8Array o Uint8ClampedArray de w*h valores de gris. Devuelve el código o null. */
  function leer(lum, w, h) {
    const votos = new Map();
    for (const grados of ANGULOS) {
      const c = leerAngulo(lum, w, h, grados, votos);
      if (c) return c;
    }
    return null;
  }

  return { leer, leerAngulo, ANGULOS, leerLinea, leerPerfil, gtinValido, canonico, UMBRAL };
})();


/* Lógica de la libreta sin pantalla: fechas, plata, consumo, compras sugeridas
   y gastos por mes. Todo son funciones puras. */
const Nucleo = (() => {
  'use strict';

  const CATS = {
    almacen: 'Almacén', lacteos: 'Lácteos y huevos', frescos: 'Frutas y verduras', carnes: 'Carnes y fiambres',
    panaderia: 'Panadería', bebidas: 'Bebidas', congelados: 'Congelados', limpieza: 'Limpieza',
    higiene: 'Higiene y cuidado', mascotas: 'Mascotas', farmacia: 'Farmacia', hogar: 'Casa y bazar', otros: 'Otros',
  };
  const CATS_ALACENA = ['almacen', 'lacteos', 'frescos', 'carnes', 'panaderia', 'bebidas', 'congelados', 'limpieza', 'higiene', 'mascotas', 'otros'];
  const ORDEN_CATS = Object.keys(CATS);

  /* ---------- fechas (siempre en hora local, como 'AAAA-MM-DD') ---------- */
  const p2 = n => String(n).padStart(2, '0');
  const isoDe = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
  const hoyISO = ahora => { const d = ahora || new Date(); return isoDe(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
  function fechaValida(s) {
    if (typeof s !== 'string') return false;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return false;
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, mo, 0)).getUTCDate();
  }
  // Número de día (días desde 1970): sirve para restar fechas sin líos de horario.
  const diaDe = iso => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 864e5);
  const isoDeDia = n => { const d = new Date(n * 864e5); return isoDe(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()); };
  const mesDe = iso => iso.slice(0, 7);
  function sumarMes(mes, n) {
    let y = +mes.slice(0, 4), m = +mes.slice(5, 7) - 1 + n;
    y += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    return `${y}-${p2(m + 1)}`;
  }
  const diasDelMes = mes => new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 0)).getUTCDate();
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_C = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const soloMes = mes => MESES[+mes.slice(5, 7) - 1];
  const nombreMes = mes => `${soloMes(mes)} de ${mes.slice(0, 4)}`;
  const mesCorto = mes => MESES_C[+mes.slice(5, 7) - 1];
  const fechaCorta = iso => `${+iso.slice(8, 10)} ${MESES_C[+iso.slice(5, 7) - 1]}`;
  const diaSemana = n => DIAS[(((n + 4) % 7) + 7) % 7];
  const fechaLarga = iso => `${diaSemana(diaDe(iso))} ${+iso.slice(8, 10)} de ${nombreMes(mesDe(iso))}`;

  /* ---------- plata y números ---------- */
  const nf0 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const redondear2 = v => Math.round(v * 100) / 100;
  const ESP = ' ';
  function plata(v, sinCentavos) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    const r = redondear2(v), entero = sinCentavos || Math.abs(r - Math.round(r)) < 0.005;
    return (r < 0 ? '−' : '') + '$' + ESP + (entero ? nf0.format(Math.abs(Math.round(r))) : nf2.format(Math.abs(r)));
  }
  // Para ejes y etiquetas angostas: 548 mil, 1,2 M.
  function plataCorta(v, conSigno) {
    if (typeof v !== 'number' || !isFinite(v)) return '—';
    const a = Math.abs(v), s = conSigno === false ? '' : '$' + ESP;
    if (a >= 999500) return s + nf1.format(a / 1e6) + ESP + 'M';
    if (a >= 9950) return s + nf0.format(a / 1000) + ESP + 'mil';
    if (a >= 1000) return s + nf1.format(a / 1000) + ESP + 'mil';
    return s + nf0.format(a);
  }
  const num = v => nf1.format(v);
  // Acepta "1.450,50", "1450.5", "$ 2.900", 1450.5. Sin coma, un punto seguido de tres cifras es separador de miles.
  function aNumero(v) {
    if (typeof v === 'number') return isFinite(v) ? v : NaN;
    let s = String(v == null ? '' : v).trim().replace(/[−–]/g, '-').replace(/[^\d.,-]/g, '');
    if (!s || !/\d/.test(s)) return NaN;
    const neg = s[0] === '-';
    s = s.replace(/-/g, '');
    const ic = s.lastIndexOf(','), ip = s.lastIndexOf('.');
    if (ic >= 0 && ip >= 0) {
      s = ic > ip ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    } else if (ic >= 0) {
      const pr = s.split(',');
      s = pr.length === 2 ? pr[0] + '.' + pr[1] : pr.join('');
    } else if (ip >= 0) {
      const pr = s.split('.');
      const miles = pr[0] !== '0' && pr[0].length >= 1 && pr[0].length <= 3 && pr.slice(1).every(x => x.length === 3);
      if (miles) s = pr.join('');
      else if (pr.length > 2) s = pr.slice(0, -1).join('') + '.' + pr[pr.length - 1];
    }
    const n = Number(s);
    return isFinite(n) ? (neg ? -n : n) : NaN;
  }
  // Texto para volver a mostrar un importe dentro de un campo editable.
  const campoPlata = v => (typeof v === 'number' && isFinite(v) && v !== 0)
    ? (Math.abs(v - Math.round(v)) < 0.005 ? nf0.format(Math.round(v)) : nf2.format(v)) : '';

  /* ---------- textos ---------- */
  const UNIDADES = { lt: 'l', lts: 'l', litro: 'l', litros: 'l', gr: 'g', grs: 'g', gramos: 'g', cc: 'ml', kilo: 'kg', kilos: 'kg', un: 'u', unid: 'u', unidades: 'u' };
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/(\d)[.,](\d)/g, '$1_$2').replace(/[^a-z0-9_]+/g, ' ').replace(/(\d)([a-z])/g, '$1 $2').trim();
  }
  /* Las palabras que importan de un nombre, en una forma común: sin acentos, sin las palabras chicas, en singular y
     sin letras dobles. «Pizzetas de muzzarella» → ['pizeta', 'muzarela']. Sirve para buscar y para comparar nombres. */
  const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'con', 'y', 'e', 'en', 'a', 'al', 'para', 'x', 'sin', 'un', 'una', 'por']);
  function raices(s) {
    return norm(s).split(/[^a-z0-9]+/).filter(w => w && !VACIAS.has(w)).map(w => {
      if (/^\d/.test(w)) return w;
      if (w.length > 4 && /[nrld]es$/.test(w)) w = w.slice(0, -2);
      else if (w.length > 3 && /[^s]s$/.test(w)) w = w.slice(0, -1);
      return w.replace(/(.)\1+/g, '$1');
    });
  }
  // Si lo buscado (sus raíces) está en ese texto: cada palabra buscada es una del texto, el comienzo de una (desde 4
  // letras) o una con una letra de diferencia (desde 5). «pizeta» encuentra «Pizzetas»; «jamon», «Jamón cocido»;
  // «pan» no encuentra «panceta».
  function distancia1(a, b) {
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, dif = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++dif > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return dif + (a.length - i) + (b.length - j) <= 1;
  }
  function coincide(buscadas, texto) {
    const ws = raices(texto);
    return buscadas.length > 0 && buscadas.every(q => ws.some(w => w === q || (q.length >= 4 && w.startsWith(q)) || (q.length >= 5 && distancia1(q, w))));
  }
  const fichas = s => norm(s).split(' ').map(t => UNIDADES[t] || t).filter(t => t.length > 1 || /[\dlgu]/.test(t));
  function parecido(a, b) {
    const A = new Set(fichas(a)), B = new Set(fichas(b));
    if (!A.size || !B.size) return 0;
    let c = 0;
    for (const t of A) if (B.has(t)) c++;
    return c / (A.size + B.size - c);
  }
  const textoProducto = p => [p.nombre, p.marca, p.presentacion].filter(Boolean).join(' ');
  function buscarParecido(productos, texto, minimo) {
    let mejor = null, punt = minimo == null ? 0.75 : minimo;
    for (const [id, p] of productos) {
      const s = parecido(textoProducto(p), texto);
      if (s >= punt) { punt = s; mejor = id; }
    }
    return mejor;
  }
  const mayuscula = s => s ? s[0].toUpperCase() + s.slice(1) : s;
  const plural = (n, uno, muchos) => n === 1 ? uno : muchos;

  /* ---------- movimientos de la alacena y precios ----------
     Cada producto guarda `log`: una entrada [día, usados, comprados] por día con actividad; y `px`, su historial
     de precios: una entrada [día, precio, comercio, ref] por día en que se anotó un precio. `ref` identifica al
     comercio (el identificador de Google Maps del lugar, si se lo ubicó en el mapa). */
  const TOPE_PX = 40;
  function precios(p) {
    const m = new Map();
    for (const e of Array.isArray(p.px) ? p.px : []) {
      if (!Array.isArray(e) || typeof e[0] !== 'number' || !(e[0] > 0) || !isFinite(e[0]) || !(+e[1] > 0) || !isFinite(+e[1])) continue;
      m.set(e[0], [+e[0], redondear2(+e[1]), typeof e[2] === 'string' ? e[2] : '', typeof e[3] === 'string' ? e[3] : '']);
    }
    // un producto de antes del historial: su único precio conocido es el punto de partida
    if (!m.size && p.precio > 0 && fechaValida(p.precioFecha)) { const d = diaDe(p.precioFecha); m.set(d, [d, redondear2(+p.precio), '', '']); }
    return [...m.values()].sort((a, b) => a[0] - b[0]);
  }
  // precio: { valor, fecha, comercio, ref }
  function aplicarMovs(p, movs, hoy, precio) {
    const m = new Map();
    for (const e of Array.isArray(p.log) ? p.log : []) {
      if (Array.isArray(e) && isFinite(e[0])) m.set(e[0], [e[0], Math.max(0, +e[1] || 0), Math.max(0, +e[2] || 0)]);
    }
    let stock = Math.max(0, +p.stock || 0);
    for (const mv of movs) {
      const u = Math.round(+mv.u || 0), c = Math.round(+mv.c || 0), dia = mv.dia == null ? hoy : mv.dia;
      const e = m.get(dia) || [dia, 0, 0];
      e[1] = Math.max(0, e[1] + u); e[2] = Math.max(0, e[2] + c);
      m.set(dia, e);
      stock = Math.max(0, stock - u + c);
    }
    let log = [...m.values()].filter(e => (e[1] > 0 || e[2] > 0) && e[0] > hoy - 200 && e[0] <= hoy + 1).sort((a, b) => a[0] - b[0]);
    if (log.length > 220) log = log.slice(-220);
    const out = { stock, log };
    if (precio && precio.valor > 0) {
      const f = precio.fecha || isoDeDia(hoy), nuevo = redondear2(precio.valor);
      const h = new Map(precios(p).map(e => [e[0], e])), d = diaDe(f);
      if (!p.precioFecha || f >= p.precioFecha) {
        // el precio anterior es el del último día anterior con precio (el de hoy, si se lo está corrigiendo, no cuenta)
        let antes = null;
        for (const e of h.values()) if (e[0] < d && (!antes || e[0] > antes[0])) antes = e;
        if (antes) out.precioAnt = antes[1];
        else if (p.precio > 0 && Math.abs(p.precio - nuevo) > 0.004 && f > (p.precioFecha || '')) out.precioAnt = p.precio;
        out.precio = nuevo; out.precioFecha = f;
      }
      // al historial entra siempre, aunque sea de una compra vieja
      h.set(d, [d, nuevo, String(precio.comercio || '').replace(/\s+/g, ' ').trim().slice(0, 60), String(precio.ref || '').slice(0, 300)]);
      out.px = [...h.values()].sort((a, b) => a[0] - b[0]).slice(-TOPE_PX);
    }
    return out;
  }
  // Se borró el precio a mano: se va el último del historial y vuelve a valer el anterior, si lo hay.
  function quitarPrecio(p) {
    const px = precios(p).slice(0, -1);
    const queda = px.length ? px[px.length - 1] : null, antes = px.length > 1 ? px[px.length - 2] : null;
    return { precio: queda ? queda[1] : null, precioFecha: queda ? isoDeDia(queda[0]) : null, precioAnt: antes ? antes[1] : null, px };
  }

  /* ---------- consumo y compras sugeridas ---------- */
  const VENTANA = 56;      // días de historia que cuentan para el ritmo
  const MARGEN = 2;        // días de colchón sobre la frecuencia de compra
  const FRECUENCIAS = [1, 3, 7, 15, 30];                     // cada cuánto se hacen las compras: a diario … una vez por mes
  /* Lo que se compra en el día a día (el pan, las frutas y verduras, o lo que el hogar marque): aunque la casa haga
     una compra grande por mes, de eso se lleva para un par de días. `p.diario`: true / false lo decide el hogar;
     sin decidir, va según la categoría. */
  const DIA_A_DIA = ['frescos', 'panaderia'];
  const diarioPorCategoria = cat => DIA_A_DIA.includes(cat);
  const esDiario = p => (p.diario === true || p.diario === false ? p.diario : diarioPorCategoria(p.categoria));
  // Para cuántos días conviene tener: la frecuencia de compra (o un par de días, si es del día a día) más un colchón.
  function horizonteDe(p, frec) {
    const f = esDiario(p) ? Math.min(frec, 2) : frec;
    return f + (f <= 3 ? 1 : MARGEN);
  }
  const mediana = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };

  /* Devuelve cómo viene un producto:
     modo   'uso' (hay consumo anotado), 'compra' (se estima por cada cuánto se compra) o 'sin' datos
     ritmo  unidades por día · dias: para cuántos días alcanza
     motivo null (no hace falta) | 'agotado' | 'ritmo' | 'cadencia' | 'aviso' | 'pedido' (alguien de la casa lo anotó en la lista)
     cant   cuánto conviene comprar */
  function analizar(p, hoy, frec) {
    const log = Array.isArray(p.log) ? p.log : [];
    const desde = hoy - VENTANA;
    let usos = 0, diasUso = 0, primero = null;
    const compras = [];
    for (const e of log) {
      const d = e[0], u = +e[1] || 0, c = +e[2] || 0;
      if (!isFinite(d) || d > hoy) continue;
      if (primero === null || d < primero) primero = d;
      if (u > 0 && d > desde) { usos += u; diasUso++; }
      if (c > 0 && d > hoy - 120) compras.push([d, c]);
    }
    compras.sort((a, b) => a[0] - b[0]);
    const stock = Math.max(0, +p.stock || 0), aviso = Math.max(0, +p.aviso || 0);
    const habitual = mediana(compras.map(c => c[1])) || 1;
    const ult = compras.length ? compras[compras.length - 1] : null;
    let modo = 'sin', ritmo = 0, stockEf = stock, cadaDias = 0;
    if (usos > 0) {
      const obs = Math.min(VENTANA, Math.max(7, hoy - Math.max(primero, desde)));
      if (diasUso >= 2 || obs >= 14) { modo = 'uso'; ritmo = usos / obs; }
    } else if (compras.length >= 2) {
      const tramo = ult[0] - compras[0][0];
      if (tramo >= 3) {
        const cant = compras.slice(0, -1).reduce((s, c) => s + c[1], 0);
        modo = 'compra'; ritmo = cant / tramo; cadaDias = tramo / (compras.length - 1);
        stockEf = stock <= 0 ? 0 : Math.max(0, ult[1] - ritmo * (hoy - ult[0]));
      }
    }
    const horizonte = horizonteDe(p, frec);
    const dias = ritmo > 0 ? stockEf / ritmo : Infinity;
    let motivo = null, cant = 0;
    if (p.reponer !== false) {
      if (stock <= 0) motivo = 'agotado';
      else if (ritmo > 0 && stockEf < ritmo * horizonte - 1e-9) motivo = modo === 'compra' ? 'cadencia' : 'ritmo';
      else if (modo !== 'compra' && aviso > 0 && stock <= aviso) motivo = 'aviso';
    }
    // lo anotó alguien en la lista (p.pedido: el día) y no se compró desde entonces
    const pedido = +p.pedido > 0 && !(ult && ult[0] >= +p.pedido) && +p.pedido <= hoy + 1;
    if (!motivo && pedido) motivo = 'pedido';
    if (motivo) {
      if (ritmo > 0) cant = Math.ceil(ritmo * horizonte - stockEf - 1e-9);
      else cant = habitual;
      if (motivo === 'aviso') cant = Math.max(cant, aviso + 1 - stock);
      cant = Math.max(1, cant);
    }
    const urgencia = motivo === 'agotado' ? -1 : motivo === 'pedido' ? -0.5 : motivo === 'aviso' && !(ritmo > 0) ? 1000 + stock : dias;
    return { modo, ritmo, dias, stock, stockEf, aviso, motivo, cant, cadaDias, diasUltCompra: ult ? hoy - ult[0] : null, urgencia, diario: esDiario(p), pedido };
  }

  const n1 = x => (x >= 9.95 ? nf0.format(x) : nf1.format(x));
  function ritmoTexto(r) {
    if (!(r > 0)) return '';
    if (r * 7 >= 0.95) return `~${n1(r * 7)} por semana`;
    if (r * 30 >= 0.95) return `~${n1(r * 30)} por mes`;
    return `1 cada ~${Math.max(2, Math.round(1 / r / 30))} meses`;
  }
  function alcanzaTexto(d) {
    if (!isFinite(d)) return '';
    if (d < 1) return 'se termina hoy';
    if (d < 1.5) return 'alcanza 1 día';
    if (d <= 60) return `alcanza ~${Math.round(d)} días`;
    return 'alcanza más de 2 meses';
  }
  const quedan = n => `${plural(n, 'Queda', 'Quedan')} ${n}`;
  // Por qué aparece en la lista de compras.
  function razon(a) {
    switch (a.motivo) {
      case 'agotado': return a.ritmo > 0 && a.modo === 'uso' ? `Se terminó · se usa ${ritmoTexto(a.ritmo)}` : 'Se terminó';
      case 'ritmo': return `${quedan(a.stock)} · se usa ${ritmoTexto(a.ritmo)} · ${alcanzaTexto(a.dias)}`;
      case 'cadencia': return `Lo comprás cada ~${Math.max(1, Math.round(a.cadaDias))} días · última compra hace ${a.diasUltCompra} ${plural(a.diasUltCompra, 'día', 'días')}`;
      case 'aviso': return `${quedan(a.stock)} · avisa con ${a.aviso} o menos`;
      case 'pedido': return 'Lo anotaron en la lista';
      default: return '';
    }
  }
  // Renglón corto para la alacena, haga falta comprar o no.
  function situacion(a) {
    if (a.motivo === 'agotado') return { tono: 'rojo', etiqueta: 'Sin stock', texto: a.modo === 'uso' ? `se usa ${ritmoTexto(a.ritmo)}` : '' };
    if (a.motivo === 'ritmo') return { tono: 'ambar', etiqueta: 'Queda poco', texto: alcanzaTexto(a.dias) };
    if (a.motivo === 'aviso') return { tono: 'ambar', etiqueta: 'Queda poco', texto: '' };
    if (a.motivo === 'cadencia') return { tono: 'ambar', etiqueta: 'Toca reponer', texto: `lo comprás cada ~${Math.max(1, Math.round(a.cadaDias))} días` };
    if (a.motivo === 'pedido') return { tono: 'ambar', etiqueta: 'En la lista', texto: '' };
    if (a.modo === 'uso') return { tono: '', etiqueta: '', texto: alcanzaTexto(a.dias) };
    return { tono: '', etiqueta: '', texto: '' };
  }

  // productos: iterable de [id, producto]. Devuelve lo que conviene comprar, lo más urgente primero.
  function listaCompras(productos, hoy, frec) {
    const out = [];
    for (const [id, p] of productos) {
      const a = analizar(p, hoy, frec);
      if (!a.motivo) continue;
      out.push({ id, p, a, costo: p.precio > 0 ? redondear2(p.precio * a.cant) : null });
    }
    out.sort((x, y) => x.a.urgencia - y.a.urgencia || String(x.p.nombre).localeCompare(String(y.p.nombre), 'es'));
    return out;
  }

  /* ---------- gastos ---------- */
  // Reparte el total del ticket entre categorías según sus renglones (los descuentos se prorratean).
  function repartoTicket(t) {
    const out = {}, items = Array.isArray(t.items) ? t.items : [];
    const total = +t.total || 0;
    let suma = 0;
    for (const it of items) if (+it.i > 0) suma += +it.i;
    if (!(suma > 0)) { out[CATS[t.cat] ? t.cat : 'otros'] = total; return out; }
    const f = total / suma;
    for (const it of items) {
      if (!(+it.i > 0)) continue;
      const c = CATS[it.cat] ? it.cat : 'otros';
      out[c] = (out[c] || 0) + it.i * f;
    }
    return out;
  }
  function totalesPorMes(tickets) {
    const m = new Map();
    for (const t of tickets) if (fechaValida(t.fecha)) m.set(mesDe(t.fecha), (m.get(mesDe(t.fecha)) || 0) + (+t.total || 0));
    return m;
  }
  // Gastado en un mes hasta cierto día inclusive.
  function gastoHasta(tickets, mes, dia) {
    let s = 0;
    for (const t of tickets) if (fechaValida(t.fecha) && mesDe(t.fecha) === mes && +t.fecha.slice(8, 10) <= dia) s += +t.total || 0;
    return s;
  }
  function porCategoria(tickets, mes) {
    const acc = {};
    for (const t of tickets) {
      if (!fechaValida(t.fecha) || mesDe(t.fecha) !== mes) continue;
      const r = repartoTicket(t);
      for (const c in r) acc[c] = (acc[c] || 0) + r[c];
    }
    return Object.entries(acc).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]).map(([cat, monto]) => ({ cat, monto }));
  }
  // Tope y paso redondos para el eje del gráfico.
  function escala(max) {
    if (!(max > 0)) return { paso: 1, tope: 1 };
    const bruto = max / 3, pot = Math.pow(10, Math.floor(Math.log10(bruto))), f = bruto / pot;
    const paso = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pot;
    return { paso, tope: Math.ceil(max / paso - 1e-9) * paso };
  }

  return {
    CATS, CATS_ALACENA, ORDEN_CATS, VENTANA,
    hoyISO, isoDe, fechaValida, diaDe, isoDeDia, mesDe, sumarMes, diasDelMes, soloMes, nombreMes, mesCorto, fechaCorta, fechaLarga, diaSemana,
    plata, plataCorta, num, aNumero, campoPlata, redondear2,
    norm, raices, coincide, parecido, textoProducto, buscarParecido, mayuscula, plural,
    precios, aplicarMovs, quitarPrecio, analizar, FRECUENCIAS, esDiario, diarioPorCategoria, horizonteDe, ritmoTexto, alcanzaTexto, razon, situacion, listaCompras,
    repartoTicket, totalesPorMes, gastoHasta, porCategoria, escala,
  };
})();


/* Cuentas para gastar menos, sin pantalla: cuánto subió cada producto, cómo viene la canasta de la casa, qué
   conviene comprar y dónde. Trabaja sobre el historial de precios de cada producto (Nucleo.precios) y, si los
   hay, sobre precios de afuera: los que cargaron otros hogares de la zona. Todo son funciones puras. */
const Ahorro = (() => {
  'use strict';
  const N = Nucleo, ESP = ' ';

  const pct = (v, conSigno) => (conSigno ? (v < -0.0005 ? '−' : v > 0.0005 ? '+' : '') : '') + N.num(Math.abs(v) * 100) + ESP + '%';
  const haceDias = d => (d <= 0 ? 'hoy' : d === 1 ? 'ayer' : d < 60 ? `hace ${d} días` : `hace ${Math.round(d / 30)} meses`);

  /* ---------- un producto: cuánto cambió su precio ---------- */
  // El último precio contra el anterior. null si hay un solo precio.
  function variacion(p) {
    const h = N.precios(p);
    if (h.length >= 2) {
      const a = h[h.length - 2], b = h[h.length - 1];
      return { antes: a[1], ahora: b[1], pct: b[1] / a[1] - 1, dias: b[0] - a[0], dia: b[0], comercio: b[2], comercioAntes: a[2] };
    }
    if (p.precio > 0 && p.precioAnt > 0) return { antes: p.precioAnt, ahora: p.precio, pct: p.precio / p.precioAnt - 1, dias: null, dia: h.length ? h[0][0] : null, comercio: '', comercioAntes: '' };
    return null;
  }
  // Un precio que se está por cargar, contra el último anotado en OTRO día (el de hoy se está corrigiendo).
  function comparar(p, valor, dia) {
    if (!(valor > 0)) return null;
    const h = N.precios(p).filter(e => e[0] < dia), u = h.length ? h[h.length - 1] : null;
    return u ? { antes: u[1], pct: valor / u[1] - 1, dias: dia - u[0], comercio: u[2] } : null;
  }
  // «Última vez $ 1.450 hace 3 días en Día · +10 %»
  function textoComparar(c) {
    if (!c) return '';
    const igual = Math.abs(c.pct) < 0.0005;
    return `Última vez ${N.plata(c.antes)} ${haceDias(c.dias)}${c.comercio ? ` en ${c.comercio}` : ''} · ${igual ? 'mismo precio' : pct(c.pct, true)}`;
  }
  // Cuánto viene cambiando por mes: recta sobre el logaritmo de los precios de los últimos 150 días.
  // null si no hay al menos dos precios separados por dos semanas.
  function tendencia(p, hoy) {
    const h = N.precios(p).filter(e => e[0] > hoy - 150 && e[0] <= hoy + 1);
    if (h.length < 2) return null;
    const d0 = h[0][0], tramo = h[h.length - 1][0] - d0;
    if (tramo < 14) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const e of h) { const x = e[0] - d0, y = Math.log(e[1]); sx += x; sy += y; sxx += x * x; sxy += x * y; }
    const n = h.length, den = n * sxx - sx * sx;
    if (!(den > 0)) return null;
    return { mensual: Math.exp(((n * sxy - sx * sy) / den) * 30.4375) - 1, puntos: n, dias: tramo };
  }
  // El último precio en cada comercio (de los últimos `dias`), del más barato al más caro.
  function porComercio(p, hoy, dias) {
    const m = new Map(), desde = hoy - (dias || 90);
    for (const e of N.precios(p)) {
      if (e[0] <= desde || !e[2]) continue;
      m.set(N.norm(e[2]), { comercio: e[2], ref: e[3], precio: e[1], dia: e[0] });
    }
    return [...m.values()].sort((a, b) => a.precio - b.precio || b.dia - a.dia);
  }
  // Para dibujar la curva del precio.
  function serie(p) {
    const h = N.precios(p);
    if (!h.length) return null;
    let min = Infinity, max = 0;
    for (const e of h) { if (e[1] < min) min = e[1]; if (e[1] > max) max = e[1]; }
    return { puntos: h, min, max, desde: h[0][0], hasta: h[h.length - 1][0] };
  }

  /* ---------- la canasta de la casa ----------
     Cuánto subió lo que compra este hogar en los últimos `dias`: cada producto pesa según lo que se gasta en
     él por mes. Solo entran los productos con un precio dentro del período y otro anterior con qué compararlo.
     `pct` es null si son menos de tres: con tan pocos no se puede hablar de «la canasta». */
  function inflacion(productos, hoy, dias, frec) {
    dias = dias || 30;
    const items = [];
    let peso = 0, suma = 0, n = 0;
    for (const [id, p] of productos) {
      const h = N.precios(p);
      if (h.length < 2) continue;
      const fin = h[h.length - 1];
      if (fin[0] <= hoy - dias || fin[0] > hoy + 1) continue;
      let base = null;
      for (const e of h) { if (e[0] <= hoy - dias) base = e; else break; }
      if (base && base[0] < hoy - dias - 120) base = null;                 // demasiado viejo para comparar
      if (!base) { const e = h.find(x => x[0] > hoy - dias); if (e && fin[0] - e[0] >= 14) base = e; }
      if (!base || base === fin) continue;
      const razon = fin[1] / base[1], raro = razon > 3 || razon < 1 / 3;   // un precio mal cargado no mueve la canasta
      const a = N.analizar(p, hoy, frec || 7), w = base[1] * (a.ritmo > 0 ? a.ritmo * 30 : 1);
      items.push({ id, nombre: p.nombre, antes: base[1], ahora: fin[1], pct: razon - 1, dias: fin[0] - base[0], raro });
      if (!raro) { peso += w; suma += w * razon; n++; }
    }
    items.sort((x, y) => y.pct - x.pct || String(x.nombre).localeCompare(String(y.nombre), 'es'));
    return { pct: n >= 3 && peso > 0 ? suma / peso - 1 : null, n, dias, items };
  }

  /* ---------- tamaños y precio por kilo, litro o unidad ---------- */
  const PESO = { kg: 1, kilo: 1, kilos: 1, kgs: 1, g: 0.001, gr: 0.001, grs: 0.001, gramos: 0.001 };
  const VOLUMEN = { l: 1, lt: 1, lts: 1, litro: 1, litros: 1, ml: 0.001, cc: 0.001, cm3: 0.001 };
  const CUENTA = 'u|un|uni|unid|unidad|unidades|rollos?|sobres?|saquitos?|comp|comprimidos?|capsulas?|panales|latas?|botellas?|paquetes?|porciones?|pastillas?|bolsas?';
  const MED = '(\\d+(?:[.,]\\d+)?)\\s*(kgs?|kilos?|gramos|grs?|g|litros?|lts?|ml|cm3|cc|l)\\b';
  const RE_MULTI = new RegExp('(\\d+)\\s*(?:(?:' + CUENTA + ')\\.?\\s*)?(?:x|por)\\s*' + MED);
  const RE_MED = new RegExp(MED), RE_CUENTA = new RegExp('(\\d+)\\s*(?:' + CUENTA + ')\\b');
  // '1,5 L' → { cant: 1.5, unidad: 'l' } · '6 x 1,5 l' → 9 l · 'docena' → 12 u · 'por peso' → null
  function medida(texto) {
    const s = String(texto == null ? '' : texto).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/×/g, 'x').replace(/\s+/g, ' ').trim();
    if (!s) return null;
    if (/\bdocenas?\b/.test(s)) {
      const m = /(\d+(?:[.,]\d+)?)\s*docenas?/.exec(s);
      return { cant: 12 * (/\bmedia docena\b/.test(s) ? 0.5 : m ? N.aNumero(m[1]) : 1), unidad: 'u' };
    }
    let veces = 1, m = RE_MULTI.exec(s);
    if (m) veces = +m[1]; else m = RE_MED.exec(s);
    if (m) {
      const n = N.aNumero(m[m.length - 2]), u = m[m.length - 1], f = PESO[u] != null ? PESO[u] : VOLUMEN[u];
      if (!(n > 0) || f == null || !(veces > 0)) return null;
      return { cant: Math.round(n * f * veces * 1e6) / 1e6, unidad: PESO[u] != null ? 'kg' : 'l' };
    }
    m = RE_CUENTA.exec(s);
    return m && +m[1] > 0 ? { cant: +m[1], unidad: 'u' } : null;
  }
  const NOMBRE_UNIDAD = { kg: 'kilo', l: 'litro', u: 'unidad' };
  function precioUnitario(p) {
    const m = medida(p.presentacion);
    if (!m || !(p.precio > 0) || !(m.cant > 0)) return null;
    return { valor: p.precio / m.cant, unidad: m.unidad, texto: `${N.plata(p.precio / m.cant, true)} por ${NOMBRE_UNIDAD[m.unidad]}` };
  }

  /* ---------- qué productos son «lo mismo» (otra marca u otro tamaño) ---------- */
  const VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'en', 'a', 'al', 'para', 'por', 'con', 'x', 'kg', 'kilo', 'g', 'gr', 'grs', 'l', 'lt', 'lts', 'litro', 'ml', 'cc', 'u', 'un', 'unidad']);
  // Plural y singular quedan iguales: fideos → fideo, panes → pan, arroces → arroz.
  function raiz(t) {
    if (t.length > 3 && t.endsWith('s')) t = t.slice(0, -1);
    if (t.length > 3 && /[^aeiou]e$/.test(t)) t = t.slice(0, -1);
    if (t.length > 3 && t.endsWith('c')) t = t.slice(0, -1) + 'z';
    return t;
  }
  function fichasTipo(texto) {
    const out = new Set();
    for (const t of N.norm(texto).split(' ')) if (t && !VACIAS.has(t) && !/^\d/.test(t)) out.add(raiz(t));
    return out;
  }
  const tipoDe = p => [...fichasTipo(p.nombre)].sort().join(' ');           // 'Fideos tirabuzón' → 'fideo tirabuzon'
  function esDelTipo(texto, tipo) {
    if (!tipo) return false;
    const f = fichasTipo(texto);
    return tipo.split(' ').every(t => f.has(t));
  }
  function agrupar(productos) {
    const m = new Map();
    for (const par of productos || []) {
      const t = tipoDe(par[1]);
      if (!t) continue;
      if (!m.has(t)) m.set(t, []);
      m.get(t).push(par);
    }
    return m;
  }

  /* ---------- distancias y zonas ---------- */
  const RAD = Math.PI / 180;
  function distancia(lat1, lon1, lat2, lon2) {
    const a = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  const distTexto = m => (m < 950 ? `${Math.max(50, Math.round(m / 50) * 50)}${ESP}m` : `${N.num(m / 1000)}${ESP}km`);
  const puntoValido = (lat, lon) => typeof lat === 'number' && typeof lon === 'number' && isFinite(lat) && isFinite(lon)
    && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && !(lat === 0 && lon === 0);
  /* El mundo en cuadros de una décima de grado (unos 11 km de alto por 9 de ancho en Buenos Aires). Los
     precios que comparten los hogares se guardan por cuadro: así cada teléfono pide solo los de su zona. */
  const PASO = 0.1;
  const indice = (v, corrimiento, paso) => Math.floor((v + corrimiento) / paso + 1e-9);
  const celda = (lat, lon, paso) => `${indice(lat, 90, paso || PASO)}x${indice(lon, 180, paso || PASO)}`;     // Obelisco → '553x1216'
  function celdasCerca(lat, lon, radio, paso) {
    paso = paso || PASO;
    const dLat = radio / 111320, dLon = radio / (111320 * Math.max(0.05, Math.cos(lat * RAD)));
    const y0 = indice(lat - dLat, 90, paso), y1 = indice(lat + dLat, 90, paso), x0 = indice(lon - dLon, 180, paso), x1 = indice(lon + dLon, 180, paso), out = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push(`${y}x${x}`);
    return out;
  }

  /* ---------- precios de afuera ----------
     Cada uno: { precio, k (el comercio: su identificador), lat, lon, dia, cuantos, comercio (su nombre, si se sabe),
     propio (lo cargó este mismo hogar), hogar (el nombre público del hogar que lo cargó), si / no (cuántos lo recomiendan o no) }.
     Se deja el último de cada comercio y se ordenan del más barato al más caro; `pos` y `radio` descartan los lejanos. */
  function ordenarCerca(lista, pos, radio) {
    const m = new Map();
    for (const o of lista || []) {
      if (!(o.precio > 0) || !puntoValido(o.lat, o.lon)) continue;
      const dist = pos ? distancia(pos.lat, pos.lon, o.lat, o.lon) : null;
      if (pos && radio && dist > radio) continue;
      const k = o.k || `${o.lat.toFixed(4)},${o.lon.toFixed(4)}`, ya = m.get(k);
      if (!ya || o.dia > ya.dia) m.set(k, Object.assign({}, o, { dist }));
    }
    return [...m.values()].sort((a, b) => a.precio - b.precio || (a.dist || 0) - (b.dist || 0));
  }
  /* ¿Conviene ese precio de afuera? Tiene que ser por lo menos 3 % más barato que lo que se viene pagando.
     No cuenta el que cargó este mismo hogar (`propio`: eso ya lo sabe), ni el que cuesta menos del 40 % de lo
     que se paga: un precio así casi siempre está mal cargado o es de otro producto. */
  const conviene = (o, precio) => precio > 0 && !o.propio && o.precio <= precio * 0.97 && o.precio >= precio * 0.4;
  const masBaratos = (cerca, precio) => (cerca || []).filter(o => conviene(o, precio));
  // Quién lo cargó: el nombre público del hogar, si eligió uno; y cuántas veces se confirmó ese precio.
  const origen = o => (o.oficial ? 'precio oficial del súper' : (o.propio ? 'lo cargó tu hogar' : `lo cargó ${o.hogar || 'otro hogar'}`) + (o.cuantos > 1 ? ` · confirmado ${o.cuantos} veces` : ''));
  // Cuántos hogares de la zona recomiendan (o no) un producto, sumando lo de cada comercio: «3 lo recomiendan · 1 no».
  function recoTexto(l) {
    let si = 0, no = 0;
    for (const o of l || []) { si += +o.si || 0; no += +o.no || 0; }
    if (!si && !no) return '';
    return [si ? `👍 ${si} ${si === 1 ? 'hogar lo recomienda' : 'hogares lo recomiendan'}` : '', no ? `👎 ${no} no` : ''].filter(Boolean).join(' · ');
  }
  // «$ 1.200 en Día, a 600 m» · sin nombre del comercio: «$ 1.200 a 600 m»
  function textoCerca(o) {
    const donde = [o.comercio ? `en ${o.comercio}` : '', o.dist != null ? `a ${distTexto(o.dist)}` : ''].filter(Boolean);
    return `${N.plata(o.precio)}${donde.length ? ' ' + donde.join(', ') : ''}`;
  }

  /* ---------- consejos para un renglón de la lista de compras ----------
     x: { id, p, a } de Nucleo.listaCompras · ctx: { hoy, frec, productos, porTipo?, cerca: Map id → precios de afuera, resto }
     Devuelve [{ tipo, texto, ahorro, … }], el que más ahorra primero y lo informativo al final. Los tipos:
       cerca     otros lo consiguieron más barato cerca
       comercio  este mismo hogar lo pagó menos en otro comercio
       marca     otra marca del mismo producto rinde más (no se sugiere si el hogar prefiere su marca)
       tamano    otro tamaño de la misma marca rinde más
       stock     viene subiendo: conviene llevar de más
       subio / bajo   cómo cambió desde la compra anterior */
  const DURAN = new Set(['almacen', 'bebidas', 'limpieza', 'higiene', 'mascotas']);
  function consejos(x, ctx) {
    const p = x.p, a = x.a, hoy = ctx.hoy, out = [];
    const h = N.precios(p), ult = h.length ? h[h.length - 1] : null, precio = p.precio > 0 ? p.precio : ult ? ult[1] : 0;
    const baratos = masBaratos(ctx.cerca && ctx.cerca.get(x.id), precio);
    if (baratos.length) {
      const o = baratos[0];
      out.push({ tipo: 'cerca', texto: `Más barato cerca: ${textoCerca(o)} (${origen(o)})`, ahorro: N.redondear2((precio - o.precio) * a.cant), oferta: o, cuantos: baratos.length });
    }
    if (ult && ult[2]) {
      const otros = porComercio(p, hoy, 60).filter(c => N.norm(c.comercio) !== N.norm(ult[2]) && c.precio <= ult[1] * 0.97 && c.dia >= ult[0] - 21);
      if (otros.length) {
        const c = otros[0];
        out.push({ tipo: 'comercio', texto: `En ${c.comercio} lo pagaste ${N.plata(c.precio)} (${haceDias(hoy - c.dia)}); en ${ult[2]}, ${N.plata(ult[1])}`, ahorro: N.redondear2((ult[1] - c.precio) * a.cant), comercio: c.comercio, ref: c.ref });
      }
    }
    const pu = precioUnitario(p), tipo = tipoDe(p);
    if (pu && tipo && ult) {
      let mejor = null;
      for (const [id, q] of (ctx.porTipo || agrupar(ctx.productos)).get(tipo) || []) {
        if (id === x.id || !!q.ejemplo !== !!p.ejemplo) continue;
        const otraMarca = N.norm(q.marca) !== N.norm(p.marca);
        if (otraMarca && p.marcaFija) continue;                 // prefiere su marca: no se le ofrece otra
        const qu = precioUnitario(q), hq = N.precios(q), uq = hq.length ? hq[hq.length - 1] : null;
        if (!qu || !uq || qu.unidad !== pu.unidad || Math.abs(uq[0] - ult[0]) > 30) continue;      // precios de la misma época
        if (qu.valor <= pu.valor * 0.95 && (!mejor || qu.valor < mejor.qu.valor)) mejor = { id, q, qu, otraMarca };
      }
      if (mejor) {
        const m = medida(p.presentacion), baja = 1 - mejor.qu.valor / pu.valor;
        out.push({
          tipo: mejor.otraMarca ? 'marca' : 'tamano', id: mejor.id,
          texto: `${mejor.otraMarca ? (mejor.q.marca || 'Otra marca') : `El de ${mejor.q.presentacion}`} rinde más: ${mejor.qu.texto}, ${pct(baja)} menos que este`,
          ahorro: N.redondear2((pu.valor - mejor.qu.valor) * m.cant * a.cant),
        });
      }
    }
    const t = tendencia(p, hoy);
    if (t && t.mensual >= 0.03 && (t.puntos >= 3 || t.dias >= 21) && a.ritmo > 0 && precio > 0 && DURAN.has(p.categoria)) {
      const diasMas = Math.min(30, 2 * (ctx.frec || 7)), extra = Math.max(1, Math.round(a.ritmo * diasMas));
      const ahorro = N.redondear2(extra * precio * t.mensual * (diasMas / 30) / 2);
      if (ahorro >= 1 && (ctx.resto == null || ctx.resto >= (a.cant + extra) * precio)) {
        out.push({ tipo: 'stock', texto: `Viene subiendo ${pct(t.mensual)} por mes: llevando ${extra} más (${diasMas} días de consumo) ahorrás unos ${N.plata(ahorro, true)}`, ahorro, extra });
      }
    }
    const v = variacion(p);
    if (v && v.dias != null && Math.abs(v.pct) >= 0.02 && hoy - v.dia <= 45) {
      out.push({ tipo: v.pct > 0 ? 'subio' : 'bajo', texto: `${v.pct > 0 ? 'Subió' : 'Bajó'} ${pct(v.pct)} en ${v.dias} ${N.plural(v.dias, 'día', 'días')}: de ${N.plata(v.antes)} a ${N.plata(v.ahora)}`, ahorro: 0 });
    }
    return out.sort((x1, x2) => x2.ahorro - x1.ahorro);       // a igual ahorro queda el orden de arriba
  }

  /* ---------- el plan de la compra ----------
     compras: la lista de Nucleo.listaCompras · ctx: como en consejos, más { presupuesto, gastado }
     Devuelve los consejos de cada renglón, cuánto se puede ahorrar yendo a otro comercio y en cuáles, y —si hay
     presupuesto y la compra no entra— qué se puede dejar para la próxima (lo menos urgente). */
  function plan(compras, ctx) {
    const porId = new Map(), comercios = new Map();
    ctx = Object.assign({}, ctx, { porTipo: ctx.porTipo || agrupar(ctx.productos) });
    let total = 0, sinPrecio = 0, ahorro = 0;
    for (const x of compras) {
      const cs = consejos(x, ctx);
      porId.set(x.id, cs);
      if (x.costo == null) sinPrecio++; else total += x.costo;
      const mejor = cs.find(c => c.ahorro > 0 && (c.tipo === 'cerca' || c.tipo === 'comercio'));
      if (!mejor) continue;
      ahorro += mejor.ahorro;
      const k = mejor.tipo === 'cerca' ? 'k:' + mejor.oferta.k : 'n:' + N.norm(mejor.comercio);
      const c = comercios.get(k) || { comercio: mejor.tipo === 'cerca' ? (mejor.oferta.comercio || '') : mejor.comercio, k: mejor.tipo === 'cerca' ? mejor.oferta.k : (mejor.ref || ''), ahorro: 0, productos: 0, oferta: mejor.oferta || null };
      c.ahorro = N.redondear2(c.ahorro + mejor.ahorro); c.productos++;
      comercios.set(k, c);
    }
    const out = { porId, total: N.redondear2(total), sinPrecio, ahorro: N.redondear2(ahorro), comercios: [...comercios.values()].sort((a, b) => b.ahorro - a.ahorro), presupuesto: null };
    if (ctx.presupuesto > 0) {
      const resto = ctx.presupuesto - (ctx.gastado || 0);
      const pr = { resto: N.redondear2(resto), excede: total > resto + 0.5, postergar: [] };
      if (pr.excede) {
        let sobra = total - Math.max(0, resto);
        for (const x of compras.slice().sort((m, n) => n.a.urgencia - m.a.urgencia)) {
          if (sobra <= 0) break;
          if (x.costo == null || x.a.motivo === 'agotado') continue;       // lo que ya se terminó no se posterga
          pr.postergar.push({ id: x.id, nombre: x.p.nombre, costo: x.costo });
          sobra -= x.costo;
        }
      }
      out.presupuesto = pr;
    }
    return out;
  }

  // Para Novedades: qué productos cambiaron de precio en su última compra, del que más subió al que más bajó.
  function cambios(productos, hoy, dias) {
    const out = [];
    for (const [id, p] of productos) {
      const v = variacion(p);
      if (!v || v.dias == null || hoy - v.dia > (dias || 45) || Math.abs(v.pct) < 0.005) continue;
      out.push({ id, nombre: p.nombre, marca: p.marca || '', pct: v.pct, antes: v.antes, ahora: v.ahora, dias: v.dias, hace: hoy - v.dia, comercio: v.comercio });
    }
    return out.sort((a, b) => b.pct - a.pct || a.hace - b.hace);
  }

  return {
    pct, haceDias, variacion, comparar, textoComparar, tendencia, porComercio, serie, inflacion,
    medida, precioUnitario, fichasTipo, tipoDe, esDelTipo, agrupar,
    distancia, distTexto, puntoValido, celda, celdasCerca, PASO,
    ordenarCerca, conviene, masBaratos, origen, recoTexto, textoCerca, consejos, plan, cambios,
  };
})();


/* Fotos: abrir un archivo de imagen, copiarlo (o recortarlo) a un lienzo y pasarlo a grises o a JPEG. */
const Imagen = (() => {
  'use strict';

  const esImagen = f => !!f && (/^image\//.test(f.type) || !f.type);

  // Abre la foto respetando su orientación. Devuelve { src, w, h, cerrar }.
  async function abrir(archivo) {
    const url = URL.createObjectURL(archivo);
    try {
      const img = new Image();
      img.decoding = 'async';
      await new Promise((ok, mal) => { img.onload = ok; img.onerror = mal; img.src = url; });
      if (!img.naturalWidth) throw new Error('imagen vacía');
      return { src: img, w: img.naturalWidth, h: img.naturalHeight, cerrar: () => URL.revokeObjectURL(url) };
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  }

  // Copia la imagen, o el recorte `r` = { x, y, w, h }, a un lienzo cuyo lado mayor no pasa de `lado`.
  function lienzo(im, lado, r) {
    r = r || { x: 0, y: 0, w: im.w, h: im.h };
    const k = Math.min(1, lado / Math.max(r.w, r.h)), c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(r.w * k)); c.height = Math.max(1, Math.round(r.h * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im.src, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    return c;
  }

  const aBlob = (c, calidad) => new Promise((ok, mal) => c.toBlob(b => (b ? ok(b) : mal(new Error('sin imagen'))), 'image/jpeg', calidad || 0.87));

  // Un valor de gris (0 a 255) por píxel.
  function grises(c) {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    const n = c.width * c.height, lum = new Uint8Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) lum[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
    return lum;
  }

  return { esImagen, abrir, lienzo, aBlob, grises };
})();


/* Dibuja códigos QR, para pasar el código de invitación del hogar de un dispositivo a otro.
   Codifica texto en modo byte con corrección de errores media (nivel M), versiones 1 a 10: hasta 213 bytes,
   de sobra para una dirección web. Devuelve la matriz de módulos o un SVG listo para insertar. */
const QR = (() => {
  'use strict';

  /* ---------- aritmética de Reed-Solomon sobre GF(256) ---------- */
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
  // Los bytes de corrección de un bloque: el resto de dividir los datos por el polinomio generador.
  function correccion(datos, n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const s = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { s[j] ^= g[j]; s[j + 1] ^= mul(g[j], EXP[i]); }
      g = s;
    }
    const r = new Array(n).fill(0);
    for (const d of datos) {
      const f = d ^ r.shift();
      r.push(0);
      for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f);
    }
    return r;
  }

  /* ---------- tablas del estándar, nivel M ---------- */
  // por versión: bytes de corrección por bloque y grupos [cantidad de bloques, bytes de datos por bloque]
  const BLOQUES = [null,
    [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
    [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
  // centros de los patrones de alineación
  const ALINEACION = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  const bytesDeDatos = v => BLOQUES[v][1].reduce((s, g) => s + g[0] * g[1], 0);
  const capacidad = v => Math.floor((bytesDeDatos(v) * 8 - 4 - (v < 10 ? 8 : 16)) / 8);

  /* ---------- del texto a los bytes finales ---------- */
  function codificar(bytes, v) {
    const total = bytesDeDatos(v), bits = [];
    const poner = (valor, n) => { for (let i = n - 1; i >= 0; i--) bits.push((valor >>> i) & 1); };
    poner(4, 4);                                  // modo byte
    poner(bytes.length, v < 10 ? 8 : 16);
    for (const b of bytes) poner(b, 8);
    poner(0, Math.min(4, total * 8 - bits.length));
    while (bits.length % 8) bits.push(0);
    const datos = [];
    for (let i = 0; i < bits.length; i += 8) datos.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
    for (let relleno = 0xec; datos.length < total; relleno ^= 0xec ^ 0x11) datos.push(relleno);
    // en bloques, cada uno con su corrección, y después intercalados byte a byte
    const [nEc, grupos] = BLOQUES[v], bloques = [];
    let k = 0;
    for (const [cant, largo] of grupos) for (let i = 0; i < cant; i++) { const d = datos.slice(k, k + largo); k += largo; bloques.push({ d, e: correccion(d, nEc) }); }
    const out = [], maxD = Math.max(...bloques.map(b => b.d.length));
    for (let i = 0; i < maxD; i++) for (const b of bloques) if (i < b.d.length) out.push(b.d[i]);
    for (let i = 0; i < nEc; i++) for (const b of bloques) out.push(b.e[i]);
    return out;
  }

  /* ---------- la matriz ---------- */
  function armar(bytes, v, mascaraFija) {
    const n = 17 + 4 * v;
    const m = Array.from({ length: n }, () => new Array(n).fill(false));      // módulo oscuro
    const fija = Array.from({ length: n }, () => new Array(n).fill(false));   // parte del dibujo fijo, no de los datos
    const fijar = (x, y, oscuro) => { m[y][x] = !!oscuro; fija[y][x] = true; };

    // líneas de sincronismo
    for (let i = 0; i < n; i++) { fijar(6, i, i % 2 === 0); fijar(i, 6, i % 2 === 0); }
    // los tres buscadores, con su separador
    for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < n && y >= 0 && y < n) fijar(x, y, d !== 2 && d !== 4);
      }
    }
    // patrones de alineación (menos los que caerían sobre un buscador)
    const al = ALINEACION[v];
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) fijar(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    // lugar de la información de formato (se completa al elegir la máscara) y de versión
    const formato = mascara => {
      let resto = mascara;                         // nivel M = 00, más los tres bits de la máscara
      for (let i = 0; i < 10; i++) resto = (resto << 1) ^ ((resto >>> 9) * 0x537);
      const bits = ((mascara << 10) | resto) ^ 0x5412, bit = i => ((bits >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) fijar(8, i, bit(i));
      fijar(8, 7, bit(6)); fijar(8, 8, bit(7)); fijar(7, 8, bit(8));
      for (let i = 9; i < 15; i++) fijar(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) fijar(n - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) fijar(8, n - 15 + i, bit(i));
      fijar(8, n - 8, true);
    };
    formato(0);
    if (v >= 7) {
      let resto = v;
      for (let i = 0; i < 12; i++) resto = (resto << 1) ^ ((resto >>> 11) * 0x1f25);
      const bits = (v << 12) | resto;
      for (let i = 0; i < 18; i++) {
        const oscuro = ((bits >>> i) & 1) === 1, a = n - 11 + (i % 3), b = Math.floor(i / 3);
        fijar(a, b, oscuro); fijar(b, a, oscuro);
      }
    }
    // los datos, en zigzag de a dos columnas desde abajo a la derecha
    let k = 0;
    for (let der = n - 1; der >= 1; der -= 2) {
      if (der === 6) der = 5;
      for (let paso = 0; paso < n; paso++) for (let j = 0; j < 2; j++) {
        const x = der - j, sube = ((der + 1) & 2) === 0, y = sube ? n - 1 - paso : paso;
        if (!fija[y][x] && k < bytes.length * 8) { m[y][x] = ((bytes[k >>> 3] >>> (7 - (k & 7))) & 1) === 1; k++; }
      }
    }
    // máscara: se prueba cada una y queda la que da el dibujo más fácil de leer
    const MASCARAS = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
      (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];
    const enmascarar = i => { for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (!fija[y][x] && MASCARAS[i](x, y)) m[y][x] = !m[y][x]; };
    let mejor = mascaraFija == null ? -1 : mascaraFija, menor = Infinity;
    for (let i = 0; mascaraFija == null && i < 8; i++) {
      enmascarar(i); formato(i);
      const p = penalidad(m, n);
      if (p < menor) { menor = p; mejor = i; }
      enmascarar(i);                               // aplicarla de nuevo la deshace
    }
    enmascarar(mejor); formato(mejor);
    return m;
  }

  // Cuánto dificulta la lectura un dibujo: tramos largos de un color, bloques, falsos buscadores y desbalance.
  function penalidad(m, n) {
    let p = 0, oscuros = 0;
    const linea = leer => {
      for (let a = 0; a < n; a++) {
        let tramo = 1;
        for (let b = 1; b <= n; b++) {
          if (b < n && leer(a, b) === leer(a, b - 1)) tramo++;
          else { if (tramo >= 5) p += tramo - 2; tramo = 1; }
        }
        // 1:1:3:1:1 con cuatro claros a un lado: parece un buscador
        for (let b = 0; b + 10 < n; b++) {
          const s = [];
          for (let i = 0; i < 11; i++) s.push(leer(a, b + i) ? 1 : 0);
          const t = s.join('');
          if (t === '10111010000' || t === '00001011101') p += 40;
        }
      }
    };
    linea((y, x) => m[y][x]); linea((x, y) => m[y][x]);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (m[y][x]) oscuros++;
      if (x + 1 < n && y + 1 < n && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) p += 3;
    }
    return p + Math.floor(Math.abs(oscuros * 20 - n * n * 10) / (n * n)) * 10;
  }

  // La matriz de módulos (true = oscuro) para un texto, o null si es demasiado largo.
  function matriz(texto, mascaraFija) {
    const bytes = Array.from(new TextEncoder().encode(String(texto)));
    let v = 1;
    while (v <= 10 && capacidad(v) < bytes.length) v++;
    return v > 10 ? null : armar(codificar(bytes, v), v, mascaraFija);
  }

  // Un SVG con el margen claro que pide el estándar. Siempre oscuro sobre claro, que es como se leen.
  function svg(texto, rotulo) {
    const m = matriz(texto);
    if (!m) return '';
    const n = m.length, t = n + 8;
    let d = '';
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      if (!m[y][x]) continue;
      let largo = 1;
      while (x + largo < n && m[y][x + largo]) largo++;
      d += `M${x + 4} ${y + 4}h${largo}v1h-${largo}z`;
      x += largo - 1;
    }
    const nombre = String(rotulo || 'Código QR').replace(/[&<>"]/g, '');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${t} ${t}" role="img" aria-label="${nombre}" shape-rendering="crispEdges"><rect width="${t}" height="${t}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  return { matriz, svg, capacidad };
})();


/* Las fotos de los tickets: se guardan en este dispositivo, en IndexedDB, una por ticket.
   No viajan a ningún lado: quedan en el dispositivo donde se cargaron. */
const Fotos = (() => {
  'use strict';
  let base = null, sinFotos = !('indexedDB' in window);
  function abrirBase() {
    if (!base) {
      base = new Promise((ok, mal) => {
        const p = indexedDB.open('libreta-fotos', 1);
        p.onupgradeneeded = () => p.result.createObjectStore('fotos');
        p.onsuccess = () => ok(p.result);
        p.onerror = () => mal(p.error);
        p.onblocked = () => mal(new Error('la base de fotos está ocupada'));
      });
    }
    return base;
  }
  const enFotos = (modo, pedir) => abrirBase().then(b => new Promise((ok, mal) => {
    const t = b.transaction('fotos', modo), p = pedir(t.objectStore('fotos'));
    t.oncomplete = () => ok(p.result);
    t.onerror = t.onabort = () => mal(t.error);
  }));
  // Hay navegadores que no dejan usar IndexedDB (por ejemplo en modo privado): ahí los gastos van sin foto.
  if (!sinFotos) { try { abrirBase().catch(() => { sinFotos = true; }); } catch (e) { sinFotos = true; } }

  return {
    disponible: () => !sinFotos,
    async guardar(id, blob) {
      const datos = await new Response(blob).arrayBuffer();   // así lo entienden también los navegadores viejos
      await enFotos('readwrite', s => s.put({ tipo: blob.type || 'image/jpeg', datos }, id));
    },
    async leer(id) {
      const f = await enFotos('readonly', s => s.get(id));
      return f && f.datos ? new Blob([f.datos], { type: f.tipo || 'image/jpeg' }) : null;
    },
    borrar: id => enFotos('readwrite', s => s.delete(id)),
    claves: () => enFotos('readonly', s => s.getAllKeys()),
  };
})();


/* Dónde se guardan los datos de la libreta: en Firebase, de Google.
   Cada persona entra con su cuenta de Google y pertenece a un hogar. Los datos del hogar viven en Cloud
   Firestore y les llegan en directo a todos sus integrantes; Firestore guarda además una copia en cada teléfono,
   así que la libreta sigue andando sin conexión y se pone al día sola cuando la conexión vuelve.

   En Firestore:
     usuarios/{uid}                     { nombre, hogar }           lo que cada cuenta anota de sí: en qué hogar está
     hogares/{hogar}                    { creador, creado, ajustes: { frecuencia, presupuesto, compartir, comercios } }
     hogares/{hogar}/miembros/{uid}     { nombre, desde }           un documento por integrante
     hogares/{hogar}/productos/{id}     el producto; sus historiales van como mapas: log.<día> = { u, c } · px.<día> = { p, s, k }
     hogares/{hogar}/meses/{AAAA-MM}    { t: { <id>: ticket } }     los tickets, juntos por mes
     hogares/{hogar}/notas/{id}         { texto, de, nombre, creada, hasta }
     invitaciones/{código}              { hogar, por, creada }      para sumar a alguien al hogar
     precios/{zona_código_comercio}     los precios que los hogares comparten con su zona: sin cuentas ni nombres de
                                        personas; con el nombre público del hogar, si eligió uno
     comercios/{id}                     los comercios que marcan los hogares cuando no figuran en OpenStreetMap
     promos/{id}                        las promociones que cargan los hogares: qué comercio, qué días, con qué medio de pago
   Quién puede leer y escribir cada cosa lo deciden las reglas de firestore.rules.

   Hay dos maneras de escribir, y se usan para cosas distintas:
     · lo de todos los días (stock, productos, gastos, notas, ajustes) se escribe «en cola»: se ve al instante en
       el teléfono y viaja al servidor cuando hay conexión;
     · lo que cambia quién está en el hogar (crearlo, entrar, invitar, quitar, salir) se hace «en línea», con
       una transacción: o el servidor lo confirma en el momento, o falla diciendo por qué. Nunca queda para después.
   Hacia la app se presenta como una base de documentos: productos, tickets y ajustes. */
const Datos = (() => {
  'use strict';
  const N = Nucleo;
  const VERSION_SDK = '12.19.0';
  // La biblioteca de Firebase se baja del sitio de Google. Para alojarla en otro lado, definí LIBRETA_SDK en config.js.
  const SDK = window.LIBRETA_SDK || `https://www.gstatic.com/firebasejs/${VERSION_SDK}/`;
  // Los datos del proyecto, de config.js: el bloque `const firebaseConfig = {…}` tal cual lo da Firebase.
  let cfg = window.LIBRETA_FIREBASE || {};
  try { if (typeof firebaseConfig === 'object' && firebaseConfig) cfg = firebaseConfig; } catch (e) { /* config.js falló antes de definirlo */ }
  const CLAVE_HOGAR = 'libreta:hogar', CLAVE_DE = 'libreta:de', CLAVE_AVISO = 'libreta:aviso';
  const LETRAS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';     // sin I, O, 0 ni 1, que se confunden al copiarlas
  const VALE_MIN = 15;                                    // minutos que vale un código (lo mismo dicen las reglas)
  /* Cuántos documentos se cambian juntos, como mucho, en un solo pedido. Las reglas de seguridad consultan si
     la persona es integrante del hogar por cada documento, y Firestore admite hasta 20 de esas consultas por pedido. */
  const TANDA = 15;

  const pausa = ms => new Promise(r => setTimeout(r, ms));
  const limpio = d => JSON.parse(JSON.stringify(d));      // sin `undefined`, que Firestore no acepta
  const esMapa = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const guardado = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const configurado = () => !!(cfg.apiKey && cfg.projectId && cfg.appId);
  const idValido = id => /^[A-Za-z0-9_-]{1,80}$/.test(id) && !/^__.*__$/.test(id);

  let F = null;            // la biblioteca de Firebase y sus objetos, una vez cargada
  let H = null;            // el hogar abierto: { id, uid, hogar (ref), bajas }
  let puerta = 'sin-usuario';
  let entrar = null;       // lo que espera la app para arrancar cuando todavía no hay hogar
  let saliendo = false;
  let reteniendo = false;  // se está borrando la cuenta: que el servidor avise la baja no es novedad
  let despedida = '';      // con qué aviso se vuelve a la entrada cuando la salida la pidió esta persona

  /* ---------- cargar Firebase ---------- */
  let cargando = null;
  function cargar() {
    if (!cargando) {
      cargando = (async () => {
        const [a, au, fs] = await Promise.all([import(SDK + 'firebase-app.js'), import(SDK + 'firebase-auth.js'), import(SDK + 'firebase-firestore.js')]);
        const app = a.initializeApp(cfg), auth = au.getAuth(app);
        let db;
        try {   // con copia en el teléfono, compartida entre pestañas; si el navegador no puede, sin copia
          db = fs.initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) });
        } catch (e) { db = fs.getFirestore(app); }
        F = { app, au, fs, auth, db };
        // para que la próxima vez arranque sin conexión, el service worker guarda también la biblioteca
        try {
          if (navigator.serviceWorker) navigator.serviceWorker.ready.then(r => { if (r.active) r.active.postMessage({ guardar: ['firebase-app.js', 'firebase-auth.js', 'firebase-firestore.js'].map(f => SDK + f) }); }, () => {});
        } catch (e) { /* sin service worker */ }
      })();
      cargando.catch(() => { cargando = null; });
    }
    return cargando;
  }
  // Un pedido que necesita al servidor: si no contesta a tiempo, se da por caída la conexión.
  const conTope = (p, ms) => Promise.race([p, pausa(ms || 15000).then(() => { throw { code: 'sin-red' }; })]);
  // La cuenta con la que se entró. Entrar es siempre un paso aparte, que da la persona: acá no se abre nada.
  function sesion() {
    const u = F && F.auth.currentUser;
    if (!u) throw { code: 'sin-usuario' };
    return u;
  }
  const proveedor = () => { const p = new F.au.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return p; };
  const primerNombre = n => String(n || '').replace(/\s+/g, ' ').trim().split(' ')[0].slice(0, 40);
  /* Un cambio «en línea»: una transacción, que le habla al servidor en el momento y, si algo falla, trae el
     motivo. Con un solo intento, para que nunca se cumpla más tarde algo que acá ya se dio por fallido. */
  function enLinea(fn, intentos) {
    if (navigator.onLine === false) return Promise.reject({ code: 'sin-red' });
    return conTope(F.fs.runTransaction(F.db, fn, { maxAttempts: intentos || 1 }), 45000);
  }

  /* Qué decir cuando algo de Firebase falla. Mucho de esto solo pasa mientras se lo configura.
     `enCola`: el error viene de un cambio de todos los días; ahí «no está» es que otro integrante lo borró.
     En lo demás (crear el hogar, entrar, probar la conexión) «no está» es que falta la base de datos. */
  function pista(e, enCola) {
    const c = String((e && e.code) || ''), m = String((e && e.message) || '');
    if (c === 'config') return 'Falta completar config.js con los datos del proyecto de Firebase.';
    if (c === 'sin-usuario') return 'Primero entrá con tu cuenta de Google.';
    if (c === 'codigo') return 'Ese código no existe, ya se usó o venció. Pedile uno nuevo a alguien que ya esté en el hogar.';
    if (c === 'codigo-negado') return 'El servidor no aceptó ese código. Pedí uno nuevo; si vuelve a pasar, revisá que las reglas publicadas en Firebase sean las de firestore.rules.';
    if (c === 'de-nuevo') return 'Justo cambió algo en el servidor. Probá de nuevo.';
    if (c === 'ultimo') return 'Sos la única persona en este hogar.';
    if (c === 'sin-hogar') return 'Este hogar ya no existe en el servidor.';
    if (/operation-not-allowed|admin-restricted-operation|configuration-not-found/.test(c)) return 'Falta habilitar el acceso con Google en Firebase: Authentication → Sign-in method → Google.';
    if (/unauthorized-domain/.test(c)) return `Falta autorizar esta dirección en Firebase: Authentication → Settings → Authorized domains → agregar ${location.hostname}`;
    if (/popup-blocked/.test(c)) return 'El navegador bloqueó la ventana de Google. Permití las ventanas emergentes para esta página y tocá de nuevo.';
    if (/popup-closed-by-user|cancelled-popup-request|user-cancelled/.test(c)) return 'Se cerró la ventana de Google antes de terminar. Tocá de nuevo para elegir tu cuenta.';
    if (/user-disabled/.test(c)) return 'Esa cuenta está deshabilitada en este proyecto de Firebase.';
    if (/user-mismatch/.test(c)) return 'Esa no es la cuenta con la que entraste. Elegí la misma cuenta.';
    if (/requires-recent-login/.test(c)) return 'Por seguridad, Google pide que entres de nuevo antes de borrar la cuenta. Probá otra vez.';
    if (/web-storage-unsupported|operation-not-supported-in-this-environment/.test(c)) return 'Este navegador no deja guardar la sesión (¿está en modo privado?). Abrí la libreta en una ventana común.';
    if (/api-key|invalid-app|app-not-authorized|referer/.test(c)) return 'Los datos de config.js no coinciden con el proyecto de Firebase. Copialos de nuevo.';
    if (/too-many-requests/.test(c)) return 'Demasiados intentos seguidos. Esperá unos minutos y probá de nuevo.';
    if (/network-request-failed|unavailable|sin-red|deadline-exceeded/.test(c)) return 'No hay conexión con el servidor. Revisá internet y probá de nuevo.';
    if (c === 'sin-directo') return 'El servidor contesta, pero la conexión en directo no abre. Puede estar cortándola un bloqueador de anuncios, un antivirus o la red.';
    if ((c === 'not-found' && (!enCola || /does not exist/i.test(m))) || (c === 'permission-denied' && /\bAPI\b|disabled/i.test(m) && !/insufficient/i.test(m))) return 'Falta crear la base de datos Cloud Firestore en el proyecto de Firebase.';
    if (c === 'permission-denied') return 'El servidor rechazó el pedido. Revisá que las reglas de firestore.rules estén publicadas en Firebase.';
    if (c === 'not-found') return 'Eso ya no está en el servidor: lo borró otro integrante.';
    if (c === 'failed-precondition') return 'La base de datos del proyecto no aceptó el pedido. Tiene que ser Cloud Firestore en modo nativo.';
    if (c === 'resource-exhausted') return 'El servidor llegó a su límite de uso por hoy. Mañana vuelve a funcionar; para que no pase, hay que pasar el proyecto de Firebase al plan con pago por uso.';
    if (c === 'invalid-argument' && /exceeds|too large|maximum/i.test(m)) return 'Ese mes ya tiene demasiado guardado para sumar otro gasto.';
    if (c === 'reglas-abiertas') return 'Las reglas publicadas dejan leer hogares ajenos: reemplazalas por las de firestore.rules.';
    return 'Algo falló' + (c ? ` (${c})` : '') + '. Probá de nuevo.';
  }
  // El error, dicho para la app. El código va con prefijo: así la app no lo toma por uno de los que reintenta sola.
  const conPista = (e, enCola) => ({ code: 'nube/' + String((e && e.code) || 'error'), texto: pista(e, enCola) });

  /* ---------- lo que hay en el hogar, como lo ve la app ---------- */
  const prods = new Map();          // id → producto
  const meses = new Map();          // 'AAAA-MM' → { id: ticket }
  const deMes = new Map();          // id de ticket → su mes
  let ajustes = null, integrantes = [], notas = [];
  const meta = { productos: { listo: false, cache: true, pend: false }, tickets: { listo: false, cache: true, pend: false }, ajustes: { listo: false, cache: true, pend: false } };
  const oyentes = { productos: new Set(), tickets: new Set(), ajustes: new Set() };
  const cambios = new Set();        // a quién avisarle que cambió el estado: conexión, pendientes, integrantes, notas
  let enVuelo = 0;
  const avisarCambio = () => { for (const fn of cambios) { try { fn(); } catch (e) { /* cada oyente se cuida solo */ } } };

  /* Del formato de Firestore al de la app: los historiales vuelven a ser listas ordenadas,
     [día, usados, comprados] el de la alacena y [día, precio, comercio, ref] el de precios. */
  function aApp(d) {
    const log = [], px = [];
    for (const k in (d.log || {})) {
      const e = d.log[k] || {}, dia = +k, u = Math.max(0, Math.round(+e.u || 0)), c = Math.max(0, Math.round(+e.c || 0));
      if (isFinite(dia) && (u > 0 || c > 0)) log.push([dia, u, c]);
    }
    log.sort((a, b) => a[0] - b[0]);
    for (const k in (d.px || {})) {
      const e = d.px[k] || {}, dia = +k, v = +e.p;
      if (isFinite(dia) && dia > 0 && v > 0) px.push([dia, v, typeof e.s === 'string' ? e.s : '', typeof e.k === 'string' ? e.k : '']);
    }
    px.sort((a, b) => a[0] - b[0]);
    return Object.assign({}, d, { stock: Math.max(0, Math.round(+d.stock || 0)), log, px });
  }
  function logANube(log) {
    const o = {};
    for (const e of Array.isArray(log) ? log : []) if (Array.isArray(e) && isFinite(e[0])) o[String(e[0])] = { u: Math.max(0, +e[1] || 0), c: Math.max(0, +e[2] || 0) };
    return o;
  }
  const puntoANube = e => { const o = { p: +e[1] }; if (e[2]) o.s = String(e[2]); if (e[3]) o.k = String(e[3]); return o; };
  function pxANube(px) {
    const o = {};
    for (const e of Array.isArray(px) ? px : []) if (Array.isArray(e) && e[0] > 0 && +e[1] > 0) o[String(e[0])] = puntoANube(e);
    return o;
  }
  const aNube = d => Object.assign(limpio(d), { log: logANube(d.log), px: pxANube(d.px) });
  const mesDe = d => (/^\d{4}-\d{2}/.test(String(d && d.fecha)) ? d.fecha.slice(0, 7) : 'sin-fecha');

  const fotoMeta = k => ({ fromCache: meta[k].cache, hasPendingWrites: meta[k].pend });
  function foto(k) {
    if (k === 'ajustes') return { id: 'hogar', exists: !!ajustes, data: () => ajustes, metadata: fotoMeta(k) };
    let lista;
    if (k === 'productos') lista = [...prods].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    else {
      lista = [];
      for (const t of meses.values()) for (const id in t) if (t[id] && typeof t[id] === 'object') lista.push([id, t[id]]);
      lista.sort((a, b) => String(b[1].fecha).localeCompare(String(a[1].fecha)) || (a[0] < b[0] ? -1 : 1));
    }
    const docs = lista.map(([id, d]) => ({ id, exists: true, data: () => d }));
    return { docs, size: docs.length, empty: !docs.length, metadata: fotoMeta(k) };
  }
  function emitir(k) {
    if (!meta[k].listo) return;
    const f = foto(k);
    for (const o of oyentes[k]) { try { o.next(f); } catch (e) { /* un oyente roto no frena a los demás */ } }
  }
  function escuchar(k, next, err) {
    const o = { next, err };
    oyentes[k].add(o);
    if (meta[k].listo) Promise.resolve().then(() => { if (oyentes[k].has(o)) next(foto(k)); });
    return () => oyentes[k].delete(o);
  }

  /* ---------- abrir el hogar: escuchar todo lo suyo ---------- */
  function abrir(id) {
    const { fs, db, auth } = F, uid = auth.currentUser.uid, opciones = { includeMetadataChanges: true };
    const hogar = fs.doc(db, 'hogares', id);
    const marcar = (k, s) => { meta[k] = { listo: true, cache: s.metadata.fromCache, pend: s.metadata.hasPendingWrites }; };
    // Un oyente que falla no vuelve a recibir nada: se le avisa a la app, salvo que el motivo sea que a esta
    // persona la quitaron del hogar (ahí vuelve a la entrada).
    const alFallar = k => async e => {
      if (e && e.code === 'permission-denied' && await negado() === 'fuera') return;
      for (const o of oyentes[k] || []) if (o.err) o.err({ code: 'error', texto: pista(e, true) });
    };
    H = { id, uid, hogar, bajas: [] };
    H.bajas.push(fs.onSnapshot(fs.collection(db, 'hogares', id, 'productos'), opciones, s => {
      prods.clear();
      for (const d of s.docs) {
        const x = d.data();
        prods.set(d.id, aApp(x));
        if (x.stock < 0 && !s.metadata.fromCache && !d.metadata.hasPendingWrites) curar(d.id);
      }
      marcar('productos', s); emitir('productos'); avisarCambio();
    }, alFallar('productos')));
    H.bajas.push(fs.onSnapshot(fs.collection(db, 'hogares', id, 'meses'), opciones, s => {
      meses.clear(); deMes.clear();
      for (const d of s.docs) {
        const t = Object.assign({}, (d.data() || {}).t);
        meses.set(d.id, t);
        for (const tid in t) deMes.set(tid, d.id);
      }
      marcar('tickets', s); emitir('tickets'); avisarCambio();
      if (!s.metadata.fromCache) limpiarFotos();
    }, alFallar('tickets')));
    H.bajas.push(fs.onSnapshot(hogar, opciones, s => {
      const d = s.exists() ? s.data() : null;
      ajustes = d && d.ajustes && typeof d.ajustes === 'object' ? d.ajustes : null;
      marcar('ajustes', s); emitir('ajustes'); avisarCambio();
    }, alFallar('ajustes')));
    H.bajas.push(fs.onSnapshot(fs.collection(db, 'hogares', id, 'miembros'), opciones, s => {
      integrantes = s.docs.map(d => { const x = d.data() || {}; return { id: d.id, nombre: String(x.nombre || 'Integrante'), yo: d.id === uid }; })
        .sort((a, b) => (a.yo ? -1 : b.yo ? 1 : a.nombre.localeCompare(b.nombre, 'es')));
      // lo dijo el servidor y esta persona no figura: la quitó otro integrante
      if (!s.metadata.fromCache && !s.metadata.hasPendingWrites && !integrantes.some(d => d.yo)) { if (!reteniendo) afuera('quitado'); return; }
      avisarCambio();
    }, alFallar('miembros')));
    // Las notas: las vencidas no se muestran y, cuando el servidor confirma que siguen ahí, se borran.
    H.bajas.push(fs.onSnapshot(fs.collection(db, 'hogares', id, 'notas'), opciones, s => {
      const ahora = Date.now(), vencidas = [];
      notas = [];
      for (const d of s.docs) {
        const x = d.data() || {}, hasta = +x.hasta || 0;
        if (hasta > ahora) notas.push({ id: d.id, texto: String(x.texto || ''), de: String(x.de || ''), nombre: String(x.nombre || ''), creada: +x.creada || 0, hasta, mia: x.de === uid });
        else if (!s.metadata.fromCache && !d.metadata.hasPendingWrites) vencidas.push(d.id);
      }
      notas.sort((a, b) => b.creada - a.creada || (a.id < b.id ? -1 : 1));
      for (const nid of vencidas.slice(0, 10)) fs.deleteDoc(fs.doc(db, 'hogares', id, 'notas', nid)).catch(() => {});
      avisarCambio();
    }, alFallar('notas')));
    // si la sesión se cierra por fuera de la libreta (desde otra pestaña, por ejemplo), acá no queda nada abierto
    try { H.bajas.push(F.au.onAuthStateChanged(auth, u => { if ((!u || u.uid !== uid) && !saliendo && !reteniendo) afuera('sesion'); })); } catch (e) { /* sin aviso de sesión */ }
    // los navegadores pueden descartar lo guardado si les falta lugar: se les pide que no (algunos lo conceden solos)
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* no se puede pedir */ }
  }
  /* Las fotos de los tickets quedan en cada teléfono. Si el gasto se borró desde otro, acá queda su foto
     sin dueño: se limpia una vez por visita, al llegar la primera lista de gastos confirmada por el servidor
     (en ese momento todavía no puede haber un gasto nuevo a medio guardar). */
  let fotosLimpias = false;
  async function limpiarFotos() {
    if (fotosLimpias || !Fotos.disponible()) return;
    fotosLimpias = true;
    const espera = fotosEnEspera();
    try { for (const k of await Fotos.claves()) if (!deMes.has(k) && !espera.has(k)) await Fotos.borrar(k); } catch (e) { /* queda para la próxima visita */ }
  }
  // Las fotos de los gastos de la versión anterior no se tocan mientras no se decida qué hacer con esos gastos.
  function fotosEnEspera() { const a = anterior(); return new Set(a ? Object.keys(a.tickets) : []); }
  /* ---------- lo que dejó la versión anterior ----------
     La libreta de un solo dispositivo guardaba todo en el navegador. Si esta versión se publica en la misma
     dirección, esos datos siguen en el teléfono: se ofrece traerlos al hogar (los de ejemplo no cuentan). */
  const VIEJAS = ['productos', 'tickets', 'ajustes', 'sembrado'].map(c => 'libreta:' + c);
  function anterior() {
    const leer = k => { try { const o = JSON.parse(localStorage.getItem(k) || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } };
    const propios = o => { const r = {}; for (const id in o) if (o[id] && typeof o[id] === 'object' && !o[id].ejemplo) r[id] = o[id]; return r; };
    const productos = propios(leer(VIEJAS[0])), tickets = propios(leer(VIEJAS[1]));
    return Object.keys(productos).length || Object.keys(tickets).length ? { libreta: 1, productos, tickets, ajustes: {} } : null;
  }
  function olvidarAnterior() { for (const k of VIEJAS) { try { localStorage.removeItem(k); } catch (e) { /* sin almacenamiento */ } } }
  // Dos teléfonos gastaron a la vez la última unidad y la cuenta quedó bajo cero: se la deja en cero.
  const curando = new Set();
  function curar(id) {
    if (curando.has(id) || !H) return;
    curando.add(id);
    const { fs, db } = F, ref = fs.doc(db, 'hogares', H.id, 'productos', id);
    fs.runTransaction(db, async tx => { const s = await tx.get(ref); if (s.exists() && s.data().stock < 0) tx.update(ref, { stock: 0 }); })
      .catch(() => {}).then(() => curando.delete(id));
  }
  /* El servidor negó un pedido. Puede ser que a esta persona la hayan quitado del hogar, o que las reglas
     de Firebase no estén bien publicadas. Para saberlo se mira el lugar propio en el hogar, que las reglas
     dejan leer siempre: si no está, la quitaron. Devuelve 'fuera', 'reglas' o 'red'. */
  let averiguando = null;
  function negado() {
    if (saliendo) return Promise.resolve('fuera');
    if (!H) return Promise.resolve('reglas');
    if (!averiguando) {
      averiguando = (async () => {
        try {
          const s = await enLinea(tx => tx.get(F.fs.doc(F.db, 'hogares', H.id, 'miembros', H.uid)));
          if (s.exists()) return 'reglas';
          if (reteniendo) return 'fuera';
          afuera('quitado');
          return 'fuera';
        } catch (e) { return e && e.code === 'permission-denied' ? 'reglas' : 'red'; }
      })();
      averiguando.then(() => { averiguando = null; });
    }
    return averiguando;
  }
  /* Esta persona deja de estar en el hogar en este teléfono: se olvida de él, borra su copia de los datos y
     vuelve a la entrada. Con `cerrar`, además se cierra la sesión de Google. */
  async function afuera(motivo, cerrar) {
    if (saliendo) return;
    saliendo = true;
    try { localStorage.removeItem(CLAVE_HOGAR); localStorage.removeItem(CLAVE_DE); sessionStorage.setItem(CLAVE_AVISO, despedida || motivo); } catch (e) { /* sin almacenamiento */ }
    for (const baja of (H && H.bajas) || []) { try { baja(); } catch (e) { /* ya estaba dada de baja */ } }
    const vaciar = async () => {
      const espera = fotosEnEspera();
      if (Fotos.disponible()) for (const k of await Fotos.claves()) if (!espera.has(k)) await Fotos.borrar(k);     // las fotos de los tickets de ese hogar
      await F.fs.terminate(F.db);
      await F.fs.clearIndexedDbPersistence(F.db);
    };
    try { await Promise.race([vaciar(), pausa(3000)]); } catch (e) { /* lo que quede se pisa al entrar a otro hogar */ }
    if (cerrar) { try { await Promise.race([F.au.signOut(F.auth), pausa(3000)]); } catch (e) { /* la sesión queda; se puede cerrar de nuevo desde la entrada */ } }
    location.reload();
  }

  /* ---------- escribir «en cola» ----------
     Firestore aplica cada cambio en el teléfono al instante y lo confirma cuando llega al servidor. Acá se
     espera esa confirmación un momento: si llega, la app se entera de cómo salió; si no (no hay conexión, o
     está lenta), el cambio queda en camino y la app sigue. Si más tarde el servidor lo rechaza, se avisa. */
  let alRechazar = null;
  // Arma el pedido para Firebase. Si los datos no sirven falla acá, antes de mostrar ningún cambio.
  const pedido = fn => { try { return fn(); } catch (e) { throw conPista(e, true); } };
  function enviar(p) {
    let tarde = false;
    enVuelo++; avisarCambio();
    const fin = p.then(() => null, e => e || { code: 'error' });
    fin.then(e => {
      enVuelo--; avisarCambio();
      if (!e) return;
      if (e.code === 'permission-denied') negado();        // ¿quitaron a esta persona del hogar?
      if (tarde && alRechazar) alRechazar(conPista(e, true));
    });
    if (navigator.onLine === false) { tarde = true; return Promise.resolve(); }
    return Promise.race([fin, pausa(2500).then(() => 'tarde')]).then(r => {
      if (r === 'tarde') { tarde = true; return; }
      if (r) throw conPista(r, true);
    });
  }

  const refProd = id => F.fs.doc(F.db, 'hogares', H.id, 'productos', id);
  const refMes = mes => F.fs.doc(F.db, 'hogares', H.id, 'meses', mes);
  const idNuevo = () => F.fs.doc(F.fs.collection(F.db, 'hogares')).id;
  const falta = () => Promise.reject(conPista({ code: 'not-found' }, true));

  const producto = id => ({
    id,
    set(d) {
      const dato = aNube(d), p = pedido(() => F.fs.setDoc(refProd(id), dato));
      prods.set(id, aApp(dato)); emitir('productos');
      return enviar(p);
    },
    update(c) {
      const b = prods.get(id);
      if (!b) return falta();
      const u = limpio(c);
      if (Array.isArray(c.log)) u.log = logANube(c.log);
      if (Array.isArray(c.px)) u.px = pxANube(c.px);
      const p = pedido(() => F.fs.updateDoc(refProd(id), u));
      prods.set(id, Object.assign({}, b, c)); emitir('productos');
      return enviar(p);
    },
    delete() {
      const p = pedido(() => F.fs.deleteDoc(refProd(id)));
      prods.delete(id); emitir('productos');
      return enviar(p);
    },
  });
  /* Movimientos de stock y precios. Al servidor no va «quedan 3» sino «uno menos»: así, si dos personas tocan
     el mismo producto a la vez, las dos cuentas se suman en vez de pisarse. Lo que se manda es la diferencia
     entre cómo se veía el producto acá antes y después del movimiento. Del historial de precios viaja solo
     el día que cambió. */
  function mover(id, movs, precio) {
    const b = prods.get(id);
    if (!b) return falta();
    const { fs } = F, hoy = N.diaDe(N.hoyISO()), campos = N.aplicarMovs(b, movs, hoy, precio), acto = new Date().toISOString();
    const args = [], antes = new Map((b.log || []).map(e => [e[0], e])), siguen = new Set();
    const sumar = (campo, n) => { if (n) args.push(campo, fs.increment(n)); };
    const delDia = (dia, k) => new fs.FieldPath('log', String(dia), k);
    sumar('stock', campos.stock - b.stock);
    for (const e of campos.log) {
      const a = antes.get(e[0]) || [e[0], 0, 0];
      siguen.add(e[0]);
      sumar(delDia(e[0], 'u'), e[1] - a[1]); sumar(delDia(e[0], 'c'), e[2] - a[2]);
    }
    let viejos = 0;
    for (const [dia, a] of antes) {
      if (siguen.has(dia)) continue;
      // un día que quedó en cero se resta, no se borra: otra persona pudo haber anotado algo ese día
      if (dia > hoy - 200 && dia <= hoy + 1) { sumar(delDia(dia, 'u'), -a[1]); sumar(delDia(dia, 'c'), -a[2]); }
      else if (viejos++ < 20) args.push(new fs.FieldPath('log', String(dia)), fs.deleteField());     // ya no cuenta para el ritmo de consumo
    }
    if ('precio' in campos) {
      args.push('precio', campos.precio, 'precioFecha', campos.precioFecha);
      if ('precioAnt' in campos) args.push('precioAnt', campos.precioAnt);
    }
    if (campos.px) {
      const pxAntes = new Map((b.px || []).map(e => [e[0], e])), quedan = new Set();
      for (const e of campos.px) {
        const a = pxAntes.get(e[0]);
        quedan.add(e[0]);
        if (!a || a[1] !== e[1] || a[2] !== e[2] || a[3] !== e[3]) args.push(new fs.FieldPath('px', String(e[0])), puntoANube(e));
      }
      for (const dia of pxAntes.keys()) if (!quedan.has(dia)) args.push(new fs.FieldPath('px', String(dia)), fs.deleteField());
    }
    if (!args.length) return Promise.resolve();
    args.push('act', acto);
    const p = pedido(() => fs.updateDoc(refProd(id), args[0], args[1], ...args.slice(2)));
    prods.set(id, Object.assign({}, b, campos, { act: acto })); emitir('productos');
    return enviar(p);
  }
  const ticket = id => ({
    id,
    set(d) {
      const { fs, db: base } = F, dato = limpio(d), mes = mesDe(dato), viejo = deMes.get(id), campo = new fs.FieldPath('t', id);
      // en el documento del mes se reemplaza solo este ticket (campo t.<id>); los demás no se tocan
      const p = pedido(() => {
        if (!viejo || viejo === mes) return fs.setDoc(refMes(mes), { t: { [id]: dato } }, { mergeFields: [campo] });
        const lote = fs.writeBatch(base);        // cambió de mes: sale de uno y entra al otro, todo junto
        lote.update(refMes(viejo), campo, fs.deleteField());
        lote.set(refMes(mes), { t: { [id]: dato } }, { mergeFields: [campo] });
        return lote.commit();
      });
      if (viejo && viejo !== mes && meses.get(viejo)) delete meses.get(viejo)[id];
      if (!meses.has(mes)) meses.set(mes, {});
      meses.get(mes)[id] = dato; deMes.set(id, mes); emitir('tickets');
      return enviar(p);
    },
    delete() {
      const mes = deMes.get(id);
      if (!mes) return Promise.resolve();
      const p = pedido(() => F.fs.updateDoc(refMes(mes), new F.fs.FieldPath('t', id), F.fs.deleteField()));
      if (meses.get(mes)) delete meses.get(mes)[id];
      deMes.delete(id); emitir('tickets');
      return enviar(p);
    },
  });
  const delHogar = {
    id: 'hogar',
    /* Se manda solo el ajuste que cambió: si otra persona cambió otro al mismo tiempo, quedan los dos. De los
       ajustes que son una lista con nombre (los comercios del hogar) viaja solo el renglón que cambió. */
    set(d) {
      const fs = F.fs, nuevo = limpio(d), antes = ajustes || {}, args = [];
      for (const k in nuevo) {
        const a = antes[k], n = nuevo[k];
        if (JSON.stringify(n) === JSON.stringify(a)) continue;
        if (esMapa(n) && esMapa(a)) {
          for (const j in n) if (JSON.stringify(n[j]) !== JSON.stringify(a[j])) args.push(new fs.FieldPath('ajustes', k, j), n[j]);
          for (const j in a) if (!(j in n)) args.push(new fs.FieldPath('ajustes', k, j), fs.deleteField());
        } else args.push(new fs.FieldPath('ajustes', k), n);
      }
      if (!args.length) return Promise.resolve();
      const p = pedido(() => fs.updateDoc(H.hogar, args[0], args[1], ...args.slice(2)));
      ajustes = Object.assign({}, antes, nuevo); emitir('ajustes');
      return enviar(p);
    },
    onSnapshot: (next, err) => escuchar('ajustes', next, err),
  };
  // La base, con la forma que usa la app: colecciones `productos` y `tickets` y el documento `ajustes/hogar`.
  function coleccion(col) {
    const c = {
      doc: id => (col === 'productos' ? producto(id || idNuevo()) : ticket(id || idNuevo())),
      orderBy: () => c, limit: () => c,       // el orden y el tope ya vienen resueltos
      onSnapshot: (next, err) => escuchar(col, next, err),
    };
    return c;
  }
  const db = {
    collection: coleccion,
    doc(ruta) { const p = ruta.split('/'); return p[0] === 'ajustes' ? delHogar : coleccion(p[0]).doc(p[1]); },
  };

  /* ---------- la cuenta, el hogar y sus integrantes ---------- */
  const refUsuario = uid => F.fs.doc(F.db, 'usuarios', uid);
  const refMiembro = (hogarId, uid) => F.fs.doc(F.db, 'hogares', hogarId, 'miembros', uid);
  function listo(id) {
    abrir(id);
    try { localStorage.setItem(CLAVE_HOGAR, id); localStorage.setItem(CLAVE_DE, H.uid); } catch (e) { /* se busca de nuevo la próxima vez */ }
    puerta = 'listo';
    if (entrar) { entrar({ db, permiso: Promise.resolve(true) }); entrar = null; }
  }
  function nombreSugerido() { const u = F && F.auth.currentUser; return (u && primerNombre(u.displayName)) || 'Yo'; }
  const nombreDe = n => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40) || nombreSugerido();
  const normalizar = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const AVISOS = {
    quitado: 'Ya no formás parte de ese hogar: otro integrante te quitó.',
    salio: 'Saliste del hogar. Sus datos siguen para los demás integrantes.',
    borrado: 'Saliste del hogar y sus datos se borraron del servidor.',
    sesion: 'Se cerró la sesión en este teléfono (pasa si se borran los datos del navegador). Entrá de nuevo con tu cuenta de Google y volvés a tu hogar.',
    cerrada: 'Cerraste la sesión. Cuando vuelvas a entrar con tu cuenta, tu hogar va a estar como lo dejaste.',
    cuenta: 'Tu cuenta y tus datos se borraron.',
    'ya-tenia': 'Tu cuenta ya estaba en un hogar: entraste a ese.',
  };
  const dejarAviso = m => { try { sessionStorage.setItem(CLAVE_AVISO, m); } catch (e) { /* sin almacenamiento */ } };
  // Dentro de una transacción: el hogar donde la cuenta ya es integrante, o ''.
  async function hogarActual(tx, uid) {
    const s = await tx.get(refUsuario(uid)), id = s.exists() ? String((s.data() || {}).hogar || '') : '';
    if (!idValido(id)) return '';
    return (await tx.get(refMiembro(id, uid))).exists() ? id : '';
  }
  /* Esta persona sale del hogar. Si es la última, con ella se borran del servidor los datos del hogar (nadie
     más podría entrar a verlos): eso solo se hace si quien llama ya lo confirmó, con `borrar`. */
  async function dejarHogar(borrar) {
    const { fs, db: base } = F, de = sub => fs.getDocsFromServer(fs.collection(base, 'hogares', H.id, sub));
    const ultimo = !(await conTope(de('miembros'), 20000)).docs.some(d => d.id !== H.uid);
    if (ultimo && !borrar) throw { code: 'ultimo' };
    const refs = [];
    if (ultimo) for (const sub of ['productos', 'meses', 'notas']) for (const d of (await conTope(de(sub), 30000)).docs) refs.push(d.ref);
    for (let i = 0; i < refs.length; i += TANDA) await enLinea(async tx => { for (const r of refs.slice(i, i + TANDA)) tx.delete(r); });
    // los avisos pendientes del hogar (todos, si se borra; los propios, si solo sale) y las notificaciones de este teléfono
    try {
      const ev = await conTope(fs.getDocs(fs.query(fs.collection(base, 'eventos'), fs.where('h', '==', H.id))), 20000);
      await Promise.all(ev.docs.filter(d => ultimo || (d.data() || {}).de === H.uid).map(d => fs.deleteDoc(d.ref).catch(() => {})));
    } catch (e) { /* los borra la tarea de los avisos en unos minutos */ }
    try { await avisos.desactivar(); } catch (e) { /* ya no estaban */ }
    despedida = ultimo ? 'borrado' : 'salio';      // desde acá, que el servidor avise la baja ya no es novedad
    await enLinea(async tx => { if (ultimo) tx.delete(H.hogar); tx.delete(refMiembro(H.id, H.uid)); tx.set(refUsuario(H.uid), { hogar: '' }, { merge: true }); });
    return despedida;
  }
  const hogar = {
    estado: () => puerta,                    // 'config' | 'red' | 'sin-usuario' | 'sin-hogar' | 'listo'
    // Con qué cuenta se entró: { uid, nombre, email }, o null.
    yo() { const u = F && F.auth.currentUser; return u ? { uid: u.uid, nombre: primerNombre(u.displayName), email: String(u.email || '') } : null; },
    nombreSugerido,
    // Lo que haya que contarle una sola vez a quien vuelve a la entrada.
    aviso() {
      let m = '';
      try { m = sessionStorage.getItem(CLAVE_AVISO) || ''; sessionStorage.removeItem(CLAVE_AVISO); } catch (e) { /* sin almacenamiento */ }
      return AVISOS[m] || '';
    },
    /* Entrar con la cuenta de Google. Hay que llamarla directamente desde el toque de la persona, sin esperar
       nada antes: abre la ventana de Google, y los navegadores solo la dejan abrir en respuesta a un toque.
       Devuelve true si la cuenta ya tenía un hogar y se abrió. */
    async entrarConGoogle() {
      try {
        if (!F) throw { code: 'sin-red' };
        await F.au.signInWithPopup(F.auth, proveedor());
        puerta = 'sin-hogar';
      } catch (e) { throw conPista(e); }
      return hogar.recuperar();
    },
    // Busca el hogar de la cuenta (para volver a él desde otro teléfono). true si lo encontró y lo abrió.
    async recuperar() {
      try {
        const u = sesion(), id = await enLinea(tx => hogarActual(tx, u.uid));
        if (!id) return false;
        listo(id);
        return true;
      } catch (e) { throw conPista(e); }
    },
    async crear(nombre) {
      try {
        const u = sesion(), { fs, db: base } = F, ref = fs.doc(fs.collection(base, 'hogares')), n = nombreDe(nombre);
        let ya = '';
        try {
          await enLinea(async tx => {
            ya = await hogarActual(tx, u.uid);
            if (ya) throw { code: 'ya-tiene' };       // la cuenta ya está en un hogar: no se le crea otro
            tx.set(ref, { creador: u.uid, creado: fs.serverTimestamp(), ajustes: { frecuencia: 7, presupuesto: 0 } });
            tx.set(refMiembro(ref.id, u.uid), { nombre: n, desde: fs.serverTimestamp() });
            tx.set(refUsuario(u.uid), { nombre: n, hogar: ref.id });
          });
        } catch (e) {
          if (!(e && e.code === 'ya-tiene' && ya)) throw e;
          dejarAviso('ya-tenia'); listo(ya);
          return;
        }
        listo(ref.id);
      } catch (e) { throw conPista(e); }
    },
    // Con un código: se lee la invitación, se anota esta persona en su hogar y se gasta el código, todo junto.
    async unirse(codigo, nombre) {
      try {
        const c = normalizar(codigo);
        if (c.length !== 8) throw { code: 'codigo' };
        const u = sesion(), { fs, db: base } = F, refInv = fs.doc(base, 'invitaciones', c), n = nombreDe(nombre);
        let id = '', vencida = false, ya = '';
        try {
          await enLinea(async tx => {
            ya = await hogarActual(tx, u.uid);
            if (ya) throw { code: 'ya-tiene' };
            const inv = await tx.get(refInv);
            if (!inv.exists()) throw { code: 'codigo' };
            const x = inv.data() || {};
            id = String(x.hogar || '');
            vencida = !x.creada || typeof x.creada.toMillis !== 'function' || Date.now() > x.creada.toMillis() + VALE_MIN * 60000;
            tx.set(refMiembro(id, u.uid), { nombre: n, desde: fs.serverTimestamp(), codigo: c });
            tx.delete(refInv);
            tx.set(refUsuario(u.uid), { nombre: n, hogar: id });
          });
        } catch (e) {
          const k = e && e.code;
          if (k === 'ya-tiene' && ya) { dejarAviso('ya-tenia'); listo(ya); return; }
          if (id && k === 'permission-denied') throw { code: vencida ? 'codigo' : 'codigo-negado' };       // la invitación estaba, pero las reglas no la aceptaron
          if (id && (k === 'aborted' || k === 'failed-precondition' || k === 'not-found')) throw { code: 'codigo' };   // otro la usó en ese mismo momento
          throw e;
        }
        listo(id);
        if (cfgAvisos.vapid) F.fs.getDoc(F.fs.doc(F.db, 'hogares', id)).then(d => { const a = (d.data() || {}).ajustes; if (a && a.avisos === true) evento('miembro', `${n} se sumó al hogar`, id, true); }).catch(() => {});
      } catch (e) { throw conPista(e); }
    },
    // Un código para sumar a otra persona. Vale unos minutos y sirve una sola vez.
    async invitar() {
      try {
        const { fs, db: base } = F;
        for (let intento = 0; ; intento++) {
          const azar = crypto.getRandomValues(new Uint8Array(8));
          const codigo = Array.from(azar, b => LETRAS[b % 32]).join('');
          try {
            await enLinea(async tx => { tx.set(fs.doc(base, 'invitaciones', codigo), { hogar: H.id, por: H.uid, creada: fs.serverTimestamp() }); });
            return { codigo, url: hogar.enlace(codigo), vence: Date.now() + VALE_MIN * 60000, minutos: VALE_MIN };
          } catch (e) { if (intento >= 2 || !e || e.code !== 'permission-denied') throw e; }   // código repetido: se prueba con otro
        }
      } catch (e) {
        if (e && e.code === 'permission-denied') negado();
        throw conPista(e);
      }
    },
    enlace: codigo => location.origin + location.pathname + '#unir=' + codigo,
    integrantes: () => integrantes.slice(),
    // Cómo se llama esta persona en el hogar.
    async renombrar(nombre) {
      const n = nombreDe(nombre);
      try { await enLinea(async tx => { tx.update(refMiembro(H.id, H.uid), { nombre: n }); tx.set(refUsuario(H.uid), { nombre: n, hogar: H.id }); }); }
      catch (e) { if (e && e.code === 'permission-denied') negado(); throw conPista(e); }
    },
    async quitar(uid) {
      try { await enLinea(async tx => { tx.delete(refMiembro(H.id, uid)); }); }
      catch (e) { if (e && e.code === 'permission-denied') negado(); throw conPista(e); }
    },
    async salir(borrar) {
      let motivo;
      try { motivo = await dejarHogar(borrar); } catch (e) { despedida = ''; throw conPista(e); }
      afuera(motivo);
    },
    // Cierra la sesión en este teléfono. El hogar y sus datos quedan como están.
    cerrarSesion() {
      if (!F) return Promise.resolve();
      despedida = 'cerrada';
      if (H) return afuera('cerrada', true);
      dejarAviso('cerrada');
      return Promise.race([F.au.signOut(F.auth), pausa(3000)]).catch(() => {}).then(() => location.reload());
    },
    /* Borra la cuenta: sale del hogar (y lo borra, si era la última persona y `borrar`), borra lo anotado de
       la cuenta y la cuenta misma. Google pide entrar de nuevo justo antes: por eso también hay que llamarla
       directamente desde el toque. */
    async borrarCuenta(borrar) {
      let salio = '';
      try {
        const u = sesion();
        await F.au.reauthenticateWithPopup(u, proveedor());
        reteniendo = true;
        if (H) salio = await dejarHogar(borrar);
        await enLinea(async tx => { tx.delete(refUsuario(u.uid)); });
        await conTope(F.au.deleteUser(u), 20000);
      } catch (e) {
        reteniendo = false;
        if (salio) afuera(salio); else despedida = '';
        throw conPista(e);
      }
      despedida = 'cuenta';
      if (H) { afuera('cuenta'); return; }
      dejarAviso('cuenta');
      location.reload();
    },
    // Cómo viene la sincronización: si hay conexión con el servidor y si quedan cambios por subir.
    sinc() {
      const m = [meta.productos, meta.tickets, meta.ajustes];
      return { enLinea: navigator.onLine !== false && !m.some(x => x.listo && x.cache), pendiente: enVuelo > 0 || m.some(x => x.pend) };
    },
    alCambiar(fn) { cambios.add(fn); return () => cambios.delete(fn); },
    alRechazar(fn) { alRechazar = fn; },
    // Datos de la libreta anterior guardados en este teléfono: cuántos hay (o null), traerlos al hogar, o descartarlos.
    anterior() {
      const a = anterior();
      if (!a) { olvidarAnterior(); return null; }      // si solo quedaban los de ejemplo, se van sin preguntar
      return { productos: Object.keys(a.productos).length, tickets: Object.keys(a.tickets).length };
    },
    async traerAnterior() {
      const a = anterior();
      if (a) await copia.importar(a, true);      // con sus fotos, que ya están en este teléfono
      olvidarAnterior();
    },
    descartarAnterior() { olvidarAnterior(); },
    /* Prueba, paso a paso, que Firebase esté bien configurado. Devuelve [{ nombre, ok, detalle, crudo }];
       `crudo` es lo que contestó Firebase tal cual, para poder consultarlo. */
    async diagnostico() {
      const pasos = [];
      const paso = async (nombre, fn) => {
        try { pasos.push({ nombre, ok: true, detalle: (await fn()) || '', crudo: '' }); return true; }
        catch (e) {
          const crudo = e && e.code ? `${e.code}${e.message ? ': ' + String(e.message).replace(/\s+/g, ' ').slice(0, 220) : ''}` : '';
          pasos.push({ nombre, ok: false, detalle: pista(e), crudo });
          return false;
        }
      };
      if (!await paso('Datos de config.js', async () => { if (!configurado()) throw { code: 'config' }; return 'proyecto ' + cfg.projectId; })) return pasos;
      if (!await paso('Biblioteca de Firebase', async () => { await conTope(cargar(), 20000); return 'versión ' + VERSION_SDK; })) return pasos;
      const { fs, db: base } = F, leer = ref => enLinea(tx => tx.get(ref)), u = F.auth.currentUser;
      if (!u) {
        // sin cuenta, lo único que se puede comprobar es que el servidor contesta y que las reglas cierran el paso
        await paso('Base de datos y reglas', async () => {
          try { await leer(fs.doc(base, 'invitaciones', 'PRUEBA00')); }
          catch (e) { if (e && e.code === 'permission-denied' && !(/\bAPI\b|disabled/i.test(String(e.message)) && !/insufficient/i.test(String(e.message)))) return 'responden'; throw e; }
          throw { code: 'reglas-abiertas' };
        });
        pasos.push({ nombre: 'Tu cuenta de Google', ok: true, detalle: 'todavía no entraste: el resto se prueba después de entrar', crudo: '' });
        return pasos;
      }
      await paso('Tu cuenta de Google', async () => String(u.email || 'abierta'));
      if (!await paso('Base de datos y reglas', async () => { await leer(fs.doc(base, 'invitaciones', 'PRUEBA00')); return 'responden'; })) return pasos;
      await paso('Los hogares ajenos están cerrados', async () => {
        try { await leer(fs.doc(base, 'hogares', 'prueba-de-acceso')); }
        catch (e) { if (e && e.code === 'permission-denied') return 'sí'; throw e; }
        throw { code: 'reglas-abiertas' };
      });
      if (H) {
        const bien = await paso('Lectura y escritura en este hogar', async () => {
          await enLinea(async tx => {
            const s = await tx.get(H.hogar);
            if (!s.exists()) throw { code: 'sin-hogar' };
            tx.update(refMiembro(H.id, H.uid), { visto: fs.serverTimestamp() });
          }, 5);
          return 'funcionan';
        });
        if (!bien) negado();
      }
      // lo anterior va por pedidos sueltos; el día a día de la app usa una conexión que queda abierta
      await paso('Conexión en directo', async () => {
        try { await conTope(fs.getDocFromServer(fs.doc(base, 'invitaciones', 'PRUEBA00')), 12000); }
        catch (e) { throw e && e.code === 'permission-denied' ? e : { code: 'sin-directo', message: e && e.message }; }
        return 'abierta';
      });
      return pasos;
    },
  };

  /* ---------- notas entre integrantes ----------
     Cada nota dice hasta cuándo vale; pasada esa hora deja de mostrarse y se borra sola. */
  const TOPE_NOTAS = 40, LARGO_NOTA = 280;
  const refNota = id => F.fs.doc(F.db, 'hogares', H.id, 'notas', id);
  /* ---------- notificaciones ----------
     Cada teléfono que las activa guarda una «suscripción» (suscripciones/{uid}_{n}): su token de Firebase Cloud
     Messaging, qué avisos quiere, en qué zonas está y lo que paga por lo de su alacena. Lo que pasa en el hogar se anota
     en eventos/{id}. Una tarea de GitHub (herramientas/avisos.js) mira cada ~10 minutos lo nuevo y manda los avisos. */
  let cfgAvisos = {};
  try { if (typeof notificaciones === 'object' && notificaciones) cfgAvisos = notificaciones; } catch (e) { /* config.js sin notificaciones */ }
  const CLAVE_PUSH = 'libreta.push';
  const TIPOS_AVISO = ['lista', 'voy', 'nota', 'gasto', 'miembro', 'baratos', 'avisos', 'promos', 'resumen'];
  const hash = s => { let a = 2166136261, b = 5381; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = (Math.imul(b, 33) ^ c) | 0; } return (a >>> 0).toString(36) + (b >>> 0).toString(36); };
  /* Solo si en el hogar alguien activó las notificaciones (ajustes.avisos): si no, no hay a quién avisarle y no se
     guarda nada. `ya`: quien llama ya lo comprobó (al sumarse a un hogar todavía no se leyeron sus ajustes). */
  function evento(tipo, texto, hogar, ya) {
    try {
      const h = hogar || (H && H.id), u = F && F.auth.currentUser;
      if (!h || !u || !TIPOS_AVISO.includes(tipo) || !cfgAvisos.vapid) return;
      if (!ya && !(ajustes && ajustes.avisos === true)) return;
      F.fs.setDoc(F.fs.doc(F.db, 'eventos', idNuevo()), { h, de: u.uid, tipo, texto: String(texto || '').replace(/\s+/g, ' ').trim().slice(0, 140), t: F.fs.serverTimestamp() }).catch(() => {});
    } catch (e) { /* sin avisos esta vez */ }
  }
  const avisos = {
    configurado: () => !!cfgAvisos.vapid,
    soportado: () => typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator && 'PushManager' in window,
    permiso: () => { try { return Notification.permission; } catch (e) { return 'denied'; } },
    // lo que guardó este teléfono: { id, token, prefs } o null
    estado() { try { const x = JSON.parse(localStorage.getItem(CLAVE_PUSH) || 'null'); return x && x.id && x.token ? x : null; } catch (e) { return null; } },
    TIPOS: TIPOS_AVISO,
    async activar(prefs) {
      if (!avisos.configurado() || !avisos.soportado()) throw { code: 'avisos/no', texto: 'Este navegador no permite notificaciones.' };
      const per = await Notification.requestPermission();
      if (per !== 'granted') throw { code: 'avisos/negado', texto: per === 'denied' ? 'Las notificaciones están bloqueadas para esta página. Se habilitan en los permisos del navegador (el candadito junto a la dirección).' : 'No se dio el permiso para las notificaciones.' };
      await cargar();
      const m = await import(SDK + 'firebase-messaging.js');
      if (m.isSupported && !(await m.isSupported())) throw { code: 'avisos/no', texto: 'Este navegador no permite notificaciones.' };
      const reg = await navigator.serviceWorker.ready;
      const token = await m.getToken(m.getMessaging(F.app), { vapidKey: cfgAvisos.vapid, serviceWorkerRegistration: reg });
      if (!token) throw { code: 'avisos/token', texto: 'No se pudo activar. Probá de nuevo.' };
      const u = sesion(), id = `${u.uid}_${hash(token)}`, ant = avisos.estado();
      const p = Object.assign({}, (ant && ant.prefs) || {}, prefs || {});
      for (const t of TIPOS_AVISO) if (typeof p[t] !== 'boolean') p[t] = true;
      await conTope(F.fs.setDoc(F.fs.doc(F.db, 'suscripciones', id), { uid: u.uid, hogar: H ? H.id : '', token, prefs: p, zonas: (ant && ant.zonas) || [], claves: {}, propios: [], alertas: {}, t: F.fs.serverTimestamp() }), 15000);
      if (ant && ant.id !== id) F.fs.deleteDoc(F.fs.doc(F.db, 'suscripciones', ant.id)).catch(() => {});
      try { localStorage.setItem(CLAVE_PUSH, JSON.stringify({ id, token, prefs: p })); } catch (e) { /* sin almacenamiento */ }
      return { id, prefs: p };
    },
    async preferencias(prefs) {
      const x = avisos.estado();
      if (!x) return;
      x.prefs = Object.assign({}, x.prefs, prefs);
      try { localStorage.setItem(CLAVE_PUSH, JSON.stringify(x)); } catch (e) { /* sin almacenamiento */ }
      await enviar(pedido(() => F.fs.updateDoc(F.fs.doc(F.db, 'suscripciones', x.id), { prefs: x.prefs, t: F.fs.serverTimestamp() })));
    },
    // dónde está este teléfono (las zonas, no el punto) y cuánto paga por lo de su alacena: para avisar lo más barato
    async zona(zonas, claves, propios, alertas) {
      const x = avisos.estado();
      if (!x || !F) return;
      const d = { zonas: (zonas || []).slice(0, 30), claves: Object.fromEntries(Object.entries(claves || {}).slice(0, 150)), propios: (propios || []).slice(-30),
        alertas: Object.fromEntries(Object.entries(alertas || {}).slice(0, 100)), hogar: H ? H.id : '', t: F.fs.serverTimestamp() };
      try { await F.fs.updateDoc(F.fs.doc(F.db, 'suscripciones', x.id), d); } catch (e) { /* la próxima vez */ }
    },
    async desactivar() {
      const x = avisos.estado();
      try { localStorage.removeItem(CLAVE_PUSH); } catch (e) { /* sin almacenamiento */ }
      if (!x) return;
      try { await conTope(F.fs.deleteDoc(F.fs.doc(F.db, 'suscripciones', x.id)), 15000); } catch (e) { /* ya no estaba */ }
      try { const m = await import(SDK + 'firebase-messaging.js'); await m.deleteToken(m.getMessaging(F.app)); } catch (e) { /* ya no tenía */ }
    },
  };

  const notasDelHogar = {
    largo: LARGO_NOTA,
    lista() { const ahora = Date.now(); return notas.filter(n => n.hasta > ahora); },
    agregar(texto, dias, tipoAviso) {
      const t = String(texto == null ? '' : texto).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, LARGO_NOTA);
      if (!t) return Promise.reject({ code: 'nube/nota-vacia', texto: 'Escribí algo en la nota.' });
      if (notasDelHogar.lista().length >= TOPE_NOTAS) return Promise.reject({ code: 'nube/notas-llenas', texto: 'Hay demasiadas notas. Borrá alguna que ya no haga falta.' });
      const d = Math.max(1, Math.min(60, Math.round(+dias) || 3)), ahora = Date.now(), yo = integrantes.find(x => x.yo);
      const dato = { texto: t, de: H.uid, nombre: yo ? yo.nombre : nombreSugerido(), creada: ahora, hasta: ahora + d * 864e5 };
      const p = enviar(pedido(() => F.fs.setDoc(refNota(idNuevo()), dato)));
      p.then(() => evento(tipoAviso === 'voy' ? 'voy' : 'nota', tipoAviso === 'voy' ? `${dato.nombre} va a hacer las compras. ¿Falta algo? Anotalo en la lista.` : `${dato.nombre}: ${t.replace(/\s+/g, ' ').slice(0, 110)}`), () => {});
      return p;
    },
    borrar(id) { return enviar(pedido(() => F.fs.deleteDoc(refNota(id)))); },
  };

  /* ---------- precios compartidos con la zona ----------
     Lo que un hogar aporta no dice de quién es: el código de barras, el precio, el día, el comercio (su
     identificador de Google Maps y dónde queda) y la zona. Si algo de esto falla, la libreta sigue igual:
     son un extra, no datos del hogar. */
  const precios = {
    // Todos los de esas zonas (hasta `tope` por tanda de 30 zonas), para el buscador.
    async deZonas(zonas, tope) {
      const { fs, db: base } = F, out = [];
      for (let i = 0; i < zonas.length; i += 30) {
        const s = await conTope(fs.getDocs(fs.query(fs.collection(base, 'precios'), fs.where('z', 'in', zonas.slice(i, i + 30)), fs.limit(tope || 600))), 20000);
        for (const d of s.docs) out.push(Object.assign({ id: d.id }, d.data()));
      }
      return out;
    },
    /* En vivo: todos los de esas zonas, cada vez que cambian (el mapa de la zona). `alCambiar(docs)` recibe la lista
       entera de cada tanda de 30 zonas juntas. Devuelve la función para dejar de escuchar. */
    escuchar(zonas, alCambiar, alFallar) {
      const { fs, db: base } = F, partes = [], bajas = [];
      for (let i = 0; i < zonas.length; i += 30) {
        const j = partes.length;
        partes.push([]);
        bajas.push(fs.onSnapshot(fs.query(fs.collection(base, 'precios'), fs.where('z', 'in', zonas.slice(i, i + 30)), fs.limit(500)), s => {
          partes[j] = s.docs.map(d => Object.assign({ id: d.id }, d.data()));
          alCambiar([].concat(...partes));
        }, e => { if (alFallar) alFallar(e); }));
      }
      return () => { for (const b of bajas) { try { b(); } catch (e) { /* ya estaba cerrado */ } } };
    },
    // claves: ['zona_código', …]. Devuelve [{ id, z, e, k, p, d, c, la, lo, v, x }].
    async buscar(claves) {
      const { fs, db: base } = F, out = [];
      for (let i = 0; i < claves.length; i += 30) {      // una consulta admite hasta 30 valores
        const s = await conTope(fs.getDocs(fs.query(fs.collection(base, 'precios'), fs.where('ze', 'in', claves.slice(i, i + 30)))), 20000);
        for (const d of s.docs) out.push(Object.assign({ id: d.id }, d.data()));
      }
      return out;
    },
    /* r: { z, e, k, p, d, c, la, lo, v, n, h, qs, qn, t, g }. `e` es el código de barras o, sin código, «n-» y el nombre (`t`). Va en cola, como todo: si no hay conexión, sale cuando vuelve.
       Contesta si quedó anotado: false si el servidor lo rechazó; true si lo aceptó o si todavía está en cola.
       `x` es el momento desde el que Firestore lo puede borrar solo (dos días después de vencido). */
    aportar(r) {
      const dato = { z: String(r.z), e: String(r.e), ze: `${r.z}_${r.e}`, k: String(r.k), p: +r.p, d: Math.round(r.d), c: Math.round(r.c) || 1, la: +r.la, lo: +r.lo, v: Math.round(r.v),
        n: String(r.n || 'Comercio').slice(0, 60), h: String(r.h || '').slice(0, 40), qs: Math.max(0, Math.round(+r.qs || 0)), qn: Math.max(0, Math.round(+r.qn || 0)) };
      // qué producto es, en palabras (para buscarlo; sin código de barras, es lo único que lo nombra) y su categoría
      const t = String(r.t || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      if (t.length >= 2) dato.t = t;
      if (/^[a-z]{3,12}$/.test(r.g || '')) dato.g = r.g;
      let envio;
      // `ts`: cuándo se anotó (lo pone el servidor), para que la tarea de los avisos sepa qué es nuevo
      // `sinNovedad`: es la confirmación de un precio que ya estaba (no se avisa como nuevo ni es «propio»)
      try { dato.x = F.fs.Timestamp.fromMillis((dato.v + 2) * 864e5); if (!r.sinNovedad) dato.ts = F.fs.serverTimestamp(); envio = F.fs.setDoc(F.fs.doc(F.db, 'precios', `${dato.ze}_${dato.k}`), dato); }
      catch (e) { return Promise.resolve(false); }
      if (!r.sinNovedad) try { const l = JSON.parse(localStorage.getItem('libreta.propios') || '[]').filter(x => x !== `${dato.ze}_${dato.k}`).concat(`${dato.ze}_${dato.k}`).slice(-30); localStorage.setItem('libreta.propios', JSON.stringify(l)); } catch (e) { /* sin almacenamiento */ }
      return Promise.race([envio.then(() => true, () => false), pausa(2500).then(() => true)]);
    },
    // Los que vencieron antes de ese día, sean de la zona que sean (hasta `tope`): [{ id, v }].
    async vencidos(dia, tope) {
      const { fs, db: base } = F;
      const s = await conTope(fs.getDocs(fs.query(fs.collection(base, 'precios'), fs.where('v', '<', dia), fs.limit(tope || 40))), 20000);
      return s.docs.map(d => ({ id: d.id, v: d.data().v }));
    },
    // Uno vencido: se borra para que no quede guardado más tiempo del debido.
    borrar(id) { try { F.fs.deleteDoc(F.fs.doc(F.db, 'precios', String(id))).catch(() => {}); } catch (e) { /* lo borrará otro */ } },
  };

  /* ---------- comercios que marcan los hogares ----------
     Los que no figuran en OpenStreetMap: el nombre, dónde queda y el rubro. Quedan para toda la zona y no se
     cambian ni se borran desde la app (no dicen qué hogar los marcó). */
  const comercios = {
    // zonas: ['553x1216', …]. Devuelve [{ id, z, n, la, lo, r }].
    async buscar(zonas) {
      const { fs, db: base } = F, out = [];
      for (let i = 0; i < zonas.length; i += 30) {
        const s = await conTope(fs.getDocs(fs.query(fs.collection(base, 'comercios'), fs.where('z', 'in', zonas.slice(i, i + 30)))), 20000);
        for (const d of s.docs) out.push(Object.assign({ id: d.id }, d.data()));
      }
      return out;
    },
    async leer(id) {
      const s = await conTope(F.fs.getDoc(F.fs.doc(F.db, 'comercios', String(id))), 20000);
      return s.exists() ? s.data() : null;
    },
    // c: { z, n, la, lo, r }. Devuelve el identificador nuevo (si no hay conexión, sale cuando vuelve).
    async crear(c) {
      const id = idNuevo(), dato = { z: String(c.z), n: String(c.n).slice(0, 60), la: +c.la, lo: +c.lo, r: String(c.r || '').slice(0, 30), t: F.fs.serverTimestamp() };
      const envio = F.fs.setDoc(F.fs.doc(F.db, 'comercios', id), dato);
      const ok = await Promise.race([envio.then(() => true, () => false), pausa(2500).then(() => true)]);
      if (!ok) throw { code: 'permission-denied', texto: 'El servidor no aceptó el comercio: falta publicar las reglas nuevas (el archivo firestore.rules).' };
      return id;
    },
  };

  /* ---------- promociones de la zona ----------
     { z, k, n, t, m, pct, dias, hasta, x, d, la, lo, h }: cuadro, comercio (cuál y su nombre), texto, medio de pago,
     porcentaje, días de la semana (0 domingo … 6 sábado; vacío: todos), último día que vale, cuándo se puede borrar,
     día en que se cargó, dónde queda el comercio y el nombre público del hogar. */
  const promos = {
    async buscar(zonas) {
      const { fs, db: base } = F, out = [];
      for (let i = 0; i < zonas.length; i += 30) {
        const s = await conTope(fs.getDocs(fs.query(fs.collection(base, 'promos'), fs.where('z', 'in', zonas.slice(i, i + 30)))), 20000);
        for (const d of s.docs) out.push(Object.assign({ id: d.id }, d.data()));
      }
      return out;
    },
    async crear(r) {
      const id = idNuevo();
      const dato = { z: String(r.z), k: String(r.k), n: String(r.n).slice(0, 60), t: String(r.t).slice(0, 120), m: String(r.m || '').slice(0, 40), pct: Math.round(+r.pct) || 0,
        dias: (r.dias || []).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6), hasta: Math.round(r.hasta), d: Math.round(r.d), la: +r.la, lo: +r.lo, h: String(r.h || '').slice(0, 40) };
      dato.x = F.fs.Timestamp.fromMillis((dato.hasta + 2) * 864e5);
      dato.ts = F.fs.serverTimestamp();
      const envio = F.fs.setDoc(F.fs.doc(F.db, 'promos', id), dato);
      const ok = await Promise.race([envio.then(() => true, () => false), pausa(2500).then(() => true)]);
      if (!ok) throw { code: 'permission-denied', texto: 'El servidor no aceptó la promo: falta publicar las reglas nuevas (el archivo firestore.rules).' };
      return id;
    },
    borrar(id) { try { F.fs.deleteDoc(F.fs.doc(F.db, 'promos', String(id))).catch(() => {}); } catch (e) { /* la borrará otro */ } },
  };

  /* ---------- copia de seguridad ---------- */
  const copia = {
    // Con el mismo formato que la libreta que guarda en el navegador, así una copia sirve en las dos.
    exportar() {
      const productos = {}, tickets = {};
      for (const [id, p] of prods) productos[id] = p;
      for (const t of meses.values()) for (const id in t) tickets[id] = t[id];
      return { libreta: 1, fecha: new Date().toISOString(), productos, tickets, ajustes: ajustes ? { hogar: ajustes } : {} };
    },
    revisar(o) {
      if (!esMapa(o) || o.libreta !== 1 || !esMapa(o.productos) || !esMapa(o.tickets)) return null;
      return { productos: Object.keys(o.productos).length, tickets: Object.keys(o.tickets).length, suma: true };
    },
    // Suma lo de la copia a lo que ya hay en el hogar (lo que tenga el mismo identificador se reemplaza).
    async importar(o, conFotos) {
      if (!copia.revisar(o)) throw new Error('no es una copia de la libreta');
      const es = esMapa, pasos = [];
      let fotos = new Set();
      if (conFotos && Fotos.disponible()) { try { fotos = new Set(await Fotos.claves()); } catch (e) { /* sin fotos */ } }
      for (const id in o.productos) {
        const p = o.productos[id];
        if (!es(p)) continue;
        const d = aNube(Object.assign({}, p, { nombre: String(p.nombre || 'Sin nombre'), stock: Math.max(0, Math.round(+p.stock || 0)), log: Array.isArray(p.log) ? p.log : [], px: N.precios(p) }));
        delete d.ejemplo;
        const ref = refProd(idValido(id) ? id : idNuevo());
        pasos.push(tx => tx.set(ref, d));
      }
      const porMes = new Map();
      for (const id in o.tickets) {
        const t = o.tickets[id];
        if (!es(t)) continue;
        const d = limpio(Object.assign({}, t, { items: Array.isArray(t.items) ? t.items.filter(es) : [] }));
        delete d.ejemplo;
        if (!(d.foto === true && idValido(id) && fotos.has(id))) delete d.foto;      // las fotos no viajan en la copia: solo vale la que ya está acá
        const mes = mesDe(d), tid = idValido(id) ? id : idNuevo(), estaba = deMes.get(tid);
        if (estaba && estaba !== mes) {      // ese gasto ya está en el hogar, en otro mes: se saca de ahí para que no quede dos veces
          const viejo = refMes(estaba), campo = new F.fs.FieldPath('t', tid);
          pasos.push(tx => tx.update(viejo, campo, F.fs.deleteField()));
        }
        if (!porMes.has(mes)) porMes.set(mes, {});
        porMes.get(mes)[tid] = d;
      }
      for (const [mes, t] of porMes) { const ref = refMes(mes); pasos.push(tx => tx.set(ref, { t }, { merge: true })); }
      // de los ajustes de la copia vuelven la frecuencia y el presupuesto; los demás (comercios, compartir) no se pisan
      const aj = es(o.ajustes) && es(o.ajustes.hogar) ? o.ajustes.hogar : null;
      if (aj) pasos.push(tx => tx.update(H.hogar, new F.fs.FieldPath('ajustes', 'frecuencia'), [7, 15, 30].includes(aj.frecuencia) ? aj.frecuencia : 7, new F.fs.FieldPath('ajustes', 'presupuesto'), +aj.presupuesto > 0 ? +aj.presupuesto : 0));
      try {
        // de a tandas; cada una entra entera o no entra
        for (let i = 0; i < pasos.length; i += TANDA) await enLinea(async tx => { for (const p of pasos.slice(i, i + TANDA)) p(tx); });
      } catch (e) { throw conPista(e); }
    },
  };

  return {
    local: true,                 // las fotos y la cámara se manejan en el teléfono, igual que sin servidor
    persistente: true,
    camaraEnVivo: true,
    instalable: true,            // se puede instalar como app y abrir sin conexión
    get fotos() { return Fotos.disponible() ? Fotos : null; },
    copia,
    respiro: 0,
    hogar,
    notas: notasDelHogar,
    precios,
    comercios,
    promos,
    mover,
    avisos,
    evento,
    // La app de Firebase ya iniciada y de dónde se baja la biblioteca: para sumarle otros servicios (la IA).
    async firebase() { await cargar(); return { app: F.app, sdk: SDK }; },
    textos: {
      sinConexion: 'No se pudo abrir la conexión con el servidor. Revisá internet y recargá la página.',
      donde: 'Los datos de este hogar se guardan en Firebase, un servicio de Google, y los ven solo sus integrantes. Cada teléfono guarda una copia para seguir andando sin conexión. Las fotos de los tickets quedan en el teléfono donde se cargaron.',
      fallo: 'No se pudo guardar. Revisá la conexión y probá de nuevo.',
      version: 'Libreta del hogar · versión 2.9.0 (2026-10-17)',       // el número y la fecha los pone armar.js
    },
    /* Devuelve { db, permiso } si en este teléfono ya hay una cuenta con su hogar. Si no, { puerta, alEntrar }:
       la app muestra la entrada y `alEntrar` se cumple cuando se entra a un hogar. null: sin conexión. */
    async conectar() {
      const id = guardado(CLAVE_HOGAR);
      const esperar = estado => { puerta = estado; return { puerta: true, alEntrar: new Promise(ok => { entrar = ok; }) }; };
      if (!configurado()) return esperar('config');
      try { await conTope(cargar(), 20000); await F.auth.authStateReady(); }
      catch (e) { return id ? null : esperar('red'); }
      const u = F.auth.currentUser;
      if (id && u && guardado(CLAVE_DE) === u.uid) { abrir(id); puerta = 'listo'; return { db, permiso: Promise.resolve(true) }; }
      if (id) {
        // está anotado un hogar, pero no hay sesión o es de otra cuenta: lo guardado acá no es de quien está ahora
        try { localStorage.removeItem(CLAVE_HOGAR); localStorage.removeItem(CLAVE_DE); if (!u) sessionStorage.setItem(CLAVE_AVISO, 'sesion'); } catch (e) { /* sin almacenamiento */ }
        try { await Promise.race([F.fs.terminate(F.db).then(() => F.fs.clearIndexedDbPersistence(F.db)), pausa(3000)]); } catch (e) { /* se pisa al entrar */ }
        location.reload();
        return new Promise(() => {});      // la página se está recargando
      }
      return esperar(u ? 'sin-hogar' : 'sin-usuario');
    },
  };
})();


/* La inteligencia artificial de la libreta: Gemini, de Google, a través de Firebase (Firebase AI Logic).
   Hace dos cosas:
     · lee la foto de un cartel, folleto o pantalla con una promo y completa la promo para cargarla;
     · propone comidas con lo que hay en la alacena y dice qué falta comprar.
   Qué se le manda: la foto del cartel, o la lista de productos de la alacena (nombre, cuántos hay y su categoría).
   Nunca tickets, nombres de personas, cuentas ni direcciones: con la cuota gratis, Google puede usar lo que
   recibe para mejorar sus productos. Siempre se le muestra a la persona lo que se entendió antes de guardarlo.
   Firebase exige App Check (reCAPTCHA de Google, invisible) para que solo esta app use la cuota.
   Se configura en config.js (`inteligencia`); sin la clave de reCAPTCHA queda apagada. */
const IA = (() => {
  'use strict';
  const N = Nucleo;
  let cfg = {};
  try { if (typeof inteligencia === 'object' && inteligencia) cfg = inteligencia; } catch (e) { /* config.js sin la IA */ }
  /* Los modelos, en orden de preferencia: para leer fotos, el más capaz primero; para las comidas (solo texto), el
     más rápido. Si uno está saturado, sin cuota o tarda, se prueba con el siguiente. */
  const sinRepetir = l => l.filter((m, i) => m && l.indexOf(m) === i);
  const PARA_FOTOS = sinRepetir([cfg.modelo || 'gemini-3.5-flash', cfg.respaldo || 'gemini-3.5-flash-lite', cfg.rapido || 'gemini-3.1-flash-lite']);
  const PARA_TEXTO = sinRepetir([cfg.rapido || 'gemini-3.1-flash-lite', cfg.respaldo || 'gemini-3.5-flash-lite', cfg.modelo || 'gemini-3.5-flash']);
  const configurada = () => cfg.activa !== false && !!cfg.recaptcha;
  let apagada = '';          // por qué no anda en esta visita (la cuota de hoy, App Check), si se supo

  const texto = (v, n) => (typeof v === 'string' ? v : v == null ? '' : String(v)).replace(/\s+/g, ' ').trim().slice(0, n);
  const pausa = ms => new Promise(r => setTimeout(r, ms));
  const conTope = (p, ms) => Promise.race([p, pausa(ms).then(() => { throw { code: 'tarde' }; })]);

  /* ---------- la conexión con Gemini ---------- */
  let motor = null;
  function cargar() {
    if (!motor) {
      motor = (async () => {
        const { app, sdk } = await Datos.firebase();
        const [ai, ac] = await Promise.all([import(sdk + 'firebase-ai.js'), import(sdk + 'firebase-app-check.js')]);
        try { ac.initializeAppCheck(app, { provider: new ac.ReCaptchaEnterpriseProvider(cfg.recaptcha), isTokenAutoRefreshEnabled: false }); }
        catch (e) { if (!/already|ya/i.test(String(e && e.message))) throw e; }
        const backend = ai.getAI(app, { backend: new ai.GoogleAIBackend() });
        const modelo = m => ai.getGenerativeModel(backend, { model: m, generationConfig: { responseMimeType: 'application/json', temperature: 0.4 } });
        return { fotos: PARA_FOTOS.map(modelo), texto: PARA_TEXTO.map(modelo) };
      })();
      motor.catch(() => { motor = null; });
    }
    return motor;
  }
  // Qué clase de falla es, mirando el código y el mensaje (Firebase los trae en inglés y varían entre versiones).
  function clase(e) {
    if (e && ['sin-red', 'tarde', 'imagen', 'vacio', 'cancelado'].includes(e.code)) return e.code;
    const t = [e && e.code, e && e.message, e && e.customErrorData && JSON.stringify(e.customErrorData)].join(' ');
    if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(t)) return 'cuota';
    if (/app.?check|recaptcha|attestation|401|UNAUTHENTICATED/i.test(t)) return 'verificacion';
    if (/404|not.?found|is not supported|unsupported model/i.test(t)) return 'modelo';
    if (/403|PERMISSION_DENIED|API has not been used|disabled|billing/i.test(t)) return 'permiso';
    if (/SAFETY|blocked|PROHIBITED/i.test(t)) return 'bloqueado';
    if (/high demand|overloaded|UNAVAILABLE|\[50[0-9] /i.test(t)) return 'saturado';
    if (/fetch|network|Failed to fetch/i.test(t)) return 'sin-red';
    return 'otro';
  }
  // Saca el JSON de la respuesta, aunque venga envuelto en ```json … ```.
  function leerJSON(t) {
    const s = String(t || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    try { return JSON.parse(s); } catch (e) { /* sigue */ }
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { /* sigue */ } }
    throw { code: 'vacio' };
  }
  async function blob64(b) {
    const buf = new Uint8Array(await b.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
    return btoa(s);
  }
  /* Un pedido: la consigna y, si hay, una foto. Si un modelo está saturado, sin cuota o tarda demasiado, prueba
     con el siguiente. */
  async function pedir(consigna, foto, signal) {
    if (navigator.onLine === false) throw { code: 'sin-red' };
    if (signal && signal.aborted) throw { code: 'cancelado' };
    const todos = await conTope(cargar(), 25000), modelos = foto ? todos.fotos : todos.texto;
    const partes = [{ text: consigna }];
    if (foto) partes.push({ inlineData: { mimeType: foto.type || 'image/jpeg', data: await blob64(foto) } });
    const cancelar = new Promise((_, mal) => { if (signal) signal.addEventListener('abort', () => mal({ code: 'cancelado' })); });
    let ultimo = null;
    for (const m of modelos) {
      try {
        const r = await Promise.race([conTope(m.generateContent(partes), foto ? 40000 : 25000), cancelar]);
        apagada = '';
        return leerJSON(r.response.text());
      } catch (e) {
        ultimo = e;
        const c = clase(e);
        if (!['cuota', 'modelo', 'saturado', 'tarde'].includes(c)) break;
      }
    }
    if (clase(ultimo) === 'cuota') apagada = 'cuota';
    throw ultimo;
  }

  /* ---------- la foto de una promo ---------- */
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  function promptPromo(medios, hoy) {
    const d = new Date(hoy + 'T12:00:00');
    return `Sos el lector de promociones de una libreta de compras que comparten familias de Argentina. La foto muestra un cartel, un folleto, una góndola, una vidriera o la pantalla de una app de banco o billetera con una promoción para comprar más barato.

Respondé SOLO con un objeto JSON, con esta forma:
{"esPromo": true, "comercio": "", "texto": "", "pct": 0, "medio": "", "dias": [], "hasta": "", "dudas": ""}

- esPromo: false si en la foto no hay ninguna promoción de precios.
- comercio: el nombre comercial del súper, almacén o negocio donde vale ("Coto", "Día", "Carrefour", "Changomás"), si se ve. Si es una promo de un banco que vale en varios comercios, "".
- texto: la promo en pocas palabras, como la contaría una persona, de hasta 100 caracteres: qué descuento, en qué productos y el tope o condición más importante. Ejemplos: "25 % en carnes, tope $ 10.000 por semana", "2x1 en yogures La Serenísima", "20 % en todo pagando con QR".
- pct: el porcentaje de descuento, entero. Un 2x1 es 50; un 3x2, 33; «la segunda al 70 %», 35; «la segunda al 50 %», 25. Si no hay un porcentaje claro, 0.
- medio: con qué hay que pagar para tener el descuento. Si es uno de estos, escribilo igual: ${medios.join(', ')}. Si es otro banco, tarjeta o billetera, su nombre corto. Si vale con cualquier medio de pago o no dice, "${medios[0]}".
- dias: los días de la semana en que vale, como números (0 domingo, 1 lunes, 2 martes, 3 miércoles, 4 jueves, 5 viernes, 6 sábado). Si vale todos los días o no dice, [].
- hasta: la última fecha en que vale, como "AAAA-MM-DD", solo si figura. Hoy es ${DIAS[d.getDay()]} ${hoy}. Si dice solo día y mes, es la próxima vez que llega esa fecha. Si no figura, "".
- dudas: "" o una frase corta sobre lo que no se leyó bien.

No inventes nada que no esté en la foto.`;
  }
  function normalizarPromo(r, medios, hoy) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const t = texto(r.texto, 120);
    let pct = Math.round(N.aNumero(r.pct));
    if (!isFinite(pct) || pct < 0 || pct > 80) pct = 0;
    const m = texto(r.medio, 30), igual = medios.find(x => N.norm(x) === N.norm(m));
    const dias = Array.from(new Set((Array.isArray(r.dias) ? r.dias : []).map(Number).filter(d => Number.isInteger(d) && d >= 0 && d <= 6))).sort();
    const hd = N.diaDe(hoy);
    let hasta = N.fechaValida(r.hasta) ? r.hasta : '';
    if (hasta && N.diaDe(hasta) < hd) hasta = '';
    if (hasta && N.diaDe(hasta) > hd + 62) hasta = N.isoDeDia(hd + 62);
    return {
      esPromo: r.esPromo !== false && t.length >= 3, comercio: texto(r.comercio, 60), texto: t, pct,
      medio: igual || m || medios[0], dias: dias.length === 7 ? [] : dias, hasta, dudas: texto(r.dudas, 200),
    };
  }

  /* ---------- qué es un producto sin código ---------- */
  function promptProducto() {
    return `Sos el lector de productos de una libreta de compras que comparten familias de Argentina. La foto muestra algo que se compró o se está por comprar, casi siempre sin envase de marca ni código de barras: comida de rotisería o de panadería, fruta, verdura, carne, fiambre, algo suelto o hecho en el negocio.

Respondé SOLO con un objeto JSON, con esta forma:
{"esProducto": true, "nombre": "", "categoria": "", "vende": "unidad", "partes": [], "precio": 0}

- esProducto: false si en la foto no se ve nada que se compre.
- nombre: qué es, corto y genérico, como lo pediría una persona en el negocio, de hasta 40 caracteres. Sin marca, salvo que se lea en una etiqueta. Ejemplos: "Pizza de muzzarella con morrón", "Pan francés", "Banana", "Milanesa de nalga", "Empanada de carne".
- categoria: una de estas claves: ${N.CATS_ALACENA.join(', ')}.
- vende: "kilo" si se vende por peso y el precio es por kilo (carne, pollo, fiambre, queso, verdura y fruta sueltas); "combo" si es una oferta que junta varias cosas por un solo precio (por ejemplo «3 kg de pata muslo + 2 kg de milanesa»); si no, "unidad".
- partes: solo para un combo, qué trae: [{"n": "Pata muslo", "q": 3, "u": "kg"}, {"n": "Milanesa", "q": 2, "u": "kg"}]. "u" es "kg" o "u" (unidades). Si no es combo, [].
- precio: si en la foto se ve un cartel o una etiqueta con el precio de ese producto (o del combo), el número (con punto decimal, sin símbolo); si no, 0.

No inventes nada que no se vea en la foto.`;
  }
  function normalizarProducto(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    const nombre = N.mayuscula(texto(r.nombre, 60));
    let precio = N.aNumero(r.precio);
    if (!isFinite(precio) || precio <= 0 || precio > 1e8) precio = 0;
    const partes = (Array.isArray(r.partes) ? r.partes : []).slice(0, 8).map(c => ({ n: N.mayuscula(texto(c && c.n, 40)), q: N.aNumero(c && c.q), u: c && /^k/i.test(String(c.u)) ? 'kg' : 'u' }))
      .filter(c => c.n.length >= 2 && c.q > 0 && c.q < 1000);
    const vende = r.vende === 'combo' && partes.length >= 2 ? 'combo' : r.vende === 'kilo' ? 'kilo' : 'unidad';
    return { esProducto: r.esProducto !== false && nombre.length >= 2, nombre, categoria: N.CATS_ALACENA.includes(r.categoria) ? r.categoria : 'otros', vende, partes: vende === 'combo' ? partes : [], precio: N.redondear2(precio) };
  }

  /* ---------- qué cocinar ---------- */
  const COMIDAS = {
    comida: 'un almuerzo o una cena',
    rapido: 'algo rápido, que se haga en menos de 30 minutos',
    dulce: 'algo dulce o para la merienda',
    vianda: 'una vianda para llevar al trabajo o al colegio',
  };
  function promptRecetas(lista, o) {
    const ya = (o.anteriores || []).filter(Boolean);
    return `Sos el ayudante de cocina de una familia de Argentina. Con lo que tienen en la alacena, proponé 3 comidas caseras y realistas, de las que se cocinan en una casa argentina un día común.

Buscan: ${COMIDAS[o.comida] || COMIDAS.comida}, para ${o.personas} ${o.personas === 1 ? 'persona' : 'personas'}.
- Usá sobre todo lo que hay. Primero lo fresco (verduras, frutas, carnes, lácteos, pan), que se echa a perder.
- Se supone que en la casa hay sal, pimienta, aceite, agua y condimentos secos comunes: no los pongas como faltantes.
- Cada comida puede necesitar comprar como mucho 3 cosas; mejor si no hace falta comprar nada.
- Cantidades para ${o.personas} ${o.personas === 1 ? 'persona' : 'personas'}, en medidas de cocina de acá (taza, cucharada, gramos, unidades).${ya.length ? `\n- No repitas estas, que ya vieron: ${ya.join('; ')}.` : ''}

Respondé SOLO con un objeto JSON, con esta forma:
{"recetas": [{"nombre": "", "minutos": 0, "usa": [1, 2], "faltan": [{"n": "", "cat": ""}], "pasos": ["", ""]}]}

- nombre: cómo se llama la comida, corto ("Tarta de acelga y queso", "Arroz con pollo").
- minutos: cuánto tarda en total, aproximado.
- usa: los números de renglón de la alacena que usa.
- faltan: lo que hay que comprar, con un nombre genérico y corto ("Tomate", "Crema de leche"); cat, una de estas claves: ${N.CATS_ALACENA.join(', ')}.
- pasos: de 3 a 8 pasos cortos y claros, con las cantidades.

alacena (número. producto · cuántos hay · categoría):
${lista.map((x, i) => `${i + 1}. ${x.texto} · ${x.cant} · ${x.cat}`).join('\n')}`;
  }
  function normalizarRecetas(r, lista) {
    const crudas = r && Array.isArray(r.recetas) ? r.recetas : Array.isArray(r) ? r : [];
    const out = [];
    for (const x of crudas.slice(0, 4)) {
      if (!x || typeof x !== 'object') continue;
      const nombre = N.mayuscula(texto(x.nombre, 80));
      const pasos = (Array.isArray(x.pasos) ? x.pasos : []).map(p => texto(p, 300)).filter(Boolean).slice(0, 10);
      if (!nombre || pasos.length < 2) continue;
      const usa = Array.from(new Set((Array.isArray(x.usa) ? x.usa : []).map(Number).filter(i => Number.isInteger(i) && i >= 1 && i <= lista.length))).map(i => lista[i - 1].id);
      const vistos = new Set(), faltan = [];
      for (const f of Array.isArray(x.faltan) ? x.faltan.slice(0, 5) : []) {
        const n = N.mayuscula(texto(f && typeof f === 'object' ? f.n || f.nombre : f, 40)), k = N.norm(n);
        if (!n || vistos.has(k) || /^(sal|pimienta|aceite|agua)( y (sal|pimienta|aceite|agua))?$/.test(k)) continue;      // lo que se supone que hay
        vistos.add(k);
        faltan.push({ n, cat: f && N.CATS_ALACENA.includes(f.cat) ? f.cat : 'almacen' });
      }
      let minutos = Math.round(N.aNumero(x.minutos));
      if (!isFinite(minutos) || minutos < 1 || minutos > 600) minutos = 0;
      out.push({ nombre, minutos, usa, faltan, pasos });
    }
    return out.slice(0, 3);
  }

  return {
    // Si la IA está configurada en este sitio. Que ande depende además de la conexión y de la cuota del día.
    disponible: () => configurada() && typeof Datos !== 'undefined' && typeof Datos.firebase === 'function',
    COMIDAS,
    // Lee la foto (un Blob JPEG) de una promo. `medios`: los medios de pago que conoce la app, el primero «todos».
    async promo(foto, medios, hoy, opciones) {
      const r = await pedir(promptPromo(medios, hoy), foto, opciones && opciones.signal);
      return normalizarPromo(r, medios, hoy);
    },
    // Dice qué es el producto de la foto (un Blob JPEG), para los que no tienen código de barras.
    async producto(foto, opciones) {
      const r = await pedir(promptProducto(), foto, opciones && opciones.signal);
      return normalizarProducto(r);
    },
    // Propone comidas. `lista`: lo que hay en la alacena [{ id, texto, cant, cat }], lo fresco primero.
    async recetas(lista, opciones) {
      const o = Object.assign({ comida: 'comida', personas: 4, anteriores: [] }, opciones || {});
      const r = await pedir(promptRecetas(lista, o), null, o.signal);
      return normalizarRecetas(r, lista);
    },
    // Qué decirle a la persona cuando algo falla.
    nota(e) {
      switch (clase(e)) {
        case 'sin-red': return 'No hay conexión con la IA. Revisá internet y probá de nuevo.';
        case 'tarde': return 'La IA tardó demasiado en contestar. Probá de nuevo en un rato.';
        case 'saturado': return 'La IA está muy pedida en este momento. Probá de nuevo en un rato.';
        case 'cuota': return 'La IA gratis llegó a su límite por ahora. Probá en un rato o mañana.';
        case 'verificacion': return 'La IA no pudo verificar que la pedís desde la libreta. Recargá la página y probá de nuevo.';
        case 'permiso': case 'modelo': return 'La IA no está habilitada en este momento. Probá más tarde.';
        case 'bloqueado': return 'La IA no quiso procesar ese pedido. Probá con otra foto.';
        case 'imagen': return 'No se pudo abrir esa imagen. Probá con otra foto.';
        case 'vacio': return 'La IA contestó algo que no se entiende. Probá de nuevo.';
        case 'cancelado': return '';
        default: return 'No se pudo usar la IA. Probá de nuevo en un rato.';
      }
    },
    get apagada() { return apagada; },
    interno: { promptProducto, normalizarProducto, promptPromo, normalizarPromo, promptRecetas, normalizarRecetas, leerJSON, clase },
  };
})();


/* De dónde salen los datos de un producto nuevo cuando la libreta corre como archivos sueltos: se busca
   por su código de barras en Open Food Facts, una base pública y colaborativa de productos
   (https://world.openfoodfacts.org). Lo único que se envía es el número del código. Si no hay conexión o el
   producto no figura, los datos se completan a mano. Leer etiquetas o tickets de una foto no se puede sin
   un servicio que lo haga, así que acá esas dos funciones quedan apagadas. */
const Lector = (() => {
  'use strict';

  // De las categorías de Open Food Facts a las de la libreta: vale la primera fila que coincida.
  const MAPA = [
    ['mascotas', ['en:pet-food', 'en:pet-foods', 'en:dog-food', 'en:dog-foods', 'en:cat-food', 'en:cat-foods']],
    ['congelados', ['en:frozen-foods', 'en:frozen-desserts', 'en:ice-creams-and-sorbets', 'en:ice-creams']],
    // yerba, café, té y polvos para preparar se guardan con lo seco aunque figuren como bebidas
    ['almacen', ['en:yerba-mate', 'en:coffees', 'en:teas', 'en:herbal-teas', 'en:hot-beverages', 'en:instant-beverages', 'en:cocoa-and-chocolate-powders']],
    ['lacteos', ['en:dairies', 'en:milks', 'en:cheeses', 'en:yogurts', 'en:eggs', 'en:butters', 'en:creams', 'en:dulce-de-leche']],
    ['bebidas', ['en:beverages', 'en:waters', 'en:sodas', 'en:juices-and-nectars', 'en:beers', 'en:wines', 'en:alcoholic-beverages']],
    ['carnes', ['en:meats', 'en:meats-and-their-products', 'en:prepared-meats', 'en:sausages', 'en:hams', 'en:poultries', 'en:seafood', 'en:fishes', 'en:fishes-and-their-products']],
    ['panaderia', ['en:breads', 'en:pastries', 'en:viennoiseries']],
    ['frescos', ['en:fresh-vegetables', 'en:fresh-fruits', 'en:fresh-foods']],
  ];
  function categoria(etiquetas) {
    const t = new Set(Array.isArray(etiquetas) ? etiquetas : []);
    for (const [cat, claves] of MAPA) if (claves.some(k => t.has(k))) return cat;
    return 'almacen';
  }
  const limpio = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

  // Devuelve { nombre, marca, presentacion, categoria }, o null si el producto no figura en la base.
  // Si no hay conexión, el servicio no responde a tiempo o rechaza la consulta, falla (lanza un error).
  async function porCodigo(codigo, opciones) {
    const control = new AbortController(), reloj = setTimeout(() => control.abort(), 7000);
    const afuera = opciones && opciones.signal;
    if (afuera) afuera.addEventListener('abort', () => control.abort());
    try {
      const r = await fetch('https://world.openfoodfacts.org/api/v2/product/' + encodeURIComponent(codigo)
        + '.json?fields=product_name,product_name_es,generic_name_es,brands,quantity,categories_tags', { signal: control.signal });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('la consulta no se pudo hacer: ' + r.status);
      const j = await r.json();
      const p = j && (j.status === 1 || j.status === 'success') ? j.product : null;
      if (!p) return null;
      const nombre = limpio(p.product_name_es || p.product_name || p.generic_name_es, 80);
      if (!nombre) return null;
      return {
        nombre: nombre[0].toUpperCase() + nombre.slice(1), marca: limpio(String(p.brands || '').split(',')[0], 50),
        presentacion: limpio(p.quantity, 30), categoria: categoria(p.categories_tags), fuente: 'codigo',
      };
    } finally { clearTimeout(reloj); }
  }

  return {
    iniciar() {},
    etiquetas: () => false,
    tickets: () => false,
    porCodigo,
    textos: {
      sinEtiquetas: '', sinTickets: '',
      consulta: 'Además, el código de barras de cada producto nuevo se consulta en Open Food Facts, una base pública, para completar su nombre.',
    },
    async etiqueta() { return null; },
    async ticket() { return null; },
    nota: () => 'No se pudo leer la foto. Completá los datos a mano.',
    interno: { categoria },
  };
})();


/* Lo que la libreta sabe de los comercios y de los hogares de la zona, con mapas libres (OpenStreetMap):
     · dónde está el teléfono: se lo pregunta al navegador cuando la persona lo pide, y queda guardado solo acá;
     · los comercios: los de OpenStreetMap (los busca el servicio Photon, de Komoot) y los que marcan los hogares
       de la libreta cuando uno no figura; buscarlos cerca o por su nombre y dibujarlos en el mapa (MapLibre +
       OpenFreeMap). Para la dirección de uno que no se conoce, el servicio Overpass;
     · los precios que comparten los hogares de la zona: leerlos y aportar los propios (por Datos.precios).
   No hace falta clave ni cuenta en ningún servicio. Los datos de OpenStreetMap son libres (licencia ODbL): se
   pueden guardar, y el mapa muestra siempre «© OpenStreetMap».

   Cada comercio se identifica con un texto: 'osm:n123' (un punto de OpenStreetMap; 'w' una forma, 'r' un
   conjunto) o 'com:<id>' (uno que marcó un hogar, en la colección `comercios`). */
const Cerca = (() => {
  'use strict';
  const N = Nucleo, A = Ahorro;
  let activo = true;
  try { if (typeof mapasLibres !== 'undefined' && mapasLibres === false) activo = false; } catch (e) { /* config.js no lo dice: se usan */ }
  const PHOTON = window.LIBRETA_PHOTON || 'https://photon.komoot.io';
  const OVERPASS = window.LIBRETA_OVERPASS || 'https://overpass-api.de/api/interpreter';
  const ESTILO = window.LIBRETA_ESTILO || 'https://tiles.openfreemap.org/styles/liberty';
  const MAPLIBRE = window.LIBRETA_MAPLIBRE || 'https://cdn.jsdelivr.net/npm/maplibre-gl@4.7.1/dist/maplibre-gl';
  const DIA = 864e5;
  const RADIO_CERCA = 40000;       // metros: hasta dónde se buscan comercios para elegir (en la ciudad salen los de unas cuadras;
                                   // en el campo, los del pueblo de al lado)
  const RADIO_NOMBRE = 30000;      // metros: hasta dónde sirve un comercio buscado por su nombre
  const RADIO_ZONA = 4000;         // metros: hasta dónde interesan los precios de otros hogares
  const VALE = 15;                 // días que vale un precio compartido: con la inflación, uno más viejo ya no dice mucho
  // Los precios oficiales de los supermercados (SEPA), ya preparados por zona: config.js dice dónde están.
  let OFICIALES = '';
  try { if (typeof preciosOficiales === 'string' && /^https?:\/\//.test(preciosOficiales.trim())) OFICIALES = preciosOficiales.trim().replace(/\/?$/, '/'); } catch (e) { /* config.js no lo trae */ }
  if (!OFICIALES && typeof window.LIBRETA_OFICIALES === 'string') OFICIALES = window.LIBRETA_OFICIALES;
  const PASO_OSM = 0.005;          // los cercanos se guardan por cuadros de media centésima de grado (~500 m)
  const VIDA_OSM = 14 * DIA;       // y se vuelven a pedir a las dos semanas
  const MAX_LUGARES = 400;         // cuántos comercios recuerda el teléfono (dónde quedan y cómo se llaman)

  const esObjeto = x => !!x && typeof x === 'object' && !Array.isArray(x);
  function leer(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function guardar(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento: dura lo que la visita */ } }
  const pausa = ms => new Promise(ok => setTimeout(ok, ms));

  /* ---------- qué decir cuando algo no contesta ---------- */
  function pista(e) {
    const c = String((e && e.code) || ''), m = String((e && e.message) || '');
    if (c === 'ocupado' || /\b(429|504)\b/.test(m)) return 'El servicio de mapas libres está ocupado. Probá de nuevo en un rato.';
    if (c === 'sin-permiso') return 'El navegador no dio permiso para usar la ubicación. Se puede habilitar en los permisos de esta página; mientras tanto, elegí uno de tus comercios o marcalo en el mapa.';
    if (c === 'sin-ubicacion') return 'No se pudo saber dónde estás. Probá de nuevo con la ubicación del teléfono encendida.';
    if (c === 'sin-lugar') return 'No se sabe dónde queda ese comercio.';
    if (c === 'sin-zona') return 'Para buscar comercios por su nombre hace falta saber más o menos dónde estás: tocá «Buscar comercios cerca mío».';
    if (c === 'mapa') return 'No se pudo dibujar el mapa.';
    if (c === 'sin-red' || /network|fetch|timeout|load|abort/i.test(m)) return 'No se pudo llegar al mapa. Revisá internet y probá de nuevo.';
    return 'El mapa no pudo contestar. Probá de nuevo.';
  }
  const conPista = e => (e && typeof e.code === 'string' && e.code.startsWith('cerca/') ? e : { code: 'cerca/' + String((e && e.code) || 'error'), texto: pista(e), crudo: String((e && (e.crudo || e.message)) || '') });

  /* ---------- dónde está el teléfono ---------- */
  const CLAVE_ACA = 'libreta.aca';
  function ultimaPosicion() {
    const p = leer(CLAVE_ACA, null);
    return esObjeto(p) && A.puntoValido(p.lat, p.lon) && Date.now() - p.t < 60 * DIA ? { lat: p.lat, lon: p.lon, t: p.t } : null;
  }
  function olvidarPosicion() { try { localStorage.removeItem(CLAVE_ACA); } catch (e) { /* sin almacenamiento */ } }
  const preguntar = ms => new Promise((ok, mal) => navigator.geolocation.getCurrentPosition(
    p => { const pos = { lat: p.coords.latitude, lon: p.coords.longitude, t: Date.now() }; guardar(CLAVE_ACA, pos); ok(pos); },
    e => mal({ code: e && e.code === 1 ? 'sin-permiso' : 'sin-ubicacion' }),
    { enableHighAccuracy: true, timeout: ms, maximumAge: 120000 }));
  /* `pedir` true: se le pregunta al navegador, que puede pedirle permiso a la persona (solo en respuesta a un toque).
     `pedir` false: sin molestar; la guardada, puesta al día si el permiso ya estaba dado. null si no hay ninguna. */
  async function posicion(pedir) {
    const g = ultimaPosicion();
    if (g && Date.now() - g.t < 120000) return g;
    if (!navigator.geolocation) { if (pedir) throw conPista({ code: 'sin-ubicacion' }); return g; }
    if (pedir) { try { return await preguntar(12000); } catch (e) { throw conPista(e); } }
    if (!g) return null;
    try {
      const st = navigator.permissions && navigator.permissions.query ? await navigator.permissions.query({ name: 'geolocation' }) : null;
      if (st && st.state === 'granted') return await preguntar(6000);
    } catch (e) { /* queda la guardada */ }
    return g;
  }

  /* ---------- los comercios que conoce este teléfono ----------
     libreta.lugares: { id: [lat, lon, cuándo, nombre, dirección, rubro] }. Son datos públicos (de OpenStreetMap o
     de la zona), así que se pueden recordar; se quedan los MAX_LUGARES usados más recientemente. */
  const CLAVE_LUGARES = 'libreta.lugares';
  const conocidos = new Map();         // los de esta visita: id → { id, nombre, direccion, rubro, lat, lon }
  function lugares() { const o = leer(CLAVE_LUGARES, {}); return esObjeto(o) ? o : {}; }
  function recordar(id, lat, lon, nombre, direccion, rubro) {
    if (!id || !A.puntoValido(lat, lon)) return;
    const o = lugares(), ya = Array.isArray(o[id]) ? o[id] : [];
    o[id] = [lat, lon, Date.now(), nombre || ya[3] || '', direccion || ya[4] || '', rubro || ya[5] || ''];
    const ids = Object.keys(o);
    if (ids.length > MAX_LUGARES) ids.sort((a, b) => o[a][2] - o[b][2]).slice(0, ids.length - MAX_LUGARES).forEach(k => delete o[k]);
    guardar(CLAVE_LUGARES, o);
  }
  function deMemoria(id) {
    if (conocidos.has(id)) return conocidos.get(id);
    const v = lugares()[id];
    return Array.isArray(v) && A.puntoValido(v[0], v[1]) ? { id, lat: v[0], lon: v[1], nombre: v[3] || '', direccion: v[4] || '', rubro: v[5] || '' } : null;
  }
  const conocer = l => { conocidos.set(l.id, l); return l; };

  /* ---------- OpenStreetMap ----------
     Se pide solo lo que es comercio de comida o de la casa. Los cercanos y la búsqueda por nombre, a Photon (es
     rápido y está hecho para buscar mientras se escribe); la dirección de uno que no se conoce, a Overpass. */
  const SHOP = ['supermarket', 'convenience', 'greengrocer', 'butcher', 'bakery', 'pastry', 'deli', 'beverages', 'alcohol', 'wine', 'general', 'department_store', 'variety_store',
    'health_food', 'dairy', 'cheese', 'frozen_food', 'seafood', 'spices', 'confectionery', 'chemist', 'wholesale', 'farm', 'pet', 'kiosk', 'food', 'coffee', 'tea', 'organic', 'nuts', 'water'];
  const AMENITY = ['pharmacy', 'marketplace'];
  const RUBROS = { supermarket: 'Supermercado', convenience: 'Almacén', greengrocer: 'Verdulería', butcher: 'Carnicería', bakery: 'Panadería', pastry: 'Confitería', deli: 'Fiambrería',
    beverages: 'Bebidas', alcohol: 'Bebidas', wine: 'Vinoteca', general: 'Almacén', department_store: 'Tienda', variety_store: 'Bazar', health_food: 'Dietética', dairy: 'Lácteos',
    cheese: 'Quesería', frozen_food: 'Congelados', seafood: 'Pescadería', spices: 'Especias', confectionery: 'Golosinas', chemist: 'Perfumería', wholesale: 'Mayorista', farm: 'Granja',
    pet: 'Mascotas', kiosk: 'Kiosco', food: 'Alimentos', coffee: 'Café', tea: 'Té', organic: 'Orgánicos', nuts: 'Frutos secos', water: 'Agua', pharmacy: 'Farmacia', marketplace: 'Mercado' };
  const FILTRO = SHOP.map(t => 'osm_tag=shop:' + t).concat(AMENITY.map(t => 'osm_tag=amenity:' + t)).join('&');
  // los grandes (súper, hiper, mayoristas): se buscan aparte, para que en la ciudad no los tapen los kioscos de la cuadra
  const FILTRO_GRANDES = ['supermarket', 'wholesale', 'department_store'].map(t => 'osm_tag=shop:' + t).join('&');
  const n6 = x => Math.round(x * 1e6) / 1e6;
  async function pedirJson(url, op, ms) {
    const ctl = typeof AbortController === 'function' ? new AbortController() : null, reloj = setTimeout(() => ctl && ctl.abort(), ms || 15000);
    try {
      const r = await fetch(url, Object.assign({ signal: ctl ? ctl.signal : undefined }, op || {}));
      if (r.status === 429 || r.status === 503 || r.status === 504) throw { code: 'ocupado', message: 'HTTP ' + r.status };
      if (!r.ok) throw { code: 'error', message: 'HTTP ' + r.status };
      return await r.json();
    } catch (e) { throw e && e.code ? e : { code: 'sin-red', message: String((e && e.message) || e) }; }
    finally { clearTimeout(reloj); }
  }
  // Un lugar de Photon (GeoJSON) como comercio de la libreta.
  function dePhoton(f) {
    const p = (f && f.properties) || {}, c = f && f.geometry && f.geometry.coordinates, t = { N: 'n', W: 'w', R: 'r' }[p.osm_type];
    if (!Array.isArray(c) || !t || !p.osm_id || !A.puntoValido(c[1], c[0])) return null;
    const rubro = RUBROS[p.osm_value] || 'Comercio', calle = [p.street, p.housenumber].filter(Boolean).join(' ');
    return { id: `osm:${t}${p.osm_id}`, nombre: String(p.name || rubro).slice(0, 80), direccion: calle.slice(0, 120), rubro, lat: c[1], lon: c[0] };
  }
  // Un elemento de Overpass como comercio de la libreta.
  function deOsm(el) {
    const t = el.tags || {}, lat = typeof el.lat === 'number' ? el.lat : el.center && el.center.lat, lon = typeof el.lon === 'number' ? el.lon : el.center && el.center.lon;
    if (!A.puntoValido(lat, lon) || !el.id || !/^(node|way|relation)$/.test(el.type)) return null;
    const rubro = RUBROS[t.shop] || RUBROS[t.amenity] || 'Comercio', calle = [t['addr:street'], t['addr:housenumber']].filter(Boolean).join(' ');
    return { id: `osm:${el.type[0]}${el.id}`, nombre: String(t.name || t.brand || rubro).slice(0, 80), direccion: calle.slice(0, 120), rubro, lat, lon };
  }
  // Los comercios más cercanos a un punto (hasta 50 de todo tipo y 30 grandes, a 40 km), guardados por cuadro para no pedirlos de nuevo.
  const CLAVE_OSM = 'libreta.osm';
  const pidiendo = new Map();
  function delCuadro(pos) {
    const cy = Math.floor((pos.lat + 90) / PASO_OSM + 1e-9), cx = Math.floor((pos.lon + 180) / PASO_OSM + 1e-9), k = `${cy}x${cx}`;
    const guardados = leer(CLAVE_OSM, {}), g = esObjeto(guardados) ? guardados[k] : null;
    if (g && Array.isArray(g.l) && Date.now() - g.t < VIDA_OSM && g.t <= Date.now() + DIA) {
      return Promise.resolve(g.l.map(x => conocer({ id: x[0], nombre: x[1], direccion: x[2], rubro: x[3], lat: x[4], lon: x[5] })));
    }
    if (pidiendo.has(k)) return pidiendo.get(k);
    const lat = n6((cy + 0.5) * PASO_OSM - 90), lon = n6((cx + 0.5) * PASO_OSM - 180);      // el centro del cuadro: no el punto exacto del teléfono
    const pedir = (filtro, cuantos) => pedirJson(`${PHOTON}/reverse?lat=${lat}&lon=${lon}&radius=${(RADIO_CERCA + 400) / 1000}&limit=${cuantos}&lang=default&${filtro}`);
    const p = Promise.all([pedir(FILTRO, 50), pedir(FILTRO_GRANDES, 30).catch(() => null)]).then(([j, g]) => {
      const vistos = new Set(), l = [];
      for (const f of ((j && j.features) || []).concat((g && g.features) || [])) {
        const x = dePhoton(f);
        if (x && !vistos.has(x.id)) { vistos.add(x.id); l.push(conocer(x)); }
      }
      const todos = leer(CLAVE_OSM, {}), o = esObjeto(todos) ? todos : {};
      o[k] = { t: Date.now(), l: l.map(x => [x.id, x.nombre, x.direccion, x.rubro, x.lat, x.lon]) };
      for (const v of Object.keys(o).sort((a, b) => o[b].t - o[a].t).slice(8)) delete o[v];       // se guardan los últimos 8 cuadros
      guardar(CLAVE_OSM, o);
      return l;
    });
    pidiendo.set(k, p);
    p.then(() => pidiendo.delete(k), () => pidiendo.delete(k));
    return p;
  }

  /* ---------- los que marcaron los hogares ---------- */
  const deLaZona = new Map();          // cuadro (0,1°) → { t, lista }
  async function marcados(pos) {
    if (!Datos.comercios) return [];
    const zonas = A.celdasCerca(pos.lat, pos.lon, RADIO_CERCA), faltan = zonas.filter(z => !deLaZona.has(z) || Date.now() - deLaZona.get(z).t > 600000);
    if (faltan.length) {
      try {
        const docs = await Datos.comercios.buscar(faltan);
        for (const z of faltan) deLaZona.set(z, { t: Date.now(), lista: [] });
        for (const d of docs) if (deLaZona.has(d.z) && A.puntoValido(d.la, d.lo)) deLaZona.get(d.z).lista.push(conocer({ id: 'com:' + d.id, nombre: String(d.n || 'Comercio'), direccion: String(d.a || ''), rubro: String(d.r || ''), lat: d.la, lon: d.lo, zona: true }));
      } catch (e) { /* sin los de la zona esta vez */ }
    }
    return zonas.flatMap(z => (deLaZona.get(z) || { lista: [] }).lista);
  }

  /* ---------- comercios ---------- */
  let ultCerca = null;       // { pos, t, lista }: si el teléfono casi no se movió, no se pide de nuevo
  // Los comercios de comida y de la casa más cercanos: [{ id, nombre, direccion, rubro, lat, lon, dist }], el más cercano primero.
  async function cercanos(pos) {
    if (ultCerca && Date.now() - ultCerca.t < 600000 && A.distancia(pos.lat, pos.lon, ultCerca.pos.lat, ultCerca.pos.lon) < 150) return ultCerca.lista;
    const [osm, zona] = await Promise.all([delCuadro(pos).catch(e => { throw conPista(e); }), marcados(pos)]);
    const vistos = new Set(), lista = [];
    for (const l of zona.concat(osm)) {
      if (vistos.has(l.id)) continue;
      vistos.add(l.id);
      const dist = A.distancia(pos.lat, pos.lon, l.lat, l.lon);
      if (dist <= RADIO_CERCA) lista.push(Object.assign({ dist }, l));
    }
    lista.sort((a, b) => a.dist - b.dist);
    ultCerca = { pos, t: Date.now(), lista: lista.slice(0, 60) };
    return ultCerca.lista;
  }
  // Para comparar nombres sin mayúsculas ni tildes.
  const plano = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const busquedas = new Map();
  /* Buscar un comercio por su nombre: primero entre los que ya conoce el teléfono (los cercanos, los marcados por
     la zona y los del hogar); si son pocos, en OpenStreetMap cerca de `pos` (una consulta por texto).
     Devuelve [{ id, nombre, direccion, rubro, lat, lon, dist }]. */
  async function sugerir(texto, pos) {
    const q = plano(texto);
    if (q.length < 2) return [];
    const centro = pos || null, conDist = l => Object.assign({}, l, { dist: centro ? A.distancia(centro.lat, centro.lon, l.lat, l.lon) : null });
    const coincide = l => plano(l.nombre).includes(q) || plano(l.direccion).includes(q);
    const out = new Map();
    for (const l of conocidos.values()) if (coincide(l)) out.set(l.id, conDist(l));
    if (out.size < 4 && q.length >= 3) {
      if (!centro) { if (!out.size) throw conPista({ code: 'sin-zona' }); }
      else {
        const k = A.celda(centro.lat, centro.lon) + '|' + q;
        if (!busquedas.has(k)) {
          const lat = n6(Math.round(centro.lat * 100) / 100), lon = n6(Math.round(centro.lon * 100) / 100);       // cerca de dónde está, sin decir el punto exacto
          const pr = pedirJson(`${PHOTON}/api?q=${encodeURIComponent(texto.trim().slice(0, 60))}&lat=${lat}&lon=${lon}&limit=12&lang=default&${FILTRO}`)
            .then(j => ((j && j.features) || []).map(dePhoton).filter(Boolean).filter(l => A.distancia(centro.lat, centro.lon, l.lat, l.lon) <= RADIO_NOMBRE).map(conocer));
          busquedas.set(k, pr);
          pr.catch(() => busquedas.delete(k));
        }
        try { for (const l of await busquedas.get(k)) if (!out.has(l.id)) out.set(l.id, conDist(l)); }
        catch (e) { if (!out.size) throw conPista(e); }
      }
    }
    return [...out.values()].sort((a, b) => (a.dist == null ? 1e9 : a.dist) - (b.dist == null ? 1e9 : b.dist)).slice(0, 8);
  }
  const ubicarSugerido = l => (A.puntoValido(l.lat, l.lon) ? Promise.resolve({ lat: l.lat, lon: l.lon }) : ubicacion(l.id));
  // Nombre, dirección y ubicación de un comercio: { id, nombre, direccion, rubro, lat, lon }.
  async function detalle(id) {
    const ya = deMemoria(id);
    if (ya) return ya;
    let l = null;
    try {
      const m = /^osm:([nwr])(\d+)$/.exec(id), c = /^com:(.+)$/.exec(id);
      if (m) {
        const q = `[out:json][timeout:10];${{ n: 'node', w: 'way', r: 'relation' }[m[1]]}(${m[2]});out center tags;`;
        const j = await pedirJson(OVERPASS, { method: 'POST', body: new URLSearchParams({ data: q }) }, 12000);
        l = ((j && j.elements) || []).map(deOsm).filter(Boolean)[0] || null;
      } else if (c && Datos.comercios) {
        const d = await Datos.comercios.leer(c[1]);
        if (d && A.puntoValido(d.la, d.lo)) l = { id, nombre: String(d.n || 'Comercio'), direccion: String(d.a || ''), rubro: String(d.r || ''), lat: d.la, lon: d.lo, zona: true };
      }
    } catch (e) { throw conPista(e); }
    if (!l) throw conPista({ code: 'sin-lugar' });
    recordar(id, l.lat, l.lon, l.nombre, l.direccion, l.rubro);
    return conocer(l);
  }
  // { lat, lon }: dónde queda un comercio.
  async function ubicacion(id) { const d = await detalle(id); return { lat: d.lat, lon: d.lon, t: Date.now() }; }
  // Un comercio que no figura: lo marca este hogar y queda para toda la zona. Devuelve su identificador ('com:…').
  async function marcar(nombre, lat, lon, rubro) {
    if (!Datos.comercios) throw conPista({ code: 'error' });
    const n = String(nombre || '').trim().slice(0, 60);
    if (!n || !A.puntoValido(lat, lon)) throw conPista({ code: 'sin-lugar' });
    const z = A.celda(lat, lon), id = await Datos.comercios.crear({ z, n, la: n6(lat), lo: n6(lon), r: String(rubro || '').slice(0, 30) });
    const l = conocer({ id: 'com:' + id, nombre: n, direccion: '', rubro: rubro || '', lat: n6(lat), lon: n6(lon), zona: true });
    const g = deLaZona.get(z);
    if (g) g.lista.push(l);
    ultCerca = null;
    recordar(l.id, l.lat, l.lon, l.nombre, '', l.rubro);
    return l.id;
  }
  // Para ir hasta ahí: abre la app de mapas que use la persona (en el teléfono, la que tenga), con «Cómo llegar».
  const enlace = (id, lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(`${lat},${lon}`)}`;

  /* ---------- los precios de la zona ----------
     Cada precio compartido es un documento por zona (un cuadro del mapa), código de barras y comercio. Lleva el
     nombre público del comercio y, si el hogar lo eligió, su nombre público («Familia García»); nunca la cuenta, el
     email ni los nombres de las personas. Vence a los 30 días como mucho y los vencidos se borran. */
  // Lo que la zona compartió para esos códigos de barras cerca de `pos`: Map código → precios, el más barato primero.
  async function buscar(pos, codigos) {
    const hoy = N.diaDe(N.hoyISO()), zonas = A.celdasCerca(pos.lat, pos.lon, RADIO_ZONA), claves = [], out = new Map();
    for (const e of new Set(codigos)) if (e) for (const z of zonas) claves.push(`${z}_${e}`);
    if (!claves.length) return out;
    let docs;
    try { docs = await Datos.precios.buscar(claves); }
    catch (e) {
      const crudo = String((e && (e.code || e.message)) || '');
      throw { code: 'cerca/zona', crudo, texto: /permission-denied/.test(crudo) ? 'Firebase no deja leer los precios de la zona: falta publicar las reglas nuevas (el archivo firestore.rules).' : 'No se pudieron traer los precios de tu zona. Revisá la conexión.' };
    }
    const crudos = new Map();
    for (const d of docs) {
      if (!(d.v >= hoy) || !(d.d <= hoy + 1) || !(d.p > 0)) { if (d.v < hoy - 2) Datos.precios.borrar(d.id); continue; }
      if (!crudos.has(d.e)) crudos.set(d.e, []);
      crudos.get(d.e).push({ precio: +d.p, k: String(d.k), texto: typeof d.t === 'string' ? d.t : '', lat: +d.la, lon: +d.lo, dia: +d.d, cuantos: +d.c || 1, comercio: typeof d.n === 'string' ? d.n : '', hogar: typeof d.h === 'string' ? d.h : '', si: +d.qs || 0, no: +d.qn || 0 });
    }
    try { await sumarOficiales(pos, codigos, crudos); } catch (e) { /* sin los oficiales esta vez */ }
    for (const [e, l] of crudos) { const o = A.ordenarCerca(l, pos, RADIO_ZONA); if (o.length) out.set(e, o); }
    return out;
  }

  /* ---------- los precios oficiales (SEPA) ----------
     Cada cuadro de la zona es un archivo comprimido, que se arma una vez por día con los datos abiertos del Estado:
       { fecha: 'AAAA-MM-DD', s: [[cadena, sucursal, dirección, lat, lon], …], l: [leyenda de promo, …],
         p: { código (14 dígitos): [[sucursal, precio de lista, promo para todos, promo con condiciones, leyenda], …] } }
     Se guarda en memoria por la visita; el navegador, además, lo tiene en su caché. */
  const cuadrosOficiales = new Map();          // cuadro → Promise<datos | null>
  function cuadroOficial(z) {
    if (!cuadrosOficiales.has(z)) {
      const p = (async () => {
        const r = await fetch(`${OFICIALES}celdas/${z}.json.gz`);
        if (r.status === 404) return null;
        if (!r.ok) throw { code: 'error', message: 'HTTP ' + r.status };
        const b = new Uint8Array(await r.arrayBuffer());
        // viene comprimido; si el servidor ya lo descomprimió en el camino, llega como texto
        if (b[0] === 0x1f && b[1] === 0x8b) {
          if (typeof DecompressionStream !== 'function') return null;
          return JSON.parse(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
        }
        return JSON.parse(new TextDecoder().decode(b));
      })();
      cuadrosOficiales.set(z, p);
      p.catch(() => cuadrosOficiales.delete(z));
    }
    return cuadrosOficiales.get(z);
  }
  async function sumarOficiales(pos, codigos, crudos) {
    if (!OFICIALES) return;
    const zonas = A.celdasCerca(pos.lat, pos.lon, RADIO_ZONA), buscados = new Set(codigos.filter(Boolean)), hoy = N.diaDe(N.hoyISO());
    const cuadros = await Promise.all(zonas.map(z => cuadroOficial(z).catch(() => null)));
    for (const c of cuadros) {
      if (!c || !c.p || !Array.isArray(c.s) || !N.fechaValida(c.fecha)) continue;
      const dia = N.diaDe(c.fecha);
      if (dia < hoy - 7) continue;                // datos de hace más de una semana: no
      for (const e of buscados) {
        for (const x of c.p[e] || []) {
          const suc = c.s[x[0]];
          if (!suc || !A.puntoValido(suc[3], suc[4])) continue;
          const lista = +x[1], promo = +x[2] > 0 ? +x[2] : 0, precio = promo > 0 && promo < lista ? promo : lista;
          if (!(precio > 0)) continue;
          const k = `sepa:${suc[0]}:${x[0]}:${suc[3]},${suc[4]}`, nombre = [suc[0], suc[1]].filter(Boolean).join(' ').slice(0, 60);
          conocer({ id: k, nombre, direccion: String(suc[2] || ''), rubro: 'Supermercado', lat: suc[3], lon: suc[4] });
          const o = { precio, k, lat: suc[3], lon: suc[4], dia, cuantos: 1, comercio: nombre, hogar: '', si: 0, no: 0, oficial: true };
          if (+x[3] > 0 && +x[3] < precio) o.promo = { precio: +x[3], texto: String((c.l || [])[x[4]] || '').slice(0, 90) };
          if (!crudos.has(e)) crudos.set(e, []);
          crudos.get(e).push(o);
        }
      }
    }
  }
  /* Lo que este hogar pagó, para la zona. items: [{ codigo, precio, reco, texto }] (codigo: el de barras o, sin
     código, «n-» y el nombre; texto: el nombre, para esos) (reco: 1 lo recomienda, -1 no, 0 nada)
     ref: el comercio · dia: el de la compra · quien: el nombre público del hogar ('' si no eligió ninguno).
     Devuelve cuántos precios quedaron anotados (los que el servidor rechaza no cuentan). */
  const CLAVE_VOTOS = 'libreta.votos';
  async function aportar(items, ref, dia, quien, lugar) {
    // dónde queda y cómo se llama: lo que ya sabe el hogar o, si no, lo que diga el mapa
    let l = lugar && A.puntoValido(lugar.lat, lugar.lon) && lugar.nombre ? lugar : null;
    if (!l) { const d = await detalle(ref); l = { lat: d.lat, lon: d.lon, nombre: d.nombre }; }
    const z = A.celda(l.lat, l.lon), vence = dia + VALE;
    const validos = items.filter(it => it.precio > 0 && it.codigo);
    let previos = [];
    try { previos = await Datos.precios.buscar(validos.map(it => `${z}_${it.codigo}`)); } catch (e) { previos = []; }
    const votos = new Set(leer(CLAVE_VOTOS, [])), hogar = String(quien || '').trim().slice(0, 40);
    const hechos = await Promise.all(validos.map(it => {
      const ya = previos.find(d => d.e === it.codigo && d.k === ref && d.v >= dia), idDoc = `${z}_${it.codigo}_${ref}`;
      // el mismo precio visto otro día es una confirmación más; uno distinto empieza la cuenta de nuevo
      const c = ya && Math.abs(ya.p - it.precio) <= it.precio * 0.01 ? (ya.d < dia ? Math.min(9999, (+ya.c || 1) + 1) : (+ya.c || 1)) : 1;
      // cada hogar cuenta una sola vez su recomendación de un producto en un comercio
      let qs = ya ? Math.min(9999, +ya.qs || 0) : 0, qn = ya ? Math.min(9999, +ya.qn || 0) : 0;
      if (it.reco && !votos.has(idDoc)) { if (it.reco > 0) qs = Math.min(9999, qs + 1); else qn = Math.min(9999, qn + 1); votos.add(idDoc); }
      return Datos.precios.aportar({ z, e: it.codigo, k: ref, p: it.precio, d: dia, c, la: l.lat, lo: l.lon, v: vence, n: l.nombre.slice(0, 60) || 'Comercio', h: hogar, qs, qn, t: it.texto || '', g: it.cat || '' });
    }));
    guardar(CLAVE_VOTOS, [...votos].slice(-500));
    return hechos.filter(Boolean).length;
  }

  /* ---------- el buscador ----------
     Lo que la zona compartió que coincide con lo buscado («pizzeta», «jamón», «verdura»): por el nombre del producto o
     por su categoría. Uno por producto y comercio, el más barato primero. Las promos de la zona que coincidan, aparte. */
  async function buscarTexto(pos, consulta) {
    const q = N.raices(consulta), hoy = N.diaDe(N.hoyISO());
    if (!q.length) return { precios: [], promos: [] };
    const zonas = A.celdasCerca(pos.lat, pos.lon, RADIO_ZONA);
    let docs;
    try { docs = await Datos.precios.deZonas(zonas, 600); }
    catch (e) {
      const crudo = String((e && (e.code || e.message)) || '');
      throw { code: 'cerca/zona', crudo, texto: 'No se pudieron traer los precios de tu zona. Revisá la conexión.' };
    }
    const m = new Map();
    for (const d of docs) {
      if (!(d.v >= hoy) || !(d.d <= hoy + 1) || !(d.p > 0) || typeof d.t !== 'string' || !A.puntoValido(d.la, d.lo)) continue;
      if (!N.coincide(q, d.t) && !(d.g && N.CATS[d.g] && N.coincide(q, N.CATS[d.g]))) continue;
      const dist = A.distancia(pos.lat, pos.lon, d.la, d.lo);
      if (dist > RADIO_ZONA) continue;
      const k = d.e + '|' + d.k, o = { e: d.e, texto: d.t, precio: +d.p, k: String(d.k), lat: +d.la, lon: +d.lo, dist, dia: +d.d, cuantos: +d.c || 1, comercio: typeof d.n === 'string' ? d.n : '', hogar: typeof d.h === 'string' ? d.h : '', si: +d.qs || 0, no: +d.qn || 0 };
      const ya = m.get(k);
      if (!ya || o.dia > ya.dia) m.set(k, o);
    }
    const precios = [...m.values()].sort((a, b) => a.precio - b.precio || a.dist - b.dist).slice(0, 40);
    let lp = [];
    try { lp = (await promos(pos)).filter(p => N.coincide(q, `${p.t} ${p.n}`)); } catch (e) { lp = []; }
    return { precios, promos: lp.slice(0, 10) };
  }

  /* Confirmar que un precio de otro hogar sigue igual: el mismo documento, con la fecha de hoy y una confirmación más.
     Conserva quién lo cargó y no se avisa como novedad. d: el documento tal como vino de Datos.precios. */
  function confirmar(d) {
    const hoy = N.diaDe(N.hoyISO());
    return Datos.precios.aportar({ z: d.z, e: d.e, k: d.k, p: d.p, d: hoy, c: Math.min(9999, (+d.c || 1) + 1), la: d.la, lo: d.lo, v: hoy + VALE,
      n: d.n, h: d.h || '', qs: d.qs || 0, qn: d.qn || 0, t: d.t, g: d.g, sinNovedad: true });
  }
  // Los precios vigentes que la zona tiene de un comercio (para confirmarlos): [{ id, z, e, k, p, d, c, t, … }].
  async function deComercio(k, lat, lon) {
    const hoy = N.diaDe(N.hoyISO()), docs = await Datos.precios.deZonas([A.celda(lat, lon)], 600);
    return docs.filter(d => d.k === k && d.v >= hoy && d.p > 0 && typeof d.t === 'string').sort((a, b) => a.d - b.d);
  }

  /* ---------- promos de la zona ----------
     Las que cargan los hogares: por día, banco o billetera. Las vencidas no se muestran y se borran. */
  async function promos(pos) {
    if (!Datos.promos) return [];
    const zonas = A.celdasCerca(pos.lat, pos.lon, RADIO_ZONA), hoy = N.diaDe(N.hoyISO());
    let docs;
    try { docs = await Datos.promos.buscar(zonas); }
    catch (e) {
      const crudo = String((e && (e.code || e.message)) || '');
      throw { code: 'cerca/promos', crudo, texto: /permission-denied/.test(crudo) ? 'Firebase no deja leer las promos: falta publicar las reglas nuevas (el archivo firestore.rules).' : 'No se pudieron traer las promos de tu zona. Revisá la conexión.' };
    }
    const out = [];
    for (const d of docs) {
      if (!(d.hasta >= hoy)) { if (d.hasta < hoy - 2) Datos.promos.borrar(d.id); continue; }
      if (!A.puntoValido(d.la, d.lo)) continue;
      const dist = A.distancia(pos.lat, pos.lon, d.la, d.lo);
      if (dist > RADIO_ZONA) continue;
      out.push({ id: d.id, k: String(d.k), n: String(d.n || 'Comercio'), t: String(d.t || ''), m: String(d.m || ''), pct: +d.pct || 0, hasta: +d.hasta, h: String(d.h || ''),
        dias: Array.isArray(d.dias) ? d.dias.filter(x => Number.isInteger(x) && x >= 0 && x <= 6) : [], lat: d.la, lon: d.lo, dist });
    }
    return out.sort((a, b) => b.pct - a.pct || a.dist - b.dist);
  }
  const cargarPromo = r => Datos.promos.crear(Object.assign({ z: A.celda(r.la, r.lo) }, r));

  /* Una vez por día, este teléfono borra del servidor los precios que vencieron hace más de dos días, de la zona
     que sean: así no quedan guardados aunque nadie vuelva a pasar por donde se cargaron. Devuelve cuántos borró. */
  const CLAVE_LIMPIEZA = 'libreta.limpieza';
  let limpioHoy = 0;
  async function limpiar() {
    const hoy = N.diaDe(N.hoyISO());
    if (limpioHoy === hoy || leer(CLAVE_LIMPIEZA, 0) === hoy) { limpioHoy = hoy; return 0; }
    limpioHoy = hoy;
    try {
      const viejos = await Datos.precios.vencidos(hoy - 2, 40);
      guardar(CLAVE_LIMPIEZA, hoy);          // recién ahora: si no hubo conexión, se prueba la próxima vez que se abra
      for (const d of viejos) Datos.precios.borrar(d.id);
      return viejos.length;
    } catch (e) { return 0; }
  }

  /* ---------- el mapa ----------
     MapLibre (la biblioteca) con el mapa de OpenFreeMap (datos de OpenStreetMap). Se carga la primera vez que hace falta. */
  let cargando = null;
  function cargarMapa() {
    if (window.maplibregl) return Promise.resolve(window.maplibregl);
    if (!cargando) {
      cargando = new Promise((ok, mal) => {
        if (!document.querySelector('link[data-maplibre]')) {
          const css = document.createElement('link');
          css.rel = 'stylesheet'; css.href = MAPLIBRE + '.css'; css.dataset.maplibre = '1';
          document.head.appendChild(css);
        }
        const s = document.createElement('script'), reloj = setTimeout(() => mal({ code: 'sin-red' }), 20000);
        s.src = MAPLIBRE + '.js'; s.async = true;
        s.onload = () => { clearTimeout(reloj); window.maplibregl ? ok(window.maplibregl) : mal({ code: 'mapa' }); };
        s.onerror = () => { clearTimeout(reloj); s.remove(); mal({ code: 'sin-red' }); };
        document.head.appendChild(s);
      });
      cargando.catch(() => { cargando = null; });
    }
    return cargando;
  }
  /* Dibuja el mapa en `el`, con un cartelito por comercio.
       op: { pines: [{ k, lat, lon, texto, tono }], yo: { lat, lon } | null, alTocar(k), mira: true (para marcar un punto), centro }
     Devuelve { elegir(k, mover), centro(), destruir() }. */
  async function dibujar(el, op) {
    let ml;
    try { ml = await cargarMapa(); } catch (e) { throw conPista(e); }
    try {
      const pines = (op.pines || []).filter(p => A.puntoValido(p.lat, p.lon)), yo = op.yo && A.puntoValido(op.yo.lat, op.yo.lon) ? op.yo : null;
      const lienzo = document.createElement('div');
      lienzo.className = 'mapa-lienzo';
      el.textContent = '';
      el.appendChild(lienzo);
      const c0 = op.centro && A.puntoValido(op.centro.lat, op.centro.lon) ? op.centro : yo || pines[0] || { lat: -34.6037, lon: -58.3816 };
      const mapa = new ml.Map({ container: lienzo, style: ESTILO, center: [c0.lon, c0.lat], zoom: op.mira ? 17 : 15, maxZoom: 19, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false, touchPitch: false });
      try { mapa.touchZoomRotate.disableRotation(); } catch (e) { /* sin gestos táctiles */ }
      mapa.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
      const marcas = new Map();
      let elegido = null;
      const marcar = p => {
        const caja = document.createElement('div'), b = document.createElement('button');
        caja.className = 'marca' + (p.k === elegido ? ' elegido' : '');
        b.type = 'button';
        b.className = 'pin' + (p.tono ? ' ' + p.tono : '') + (p.k === elegido ? ' elegido' : '');
        b.textContent = p.texto;
        b.dataset.k = p.k;
        b.addEventListener('click', ev => { ev.stopPropagation(); if (op.alTocar) op.alTocar(p.k); });
        caja.appendChild(b);
        marcas.set(p.k, { caja, b, m: new ml.Marker({ element: caja, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(mapa), lat: p.lat, lon: p.lon, texto: p.texto, tono: p.tono || '' });
      };
      for (const p of pines) marcar(p);
      let marcaYo = null;
      if (yo) {
        const s = document.createElement('span');
        s.className = 'pin-yo';
        s.setAttribute('aria-label', 'Vos');
        marcaYo = new ml.Marker({ element: s, anchor: 'center' }).setLngLat([yo.lon, yo.lat]).addTo(mapa);
      }
      if (op.mira) {
        const m = document.createElement('span');
        m.className = 'mapa-mira';
        m.setAttribute('aria-hidden', 'true');
        el.appendChild(m);
      } else if (pines.length + (yo ? 1 : 0) > 1) {
        const lim = new ml.LngLatBounds();
        for (const p of pines) lim.extend([p.lon, p.lat]);
        if (yo) lim.extend([yo.lon, yo.lat]);
        mapa.fitBounds(lim, { padding: 56, maxZoom: 16, animate: false });
      }
      // si el mapa de fondo no carga (sin internet), quedan los carteles sobre gris y abajo la lista
      mapa.on('error', () => { el.classList.add('sin-fondo'); });
      return {
        // Cambia los carteles por otros (el mapa en vivo): saca los que ya no están, actualiza los que cambiaron y suma los nuevos.
        poner(nuevos) {
          const quedan = new Set();
          for (const p of nuevos || []) {
            if (!A.puntoValido(p.lat, p.lon)) continue;
            quedan.add(p.k);
            const x = marcas.get(p.k);
            if (x && x.lat === p.lat && x.lon === p.lon) {
              if (x.texto !== p.texto) { x.b.textContent = p.texto; x.texto = p.texto; }
              if (x.tono !== (p.tono || '')) { x.b.className = 'pin' + (p.tono ? ' ' + p.tono : '') + (p.k === elegido ? ' elegido' : ''); x.tono = p.tono || ''; }
              continue;
            }
            if (x) { x.m.remove(); marcas.delete(p.k); }
            marcar(p);
          }
          for (const [k, x] of [...marcas]) if (!quedan.has(k)) { x.m.remove(); marcas.delete(k); }
        },
        elegir(k, mover) {
          elegido = k;
          for (const [id, x] of marcas) { x.b.classList.toggle('elegido', id === k); x.caja.classList.toggle('elegido', id === k); }
          const x = marcas.get(k);
          if (x && mover) mapa.easeTo({ center: [x.lon, x.lat] });
        },
        centro() { const c = mapa.getCenter(); return { lat: n6(c.lat), lon: n6(c.lng) }; },
        destruir() {
          try { mapa.remove(); } catch (e) { /* ya no estaba */ }
          el.textContent = '';
        },
      };
    } catch (e) { throw conPista({ code: 'mapa', message: String((e && e.message) || e) }); }
  }

  return {
    conMapa: () => activo,
    // Para la prueba de conexión: que el mapa de fondo conteste.
    async probar() {
      try {
        const r = await Promise.race([fetch(ESTILO, { cache: 'no-store' }), pausa(15000).then(() => { throw { code: 'sin-red' }; })]);
        if (!r.ok) throw { code: 'error', message: 'HTTP ' + r.status };
        return 'funciona';
      } catch (e) { throw conPista(e); }
    },
    posicion, ultimaPosicion, olvidarPosicion,
    cercanos, sugerir, ubicarSugerido, detalle, ubicacion, recordar, marcar, enlace, conocido: deMemoria, conOficiales: () => !!OFICIALES,
    buscar, buscarTexto, aportar, confirmar, deComercio, VALE, limpiar, dibujar, promos, cargarPromo,
    RADIO_ZONA,
  };
})();


/* La pantalla de la libreta: alacena, compras y gastos. Los datos los guarda `Datos` y las fotos las lee `Lector`. */
(() => {
  'use strict';
  const N = Nucleo, A = Ahorro;
  const C = typeof Cerca !== 'undefined' ? Cerca : null;      // el mapa, los comercios y los precios de la zona: solo con servidor
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  /* ---------- plantillas: todo lo que se interpola se escapa ---------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = s => String(s).replace(/[&<>"']/g, c => ESC[c]);
  const crudo = s => ({ __h: String(s) });
  function val(v) {
    if (v == null || v === false || v === true) return '';
    if (Array.isArray(v)) return v.map(val).join('');
    if (typeof v === 'object' && '__h' in v) return v.__h;
    return esc(v);
  }
  function h(st, ...vs) {
    let o = st[0];
    for (let i = 0; i < vs.length; i++) o += val(vs[i]) + st[i + 1];
    return { __h: o };
  }
  const ico = n => crudo(`<svg class="ico" aria-hidden="true"><use href="#i-${n}"/></svg>`);
  const atr = (nombre, cond) => crudo(cond ? ` ${nombre}` : '');
  const opciones = (pares, sel) => pares.map(([v, t]) => h`<option value="${v}"${atr('selected', v === sel)}>${t}</option>`);
  const campo = (rotulo, control, ayuda) => h`<label class="campo"><span>${rotulo}</span>${control}${ayuda ? h`<small>${ayuda}</small>` : ''}</label>`;
  const campoPaso = (rotulo, id, k, valor, min) => h`<div class="campo"><span id="${id}-r">${rotulo}</span><div class="paso">
    <button type="button" data-act="paso" data-para="${id}" data-d="-1" aria-label="Uno menos">${ico('menos')}</button>
    <input type="number" id="${id}" data-k="${k}" value="${valor}" min="${min}" max="9999" step="1" inputmode="numeric" aria-labelledby="${id}-r">
    <button type="button" data-act="paso" data-para="${id}" data-d="1" aria-label="Uno más">${ico('mas')}</button></div></div>`;

  /* ---------- estado ---------- */
  const E = {
    tab: 'alacena',
    db: null, conexion: 'esperando', lectura: false, permisoSabido: false,
    prod: new Map(), prodListo: false, tickets: [], ticListo: false,
    ajustes: { frecuencia: 7, presupuesto: 0, compartir: null, comercios: {} },
    filtro: { texto: '', chip: 'todo' },
    mes: null, marcados: new Set(),
    hoja: null, turno: 0, tostadaFn: null, borrandoEj: false,
    codigoPara: null,   // el producto que espera la foto de su código de barras, mientras se elige el archivo
    puerta: null,       // la entrada, mientras no se entró a ningún hogar: { modo, paso, nombre, codigo, error, … }
    anterior: null,     // datos de la libreta anterior que quedaron en este teléfono: { productos, tickets, ocupado, confirmar }
    motivo: '',         // por qué no hay conexión con los datos, si se sabe
    // lo que otros hogares de la zona pagaron por productos de este: porId es id de producto → sus precios, del más barato al más caro
    cerca: { estado: 'sin', pos: null, porId: new Map(), firma: '', t: 0, nota: '' },
    promos: { estado: 'sin', lista: [], t: 0, nota: '' },        // las promos de la zona (por día, banco o billetera)
    modoEscaneo: null,                                            // 'precio': se escanea en la góndola, para saber si conviene
    porCompartir: null, // precios recién anotados que esperan que el hogar decida si comparte
  };
  let V = { prods: [], compras: [], tickets: [], plan: null, cerca: new Map() };   // lo que se ve, calculado en cada pintada
  const TABS = ['alacena', 'compras', 'gastos', 'novedades'];

  const hoyDia = () => N.diaDe(N.hoyISO());
  const pausa = ms => new Promise(r => setTimeout(r, ms));
  const limpio = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const esObjeto = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const entero = (v, def, min) => { const n = Math.round(Number(String(v).replace(',', '.'))); return isFinite(n) ? Math.max(min == null ? 0 : min, Math.min(9999, n)) : def; };
  const catDe = p => (N.CATS_ALACENA.includes(p.categoria) ? p.categoria : 'otros');
  const dedoGrueso = () => { try { return matchMedia('(pointer: coarse)').matches; } catch (e) { return false; } };
  function leerLocal(k, def) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function guardarLocal(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento: se pierde al recargar */ } }

  /* ---------- avisos breves ---------- */
  let relojTostada = 0;
  function avisar(texto, accion) {
    const el = $('#tostada');
    el.innerHTML = val(h`<span>${texto}</span>${accion ? h`<button type="button" data-act="tostada-accion">${accion.rotulo}</button>` : ''}`);
    E.tostadaFn = accion ? accion.fn : null;
    el.hidden = false;
    clearTimeout(relojTostada);
    relojTostada = setTimeout(() => { el.hidden = true; E.tostadaFn = null; }, accion ? 6500 : 3600);
  }

  /* ---------- guardar ---------- */
  function puede() {
    if (E.conexion === 'esperando') { avisar('Todavía se están cargando los datos guardados.'); return false; }
    if (E.conexion !== 'lista' || !E.db) { avisar('No hay conexión con los datos guardados.'); return false; }
    if (E.lectura) { avisar('Esta libreta está en modo solo lectura.'); return false; }
    return true;
  }
  async function escribir(fn) {
    try { return await fn(); }
    catch (e) {
      if (e && e.code === 'unavailable') { await pausa(400 + Math.random() * 600); return await fn(); }
      if (e && e.code === 'resource_exhausted') { await pausa(2200 + Math.random() * 800); return await fn(); }   // ir más despacio, una sola vez
      throw e;
    }
  }
  /* Qué decir cuando no se pudo guardar. `existe` es false cuando lo que se quiso cambiar ya no está
     (lo borraron desde otra pestaña o desde otro teléfono): la base lo rechaza igual que la falta de permiso. Si el rechazo
     no se explica así y la plataforma no dijo si esta persona puede escribir, la libreta pasa a solo lectura. */
  function textoFallo(e, existe) {
    if (e && e.texto) return e.texto;        // quien guarda los datos ya sabe explicarlo
    switch (e && e.code) {
      case 'quota_exceeded': return 'La libreta llegó al límite de lo que puede guardar. Borrá tickets o productos viejos y probá de nuevo.';
      case 'resource_exhausted': return 'Demasiados cambios seguidos. Esperá unos segundos y probá de nuevo.';
      case 'invalid_argument':
        if (existe === false) return 'Ese dato ya no está: puede que lo haya borrado otra persona.';
        if (!E.permisoSabido) { E.lectura = true; pintar(); }
        return 'No se pudo guardar. Puede que no tengas permiso para modificar esta libreta.';
      case 'revoked': case 'not_granted': return 'Se perdió el acceso a los datos. Recargá la página.';
      default: return Datos.textos.fallo || 'No se pudo guardar. Revisá la conexión y probá de nuevo.';
    }
  }
  function falloGuardar(e, existe) {
    avisar(textoFallo(e, existe));
    pintar();
  }

  // Movimientos de stock: los toques seguidos se juntan y se guardan en una sola escritura por producto.
  const cola = new Map();   // id → { pend, reloj, vuelo, cadena }
  function colaDe(id) {
    let q = cola.get(id);
    if (!q) { q = { pend: null, reloj: 0, vuelo: null, cadena: Promise.resolve(true) }; cola.set(id, q); }
    return q;
  }
  function enCola(id, fn) {
    const q = colaDe(id), r = q.cadena.then(fn);
    q.cadena = r.then(() => true, () => false);
    return r;
  }
  // El producto como se muestra: lo guardado, más lo que está viajando, más lo que todavía no salió.
  function verProd(id) {
    const b = E.prod.get(id);
    if (!b) return null;
    const q = cola.get(id);
    if (!q || (!q.vuelo && !q.pend)) return b;
    let p = q.vuelo ? { ...b, ...q.vuelo } : b;
    if (q.pend) p = { ...p, ...N.aplicarMovs(p, q.pend.movs, hoyDia(), q.pend.precio) };
    return p;
  }
  function mover(id, mov, precio, ya) {
    const q = colaDe(id);
    if (!q.pend) q.pend = { movs: [], precio: null };
    const dia = mov.dia == null ? null : mov.dia;
    const igual = q.pend.movs.find(m => m.dia === dia);
    if (igual) { igual.u += mov.u || 0; igual.c += mov.c || 0; }
    else q.pend.movs.push({ dia, u: mov.u || 0, c: mov.c || 0 });
    if (precio) q.pend.precio = precio;
    clearTimeout(q.reloj);
    if (ya) return volcar(id);
    q.reloj = setTimeout(() => volcar(id), 800);
    pintar();
    return null;
  }
  function volcar(id) {
    const q = colaDe(id);
    clearTimeout(q.reloj);
    q.cadena = q.cadena.then(async () => {
      const pend = q.pend;
      q.pend = null;
      if (!pend) return true;
      const base = E.prod.get(id);
      if (!base || !E.db) return false;
      const campos = N.aplicarMovs(base, pend.movs, hoyDia(), pend.precio);
      if (campos.stock === (+base.stock || 0) && campos.precio === undefined && JSON.stringify(campos.log) === JSON.stringify(base.log || [])) { pintar(); return true; }
      if (Datos.mover) {       // suma «uno menos» en vez de escribir «quedan 3», y ya lo muestra él
        try { await escribir(() => Datos.mover(id, pend.movs, pend.precio)); return true; }
        catch (e) { falloGuardar(e, E.prod.has(id)); return false; }
        finally { pintar(); }
      }
      campos.act = new Date().toISOString();
      q.vuelo = campos;
      try {
        await escribir(() => E.db.doc('productos/' + id).update(campos));
        const actual = E.prod.get(id);
        if (actual) E.prod.set(id, { ...actual, ...campos });
        return true;
      } catch (e) { falloGuardar(e, E.prod.has(id)); return false; }
      finally { q.vuelo = null; pintar(); }
    });
    return q.cadena;
  }

  async function crearProducto(d, diaCompra) {
    const hoyI = N.hoyISO(), hd = N.diaDe(hoyI), dia = diaCompra == null ? hd : diaCompra;
    const stock = Math.max(0, Math.round(+d.stock || 0));
    const precio = d.precio > 0 ? N.redondear2(d.precio) : null, fechaPrecio = precio ? (d.precioFecha || hoyI) : null;
    const doc = {
      nombre: d.nombre, marca: d.marca || '', presentacion: d.presentacion || '',
      categoria: N.CATS_ALACENA.includes(d.categoria) ? d.categoria : 'otros', codigo: d.codigo || '',
      stock, aviso: Math.max(0, Math.round(+d.aviso || 0)), reponer: d.reponer !== false,
      precio, precioFecha: fechaPrecio, precioAnt: null,
      px: precio ? [[N.diaDe(fechaPrecio), precio, limpio(d.comercio).slice(0, 60), String(d.ref || '')]] : [],
      log: stock > 0 && dia > hd - 200 && dia <= hd + 1 ? [[dia, 0, stock]] : [], creado: new Date().toISOString(),
    };
    if (d.marcaFija) doc.marcaFija = true;
    if (d.pedido > 0) doc.pedido = d.pedido;
    if (d.suelto) doc.suelto = true;
    if (d.porKg) doc.porKg = true;
    if (d.diario === true || d.diario === false) doc.diario = d.diario;
    const ref = E.db.collection('productos').doc();
    await escribir(() => ref.set(doc));
    if (!E.prod.has(ref.id)) E.prod.set(ref.id, doc);
    return ref.id;
  }

  /* ---------- ejemplos ----------
     Los datos de muestra llevan `ejemplo: true`. Se dejan de mostrar apenas hay un dato propio y se borran. */
  function hayReales() {
    for (const p of E.prod.values()) if (!p.ejemplo) return true;
    return E.tickets.some(t => !t.ejemplo);
  }
  function hayEjemplos() {
    for (const p of E.prod.values()) if (p.ejemplo) return true;
    return E.tickets.some(t => t.ejemplo);
  }
  function prodReales() {
    const out = [];
    for (const [id, p] of E.prod) if (!p.ejemplo) out.push([id, p]);
    return out;
  }
  // `avisa`: 'todo' cuenta cómo terminó · 'fallo' solo si no pudo · 'nada' trabaja en silencio
  async function borrarEjemplos(avisa) {
    if (E.borrandoEj || !E.db) return;
    E.borrandoEj = true;
    let fallo = false;
    try {
      for (const id of [...E.prod].filter(x => x[1].ejemplo).map(x => x[0])) {
        await enCola(id, () => escribir(() => E.db.doc('productos/' + id).delete()));
        E.prod.delete(id); cola.delete(id);
        await pausa(Datos.respiro);
      }
      for (const id of E.tickets.filter(t => t.ejemplo).map(t => t.id)) {
        await escribir(() => E.db.doc('tickets/' + id).delete());
        E.tickets = E.tickets.filter(t => t.id !== id);
        await pausa(Datos.respiro);
      }
    } catch (e) { fallo = true; }
    E.borrandoEj = false;
    pintar();
    if (fallo) { if (avisa !== 'nada') avisar('No se pudieron borrar todos los ejemplos. Probá de nuevo desde Ajustes.'); }
    else if (avisa === 'todo') avisar('Se borraron los datos de ejemplo.');
  }
  function trasGuardarPropio() { if (hayEjemplos()) borrarEjemplos('fallo'); }
  // Si una visita anterior se cerró mientras se borraban los ejemplos, acá se terminan de borrar.
  let restosVistos = false;
  function borrarRestos() {
    if (restosVistos || !E.prodListo || !E.ticListo || !E.permisoSabido || E.lectura) return;
    restosVistos = true;
    if (hayReales() && hayEjemplos()) borrarEjemplos('nada');
  }

  /* ---------- conexión con los datos ---------- */
  const reintentos = {};
  function suscribir() {
    const db = E.db;
    const alFallar = (nombre, otraVez) => e => {
      reintentos[nombre] = (reintentos[nombre] || 0) + 1;
      if (e && e.code === 'unavailable' && reintentos[nombre] <= 3) { setTimeout(otraVez, 2500 * reintentos[nombre]); return; }
      E.conexion = 'sin'; E.motivo = (e && e.texto) || ''; pintar();
    };
    const productos = () => db.collection('productos').limit(1000).onSnapshot(s => {
      const m = new Map();
      for (const d of s.docs) { const x = d.data(); if (x) m.set(d.id, x); }
      E.prod = m; E.conexion = 'lista';
      if (s.metadata && s.metadata.fromCache && s.empty && !E.prodListo) setTimeout(() => { E.prodListo = true; pintar(); }, 4000);
      else { E.prodListo = true; borrarRestos(); }
      pintar();
    }, alFallar('productos', productos));
    const tickets = () => db.collection('tickets').orderBy('fecha', 'desc').limit(1000).onSnapshot(s => {
      E.tickets = s.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
      if (s.metadata && s.metadata.fromCache && s.empty && !E.ticListo) setTimeout(() => { E.ticListo = true; pintar(); }, 4000);
      else { E.ticListo = true; borrarRestos(); }
      pintar();
    }, alFallar('tickets', tickets));
    const ajustes = () => db.doc('ajustes/hogar').onSnapshot(s => {
      if (!s.exists) return;
      E.ajustes = leerAjustes(s.data() || {});
      pintar();
    }, alFallar('ajustes', ajustes));
    productos(); tickets(); ajustes();
  }
  async function iniciar() {
    Lector.iniciar(() => { if (E.hoja && E.hoja.estado === 'espera') renderHoja(); });
    let c = null;
    try { c = await Datos.conectar(); } catch (e) { c = null; }
    if (c && c.puerta) {       // todavía no se entró a ningún hogar: se muestra la entrada y se espera
      const estado = Datos.hogar.estado();
      E.puerta = {
        modo: estado === 'sin-usuario' && !leerLocal('libreta.tutorial', false) ? 'tutorial' : 'inicio', paso: 0,
        nombre: Datos.hogar.nombreSugerido(), codigo: conGuion(codigoEnlace), error: '', errorBuscar: '', ocupado: false, buscando: false,
        aviso: Datos.hogar.aviso(), diag: null,
      };
      codigoEnlace = '';
      render();
      if (estado === 'sin-hogar') buscarHogar();      // ya hay una cuenta abierta: se busca su hogar
      c = await c.alEntrar;
      const recien = E.puerta.creado, aviso = Datos.hogar.aviso();
      E.puerta = null;
      render();
      if (aviso) avisar(aviso); else if (recien) abrirHoja({ tipo: 'bienvenida' });
    } else if (codigoEnlace) { codigoEnlace = ''; avisar('Ya estás en un hogar. Para entrar a otro, primero salí de este desde Ajustes.'); }
    if (!c || !c.db) { E.conexion = 'sin'; pintar(); return; }
    E.db = c.db;
    if (Datos.hogar && Datos.hogar.anterior) E.anterior = Datos.hogar.anterior();
    Promise.resolve(c.permiso).then(p => {
      if (p === false) E.lectura = true;
      if (p === true || p === false) E.permisoSabido = true;
      borrarRestos();
      pintar();
    }, () => {});
    suscribir();
  }

  /* ---------- pintar ---------- */
  let pendiente = false;
  function pintar() {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => { pendiente = false; render(); });
  }
  function calcular() {
    const propios = hayReales(), prods = [];
    for (const id of E.prod.keys()) {
      const p = verProd(id);
      if (p && !(propios && p.ejemplo)) prods.push([id, p]);
    }
    const tickets = propios ? E.tickets.filter(t => !t.ejemplo) : E.tickets;
    const hoy = hoyDia(), frec = E.ajustes.frecuencia, pres = E.ajustes.presupuesto, compras = N.listaCompras(prods, hoy, frec);
    const gastado = pres > 0 ? (N.totalesPorMes(tickets).get(N.mesDe(N.hoyISO())) || 0) : 0;
    // los precios de la zona, con el nombre que este hogar le da a cada comercio y cuáles son suyos
    const cerca = new Map();
    for (const [id, l] of E.cerca.porId) { const p = verProd(id); if (p && l.length) cerca.set(id, deLaZona(p, l)); }
    const plan = A.plan(compras, { hoy, frec, productos: prods, cerca, presupuesto: pres, gastado, resto: pres > 0 ? pres - gastado : null });
    V = { prods, tickets, compras, plan, cerca };
  }
  function render() {
    document.documentElement.classList.toggle('en-puerta', !!E.puerta);
    $('#puerta').hidden = !E.puerta;
    if (E.puerta) { renderPuerta(); return; }
    calcular();
    document.documentElement.classList.toggle('solo-lectura', E.lectura || E.conexion === 'sin');
    renderAvisos();
    pintarSinc();
    for (const a of $$('.pestanas a')) { if (a.dataset.tab === E.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    const globo = $('#globo-compras');
    globo.hidden = !V.compras.length;
    globo.textContent = V.compras.length;
    for (const t of TABS) $('#tab-' + t).hidden = t !== E.tab;
    if (E.tab === 'alacena') renderAlacena(); else if (E.tab === 'compras') renderCompras(); else if (E.tab === 'gastos') renderGastos(); else renderNovedades();
    pintarGloboNovedades();
    pintarNotas();
    revisarCerca();
  }
  function renderAvisos() {
    const partes = [];
    if (E.conexion === 'sin') partes.push(h`<div class="aviso aviso-rojo"><p><strong>No hay conexión con los datos guardados.</strong> ${E.motivo || Datos.textos.sinConexion}</p></div>`);
    else if (E.lectura) partes.push(h`<div class="aviso"><p><strong>Solo lectura.</strong> Podés ver la libreta, pero no modificarla.</p></div>`);
    // las notas del hogar que todavía no se leyeron en este teléfono
    for (const n of notasSinLeer().slice(0, 2)) {
      partes.push(h`<button type="button" class="aviso aviso-nota" data-act="notas">${ico('nota')}<p><strong>${n.nombre || 'Alguien'}:</strong> ${n.texto.length > 90 ? n.texto.slice(0, 88).trimEnd() + '…' : n.texto} <span class="tenue">· ${quedaTexto(n)}</span></p></button>`);
    }
    if (E.anterior && E.conexion !== 'sin') {
      const a = E.anterior, cuanto = [a.productos ? `${a.productos} ${N.plural(a.productos, 'producto', 'productos')}` : '', a.tickets ? `${a.tickets} ${N.plural(a.tickets, 'gasto', 'gastos')}` : ''].filter(Boolean).join(' y ');
      partes.push(a.confirmar
        ? h`<div class="aviso aviso-ejemplo"><p><strong>¿Descartar esos datos?</strong> Se borran de este teléfono y no se pueden recuperar.</p>
          <div class="acciones"><button type="button" class="btn btn-chico" data-act="anterior-volver">No</button><button type="button" class="btn btn-chico btn-peligro" data-act="anterior-descartar">Sí, descartar</button></div></div>`
        : h`<div class="aviso aviso-ejemplo"><p><strong>En este teléfono hay datos de la libreta anterior:</strong> ${cuanto}. ¿Los traés a este hogar?</p>
          <div class="acciones"><button type="button" class="btn btn-chico" data-act="anterior-no"${atr('disabled', a.ocupado)}>Descartarlos</button><button type="button" class="btn btn-chico btn-principal" data-act="anterior-si"${atr('disabled', a.ocupado)}>${a.ocupado ? 'Trayendo…' : 'Traerlos'}</button></div></div>`);
    }
    if (!Datos.persistente) partes.push(h`<div class="aviso aviso-rojo"><p><strong>Este navegador no deja guardar datos.</strong> Lo que cargues se pierde al cerrar la página.</p></div>`);
    if (hayEjemplos() && !hayReales()) {
      partes.push(h`<div class="aviso aviso-ejemplo"><p><strong>Datos de ejemplo</strong>, para ver cómo funciona. Se borran solos cuando cargues tu primer producto o ticket.</p>
        <button type="button" class="enlace" data-act="borrar-ejemplos" data-escribe${atr('disabled', E.borrandoEj)}>Borrar ahora</button></div>`);
    }
    $('#avisos').innerHTML = val(partes);
  }
  const cargando = texto => h`<p class="cargando"><span class="giro"></span>${texto}</p>`;

  /* ---------- la entrada: tutorial, cuenta de Google y hogar ---------- */
  let codigoEnlace = '';       // el código que vino en la dirección (#unir=…), si vino
  const soloCodigo = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const conGuion = c => { const v = soloCodigo(c); return v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v; };
  const listaDiag = pasos => h`<ul class="diag">${pasos.map(p => h`<li class="${p.ok ? 'bien' : 'mal'}"><strong>${p.ok ? '✓' : '✗'} ${p.nombre}</strong>${p.detalle ? h` — ${p.detalle}` : ''}${p.crudo ? h`<code>${p.crudo}</code>` : ''}</li>`)}</ul>`;
  // Lo que se cuenta la primera vez (y cuando se lo pide desde Ajustes).
  const TUTORIAL_BASE = [
    ['compras', 'Tu lista de compras, sola', 'Cargá lo que hay en casa escaneando el código de barras. La libreta aprende cada cuánto comprás cada cosa y arma la lista: la de la compra grande y la del día a día. Si querés más precisión, tocá − cuando se termina algo; no hace falta.'],
    ['escanear', '¿Está a buen precio?', 'En el súper, tocá «Comparar precio» en Compras y escaneá el producto: ves al instante cuánto lo pagaste la última vez y si cerca está más barato. Con un toque anotás el precio, lo lleves o no.'],
    ['familia', 'Toda la familia en el mismo hogar', 'Cada persona entra con su cuenta de Google y se suma con un código. Lo que anota uno lo ven todos al instante. Antes de salir, «Aviso que voy» le pregunta a la familia si falta algo.'],
    ['gastos', 'Cuánto gastás y cuánto ahorrás', 'Cada compra queda anotada en Gastos: cuánto se va por mes, en qué y cuánto subió cada cosa. Y en Ofertas, cuánto ahorraste gracias a otros hogares.'],
  ];
  // Con el mapa encendido hay un paso más: la comunidad de hogares de la zona.
  const PASO_ZONA = ['mapa', 'Una comunidad de hogares', 'Avisá un precio de lo que sea y aparece al instante en el mapa del barrio; confirmá con un toque los que cargaron otros. La libreta te avisa si otro hogar consiguió más barato lo que comprás, y dónde. También ves los precios oficiales de los supermercados y las promos del día con tu banco o billetera. Compartir es optativo: va con el nombre que elijas para tu hogar, nunca con el tuyo.'];
  // Con la IA encendida, otro: las ideas para cocinar y la foto de las promos.
  const PASO_IA = ['olla', 'Ideas con inteligencia artificial', '¿No sabés qué cocinar? «¿Qué cocino?», en la Alacena, te propone comidas con lo que tenés y anota en la lista lo poco que falte. Y si ves un cartel de promo, sacale una foto: la IA la completa sola y la compartís con tu zona.'];
  function pasosTutorial() {
    const l = conMapa() ? [TUTORIAL_BASE[0], TUTORIAL_BASE[1], PASO_ZONA, TUTORIAL_BASE[2], TUTORIAL_BASE[3]] : TUTORIAL_BASE.slice();
    if (hayIA()) l.splice(l.length - 1, 0, PASO_IA);
    return l;
  }
  const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  function vistaTutorial(paso, acciones) {
    const TUTORIAL = pasosTutorial(), [icono, titulo, texto] = TUTORIAL[Math.max(0, Math.min(TUTORIAL.length - 1, paso))];
    return h`<div class="tutorial" id="tutorial"><div class="tut-ico">${ico(icono)}</div>
      <h2 class="tut-titulo">${titulo}</h2><p class="tut-texto">${texto}</p>
      <p class="tut-puntos" role="img" aria-label="Paso ${paso + 1} de ${TUTORIAL.length}">${TUTORIAL.map((x, i) => h`<i${atr('class="aca"', i === paso)}></i>`)}</p>
      ${acciones}</div>`;
  }
  const botonGoogle = ocupado => h`<button type="button" class="btn-google" data-act="puerta-google"${atr('disabled', ocupado)}>
    <svg class="ico-google" aria-hidden="true"><use href="#i-google"/></svg><span>${ocupado ? 'Esperando a Google…' : 'Continuar con Google'}</span></button>`;
  function renderPuerta() {
    const P = E.puerta, estado = Datos.hogar.estado(), yo = Datos.hogar.yo();
    const error = P.error ? h`<p class="error" role="alert">${P.error}</p>` : '';
    const nombre = campo('¿Cómo te llaman en casa?', h`<input type="text" id="pu-nombre" data-p="nombre" value="${P.nombre}" maxlength="40" autocomplete="off">`, 'Así te van a ver los demás integrantes del hogar.');
    let titulo = 'Tu hogar', bajada = 'La alacena, las compras y los gastos de casa, compartidos con tu familia: lo que anota uno lo ven todos.', cuerpo, pie = true;
    if (estado === 'config') {
      cuerpo = h`<div class="nota"><p><strong>Falta conectar la libreta con Firebase.</strong> En el archivo <code>config.js</code> tiene que estar el bloque <code>firebaseConfig</code> de tu proyecto, como indica la guía. Completalo, subilo de nuevo y recargá esta página.</p></div>`;
    } else if (estado === 'red') {
      cuerpo = h`<div class="nota"><p><strong>No se pudo llegar al servidor.</strong> La primera vez hace falta conexión a internet. Revisala y probá de nuevo.</p></div>
        <div class="elegir"><button type="button" class="btn btn-principal btn-grande" data-act="puerta-recargar">Probar de nuevo</button></div>`;
    } else if (P.modo === 'tutorial') {
      const ultimo = P.paso >= pasosTutorial().length - 1;
      titulo = ''; bajada = ''; pie = false;
      cuerpo = vistaTutorial(P.paso, h`<div class="hoja-pie"><button type="button" class="btn" data-act="tutorial-saltar">Saltar</button>
        <button type="button" class="btn btn-principal" data-act="tutorial-sigue">${ultimo ? 'Empezar' : 'Siguiente'}</button></div>`);
    } else if (!yo) {
      cuerpo = h`${error}<div class="elegir">${botonGoogle(P.ocupado)}</div>
        <p class="tenue chico">La libreta solo toma tu nombre y tu email, para reconocerte en cualquier teléfono. ${soloCodigo(P.codigo).length === 8 ? 'Después de entrar se usa el código de la invitación.' : '¿Te invitaron a un hogar? Entrá primero con tu cuenta y después ponés el código.'}</p>
        <p class="tenue chico" id="pu-legal">Al continuar aceptás las <a href="privacidad.html#condiciones" target="_blank" rel="noopener">condiciones de uso</a> y la <a href="privacidad.html" target="_blank" rel="noopener">política de privacidad</a>.</p>
        <button type="button" class="enlace" data-act="tutorial-ver">Ver cómo funciona</button>`;
    } else if (P.buscando) {
      cuerpo = cargando('Buscando tu hogar…');
    } else if (P.errorBuscar) {
      cuerpo = h`<p class="error" role="alert">${P.errorBuscar}</p>
        <div class="elegir"><button type="button" class="btn btn-principal btn-grande" data-act="puerta-buscar">Probar de nuevo</button></div>`;
    } else if (P.modo === 'crear') {
      cuerpo = h`<form class="form" data-form="puerta-crear" novalidate>
        <p>Vas a crear un hogar nuevo, vacío. Después sumás al resto de la familia con un código.</p>
        ${nombre}${error}
        <div class="hoja-pie"><button type="button" class="btn" data-act="puerta-volver"${atr('disabled', P.ocupado)}>Volver</button>
          <button type="submit" class="btn btn-principal"${atr('disabled', P.ocupado)}>${P.ocupado ? 'Creando…' : 'Crear el hogar'}</button></div></form>`;
    } else if (P.modo === 'unirse') {
      cuerpo = h`<form class="form" data-form="puerta-unirse" novalidate>
        ${campo('Código del hogar', h`<input type="text" class="codigo-campo" id="pu-codigo" data-p="codigo" value="${P.codigo}" maxlength="9" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCD-2345">`,
          'Te lo da alguien que ya está en el hogar: Ajustes → Sumar a alguien.')}
        ${nombre}${error}
        <div class="hoja-pie"><button type="button" class="btn" data-act="puerta-volver"${atr('disabled', P.ocupado)}>Volver</button>
          <button type="submit" class="btn btn-principal"${atr('disabled', P.ocupado)}>${P.ocupado ? 'Entrando…' : 'Entrar al hogar'}</button></div></form>`;
    } else if (P.modo === 'borrar') {
      cuerpo = h`<div class="nota"><p><strong>¿Borrar tu cuenta de la libreta?</strong> Se borra lo que la libreta tiene anotado de vos. Google te va a pedir que entres una vez más para confirmar que sos vos.</p>${error}
        <div class="acciones"><button type="button" class="btn btn-chico" data-act="puerta-volver"${atr('disabled', P.ocupado)}>No</button>
          <button type="button" class="btn btn-chico btn-peligro" data-act="puerta-borrar-si"${atr('disabled', P.ocupado)}>${P.ocupado ? 'Borrando…' : 'Sí, borrar mi cuenta'}</button></div></div>`;
    } else {
      titulo = `Hola, ${yo.nombre || 'bienvenida'}`; bajada = 'Todavía no estás en ningún hogar.';
      cuerpo = h`${error}<div class="elegir">
          <button type="button" class="btn btn-principal btn-grande" data-act="puerta-crear">Crear un hogar nuevo</button>
          <button type="button" class="btn btn-grande" data-act="puerta-unirse">Tengo un código</button></div>
        <p class="tenue chico">¿Ya usan la libreta en casa? Pedile un código a alguien que ya esté adentro: Ajustes → Sumar a alguien.</p>`;
    }
    const cuenta = yo && estado !== 'config' && estado !== 'red' && P.modo !== 'borrar' && !P.buscando
      ? h`<div class="cuenta-de"><span>Entraste como <strong>${yo.email || yo.nombre}</strong></span>
          <span class="enlaces"><button type="button" class="enlace" data-act="puerta-salir">Salir de la cuenta</button><button type="button" class="enlace rojo" data-act="puerta-borrar">Borrar mi cuenta</button></span></div>` : '';
    $('#puerta').innerHTML = val(h`<div class="puerta-caja">
      ${titulo ? h`<h1>${titulo}</h1>` : ''}
      ${bajada ? h`<p class="puerta-bajada">${bajada}</p>` : ''}
      ${P.aviso ? h`<p class="nota gris">${P.aviso}</p>` : ''}
      ${cuerpo}
      ${cuenta}
      ${!pie ? '' : P.diag === 'corriendo' ? cargando('Probando la conexión…') : h`${P.diag ? listaDiag(P.diag) : ''}<button type="button" class="enlace" data-act="puerta-diagnostico">${P.diag ? 'Probar la conexión de nuevo' : 'Probar la conexión con el servidor'}</button>`}
    </div>`);
  }
  // La prueba de conexión: lo de Firebase y, al final, si el mapa carga y si se pueden leer los precios de la zona.
  async function diagnosticar() {
    const pasos = await Datos.hogar.diagnostico().catch(() => []);
    if (!C || !pasos.length || pasos.some(x => !x.ok)) return pasos;
    if (!C.conMapa()) pasos.push({ nombre: 'Mapa', ok: true, detalle: 'apagado en config.js: los comercios se anotan a mano y no hay precios de la zona', crudo: '' });
    else {
      try { await C.probar(); pasos.push({ nombre: 'Mapa', ok: true, detalle: 'carga (OpenStreetMap)', crudo: '' }); }
      catch (e) { pasos.push({ nombre: 'Mapa', ok: false, detalle: (e && e.texto) || 'no cargó', crudo: (e && e.crudo) || '' }); return pasos; }
      if (Datos.precios && Datos.hogar.yo()) {
        try { await Datos.precios.buscar(['0x0_00000000']); pasos.push({ nombre: 'Precios de la zona', ok: true, detalle: 'se pueden leer', crudo: '' }); }
        catch (e) {
          const crudo = String((e && (e.code || e.message)) || '');
          pasos.push({ nombre: 'Precios de la zona', ok: false, crudo, detalle: /permission-denied/.test(crudo) ? 'Firebase no deja leerlos: falta publicar las reglas nuevas (el archivo firestore.rules).' : 'No se pudieron leer. Revisá la conexión.' });
        }
      }
    }
    return pasos;
  }
  // Con la cuenta ya abierta: ¿en qué hogar está? Si está en uno, se entra directo.
  async function buscarHogar() {
    const P = E.puerta;
    if (!P || P.buscando) return;
    Object.assign(P, { buscando: true, errorBuscar: '', error: '' });
    render();
    try {
      const entro = await Datos.hogar.recuperar();
      if (entro || E.puerta !== P) return;
      Object.assign(P, { buscando: false, modo: soloCodigo(P.codigo).length === 8 ? 'unirse' : 'inicio', nombre: Datos.hogar.nombreSugerido() });
    } catch (e) {
      if (E.puerta !== P) return;
      Object.assign(P, { buscando: false, errorBuscar: (e && e.texto) || 'No se pudo buscar tu hogar. Probá de nuevo.' });
    }
    render();
    if (P.modo === 'unirse') { const c = $('#pu-codigo'); if (c) c.focus(); }
  }
  async function entrarPorLaPuerta(crear) {
    const P = E.puerta;
    if (!P || P.ocupado) return;
    if (!crear && soloCodigo(P.codigo).length !== 8) { P.error = 'El código tiene 8 letras y números. Revisalo.'; render(); const c = $('#pu-codigo'); if (c) c.focus(); return; }
    P.ocupado = true; P.error = ''; P.aviso = ''; render();
    try {
      if (crear) { P.creado = true; await Datos.hogar.crear(P.nombre); } else await Datos.hogar.unirse(P.codigo, P.nombre);
    } catch (e) {
      if (E.puerta !== P) return;
      P.creado = false; P.ocupado = false; P.error = (e && e.texto) || 'No se pudo. Probá de nuevo.'; render();
    }
  }

  /* ---------- hogar compartido: cómo viene la sincronización ---------- */
  let sincDesde = 0, relojSinc = 0;
  function pintarSinc() {
    const el = $('#sinc');
    if (!el) return;
    const st = Datos.hogar && !E.puerta && E.conexion === 'lista' ? Datos.hogar.sinc() : null;
    const texto = !st || (st.enLinea && !st.pendiente) ? '' : !st.enLinea ? (st.pendiente ? 'Sin conexión · hay cambios por enviar' : 'Sin conexión') : 'Enviando cambios…';
    clearTimeout(relojSinc);
    if (!texto) { sincDesde = 0; el.hidden = true; return; }
    // solo se muestra si dura: un cambio que sube enseguida o el arranque no hacen parpadear el cartel
    if (!sincDesde) sincDesde = Date.now();
    const falta = 2500 - (Date.now() - sincDesde);
    if (falta > 0 && el.hidden) { relojSinc = setTimeout(pintarSinc, falta + 20); return; }
    el.textContent = texto; el.hidden = false;
    el.classList.toggle('sin-red', !st.enLinea);
  }

  function irA(tab) {
    if (!TABS.includes(tab)) tab = 'alacena';
    const cambio = tab !== E.tab;
    E.tab = tab;
    try { history.replaceState(null, '', '#' + tab); } catch (e) { /* sin historial, no importa */ }
    render();
    if (cambio) window.scrollTo(0, 0);
  }

  /* ---------- ajustes del hogar ---------- */
  function leerAjustes(d) {
    const comercios = {};
    for (const k in esObjeto(d.comercios) ? d.comercios : {}) {
      const c = d.comercios[k];
      if (!esObjeto(c) || typeof c.n !== 'string' || !c.n) continue;
      comercios[k] = A.puntoValido(c.la, c.lo) ? { n: c.n, la: c.la, lo: c.lo } : { n: c.n };      // dónde queda: es un comercio, no una casa
      if (typeof c.p === 'string' && c.p) comercios[k].p = c.p.slice(0, 60);                      // y cómo se llama de verdad
    }
    return {
      frecuencia: N.FRECUENCIAS.includes(d.frecuencia) ? d.frecuencia : 7, presupuesto: +d.presupuesto > 0 ? +d.presupuesto : 0,
      compartir: d.compartir === true ? true : d.compartir === false ? false : null, comercios,
      alias: typeof d.alias === 'string' ? d.alias.slice(0, 40) : '', avisos: d.avisos === true,
      ahorroDias: esObjeto(d.ahorroDias) ? Object.fromEntries(Object.entries(d.ahorroDias).filter(([k, v]) => /^\d{4,6}$/.test(k) && +v > 0).map(([k, v]) => [k, +v])) : {},
      aportes: esObjeto(d.aportes) ? Object.fromEntries(Object.entries(d.aportes).filter(([m, v]) => /^\d{4}-\d{2}$/.test(m) && +v > 0).map(([m, v]) => [m, Math.round(+v)])) : {},
      ahorro: esObjeto(d.ahorro) ? Object.fromEntries(Object.entries(d.ahorro).filter(([m, v]) => /^\d{4}-\d{2}$/.test(m) && +v > 0).map(([m, v]) => [m, +v])) : {},
    };
  }
  let colaAjustes = Promise.resolve();   // una escritura por vez sobre el documento de ajustes
  function cambiarAjustes(cambios) {
    const antes = E.ajustes, nuevo = Object.assign({}, antes, cambios);
    E.ajustes = nuevo;
    const doc = { frecuencia: nuevo.frecuencia, presupuesto: nuevo.presupuesto };      // lo que nunca se usó no se guarda
    if (nuevo.compartir != null) doc.compartir = nuevo.compartir;
    if (nuevo.alias || antes.alias) doc.alias = nuevo.alias || '';
    if (nuevo.avisos) doc.avisos = true;           // alguien del hogar activó las notificaciones: vale la pena anotar lo que pasa
    if (Object.keys(nuevo.ahorro || {}).length) doc.ahorro = nuevo.ahorro;
    if (Object.keys(nuevo.ahorroDias || {}).length) doc.ahorroDias = nuevo.ahorroDias;
    if (Object.keys(nuevo.aportes || {}).length) doc.aportes = nuevo.aportes;
    if (Object.keys(nuevo.comercios).length || Object.keys(antes.comercios).length) doc.comercios = nuevo.comercios;
    const r = colaAjustes.then(() => escribir(() => E.db.doc('ajustes/hogar').set(doc)));
    colaAjustes = r.catch(() => {});
    return r;
  }

  /* ---------- comercios ----------
     En cada compra el comercio es un texto: el nombre que el hogar le da («Día», «el chino de la vuelta»).
     Si además se lo ubicó en el mapa, en los ajustes del hogar queda qué comercio es: comercios.<id> = { n: ese nombre },
     con el identificador de OpenStreetMap ('osm:n123') o el de uno que marcó algún hogar ('com:…'). */
  const ultimoComercio = () => { const v = leerLocal('libreta.comercio', ''); return typeof v === 'string' ? v : ''; };
  const recordarComercio = n => { if (n) guardarLocal('libreta.comercio', n); };
  function comerciosConocidos() {
    const m = new Map(), poner = n => { const t = limpio(n), k = N.norm(t); if (t && k && t !== 'Compra' && !m.has(k)) m.set(k, t); };
    for (const k in E.ajustes.comercios) poner(E.ajustes.comercios[k].n);
    for (const t of V.tickets) poner(t.comercio);
    for (const par of V.prods) for (const e of N.precios(par[1])) poner(e[2]);
    return [...m.values()];
  }
  function pintarComercios() {
    const dl = $('#lista-comercios');
    if (dl) dl.innerHTML = val(comerciosConocidos().slice(0, 40).map(n => h`<option value="${n}"></option>`));
  }
  // El comercio del mapa que el hogar anotó con ese nombre, o ''.
  function refDeComercio(nombre) {
    const k = N.norm(nombre);
    if (!k) return '';
    for (const id in E.ajustes.comercios) if (N.norm(E.ajustes.comercios[id].n) === k) return id;
    return '';
  }
  const nombreDeRef = ref => (ref && E.ajustes.comercios[ref] ? E.ajustes.comercios[ref].n : '');
  // Lo que el hogar sabe de un comercio para compartir un precio: dónde queda y su nombre de verdad (o null).
  function lugarDe(ref) {
    const c = ref && E.ajustes.comercios[ref];
    return c && A.puntoValido(c.la, c.lo) && c.p ? { lat: c.la, lon: c.lo, nombre: c.p } : null;
  }
  // Dónde queda un comercio del hogar: lo anotado en el hogar o, si no, lo que sepa el mapa.
  function ubicacionDe(ref) {
    const c = ref && E.ajustes.comercios[ref];
    return c && A.puntoValido(c.la, c.lo) ? Promise.resolve({ lat: c.la, lon: c.lo }) : C.ubicacion(ref);
  }
  const precioDe = (valor, comercio, fecha) => { const n = limpio(comercio).slice(0, 60), o = { valor, comercio: n, ref: refDeComercio(n) }; if (fecha) o.fecha = fecha; return o; };
  const conMapa = () => !!(C && C.conMapa());
  // Cada cuánto se hacen las compras: cómo se dice en los botones y hasta cuándo alcanza lo que se lleva.
  const FREC_BOTON = { 1: 'A diario', 3: '2–3 días', 7: 'Semana', 15: 'Quincena', 30: 'Mes' };
  const FREC_HASTA = { 1: 'hoy y mañana', 3: 'los próximos días', 7: 'la semana', 15: 'la quincena', 30: 'el mes' };
  const botonesFrec = (act, actual) => N.FRECUENCIAS.map(d => h`<button type="button" data-act="${act}" data-frec="${d}" aria-pressed="${String(actual === d)}">${FREC_BOTON[d]}</button>`);
  /* ---------- aportes voluntarios ----------
     Si config.js trae `aportes` (un link de pago de Mercado Pago y/o un alias), Ajustes invita a apoyar la libreta.
     Dentro de la app de Google Play no se muestra: ahí los pagos tienen sus propias reglas. */
  const APORTES = (() => {
    let a = null;
    try { if (typeof aportes !== 'undefined' && aportes && typeof aportes === 'object') a = aportes; } catch (e) { /* config.js no lo trae */ }
    const link = a && typeof a.mercadoPago === 'string' && /^https:\/\/(www\.)?(mpago\.la|mpago\.li|link\.mercadopago\.com\.ar|mercadopago\.com\.ar)\//.test(a.mercadoPago.trim()) ? a.mercadoPago.trim() : '';
    const alias = a && typeof a.alias === 'string' ? a.alias.trim().slice(0, 40) : '';
    return { link, alias, hay: !!(link || alias) };
  })();
  const enPlay = (() => {
    try {
      if (document.referrer.startsWith('android-app://')) sessionStorage.setItem('libreta.play', '1');
      return sessionStorage.getItem('libreta.play') === '1';
    } catch (e) { return false; }
  })();
  function bloqueAportes() {
    if (!APORTES.hay || enPlay) return '';
    return h`<div class="dato aportes"><p class="rotulo">Apoyá la libreta</p>
      <p>La libreta es gratis y sin publicidad. Si te sirve, podés hacer un aporte voluntario, del monto que quieras: ayuda a pagar el servidor y a seguir mejorándola.</p>
      <div class="acciones">${APORTES.link ? h`<a class="btn btn-chico btn-principal" href="${APORTES.link}" target="_blank" rel="noopener">Hacer un aporte</a>` : ''}
        ${APORTES.alias ? h`<button type="button" class="btn btn-chico" data-act="copiar-alias">Copiar el alias</button>` : ''}</div>
      ${APORTES.alias ? h`<p class="tenue chico">Alias de Mercado Pago: <strong>${APORTES.alias}</strong></p>` : ''}</div>`;
  }
  const notaComercio = nombre => (refDeComercio(nombre) ? 'Ubicado en el mapa.' : limpio(nombre) ? 'Tocá el pin para ubicarlo en el mapa.' : '');
  function campoComercio(id, k, valor, rotulo, sugerido) {
    const mapa = conMapa(), ubicado = mapa && !!refDeComercio(valor);
    return h`<div class="campo"><span id="${id}-r">${rotulo || 'Dónde lo compraste'}</span><div class="con-boton">
      <input type="text" id="${id}" data-k="${k}" data-comercio value="${valor}" maxlength="60" autocomplete="off" list="lista-comercios" placeholder="${sugerido || 'Opcional'}" aria-labelledby="${id}-r">
      ${mapa ? h`<button type="button" class="icono-btn borde${ubicado ? ' puesto' : ''}" data-act="elegir-comercio" data-para="${k}" data-campo="${id}" aria-label="Buscar el comercio en el mapa">${ico('lugar')}</button>` : ''}</div>
      ${mapa ? h`<small data-nota-comercio="${id}">${notaComercio(valor)}</small>` : ''}</div>`;
  }

  /* ---------- precios: cuánto cambiaron ---------- */
  // «Última vez $ 1.450 hace 3 días en Día · +10 %», para un precio que se está escribiendo.
  function notaPrecio(id, texto, dia) {
    const p = id ? verProd(id) : null, v = N.aNumero(limpio(texto));
    return p && v > 0 ? A.textoComparar(A.comparar(p, v, dia == null ? hoyDia() : dia)) : '';
  }
  // c: { nombre, marca, pct, antes, ahora, dias, comercio }
  const filaCambio = c => h`<li class="cambio ${c.pct > 0 ? 'sube' : 'baja'}">${ico(c.pct > 0 ? 'sube' : 'baja')}
    <span class="cambio-nombre">${c.nombre}${c.marca ? h` <span class="tenue">· ${c.marca}</span>` : ''}</span><strong class="cambio-pct">${A.pct(c.pct, true)}</strong>
    <span class="cambio-detalle">de ${N.plata(c.antes)} a ${N.plata(c.ahora)}${c.dias != null ? ` · en ${c.dias} ${N.plural(c.dias, 'día', 'días')}` : ''}${c.comercio ? ` · ${c.comercio}` : ''}</span></li>`;
  function bloqueCanasta(inf) {
    if (!inf || inf.pct == null) return '';
    const quieta = Math.abs(inf.pct) < 0.0005;
    return h`<div class="bloque canasta"><h2 class="bloque-t">Tus precios</h2>
      <p class="canasta-pct ${quieta ? '' : inf.pct > 0 ? 'rojo' : 'verde'}">${A.pct(inf.pct, true)}</p>
      <p class="mes-nota">${quieta ? 'Tu canasta no cambió' : inf.pct > 0 ? 'subió tu canasta' : 'bajó tu canasta'} en ${inf.dias} días</p>
      <p class="tenue chico">Sale de los ${inf.n} productos que compraste en este tiempo y ya tenían un precio anterior. Pesan más los que más se consumen en tu casa.</p></div>`;
  }
  // La curva del precio de un producto.
  function chispa(sr) {
    if (!sr || sr.puntos.length < 2) return '';
    const W = 300, Al = 64, m = 7, dx = Math.max(1, sr.hasta - sr.desde), dy = sr.max - sr.min || 1;
    const x = d => (m + (W - 2 * m) * (d - sr.desde) / dx).toFixed(1), y = v => (Al - m - (Al - 2 * m) * (sr.max === sr.min ? 0.5 : (v - sr.min) / dy)).toFixed(1);
    const u = sr.puntos[sr.puntos.length - 1];
    return h`<svg class="chispa" viewBox="0 0 ${W} ${Al}" role="img" aria-label="El precio fue de ${N.plata(sr.puntos[0][1])} a ${N.plata(u[1])}">
        <polyline points="${sr.puntos.map(e => `${x(e[0])},${y(e[1])}`).join(' ')}"/>${sr.puntos.map(e => h`<circle cx="${x(e[0])}" cy="${y(e[1])}" r="2.6"/>`)}<circle class="ult" cx="${x(u[0])}" cy="${y(u[1])}" r="4.2"/></svg>
      <p class="chispa-pie"><span>${N.fechaCorta(N.isoDeDia(sr.desde))} · ${N.plata(sr.puntos[0][1])}</span><span>${N.fechaCorta(N.isoDeDia(sr.hasta))} · ${N.plata(u[1])}</span></p>`;
  }
  // En la ficha del producto: su precio, cuánto cambió, cómo viene y dónde se lo compró.
  function bloquePrecios(id, p) {
    const hoy = hoyDia(), hist = N.precios(p);
    if (!hist.length) return '';
    const v = A.variacion(p), t = A.tendencia(p, hoy), pc = A.porComercio(p, hoy, 90), pu = A.precioUnitario(p), u = hist[hist.length - 1];
    const afuera = (V.cerca.get(id) || []).filter(o => !o.propio && !(p.precio > 0 && o.precio < p.precio * 0.4));      // uno tan barato casi siempre está mal cargado
    return h`<div class="dato precios"><p class="rotulo">Precios</p>
      <p><strong>${N.plata(u[1])}</strong> ${A.haceDias(hoy - u[0])}${u[2] ? ` en ${u[2]}` : ''}${pu ? h` <span class="tenue">· ${pu.texto}</span>` : ''}</p>
      ${v ? h`<p>${v.pct > 0.0005 ? h`<strong class="rojo">Subió ${A.pct(v.pct)}</strong>` : v.pct < -0.0005 ? h`<strong class="verde">Bajó ${A.pct(v.pct)}</strong>` : h`<strong>Mismo precio</strong>`} desde la compra anterior (${N.plata(v.antes)}${v.dias != null ? `, ${v.dias} ${N.plural(v.dias, 'día', 'días')} antes` : ''}).</p>`
        : h`<p class="tenue">Es el único precio anotado: la próxima compra dice cuánto cambió.</p>`}
      ${chispa(A.serie(p))}
      ${t ? h`<p class="tenue">Viene ${t.mensual >= 0 ? 'subiendo' : 'bajando'} <strong>${A.pct(t.mensual)} por mes</strong> (${t.puntos} precios en ${t.dias} días).</p>` : ''}
      ${pc.length ? h`<table class="por-comercio"><caption class="rotulo">Dónde lo compraste</caption>${pc.map(c => h`<tr><th scope="row">${c.comercio}</th><td>${N.plata(c.precio)}</td><td class="tenue">${A.haceDias(hoy - c.dia)}</td></tr>`)}</table>` : ''}
      ${afuera.length ? h`<p class="tenue">En tu zona otros hogares lo pagaron desde <strong>${N.plata(afuera[0].precio)}</strong>${afuera[0].hogar ? ` (${afuera[0].hogar}${afuera[0].comercio ? `, en ${afuera[0].comercio}` : ''})` : afuera[0].comercio ? ` en ${afuera[0].comercio}` : ''}.</p>` : ''}
      ${A.recoTexto(V.cerca.get(id)) ? h`<p class="tenue">${A.recoTexto(V.cerca.get(id))} en tu zona.</p>` : ''}
      ${codigoDe(p) && puedeCerca() ? h`<div class="reco" role="group" aria-label="¿Lo recomendás?"><span>¿Lo recomendás a otros hogares?</span>
        <button type="button" class="chip${p.reco === 1 ? ' puesto' : ''}" data-act="reco" data-id="${id}" data-v="1" aria-pressed="${p.reco === 1 ? 'true' : 'false'}" data-escribe>👍 Sí</button>
        <button type="button" class="chip${p.reco === -1 ? ' puesto' : ''}" data-act="reco" data-id="${id}" data-v="-1" aria-pressed="${p.reco === -1 ? 'true' : 'false'}" data-escribe>👎 No</button></div>` : ''}
      ${puedeCerca() && codigoDe(p) ? h`<button type="button" class="btn btn-chico" data-act="mapa-producto" data-id="${id}">${ico('mapa')}Ver precios en el mapa</button>` : ''}
    </div>`;
  }

  /* ---------- notas del hogar ---------- */
  const DURACIONES = [[1, '1 día'], [3, '3 días'], [7, '1 semana'], [30, '1 mes']];
  const notasActivas = () => (Datos.notas && !E.puerta && E.db ? Datos.notas.lista() : []);
  // Las de otros integrantes que todavía no se abrieron en este teléfono.
  function notasSinLeer() {
    const l = notasActivas();
    if (!l.length) return [];
    const vistas = new Set(leerLocal('libreta.notasVistas', []));
    return l.filter(n => !n.mia && !vistas.has(n.id));
  }
  const marcarNotasLeidas = () => guardarLocal('libreta.notasVistas', notasActivas().map(n => n.id));
  function quedaTexto(n) {
    const hs = (n.hasta - Date.now()) / 36e5;
    if (hs < 1) return 'queda menos de 1 hora';
    if (hs < 20) { const x = Math.max(1, Math.round(hs)); return `${N.plural(x, 'queda', 'quedan')} ${x} ${N.plural(x, 'hora', 'horas')}`; }
    const d = Math.max(1, Math.round(hs / 24));
    return `${N.plural(d, 'queda', 'quedan')} ${d} ${N.plural(d, 'día', 'días')}`;
  }
  function haceTexto(ms) {
    const min = (Date.now() - ms) / 6e4;
    return min < 2 ? 'recién' : min < 60 ? `hace ${Math.round(min)} min` : min < 36 * 60 ? `hace ${Math.round(min / 60)} h` : `hace ${Math.round(min / 1440)} días`;
  }
  function listaNotas() {
    const l = notasActivas();
    if (!l.length) return h`<p class="tenue">No hay notas. Dejá una para avisarle algo a tu familia: se borra sola cuando pasa el tiempo que elijas.</p>`;
    return h`<ul class="notas">${l.map(n => h`<li class="nota-item${n.mia ? ' mia' : ''}"><p class="nota-texto">${n.texto}</p>
      <p class="nota-pie"><span>${n.mia ? 'Vos' : (n.nombre || 'Alguien')} · ${haceTexto(n.creada)} · ${quedaTexto(n)}</span>
        <button type="button" class="enlace rojo" data-act="nota-borrar" data-id="${n.id}" data-escribe>Borrar</button></p></li>`)}</ul>`;
  }
  // El botón de notas del encabezado y, si la hoja de notas está abierta, su lista.
  function pintarNotas() {
    const b = $('#btn-notas'), g = $('#globo-notas');
    if (!b || !g) return;
    const hay = !!Datos.notas && !E.puerta && !!E.db;
    b.hidden = !hay;
    if (!hay) return;
    const n = notasActivas().length, sin = notasSinLeer().length;
    g.hidden = !n;
    g.textContent = n > 9 ? '9+' : String(n);
    g.classList.toggle('nueva', sin > 0);
    b.setAttribute('aria-label', n ? `Notas del hogar: ${n}${sin ? `, ${sin} sin leer` : ''}` : 'Notas del hogar');
    const H = E.hoja;
    if (H && H.tipo === 'notas' && !H.sub) {
      const l = $('#notas-lista');
      if (l) l.innerHTML = val(listaNotas());
      if (sin) { marcarNotasLeidas(); renderAvisos(); g.classList.remove('nueva'); }
    }
  }
  function bloqueNotas() {
    if (!notasActivas().length) return '';
    return h`<div class="bloque notas-bloque"><h2 class="bloque-t">Notas del hogar</h2>${listaNotas()}
      <button type="button" class="enlace" data-act="notas" data-escribe>Dejar una nota</button></div>`;
  }
  async function guardarNota() {
    const H = E.hoja;
    if (!H || H.tipo !== 'notas' || H.ocupado || !puede()) return;
    if (!limpio(H.texto)) return errorHoja('Escribí algo en la nota.', 'nota-texto');
    H.ocupado = true; H.error = '';
    try { await Datos.notas.agregar(H.texto, H.dias); }
    catch (e) { if (E.hoja === H) errorHoja((e && e.texto) || textoFallo(e), 'nota-texto'); return; }
    if (E.hoja !== H) return;
    Object.assign(H, { texto: '', ocupado: false, error: '', sucio: false });
    renderHoja();
    avisar('Nota dejada: la ven todos en el hogar');
    pintar();
  }

  /* ---------- precios de la zona ----------
     Lo que otros hogares pagaron cerca por los mismos productos (se los reconoce por el código de barras).
     Hace falta saber, más o menos, dónde está el teléfono. */
  const puedeCerca = () => conMapa() && !!Datos.precios && !!E.db;
  /* Con qué se comparte un producto con la zona: su código de barras o, si no tiene (pan, fruta, comida de rotisería)
     y se cargó como «sin código», su nombre hecho clave: «Pizza de muzzarella con morrón» → «n-piza-muzarela-moron».
     Sin las palabras chicas, en singular y sin letras dobles (N.raices), para que «Papas» y «papa» den lo mismo. */
  function claveNombre(texto) {
    const ws = N.raices(texto);
    let k = '';
    for (const w of ws) { if ((k ? k.length + 1 : 0) + w.length > 40) break; k += (k ? '-' : '') + w; }
    return k.length >= 2 ? 'n-' + k : '';
  }
  const textoSuelto = p => [p.nombre, p.marca, p.porKg ? '' : p.presentacion].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  // Lo que se vende por kilo lleva «-xkg» en la clave: su precio es el del kilo y solo se compara con otros por kilo.
  function claveSuelto(texto, porKg) { const k = claveNombre(texto); return k && porKg ? k.slice(0, 38).replace(/-+$/, '') + '-xkg' : k; }
  const conBarras = p => !!(p && p.codigo && Barras.gtinValido(String(p.codigo).replace(/\D/g, '')));
  const codigoDe = p => (conBarras(p) ? Barras.canonico(p.codigo) : p && p.suelto && p.nombre ? claveSuelto(textoSuelto(p), !!p.porKg) : '');
  // El producto de la alacena, sin código de barras, que corresponde a esa clave (o null).
  function productoSuelto(clave) {
    if (!clave) return null;
    for (const [id, p] of V.prods) if (!p.ejemplo && !conBarras(p) && (claveSuelto(textoSuelto(p), !!p.porKg) === clave || claveSuelto(p.nombre, !!p.porKg) === clave)) return id;
    return null;
  }
  // ¿Ese precio de la zona lo cargó este mismo hogar? Es suyo si está en su historial: el mismo comercio, el mismo día, el mismo precio.
  const esPropio = (p, o) => N.precios(p).some(e => !!e[3] && e[3] === o.k && e[0] === o.dia && Math.abs(e[1] - o.precio) < 0.006);
  // Los precios de la zona para un producto de este hogar, con el nombre que el hogar le da a cada comercio.
  const deLaZona = (p, l) => l.map(o => Object.assign({}, o, { comercio: nombreDeRef(o.k) || o.comercio || '', propio: esPropio(p, o) }));
  const recoDe = p => (p && p.reco === 1 ? 1 : p && p.reco === -1 ? -1 : 0);
  // ¿Hace falta pedir de nuevo los precios de la zona? Se mira solo cuando se está por mostrarlos.
  function revisarCerca() {
    if (!puedeCerca() || E.conexion !== 'lista' || !E.prodListo) return;
    C.limpiar();          // una vez por día, este teléfono borra del servidor los precios vencidos
    if (E.tab !== 'compras' && E.tab !== 'novedades') return;
    const pos = C.ultimaPosicion();
    if (!pos) { if (E.cerca.estado !== 'sin') E.cerca = { estado: 'sin', pos: null, porId: new Map(), firma: '', t: 0, nota: '' }; return; }
    const firma = firmaCerca(pos);
    if (E.cerca.estado === 'buscando' || (E.cerca.firma === firma && Date.now() - E.cerca.t < 3 * 3600e3)) return;
    actualizarCerca();
  }
  const conCodigo = () => V.prods.filter(par => !par[1].ejemplo && codigoDe(par[1])).slice(0, 60);
  const firmaCerca = pos => A.celda(pos.lat, pos.lon) + '|' + conCodigo().map(par => codigoDe(par[1])).sort().join(',');
  /* Para los avisos de «más barato cerca»: la suscripción de este teléfono sabe en qué zonas está (no el punto) y
     cuánto paga el hogar por lo que tiene con código o cargado sin código. Se actualiza cuando cambia, como mucho cada 6 horas. */
  function zonaParaAvisos(pos) {
    if (!Datos.avisos || !Datos.avisos.estado() || !pos) return;
    const claves = {};
    for (const [, p] of V.prods) { const k = codigoDe(p); if (k && !p.ejemplo && p.precio > 0) claves[k] = N.redondear2(p.precio); }
    let propios = [];
    try { propios = JSON.parse(localStorage.getItem('libreta.propios') || '[]'); } catch (e) { propios = []; }
    const alertas = {};
    for (const [, p] of V.prods) { const k = codigoDe(p); if (k && !p.ejemplo && p.alerta > 0) alertas[k] = N.redondear2(p.alerta); }
    const zonas = A.celdasCerca(pos.lat, pos.lon, C.RADIO_ZONA), firma = zonas.join(',') + '|' + JSON.stringify(claves) + '|' + JSON.stringify(alertas) + '|' + propios.join(',');
    let ant = null;
    try { ant = JSON.parse(localStorage.getItem('libreta.pushZona') || 'null'); } catch (e) { ant = null; }
    if (ant && ant.firma === firma && Date.now() - ant.t < 6 * 3600e3) return;
    try { localStorage.setItem('libreta.pushZona', JSON.stringify({ firma, t: Date.now() })); } catch (e) { /* sin almacenamiento */ }
    Datos.avisos.zona(zonas, claves, propios, alertas);
  }
  async function actualizarCerca() {
    const pos = C.ultimaPosicion();
    if (!puedeCerca() || !pos || E.cerca.estado === 'buscando') return;
    const lista = conCodigo(), firma = firmaCerca(pos), antes = E.cerca.porId;
    E.cerca = { estado: 'buscando', pos, porId: antes, firma, t: Date.now(), nota: '' };
    if (E.tab === 'novedades') pintar();
    let porId = new Map(), nota = '';
    try {
      const porCodigo = lista.length ? await C.buscar(pos, lista.map(par => codigoDe(par[1]))) : new Map();
      for (const [id, p] of lista) { const l = porCodigo.get(codigoDe(p)); if (l && l.length) porId.set(id, l); }
    } catch (e) { porId = antes; nota = (e && e.texto) || 'No se pudieron traer los precios de tu zona. Revisá la conexión.'; }
    E.cerca = { estado: nota ? 'error' : 'listo', pos, porId, firma, t: Date.now(), nota };
    pintar();
    zonaParaAvisos(pos);
    if (Date.now() - (E.promos.t || 0) > 3600e3 || E.promos.estado === 'error') actualizarPromos(pos);
  }
  /* Después de anotar precios: si el hogar comparte, van a la zona; y se mira si otros lo consiguieron más barato.
     items: [{ id, precio, cant }]. Devuelve qué hay para contar o null:
       { baratos: [{ id, nombre, pagado, cant, oferta, cuantos }], compartidos, preguntar, ref, porId (para el mapa) } */
  async function trasCompra(items, comercio, fechaISO) {
    if (!puedeCerca()) return null;
    const hoy = hoyDia(), dia = fechaISO && N.fechaValida(fechaISO) ? N.diaDe(fechaISO) : hoy;
    if (dia < hoy - 3 || dia > hoy) return null;                       // una compra vieja no es novedad para la zona
    const ref = refDeComercio(comercio), con = [];
    for (const it of items) { const p = E.prod.get(it.id), codigo = codigoDe(p); if (p && !p.ejemplo && codigo && it.precio > 0) con.push({ id: it.id, nombre: p.nombre, codigo, precio: N.redondear2(it.precio), cant: it.cant || 1, reco: recoDe(p), texto: p.porKg ? `${textoSuelto(p).slice(0, 50)} (por kg)` : textoSuelto(p), cat: catDe(p) }); }
    if (!con.length) return null;
    const out = { baratos: [], compartidos: 0, preguntar: false, ref, porId: new Map(), ahorro: 0 };
    if (ref && E.ajustes.compartir === true) {
      try { out.compartidos = await aportarZona(con, ref, dia, E.ajustes.alias, lugarDe(ref)); } catch (e) { out.compartidos = 0; }
      if (out.compartidos) E.cerca.t = 0;                              // lo de la zona cambió: se vuelve a pedir cuando haga falta
    } else if (ref && E.ajustes.compartir == null) { out.preguntar = true; E.porCompartir = { items: con, ref, dia }; }
    // se mira cerca de donde se compró; si ese comercio no está ubicado, cerca del teléfono
    const aca = C.ultimaPosicion();
    let centro = null;
    if (ref) { try { centro = await ubicacionDe(ref); } catch (e) { centro = null; } }
    if (!centro) centro = aca;
    if (centro) {
      try {
        const porCodigo = await C.buscar(centro, con.map(x => x.codigo));
        for (const x of con) {
          const p = verProd(x.id), todos = porCodigo.get(x.codigo) || [];
          if (!p || !todos.length) continue;
          // la distancia que se muestra es desde el teléfono; si no se sabe dónde está, va desde donde se compró, y se lo dice
          const l = deLaZona(p, todos).map(o => Object.assign(o, { dist: aca ? A.distancia(aca.lat, aca.lon, o.lat, o.lon) : null }));
          out.ahorro += ahorroDe(p, x, l, ref, dia);
          const b = A.masBaratos(l.filter(o => o.k !== ref), x.precio);
          if (!b.length) continue;
          out.porId.set(x.id, l);
          const cruda = todos.find(o => o.k === b[0].k);
          out.baratos.push({ id: x.id, nombre: x.nombre, pagado: x.precio, cant: x.cant, cuantos: b.length, oferta: aca ? b[0] : Object.assign({}, b[0], { dist: cruda.dist, deCompra: true }) });
        }
      } catch (e) { /* sin precios de la zona esta vez */ }
    }
    if (out.ahorro > 0) sumarAhorro(out.ahorro, fechaISO && N.fechaValida(fechaISO) ? fechaISO : N.hoyISO());
    return out.baratos.length || out.preguntar || out.compartidos || out.ahorro ? out : null;
  }
  /* Lo que se ahorró gracias a la comunidad en un producto: se compró en un comercio donde otro hogar ya había visto
     ese precio (o uno más bajo) y es menos de lo que este hogar pagaba antes. x: { precio, cant } · l: los de la zona. */
  function ahorroDe(p, x, l, ref, dia) {
    if (!ref) return 0;
    const antes = N.precios(p).filter(e => e[0] < dia), previo = antes.length ? antes[antes.length - 1][1] : 0;
    if (!(previo > x.precio)) return 0;
    const sabido = l.some(o => !o.propio && !o.oficial && o.k === ref && o.dia <= dia && o.precio <= x.precio * 1.03);
    return sabido ? N.redondear2((previo - x.precio) * (x.cant || 1)) : 0;
  }
  function sumarAhorro(monto, iso) {
    const mes = iso.slice(0, 7), ah = Object.assign({}, E.ajustes.ahorro);
    ah[mes] = N.redondear2((ah[mes] || 0) + monto);
    for (const m of Object.keys(ah).sort().slice(0, -12)) delete ah[m];       // se guardan los últimos 12 meses
    const ad = Object.assign({}, E.ajustes.ahorroDias), dia = String(N.diaDe(iso));      // y por día, los últimos 40 (para la semana)
    ad[dia] = N.redondear2((+ad[dia] || 0) + monto);
    for (const k of Object.keys(ad)) if (+k < hoyDia() - 40) delete ad[k];
    cambiarAjustes({ ahorro: ah, ahorroDias: ad }).catch(() => {});
  }
  const ahorroDelMes = () => +(E.ajustes.ahorro || {})[N.hoyISO().slice(0, 7)] || 0;
  const detalleOferta = (o, hoy) => [o.comercio ? `en ${o.comercio}` : '', o.dist != null ? `a ${A.distTexto(o.dist)}${o.deCompra ? ' de donde compraste' : ''}` : '', A.haceDias(hoy - o.dia), A.origen(o), A.recoTexto([o]),
    o.promo ? `con promo: ${N.plata(o.promo.precio)}${o.promo.texto ? ` (${o.promo.texto})` : ''}` : ''].filter(Boolean).join(' · ');
  // La tostada después de anotar un precio: quién lo consiguió más barato y dónde.
  const avisoBarato = o => `${o.hogar && !o.propio ? `${o.hogar} lo consiguió` : 'Otros hogares lo consiguieron'} más barato: ${textoOferta(o)}`;
  const textoOferta = o => A.textoCerca(o.deCompra ? Object.assign({}, o, { dist: null }) : o);
  // El mapa de lo que, después de una compra, resultó que otros consiguieron más barato.
  function verBaratos(r) {
    const pines = pinesDe(r.baratos.map(b => b.id), r.porId).filter(pn => pn.baratos);
    abrirMapa({ titulo: 'Dónde estaba más barato', pines, pin: pines.length ? pines[0].k : null });
  }
  // La leyenda que sigue a una compra: otros lo consiguieron más barato, y si se comparten los precios propios.
  function bloqueCercaDe(H) {
    const r = H && H.cerca;
    if (!r) return '';
    const hoy = hoyDia();
    return h`${r.baratos.length ? h`<div class="leyenda-cerca" role="status"><p class="rotulo">Otros lo consiguieron más barato</p>
        <ul class="ofertas">${r.baratos.map(b => h`<li><span class="oferta-nombre">${b.nombre}</span><strong class="oferta-precio">${N.plata(b.oferta.precio)}</strong>
          <span class="oferta-detalle">${detalleOferta(b.oferta, hoy)} · vos lo pagaste ${N.plata(b.pagado)}</span></li>`)}</ul>
        <div class="acciones"><button type="button" class="btn btn-chico" data-act="mapa-compra">${ico('mapa')}Ver dónde</button></div></div>` : ''}
      ${r.preguntar && E.ajustes.compartir == null ? h`<div class="nota compartir"><p><strong>¿Compartir estos precios con otros hogares de tu zona?</strong> Va el producto, el precio, la fecha y el comercio, y el nombre público de tu hogar si elegiste uno en Ajustes. Nunca tu nombre, tu email ni tu dirección. Se puede cambiar después en Ajustes.</p>
        <div class="acciones"><button type="button" class="btn btn-chico" data-act="compartir-no">No</button><button type="button" class="btn btn-chico btn-principal" data-act="compartir-si">Sí, compartir</button></div></div>` : ''}
      ${r.ahorro > 0 ? h`<p class="nota verde" id="ahorro-compra"><strong>Con esta compra ahorraste ${N.plata(r.ahorro)} gracias a otros hogares.</strong></p>` : ''}
      ${r.compartidos ? h`<p class="tenue chico" id="compartidos">${r.compartidos === 1 ? 'Ese precio ya lo ven' : `Esos ${r.compartidos} precios ya los ven`} los hogares de tu zona${E.ajustes.alias ? `, como «${E.ajustes.alias}»` : ', sin tu nombre'}.</p>` : ''}`;
  }
  // Lo de la zona que le sirve a este hogar: [{ id, p, o (el más barato), cuantos }], lo que más ahorra primero.
  function ofertasCerca() {
    const out = [];
    for (const [id, l] of V.cerca) {
      const p = verProd(id);
      if (!p || !(p.precio > 0)) continue;
      const b = A.masBaratos(l, p.precio);
      if (b.length) out.push({ id, p, o: b[0], cuantos: b.length, baja: 1 - b[0].precio / p.precio });
    }
    return out.sort((a, b) => b.baja - a.baja);
  }
  function bloqueCercaNovedades() {
    if (!puedeCerca()) return '';
    const c = E.cerca, hoy = hoyDia();
    if (c.estado === 'sin') {
      return h`<div class="bloque cerca"><h2 class="bloque-t">Precios cerca tuyo</h2>
        <p>Mirá si otros hogares de tu zona consiguieron más barato lo mismo que comprás vos.</p>
        ${c.nota ? h`<p class="error" role="alert">${c.nota}</p>` : ''}
        <div class="acciones"><button type="button" class="btn btn-principal" data-act="cerca-activar">${ico('aca')}Usar mi ubicación</button></div>
        <p class="tenue chico">La ubicación queda en este teléfono y sirve para pedir los precios de tu zona. No se guarda en tu hogar ni se comparte.</p></div>`;
    }
    const of = ofertasCerca(), hayAlgo = V.cerca.size > 0, comparte = E.ajustes.compartir;
    // lo que el hogar decidió sobre compartir sus precios; mientras no lo decida, se le pregunta acá
    const compartir = comparte == null
      ? h`<div class="nota compartir"><p><strong>¿Compartir con tu zona los precios que anotás?</strong> Va el producto, el precio, la fecha y el comercio, y el nombre público de tu hogar si elegiste uno en Ajustes. Nunca tu nombre, tu email ni tu dirección. Sirve cuando el comercio está ubicado en el mapa y el producto tiene código de barras o lo cargaste con «No tiene código».</p>
          <div class="acciones"><button type="button" class="btn btn-chico" data-act="compartir-no">No</button><button type="button" class="btn btn-chico btn-principal" data-act="compartir-si">Sí, compartir</button></div></div>`
      : h`<p class="tenue chico">${comparte ? 'Tu hogar comparte sus precios con la zona, sin nombres.' : 'Tu hogar no comparte sus precios.'} Se cambia en Ajustes.</p>`;
    return h`<div class="bloque cerca"><h2 class="bloque-t">Precios cerca tuyo</h2>
      ${c.estado === 'buscando' && !hayAlgo ? cargando('Buscando precios en tu zona…') : ''}
      ${c.nota ? h`<p class="nota gris">${c.nota}</p>` : ''}
      ${alertasCumplidas().length ? h`<div class="nota verde bajo"><p><strong>🔔 ¡Bajó!</strong></p><ul class="ofertas">${alertasCumplidas().map(x => h`<li><span class="oferta-nombre">${x.p.nombre}</span><strong class="oferta-precio">${N.plata(x.o.precio)}</strong>
          <span class="oferta-detalle">${detalleOferta(x.o, hoy)} · pediste que te avise por debajo de ${N.plata(x.p.alerta)}</span></li>`)}</ul></div>` : ''}
      ${of.length ? h`<p><strong>Otros hogares lo consiguieron más barato:</strong></p>
          <ul class="ofertas">${of.slice(0, 12).map(x => h`<li><span class="oferta-nombre">${x.p.nombre}</span><strong class="oferta-precio">${N.plata(x.o.precio)}</strong>
            <span class="oferta-detalle">${detalleOferta(x.o, hoy)} · vos lo pagaste ${N.plata(x.p.precio)}</span></li>`)}</ul>`
        : c.estado === 'buscando' ? '' : h`<p class="tenue">${hayAlgo ? 'En tu zona nadie cargó un precio más bajo que el tuyo para lo que comprás.' : 'Todavía nadie de tu zona cargó precios de lo que comprás. Cuando anotes los tuyos con el comercio ubicado en el mapa, les sirven a los demás.'}</p>`}
      <div class="acciones">${hayAlgo ? h`<button type="button" class="btn btn-chico btn-principal" data-act="mapa-zona">${ico('mapa')}Ver el mapa</button>` : ''}
        <button type="button" class="btn btn-chico" data-act="cerca-actualizar"${atr('disabled', c.estado === 'buscando')}>${c.estado === 'buscando' ? 'Buscando…' : 'Actualizar'}</button></div>
      ${compartir}</div>`;
  }

  /* ---------- lo que motiva: el ahorro de la semana, lo que aporta el hogar, el barrio ---------- */
  const ahorroSemana = () => { const hoy = hoyDia(); return N.redondear2(Object.entries(E.ajustes.ahorroDias || {}).filter(([d]) => +d > hoy - 7).reduce((s, [, v]) => s + (+v || 0), 0)); };
  const aportesDelMes = () => +(E.ajustes.aportes || {})[N.hoyISO().slice(0, 7)] || 0;
  function contarAportes(n) {
    if (!(n > 0)) return;
    const mes = N.hoyISO().slice(0, 7), ap = Object.assign({}, E.ajustes.aportes);
    ap[mes] = (+ap[mes] || 0) + n;
    for (const m of Object.keys(ap).sort().slice(0, -12)) delete ap[m];
    cambiarAjustes({ aportes: ap }).catch(() => {});
  }
  // Todo lo que se comparte con la zona pasa por acá, para contar lo que aporta el hogar.
  async function aportarZona(items, ref, dia, alias, lugar) {
    const n = await C.aportar(items, ref, dia, alias, lugar);
    contarAportes(n);
    return n;
  }
  const URL_APP = () => location.origin + location.pathname.replace(/index\.html$/, '');
  // Compartir: con el menú del teléfono (WhatsApp, etc.) si lo tiene, con una imagen si se puede; si no, WhatsApp web.
  async function compartirTexto(texto, archivo) {
    try {
      if (archivo && navigator.canShare && navigator.canShare({ files: [archivo] })) { await navigator.share({ text: texto, files: [archivo] }); return; }
      if (navigator.share) { await navigator.share({ text: texto }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    window.open('https://wa.me/?text=' + encodeURIComponent(texto), '_blank', 'noopener');
  }
  // La tarjeta del ahorro, para mandar por WhatsApp: una imagen cuadrada con el monto.
  async function tarjetaAhorro(monto, cuando) {
    try {
      const c = document.createElement('canvas'); c.width = c.height = 1080;
      const x = c.getContext('2d');
      x.fillStyle = '#2343B5'; x.fillRect(0, 0, 1080, 1080);
      x.fillStyle = '#FFE352'; x.fillRect(0, 760, 1080, 320);
      x.fillStyle = '#FFFFFF'; x.textAlign = 'center';
      x.font = '700 64px Archivo, system-ui, sans-serif'; x.fillText(cuando === 'semana' ? 'Esta semana ahorré' : 'Este mes ahorré', 540, 250);
      x.font = '900 190px Archivo, system-ui, sans-serif'; x.fillText(N.plata(monto), 540, 470, 1000);
      x.font = '500 50px Archivo, system-ui, sans-serif'; x.fillText('comprando donde otros hogares', 540, 590); x.fillText('del barrio encontraron mejor precio', 540, 655);
      x.fillStyle = '#131C33'; x.font = '800 70px Archivo, system-ui, sans-serif'; x.fillText('LIBRETA del hogar', 540, 900);
      x.font = '500 40px Archivo, system-ui, sans-serif'; x.fillText('Gratis · sumate y compartamos precios', 540, 975);
      const b = await new Promise(ok => c.toBlob(ok, 'image/png'));
      return b ? new File([b], 'mi-ahorro.png', { type: 'image/png' }) : null;
    } catch (e) { return null; }
  }
  // Lo de la zona para el bloque del barrio: cuántos precios hay, qué hogares aportan más y si hay algo para confirmar acá.
  async function actualizarBarrio(forzar) {
    const pos = C.ultimaPosicion();
    if (!puedeCerca() || !pos || !Datos.precios.deZonas) return;
    if (!forzar && E.barrio && (E.barrio.estado === 'buscando' || Date.now() - E.barrio.t < 20 * 60000)) return;
    E.barrio = Object.assign({}, E.barrio, { estado: 'buscando', t: Date.now() });
    let docs = null;
    try { docs = await Datos.precios.deZonas(A.celdasCerca(pos.lat, pos.lon, C.RADIO_ZONA), 600); } catch (e) { docs = null; }
    const hoy = hoyDia(), vig = (docs || []).filter(d => d.v >= hoy && d.p > 0 && A.puntoValido(d.la, d.lo) && A.distancia(pos.lat, pos.lon, d.la, d.lo) <= C.RADIO_ZONA);
    const hog = new Map();
    let anonimos = 0;
    for (const d of vig) { if (typeof d.h === 'string' && d.h) hog.set(d.h, (hog.get(d.h) || 0) + 1); else anonimos++; }
    // un comercio a menos de 150 m de donde está el teléfono, con precios de otros para confirmar
    let propios = [];
    try { propios = JSON.parse(localStorage.getItem('libreta.propios') || '[]'); } catch (e) { propios = []; }
    const cerca = new Map();
    for (const d of vig) {
      if (propios.includes(d.id) || typeof d.t !== 'string') continue;
      const dist = A.distancia(pos.lat, pos.lon, d.la, d.lo);
      if (dist > 150) continue;
      const c = cerca.get(d.k) || { k: d.k, n: nombreDeRef(d.k) || d.n || 'este comercio', dist, docs: [] };
      c.docs.push(d); cerca.set(d.k, c);
    }
    const aca = [...cerca.values()].sort((a, b) => a.dist - b.dist)[0] || null;
    E.barrio = { estado: docs ? 'listo' : 'error', t: Date.now(), precios: vig.length, hogares: [...hog].map(([h, n]) => ({ h, n })).sort((a, b) => b.n - a.n), anonimos, aca, pos };
    if (E.tab === 'novedades') pintar();
  }
  function bloqueBarrio() {
    const sem = ahorroSemana(), mes = ahorroDelMes(), ap = aportesDelMes(), B = E.barrio, mio = E.ajustes.alias;
    const partes = [];
    if (sem > 0 || mes > 0) {
      partes.push(h`<div class="ahorro-caja"><p class="canasta-pct verde">${N.plata(sem > 0 ? sem : mes)}</p>
        <p class="mes-nota">ahorraste ${sem > 0 ? 'esta semana' : 'este mes'} comprando donde otros hogares encontraron mejor precio${sem > 0 && mes > sem ? ` · ${N.plata(mes)} en el mes` : ''}</p>
        <div class="acciones"><button type="button" class="btn btn-chico btn-principal" data-act="compartir-ahorro" data-cuando="${sem > 0 ? 'semana' : 'mes'}">Compartir mi ahorro</button></div></div>`);
    }
    partes.push(h`<p>${ap ? h`<strong>Tu hogar avisó ${ap} ${N.plural(ap, 'precio', 'precios')} este mes.</strong> ${B && B.precios ? `Los ven los hogares de tu zona: ¡gracias!` : ''}` : 'Cada precio que avisás les sirve a todos los hogares de tu zona.'}</p>`);
    if (B && B.aca && E.ajustes.compartir !== false) {
      partes.push(h`<div class="nota aca-confirmar"><p><strong>¿Estás en ${B.aca.n}?</strong> Hay ${B.aca.docs.length} ${N.plural(B.aca.docs.length, 'precio', 'precios')} de otros hogares para confirmar con un toque.</p>
        <div class="acciones"><button type="button" class="btn btn-chico btn-principal" data-act="confirmar" data-k="${B.aca.k}">Confirmar precios</button></div></div>`);
    }
    if (B && B.estado === 'listo') {
      const top = B.hogares.slice(0, 5);
      partes.push(h`<p class="tenue chico">En tu zona hay <strong>${B.precios} ${N.plural(B.precios, 'precio vigente', 'precios vigentes')}</strong> que cargaron los hogares.</p>
        ${top.length ? h`<p class="chico"><strong>Los hogares que más aportan:</strong></p><ol class="ranking">${top.map(x => h`<li${atr('class="yo"', !!mio && x.h === mio)}><span>${x.h}${mio && x.h === mio ? ' (vos)' : ''}</span><strong>${x.n}</strong></li>`)}</ol>
          ${!mio ? h`<p class="tenue chico">Para figurar acá, elegí un nombre público para tu hogar en Ajustes.</p>` : ''}` : ''}`);
    }
    partes.push(h`<div class="acciones"><button type="button" class="btn btn-chico" data-act="invitar-barrio">${ico('familia')}Invitar vecinos</button></div>`);
    return h`<div class="bloque barrio"><h2 class="bloque-t">Tu barrio</h2>${partes}</div>`;
  }

  /* ---------- confirmar los precios de un comercio: «¿sigue a este precio?» ---------- */
  async function abrirConfirmar(k) {
    if (!puede() || !puedeCerca() || !k) return;
    let l = C.conocido(k);
    const B = E.barrio && E.barrio.aca && E.barrio.aca.k === k ? E.barrio.aca : null;
    if (!l && B) l = { lat: B.docs[0].la, lon: B.docs[0].lo, nombre: B.docs[0].n };
    if (!l) { try { l = await ubicacionDe(k); } catch (e) { l = null; } }
    if (!l) return avisar('No se encontró dónde queda ese comercio.');
    const H = { tipo: 'confirmar', k, nombre: nombreDeRef(k) || l.nombre || 'este comercio', estado: 'cargando', items: [], error: '' };
    abrirHoja(H);
    let docs = null;
    try { docs = await C.deComercio(k, l.lat, l.lon); } catch (e) { docs = null; }
    if (E.hoja !== H) return;
    let propios = [], hechos = {};
    try { propios = JSON.parse(localStorage.getItem('libreta.propios') || '[]'); hechos = JSON.parse(localStorage.getItem('libreta.confirmados') || '{}'); } catch (e) { /* nada */ }
    const hoy = hoyDia();
    H.items = (docs || []).filter(d => !propios.includes(d.id)).map(d => ({ d, estado: hechos[d.id] === hoy ? 'sigue' : '', nuevo: '' }));
    H.estado = docs ? 'listo' : 'error';
    renderHoja();
  }
  async function confirmarPrecio(i, cambio) {
    const H = E.hoja, it = H && H.tipo === 'confirmar' ? H.items[i] : null;
    if (!it || it.ocupado || !puede()) return;
    if (E.ajustes.compartir === false) { H.error = 'Tu hogar eligió no compartir precios con la zona. Se cambia en Ajustes.'; renderHoja(); return; }
    if (E.ajustes.compartir == null) { try { await cambiarAjustes({ compartir: true }); } catch (e) { H.error = textoFallo(e); renderHoja(); return; } }
    const d = it.d, hoy = hoyDia();
    let ok = false;
    if (!cambio) {
      it.ocupado = true; renderHoja();
      try { ok = await C.confirmar(d); } catch (e) { ok = false; }
      if (ok) { try { const x = JSON.parse(localStorage.getItem('libreta.confirmados') || '{}'); x[d.id] = hoy; for (const k of Object.keys(x)) if (x[k] < hoy - 20) delete x[k]; localStorage.setItem('libreta.confirmados', JSON.stringify(x)); } catch (e) { /* nada */ } contarAportes(1); }
    } else {
      const precio = N.aNumero(limpio(it.nuevo));
      if (!(precio > 0)) { it.error = 'Escribí el precio que ves.'; renderHoja(); return; }
      it.ocupado = true; renderHoja();
      try { ok = (await aportarZona([{ codigo: d.e, precio, reco: 0, texto: d.t, cat: d.g || '' }], d.k, hoy, E.ajustes.alias, { lat: d.la, lon: d.lo, nombre: d.n })) > 0; } catch (e) { ok = false; }
      if (ok) it.d = Object.assign({}, d, { p: precio, d: hoy });
    }
    if (E.hoja !== H) return;
    it.ocupado = false; it.error = ok ? '' : 'No se pudo guardar. Probá de nuevo.';
    if (ok) { it.estado = cambio ? 'cambio' : 'sigue'; it.abierto = false; }
    renderHoja();
  }

  /* ---------- arranque rápido: lo que hay en casa, con un toque ---------- */
  const BASICOS = [
    ['almacen', ['Yerba', 'Azúcar', 'Aceite', 'Fideos', 'Arroz', 'Harina', 'Sal', 'Café', 'Té', 'Galletitas', 'Puré de tomate', 'Mayonesa']],
    ['lacteos', ['Leche', 'Huevos', 'Manteca', 'Queso cremoso', 'Yogur', 'Dulce de leche']],
    ['frescos', ['Papa', 'Cebolla', 'Tomate', 'Banana', 'Manzana']],
    ['carnes', ['Pollo', 'Carne picada', 'Jamón cocido']],
    ['panaderia', ['Pan']],
    ['bebidas', ['Agua', 'Gaseosa']],
    ['limpieza', ['Lavandina', 'Detergente', 'Jabón en polvo']],
    ['higiene', ['Papel higiénico', 'Jabón', 'Pasta dental', 'Shampoo']],
  ];
  const POR_KILO = new Set(['Papa', 'Cebolla', 'Tomate', 'Banana', 'Manzana', 'Pollo', 'Carne picada']);
  function vistaArranque(H) {
    const n = Object.values(H.sel).filter(Boolean).length, faltan = Object.values(H.sel).filter(v => v === 2).length;
    return marco('¿Qué hay en tu casa?', h`<div class="hoja-cuerpo">
      <p class="tenue chico">Tocá una vez lo que <strong>hay</strong>, dos veces lo que <strong>falta</strong> (va a la lista de compras). Lo que no usás, dejalo. Después se ajusta todo.</p>
      ${BASICOS.map(([cat, l]) => h`<div class="campo"><span>${N.CATS[cat]}</span><div class="chips envuelve" role="group">${l.map(nom => {
        const v = H.sel[nom] || 0;
        return h`<button type="button" class="chip${v === 1 ? ' puesto' : v === 2 ? ' falta' : ''}" data-act="arranque-toque" data-n="${nom}" aria-pressed="${v ? 'true' : 'false'}" aria-label="${nom}: ${v === 1 ? 'hay' : v === 2 ? 'falta' : 'no'}">${v === 2 ? '🛒 ' : v === 1 ? '✓ ' : ''}${nom}</button>`;
      })}</div></div>`)}
      ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
      <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Ahora no</button>
        <button type="button" class="btn btn-principal" data-act="arranque-listo"${atr('disabled', !n || H.ocupado)}>${H.ocupado ? 'Cargando…' : n ? `Cargar ${n}${faltan ? ` (${faltan} a la lista)` : ''}` : 'Elegí algo'}</button></div></div>`);
  }
  async function guardarArranque() {
    const H = E.hoja;
    if (!H || H.tipo !== 'arranque' || H.ocupado || !puede()) return;
    const ya = new Set(V.prods.filter(([, p]) => !p.ejemplo).map(([, p]) => N.norm(p.nombre)));
    const lista = [];
    for (const [cat, l] of BASICOS) for (const nom of l) if (H.sel[nom] && !ya.has(N.norm(nom))) lista.push({ nom, cat, v: H.sel[nom] });
    H.ocupado = true; renderHoja();
    let n = 0;
    try {
      for (const x of lista) {
        await crearProducto({ nombre: x.nom, categoria: x.cat, stock: x.v === 1 ? 1 : 0, pedido: x.v === 2 ? hoyDia() : 0, suelto: true, porKg: POR_KILO.has(x.nom) });
        n++;
      }
    } catch (e) { if (E.hoja === H) { H.ocupado = false; H.error = textoFallo(e); renderHoja(); } return; }
    if (E.hoja === H) cerrarHoja();
    const f = lista.filter(x => x.v === 2).length;
    pintar();
    avisar(`Listo: ${n} ${N.plural(n, 'producto cargado', 'productos cargados')}${f ? `, ${f} en la lista de compras` : ''}`, f ? { rotulo: 'Ver la lista', fn: () => irA('compras') } : undefined);
  }

  /* ---------- «avisame cuando baje» ---------- */
  function bloqueAlerta(id, p) {
    if (!puedeCerca() || !codigoDe(p)) return '';
    const H = E.hoja || {};
    if (H.alertaEdit) {
      return h`<div class="dato alerta"><label class="campo"><span>Avisame si cerca está a menos de</span>
        <input type="text" id="p-alerta" data-k="alertaPrecio" value="${H.alertaPrecio}" inputmode="decimal" autocomplete="off" placeholder="$"></label>
        <div class="acciones"><button type="button" class="btn btn-chico" data-act="alerta-cancelar">Cancelar</button><button type="button" class="btn btn-chico btn-principal" data-act="alerta-guardar" data-id="${id}" data-escribe>Guardar</button></div></div>`;
    }
    return p.alerta > 0
      ? h`<div class="dato alerta"><span>🔔 Te aviso si cerca baja de <strong>${N.plata(p.alerta)}</strong>.</span>
          <span class="acciones"><button type="button" class="enlace" data-act="alerta-editar" data-id="${id}">Cambiar</button><button type="button" class="enlace" data-act="alerta-quitar" data-id="${id}" data-escribe>Quitar</button></span></div>`
      : h`<div class="dato alerta"><button type="button" class="btn btn-chico" data-act="alerta-editar" data-id="${id}" data-escribe>🔔 Avisame cuando baje</button></div>`;
  }
  function guardarAlerta(id, valor) {
    const p = E.prod.get(id);
    if (!p || !puede()) return;
    E.prod.set(id, { ...p, alerta: valor });
    enCola(id, () => escribir(() => E.db.doc('productos/' + id).update({ alerta: valor }))).then(() => {
      avisar(valor ? `Te aviso cuando ${p.nombre} esté a menos de ${N.plata(valor)} cerca${Datos.avisos && Datos.avisos.configurado() && !Datos.avisos.estado() ? '. Activá las notificaciones en Ajustes para enterarte aunque la app esté cerrada' : ''}` : 'Aviso quitado');
      try { localStorage.removeItem('libreta.pushZona'); } catch (e) { /* nada */ }
      const pos = C.ultimaPosicion(); if (pos) zonaParaAvisos(pos);
    }, falloGuardar);
    if (E.hoja) { E.hoja.alertaEdit = false; renderHoja(); }
    pintar();
  }
  // Los productos con aviso que ya bajaron cerca: [{ id, p, o }].
  function alertasCumplidas() {
    const out = [];
    for (const [id, l] of V.cerca) {
      const p = verProd(id);
      if (!p || !(p.alerta > 0)) continue;
      const o = l.filter(x => !x.propio && x.precio <= p.alerta).sort((a, b) => a.precio - b.precio)[0];
      if (o) out.push({ id, p, o });
    }
    return out;
  }

  // Lo que el hogar ahorró este mes gracias a la comunidad (sin el mapa; con él, va en «Tu barrio»).
  function bloqueAhorro() {
    if (puedeCerca()) return '';
    const m = ahorroDelMes();
    if (!(m > 0)) return '';
    return h`<div class="bloque ahorro"><h2 class="bloque-t">Ahorro con la comunidad</h2>
      <p class="canasta-pct verde">${N.plata(m)}</p>
      <p class="mes-nota">ahorraste este mes comprando donde otros hogares encontraron mejor precio</p></div>`;
  }
  /* ---------- promos de la zona ---------- */
  // Cómo se llama quien usa este teléfono, para los avisos al resto del hogar («Caro anotó en la lista…»).
  function miNombre() {
    try {
      const i = Datos.hogar && Datos.hogar.integrantes ? Datos.hogar.integrantes().find(x => x.yo) : null, y = Datos.hogar && Datos.hogar.yo ? Datos.hogar.yo() : null;
      return (i && i.nombre) || (y && y.nombre) || 'Alguien';
    } catch (e) { return 'Alguien'; }
  }
  /* ---------- la IA (Gemini, ver ia.js): leer la foto de una promo y proponer comidas ----------
     Cada teléfono elige si la usa (Ajustes); por omisión sí, cuando el sitio la tiene configurada. */
  const CLAVE_IA = 'libreta.ia';
  function iaElegida() { try { return localStorage.getItem(CLAVE_IA) !== 'no'; } catch (e) { return true; } }
  function hayIA() { return typeof IA !== 'undefined' && IA.disponible() && iaElegida(); }
  const PROMO_MEDIOS = ['Todos los medios', 'Efectivo', 'MODO', 'Mercado Pago', 'Cuenta DNI', 'Banco Nación', 'Banco Provincia', 'Galicia', 'Santander', 'BBVA', 'Macro', 'Naranja X', 'Ualá', 'Jubilados'];
  const DIAS_CORTOS = ['D', 'L', 'M', 'M', 'J', 'V', 'S'];
  function diasTexto(d) {
    if (!d || !d.length || d.length === 7) return 'todos los días';
    const l = d.slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(x => DIAS_SEMANA[x]);
    return l.length === 1 ? `los ${l[0]}` : `${l.slice(0, -1).join(', ')} y ${l[l.length - 1]}`;
  }
  const promoDeHoy = (x, dow) => !x.dias.length || x.dias.includes(dow);
  function promosVigentes() {
    const hoy = hoyDia();
    return (E.promos.lista || []).filter(x => x.hasta >= hoy);
  }
  const filaPromo = x => h`<li><span class="oferta-nombre">${x.n}</span><strong class="oferta-precio">${x.pct ? `${x.pct} %` : ''}</strong>
    <span class="oferta-detalle">${[x.t, x.m && x.m !== 'Todos los medios' && !N.norm(x.t).includes(N.norm(x.m)) ? `con ${x.m}` : '', diasTexto(x.dias), `hasta el ${N.fechaCorta(N.isoDeDia(x.hasta))}`, x.dist != null ? `a ${A.distTexto(x.dist)}` : '', x.h ? `la cargó ${x.h}` : ''].filter(Boolean).join(' · ')}</span></li>`;
  /* El buscador: qué cargaron los hogares de la zona que coincide con lo buscado, del más barato al más caro. */
  function bloqueBuscador() {
    if (!puedeCerca()) return '';
    const B = E.busca || {}, hoy = hoyDia();
    let res = '';
    if (B.estado === 'buscando') res = cargando('Buscando cerca…');
    else if (B.estado === 'error') res = h`<p class="nota gris">${B.error}</p>`;
    else if (B.estado === 'listo') {
      res = !B.precios.length && !B.promos.length
        ? h`<p class="tenue">Nadie cargó «${B.q}» cerca en los últimos días. Cuando lo compres, anotá el precio y sos el primero.</p>`
        : h`${B.precios.length ? h`<ul class="ofertas buscados">${B.precios.map((o, i) => h`<li><span class="oferta-nombre">${o.texto}</span><strong class="oferta-precio${i ? '' : ' verde'}">${N.plata(o.precio)}</strong>
            <span class="oferta-detalle">${detalleOferta(o, hoy)}</span></li>`)}</ul>` : ''}
          ${B.promos.length ? h`<p><strong>Promos que coinciden:</strong></p><ul class="ofertas">${B.promos.map(filaPromo)}</ul>` : ''}
          <p class="tenue chico">Los cargaron hogares de tu zona${B.precios.length ? ', del más barato al más caro' : ''}. Pueden haber cambiado.</p>`;
    }
    return h`<div class="bloque buscador-cerca"><h2 class="bloque-t">Precios de tu zona</h2>
      <div class="acciones"><button type="button" class="btn btn-principal" data-act="avisar-precio" data-escribe>${ico('mas')}Avisar un precio</button>
        <button type="button" class="btn" data-act="mapa-vivo">${ico('mapa')}Mapa en vivo</button></div>
      <form class="buscador" data-form="buscar-cerca" role="search"><label class="buscar">${ico('buscar')}<input type="search" id="bc-q" value="${E.buscaEscrito != null ? E.buscaEscrito : B.q || ''}" placeholder="Pizzeta, jamón, tomate…" enterkeyhint="search" autocomplete="off" maxlength="60" aria-label="Qué producto buscás"></label>
        <button type="submit" class="btn btn-principal">Buscar</button></form>
      <div id="bc-res" aria-live="polite">${res}</div></div>`;
  }
  async function buscarCerca() {
    const q = limpio(($('#bc-q') || {}).value || '').slice(0, 60);
    if (!q || !puedeCerca()) return;
    if (!N.raices(q).length) { E.busca = { q, estado: 'error', error: 'Escribí qué producto buscás: por ejemplo «pizzeta».' }; renderNovedades(); return; }
    const turno = (E.buscaTurno || 0) + 1;
    E.buscaTurno = turno;
    E.busca = { q, estado: 'buscando' };
    renderNovedades();
    let pos = C.ultimaPosicion();
    if (!pos) { try { pos = await C.posicion(true); } catch (e) { pos = null; } }
    let r = null, error = '';
    if (!pos) error = 'Para buscar cerca hace falta tu ubicación: tocá «Usar mi ubicación» o permitila en el navegador.';
    else { try { r = await C.buscarTexto(pos, q); } catch (e) { error = (e && e.texto) || 'No se pudo buscar. Revisá la conexión.'; } }
    if (E.buscaTurno !== turno) return;
    E.busca = r ? { q, estado: 'listo', precios: r.precios, promos: r.promos } : { q, estado: 'error', error };
    if (E.tab === 'novedades') { renderNovedades(); const el = $('#bc-res'); if (el) el.scrollIntoView({ block: 'nearest' }); }
  }
  function bloquePromos() {
    if (!puedeCerca() || !Datos.promos || E.cerca.estado === 'sin') return '';
    const P = E.promos, dow = new Date().getDay(), vig = promosVigentes(), hoyL = vig.filter(x => promoDeHoy(x, dow)), otras = vig.filter(x => !promoDeHoy(x, dow));
    return h`<div class="bloque promos"><h2 class="bloque-t">Promos de tu zona</h2>
      ${P.estado === 'buscando' && !vig.length ? cargando('Buscando promos…') : ''}
      ${P.nota ? h`<p class="nota gris">${P.nota}</p>` : ''}
      ${hoyL.length ? h`<p><strong>Hoy, ${DIAS_SEMANA[dow]}:</strong></p><ul class="ofertas">${hoyL.map(filaPromo)}</ul>` : P.estado === 'buscando' ? '' : h`<p class="tenue">Hoy no hay promos cargadas cerca.</p>`}
      ${otras.length ? h`<p><strong>Otros días:</strong></p><ul class="ofertas">${otras.slice(0, 10).map(filaPromo)}</ul>` : ''}
      <p class="tenue chico">Las cargan los hogares: descuentos por día, banco o billetera. Pueden haber cambiado, conviene confirmarlas en el comercio.</p>
      <div class="acciones"><button type="button" class="btn btn-chico" data-act="promo-nueva" data-escribe>Cargar una promo</button></div></div>`;
  }
  async function actualizarPromos(pos) {
    if (!Datos.promos || !pos) return;
    E.promos = Object.assign({}, E.promos, { estado: 'buscando', nota: '' });
    try {
      const l = await C.promos(pos);
      E.promos = { estado: 'listo', lista: l, t: Date.now(), nota: '' };
    } catch (e) { E.promos = { estado: 'error', lista: E.promos.lista || [], t: Date.now(), nota: (e && e.texto) || 'No se pudieron traer las promos de tu zona.' }; }
    pintar();
  }
  // Arriba de la lista de compras: si hoy hay promos cerca.
  function avisoPromosHoy() {
    if (!puedeCerca() || !Datos.promos) return '';
    const dow = new Date().getDay(), l = promosVigentes().filter(x => promoDeHoy(x, dow));
    if (!l.length) return '';
    const x = l[0];
    return h`<a class="nota promo-hoy" href="#novedades" data-tab="novedades"><strong>Hoy conviene:</strong> ${x.n} · ${x.t}${l.length > 1 ? ` · y ${l.length - 1} ${N.plural(l.length - 1, 'promo más', 'promos más')}` : ''}</a>`;
  }

  /* ---------- promos de bancos y billeteras (promos-bancos.json) ----------
     Las carga a mano quien mantiene la libreta, una vez por mes, con su fuente y su vigencia. Se muestran como
     «Ofertas de hoy» y, en el mapa, con un cartel en cada sucursal de esas cadenas cerca de la persona. */
  let pbCargando = null;
  function cargarPB() {
    if (!pbCargando) {
      pbCargando = fetch('promos-bancos.json', { cache: 'no-cache' }).then(r => (r.ok ? r.json() : null)).then(j => {
        E.pb = j && Array.isArray(j.promos) ? j : { promos: [] };
        // solo si hay algo para mostrar (y sin pisar lo que alguien está escribiendo)
        const ae = document.activeElement;
        if (pbVigentes().length && !(ae && /^(INPUT|TEXTAREA)$/.test(ae.tagName) && !E.hoja)) pintar();
        return E.pb;
      }, () => { E.pb = { promos: [] }; return E.pb; });
    }
    return pbCargando;
  }
  // Cuenta DNI vale en comercios de la provincia de Buenos Aires (no en la Ciudad).
  const enPBA = (lat, lon) => lat >= -41.2 && lat <= -33.2 && lon >= -63.5 && lon <= -56.5 && !(lat > -34.71 && lat < -34.52 && lon > -58.54 && lon < -58.33);
  function pbVigentes(pos) {
    const hoy = N.hoyISO();
    return ((E.pb && E.pb.promos) || []).filter(p => p && p.pct > 0 && p.cadena && (!p.desde || p.desde <= hoy) && (!p.hasta || p.hasta >= hoy)
      && (p.zona !== 'pba' || !pos || enPBA(pos.lat, pos.lon)));
  }
  const pbDia = (p, dow) => !p.dias || !p.dias.length || p.dias.includes(dow);
  const planoCad = s => N.norm(s).replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  // Las promos que valen en un comercio por su nombre («Supermercado Día», «Changomás Bahía Blanca»…).
  function pbDeComercio(nombre, lat, lon, dow) {
    const n = planoCad(nombre);
    if (!n) return [];
    return pbVigentes().filter(p => (dow == null || pbDia(p, dow)) && (p.zona !== 'pba' || enPBA(lat, lon))
      && (p.cadenas || []).some(c => n === c || n.startsWith(c + ' ') || ['supermercado ', 'super ', 'hipermercado ', 'autoservicio '].some(x => n.startsWith(x + c))));
  }
  const pbTope = p => [p.tope > 0 ? `tope ${N.plata(p.tope)}${/semana/.test(p.detalle || '') ? ' por semana' : ''}` : 'sin tope', p.minimo > 0 ? `mínimo ${N.plata(p.minimo)}` : ''].filter(Boolean).join(' · ');
  // Las sucursales cerca (hasta 8 km) de las cadenas con promo vigente: se buscan una vez por lugar.
  async function tiendasConPromo(pos) {
    if (!pos || !puedeCerca()) return [];
    await cargarPB();
    const k = A.celda(pos.lat, pos.lon);
    if (E.pbTiendas && E.pbTiendas.k === k) return E.pbTiendas.l;
    if (!pbVigentes(pos).some(p => p.cadenas && p.cadenas.length)) { E.pbTiendas = { k, l: [] }; return []; }
    let l = [];
    E.pbTiendas = { k, l: [] };       // mientras busca (y si falla), para no volver a pedirlo en cada dibujo
    try { l = await C.cercanos(pos); } catch (e) { return []; }
    const out = l.filter(t => t.dist <= 8000 && pbDeComercio(t.nombre, t.lat, t.lon).length);
    E.pbTiendas = { k, l: out };
    return out;
  }
  // Las ofertas de un día: [{ p, tienda (la más cercana, si hay) }], las de mayor descuento primero.
  function ofertasDelDia(dow) {
    const pos = C.ultimaPosicion(), tiendas = (E.pbTiendas && E.pbTiendas.l) || [];
    return pbVigentes(pos).filter(p => pbDia(p, dow)).map(p => ({ p, tienda: tiendas.filter(t => pbDeComercio(t.nombre, t.lat, t.lon, dow).includes(p)).sort((a, b) => a.dist - b.dist)[0] || null }))
      .sort((a, b) => (b.tienda ? 1 : 0) - (a.tienda ? 1 : 0) || b.p.pct - a.p.pct);
  }
  function bloqueOfertasHoy() {
    if (!E.pb) { cargarPB(); return ''; }
    const pos = C.ultimaPosicion();
    if (pos && (!E.pbTiendas || E.pbTiendas.k !== A.celda(pos.lat, pos.lon))) tiendasConPromo(pos).then(l => { if (l.length && E.tab === 'novedades') pintar(); });
    const dow = new Date().getDay(), hoy = ofertasDelDia(dow);
    if (!pbVigentes(pos).length) return '';
    const manana = ofertasDelDia((dow + 1) % 7);
    return h`<section class="ofertas-hoy" aria-labelledby="oh-t">
      <div class="oh-cabeza"><p class="oh-dia">Hoy, ${DIAS_SEMANA[dow]}</p><h2 id="oh-t">${hoy.length ? `${hoy.length} ${N.plural(hoy.length, 'oferta', 'ofertas')} para hoy` : 'Hoy no hay promos de bancos'}</h2></div>
      ${hoy.length ? h`<ul class="oh-tarjetas">${hoy.map((x, i) => h`<li class="oh-tarjeta t${i % 4}">
          <p class="oh-pct">${x.p.pct}<span>%</span></p>
          <p class="oh-cadena">${x.p.cadena}</p>
          <p class="oh-medio">con ${x.p.medio}</p>
          <p class="oh-tope">${pbTope(x.p)}</p>
          ${x.tienda ? h`<button type="button" class="oh-donde" data-act="oferta-mapa" data-k="${x.tienda.id}">${ico('lugar')}a ${A.distTexto(x.tienda.dist)} · ver</button>` : h`<p class="oh-tope">${x.p.detalle || ''}</p>`}
        </li>`)}</ul>` : ''}
      ${manana.length ? h`<p class="oh-manana"><strong>Mañana:</strong> ${manana.slice(0, 4).map(x => `${x.p.pct} % ${x.p.cadena}`).join(' · ')}${manana.length > 4 ? '…' : ''}</p>` : ''}
      ${!pos ? h`<p class="oh-nota">Activá tu ubicación (más abajo) y te muestro cuál te queda más cerca.</p>` : ''}
      <p class="oh-nota">Promos de bancos y billeteras de ${N.nombreMes ? N.nombreMes((E.pb.actualizado || N.hoyISO()).slice(0, 7)) : 'este mes'}. Confirmá condiciones y tope en la app de tu banco. <button type="button" class="enlace" data-act="ofertas-fuentes">Fuentes</button></p>
    </section>`;
  }
  // El cartel corto de arriba de la alacena y de la lista de compras.
  function avisoOfertaHoy() {
    if (!E.pb) { cargarPB(); return ''; }
    const l = ofertasDelDia(new Date().getDay()).filter(x => x.tienda || !(x.p.cadenas || []).length || !C.ultimaPosicion());
    if (!l.length) return '';
    const x = l[0];
    return h`<a class="banda-oferta" href="#novedades" data-tab="novedades"><span class="bo-pct">${x.p.pct}%</span><span><strong>Hoy en ${x.p.cadena}</strong> con ${x.p.medio}${x.tienda ? ` · a ${A.distTexto(x.tienda.dist)}` : ''}${l.length > 1 ? ` · y ${l.length - 1} ${N.plural(l.length - 1, 'oferta más', 'ofertas más')}` : ''}</span><span class="bo-ver">Ver ›</span></a>`;
  }

  /* ---------- novedades ---------- */
  // Lo que hay para contar, con una clave por novedad para saber cuáles ya se vieron en este teléfono.
  function novedades() {
    const hoy = hoyDia(), cambios = A.cambios(V.prods, hoy, 45), ofertas = puedeCerca() ? ofertasCerca() : [];
    const dow = new Date().getDay(), promos = puedeCerca() ? promosVigentes().filter(x => promoDeHoy(x, dow)) : [];
    const claves = cambios.map(c => `p:${c.id}:${hoy - c.hace}`).concat(ofertas.map(x => `c:${x.id}:${x.o.k}:${x.o.dia}`), promos.map(x => `r:${x.id}:${hoy}`));
    return { cambios, ofertas, claves };
  }
  function pintarGloboNovedades() {
    const g = $('#globo-novedades');
    if (!g) return;
    const vistas = new Set(leerLocal('libreta.novVistas', [])), n = E.prodListo && !E.puerta ? novedades().claves.filter(k => !vistas.has(k)).length : 0;
    g.hidden = !n || E.tab === 'novedades';
    g.textContent = n > 9 ? '9+' : String(n);
  }
  function renderNovedades() {
    const hoy = hoyDia(), caja = $('#no-cuerpo'), nov = novedades();
    const inf = A.inflacion(V.prods, hoy, 30, E.ajustes.frecuencia);
    const consejos = [];
    for (const x of V.compras) { const c = ((V.plan && V.plan.porId.get(x.id)) || []).find(k => k.ahorro > 0); if (c) consejos.push({ x, c }); }
    consejos.sort((a, b) => b.c.ahorro - a.c.ahorro);
    $('#no-resumen').textContent = nov.cambios.length ? `${nov.cambios.length} ${N.plural(nov.cambios.length, 'producto cambió', 'productos cambiaron')} de precio en los últimos 45 días` : '';
    if (puedeCerca()) actualizarBarrio();
    const partes = [puedeCerca() ? bloqueOfertasHoy() : '', bloqueBuscador(), puedeCerca() ? bloqueBarrio() : '', bloqueAhorro(), bloqueCanasta(inf), bloquePromos(), bloqueCercaNovedades()];
    if (consejos.length) {
      partes.push(h`<div class="bloque"><h2 class="bloque-t">Para la próxima compra</h2>
        <ul class="consejos">${consejos.slice(0, 8).map(k => h`<li><strong>${k.x.p.nombre}</strong><span class="compra-consejo ${k.c.tipo}">${k.c.texto}</span></li>`)}</ul>
        <a class="enlace" href="#compras" data-tab="compras">Ver la lista de compras</a></div>`);
    }
    if (nov.cambios.length) {
      partes.push(h`<div class="bloque"><h2 class="bloque-t">Cambios de precio</h2><ul class="cambios">${nov.cambios.slice(0, 15).map(filaCambio)}</ul>
        ${nov.cambios.length > 15 ? h`<p class="tenue chico">Y ${nov.cambios.length - 15} más. El detalle de cada uno está en su ficha, en la alacena.</p>` : ''}</div>`);
    }
    const hay = partes.some(x => x && x.__h);
    caja.innerHTML = val(h`${partes}${nov.cambios.length || inf.pct != null ? '' : h`<div class="vacio">${E.conexion === 'esperando' || (E.conexion === 'lista' && !E.prodListo) ? cargando('Cargando lo guardado…') : ''}
      <h3>${hay ? 'Todavía no hay cambios de precio' : 'Acá aparecen los cambios de precio'}</h3>
      <p>Cada vez que anotás lo que pagaste, la libreta compara con la vez anterior: cuánto subió cada cosa, cómo viene la canasta de tu casa y dónde conviene comprar.</p></div>`}${bloqueNotas()}`);
    if (E.prodListo && nov.claves.length) guardarLocal('libreta.novVistas', nov.claves.slice(0, 300));
  }

  /* ---------- alacena ---------- */
  function renderAlacena() {
    const dia = hoyDia(), frec = E.ajustes.frecuencia;
    const filas = V.prods.map(([id, p]) => ({ id, p, a: N.analizar(p, dia, frec) }));
    const falta = filas.filter(f => f.a.motivo).length;
    $('#al-resumen').innerHTML = val(!filas.length ? '' : h`${filas.length} ${N.plural(filas.length, 'producto', 'productos')} · ${falta
      ? h`<a href="#compras" data-tab="compras">${falta} para reponer</a>` : 'no falta nada'}`);
    const cats = N.CATS_ALACENA.filter(c => filas.some(f => catDe(f.p) === c));
    if (!['todo', 'reponer'].includes(E.filtro.chip) && !cats.includes(E.filtro.chip)) E.filtro.chip = 'todo';
    if (E.filtro.chip === 'reponer' && !falta) E.filtro.chip = 'todo';
    const chips = [['todo', 'Todo']].concat(falta ? [['reponer', `Para reponer · ${falta}`]] : [], cats.map(c => [c, N.CATS[c]]));
    $('#al-filtros').hidden = filas.length < 6;
    const cocina = $('#al-cocina');
    if (cocina) cocina.hidden = !hayIA() || !filas.some(f => !f.p.ejemplo && +f.p.stock > 0);
    $('#al-chips').innerHTML = val(chips.map(([v, t]) => h`<button type="button" class="chip" data-act="chip" data-chip="${v}" aria-pressed="${String(E.filtro.chip === v)}">${t}</button>`));

    const bo = $('#al-oferta');
    if (bo) bo.innerHTML = val(puedeCerca() ? avisoOfertaHoy() : '');
    const caja = $('#al-lista');
    if (!filas.length) {
      caja.innerHTML = val(h`<div class="vacio">
        ${E.conexion === 'esperando' || (E.conexion === 'lista' && !E.prodListo) ? cargando('Cargando lo guardado…') : ''}
        <h3>Acá va tu alacena</h3>
        <p>Cada producto con cuánto queda y para cuántos días alcanza según lo que se consume en casa.</p>
        <div class="acciones" data-escribe><button type="button" class="btn btn-principal" data-act="arranque">✓ Empezar rápido: ¿qué hay en tu casa?</button></div>
        <p class="tenue chico">Tildás los básicos en un minuto. También podés tocar <strong>Escanear producto</strong> y ${Datos.camaraEnVivo ? 'apuntar la cámara a su código de barras' : 'sacarle una foto al envase o al código de barras'}.</p></div>`);
      return;
    }
    const q = filas.length < 6 ? '' : N.norm(E.filtro.texto), chip = E.filtro.chip;
    const vis = filas.filter(f => (!q || N.norm(N.textoProducto(f.p)).includes(q))
      && (chip === 'todo' || (chip === 'reponer' ? !!f.a.motivo : catDe(f.p) === chip)));
    if (!vis.length) {
      caja.innerHTML = val(h`<div class="vacio"><h3>Nada coincide</h3><p>No hay productos que coincidan con «${E.filtro.texto.trim()}»${chip !== 'todo' ? ' en este filtro' : ''}.</p></div>`);
      return;
    }
    // recordar dónde estaba el foco para devolverlo después de redibujar
    const activo = document.activeElement, enFila = activo && activo.closest ? activo.closest('#al-lista [data-id]') : null;
    const foco = enFila && activo.dataset.act ? { id: enFila.dataset.id, act: activo.dataset.act } : null;
    const grupos = [];
    if (!filas.some(f => (f.p.log || []).some(e => e[1] > 0))) grupos.push(h`<p class="tenue chico" data-escribe>La libreta aprende de cada cuánto comprás cada cosa. Si querés que avise con más precisión, tocá <strong>−</strong> cuando se termina uno: es optativo.</p>`);
    for (const c of N.CATS_ALACENA) {
      const g = vis.filter(f => catDe(f.p) === c).sort((x, y) => String(x.p.nombre).localeCompare(String(y.p.nombre), 'es'));
      if (!g.length) continue;
      grupos.push(h`<section class="grupo"><h2 class="grupo-t"><span>${N.CATS[c]}</span><span>${g.length}</span></h2>${g.map(filaProducto)}</section>`);
    }
    caja.innerHTML = val(grupos);
    if (foco) {
      const el = $$('#al-lista [data-id]').find(x => x.dataset.id === foco.id);
      const b = el && $(`[data-act="${foco.act}"]`, el);
      if (b && !b.disabled) b.focus({ preventScroll: true });
      else if (el) { const otro = $('[data-act="mas"]', el); if (otro) otro.focus({ preventScroll: true }); }
    }
  }
  function filaProducto(f) {
    const p = f.p, s = N.situacion(f.a), meta = [p.marca, p.presentacion].filter(Boolean).join(' · ');
    return h`<div class="fila" data-id="${f.id}">
      <button type="button" class="fila-txt" data-act="producto" data-id="${f.id}">
        <span class="fila-nombre">${p.nombre}</span>
        ${meta ? h`<span class="fila-meta">${meta}</span>` : ''}
        ${s.etiqueta || s.texto ? h`<span class="fila-estado">${s.etiqueta ? h`<span class="pastilla ${s.tono}">${s.etiqueta}</span>` : ''}${s.texto ? h`<span>${s.texto}</span>` : ''}</span>` : ''}
      </button>
      <div class="contador">
        <button type="button" data-act="menos" data-escribe aria-label="Se usó uno: ${p.nombre}"${atr('disabled', f.a.stock <= 0)}>${ico('menos')}</button>
        <output class="cuenta${f.a.stock <= 0 ? ' cero' : ''}" aria-label="Quedan ${f.a.stock}">${f.a.stock}</output>
        <button type="button" data-act="mas" data-escribe aria-label="Sumar uno: ${p.nombre}">${ico('mas')}</button>
      </div></div>`;
  }

  let rafaga = null;   // toques seguidos sobre el mismo producto, para poder deshacerlos juntos
  function toque(id, du, dc) {
    if (!puede()) return;
    const p = verProd(id);
    if (!p || (du > 0 && p.stock <= 0)) return;
    const ahora = Date.now();
    if (!rafaga || rafaga.id !== id || ahora - rafaga.t > 5000) rafaga = { id, u: 0, c: 0, t: ahora };
    const r = rafaga;
    r.t = ahora;
    // un toque en sentido contrario dentro de la misma ráfaga corrige el anterior
    if (dc > 0 && r.u > 0) { mover(id, { u: -1 }); r.u--; }
    else if (du > 0 && r.c > 0) { mover(id, { c: -1 }); r.c--; }
    else { mover(id, { u: du, c: dc }); r.u += du; r.c += dc; }
    const d = verProd(id), neto = r.c - r.u;
    if (!neto) { avisar(`${d.nombre}: sin cambios, ${N.plural(d.stock, 'queda', 'quedan')} ${d.stock}`); return; }
    avisar(`${d.nombre}: ${neto > 0 ? '+' : '−'}${Math.abs(neto)} · ${N.plural(d.stock, 'queda', 'quedan')} ${d.stock}`, {
      rotulo: 'Deshacer', fn: () => { mover(id, { u: -r.u, c: -r.c }); if (rafaga === r) rafaga = null; avisar('Deshecho'); },
    });
  }

  /* ---------- compras ---------- */
  // Arriba del total: cuánto se puede ahorrar y dónde, y qué hacer si la compra no entra en el presupuesto.
  function bloquePlan() {
    const pl = V.plan, partes = [];
    if (!pl) return '';
    if (pl.ahorro >= 1) {
      partes.push(h`<p><strong>Podés ahorrar unos ${N.plata(pl.ahorro, true)}</strong> comprando donde está más barato:</p>
        <ul class="plan-comercios">${pl.comercios.map(c => h`<li><span>${c.comercio || (c.oferta && c.oferta.dist != null ? `Un comercio a ${A.distTexto(c.oferta.dist)}` : 'Un comercio de tu zona')}</span>
          <span class="tenue">${c.productos} ${N.plural(c.productos, 'producto', 'productos')} · ${N.plata(c.ahorro, true)} menos</span></li>`)}</ul>`);
    }
    const pr = pl.presupuesto;
    if (pr && pr.excede) {
      partes.push(h`<p>${pr.resto > 0 ? h`Del presupuesto del mes quedan <strong>${N.plata(pr.resto, true)}</strong> y esta compra suma unos ${N.plata(pl.total, true)}.` : h`<strong>El presupuesto del mes ya está gastado.</strong>`}
        ${pr.postergar.length ? ` Se puede dejar para la próxima: ${pr.postergar.map(x => x.nombre).join(', ')}.` : ''}</p>`);
    }
    if (!partes.length) return '';
    const enMapa = puedeCerca() && pl.comercios.some(c => c.oferta);
    return h`<div class="bloque plan"><h2 class="bloque-t">Para gastar menos</h2>${partes}
      ${enMapa ? h`<div class="acciones"><button type="button" class="btn btn-chico" data-act="mapa-lista">${ico('mapa')}Ver en el mapa</button></div>` : ''}</div>`;
  }
  function renderCompras() {
    const frec = E.ajustes.frecuencia, compras = V.compras, pl = V.plan;
    const voy = $('#co-voy');
    if (voy) voy.hidden = !Datos.notas || !E.db;
    const bo = $('#co-oferta');
    if (bo) bo.innerHTML = val(puedeCerca() ? avisoOfertaHoy() : '');
    for (const b of $$('#co-frec button')) b.setAttribute('aria-pressed', String(+b.dataset.frec === frec));
    const enLista = new Set(compras.map(x => x.id));
    for (const id of [...E.marcados]) if (!enLista.has(id) && E.prodListo) E.marcados.delete(id);
    $('#co-resumen').textContent = compras.length ? `${compras.length} ${N.plural(compras.length, 'producto', 'productos')} para ${FREC_HASTA[frec] || 'la próxima compra'}` : '';
    const caja = $('#co-lista');
    if (!compras.length) {
      caja.innerHTML = val(h`${V.prods.length
        ? h`<div class="vacio"><h3>No hace falta comprar nada</h3><p>Con lo que hay en la alacena alcanza para ${FREC_HASTA[frec] || `los próximos ${frec} días`}. A medida que se vaya usando, acá aparece qué reponer y cuánto.</p></div>`
        : h`<div class="vacio">${E.conexion === 'esperando' ? cargando('Cargando lo guardado…') : ''}<h3>Acá aparece qué comprar</h3>
          <p>La lista se arma sola con lo que se terminó o está por terminarse, y sugiere cuánto llevar según el ritmo de consumo de la casa.</p></div>`}${bloqueNotas()}`);
      return;
    }
    let marcados = 0;
    const fila = x => {
      const p = x.p, m = E.marcados.has(x.id), meta = [p.marca, p.presentacion].filter(Boolean).join(' · '), c = ((pl && pl.porId.get(x.id)) || [])[0];
      if (m) marcados++;
      return h`<label class="compra${m ? ' marcada' : ''}">
        <input type="checkbox" data-cambio="marcar" data-id="${x.id}"${atr('checked', m)}>
        <span class="compra-nombre">${p.nombre}${meta ? h` <span class="tenue">· ${meta}</span>` : ''}</span>
        <span class="compra-cant"><mark>×${x.a.cant}</mark></span>
        <span class="compra-razon">${N.razon(x.a)}</span>
        ${x.costo != null ? h`<span class="compra-costo">≈ ${N.plata(x.costo, true)}</span>` : ''}
        ${c ? h`<span class="compra-consejo ${c.tipo}">${c.texto}</span>` : ''}
      </label>`;
    };
    // Con compras grandes (semanal o más), lo del día a día va aparte: se compra en el almacén o la verdulería de la vuelta.
    const diarias = frec > 3 ? compras.filter(x => x.a.diario) : [], grandes = frec > 3 ? compras.filter(x => !x.a.diario) : compras;
    const filas = !diarias.length ? h`<div class="grupo">${compras.map(fila)}</div>`
      : h`<section class="grupo"><h2 class="grupo-t"><span>Del día a día</span><span>${diarias.length}</span></h2>${diarias.map(fila)}</section>
        ${grandes.length ? h`<section class="grupo"><h2 class="grupo-t"><span>Para ${FREC_HASTA[frec]}</span><span>${grandes.length}</span></h2>${grandes.map(fila)}</section>` : ''}`;
    const total = pl ? pl.total : 0, sinPrecio = pl ? pl.sinPrecio : 0;
    caja.innerHTML = val(h`${avisoPromosHoy()}<p class="tenue chico">Tildá lo que vayas poniendo en el changuito.</p>
      ${filas}
      ${bloquePlan()}
      <div class="pie-compras">
        <p class="estimado">${total > 0 ? h`<span>Estimado</span><strong>${N.plata(total, true)}</strong>` : ''}
          ${sinPrecio ? h`<span class="tenue">${total > 0 ? 'sin contar ' : ''}${sinPrecio} ${N.plural(sinPrecio, 'producto', 'productos')} sin precio cargado</span>` : ''}</p>
        <div class="acciones">
          <button type="button" class="btn" data-act="copiar-lista">${ico('copiar')}Copiar la lista</button>
          <button type="button" class="btn btn-principal" data-act="sumar-marcados" data-escribe${atr('disabled', !marcados)}>${ico('ok')}Ya lo compré${marcados ? ` (${marcados})` : ''}</button>
        </div>
      </div>
      ${bloqueNotas()}`);
  }
  function textoLista() {
    const l = V.compras.map(x => `• ${x.a.cant} × ${N.textoProducto(x.p)}`);
    return `Lista de compras (${N.fechaCorta(N.hoyISO())})\n${l.join('\n')}`;
  }
  /* «Ya lo compré»: antes de sumar a la alacena se confirma cuánto se llevó de cada cosa, a qué precio y dónde.
     Con eso quedan el stock, el historial de precios y, si se quiere, el gasto. */
  function abrirCompra() {
    if (!puede()) return;
    const marcados = V.compras.filter(x => E.marcados.has(x.id));
    if (!marcados.length) return;
    pintarComercios();
    abrirHoja({ tipo: 'compra', comercio: ultimoComercio(), gasto: true, items: marcados.map(x => ({ id: x.id, cant: String(x.a.cant), precio: x.p.precio > 0 ? N.campoPlata(x.p.precio) : '' })) });
  }
  function textoTotalCompra(H) {
    let total = 0, sin = 0;
    for (const it of H.items) { const v = N.aNumero(limpio(it.precio)); if (v > 0) total += v * entero(it.cant, 1, 1); else sin++; }
    return `${N.plata(total, true)}${sin ? ` · ${sin} sin precio` : ''}`;
  }
  async function guardarCompra() {
    const H = E.hoja;
    if (!H || H.tipo !== 'compra' || H.ocupado || !puede()) return;
    const comercio = limpio(H.comercio).slice(0, 60), hoy = hoyDia(), lista = [];
    for (let i = 0; i < H.items.length; i++) {
      const it = H.items[i], p = verProd(it.id);
      if (!p) continue;
      const txt = limpio(it.precio), precio = txt ? N.aNumero(txt) : 0;
      if (txt && !(precio > 0)) return errorHoja(`El precio de «${p.nombre}» no se entiende. Escribilo así: 1.450,50`, 'cp-p-' + i);
      const c = precio > 0 ? A.comparar(p, precio, hoy) : null;
      lista.push({ id: it.id, p, nombre: p.nombre, marca: p.marca || '', cant: entero(it.cant, 1, 1), precio: precio > 0 ? N.redondear2(precio) : 0, antes: c ? c.antes : null, pct: c ? c.pct : null, dias: c ? c.dias : null });
    }
    if (!lista.length) { cerrarHoja(); return; }
    ocupar(true);
    const hechos = [];
    for (const x of lista) if (await mover(x.id, { c: x.cant }, x.precio > 0 ? precioDe(x.precio, comercio) : null, true)) hechos.push(x);
    for (const x of hechos) E.marcados.delete(x.id);
    guardarLocal('libreta.marcados', [...E.marcados]);
    if (hechos.some(x => x.precio > 0)) recordarComercio(comercio);
    const total = N.redondear2(hechos.reduce((t, x) => t + x.precio * x.cant, 0));
    let gasto = false;
    if (H.gasto && total > 0) {
      const doc = {
        comercio: comercio || 'Compra', fecha: N.hoyISO(), total, cat: null, origen: 'lista', creado: new Date().toISOString(),
        items: hechos.filter(x => x.precio > 0).map(x => ({ n: N.textoProducto(x.p), c: x.cant, i: N.redondear2(x.precio * x.cant), cat: catDe(x.p) })),
      };
      const lugar = refDeComercio(comercio);
      if (lugar) doc.ref = lugar;
      try {
        const ref = E.db.collection('tickets').doc();
        await escribir(() => ref.set(doc));
        E.tickets = [{ id: ref.id, ...doc }].concat(E.tickets.filter(t => t.id !== ref.id)).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
        gasto = true;
      } catch (e) { avisar(textoFallo(e)); }
    }
    if (hechos.length) trasGuardarPropio();
    const resumen = { tipo: 'compra-hecha', ocupado: false, error: '', sucio: false, total, gasto, comercio, fallidos: lista.length - hechos.length,
      hechos: hechos.map(x => ({ id: x.id, nombre: x.nombre, marca: x.marca, cant: x.cant, precio: x.precio, ahora: x.precio, antes: x.antes, pct: x.pct, dias: x.dias })) };
    if (E.hoja === H) cambiarHoja(resumen);
    else if (hechos.length) avisar(`${hechos.length} ${N.plural(hechos.length, 'producto sumado', 'productos sumados')} a la alacena`);
    pintar();
    const con = hechos.filter(x => x.precio > 0);
    if (con.length) trasCompra(con.map(x => ({ id: x.id, precio: x.precio, cant: x.cant })), comercio).then(r => { if (r && E.hoja === H && H.tipo === 'compra-hecha') { H.cerca = r; renderHoja(); } });
  }

  /* ---------- gastos ---------- */
  function renderGastos() {
    const caja = $('#ga-cuerpo'), tk = V.tickets, hoyI = N.hoyISO(), mesHoy = N.mesDe(hoyI);
    if (!tk.length) {
      caja.innerHTML = val(h`<div class="vacio">${E.conexion === 'esperando' || (E.conexion === 'lista' && !E.ticListo) ? cargando('Cargando lo guardado…') : ''}
        <h3>Acá se ve el gasto mes a mes</h3>
        <p>${Datos.local ? 'Cargá cada gasto con su total y, si querés, con la foto del ticket. Con eso la libreta arma el gasto de cada mes y en qué se fue.'
          : 'Subí la foto de un ticket y la libreta anota el comercio, la fecha, el total y cada producto. Con eso arma el gasto de cada mes y en qué se fue.'}</p></div>`);
      return;
    }
    const tot = N.totalesPorMes(tk), mesesCon = [...tot.keys()].sort();
    const primero = mesesCon[0] < mesHoy ? mesesCon[0] : mesHoy, ultimo = mesesCon[mesesCon.length - 1] > mesHoy ? mesesCon[mesesCon.length - 1] : mesHoy;
    if (!E.mes || E.mes < primero || E.mes > ultimo) E.mes = mesHoy;
    const mes = E.mes, total = tot.get(mes) || 0, esActual = mes === mesHoy, diaHoy = +hoyI.slice(8, 10);
    const previo = N.sumarMes(mes, -1);
    let nota = '';
    if (esActual) {
      const a = N.gastoHasta(tk, mes, diaHoy), b = N.gastoHasta(tk, previo, diaHoy);
      nota = h`En lo que va del mes${b > 0 && Math.abs(a - b) >= 1 ? h` · <strong class="${a > b ? 'rojo' : 'verde'}">${N.plata(Math.abs(a - b), true)} ${a > b ? 'más' : 'menos'}</strong> que ${N.soloMes(previo)} al día ${diaHoy}` : ''}`;
    } else {
      const b = tot.get(previo) || 0;
      nota = b > 0 && total > 0 ? h`<strong class="${total > b ? 'rojo' : 'verde'}">${N.num(Math.abs(total / b - 1) * 100)} % ${total > b ? 'más' : 'menos'}</strong> que ${N.soloMes(previo)}` : 'Total del mes';
    }
    const pres = E.ajustes.presupuesto;
    let bloquePres = '';
    if (pres > 0) {
      const resto = pres - total, pct = Math.min(100, total / pres * 100), diasQuedan = N.diasDelMes(mes) - diaHoy + 1;
      bloquePres = h`<div class="presupuesto"><div class="riel${resto < 0 ? ' pasado' : ''}" role="img" aria-label="${Math.round(total / pres * 100)} % del presupuesto"><i data-ancho="${pct.toFixed(1)}"></i></div>
        <p>${resto < 0 ? h`<strong class="rojo">${N.plata(-resto, true)} por encima</strong> del presupuesto de ${N.plata(pres, true)}`
          : esActual ? h`Quedan <strong>${N.plata(resto, true)}</strong> de ${N.plata(pres, true)} · ${N.plata(resto / diasQuedan, true)} por día hasta fin de mes`
            : h`Se usó el ${Math.round(total / pres * 100)} % del presupuesto de ${N.plata(pres, true)}`}</p></div>`;
    } else if (!E.lectura) bloquePres = h`<button type="button" class="enlace" data-act="ajustes" data-escribe>Poner un presupuesto mensual</button>`;

    // ventana de meses del gráfico
    const ancho = Math.max(240, Math.min(752, (caja.clientWidth || 340)) - 31);
    let n = 6;
    if (ancho >= 560) { let m = primero; n = 1; while (m < ultimo && n < 12) { m = N.sumarMes(m, 1); n++; } n = Math.max(6, n); }
    let fin = ultimo;
    if (mes < N.sumarMes(fin, -(n - 1))) fin = N.sumarMes(mes, n - 1);
    const datos = [];
    for (let i = n - 1; i >= 0; i--) { const m = N.sumarMes(fin, -i); datos.push({ mes: m, total: tot.get(m) || 0 }); }

    const cats = N.porCategoria(tk, mes), maxCat = cats.length ? cats[0].monto : 1;
    const delMes = tk.filter(t => N.fechaValida(t.fecha) && N.mesDe(t.fecha) === mes);
    const canasta = esActual ? bloqueCanasta(A.inflacion(V.prods, hoyDia(), 30, E.ajustes.frecuencia)) : '';
    caja.innerHTML = val(h`<div class="bloque">
        <div class="mes-nav">
          <button type="button" class="icono-btn" data-act="mes-mover" data-d="-1" aria-label="Mes anterior"${atr('disabled', mes <= primero)}>${ico('izq')}</button>
          <h2>${N.nombreMes(mes)}</h2>
          <button type="button" class="icono-btn" data-act="mes-mover" data-d="1" aria-label="Mes siguiente"${atr('disabled', mes >= ultimo)}>${ico('der')}</button>
        </div>
        <p class="mes-total">${N.plata(total, true)}</p>
        <p class="mes-nota">${nota}</p>
        ${bloquePres}
      </div>
      ${canasta}
      <div class="bloque">
        <h2 class="bloque-t">Mes a mes</h2>
        ${grafico(datos, mes, pres, ancho)}
        ${pres > 0 ? h`<p class="leyenda"><i></i>Presupuesto mensual: ${N.plata(pres, true)}</p>` : ''}
      </div>
      ${cats.length ? h`<div class="bloque"><h2 class="bloque-t">En qué se fue</h2><div class="cats">${cats.map(c => h`<div class="cat">
          <span class="cat-nombre">${N.CATS[c.cat]}</span><span class="cat-monto">${N.plata(c.monto, true)} <small>${Math.round(c.monto / total * 100)} %</small></span>
          <span class="cat-riel"><i data-ancho="${(c.monto / maxCat * 100).toFixed(1)}"></i></span></div>`)}</div></div>` : ''}
      <div class="bloque">
        <h2 class="bloque-t">Tickets de ${N.soloMes(mes)}</h2>
        ${delMes.length ? h`<div class="t-lista">${delMes.map(t => h`<button type="button" class="t-fila" data-act="ticket-ver" data-id="${t.id}">
            <span class="t-fecha">${N.fechaCorta(t.fecha)}</span><span class="t-comercio">${t.comercio || 'Compra'}</span><span class="t-monto">${N.plata(+t.total || 0, true)}</span>
            <span class="t-detalle">${(t.items || []).length ? `${t.items.length} ${N.plural(t.items.length, 'renglón', 'renglones')}` : N.CATS[t.cat] || 'Sin detalle'}</span></button>`)}</div>`
          : h`<p class="tenue">No hay tickets cargados en este mes.</p>`}
      </div>`);
    for (const el of $$('[data-ancho]', caja)) el.style.width = el.dataset.ancho + '%';
  }
  function grafico(datos, sel, pres, W) {
    const H = 214, arriba = 24, abajo = 26, n = datos.length;
    const maximo = Math.max(pres || 0, ...datos.map(d => d.total));
    const tope = N.escala(maximo > 0 ? maximo : 1).tope, alto = H - arriba - abajo;
    const y = v => arriba + alto * (1 - v / tope);
    const hueco = W / n, bw = Math.min(56, hueco * 0.64), conPeso = hueco >= 66;
    const partes = [];
    datos.forEach((d, i) => {
      const cx = hueco * i + hueco / 2, yy = d.total > 0 ? Math.min(y(d.total), H - abajo - 3) : H - abajo - 2;
      const rotulo = N.mesCorto(d.mes) + (d.mes.slice(5) === '01' || i === 0 ? ` ${d.mes.slice(2, 4)}` : '');
      partes.push(h`<g class="${d.mes === sel ? 'g-sel' : ''}" data-act="mes" data-mes="${d.mes}" role="button" tabindex="0" aria-label="${N.nombreMes(d.mes)}: ${N.plata(d.total, true)}"${atr('aria-current="true"', d.mes === sel)}>
        <rect class="g-toque" x="${(hueco * i).toFixed(1)}" y="0" width="${hueco.toFixed(1)}" height="${H}"/>
        <rect class="g-barra" x="${(cx - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${(H - abajo - yy).toFixed(1)}" rx="2"/>
        ${d.total > 0 ? h`<text x="${cx.toFixed(1)}" y="${(yy - 6).toFixed(1)}" text-anchor="middle">${N.plataCorta(d.total, conPeso)}</text>` : ''}
        <text x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle">${rotulo}</text></g>`);
    });
    return h`<svg class="grafico" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="group" aria-label="Gasto por mes">
      ${pres > 0 ? h`<line class="g-pres" x1="0" x2="${W}" y1="${y(pres).toFixed(1)}" y2="${y(pres).toFixed(1)}"/>` : ''}
      ${partes}
      <line class="g-base" x1="0" x2="${W}" y1="${H - abajo}" y2="${H - abajo}"/></svg>`;
  }

  /* ---------- hojas (diálogos) ---------- */
  let focoPrevio = null;
  function soltarHoja() {
    const H = E.hoja;
    if (!H) return;
    E.turno++;
    detenerCamara(H);
    if (H.ctl) { try { H.ctl.abort(); } catch (e) { /* ya estaba cancelado */ } }
    for (const u of H.urls || []) URL.revokeObjectURL(u);
    for (const x of [H, H.sub]) if (x && x.mapa) { try { x.mapa.destruir(); } catch (e) { /* el mapa ya no estaba */ } x.mapa = null; }
    for (const x of [H, H.sub]) if (x && x.alSoltar) { try { x.alSoltar(); } catch (e) { /* ya no escuchaba */ } x.alSoltar = null; }
    if (H.sub) clearTimeout(H.sub.reloj);
  }
  function abrirHoja(estado) {
    if (!E.hoja) focoPrevio = document.activeElement;
    soltarHoja();
    E.hoja = estado;
    $('#tostada').hidden = true; E.tostadaFn = null;
    $('#fondo-hoja').hidden = false;
    document.documentElement.classList.add('con-hoja');
    renderHoja(true);
  }
  function cambiarHoja(cambios) {
    if (!E.hoja) return;
    Object.assign(E.hoja, cambios);
    renderHoja(true);
  }
  function cerrarHoja() {
    soltarHoja();
    E.hoja = null; E.codigoPara = null;
    $('#fondo-hoja').hidden = true;
    $('#hoja').innerHTML = '';
    document.documentElement.classList.remove('con-hoja');
    if (focoPrevio && document.contains(focoPrevio)) { try { focoPrevio.focus({ preventScroll: true }); } catch (e) { /* el foco no es esencial */ } }
    focoPrevio = null;
  }
  function renderHoja(arriba) {
    const H = E.hoja, el = $('#hoja');
    if (!H) return;
    // `sub`: una hoja encima de esta (elegir el comercio, ver el mapa); al cerrarla se vuelve a la de abajo como estaba
    const X = H.sub || H;
    if (X.tipo === 'mapa' && X.mapa) { pintarFichaMapa(X); return; }      // el mapa no se redibuja: cada vez sería abrirlo de nuevo
    if (X.tipo === 'comercio' && X.paso === 'marcar' && X.mapa) return;     // el de marcar un comercio, tampoco
    // si se redibuja mientras alguien escribe (llegaron los precios de la zona), el cursor sigue donde estaba
    const ae = document.activeElement, foco = !arriba && ae && ae.id && el.contains(ae) ? ae.id : '';
    let sel = null;
    try { if (foco && ae.selectionStart != null) sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { sel = null; }
    el.innerHTML = val(VISTAS[X.tipo](X, H));
    if (arriba) { el.scrollTop = 0; el.focus({ preventScroll: true }); }
    else if (foco) {
      const n = document.getElementById(foco);
      if (n && el.contains(n)) { n.focus({ preventScroll: true }); try { if (sel) n.setSelectionRange(sel[0], sel[1]); } catch (e) { /* no es de texto */ } }
    }
  }
  function errorHoja(texto, idCampo) {
    const H = E.hoja;
    if (!H) return;
    H.error = texto; H.ocupado = false;
    renderHoja();
    const c = idCampo && document.getElementById(idCampo), e = $('#hoja .error');
    if (c) c.focus(); else if (e) e.scrollIntoView({ block: 'nearest' });
  }
  function ocupar(si, texto) {
    const H = E.hoja;
    if (!H) return;
    H.ocupado = si; H.ocupadoTexto = texto || '';
    if (si) H.error = '';
    for (const b of $$('#hoja .hoja-pie .btn')) b.disabled = si;
    const p = $('#hoja [data-progreso]');
    if (p) p.textContent = si ? (texto || 'Guardando…') : p.dataset.progreso;
  }
  const marco = (titulo, cuerpo) => h`<div class="hoja-cabeza"><h2 id="hoja-titulo">${titulo}</h2>
    <button type="button" class="icono-btn" data-act="cerrar" aria-label="Cerrar">${ico('x')}</button></div>${cuerpo}`;

  const VISTAS = {
    producto(H) {
      const f = H.f, p = H.id ? verProd(H.id) : null;
      let dato = '';
      if (p) {
        const a = N.analizar(p, hoyDia(), E.ajustes.frecuencia), l = [];
        if (a.modo === 'uso') l.push(h`<span>Se usa <strong>${N.ritmoTexto(a.ritmo)}</strong> (según lo anotado en los últimos ${N.VENTANA} días).</span>`);
        else if (a.modo === 'compra') l.push(h`<span>Sin consumo anotado: se estima por las compras, <strong>cada ~${Math.max(1, Math.round(a.cadaDias))} días</strong>.</span>`);
        else l.push(h`<span>Todavía no hay datos de consumo. Se aprende solo de cada cuánto lo comprás; si querés, tocá − en la alacena cuando se termina uno.</span>`);
        l.push(h`<span class="acciones"><button type="button" class="btn btn-chico${a.pedido ? '' : ' btn-principal'}" data-act="pedir" data-id="${H.id}" data-escribe>${a.pedido ? 'Sacar de la lista' : 'Anotar en la lista'}</button></span>`);
        dato = h`<div class="dato">${l}</div>${bloqueAlerta(H.id, p)}${bloquePrecios(H.id, p)}`;
      }
      const par = H.parecido ? verProd(H.parecido) : null;
      return marco(H.id ? 'Editar producto' : 'Producto nuevo', h`<form class="form" data-form="producto" novalidate>
        ${H.mini ? h`<div class="conocido"><img class="mini" src="${H.mini}" alt=""><div><p class="chico">${H.aviso || ''}</p>
          ${H.puedeDetalle ? h`<button type="button" class="enlace" data-act="leer-detalle">Leer la foto otra vez, con más detalle</button>` : ''}</div></div>`
          : H.aviso ? h`<p class="nota gris">${H.aviso}</p>` : ''}
        ${campo('Nombre', h`<input type="text" id="p-nombre" data-k="f.nombre" value="${f.nombre}" maxlength="80" autocomplete="off" placeholder="Leche entera">`)}
        <div class="dos">
          ${campo('Marca', h`<input type="text" id="p-marca" data-k="f.marca" value="${f.marca}" maxlength="50" autocomplete="off">`)}
          ${campo('Tamaño', h`<input type="text" id="p-presentacion" data-k="f.presentacion" value="${f.presentacion}" maxlength="30" autocomplete="off" placeholder="1 L">`)}
        </div>
        ${campo('Categoría', h`<select id="p-categoria" data-k="f.categoria">${opciones(N.CATS_ALACENA.map(c => [c, N.CATS[c]]), f.categoria)}</select>`)}
        <div class="dos">
          ${campoPaso('Cuántos hay', 'p-stock', 'f.stock', f.stock, 0)}
          ${campoPaso('Avisar si quedan', 'p-aviso', 'f.aviso', f.aviso, 0)}
        </div>
        <div class="dos">
          ${campo('Precio por unidad', h`<input type="text" id="p-precio" data-k="f.precio" value="${f.precio}" inputmode="decimal" autocomplete="off" placeholder="Opcional">`)}
          ${campo('Código de barras', h`<input type="text" id="p-codigo" data-k="f.codigo" value="${f.codigo}" inputmode="numeric" autocomplete="off" placeholder="Opcional">`)}
        </div>
        <small class="nota-precio" id="p-nota" data-nota-de="p-precio" data-prod="${H.id || ''}">${H.id && H.f0 && f.precio !== H.f0.precio ? notaPrecio(H.id, f.precio) : ''}</small>
        ${campoComercio('p-comercio', 'f.comercio', f.comercio)}
        <label class="casilla"><input type="checkbox" id="p-reponer" data-k="f.reponer"${atr('checked', f.reponer)}><span>Recomendar la compra cuando falte</span></label>
        <label class="casilla"><input type="checkbox" id="p-diario" data-k="f.diario"${atr('checked', f.diario)}><span>Lo compro en el día a día <small class="tenue">· se sugiere para un par de días, no para toda la compra grande</small></span></label>
        <label class="casilla"><input type="checkbox" id="p-marca-fija" data-k="f.marcaFija"${atr('checked', f.marcaFija)}><span>Prefiero esta marca <small class="tenue">· no sugerirme otras más baratas</small></span></label>
        ${dato}
        ${par ? h`<div class="nota"><p>Ya hay uno parecido en la alacena: <strong>${N.textoProducto(par)}</strong> (${par.stock} en stock).</p>
          <div class="hoja-pie"><button type="button" class="btn btn-chico" data-act="sumar-parecido">Sumar a ese</button><button type="button" class="btn btn-chico" data-act="guardar-igual">Guardar como otro</button></div></div>` : ''}
        ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
        ${H.borrar ? h`<div class="nota"><p>¿Borrar <strong>${f.nombre}</strong> de la alacena? Se pierde su historial de consumo.</p>
          <div class="hoja-pie"><button type="button" class="btn btn-chico" data-act="no-borrar">No</button><button type="button" class="btn btn-chico btn-peligro" data-act="borrar-producto-si">Sí, borrar</button></div></div>`
          : h`<div class="hoja-pie">
            ${H.id ? h`<button type="button" class="btn btn-peligro" data-act="borrar-producto">Borrar</button>` : ''}
            <button type="submit" class="btn btn-principal">Guardar</button></div>`}
      </form>`);
    },

    escanear(H) {
      const titulo = H.codigoPara ? 'Código de barras' : H.modo === 'precio' ? '¿Está a buen precio?' : 'Escanear producto';
      if (H.estado === 'gondola') return vistaGondola(H);
      if (H.estado === 'suelto') return vistaSuelto(H);
      if (H.estado === 'camara') {
        return marco(titulo, h`<div class="hoja-cuerpo">
          <div class="visor"><video id="visor-video" playsinline muted autoplay aria-label="Lo que ve la cámara"></video><div class="visor-guia" aria-hidden="true"></div></div>
          <p class="leyendo-paso" id="visor-estado" role="status"><span class="giro"></span><span>Abriendo la cámara…</span></p>
          ${H.modo === 'precio' ? enlaceSinCodigo : ''}
          <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Cancelar</button>
            <button type="button" class="btn" data-act="${H.codigoPara ? 'foto-codigo' : 'foto-prod-gal'}">${ico('imagen')}Usar una foto</button></div></div>`);
      }
      if (H.estado === 'leyendo') {
        const paso = { codigo: 'Buscando el código de barras…', buscando: 'Buscando el producto por su código…', guardando: 'Guardando el código…' }[H.paso] || 'Leyendo la etiqueta…';
        return marco(titulo, h`<div class="leyendo">${H.mini ? h`<img class="mini" src="${H.mini}" alt="">` : ''}
          <div><p class="leyendo-paso"><span class="giro"></span>${paso}</p>
          <button type="button" class="btn btn-chico" data-act="cancelar-lectura">Cancelar</button></div></div>`);
      }
      if (H.estado === 'conocido') {
        const p = verProd(H.id) || {};
        return marco(titulo, h`<form class="form" data-form="conocido" novalidate>
          <div class="conocido">${H.mini ? h`<img class="mini" src="${H.mini}" alt="">` : ''}<div>
            <p class="rotulo">Ya está en la alacena</p><p class="conocido-nombre">${p.nombre}</p>
            <p class="tenue chico">${[p.marca, p.presentacion, `hay ${p.stock || 0}`].filter(Boolean).join(' · ')}</p></div></div>
          <div class="dos">
            ${campoPaso('Cuántos sumar', 'c-cant', 'cant', H.cant, 1)}
            ${campo('Precio por unidad', h`<input type="text" id="c-precio" data-k="precio" value="${H.precio}" inputmode="decimal" autocomplete="off" placeholder="Opcional">`)}
          </div>
          <small class="nota-precio" id="c-nota" data-nota-de="c-precio" data-prod="${H.id}">${notaPrecio(H.id, H.precio)}</small>
          ${campoComercio('c-comercio', 'comercio', H.comercio || '')}
          ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
          <div class="hoja-pie"><button type="button" class="btn" data-act="no-es-este">No es este</button>
            <button type="submit" class="btn btn-principal">Sumar a la alacena</button></div></form>`);
      }
      const viva = camaraViva(), tactil = dedoGrueso();
      if (H.estado === 'hecho') {
        return marco(titulo, h`<div class="${H.fallo ? 'nota gris' : 'hecho'}">${H.fallo ? '' : ico('ok')}<p>${H.texto}</p></div>
          ${bloqueCercaDe(H)}
          ${H.sinCodigo ? h`<div class="dato"><span>Para que la próxima vez alcance con el código de barras, ${viva ? 'escaneá' : 'sacale una foto a'} el código de este producto.</span>
            <button type="button" class="enlace" data-act="pedir-codigo">${!H.fallo ? 'Sumarle el código de barras' : viva ? 'Probar otra vez' : 'Probar con otra foto del código'}</button></div>` : ''}
          ${H.modo === 'precio' && puedeCerca() && refDeComercio(limpio(H.comercio || '')) ? h`<div class="dato"><span>¿Ves otros precios en ${limpio(H.comercio)}? Confirmá con un toque los que cargaron otros hogares.</span>
            <button type="button" class="enlace" data-act="confirmar" data-k="${refDeComercio(limpio(H.comercio))}">Confirmar precios de acá</button></div>` : ''}
          <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Listo</button>
            <button type="button" class="btn btn-principal" data-act="${viva ? 'camara' : tactil ? 'foto-prod-cam' : 'foto-prod-gal'}">${ico('escanear')}Escanear otro</button></div>`);
      }
      // `viva`: se escanea con la cámara en directo · si no, con una foto (del celular o de un archivo)
      return marco(titulo, h`<div class="hoja-cuerpo">
        ${H.nota ? h`<p class="error" role="alert">${H.nota}</p>` : ''}
        ${Lector.etiquetas() ? h`<p><strong>Producto nuevo:</strong> foto del frente del envase, para leer el nombre, la marca y el tamaño.</p>
          <p><strong>Uno que ya cargaste:</strong> alcanza con la foto del código de barras, o del frente otra vez.</p>`
          : H.modo === 'precio' ? h`<p>${viva ? 'Apuntá la cámara al' : 'Sacale una foto al'} <strong>código de barras</strong> del producto. Escribí el precio que ves y te digo si conviene y dónde está más barato cerca.</p>`
          : h`<p>${viva ? 'Apuntá la cámara al' : 'Sacale una foto al'} <strong>código de barras</strong> del producto. Si ya está en la alacena, se le suman unidades; si es nuevo, ${
            Lector.porCodigo ? 'se busca su nombre por el código para que lo confirmes' : 'completás sus datos una sola vez'}.</p>`}
        <div class="elegir">
          ${viva ? h`<button type="button" class="btn btn-principal btn-grande" data-act="camara">${ico('escanear')}Usar la cámara</button>` : ''}
          ${tactil && !viva ? h`<button type="button" class="btn btn-principal btn-grande" data-act="foto-prod-cam">${ico('camara')}Sacar foto</button>` : ''}
          <button type="button" class="btn btn-grande${viva || tactil ? '' : ' btn-principal'}" data-act="foto-prod-gal">${ico('imagen')}Elegir una foto</button>
        </div>
        ${tactil ? '' : h`<p class="tenue chico">También se puede arrastrar o pegar una imagen acá.${viva ? '' : Datos.camaraEnVivo ? ' Desde el celular se escanea directamente con la cámara.' : ' Desde el celular, este mismo botón abre la cámara.'}</p>`}
        ${!Lector.etiquetas() && !Lector.porCodigo && Lector.textos.sinEtiquetas ? h`<p class="nota gris">${Lector.textos.sinEtiquetas}</p>` : ''}
        ${camaraPosible() && !sinCamara && (camaraFallo || camaraDudosa) ? h`<button type="button" class="enlace" data-act="camara">${camaraFallo ? 'Probar la cámara otra vez' : 'Usar la cámara de esta computadora'}</button>` : ''}
        ${H.modo === 'precio' ? enlaceSinCodigo : h`<button type="button" class="enlace" data-act="producto-nuevo">Cargar a mano, sin foto</button>`}</div>`);
    },

    ticket(H) {
      if (H.estado === 'leyendo') {
        return marco('Subir ticket', h`<div class="leyendo"><div class="minis">${H.minis.map(u => h`<img class="mini" src="${u}" alt="">`)}</div>
          <div><p class="leyendo-paso"><span class="giro"></span><span id="t-progreso">Leyendo el ticket…</span></p>
          <p class="tenue chico">Suele tardar menos de un minuto. Después podés revisar y corregir todo antes de guardar.</p>
          <button type="button" class="btn btn-chico" data-act="cancelar-lectura">Cancelar</button></div></div>`);
      }
      if (H.estado === 'revisar') return VISTAS.revisar(H);
      // `lee`: la foto se lee sola · `adjunta`: la foto queda guardada y los datos se completan a mano
      const lee = Lector.tickets(), adjunta = !lee && !!Datos.fotos, tactil = dedoGrueso();
      return marco('Subir ticket', h`<div class="hoja-cuerpo">
        ${H.nota ? h`<p class="error" role="alert">${H.nota}</p>` : ''}
        ${lee ? h`<p>Sacale una foto al ticket, <strong>entero y derecho</strong>. La libreta lee el comercio, la fecha, el total y cada producto, y te lo muestra para revisar antes de guardar.</p>`
          : adjunta ? h`<p>Elegí la foto del ticket: queda guardada junto al gasto. El comercio, la fecha y el total los completás mirando la foto.</p>`
            : h`<p class="nota gris">${Lector.textos.sinTickets}</p>`}
        ${lee || adjunta ? h`<div class="elegir">
            ${tactil ? h`<button type="button" class="btn btn-principal btn-grande" data-act="foto-tic-cam">${ico('camara')}Sacar foto</button>` : ''}
            <button type="button" class="btn btn-grande${tactil ? '' : ' btn-principal'}" data-act="foto-tic-gal">${ico('imagen')}${lee ? 'Elegir fotos' : 'Elegir una foto'}</button>
          </div>
          ${tactil ? '' : h`<p class="tenue chico">También se puede arrastrar o pegar la imagen acá. Desde el celular, este mismo botón abre la cámara.</p>`}` : ''}
        ${lee ? h`<p class="tenue chico">Si el ticket es muy largo, sacale dos o tres fotos por partes y elegilas juntas. También sirven capturas de pantalla de compras por internet.${Datos.fotos ? '' : ' La foto se usa solo para leerla: no queda guardada.'}</p>` : ''}
        <button type="button" class="${lee || adjunta ? 'enlace' : 'btn btn-principal'}" data-act="gasto-manual">${adjunta ? 'Cargar el gasto sin foto' : 'Cargar el gasto a mano'}</button></div>`);
    },

    revisar(H) {
      const t = H.t, nuevo = !H.id, n = t.items.length;
      const paraAlacena = t.items.filter(it => it.dest !== 'no').length;
      const dest = [['no', 'No sumar a la alacena'], ['nuevo', 'Producto nuevo']].concat(
        prodReales().map(([id, p]) => [id, N.textoProducto(p)]).sort((a, b) => a[1].localeCompare(b[1], 'es')));
      const cats = N.ORDEN_CATS.map(c => [c, N.CATS[c]]);
      return marco(H.id ? 'Editar gasto' : H.leido ? 'Revisar el ticket' : H.origen === 'foto' ? 'Cargar el ticket' : 'Cargar un gasto', h`<form class="form" data-form="ticket" novalidate>
        ${H.descartar ? h`<div class="nota"><p>¿Descartar este ticket sin guardarlo?</p><div class="hoja-pie">
          <button type="button" class="btn btn-chico" data-act="seguir-ticket">Seguir revisando</button><button type="button" class="btn btn-chico btn-peligro" data-act="descartar-ticket">Descartar</button></div></div>` : ''}
        ${H.nota ? h`<p class="nota">${H.nota}</p>` : ''}
        ${H.foto || H.fotoUrl ? h`<figure class="adjunto"><img class="t-foto${H.fotoGrande ? ' grande' : ''}" src="${H.foto ? H.foto.url : H.fotoUrl}" alt="Foto del ticket" data-act="foto-zoom" role="button" tabindex="0">
          <figcaption class="tenue chico">${H.foto ? 'La foto queda guardada con el gasto. ' : ''}Tocala para verla más grande o más chica.</figcaption></figure>` : ''}
        <div class="dos ancha">
          ${campoComercio('t-comercio', 't.comercio', t.comercio, 'Comercio', 'Supermercado')}
          ${campo('Fecha', h`<input type="date" id="t-fecha" data-k="t.fecha" value="${t.fecha}" max="${N.hoyISO()}">`)}
        </div>
        <p class="nota" id="t-repetido"${atr('hidden', !textoRepetido(H))}>${textoRepetido(H)}</p>
        <div class="ticket-caja"><div class="ticket-sombra"><div class="ticket">
          ${n ? h`<ul class="t-items">${t.items.map((it, i) => h`<li class="t-item">
            <button type="button" class="t-renglon" data-act="item-abrir" data-i="${i}" aria-expanded="${String(!!it.abierto)}">
              <span class="t-cant" id="t-c-${i}">${entero(it.c, 1, 1)}×</span><span class="t-nombre" id="t-nm-${i}">${it.n || '(sin nombre)'}</span><span class="t-imp" id="t-im-${i}">${it.i || '—'}</span>
              ${nuevo ? h`<span class="t-dest" id="t-d-${i}">${textoDestino(it)}</span>` : ''}
            </button>
            ${it.abierto ? h`<div class="t-editor">
              ${campo('Nombre', h`<input type="text" id="t-n-${i}" data-k="t.items.${i}.n" value="${it.n}" maxlength="120" autocomplete="off">`)}
              <div class="tres">
                ${campo('Cantidad', h`<input type="number" id="t-q-${i}" data-k="t.items.${i}.c" value="${it.c}" min="1" step="1" inputmode="numeric">`)}
                ${campo('Importe', h`<input type="text" id="t-i-${i}" data-k="t.items.${i}.i" value="${it.i}" inputmode="decimal" autocomplete="off">`)}
                ${campo('Categoría', h`<select id="t-k-${i}" data-k="t.items.${i}.cat">${opciones(cats, it.cat)}</select>`)}
              </div>
              ${nuevo ? campo('En la alacena', h`<select id="t-a-${i}" data-k="t.items.${i}.dest">${opciones(dest, it.dest)}</select>`) : ''}
              <button type="button" class="enlace rojo" data-act="item-quitar" data-i="${i}">Quitar este renglón</button></div>` : ''}
          </li>`)}</ul>` : ''}
          <button type="button" class="t-agregar" data-act="item-nuevo">+ Agregar un renglón</button>
          <div class="t-total"><label for="t-total">TOTAL $</label><input type="text" id="t-total" data-k="t.total" value="${t.total}" inputmode="decimal" autocomplete="off" placeholder="0"></div>
          <p class="t-nota" id="t-dif">${textoDiferencia(t)}</p>
        </div></div></div>
        ${n ? '' : campo('Categoría del gasto', h`<select id="t-cat" data-k="t.cat">${opciones(cats, t.cat)}</select>`)}
        ${nuevo && n ? h`<label class="casilla"><input type="checkbox" id="t-alacena" data-k="t.aAlacena"${atr('checked', t.aAlacena)}>
          <span id="t-alacena-txt">${textoAlacena(paraAlacena)}</span></label>` : ''}
        ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
        <div class="hoja-pie"><button type="submit" class="btn btn-principal"${atr('disabled', H.ocupado)} data-progreso="${H.id ? 'Guardar cambios' : 'Guardar el gasto'}">${H.id ? 'Guardar cambios' : 'Guardar el gasto'}</button></div>
      </form>`);
    },

    'ticket-ver'(H) {
      const t = E.tickets.find(x => x.id === H.id);
      if (!t) return marco('Ticket', h`<p class="tenue">Este ticket ya no está.</p>`);
      const items = t.items || [], suma = items.reduce((s, it) => s + (+it.i || 0), 0), dif = (+t.total || 0) - suma;
      return marco('Ticket', h`<div class="ticket-caja"><div class="ticket-sombra"><div class="ticket">
          <div class="ticket-encabezado"><strong>${t.comercio || 'Compra'}</strong><span>${N.fechaValida(t.fecha) ? N.fechaLarga(t.fecha) : ''}</span></div>
          ${items.length ? h`<ul class="t-items">${items.map(it => h`<li class="t-item"><div class="t-renglon"><span class="t-cant">${it.c || 1}×</span><span class="t-nombre">${it.n}</span><span class="t-imp">${N.plata(+it.i || 0).replace(/^(−?)\$\s/, '$1')}</span>
            <span class="t-dest">${N.CATS[it.cat] || N.CATS.otros}</span></div></li>`)}</ul>` : h`<p class="t-solo">${N.CATS[t.cat] || 'Sin detalle'}</p>`}
          <div class="t-total"><span>TOTAL</span><mark>${N.plata(+t.total || 0)}</mark></div>
          ${items.length && Math.abs(dif) >= 1 ? h`<p class="t-nota">Los renglones suman ${N.plata(suma)}. ${dif < 0 ? 'La diferencia son descuentos.' : 'La diferencia son recargos o renglones sin detallar.'}</p>` : ''}
        </div></div></div>
        ${H.fotoUrl ? h`<figure class="adjunto"><img class="t-foto${H.fotoGrande ? ' grande' : ''}" src="${H.fotoUrl}" alt="Foto del ticket" data-act="foto-zoom" role="button" tabindex="0">
            <figcaption class="tenue chico">Tocá la foto para verla más grande o más chica.</figcaption></figure>`
          : H.fotoNota ? h`<p class="tenue chico">${H.fotoNota}</p>` : ''}
        ${H.borrar ? h`<div class="nota"><p>¿Borrar este gasto? El stock de la alacena no cambia.</p><div class="hoja-pie">
            <button type="button" class="btn btn-chico" data-act="no-borrar">No</button><button type="button" class="btn btn-chico btn-peligro" data-act="borrar-ticket-si">Sí, borrar</button></div></div>`
          : h`<div class="hoja-pie" data-escribe><button type="button" class="btn btn-peligro" data-act="borrar-ticket">Borrar</button>
            <button type="button" class="btn" data-act="editar-ticket">${ico('lapiz')}Editar</button></div>`}`);
    },

    ajustes(H) {
      return marco('Ajustes', h`<form class="form" data-form="ajustes" novalidate>
        <div class="campo"><span id="aj-frec-r">¿Cada cuánto hacés las compras?</span>
          <div class="segmentos frec" role="group" aria-labelledby="aj-frec-r">${botonesFrec('aj-frecuencia', H.frecuencia)}</div>
          <small>La lista de compras sugiere lo necesario hasta la próxima compra. El pan, las frutas y verduras y lo que marques como «del día a día» se sugieren para un par de días, aunque compres una vez por mes.</small></div>
        ${campo('Presupuesto mensual', h`<input type="text" id="aj-presupuesto" data-k="presupuesto" value="${H.presupuesto}" inputmode="decimal" autocomplete="off" placeholder="Opcional">`, 'En Gastos se ve cuánto queda del presupuesto cada mes.')}
        ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
        <div class="hoja-pie" data-escribe><button type="submit" class="btn btn-principal">Guardar</button></div>
        ${puedeCerca() ? bloqueZona() : ''}
        ${Datos.avisos && Datos.avisos.configurado() ? bloqueAvisos() : ''}
        ${typeof IA !== 'undefined' && IA.disponible() ? bloqueIA() : ''}
        ${Datos.hogar ? bloqueHogar(H) : ''}
        ${bloqueAportes()}
        ${!Datos.copia ? h`<p class="tenue chico">${Datos.textos.donde}</p>` : h`<div class="dato"><span>${Datos.textos.donde}</span>${Lector.textos.consulta ? h`<span>${Lector.textos.consulta}</span>` : ''}
          ${H.errorCopia ? h`<p class="error" role="alert">${H.errorCopia}</p>` : ''}
          ${H.copia ? h`<p>${H.copia.n.suma ? h`<strong>Se suma a lo que ya hay en el hogar</strong> lo de la copia` : h`<strong>Restaurar reemplaza todo lo que hay ahora</strong> por lo de la copia`}: ${H.copia.n.productos} ${N.plural(H.copia.n.productos, 'producto', 'productos')} y ${H.copia.n.tickets} ${N.plural(H.copia.n.tickets, 'gasto', 'gastos')}. Las fotos de los tickets no van en la copia.</p>
            <div class="acciones"><button type="button" class="btn btn-chico" data-act="importar-no">Cancelar</button><button type="button" class="btn btn-chico${H.copia.n.suma ? ' btn-principal' : ' btn-peligro'}" data-act="importar-si">${H.copia.n.suma ? 'Traer la copia' : 'Restaurar'}</button></div>`
            : h`<div class="acciones"><button type="button" class="btn btn-chico" data-act="exportar">Guardar una copia</button><button type="button" class="btn btn-chico" data-act="importar">${Datos.hogar ? 'Traer una copia' : 'Restaurar una copia'}</button></div>`}</div>`}
        ${hayEjemplos() ? h`<button type="button" class="enlace rojo" data-act="borrar-ejemplos" data-escribe>Borrar los datos de ejemplo</button>` : ''}
        ${Datos.textos.version ? h`<p class="tenue chico" id="aj-version">${Datos.textos.version}${Datos.hogar ? h` · <a href="privacidad.html" target="_blank" rel="noopener">Privacidad</a>` : ''}</p>` : ''}
      </form>`);
    },

    // Un código para sumar a otra persona al hogar, en letras y como QR.
    invitar(H) {
      if (H.estado === 'pidiendo') return marco('Sumar a alguien', h`<div class="hoja-cuerpo">${cargando('Pidiendo un código…')}</div>`);
      if (H.estado === 'error') {
        return marco('Sumar a alguien', h`<div class="hoja-cuerpo"><p class="error" role="alert">${H.error}</p>
          <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Cerrar</button><button type="button" class="btn btn-principal" data-act="hogar-invitar">Probar de nuevo</button></div></div>`);
      }
      const qr = QR.svg(H.inv.url, 'Código QR para entrar al hogar'), hasta = new Date(H.inv.vence);
      const hora = String(hasta.getHours()).padStart(2, '0') + ':' + String(hasta.getMinutes()).padStart(2, '0');
      return marco('Sumar a alguien', h`<div class="hoja-cuerpo">
        <p>La otra persona abre la libreta en su teléfono${qr ? ' apuntando la cámara a este QR' : ''}, entra con su cuenta de Google y elige <strong>Tengo un código</strong>.</p>
        <div class="invitacion">${qr ? h`<div class="qr">${crudo(qr)}</div>` : ''}
          <div><p class="rotulo">Código</p><p class="codigo" id="inv-codigo">${conGuion(H.inv.codigo)}</p>
          <p class="tenue chico">Vale hasta las ${hora} y sirve para una sola persona.</p></div></div>
        <div class="hoja-pie"><button type="button" class="btn" data-act="hogar-invitar">Otro código</button><button type="button" class="btn btn-principal" data-act="cerrar">Listo</button></div></div>`);
    },
    bienvenida() {
      return marco('Tu hogar está listo', h`<div class="hoja-cuerpo">
        <p>Ya podés anotar lo que hay en la alacena. Para que el resto de la familia vea y anote lo mismo desde su teléfono, sumalos al hogar con un código.</p>
        <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Después</button><button type="button" class="btn btn-principal" data-act="hogar-invitar">Sumar a alguien</button></div></div>`);
    },
    tutorial(H) {
      const ultimo = H.paso >= pasosTutorial().length - 1;
      return marco('Cómo funciona', vistaTutorial(H.paso, h`<div class="hoja-pie">
        <button type="button" class="btn" data-act="tutorial-atras"${atr('disabled', H.paso === 0)}>Atrás</button>
        <button type="button" class="btn btn-principal" data-act="tutorial-sigue">${ultimo ? 'Listo' : 'Siguiente'}</button></div>`));
    },

    // «Ya lo compré»: cuánto se llevó de cada cosa, a qué precio y dónde.
    compra(H) {
      const filas = H.items.map((it, i) => {
        const p = verProd(it.id) || {}, meta = [p.marca, p.presentacion].filter(Boolean).join(' · ');
        return h`<li class="cp-item"><span class="cp-nombre">${p.nombre}${meta ? h` <span class="tenue">· ${meta}</span>` : ''}</span>
          <label class="cp-cant"><span>Cantidad</span><input type="number" id="cp-c-${i}" data-k="items.${i}.cant" value="${it.cant}" min="1" max="9999" step="1" inputmode="numeric" aria-label="Cantidad de ${p.nombre}"></label>
          <label class="cp-precio"><span>Precio de cada uno</span><input type="text" id="cp-p-${i}" data-k="items.${i}.precio" value="${it.precio}" inputmode="decimal" autocomplete="off" placeholder="Opcional" aria-label="Precio de cada uno: ${p.nombre}"></label>
          <small class="nota-precio" id="cp-n-${i}" data-nota-de="cp-p-${i}" data-prod="${it.id}">${notaPrecio(it.id, it.precio)}</small></li>`;
      });
      return marco('Compra de hoy', h`<form class="form" data-form="compra" novalidate>
        <p class="tenue chico">Revisá cuánto llevaste de cada cosa y a qué precio. Con eso la libreta sabe cuánto aumentó y dónde conviene comprar.</p>
        ${campoComercio('cp-comercio', 'comercio', H.comercio)}
        <ul class="cp-lista">${filas}</ul>
        <p class="cp-total"><span>Total</span><strong id="cp-total">${textoTotalCompra(H)}</strong></p>
        <label class="casilla"><input type="checkbox" id="cp-gasto" data-k="gasto"${atr('checked', H.gasto)}><span>Anotar el total también en Gastos</span></label>
        ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
        <div class="hoja-pie"><button type="submit" class="btn btn-principal"${atr('disabled', H.ocupado)} data-progreso="Guardar la compra">Guardar la compra</button></div></form>`);
    },
    'compra-hecha'(H) {
      const n = H.hechos.length, con = H.hechos.filter(x => x.precio > 0);
      const movidos = con.filter(x => x.pct != null && Math.abs(x.pct) >= 0.0005).sort((a, b) => b.pct - a.pct);
      const iguales = con.filter(x => x.pct != null && Math.abs(x.pct) < 0.0005).length, primeros = con.filter(x => x.pct == null).length;
      return marco('Compra anotada', h`<div class="hoja-cuerpo">
        <div class="hecho">${ico('ok')}<p>${n} ${N.plural(n, 'producto sumado', 'productos sumados')} a la alacena${H.gasto ? h` y un gasto de <strong>${N.plata(H.total, true)}</strong>${H.comercio ? ` en ${H.comercio}` : ''}` : ''}.</p></div>
        ${H.fallidos ? h`<p class="error" role="alert">${H.fallidos} ${N.plural(H.fallidos, 'producto no se pudo', 'productos no se pudieron')} guardar. Siguen tildados en la lista: probá de nuevo.</p>` : ''}
        ${con.length ? h`<div class="dato"><p class="rotulo">Qué pasó con los precios</p>
          ${movidos.length ? h`<ul class="cambios">${movidos.map(filaCambio)}</ul>` : ''}
          ${iguales ? h`<p class="tenue chico">${iguales} ${N.plural(iguales, 'sigue', 'siguen')} al mismo precio.</p>` : ''}
          ${primeros ? h`<p class="tenue chico">De ${primeros} ${N.plural(primeros, 'producto', 'productos')} es el primer precio que se anota: la próxima vez vas a ver cuánto cambió.</p>` : ''}</div>` : ''}
        ${bloqueCercaDe(H)}
        <div class="hoja-pie"><button type="button" class="btn btn-principal" data-act="cerrar">Listo</button></div></div>`);
    },

    notas(H) {
      return marco('Notas del hogar', h`<div class="hoja-cuerpo">
        <div id="notas-lista">${listaNotas()}</div>
        <form class="form" data-form="nota" novalidate data-escribe>
          ${campo('Nota nueva', h`<textarea id="nota-texto" class="nota-campo" data-k="texto" maxlength="${Datos.notas.largo}" rows="3" placeholder="Faltan pañales talle M">${H.texto}</textarea>`)}
          <div class="campo"><span id="nota-dias-r">¿Cuánto tiempo queda a la vista?</span>
            <div class="segmentos" role="group" aria-labelledby="nota-dias-r">${DURACIONES.map(([d, t]) => h`<button type="button" data-act="nota-dias" data-dias="${d}" aria-pressed="${String(H.dias === d)}">${t}</button>`)}</div>
            <small>Pasado ese tiempo la nota se borra sola. La ven todos los integrantes del hogar.</small></div>
          ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
          <div class="hoja-pie"><button type="submit" class="btn btn-principal"${atr('disabled', H.ocupado)}>Dejar la nota</button></div>
        </form></div>`);
    },

    // Cargar una promo de la zona: en qué comercio, qué descuento, qué días y con qué medio de pago.
    arranque: vistaArranque,
    fuentes(H) {
      return marco('De dónde salen', h`<div class="hoja-cuerpo">
        <p>Las promos de bancos y billeteras las publica cada banco y se cargan en la libreta una vez por mes${H.actualizado ? ` (última vez: ${N.fechaCorta(H.actualizado)})` : ''}. Pueden cambiar o agotarse: confirmalas siempre en la app de tu banco antes de pagar.</p>
        <ul class="fuentes">${H.fuentes.map(u => h`<li><a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, '').split('/')[0]}</a></li>`)}</ul>
        <p class="tenue chico">¿Viste una promo que no está? Cargala en «Promos de tu zona»: la ven todos los hogares del barrio.</p>
        <div class="hoja-pie"><button type="button" class="btn btn-principal" data-act="cerrar">Listo</button></div></div>`);
    },
    confirmar(H) {
      const hoy = hoyDia();
      return marco(`¿Siguen estos precios?`, h`<div class="hoja-cuerpo">
        <p class="tenue chico">Precios que cargaron otros hogares en <strong>${H.nombre}</strong>. Si estás ahí, confirmá con un toque si siguen igual o cuánto salen ahora: así nadie se lleva una sorpresa.</p>
        ${H.estado === 'cargando' ? cargando('Buscando los precios de este comercio…') : H.estado === 'error' ? h`<p class="nota gris">No se pudieron traer los precios. Revisá la conexión.</p>`
          : !H.items.length ? h`<p class="tenue">No hay precios de otros hogares para confirmar en este comercio. ¡Avisá vos uno!</p>`
          : h`<ul class="confirmar">${H.items.map((it, i) => h`<li>
            <div class="conf-dato"><span class="oferta-nombre">${it.d.t}</span><strong class="oferta-precio">${N.plata(it.d.p)}</strong>
              <span class="oferta-detalle">${[A.haceDias(hoy - it.d.d), A.origen({ hogar: it.d.h, cuantos: +it.d.c || 1 })].join(' · ')}</span></div>
            ${it.estado === 'sigue' ? h`<p class="verde chico">✓ Confirmado. ¡Gracias!</p>` : it.estado === 'cambio' ? h`<p class="verde chico">✓ Precio actualizado. ¡Gracias!</p>`
              : it.abierto ? h`<div class="conf-nuevo"><input type="text" id="cf-${i}" data-k="items.${i}.nuevo" value="${it.nuevo}" inputmode="decimal" autocomplete="off" placeholder="$ ahora" aria-label="Precio de ahora">
                  <button type="button" class="btn btn-chico btn-principal" data-act="conf-guardar" data-i="${i}"${atr('disabled', it.ocupado)}>Guardar</button></div>`
              : h`<div class="acciones"><button type="button" class="btn btn-chico btn-principal" data-act="conf-sigue" data-i="${i}"${atr('disabled', it.ocupado)}>👍 Sigue igual</button>
                  <button type="button" class="btn btn-chico" data-act="conf-cambio" data-i="${i}">Cambió</button></div>`}
            ${it.error ? h`<p class="error">${it.error}</p>` : ''}</li>`)}</ul>`}
        ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
        <div class="hoja-pie"><button type="button" class="btn btn-principal" data-act="cerrar">Listo</button></div></div>`);
    },
    // ¿Qué cocino?: primero qué se busca; después, las ideas de la IA.
    cocina(H) {
      const err = H.error ? h`<p class="error" role="alert">${H.error}</p>` : '';
      if (H.paso !== 'ideas') {
        return marco('¿Qué cocino?', h`<div class="hoja-cuerpo">
          <p class="tenue chico">Con lo que hay en tu alacena, la inteligencia artificial te propone tres comidas y te dice qué falta comprar. Solo se le envía la lista de productos.</p>
          <div class="campo"><span id="ck-que-r">Qué buscás</span><div class="chips" role="group" aria-labelledby="ck-que-r">${Object.entries(COMIDAS_TXT).map(([k, t]) => h`<button type="button" class="chip${H.comida === k ? ' puesto' : ''}" data-act="cocina-comida" data-c="${k}" aria-pressed="${H.comida === k ? 'true' : 'false'}">${t}</button>`)}</div></div>
          ${campoPaso('Para cuántas personas', 'ck-personas', 'personas', H.personas, 1)}
          ${H.pensando ? cargando('Pensando ideas con lo que tenés…') : ''}${err}
          <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Cancelar</button>
            <button type="button" class="btn btn-principal" data-act="cocina-pensar"${atr('disabled', H.pensando)}>${H.pensando ? 'Pensando…' : 'Ver ideas'}</button></div></div>`);
      }
      const usa = r => r.usa.map(id => verProd(id)).filter(Boolean).map(p => p.nombre).slice(0, 5);
      return marco('Ideas para cocinar', h`<div class="hoja-cuerpo">
        <ul class="recetas">${H.recetas.map((r, i) => {
          const anotada = H.anotadas.includes(i), u = usa(r);
          return h`<li class="receta"><h3>${r.nombre}</h3>
            <p class="tenue chico">${[r.minutos ? `~${r.minutos} min` : '', u.length ? `Usa: ${u.join(', ')}` : ''].filter(Boolean).join(' · ')}</p>
            ${r.faltan.length ? h`<p class="chico">Te falta: <strong>${r.faltan.map(f => f.n).join(', ')}</strong></p>
              <div class="acciones"><button type="button" class="btn btn-chico${anotada ? '' : ' btn-principal'}" data-act="cocina-faltan" data-i="${i}" data-escribe${atr('disabled', anotada)}>${anotada ? 'Anotado en la lista' : 'Anotar lo que falta'}</button></div>`
              : h`<p class="chico verde">Tenés todo lo que hace falta.</p>`}
            <details><summary>Cómo se hace</summary><ol class="pasos">${r.pasos.map(x => h`<li>${x}</li>`)}</ol></details></li>`;
        })}</ul>
        <p class="tenue chico">Son ideas de una inteligencia artificial: revisá las cantidades y que la comida quede bien cocida.</p>${err}
        <div class="hoja-pie"><button type="button" class="btn" data-act="cocina-otras"${atr('disabled', H.pensando)}>${H.pensando ? 'Pensando…' : 'Otras ideas'}</button>
          <button type="button" class="btn btn-principal" data-act="cerrar">Listo</button></div></div>`);
    },

    promo(H) {
      return marco('Cargar una promo', h`<form class="form" data-form="promo" novalidate>
        <p class="tenue chico">La ven los hogares de tu zona${E.ajustes.alias ? `, como «${E.ajustes.alias}»` : ', sin tu nombre'}. Cargá solo promos que viste en el comercio o en tu banco.</p>
        ${hayIA() ? h`<div class="ia-foto" aria-live="polite">${H.leyendo ? cargando('La IA está leyendo la foto…') : h`<div class="acciones">
            <button type="button" class="btn btn-chico${H.aviso ? '' : ' btn-principal'}" data-act="promo-foto">${ico('camara')}${H.aviso ? 'Otra foto' : 'Sacale una foto al cartel'}</button>
            <button type="button" class="enlace" data-act="promo-galeria">o elegila de la galería</button></div>`}
          ${H.aviso ? h`<p class="nota gris chico">${H.aviso}</p>` : h`<p class="tenue chico">La inteligencia artificial completa los datos y vos los revisás. Solo se envía la foto: que no salgan personas ni datos tuyos.</p>`}</div>` : ''}
        ${campoComercio('pr-comercio', 'comercio', H.comercio || '', 'En qué comercio')}
        ${campo('Qué promo es', h`<input type="text" id="pr-texto" data-k="texto" value="${H.texto}" maxlength="120" autocomplete="off" placeholder="25 % en todo, tope $ 10.000 por semana">`)}
        <div class="dos">
          ${campo('Descuento (%)', h`<input type="text" id="pr-pct" data-k="pct" value="${H.pct}" inputmode="numeric" autocomplete="off" placeholder="Opcional">`)}
          ${campo('Con qué se paga', h`<select id="pr-medio" data-k="medio">${opciones((PROMO_MEDIOS.includes(H.medio) ? PROMO_MEDIOS : PROMO_MEDIOS.concat(H.medio)).map(m => [m, m]), H.medio)}</select>`)}
        </div>
        <div class="campo"><span id="pr-dias-r">Qué días <small class="tenue">· sin tildar ninguno: todos los días</small></span>
          <div class="chips" role="group" aria-labelledby="pr-dias-r">${[1, 2, 3, 4, 5, 6, 0].map(d => h`<button type="button" class="chip${H.dias.includes(d) ? ' puesto' : ''}" data-act="promo-dia" data-d="${d}" aria-pressed="${H.dias.includes(d) ? 'true' : 'false'}" aria-label="${DIAS_SEMANA[d]}">${DIAS_CORTOS[d]}</button>`)}</div></div>
        ${campo('Vale hasta', h`<input type="date" id="pr-hasta" data-k="hasta" value="${H.hasta}" min="${N.hoyISO()}" max="${N.isoDeDia(hoyDia() + 62)}">`)}
        ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
        <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Cancelar</button>
          <button type="submit" class="btn btn-principal"${atr('disabled', H.ocupado)}>${H.ocupado ? 'Guardando…' : 'Cargar la promo'}</button></div></form>`);
    },

    // El mapa con los precios de la zona. Se dibuja una sola vez; después cambia solo la ficha de abajo.
    mapa(H) {
      if (H.vivo) {
        return marco('Precios de tu zona', h`<div class="hoja-cuerpo">
          <label class="buscar">${ico('buscar')}<input type="search" id="mz-filtro" value="${H.filtro}" placeholder="Filtrar: pollo, pan, yerba…" autocomplete="off" maxlength="60" aria-label="Filtrar los precios del mapa"></label>
          <p class="tenue chico en-vivo" id="mz-estado" aria-live="polite">${estadoZonaVivo(H)}</p>
          <div class="mapa" id="mapa">${cargando('Abriendo el mapa…')}</div>
          <div id="mapa-ficha" class="mapa-ficha" aria-live="polite">${fichaMapa(H)}</div>
          <ul class="lugares" id="mapa-lista">${H.pines.map((pn, i) => filaPin(H, pn, i))}</ul>
          <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Cerrar</button>
            <button type="button" class="btn btn-principal" data-act="avisar-precio" data-escribe>${ico('mas')}Avisar un precio</button></div></div>`);
      }
      return marco(H.titulo || 'Precios cerca', h`<div class="hoja-cuerpo">
        ${H.bajada ? h`<p class="tenue chico">${H.bajada}</p>` : ''}
        <div class="mapa${H.pines.length ? '' : ' sin-mapa'}" id="mapa">${H.pines.length ? cargando('Abriendo el mapa…') : h`<p class="tenue">Todavía no hay precios para mostrar en el mapa. Aparecen cuando alguien de tu zona, o vos, anota un precio con el comercio ubicado.</p>`}</div>
        <div id="mapa-ficha" class="mapa-ficha" aria-live="polite">${fichaMapa(H)}</div>
        ${H.pines.length ? h`<ul class="lugares" id="mapa-lista">${H.pines.map((pn, i) => filaPin(H, pn, i))}</ul>` : ''}</div>`);
    },

    // Elegir el comercio en el mapa: va encima de la hoja que se está completando.
    comercio(S) {
      if (S.paso === 'marcar') {
        return marco('Marcalo en el mapa', h`<div class="hoja-cuerpo">
          <p class="tenue chico">Mové el mapa hasta que la cruz quede sobre el comercio y tocá «Es acá». Lo van a poder elegir también los demás hogares de la zona.</p>
          <div class="mapa" id="lc-mapa">${cargando('Abriendo el mapa…')}</div>
          ${S.error ? h`<p class="error" role="alert">${S.error}</p>` : ''}
          <div class="hoja-pie"><button type="button" class="btn" data-act="comercio-volver">Volver</button>
            <button type="button" class="btn btn-principal" data-act="comercio-aca"${atr('disabled', !S.mapa)}>Es acá</button></div></div>`);
      }
      if (S.paso === 'nombre') {
        const l = S.elegido;
        return marco(l.nuevo ? 'Un comercio nuevo' : '¿Cómo lo anotás?', h`<form class="form" data-form="comercio-nombre" novalidate>
          ${l.nuevo ? '' : h`<div class="lugar-ficha"><p class="lugar-nombre">${l.nombre}</p>${l.direccion || l.rubro ? h`<p class="lugar-dir">${l.direccion || l.rubro}</p>` : ''}</div>`}
          ${campo(l.nuevo ? 'Nombre del comercio' : 'Nombre para tu libreta', h`<input type="text" id="lc-nombre" data-k="sub.nombre" value="${S.nombre}" maxlength="40" autocomplete="off" placeholder="${l.nuevo ? 'Almacén Don Pepe' : 'El súper de la esquina'}">`,
            l.nuevo ? 'Como figura en el cartel. Este nombre y el lugar los ven los hogares de tu zona; no se dice quién lo marcó.' : 'Así lo vas a ver en tus compras y gastos.')}
          ${l.nuevo ? h`<div class="chips" role="group" aria-label="Rubro">${CLASES_COMERCIO.map(c => h`<button type="button" class="chip${S.rubro === c ? ' puesto' : ''}" data-act="comercio-rubro" data-n="${c}" aria-pressed="${S.rubro === c ? 'true' : 'false'}">${c}</button>`)}</div>`
            : h`<div class="chips" role="group" aria-label="Nombres frecuentes">${CLASES_COMERCIO.map(c => h`<button type="button" class="chip" data-act="comercio-chip" data-n="${c}">${c}</button>`)}</div>`}
          ${S.error ? h`<p class="error" role="alert">${S.error}</p>` : ''}
          <div class="hoja-pie"><button type="button" class="btn" data-act="comercio-volver">Volver</button>
            <button type="submit" class="btn btn-principal"${atr('disabled', S.ocupado)}>${S.ocupado ? 'Guardando…' : l.nuevo ? 'Guardar el comercio' : 'Usar este comercio'}</button></div></form>`);
      }
      return marco('¿Dónde compraste?', h`<div class="hoja-cuerpo">
        <label class="buscar">${ico('buscar')}<input type="search" id="lc-buscar" data-k="sub.texto" value="${S.texto}" placeholder="Nombre del comercio" autocomplete="off" aria-label="Buscar un comercio por su nombre"></label>
        ${S.error ? h`<p class="error" role="alert">${S.error}</p>` : ''}
        <div id="lc-resultados" class="lc-resultados">${htmlLugares(S)}</div>
        <p class="gmaps-pie">Mapa y comercios: <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a></p></div>`);
    },

    copiar(H) {
      return marco('Lista de compras', h`<div class="hoja-cuerpo"><p class="tenue chico">No se pudo copiar sola. Mantené apretado el texto para seleccionarlo y copiarlo.</p>
        <textarea id="copiar-texto" readonly>${H.texto}</textarea></div>`);
    },
  };

  // Dentro de Ajustes: quiénes están en el hogar, cómo sumar a alguien, y la cuenta de quien está usando la libreta.
  const SIN_PANEL = { quitar: null, salir: false, cerrar: false, borrarCuenta: false, renombrar: null, errorHogar: '' };
  function bloqueHogar(H) {
    const is = Datos.hogar.integrantes(), yo = Datos.hogar.yo(), aQuitar = H.quitar ? is.find(d => d.id === H.quitar) : null;
    const no = h`<button type="button" class="btn btn-chico" data-act="hogar-no"${atr('disabled', H.ocupado)}>No</button>`;
    let panel = '';
    if (aQuitar) {
      panel = h`<div class="nota"><p>¿Quitar a <strong>${aQuitar.nombre}</strong> del hogar? Deja de ver y de cambiar los datos. Para volver necesita un código nuevo.</p>
        <div class="acciones">${no}<button type="button" class="btn btn-chico btn-peligro" data-act="hogar-quitar-si">Sí, quitar</button></div></div>`;
    } else if (H.renombrar != null) {
      panel = h`<div class="nota gris"><label class="campo"><span>¿Cómo te llaman en casa?</span><input type="text" id="aj-nombre" data-k="renombrar" value="${H.renombrar}" maxlength="40" autocomplete="off"></label>
        <div class="acciones"><button type="button" class="btn btn-chico" data-act="hogar-no"${atr('disabled', H.ocupado)}>Cancelar</button>
          <button type="button" class="btn btn-chico btn-principal" data-act="hogar-renombrar-si"${atr('disabled', H.ocupado)}>${H.ocupado ? 'Guardando…' : 'Guardar el nombre'}</button></div></div>`;
    } else if (H.salir) {
      panel = h`<div class="nota">${H.ultimo
        ? h`<p><strong>Sos la única persona en este hogar.</strong> Si salís, los productos, los gastos, las notas y los ajustes del hogar <strong>se borran para siempre</strong>. Para conservarlos, antes guardá una copia (más abajo) o sumá a alguien.</p>`
        : h`<p>¿Salir de este hogar? Sus datos siguen para los demás integrantes. Para volver hace falta un código nuevo.</p>`}
        <div class="acciones">${no}<button type="button" class="btn btn-chico btn-peligro" data-act="hogar-salir-si"${atr('disabled', H.ocupado)}>${H.ocupado ? 'Saliendo…' : H.ultimo ? 'Salir y borrar todo' : 'Sí, salir'}</button></div></div>`;
    } else if (H.cerrar) {
      panel = h`<div class="nota"><p>¿Cerrar la sesión en este teléfono? Tu hogar y sus datos quedan como están: cuando vuelvas a entrar con tu cuenta, volvés a él.
        ${Datos.hogar.sinc().pendiente || [...cola.values()].some(q => q.pend || q.vuelo) ? h`<strong>Hay cambios que todavía no se enviaron al servidor: si cerrás ahora, se pierden.</strong>` : ''}</p>
        <div class="acciones">${no}<button type="button" class="btn btn-chico btn-peligro" data-act="hogar-cerrar-si"${atr('disabled', H.ocupado)}>${H.ocupado ? 'Cerrando…' : 'Sí, cerrar sesión'}</button></div></div>`;
    } else if (H.borrarCuenta) {
      panel = h`<div class="nota"><p><strong>¿Borrar tu cuenta de la libreta?</strong> ${is.length < 2
        ? h`Sos la única persona en este hogar: con tu cuenta <strong>se borran para siempre</strong> sus productos, gastos, notas y ajustes.`
        : 'Salís del hogar (sus datos siguen para los demás) y se borra lo que la libreta tiene anotado de vos.'}
        Google te va a pedir que entres una vez más, para confirmar que sos vos.</p>
        <div class="acciones">${no}<button type="button" class="btn btn-chico btn-peligro" data-act="hogar-borrar-cuenta-si"${atr('disabled', H.ocupado)}>${H.ocupado ? 'Borrando…' : 'Sí, borrar mi cuenta'}</button></div></div>`;
    }
    return h`<div class="dato hogar" id="cuenta"><p class="rotulo">Integrantes de este hogar</p>
      <ul class="integrantes">${is.map(d => h`<li><span>${d.nombre}${d.yo ? h` <small class="tenue">· vos</small>` : ''}</span>
        ${d.yo ? h`<button type="button" class="enlace" data-act="hogar-renombrar">Cambiar nombre</button>` : h`<button type="button" class="enlace rojo" data-act="hogar-quitar" data-id="${d.id}">Quitar</button>`}</li>`)}</ul>
      ${!is.length ? h`<p class="tenue chico">Cargando…</p>` : ''}
      ${H.errorHogar ? h`<p class="error" role="alert">${H.errorHogar}</p>` : ''}
      ${panel || h`<div class="acciones"><button type="button" class="btn btn-chico btn-principal" data-act="hogar-invitar">Sumar a alguien</button></div>`}
      ${H.diag === 'corriendo' ? cargando('Probando la conexión…') : H.diag ? listaDiag(H.diag) : ''}
      ${yo ? h`<p class="cuenta-de">Entraste como <strong>${yo.email || yo.nombre}</strong></p>` : ''}
      ${panel ? '' : h`<div class="enlaces"><button type="button" class="enlace" data-act="hogar-diagnostico">Probar la conexión</button>
        <button type="button" class="enlace" data-act="tutorial-ver">Ver cómo funciona</button>
        <button type="button" class="enlace" data-act="hogar-cerrar">Cerrar sesión</button>
        <button type="button" class="enlace rojo" data-act="hogar-salir">Salir de este hogar</button>
        <button type="button" class="enlace rojo" data-act="hogar-borrar-cuenta">Borrar mi cuenta</button></div>`}</div>`;
  }
  // Dentro de Ajustes: si este teléfono usa la IA. Es de cada persona, no del hogar.
  /* Las notificaciones: activarlas en este teléfono y elegir cuáles. */
  const AVISOS_HOGAR = [['lista', 'Alguien anota algo en la lista'], ['voy', 'Alguien avisa que va al súper'], ['nota', 'Notas nuevas del hogar'], ['gasto', 'Alguien carga una compra o un gasto'], ['miembro', 'Alguien se suma al hogar'], ['resumen', 'Lo que ahorró el hogar en la semana (los domingos)']];
  const AVISOS_ZONA = [['baratos', 'Algo que comprás está más barato cerca'], ['avisos', 'Precios que avisan en tu zona'], ['promos', 'Promos nuevas en tu zona']];
  function bloqueAvisos() {
    const A1 = Datos.avisos, est = A1.estado(), per = A1.permiso(), H = E.hoja || {};
    if (!A1.soportado()) {
      return h`<div class="dato"><p class="rotulo">Notificaciones</p><p class="tenue chico">Este navegador no permite notificaciones.${/iPhone|iPad/.test(navigator.userAgent) ? ' En iPhone: tocá Compartir → «Agregar a inicio» y abrí la libreta desde ese ícono.' : ''}</p></div>`;
    }
    const casilla = ([k, t]) => h`<label class="casilla"><input type="checkbox" data-cambio="aviso" data-tipo="${k}"${atr('checked', !est || est.prefs[k] !== false)}><span>${t}</span></label>`;
    return h`<div class="dato avisos"><p class="rotulo">Notificaciones</p>
      ${est && per === 'granted' ? h`<p class="tenue chico">Activadas en este teléfono. Llegan aunque la app esté cerrada, con unos minutos de demora.</p>
        <p class="chico"><strong>Del hogar</strong></p>${AVISOS_HOGAR.map(casilla)}
        ${puedeCerca() ? h`<p class="chico"><strong>De tu zona</strong></p>${AVISOS_ZONA.map(casilla)}` : ''}
        <button type="button" class="enlace" data-act="avisos-apagar">Desactivarlas en este teléfono</button>`
        : h`<p class="tenue chico">${per === 'denied' ? 'Están bloqueadas para esta página. Se habilitan en los permisos del navegador (el candadito junto a la dirección) y después tocás «Activar».' : 'Te avisa cuando alguien del hogar anota algo en la lista, va al súper o deja una nota, y cuando algo que comprás está más barato cerca.'}</p>
          <div class="acciones"><button type="button" class="btn btn-chico btn-principal" data-act="avisos-activar"${atr('disabled', H.avisando)}>${H.avisando ? 'Activando…' : 'Activar notificaciones'}</button></div>`}
      ${H.errorAvisos ? h`<p class="error" role="alert">${H.errorAvisos}</p>` : ''}</div>`;
  }
  function bloqueIA() {
    return h`<div class="dato"><p class="rotulo">Inteligencia artificial</p>
      <label class="casilla"><input type="checkbox" id="aj-ia" data-cambio="ia"${atr('checked', iaElegida())}>
        <span>Usar la IA en este teléfono <small class="tenue">· para leer fotos de promos y proponer comidas. Es Gemini, de Google: solo se le envía la foto del cartel o la lista de productos de tu alacena, nunca tu nombre, tu email ni tus tickets. Google puede usar lo que recibe para mejorar sus servicios.</small></span></label></div>`;
  }
  // Dentro de Ajustes: si este hogar comparte sus precios con la zona, con qué nombre, y la ubicación que recuerda este teléfono.
  function bloqueZona() {
    const pos = C.ultimaPosicion();
    return h`<div class="dato zona"><p class="rotulo">Precios de tu zona</p>
      <label class="casilla"><input type="checkbox" id="aj-compartir" data-cambio="compartir"${atr('checked', E.ajustes.compartir === true)}>
        <span>Compartir los precios que anoto con otros hogares de mi zona <small class="tenue">· va el producto, el precio, la fecha y el comercio; nunca tu nombre, tu email ni tu dirección</small></span></label>
      <label class="campo"><span>Nombre público de tu hogar <small class="tenue">· opcional</small></span>
        <input type="text" id="aj-alias" data-cambio="alias" value="${E.ajustes.alias}" maxlength="40" autocomplete="off" placeholder="Familia García, Los del 3°B…" enterkeyhint="done">
        <small>Con este nombre te ven los hogares de tu zona cuando consiguen algo más barato gracias a vos. Sin nombre, aparecés como «otro hogar».</small></label>
      <p class="tenue chico">${pos ? 'Este teléfono recuerda tu ubicación para pedir los precios de tu zona.' : 'Este teléfono no tiene guardada tu ubicación.'}
        <button type="button" class="enlace" data-act="${pos ? 'cerca-olvidar' : 'cerca-activar'}">${pos ? 'Olvidarla' : 'Usar mi ubicación'}</button></p></div>`;
  }

  /* ---------- el mapa ---------- */
  /* Un pin por comercio, con los productos de `ids` que se le conocen: { k, lat, lon, dist, nombre, tono, texto, renglones }.
     `fuente`: de dónde salen los precios (id de producto → precios de la zona); por omisión, los de la zona del teléfono. */
  function pinesDe(ids, fuente) {
    const hoy = hoyDia(), m = new Map();
    for (const id of ids) {
      const p = verProd(id), l = (fuente || V.cerca).get(id);
      if (!p || !l) continue;
      for (const o of l) {
        if (!A.puntoValido(o.lat, o.lon)) continue;
        const pn = m.get(o.k) || { k: o.k, lat: o.lat, lon: o.lon, dist: o.dist, nombre: nombreDeRef(o.k), publico: o.comercio || '', renglones: [], baratos: 0 };
        const barato = A.conviene(o, p.precio);
        if (barato) pn.baratos++;
        pn.renglones.push({ nombre: p.nombre, precio: o.precio, barato, detalle: [A.haceDias(hoy - o.dia), A.origen(o), A.recoTexto([o]), !o.propio && p.precio > 0 ? `vos lo pagaste ${N.plata(p.precio)}` : ''].filter(Boolean).join(' · ') });
        m.set(o.k, pn);
      }
    }
    const pines = [...m.values()];
    for (const pn of pines) {
      pn.renglones.sort((a, b) => (b.barato ? 1 : 0) - (a.barato ? 1 : 0) || a.nombre.localeCompare(b.nombre, 'es'));
      pn.tono = pn.baratos ? 'barato' : pn.nombre ? 'mio' : '';
      pn.texto = pn.renglones.length === 1 ? N.plata(pn.renglones[0].precio) : pn.baratos ? `${pn.baratos} más ${N.plural(pn.baratos, 'barato', 'baratos')}` : `${pn.renglones.length} precios`;
    }
    return pines.sort((a, b) => b.baratos - a.baratos || (a.dist || 0) - (b.dist || 0));
  }
  // Debajo del mapa: el comercio elegido, con el nombre que le da el hogar, el público, la dirección y los precios.
  function fichaMapa(H) {
    const pn = H.pines.find(x => x.k === H.pin);
    if (!pn) return H.pines.length ? h`<p class="tenue chico">Tocá un precio para ver los detalles de ese comercio.</p>` : '';
    const d = H.detalles[pn.k], sabe = esObjeto(d), publico = (sabe && d.nombre) || pn.publico;
    return h`<div class="lugar-ficha" data-estado="${d === 'buscando' ? 'buscando' : 'listo'}">
      <p class="lugar-nombre">${pn.nombre || publico || 'Un comercio de tu zona'}</p>
      ${publico && pn.nombre && N.norm(publico) !== N.norm(pn.nombre) ? h`<p class="lugar-dir">${publico}</p>` : ''}
      ${sabe && (d.direccion || d.rubro) ? h`<p class="lugar-dir">${d.direccion || d.rubro}</p>` : ''}
      ${pn.dist != null ? h`<p class="tenue chico">A ${A.distTexto(pn.dist)} de vos</p>` : ''}
      <ul class="ofertas">${pn.renglones.map(r => h`<li${atr('class="es-promo"', !!r.promo)}><span class="oferta-nombre">${r.nombre}</span><strong class="oferta-precio${r.barato || r.promo ? ' verde' : ''}">${r.promo ? `−${r.pct} %` : N.plata(r.precio)}</strong><span class="oferta-detalle">${r.detalle}</span></li>`)}</ul>
      <div class="acciones"><a class="btn btn-chico" href="${C.enlace(pn.k, pn.lat, pn.lon)}" target="_blank" rel="noopener">${ico('lugar')}Cómo llegar</a>
        ${/^(osm|com):/.test(pn.k) ? h`<button type="button" class="btn btn-chico" data-act="confirmar" data-k="${pn.k}" data-escribe>¿Estás acá? Confirmá</button>` : ''}</div></div>`;
  }
  const filaPin = (H, pn, i) => h`<li><button type="button" class="lugar" data-act="mapa-pin" data-k="${pn.k}"${atr('aria-current="true"', pn.k === H.pin)}>
    <span class="lugar-nombre">${pn.nombre || pn.publico || (esObjeto(H.detalles[pn.k]) && H.detalles[pn.k].nombre) || `Comercio ${i + 1}`}</span><span class="lugar-dist">${pn.texto}</span>
    <span class="lugar-dir">${[pn.dist != null ? `a ${A.distTexto(pn.dist)}` : '', pn.renglones.slice(0, 3).map(r => r.nombre).join(', ') + (pn.renglones.length > 3 ? '…' : '')].filter(Boolean).join(' · ')}</span></button></li>`;
  const mapaActual = () => { const H = E.hoja, X = H && (H.sub || H); return X && X.tipo === 'mapa' ? X : null; };
  function pintarFichaMapa(H) {
    const f = $('#mapa-ficha'), l = $('#mapa-lista'), est = $('#mz-estado');
    if (est && H.vivo) est.innerHTML = val(estadoZonaVivo(H));
    if (f) f.innerHTML = val(fichaMapa(H));
    if (l) l.innerHTML = val(H.pines.map((pn, i) => filaPin(H, pn, i)));
  }
  function elegirPin(H, k, mover) {
    if (!H.pines.some(x => x.k === k)) return;
    H.pin = k;
    if (!H.detalles[k]) {
      const ya = C.conocido(k);
      H.detalles[k] = ya || 'buscando';
    }
    if (H.detalles[k] === 'buscando') {
      C.detalle(k).then(d => { H.detalles[k] = d; }, () => { H.detalles[k] = 'fallo'; }).then(() => { if (mapaActual() === H) pintarFichaMapa(H); });
    }
    pintarFichaMapa(H);
    if (H.mapa) H.mapa.elegir(k, mover);
    const f = $('#mapa-ficha');
    if (f && mover) $('#mapa').scrollIntoView({ block: 'nearest' });
  }
  // Si hay una hoja abierta (la ficha de un producto, el resumen de una compra), el mapa va encima y al cerrarlo se vuelve a ella.
  async function abrirMapa(op) {
    if (!puedeCerca() || (E.hoja && E.hoja.sub)) return;
    const H = Object.assign({ tipo: 'mapa', pines: [], pin: null, detalles: {}, mapa: null }, op);
    if (E.hoja) { E.hoja.sub = H; renderHoja(true); } else abrirHoja(H);
    if (!H.pines.length) return;
    if (H.pin) elegirPin(H, H.pin, false);
    try {
      const m = await C.dibujar($('#mapa'), { yo: C.ultimaPosicion(), pines: H.pines.map(x => ({ k: x.k, lat: x.lat, lon: x.lon, texto: x.texto, tono: x.tono })), alTocar: k => { if (mapaActual() === H) elegirPin(H, k, false); } });
      if (mapaActual() !== H) { m.destruir(); return; }
      H.mapa = m;
      if (H.pin) m.elegir(H.pin, true);
    } catch (e) {
      const el = mapaActual() === H ? $('#mapa') : null;
      if (el) { el.classList.add('sin-mapa'); el.innerHTML = val(h`<p class="nota gris">${(e && e.texto) || 'No se pudo abrir el mapa.'} Abajo está la lista de comercios.</p>`); }
    }
  }
  /* ---------- el mapa de la zona, en vivo ----------
     Todos los precios que cargaron los hogares cerca, como carteles en el mapa. Escucha a Firestore: cuando otro hogar
     avisa un precio, su cartel aparece (resaltado) sin recargar. Se puede filtrar escribiendo. */
  const pinMapa = x => ({ k: x.k, lat: x.lat, lon: x.lon, texto: x.texto, tono: x.tono });
  function estadoZonaVivo(H) {
    if (H.estado === 'error') return h`<span class="rojo">${H.error || 'No se pudo conectar con los precios de la zona.'}</span>`;
    if (H.estado !== 'vivo') return 'Conectando…';
    const n = H.pines.reduce((s, pn) => s + (pn.precios || 0), 0), pr = H.pines.filter(pn => pn.promos).length;
    const txtP = n ? `${n} ${N.plural(n, 'precio', 'precios')}${H.filtro && N.raices(H.filtro).length ? ' que coinciden' : ''} en ${H.pines.filter(pn => pn.precios).length} ${N.plural(H.pines.filter(pn => pn.precios).length, 'comercio', 'comercios')}` : '';
    const txtR = pr ? `${pr} ${N.plural(pr, 'súper', 'súpers')} con promo hoy` : '';
    return h`<span class="punto-vivo" aria-hidden="true"></span>En vivo · ${n || pr ? [txtP, txtR].filter(Boolean).join(' · ') : H.filtro ? 'nada coincide con lo que escribiste' : 'todavía nadie cargó precios cerca: ¡avisá el primero!'}`;
  }
  function pinesZona(H) {
    const hoy = hoyDia(), q = N.raices(H.filtro || ''), m = new Map();
    for (const d of H.docs) {
      if (!(d.v >= hoy) || !(d.d <= hoy + 1) || !(d.p > 0) || typeof d.t !== 'string' || !A.puntoValido(d.la, d.lo)) continue;
      if (q.length && !N.coincide(q, d.t) && !(d.g && N.CATS[d.g] && N.coincide(q, N.CATS[d.g]))) continue;
      const dist = A.distancia(H.pos.lat, H.pos.lon, d.la, d.lo);
      if (dist > C.RADIO_ZONA) continue;
      const pn = m.get(d.k) || { k: d.k, lat: d.la, lon: d.lo, dist, nombre: nombreDeRef(d.k), publico: typeof d.n === 'string' ? d.n : '', renglones: [], baratos: 0 };
      pn.renglones.push({ nombre: d.t, precio: +d.p, barato: false, dia: +d.d, detalle: [A.haceDias(hoy - d.d), A.origen({ hogar: typeof d.h === 'string' ? d.h : '', cuantos: +d.c || 1 })].join(' · ') });
      m.set(d.k, pn);
    }
    // las sucursales con promo de banco hoy (si lo buscado no la deja afuera)
    const dow = new Date().getDay();
    for (const t of H.tiendas || []) {
      const ps = pbDeComercio(t.nombre, t.lat, t.lon, dow).filter(p => !q.length || N.coincide(q, `${p.cadena} ${p.medio} promo descuento oferta`));
      if (!ps.length) continue;
      const pn = m.get(t.id) || { k: t.id, lat: t.lat, lon: t.lon, dist: A.distancia(H.pos.lat, H.pos.lon, t.lat, t.lon), nombre: nombreDeRef(t.id), publico: t.nombre, renglones: [], baratos: 0 };
      for (const p of ps) pn.renglones.push({ nombre: `${p.pct} % con ${p.medio}`, pct: p.pct, promo: true, dia: 1e9, detalle: [`hoy, ${DIAS_SEMANA[dow]}`, pbTope(p), p.detalle || ''].filter(Boolean).join(' · ') });
      m.set(t.id, pn);
    }
    const pines = [...m.values()];
    for (const pn of pines) {
      pn.renglones.sort((a, b) => b.dia - a.dia || a.nombre.localeCompare(b.nombre, 'es'));
      const pr = pn.renglones.filter(r => r.promo), pc = pn.renglones.length - pr.length, max = pr.length ? Math.max(...pr.map(r => r.pct)) : 0;
      pn.promos = pr.length; pn.precios = pc;
      pn.tono = H.nuevos.has(pn.k) ? 'barato' : max ? 'promo' : pn.nombre ? 'mio' : '';
      pn.texto = max && !pc ? `${max}% hoy` : max ? `${max}% · ${pc} ${pc === 1 ? 'precio' : 'precios'}` : pc === 1 ? N.plata(pn.renglones[0].precio) : `${pc} precios`;
    }
    return pines.sort((a, b) => (H.nuevos.has(b.k) ? 1 : 0) - (H.nuevos.has(a.k) ? 1 : 0) || a.dist - b.dist);
  }
  function actualizarZonaVivo(H) {
    H.pines = pinesZona(H);
    if (H.pin && !H.pines.some(x => x.k === H.pin)) H.pin = null;
    if (H.mapa) H.mapa.poner(H.pines.map(pinMapa));
    pintarFichaMapa(H);
  }
  function alLlegarZona(H, docs) {
    if (mapaActual() !== H) return;
    const firma = d => `${d.id}|${d.p}|${d.d}`, nuevos = [];
    if (H.vistos) for (const d of docs) if (!H.vistos.has(firma(d)) && typeof d.t === 'string' && d.p > 0) nuevos.push(d);
    H.vistos = new Set(docs.map(firma));
    for (const d of nuevos) H.nuevos.add(d.k);
    H.docs = docs; H.estado = 'vivo';
    actualizarZonaVivo(H);
    if (nuevos.length) {
      const d = nuevos[nuevos.length - 1];
      avisar(`Nuevo precio en tu zona: ${d.t}, ${N.plata(d.p)} en ${nombreDeRef(d.k) || d.n || 'un comercio'}`, { rotulo: 'Ver', fn: () => { if (mapaActual() === H) elegirPin(H, d.k, true); } });
    }
  }
  async function abrirMapaZona(op) {
    if (!puedeCerca() || !Datos.precios || !Datos.precios.escuchar) return;
    let pos = C.ultimaPosicion();
    if (!pos) { try { pos = await C.posicion(true); } catch (e) { avisar((e && e.texto) || 'Para ver el mapa de la zona hace falta tu ubicación.'); return; } }
    const H = { tipo: 'mapa', vivo: true, pos, pines: [], pin: null, detalles: {}, mapa: null, filtro: '', docs: [], vistos: null, nuevos: new Set(), estado: 'conectando', error: '', tiendas: [], foco: op && op.foco };
    abrirHoja(H);
    tiendasConPromo(pos).then(l => { H.tiendas = l; if (mapaActual() === H) { actualizarZonaVivo(H); if (H.foco && H.pines.some(x => x.k === H.foco)) elegirPin(H, H.foco, true); } });
    try {
      H.alSoltar = Datos.precios.escuchar(A.celdasCerca(pos.lat, pos.lon, C.RADIO_ZONA), docs => alLlegarZona(H, docs),
        e => { H.estado = 'error'; H.error = /permission/i.test(String(e && (e.code || e.message))) ? 'Firebase no deja leer los precios de la zona: falta publicar las reglas nuevas.' : 'Se cortó la conexión con los precios de la zona. Cerrá el mapa y abrilo de nuevo.'; if (mapaActual() === H) pintarFichaMapa(H); });
    } catch (e) { H.estado = 'error'; }
    try {
      const m = await C.dibujar($('#mapa'), { yo: pos, centro: pos, pines: H.pines.map(pinMapa), alTocar: k => { if (mapaActual() === H) elegirPin(H, k, false); } });
      if (mapaActual() !== H) { m.destruir(); return; }
      H.mapa = m;
      m.poner(H.pines.map(pinMapa));
    } catch (e) {
      const el = mapaActual() === H ? $('#mapa') : null;
      if (el) { el.classList.add('sin-mapa'); el.innerHTML = val(h`<p class="nota gris">${(e && e.texto) || 'No se pudo abrir el mapa.'} Abajo está la lista de comercios.</p>`); }
    }
  }

  // El mapa de un producto: dónde lo compró este hogar y dónde lo consiguieron otros.
  async function mapaDeProducto(id) {
    const p = verProd(id), codigo = codigoDe(p);
    if (!p || !codigo || !puedeCerca()) return;
    const pos = C.ultimaPosicion();
    if (pos && !E.cerca.porId.has(id)) {
      try { const l = (await C.buscar(pos, [codigo])).get(codigo); if (l && l.length) E.cerca.porId.set(id, l); } catch (e) { /* se muestra lo que haya */ }
    }
    const pines = pinesDe([id], new Map([[id, deLaZona(p, E.cerca.porId.get(id) || [])]])), hoy = hoyDia();
    // los comercios donde lo compró este hogar y que la zona no tiene (porque no comparte, o el precio ya venció)
    for (const c of A.porComercio(p, hoy, 90)) {
      if (!c.ref || pines.some(x => x.k === c.ref)) continue;
      let u = null;
      try { u = await ubicacionDe(c.ref); } catch (e) { u = null; }
      if (!u) continue;
      pines.push({ k: c.ref, lat: u.lat, lon: u.lon, dist: pos ? A.distancia(pos.lat, pos.lon, u.lat, u.lon) : null, nombre: c.comercio, publico: '', tono: 'mio', baratos: 0, texto: N.plata(c.precio),
        renglones: [{ nombre: p.nombre, precio: c.precio, barato: false, detalle: `lo pagaste ${A.haceDias(hoy - c.dia)}` }] });
    }
    abrirMapa({ titulo: p.nombre, bajada: pos ? '' : 'Para ver también los precios de otros hogares, activá tu ubicación en Ofertas.', pines, pin: pines.length ? pines[0].k : null });
  }

  /* ---------- elegir el comercio en el mapa ----------
     Una hoja encima de la que se está completando. Lo elegido queda anotado en el hogar como «este nombre es
     este comercio», y el campo de la hoja de abajo recibe el nombre. Los comercios salen de OpenStreetMap y de
     los que marcaron los hogares de la zona; si uno no figura, se lo marca en el mapa. */
  const CLASES_COMERCIO = ['Súper', 'Chino', 'Almacén', 'Verdulería', 'Carnicería', 'Panadería', 'Dietética', 'Farmacia', 'Mayorista', 'Kiosco'];
  const leerEn = (obj, ruta) => ruta.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const subComercio = () => { const H = E.hoja, S = H && H.sub; return S && S.tipo === 'comercio' ? S : null; };
  function abrirElegirComercio(para, campoId) {
    const H = E.hoja;
    if (!H || H.sub || !conMapa()) return;
    const actual = limpio(leerEn(H, para)), buscar = refDeComercio(actual) ? '' : actual;      // el nombre de un comercio ya ubicado es del hogar: no se busca
    H.sub = { tipo: 'comercio', para, campo: campoId, paso: 'lista', texto: buscar, pedido: actual, cerca: null, estadoCerca: 'sin', notaCerca: '', sugeridos: null, estadoSug: '', elegido: null, nombre: '', rubro: '', error: '', ocupado: false, reloj: 0, vuelta: 0, mapa: null };
    renderHoja(true);
    if (C.ultimaPosicion()) buscarCercanos(false);
    if (buscar.length >= 2) sugerirComercios(0);
  }
  function soltarMapa(S) { if (S && S.mapa) { try { S.mapa.destruir(); } catch (e) { /* el mapa ya no estaba */ } S.mapa = null; } }
  function cerrarSub() {
    const H = E.hoja;
    if (!H || !H.sub) return;
    const campoId = H.sub.campo;
    clearTimeout(H.sub.reloj);
    soltarMapa(H.sub);
    H.sub = null;
    if (H.error) H.error = '';      // lo que faltaba era el comercio: ya se eligió
    renderHoja();
    const el = campoId && document.getElementById(campoId);
    if (el) { el.scrollIntoView({ block: 'nearest' }); el.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  const filaLugar = (l, i, de) => h`<li><button type="button" class="lugar" data-act="comercio-elegir" data-de="${de}" data-i="${i}">
    <span class="lugar-nombre">${l.nombre}</span>${l.dist != null ? h`<span class="lugar-dist">${A.distTexto(l.dist)}</span>` : ''}
    <span class="lugar-dir">${[l.direccion || l.rubro || '', l.zona ? 'lo marcó un hogar' : ''].filter(Boolean).join(' · ')}${E.ajustes.comercios[l.id] ? h`${l.direccion || l.rubro || l.zona ? ' · ' : ''}<strong>ya lo anotaste como «${E.ajustes.comercios[l.id].n}»</strong>` : ''}</span></button></li>`;
  function htmlLugares(S) {
    const q = N.norm(S.texto), partes = [];
    const mios = Object.keys(E.ajustes.comercios).map(id => ({ id, n: E.ajustes.comercios[id].n })).filter(x => !q || N.norm(x.n).includes(q)).sort((a, b) => a.n.localeCompare(b.n, 'es'));
    if (S.sugeridos || S.estadoSug) {
      partes.push(h`<section><h3 class="rotulo">Con ese nombre</h3>
        ${S.estadoSug === 'buscando' ? cargando('Buscando…') : S.estadoSug ? h`<p class="nota gris">${S.estadoSug}</p>`
          : S.sugeridos.length ? h`<ul class="lugares">${S.sugeridos.map((l, i) => filaLugar(l, i, 'sug'))}</ul>`
            : h`<p class="tenue chico">No aparece ningún comercio con ese nombre cerca. Probá con otro nombre o marcalo en el mapa.</p>`}</section>`);
    }
    if (mios.length) {
      partes.push(h`<section><h3 class="rotulo">Tus comercios</h3><ul class="lugares">${mios.map(x => h`<li class="lugar-propio">
        <button type="button" class="lugar" data-act="comercio-usar" data-ref="${x.id}"><span class="lugar-nombre">${x.n}</span><span class="lugar-dir">Ya ubicado en el mapa</span></button>
        <button type="button" class="enlace rojo" data-act="comercio-quitar" data-ref="${x.id}" aria-label="Quitar ${x.n} de tus comercios">Quitar</button></li>`)}</ul></section>`);
    }
    partes.push(h`<section><h3 class="rotulo">Cerca tuyo</h3>
      ${S.estadoCerca === 'buscando' ? cargando('Buscando comercios cerca…')
        : S.estadoCerca === 'listo' ? (S.cerca.length ? h`<ul class="lugares">${S.cerca.map((l, i) => filaLugar(l, i, 'cerca'))}</ul>`
          : h`<p class="tenue chico">El mapa no muestra comercios de comida a menos de 40 km. Buscalo por su nombre o marcalo en el mapa.</p>`)
          : h`${S.notaCerca ? h`<p class="nota gris">${S.notaCerca}</p>` : ''}
            <div class="acciones"><button type="button" class="btn btn-chico" data-act="comercio-cerca">${ico('aca')}${S.estadoCerca === 'error' ? 'Probar de nuevo' : 'Buscar comercios cerca mío'}</button></div>`}</section>`);
    partes.push(h`<section class="marcar"><h3 class="rotulo">¿No está?</h3>
      <p class="tenue chico">Marcalo en el mapa: queda para vos y para los demás hogares de tu zona.</p>
      <div class="acciones"><button type="button" class="btn btn-chico" data-act="comercio-marcar">${ico('lugar')}Marcarlo en el mapa</button></div></section>`);
    return partes;
  }
  function pintarLugares() {
    const S = subComercio(), el = $('#lc-resultados');
    if (S && S.paso === 'lista' && el) el.innerHTML = val(htmlLugares(S));
  }
  async function buscarCercanos(pedir) {
    const H = E.hoja, S = subComercio();
    if (!S || S.estadoCerca === 'buscando') return;
    const sigue = () => E.hoja === H && H.sub === S;
    S.estadoCerca = 'buscando'; S.notaCerca = '';
    pintarLugares();
    try {
      const pos = await C.posicion(pedir);
      if (!sigue()) return;
      if (!pos) { S.estadoCerca = 'sin'; pintarLugares(); return; }
      const l = await C.cercanos(pos);
      if (!sigue()) return;
      S.cerca = l; S.estadoCerca = 'listo';
      if (limpio(S.texto).length >= 2 && (!S.sugeridos || !S.sugeridos.length)) sugerirComercios(0);      // ahora hay dónde buscar
    } catch (e) {
      if (!sigue()) return;
      S.estadoCerca = 'error'; S.notaCerca = (e && e.texto) || 'No se pudieron buscar los comercios cercanos.';
    }
    pintarLugares();
  }
  // Buscar por nombre: se espera a que la persona deje de escribir, para no consultar por cada letra.
  function sugerirComercios(espera) {
    const H = E.hoja, S = subComercio();
    if (!S) return;
    clearTimeout(S.reloj);
    const texto = limpio(S.texto), vuelta = ++S.vuelta;
    if (texto.length < 2) { S.sugeridos = null; S.estadoSug = ''; pintarLugares(); return; }
    S.reloj = setTimeout(async () => {
      const sigue = () => E.hoja === H && H.sub === S && S.vuelta === vuelta;
      if (!sigue()) return;
      S.estadoSug = 'buscando';
      pintarLugares();
      try {
        const l = await C.sugerir(texto, C.ultimaPosicion());
        if (!sigue()) return;
        S.sugeridos = l; S.estadoSug = '';
      } catch (e) {
        if (!sigue()) return;
        S.sugeridos = []; S.estadoSug = (e && e.texto) || 'No se pudo buscar.';
      }
      pintarLugares();
    }, espera == null ? 450 : espera);
  }
  function usarComercio(ref) {
    const H = E.hoja, S = subComercio(), n = nombreDeRef(ref);
    if (!S || !n) return;
    ponerEn(H, S.para, n);
    H.sucio = true;
    cerrarSub();
  }
  function elegirLugar(de, i) {
    const S = subComercio();
    if (!S || S.ocupado) return;
    const l = (de === 'sug' ? S.sugeridos : S.cerca || [])[i];
    if (!l) return;
    if (E.ajustes.comercios[l.id]) { usarComercio(l.id); return; }      // ya estaba ubicado: se usa con su nombre
    const escrito = limpio(S.pedido);     // lo que ya decía el campo sirve de nombre, salvo que sea el de otro comercio
    Object.assign(S, { paso: 'nombre', elegido: { id: l.id, nombre: l.nombre, direccion: l.direccion, rubro: l.rubro, lat: l.lat, lon: l.lon }, nombre: escrito && !refDeComercio(escrito) ? escrito.slice(0, 40) : '', error: '' });
    renderHoja(true);
    const c = $('#lc-nombre');
    if (c) c.focus();
  }
  // Marcar en el mapa un comercio que no figura: el mapa con una cruz en el medio.
  async function marcarEnMapa() {
    const H = E.hoja, S = subComercio();
    if (!S || S.ocupado) return;
    const sigue = () => E.hoja === H && H.sub === S && S.paso === 'marcar';
    Object.assign(S, { paso: 'marcar', error: '', mapa: null });
    renderHoja(true);
    let pos = C.ultimaPosicion();
    if (!pos) { try { pos = await C.posicion(true); } catch (e) { pos = null; } }
    if (!sigue()) return;
    try {
      const m = await C.dibujar($('#lc-mapa'), { mira: true, yo: pos, centro: pos });
      if (!sigue()) { m.destruir(); return; }
      S.mapa = m;
      const b = $('#hoja [data-act="comercio-aca"]');
      if (b) b.disabled = false;
    } catch (e) {
      if (!sigue()) return;
      const el = $('#lc-mapa');
      if (el) { el.classList.add('sin-mapa'); el.innerHTML = val(h`<p class="nota gris">${(e && e.texto) || 'No se pudo abrir el mapa.'}</p>`); }
    }
  }
  function marcarAca() {
    const S = subComercio();
    if (!S || S.paso !== 'marcar' || !S.mapa) return;
    const c = S.mapa.centro(), escrito = limpio(S.texto) || limpio(S.pedido);
    soltarMapa(S);
    Object.assign(S, { paso: 'nombre', elegido: { id: '', nuevo: true, nombre: '', direccion: '', lat: c.lat, lon: c.lon }, nombre: escrito && !refDeComercio(escrito) ? escrito.slice(0, 40) : '', rubro: '', error: '' });
    renderHoja(true);
    const n = $('#lc-nombre');
    if (n) n.focus();
  }
  async function guardarComercioNuevo() {
    const H = E.hoja, S = subComercio();
    if (!S || S.paso !== 'nombre' || S.ocupado || !puede()) return;
    const n = limpio(S.nombre).slice(0, 40), l = S.elegido, otro = refDeComercio(n);
    const decir = texto => { S.error = texto; S.ocupado = false; renderHoja(); const c = $('#lc-nombre'); if (c) c.focus(); };
    if (!n) return decir(l.nuevo ? 'Poné el nombre del comercio, como figura en el cartel.' : 'Ponele un nombre: es como lo vas a ver en tus compras.');
    if (otro && otro !== l.id) return decir(`Ya tenés otro comercio anotado como «${nombreDeRef(otro)}». Ponele a este un nombre distinto, por ejemplo con la calle.`);
    S.ocupado = true;
    renderHoja();
    let id = l.id;
    try {
      if (l.nuevo) id = await C.marcar(n, l.lat, l.lon, S.rubro);
      await cambiarAjustes({ comercios: Object.assign({}, E.ajustes.comercios, { [id]: { n, la: l.lat, lo: l.lon, p: (l.nuevo ? n : l.nombre || n).slice(0, 60) } }) });
    } catch (e) { if (E.hoja === H && H.sub === S) decir((e && e.texto) || textoFallo(e)); return; }
    if (!l.nuevo) C.recordar(id, l.lat, l.lon, l.nombre, l.direccion, l.rubro);
    pintarComercios();
    if (E.hoja !== H || H.sub !== S) return;
    ponerEn(H, S.para, n);
    H.sucio = true;
    cerrarSub();
    avisar(l.nuevo ? `${n} quedó marcado en el mapa para tu zona` : `${n} quedó ubicado en el mapa`);
  }

  /* ---------- ticket: textos que se actualizan mientras se edita ---------- */
  function textoDestino(it) {
    if (it.ya) return 'ya se sumó a la alacena ese día';
    if (it.dest === 'no') return 'no va a la alacena';
    if (it.dest === 'nuevo') return 'alacena: producto nuevo';
    const p = E.prod.get(it.dest);
    return p ? `alacena: ${N.textoProducto(p)}` : 'no va a la alacena';
  }
  function textoDiferencia(t) {
    if (!t.items.length) return '';
    const suma = t.items.reduce((s, it) => { const v = N.aNumero(it.i); return s + (isFinite(v) ? v : 0); }, 0), total = N.aNumero(t.total);
    if (!isFinite(total) || Math.abs(total - suma) < Math.max(1, total * 0.005)) return '';
    return `Los renglones suman ${N.plata(suma)}. ${suma > total ? 'Si hubo descuentos, está bien' : 'Puede faltar un renglón o haber un recargo'}: el gasto se guarda por el total.`;
  }
  const textoAlacena = n => n ? `Sumar a la alacena ${n === 1 ? 'el producto' : `los ${n} productos`} de este ticket` : 'Ningún renglón está marcado para la alacena';
  // Un gasto nuevo que parece uno ya cargado: el mismo día en el mismo comercio, o por el mismo total.
  function textoRepetido(H) {
    if (H.id || !H.t) return '';
    const t = H.t, total = N.aNumero(limpio(t.total)), com = N.norm(t.comercio);
    const otro = V.tickets.find(x => x.fecha === t.fecha && ((com && N.norm(x.comercio) === com) || (total > 0 && Math.abs((+x.total || 0) - total) <= total * 0.01)));
    return otro ? `Ojo: ya hay un gasto del ${N.fechaCorta(otro.fecha)} en ${otro.comercio || 'Compra'} por ${N.plata(+otro.total || 0, true)}. Si es este mismo, no hace falta cargarlo de nuevo.` : '';
  }
  function ticketVivo() {
    const H = E.hoja;
    if (!H || H.tipo !== 'ticket' || H.estado !== 'revisar') return;
    const t = H.t, poner = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    t.items.forEach((it, i) => {
      if (!it.abierto) return;
      if (it.ya && it.dest !== 'no') it.ya = false;
      poner('t-c-' + i, entero(it.c, 1, 1) + '×'); poner('t-nm-' + i, it.n || '(sin nombre)'); poner('t-im-' + i, it.i || '—'); poner('t-d-' + i, textoDestino(it));
    });
    poner('t-dif', textoDiferencia(t));
    poner('t-alacena-txt', textoAlacena(t.items.filter(it => it.dest !== 'no').length));
    const rep = textoRepetido(H), elRep = document.getElementById('t-repetido');
    if (elRep) { elRep.textContent = rep; elRep.hidden = !rep; }
  }

  /* ---------- códigos de barras ---------- */
  // El lector de códigos que trae el navegador, si lo tiene y conoce los formatos de almacén. Si no, null.
  let detector = null;
  function detectorNativo() {
    if (!detector) {
      detector = (async () => {
        if (!('BarcodeDetector' in window)) return null;
        try {
          const sop = await window.BarcodeDetector.getSupportedFormats();
          const fm = ['ean_13', 'ean_8', 'upc_a'].filter(f => sop.includes(f));
          return fm.length ? new window.BarcodeDetector({ formats: fm }) : null;
        } catch (e) { return null; }
      })();
    }
    return detector;
  }
  async function conNativo(fuente) {
    const d = await detectorNativo();
    if (!d) return null;
    try {
      for (const b of await d.detect(fuente)) { const c = String(b.rawValue || '').replace(/\D/g, ''); if (Barras.gtinValido(c)) return c; }
    } catch (e) { /* sigue el lector propio */ }
    return null;
  }
  // Busca un código de barras en una foto ya abierta: con el lector del navegador y, si no, con el propio.
  async function leerCodigo(im, vivo) {
    const nativo = await conNativo(Imagen.lienzo(im, 2000));
    if (nativo) return nativo;
    const mayor = Math.max(im.w, im.h);
    for (const lado of mayor > 1900 ? [1600, Math.min(3200, mayor)] : [1600]) {
      const c = Imagen.lienzo(im, lado), lum = Imagen.grises(c), votos = new Map();
      for (const g of Barras.ANGULOS) {
        const r = Barras.leerAngulo(lum, c.width, c.height, g, votos);
        if (r) return r;
        await pausa(0);
        if (!vivo()) return null;
      }
    }
    return null;
  }
  // La alacena como la necesita el lector de fotos, para que reconozca lo que ya está cargado.
  const listaParaLector = () => prodReales().slice(0, 300).map(([id, p]) => ({ id, texto: [p.nombre, p.marca || '', p.presentacion || ''].join(' | ') }));
  // El producto de la alacena que tiene ese código, o null.
  function porCodigo(c) {
    const k = Barras.canonico(c);
    if (!k) return null;
    for (const [id, p] of prodReales()) if (p.codigo && Barras.canonico(p.codigo) === k) return id;
    return null;
  }

  /* ---------- escanear un producto ---------- */
  // `nuevo`: todavía no está en la alacena; el comercio que se propone es el de la última compra anotada en este teléfono.
  function formProducto(d, nuevo) {
    const hist = N.precios(d), ult = hist.length ? hist[hist.length - 1] : null;
    return {
      nombre: d.nombre || '', marca: d.marca || '', presentacion: d.presentacion || '', categoria: d.categoria || 'almacen', codigo: d.codigo || '',
      stock: String(d.stock == null ? 1 : d.stock), aviso: String(d.aviso || 0), reponer: d.reponer !== false, precio: d.precio > 0 ? N.campoPlata(d.precio) : '',
      comercio: ult ? ult[2] : nuevo ? ultimoComercio() : '', marcaFija: !!d.marcaFija,
      diario: N.esDiario({ categoria: d.categoria || 'almacen', diario: d.diario }), diarioTocado: d.diario === true || d.diario === false,
    };
  }
  const conocido = (id, extra) => { pintarComercios(); cambiarHoja({ estado: 'conocido', id, cant: '1', precio: '', comercio: ultimoComercio(), error: '', codigoNuevo: '', leido: null, cerca: null, ...extra }); };

  // Una foto del producto: del código de barras o del frente del envase.
  async function fotoProducto(archivo, detalle) {
    if (!puede() || !Imagen.esImagen(archivo)) return;
    const url = URL.createObjectURL(archivo);
    abrirHoja({ tipo: 'escanear', estado: 'leyendo', paso: 'codigo', mini: url, urls: [url], ctl: new AbortController(), archivo, modo: E.modoEscaneo });
    const H = E.hoja, turno = E.turno, vivo = () => E.turno === turno && E.hoja === H;
    let im;
    try { im = await Imagen.abrir(archivo); }
    catch (e) { if (vivo()) cambiarHoja({ estado: 'espera', nota: 'No se pudo abrir esa imagen. Probá con otra foto.' }); return; }
    try {
      let codigo = null;
      try { codigo = await leerCodigo(im, vivo); } catch (e) { codigo = null; }
      if (vivo()) await trasLeer(H, vivo, codigo, im, detalle);
    } finally { im.cerrar(); }
  }

  /* Con el código ya buscado (puede no haberlo), decide qué sigue. Si es de un producto de la alacena, se le
     suman unidades. Si no, se averiguan los datos —por el código, o leyendo la etiqueta de la foto— y se abre
     la ficha para confirmarlos. `im` es la foto abierta, o null si el código salió de la cámara en vivo. */
  async function trasLeer(H, vivo, codigo, im, detalle) {
    if (H.modo === 'precio') { await gondola(H, vivo, codigo); return; }
    if (codigo) { const id = porCodigo(codigo); if (id) { conocido(id); return; } }
    let leido = null, nota = '', sinRed = false;
    if (codigo && Lector.porCodigo) {
      cambiarHoja({ estado: 'leyendo', paso: 'buscando' });
      try {
        const r = await Lector.porCodigo(codigo, { signal: H.ctl.signal });
        if (r) leido = { legible: true, existente: null, ...r, codigo };
      } catch (e) { sinRed = true; }
      if (!vivo()) return;
    }
    if (!leido && im && Lector.etiquetas()) {
      cambiarHoja({ estado: 'leyendo', paso: 'etiqueta' });
      try { leido = await Lector.etiqueta(im, listaParaLector(), { detalle, signal: H.ctl.signal }); }
      catch (e) {
        if (!vivo() || (e && e.code === 'cancelled')) return;
        nota = Lector.nota(e);
      }
      if (!vivo()) return;
    }
    const cod = codigo || (leido && leido.codigo) || '';
    if (!codigo && cod) { const id = porCodigo(cod); if (id) { conocido(id); return; } }
    if (leido && leido.existente && E.prod.has(leido.existente)) { conocido(leido.existente, { codigoNuevo: cod, leido }); return; }
    if (!leido && !cod && !nota) {   // ni código ni quién lea la etiqueta: se pide otra foto
      cambiarHoja({ estado: 'espera', nota: 'No se encontró un código de barras en esa foto. Tiene que verse entero, de cerca y sin reflejos.' });
      return;
    }
    const ok = !!(leido && leido.legible);
    const aviso = ok ? (leido.fuente === 'codigo' ? 'Estos datos salen de buscar el código de barras en una base pública de productos. Revisalos y corregí lo que haga falta.'
      : 'Esto se leyó de la foto. Revisá los datos y corregí lo que haga falta.')
      : nota ? nota
        : leido ? `No se llegó a reconocer el producto en la foto.${cod ? ' El código de barras sí se leyó.' : ''} Completá los datos o probá con otra foto.`
          : sinRed ? 'Se leyó el código de barras, pero no se pudo consultar de qué producto es: puede que no haya conexión. Completá el nombre una vez y la próxima se reconoce solo.'
            : Lector.porCodigo ? 'Se leyó el código de barras, pero ese producto no figura en la base pública. Completá el nombre una vez y la próxima se reconoce solo.'
              : 'Se leyó el código de barras. Completá el nombre una vez y la próxima se reconoce solo.';
    cambiarHoja({
      tipo: 'producto', id: null, f: formProducto(ok ? { ...leido, codigo: cod } : { codigo: cod }, true), aviso, deEscaneo: true,
      puedeDetalle: !!leido && !ok && !detalle && !!H.archivo && Lector.etiquetas(), sucio: true, error: '',
    });
  }
  /* ---------- en la góndola ----------
     Con el producto en la mano: cuánto se pagó la última vez, lo más barato cerca (de otros hogares y de los precios
     oficiales) y, al escribir el precio que se ve, si conviene. Se anota solo el precio o, si se lo lleva, también suma. */
  async function gondola(H, vivo, codigo) {
    if (!codigo) { cambiarHoja({ estado: 'espera', nota: 'No se encontró un código de barras. Tiene que verse entero, de cerca y sin reflejos.' }); return; }
    const id = porCodigo(codigo), canon = Barras.canonico(codigo), p = id ? verProd(id) : null;
    pintarComercios();
    cambiarHoja({ estado: 'gondola', id, codigo: canon, codigoLeido: String(codigo).replace(/\D/g, ''), nombre: p ? N.textoProducto(p) : '', info: null, precio: '', comercio: ultimoComercio(), error: '', zona: null, estadoZona: puedeCerca() ? 'buscando' : 'sin', ocupado: false });
    if (!id && Lector.porCodigo) {
      try {
        const r = await Lector.porCodigo(codigo, { signal: H.ctl.signal });
        if (!vivo()) return;
        if (r) { H.info = r; H.nombre = [r.nombre, r.marca, r.presentacion].filter(Boolean).join(' · '); renderHoja(); }
      } catch (e) { /* sin nombre: se ve el código */ }
    }
    if (!puedeCerca()) return;
    let pos = C.ultimaPosicion();
    if (!pos) { try { pos = await C.posicion(true); } catch (e) { pos = null; } }      // se tocó «comparar precio»: se puede preguntar
    let zona = null;
    if (pos) { try { zona = (await C.buscar(pos, [canon])).get(canon) || []; } catch (e) { zona = null; } }
    if (!vivo() || E.hoja !== H || H.estado !== 'gondola') return;
    H.zona = zona ? zona.map(o => Object.assign({}, o, { dist: A.distancia(pos.lat, pos.lon, o.lat, o.lon) })) : null;
    H.estadoZona = pos ? 'listo' : 'sin-ubicacion';
    renderHoja();
  }
  function datosGondola(H) {
    const p = H.id ? verProd(H.id) : null, hist = p ? N.precios(p) : [], ult = hist.length ? hist[hist.length - 1] : null;
    const zona = H.zona ? (p ? deLaZona(p, H.zona) : H.zona.map(o => Object.assign({}, o, { comercio: nombreDeRef(o.k) || o.comercio || '' }))).filter(o => !o.propio) : null;
    const precios = zona ? zona.filter(o => !ult || o.precio >= ult[1] * 0.4) : null;       // uno tan barato casi siempre está mal cargado
    return { p, ult, mejor: precios && precios.length ? precios.slice().sort((a, b) => a.precio - b.precio)[0] : null, hayZona: !!zona };
  }
  function veredictoGondola(H) {
    const v = N.aNumero(limpio(H.precio)), d = datosGondola(H);
    if (!(v > 0)) return { tono: '', texto: d.ult || d.mejor ? 'Escribí el precio que ves y te digo si conviene.' : 'Escribí el precio que ves: así la próxima vez sabés si subió.' };
    if (d.mejor && v > d.mejor.precio * 1.03) {
      return { tono: 'rojo', texto: `Está ${A.pct(v / d.mejor.precio - 1)} más caro que ${d.mejor.comercio ? `en ${d.mejor.comercio}` : 'cerca'} (${N.plata(d.mejor.precio)}${d.mejor.dist != null ? `, a ${A.distTexto(d.mejor.dist)}` : ''}).` };
    }
    if (d.ult && v > d.ult[1] * 1.03) return { tono: 'ambar', texto: `Subió ${A.pct(v / d.ult[1] - 1)} desde la última vez (${N.plata(d.ult[1])}).${d.mejor ? ' Igual, cerca no se vio más barato.' : ''}` };
    if (d.mejor) return { tono: 'verde', texto: 'Buen precio: es lo más barato que se vio cerca.' };
    if (d.ult) return { tono: 'verde', texto: v < d.ult[1] * 0.97 ? `Bajó ${A.pct(1 - v / d.ult[1])} desde la última vez. Buen precio.` : 'Igual que la última vez.' };
    return { tono: '', texto: 'Anotalo: así la próxima vez sabés si subió.' };
  }
  const enlaceSinCodigo = h`<button type="button" class="btn btn-grande sin-codigo" data-act="sin-codigo">No tiene código<small>pan, fruta, verdura, carne, comida de rotisería…</small></button>`;
  // Lo que se sabe del precio: lo que pagó este hogar la última vez y lo más barato cerca.
  function filasGondola(H, d, hoy) {
    return h`${d.ult ? h`<li><span>La última vez lo pagaste</span><strong>${N.plata(d.ult[1])}</strong><small>${[A.haceDias(hoy - d.ult[0]), d.ult[2] ? `en ${d.ult[2]}` : ''].filter(Boolean).join(' · ')}</small></li>` : ''}
        ${H.estadoZona === 'buscando' ? h`<li>${cargando('Mirando precios cerca…')}</li>`
          : d.mejor ? h`<li><span>Lo más barato cerca</span><strong class="verde">${N.plata(d.mejor.precio)}</strong><small>${detalleOferta(d.mejor, hoy)}</small></li>`
            : H.estadoZona === 'sin-ubicacion' ? h`<li><span class="tenue">Para comparar con tu zona, activá tu ubicación en Ofertas.</span></li>`
              : d.hayZona ? h`<li><span class="tenue">Todavía nadie cargó este producto cerca. ¡Sé el primero!</span></li>` : ''}`;
  }
  // Un precio de algo sin código de barras: qué es (lo puede decir la IA con una foto), cuánto sale y dónde.
  /* ---------- lo que no tiene código: por unidad, por kilo o en combo ----------
     Por kilo, el precio es el del kilo y en la alacena se cuentan kilos; la clave para la zona lleva «-xkg», así un
     precio por kilo solo se compara con otros por kilo. Un combo («3 kg de pata muslo + 2 kg de milanesa») se comparte
     como tal, en la alacena se suman sus partes y se compara con lo que costarían sueltas cerca. */
  const VENDE = [['unidad', 'Unidad'], ['kilo', 'Kilo'], ['combo', 'Combo']];
  const UNIDADES_COMBO = [['kg', 'kg'], ['u', 'unidades']];
  const cantTexto = (q, u) => (u === 'kg' ? `${N.num(q)} kg` : `${N.num(q)} ${N.plural(q, 'unidad', 'unidades')}`);
  // Las partes de un combo escritas de corrido: «Combo 3kpata muslo 2k milanesa» → [3 kg pata muslo, 2 kg milanesa].
  function partesCombo(texto) {
    const t = String(texto || '').replace(/^\s*combo\s*/i, ' ').replace(/[+,;y]\s/gi, m => m.replace(/[+,;]/, ' '));
    const re = /(\d+(?:[.,]\d+)?)\s*(kg|kgs|kilos?|k|u|un|unid(?:ades)?|x)?\.?\s*(?:de\s+)?([a-záéíóúñü][a-záéíóúñü ]*?)(?=\s*(?:\d|\+|$))/gi, out = [];
    let m;
    while ((m = re.exec(t)) && out.length < 8) {
      const q = N.aNumero(m[1].replace(',', '.')), n = m[3].replace(/\s+y\s*$/i, '').trim();
      if (q > 0 && n.length >= 2) out.push({ n: N.mayuscula(n), q: String(q), u: /^k/i.test(m[2] || '') ? 'kg' : 'u' });
    }
    return out;
  }
  const partesValidas = l => (l || []).map(c => ({ n: N.mayuscula(limpio(c.n).slice(0, 40)), q: N.aNumero(String(c.q).replace(',', '.')), u: c.u === 'kg' ? 'kg' : 'u' })).filter(c => c.n.length >= 2 && c.q > 0 && c.q < 1000);
  const textoCombo = l => ('Combo: ' + l.map(c => `${cantTexto(c.q, c.u)} de ${c.n.toLowerCase()}`).join(' + ')).slice(0, 60);
  // Lo que cada parte del combo costaría suelta cerca (lo más barato de la zona) y la cuenta contra el precio del combo.
  function cuentaCombo(H) {
    const partes = partesValidas(H.comps), precio = N.aNumero(limpio(H.precio));
    if (partes.length < 2 || !H.cmpZona) return null;
    const con = [], faltan = [];
    let suma = 0;
    for (const c of partes) {
      const l = (H.cmpZona.get(claveSuelto(c.n, c.u === 'kg')) || []).filter(o => !o.propio);
      if (!l.length) { faltan.push(c); continue; }
      const o = l[0], sub = N.redondear2(o.precio * c.q);
      suma += sub; con.push({ c, o, sub });
    }
    return { con, faltan, suma: N.redondear2(suma), precio: precio > 0 ? precio : 0 };
  }
  function vistaCuentaCombo(H) {
    if (H.vende !== 'combo') return '';
    const k = cuentaCombo(H);
    if (!k) return H.cmpBuscando ? cargando('Mirando cuánto salen sueltos cerca…') : '';
    const lineas = k.con.map(x => h`<li><span>${cantTexto(x.c.q, x.c.u)} de ${x.c.n.toLowerCase()}</span><strong>${N.plata(x.sub)}</strong>
      <small>${N.plata(x.o.precio)} ${x.c.u === 'kg' ? 'el kilo' : 'cada una'} en ${nombreDeRef(x.o.k) || x.o.comercio || 'un comercio cerca'}</small></li>`);
    let veredicto = '';
    if (!k.con.length) veredicto = h`<p class="tenue chico">Para saber si conviene hace falta el precio suelto cerca de: ${k.faltan.map(c => c.n.toLowerCase()).join(', ')}${k.faltan.some(c => c.u === 'kg') ? ' (por kilo)' : ''}. Cuando algún hogar lo avise, te lo digo.</p>`;
    else if (k.faltan.length) veredicto = h`<p class="tenue chico">Falta el precio suelto de: ${k.faltan.map(c => c.n.toLowerCase()).join(', ')}. Con lo que se sabe, por separado sale al menos ${N.plata(k.suma)}.</p>`;
    else if (k.precio > 0) {
      const dif = N.redondear2(k.suma - k.precio), pct = Math.round(Math.abs(dif) / k.suma * 100);
      veredicto = dif > 0 ? h`<p class="gondola-veredicto verde">Conviene: por separado sale ${N.plata(k.suma)}. El combo te ahorra ${N.plata(dif)} (${pct} %).</p>`
        : dif < 0 ? h`<p class="gondola-veredicto rojo">No conviene: por separado sale ${N.plata(k.suma)}, ${N.plata(-dif)} menos (${pct} %).</p>`
          : h`<p class="gondola-veredicto">Da lo mismo que comprarlo por separado (${N.plata(k.suma)}).</p>`;
    } else veredicto = h`<p class="tenue chico">Por separado, cerca, sale ${N.plata(k.suma)}. Escribí el precio del combo y te digo si conviene.</p>`;
    return h`<div class="combo-cuenta">${k.con.length ? h`<ul class="gondola-datos">${lineas}</ul>` : ''}${veredicto}</div>`;
  }
  function pintarCuentaCombo(H) { const el = $('#s-combo-cuenta'); if (el) el.innerHTML = val(vistaCuentaCombo(H)); }
  // Busca cerca el precio suelto de cada parte del combo (cuando cambian las partes).
  async function buscarPartesCombo(H) {
    const partes = partesValidas(H.comps), claves = partes.map(c => claveSuelto(c.n, c.u === 'kg')).filter(Boolean), firma = claves.join('|');
    if (firma === H.cmpFirma) return;
    H.cmpFirma = firma; H.cmpZona = null;
    if (partes.length < 2 || !puedeCerca()) { pintarCuentaCombo(H); return; }
    H.cmpBuscando = true; pintarCuentaCombo(H);
    let pos = C.ultimaPosicion();
    if (!pos) { try { pos = await C.posicion(true); } catch (e) { pos = null; } }
    let m = new Map();
    if (pos) { try { m = await C.buscar(pos, claves); } catch (e) { m = new Map(); } }
    if (E.hoja !== H || H.cmpFirma !== firma) return;
    H.cmpBuscando = false; H.cmpZona = m;
    pintarCuentaCombo(H);
  }
  function vistaSuelto(H) {
    const d = datosGondola(H), hoy = hoyDia(), ver = veredictoGondola(H), combo = H.vende === 'combo', kilo = H.vende === 'kilo';
    const hayFilas = !!H.clave && !!(d.ult || d.mejor || d.hayZona || H.estadoZona === 'buscando' || H.estadoZona === 'sin-ubicacion');
    return marco(H.avisar ? 'Avisar un precio' : 'Precio sin código', h`<form class="form" data-form="suelto" novalidate>
      ${H.avisar ? h`<p class="tenue chico">Lo ven al instante los hogares de tu zona, en el mapa${E.ajustes.alias ? `, como «${E.ajustes.alias}»` : ', sin tu nombre'}. ¿Tiene código de barras? <button type="button" class="enlace" data-act="gondola">Escanealo</button></p>` : ''}
      ${hayIA() ? h`<div class="ia-foto" aria-live="polite">${H.leyendo ? cargando('La IA está mirando la foto…') : h`<div class="acciones">
          <button type="button" class="btn btn-chico${H.aviso ? '' : ' btn-principal'}" data-act="suelto-foto">${ico('camara')}${H.aviso ? 'Otra foto' : 'Sacale una foto'}</button>
          <button type="button" class="enlace" data-act="suelto-galeria">o elegila de la galería</button></div>`}
        ${H.aviso ? h`<p class="nota gris chico">${H.aviso}</p>` : h`<p class="tenue chico">La inteligencia artificial te dice qué es, si va por kilo o es un combo (y el precio, si se ve el cartel). Solo se envía la foto.</p>`}</div>`
        : h`<p class="tenue chico">Para lo que no tiene código de barras: pan, fruta, verdura, carne, comida de rotisería…</p>`}
      ${campo(combo ? 'Cómo se llama el combo' : 'Qué es', h`<input type="text" id="s-nombre" data-k="nombre" data-suelto value="${H.nombre}" maxlength="60" autocomplete="off" list="lista-sueltos" placeholder="${combo ? 'Combo 3 kg pata muslo + 2 kg milanesa' : 'Pizza de muzzarella'}">`,
        combo ? '' : H.id ? 'Ya está en tu alacena.' : 'Un nombre corto y común: así lo encuentran los otros hogares.')}
      <div class="campo"><span id="s-vende-r">Se vende por</span><div class="segmentos" role="group" aria-labelledby="s-vende-r">${VENDE.map(([v, t]) => h`<button type="button" data-act="suelto-vende" data-v="${v}" aria-pressed="${H.vende === v ? 'true' : 'false'}">${t}</button>`)}</div></div>
      ${combo ? h`<div class="campo"><span>Qué trae</span><ul class="partes">${H.comps.map((c, i) => h`<li>
          <input type="text" id="s-q-${i}" data-k="comps.${i}.q" data-combo value="${c.q}" inputmode="decimal" autocomplete="off" aria-label="Cantidad" placeholder="3">
          <select id="s-u-${i}" data-k="comps.${i}.u" data-combo aria-label="Unidad">${opciones(UNIDADES_COMBO, c.u)}</select>
          <input type="text" id="s-n-${i}" data-k="comps.${i}.n" data-combo value="${c.n}" maxlength="40" autocomplete="off" aria-label="Qué" placeholder="Pata muslo">
          <button type="button" class="icono-btn" data-act="suelto-parte-quitar" data-i="${i}" aria-label="Quitar">${ico('x')}</button></li>`)}</ul>
          <button type="button" class="enlace" data-act="suelto-parte">${ico('mas')}Agregar otra cosa</button></div>
        <div id="s-combo-cuenta" aria-live="polite">${vistaCuentaCombo(H)}</div>` : ''}
      ${!combo && hayFilas ? h`<ul class="gondola-datos">${filasGondola(H, d, hoy)}</ul>` : ''}
      <div class="dos">
        ${campo(combo ? 'Precio del combo' : kilo ? 'Precio por kilo' : 'Precio', h`<input type="text" id="g-precio" data-k="precio" value="${H.precio}" inputmode="decimal" autocomplete="off" placeholder="$">`)}
        ${kilo ? campo('Cuántos kilos llevás', h`<input type="text" id="s-kilos" data-k="kilos" value="${H.kilos}" inputmode="decimal" autocomplete="off" placeholder="1">`) : ''}
      </div>
      ${combo ? '' : h`<p class="gondola-veredicto ${ver.tono}" id="g-veredicto" aria-live="polite">${ver.texto}</p>`}
      ${campoComercio('g-comercio', 'comercio', H.comercio || '', 'Dónde estás')}
      ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
      <div class="hoja-pie"><button type="submit" class="btn"${atr('disabled', H.ocupado || H.leyendo)}>Solo anotar el precio</button>
        <button type="button" class="btn btn-principal" data-act="suelto-llevo"${atr('disabled', H.ocupado || H.leyendo)}>Lo llevo</button></div></form>`);
  }
  // La clave de la zona según cómo se vende.
  function claveDeSuelto(H) {
    if (H.vende === 'combo') { const l = partesValidas(H.comps); return l.length >= 2 ? claveNombre(textoCombo(l)) : ''; }
    return claveSuelto(H.nombre, H.vende === 'kilo');
  }
  // Con el nombre puesto: si ya está en la alacena y qué precios hay cerca.
  async function actualizarSuelto(H) {
    if (H.vende !== 'combo' && /^\s*combo\b/i.test(H.nombre || '') && !H.vendeElegido) {      // «Combo 3k pata muslo…»: es un combo
      const l = partesCombo(H.nombre);
      if (l.length >= 2) { H.vende = 'combo'; H.comps = l; }
    } else if (H.vende === 'combo' && !partesValidas(H.comps).length) {
      const l = partesCombo(H.nombre);
      if (l.length) H.comps = l;
    }
    if (H.vende === 'combo') buscarPartesCombo(H);
    const clave = claveDeSuelto(H);
    if (clave === H.clave) { renderHoja(); return; }
    H.clave = clave; H.id = H.vende === 'combo' ? null : productoSuelto(clave); H.zona = null;
    if (H.id) H.cat = catDe(E.prod.get(H.id));
    H.estadoZona = clave && puedeCerca() ? 'buscando' : 'sin';
    renderHoja();
    if (H.estadoZona !== 'buscando') return;
    let pos = C.ultimaPosicion();
    if (!pos) { try { pos = await C.posicion(true); } catch (e) { pos = null; } }
    let zona = null;
    if (pos) { try { zona = (await C.buscar(pos, [clave])).get(clave) || []; } catch (e) { zona = null; } }
    if (E.hoja !== H || H.estado !== 'suelto' || H.clave !== clave) return;
    H.zona = zona ? zona.map(o => Object.assign({}, o, { dist: A.distancia(pos.lat, pos.lon, o.lat, o.lon) })) : null;
    H.estadoZona = pos ? 'listo' : 'sin-ubicacion';
    renderHoja();
  }
  function pintarSueltos() {
    let dl = $('#lista-sueltos');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'lista-sueltos'; document.body.appendChild(dl); }
    const ns = V.prods.filter(([, p]) => !p.ejemplo && !conBarras(p)).map(([, p]) => p.nombre).filter(Boolean);
    dl.innerHTML = val(Array.from(new Set(ns)).slice(0, 60).map(n => h`<option value="${n}"></option>`));
  }
  async function fotoSuelto(archivo) {
    const H = E.hoja;
    if (!H || H.estado !== 'suelto' || H.leyendo || !hayIA() || !archivo) return;
    cambiarHoja({ leyendo: true, error: '' });
    let r = null, falla = null;
    try {
      let foto;
      try { const im = await Imagen.abrir(archivo); try { foto = await Imagen.aBlob(Imagen.lienzo(im, 1280), 0.85); } finally { im.cerrar(); } }
      catch (e) { throw { code: 'imagen' }; }
      r = await IA.producto(foto);
    } catch (e) { falla = e; }
    if (E.hoja !== H) return;
    H.leyendo = false;
    if (falla || !r) { const t = IA.nota(falla); if (t) errorHoja(t); else renderHoja(); return; }
    if (!r.esProducto) { errorHoja('En esa foto no se ve qué es. Probá con otra o escribilo.'); return; }
    H.nombre = r.nombre; H.cat = r.categoria; H.vende = r.vende; H.vendeElegido = true;
    if (r.vende === 'combo') H.comps = r.partes.map(c => ({ n: c.n, q: String(c.q), u: c.u }));
    if (r.precio > 0 && !limpio(H.precio)) H.precio = N.plata(r.precio).replace(/^\$\s*/, '');
    H.aviso = `La IA dice que es «${r.nombre}»${r.vende === 'kilo' ? ', por kilo' : r.vende === 'combo' ? `, un combo con ${r.partes.map(c => `${cantTexto(c.q, c.u)} de ${c.n.toLowerCase()}`).join(' y ')}` : ''}${r.precio > 0 ? ` y que sale ${N.plata(r.precio)}` : ''}. Corregilo si hace falta.`;
    H.clave = null; H.cmpFirma = null;
    await actualizarSuelto(H);
  }
  async function guardarSuelto(llevo) {
    const H = E.hoja;
    if (!H || H.estado !== 'suelto' || H.ocupado || H.leyendo || !puede()) return;
    const combo = H.vende === 'combo', kilo = H.vende === 'kilo', partes = combo ? partesValidas(H.comps) : [];
    const nombre = combo ? (N.mayuscula(limpio(H.nombre).slice(0, 60)) || textoCombo(partes)) : N.mayuscula(limpio(H.nombre).slice(0, 60));
    const clave = claveDeSuelto(H), texto = combo ? textoCombo(partes) : kilo ? `${nombre.slice(0, 50)} (por kg)` : nombre;
    const txt = limpio(H.precio), precio = txt ? N.aNumero(txt) : 0, comercio = limpio(H.comercio).slice(0, 60);
    const kilos = kilo ? (limpio(H.kilos) ? N.aNumero(String(H.kilos).replace(',', '.')) : 1) : 1;
    if (combo && partes.length < 2) return errorHoja('Poné al menos dos cosas que trae el combo, con su cantidad: por ejemplo 3 kg de pata muslo y 2 kg de milanesa.', 's-q-0');
    if (!clave) return errorHoja('Escribí qué es: por ejemplo «Pizza de muzzarella».', 's-nombre');
    if (!(precio > 0)) return errorHoja(txt ? 'El precio no se entiende. Escribilo así: 1.450,50' : 'Escribí cuánto sale.', 'g-precio');
    if (kilo && llevo && !(kilos > 0 && kilos < 1000)) return errorHoja('¿Cuántos kilos llevás? Por ejemplo 1,5', 's-kilos');
    if (H.avisar && !refDeComercio(comercio)) return errorHoja(comercio ? 'Ubicá ese comercio en el mapa (el botón del pin): así el precio aparece donde corresponde.' : 'Elegí en qué comercio está (el botón del pin).', 'g-comercio');
    if (H.avisar && E.ajustes.compartir === false) return errorHoja('Tu hogar eligió no compartir precios con la zona. Se cambia en Ajustes → «Compartir los precios que anoto».');
    if (H.avisar && E.ajustes.compartir == null) { try { await cambiarAjustes({ compartir: true }); } catch (e) { return errorHoja(textoFallo(e)); } }
    ocupar(true);
    const ref = refDeComercio(comercio);
    // un combo: en la alacena se suman sus partes (sin precio: no se sabe cuánto vale cada una); a la zona va el combo
    if (combo) {
      const sumadas = [];
      try {
        if (llevo) {
          for (const c of partes) {
            const kc = claveSuelto(c.n, c.u === 'kg'), cant = Math.max(1, Math.round(c.q));
            const id = productoSuelto(kc);
            if (id) { if (await mover(id, { c: cant }, null, true)) sumadas.push(c); }
            else { await crearProducto({ nombre: c.n, categoria: H.cat === 'otros' ? 'carnes' : H.cat, stock: cant, suelto: true, porKg: c.u === 'kg' }); sumadas.push(c); }
          }
        }
      } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e)); else falloGuardar(e); return; }
      let n = 0;
      if (ref && E.ajustes.compartir === true && puedeCerca()) { try { n = await aportarZona([{ codigo: clave, precio, reco: 0, texto, cat: H.cat }], ref, hoyDia(), E.ajustes.alias, lugarDe(ref)); } catch (e) { n = 0; } }
      if (E.hoja !== H) return;
      if (comercio) recordarComercio(comercio);
      const k = cuentaCombo(H);
      const cuenta = k && !k.faltan.length && k.suma > 0 ? (k.suma > precio ? ` Por separado saldría ${N.plata(k.suma)}: te ahorraste ${N.plata(k.suma - precio)}.` : k.suma < precio ? ` Por separado saldría ${N.plata(k.suma)}.` : '') : '';
      cambiarHoja({ estado: 'hecho', ocupado: false, error: '', fallo: false, sinCodigo: false, cerca: null,
        texto: (llevo ? `Se ${N.plural(sumadas.length, 'sumó', 'sumaron')} a la alacena: ${sumadas.map(c => `${cantTexto(c.q, c.u)} de ${c.n.toLowerCase()}`).join(' y ')}.` : `Combo anotado: ${N.plata(precio)}${comercio ? ` en ${comercio}` : ''}.`)
          + (n ? ' Ya lo ven los hogares de tu zona.' : !ref ? ' Para que lo vean otros hogares, ubicá el comercio en el mapa.' : '') + cuenta });
      return;
    }
    let id = H.id && E.prod.has(H.id) && codigoDe({ ...E.prod.get(H.id), suelto: true }) === clave ? H.id : productoSuelto(clave);
    const cant = kilo ? Math.max(1, Math.round(kilos)) : 1;
    try {
      if (id) {
        const p = E.prod.get(id);
        if (!p.suelto || !!p.porKg !== kilo) { const cambio = { suelto: true, porKg: kilo }; E.prod.set(id, { ...p, ...cambio }); await enCola(id, () => escribir(() => E.db.doc('productos/' + id).update(cambio))); }
        if (!await mover(id, { c: llevo ? cant : 0 }, precioDe(precio, comercio), true)) { if (E.hoja === H) ocupar(false); return; }
      } else if (llevo) {
        id = await crearProducto({ nombre, categoria: H.cat, stock: cant, precio, comercio, ref, suelto: true, porKg: kilo });
      }
    } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e)); else falloGuardar(e); return; }
    if (E.hoja !== H) return;
    if (comercio) recordarComercio(comercio);
    if (id) {
      const p = verProd(id) || {};
      cambiarHoja({ estado: 'hecho', ocupado: false, error: '', fallo: false, sinCodigo: false, cerca: null,
        texto: llevo ? `${p.nombre}: se ${kilo ? `sumaron ${cant} kg` : 'sumó 1'} a la alacena. Ahora hay ${p.stock}${kilo ? ' kg' : ''}.` : `Precio anotado: ${N.plata(precio)}${kilo ? ' el kilo' : ''}${comercio ? ` en ${comercio}` : ''}.` });
      trasCompra([{ id, precio, cant: llevo ? cant : 1 }], comercio).then(r => { if (r && E.hoja === H && H.estado === 'hecho') { H.cerca = r; renderHoja(); } });
      return;
    }
    // solo el precio de algo que no está en la alacena: sirve para la zona, si el hogar comparte y el comercio está ubicado
    let n = 0;
    if (ref && E.ajustes.compartir === true && puedeCerca()) { try { n = await aportarZona([{ codigo: clave, precio, reco: 0, texto, cat: H.cat }], ref, hoyDia(), E.ajustes.alias, lugarDe(ref)); } catch (e) { n = 0; } }
    if (E.hoja !== H) return;
    cambiarHoja({ estado: 'hecho', ocupado: false, error: '', fallo: false, sinCodigo: false, cerca: null,
      texto: n ? `Precio anotado: ${nombre}, ${N.plata(precio)}${kilo ? ' el kilo' : ''} en ${comercio}. Ya lo ven los hogares de tu zona. ¡Gracias!`
        : !ref ? 'Para que ese precio les sirva a otros hogares, ubicá el comercio en el mapa (el botón del pin).'
          : E.ajustes.compartir !== true ? 'Tu hogar no comparte precios con la zona: se cambia en Ajustes. Como no está en tu alacena, el precio no se guardó.'
            : 'No se pudo anotar el precio. Probá de nuevo.' });
  }

  function vistaGondola(H) {
    const d = datosGondola(H), hoy = hoyDia(), ver = veredictoGondola(H);
    return marco('¿Está a buen precio?', h`<form class="form" data-form="gondola" novalidate>
      <div class="conocido"><div><p class="rotulo">${d.p ? 'Está en tu alacena' : 'En la góndola'}</p><p class="conocido-nombre">${H.nombre || 'Producto nuevo'}</p>
        <p class="tenue chico">${d.p ? `hay ${d.p.stock || 0} en casa` : `código ${H.codigo}`}</p></div></div>
      <ul class="gondola-datos">${filasGondola(H, d, hoy)}</ul>
      ${campo('Precio acá', h`<input type="text" id="g-precio" data-k="precio" value="${H.precio}" inputmode="decimal" autocomplete="off" placeholder="$">`)}
      <p class="gondola-veredicto ${ver.tono}" id="g-veredicto" aria-live="polite">${ver.texto}</p>
      ${campoComercio('g-comercio', 'comercio', H.comercio || '', 'Dónde estás')}
      ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
      <div class="hoja-pie"><button type="submit" class="btn"${atr('disabled', H.ocupado)}>Solo anotar el precio</button>
        <button type="button" class="btn btn-principal" data-act="gondola-llevo"${atr('disabled', H.ocupado)}>Lo llevo</button></div></form>`);
  }
  async function guardarGondola(llevo) {
    const H = E.hoja;
    if (!H || H.estado !== 'gondola' || H.ocupado || !puede()) return;
    const txt = limpio(H.precio), precio = txt ? N.aNumero(txt) : 0, comercio = limpio(H.comercio).slice(0, 60);
    if (!(precio > 0)) return errorHoja(txt ? 'El precio no se entiende. Escribilo así: 1.450,50' : 'Escribí el precio que ves en la góndola.', 'g-precio');
    if (!H.id && llevo) {      // uno que no está en la alacena: se completan sus datos una vez
      const f = formProducto(Object.assign({}, H.info || {}, { codigo: H.codigoLeido || H.codigo, precio, stock: 1 }), true);
      f.comercio = comercio;
      cambiarHoja({ tipo: 'producto', id: null, f, deEscaneo: true, sucio: true, error: '', aviso: H.info ? 'Revisá los datos: salen de buscar el código de barras en una base pública.' : 'Completá el nombre una vez y la próxima se reconoce solo.' });
      return;
    }
    ocupar(true);
    if (H.id) {
      const cambio = notaPrecio(H.id, txt);
      const ok = await mover(H.id, { c: llevo ? 1 : 0 }, precioDe(precio, comercio), true);
      if (E.hoja !== H) return;
      if (!ok) { ocupar(false); return; }
      recordarComercio(comercio);
      const p = verProd(H.id) || {};
      cambiarHoja({ estado: 'hecho', texto: llevo ? `${p.nombre}: se sumó 1 a la alacena. Ahora hay ${p.stock}.${cambio ? ` ${cambio}.` : ''}` : `Precio anotado: ${N.plata(precio)}${comercio ? ` en ${comercio}` : ''}.${cambio ? ` ${cambio}.` : ''}`, ocupado: false, error: '', fallo: false, sinCodigo: false, cerca: null });
      trasCompra([{ id: H.id, precio, cant: 1 }], comercio).then(r => { if (r && E.hoja === H && H.estado === 'hecho') { H.cerca = r; renderHoja(); } });
      return;
    }
    // el precio de algo que no está en la alacena: sirve para la zona, si el hogar comparte y el comercio está ubicado
    const ref = refDeComercio(comercio);
    let n = 0;
    if (ref && E.ajustes.compartir === true && puedeCerca()) { try { n = await aportarZona([{ codigo: H.codigo, precio, reco: 0, texto: H.info ? [H.info.nombre, H.info.marca, H.info.presentacion].filter(Boolean).join(' ').slice(0, 60) : '', cat: H.info ? H.info.categoria : '' }], ref, hoyDia(), E.ajustes.alias, lugarDe(ref)); } catch (e) { n = 0; } }
    if (E.hoja !== H) return;
    if (comercio) recordarComercio(comercio);
    cambiarHoja({ estado: 'hecho', ocupado: false, error: '', fallo: false, sinCodigo: false, cerca: null,
      texto: n ? `Precio anotado: ${N.plata(precio)} en ${comercio}. Ya lo ven los hogares de tu zona. ¡Gracias!`
        : !ref ? 'Para que ese precio les sirva a otros hogares, ubicá el comercio en el mapa (el botón del pin).'
          : E.ajustes.compartir !== true ? 'Tu hogar no comparte precios con la zona: se cambia en Ajustes. Como el producto no está en tu alacena, el precio no se guardó.'
            : 'No se pudo anotar el precio. Probá de nuevo.' });
  }

  /* La foto de una promo: la IA la lee y completa la hoja; la persona revisa y la carga. */
  function comercioParecido(nombre) {
    const k = N.norm(nombre);
    if (!k) return '';
    const ns = Object.values(E.ajustes.comercios || {}).map(c => c.n).filter(Boolean);
    const igual = ns.find(n => N.norm(n) === k);
    if (igual) return igual;
    const empieza = ns.filter(n => N.norm(n).startsWith(k + ' ') || k.startsWith(N.norm(n) + ' '));
    return empieza.length === 1 ? empieza[0] : '';
  }
  async function fotoPromo(archivo) {
    const H = E.hoja;
    if (!H || H.tipo !== 'promo' || H.leyendo || !hayIA() || !archivo) return;
    cambiarHoja({ leyendo: true, error: '' });
    let r = null, falla = null;
    try {
      let foto;
      try { const im = await Imagen.abrir(archivo); try { foto = await Imagen.aBlob(Imagen.lienzo(im, 1600), 0.85); } finally { im.cerrar(); } }
      catch (e) { throw { code: 'imagen' }; }
      r = await IA.promo(foto, PROMO_MEDIOS, N.hoyISO());
    } catch (e) { falla = e; }
    if (E.hoja !== H) return;
    H.leyendo = false;
    if (falla || !r) { const t = IA.nota(falla); if (t) errorHoja(t); else renderHoja(); return; }
    if (!r.esPromo) { errorHoja('En esa foto no se ve una promo. Probá con otra, más cerca del cartel.'); return; }
    const c = { texto: r.texto, pct: r.pct ? String(r.pct) : '', medio: r.medio, dias: r.dias, error: '' };
    if (r.hasta) c.hasta = r.hasta;
    let dice = '';
    if (r.comercio) {
      const n = comercioParecido(r.comercio);
      if (n) c.comercio = n;
      else if (!refDeComercio(limpio(H.comercio))) { dice = r.comercio; c.comercio = r.comercio; }
    }
    c.aviso = 'Listo: la IA completó la promo. Revisá que esté bien antes de cargarla.'
      + (dice ? ` Ubicá «${dice}» en el mapa con el botón del pin.` : '') + (r.dudas ? ` Ojo: ${r.dudas}` : '');
    cambiarHoja(c);
  }

  /* ¿Qué cocino?: la IA propone comidas con lo que hay y se anota en la lista lo que falta. */
  const COMIDAS_TXT = { comida: 'Almuerzo o cena', rapido: 'Algo rápido', dulce: 'Dulce o merienda', vianda: 'Vianda' };
  const PRIMERO_COCINA = ['frescos', 'carnes', 'lacteos', 'panaderia', 'congelados'];
  function listaParaCocinar() {
    const orden = c => { const i = PRIMERO_COCINA.indexOf(c); return i < 0 ? 9 : i; };
    return V.prods.filter(([, p]) => !p.ejemplo && +p.stock > 0)
      .map(([id, p]) => ({ id, texto: [p.nombre, p.marca, p.presentacion].filter(Boolean).join(' ').slice(0, 90), cant: String(Math.round(+p.stock)), cat: N.CATS[catDe(p)] || 'otros', o: orden(catDe(p)) }))
      .sort((a, b) => a.o - b.o).slice(0, 120);
  }
  async function pensarRecetas(otras) {
    const H = E.hoja;
    if (!H || H.tipo !== 'cocina' || H.pensando || !hayIA()) return;
    const personas = Math.min(20, entero(H.personas, 4, 1) || 4), lista = listaParaCocinar();
    if (!lista.length) return errorHoja('No hay nada en la alacena todavía: cargá algunos productos y probá de nuevo.');
    H.pensando = true; H.error = ''; H.personas = String(personas);
    renderHoja();
    let r = null, falla = null;
    try { r = await IA.recetas(lista, { comida: H.comida, personas, anteriores: otras ? H.vistas : [] }); } catch (e) { falla = e; }
    if (E.hoja !== H) return;
    H.pensando = false;
    if (falla || !r || !r.length) { const t = falla ? IA.nota(falla) : 'La IA no encontró ideas con lo que hay. Probá de nuevo o elegí otra cosa.'; if (t) errorHoja(t); else renderHoja(); return; }
    try { localStorage.setItem('libreta.personas', String(personas)); } catch (e) { /* no importa */ }
    cambiarHoja({ paso: 'ideas', recetas: r, anotadas: [], error: '', vistas: H.vistas.concat(r.map(x => x.nombre)).slice(-12) });
  }
  // El producto de la alacena que corresponde a un ingrediente: el mismo nombre, o uno que empieza igual («Tomate» → «Tomate perita»).
  function productoParecido(nombre) {
    const k = N.norm(nombre);
    if (!k) return null;
    let mejor = null;
    for (const [id, p] of V.prods) {
      if (p.ejemplo) continue;
      const n = N.norm(p.nombre);
      if (n === k) return id;
      if (!mejor && (n.startsWith(k + ' ') || k.startsWith(n + ' '))) mejor = id;
    }
    return mejor;
  }
  async function anotarFaltantes(i) {
    const H = E.hoja, r = H && H.tipo === 'cocina' ? H.recetas[i] : null;
    if (!r || H.anotadas.includes(i) || !puede()) return;
    H.anotadas = H.anotadas.concat(i);
    renderHoja();
    const hoy = hoyDia();
    let n = 0, falla = null;
    for (const f of r.faltan) {
      try {
        const id = productoParecido(f.n);
        if (id) {
          const p = E.prod.get(id);
          if (p && !N.analizar(p, hoy, E.ajustes.frecuencia).pedido) {
            E.prod.set(id, { ...p, pedido: hoy });
            await enCola(id, () => escribir(() => E.db.doc('productos/' + id).update({ pedido: hoy })));
          }
        } else await crearProducto({ nombre: f.n, categoria: f.cat, stock: 0, pedido: hoy });
        n++;
      } catch (e) { falla = e; }
    }
    pintar();
    if (!falla && n && Datos.evento) Datos.evento('lista', `${miNombre()} anotó en la lista: ${r.faltan.map(f => f.n).join(', ')} (para ${r.nombre.toLowerCase()})`);
    if (falla) falloGuardar(falla);
    else avisar(`${n === 1 ? 'Quedó anotada 1 cosa' : `Quedaron anotadas ${n} cosas`} en la lista de compras`, { rotulo: 'Ver', fn: () => { cerrarHoja(); irA('compras'); } });
  }

  async function guardarPromo() {
    const H = E.hoja;
    if (!H || H.tipo !== 'promo' || H.ocupado || !puede()) return;
    const comercio = limpio(H.comercio), ref = refDeComercio(comercio), texto = limpio(H.texto).slice(0, 120), hoy = hoyDia();
    const pct = limpio(H.pct) ? Math.round(N.aNumero(limpio(H.pct).replace('%', ''))) : 0, hasta = N.fechaValida(H.hasta) ? N.diaDe(H.hasta) : 0;
    if (!ref) return errorHoja(comercio ? 'Ubicá ese comercio en el mapa (el botón del pin): así la promo les aparece a los hogares de la zona.' : 'Elegí el comercio de la promo.', 'pr-comercio');
    if (texto.length < 3) return errorHoja('Contá en pocas palabras qué promo es.', 'pr-texto');
    if (!(pct >= 0 && pct <= 80)) return errorHoja('El descuento va de 0 a 80 %.', 'pr-pct');
    if (!(hasta >= hoy && hasta <= hoy + 62)) return errorHoja('La fecha tiene que ser de hoy en adelante, hasta dos meses.', 'pr-hasta');
    ocupar(true);
    try {
      let lugar = lugarDe(ref);
      if (!lugar) { const u = await ubicacionDe(ref); const d = C.conocido(ref); lugar = { lat: u.lat, lon: u.lon, nombre: (d && d.nombre) || nombreDeRef(ref) }; }
      await C.cargarPromo({ k: ref, n: lugar.nombre, t: texto, m: H.medio, pct, dias: H.dias.slice().sort(), hasta, d: hoy, la: lugar.lat, lo: lugar.lon, h: E.ajustes.alias || '' });
    } catch (e) { if (E.hoja === H) errorHoja((e && e.texto) || textoFallo(e)); return; }
    if (E.hoja !== H) return;
    cerrarHoja();
    avisar('Promo cargada: ya la ven los hogares de tu zona');
    const pos = C.ultimaPosicion();
    if (pos) actualizarPromos(pos);
  }

  async function sumarConocido() {
    const H = E.hoja;
    if (!H || H.ocupado || !puede()) return;
    const cant = entero(H.cant, 1, 1), txt = limpio(H.precio), precio = txt ? N.aNumero(txt) : 0, id = H.id;
    if (txt && !(precio > 0)) return errorHoja('El precio no se entiende. Escribilo así: 1.450,50', 'c-precio');
    const comercio = limpio(H.comercio).slice(0, 60), cambio = precio > 0 ? notaPrecio(id, txt) : '';
    ocupar(true);
    const ok = await mover(id, { c: cant }, precio > 0 ? precioDe(precio, comercio) : null, true);
    if (E.hoja !== H) return;
    if (!ok) { ocupar(false); return; }
    const base = E.prod.get(id);
    if (base && !base.codigo && H.codigoNuevo && !porCodigo(H.codigoNuevo)) await guardarCodigo(id, H.codigoNuevo);
    if (E.hoja !== H) return;
    const p = verProd(id) || {};
    if (precio > 0) recordarComercio(comercio);
    cambiarHoja({ estado: 'hecho', texto: `${p.nombre}: se ${N.plural(cant, 'sumó', 'sumaron')} ${cant}. Ahora hay ${p.stock}.${cambio ? ` ${cambio}.` : ''}`, ocupado: false, error: '', fallo: false, sinCodigo: false, cerca: null });
    if (precio > 0) trasCompra([{ id, precio, cant }], comercio).then(r => { if (r && E.hoja === H && H.estado === 'hecho') { H.cerca = r; renderHoja(); } });
  }

  // Le anota el código de barras a un producto que no lo tenía.
  function guardarCodigo(id, codigo) {
    return enCola(id, () => escribir(() => E.db.doc('productos/' + id).update({ codigo }))).then(() => {
      const a = E.prod.get(id);
      if (a) E.prod.set(id, { ...a, codigo });
      return true;
    }, () => false);
  }
  // Le pone a un producto el código recién leído (de una foto o con la cámara) y cuenta cómo salió.
  async function ponerCodigo(vivo, id, codigo) {
    const fin = (texto, fallo, reintentar) => { if (vivo()) cambiarHoja({ estado: 'hecho', texto, fallo, idNuevo: id, sinCodigo: !!reintentar }); };
    const p = E.prod.get(id);
    if (!p) { fin('Ese producto ya no está en la alacena.', true, false); return; }
    if (!codigo) { fin('No se encontró un código de barras en esa foto. Tiene que verse entero, de cerca y sin reflejos.', true, true); return; }
    const otro = porCodigo(codigo);
    if (otro && otro !== id) { fin(`Ese código ya es de otro producto de la alacena: ${N.textoProducto(E.prod.get(otro))}.`, true, true); return; }
    const ok = await guardarCodigo(id, codigo);
    if (ok) fin(`Listo: ${p.nombre} quedó con su código de barras. La próxima vez alcanza con escanearlo.`, false, false);
    else fin('No se pudo guardar el código. Probá de nuevo.', true, true);
  }
  // Foto del código de barras de un producto que se cargó sin él.
  async function fotoCodigo(archivo, id) {
    if (!puede() || !Imagen.esImagen(archivo)) return;
    const url = URL.createObjectURL(archivo);
    abrirHoja({ tipo: 'escanear', estado: 'leyendo', paso: 'codigo', mini: url, urls: [url], ctl: new AbortController(), codigoPara: id });
    const H = E.hoja, turno = E.turno, vivo = () => E.turno === turno && E.hoja === H;
    let im;
    try { im = await Imagen.abrir(archivo); }
    catch (e) { if (vivo()) cambiarHoja({ estado: 'hecho', texto: 'No se pudo abrir esa imagen.', fallo: true, idNuevo: id, sinCodigo: true }); return; }
    try {
      let codigo = null;
      try { codigo = await leerCodigo(im, vivo); } catch (e) { codigo = null; }
      if (!vivo()) return;
      if (!codigo && Lector.etiquetas()) {   // los dígitos impresos debajo de las barras también sirven
        cambiarHoja({ paso: 'etiqueta' });
        try { const l = await Lector.etiqueta(im, [], { signal: H.ctl.signal }); codigo = l && l.codigo ? l.codigo : null; }
        catch (e) { if (!vivo() || (e && e.code === 'cancelled')) return; Lector.nota(e); }
        if (!vivo()) return;
      }
      await ponerCodigo(vivo, id, codigo);
    } finally { im.cerrar(); }
  }

  /* ---------- escanear con la cámara en vivo ---------- */
  let sinCamara = false;      // se pidió la cámara y el teléfono no tiene
  let camaraFallo = false;    // se pidió y no se pudo abrir: sin permiso, ocupada…
  let camaraDudosa = false;   // el navegador no lista ninguna (en una computadora): no se ofrece de entrada
  const camaraPosible = () => !!(Datos.camaraEnVivo && window.isSecureContext !== false && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  const camaraViva = () => camaraPosible() && !sinCamara && !camaraFallo && !camaraDudosa;
  function detenerCamara(H) {
    if (!H) return;
    clearTimeout(H.reloj); H.reloj = 0;
    if (H.flujo) {
      for (const pista of H.flujo.getTracks()) { try { pista.stop(); } catch (e) { /* ya estaba detenida */ } }
      H.flujo = null;
    }
  }
  function textoCamara(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError': return 'El navegador no dio permiso para usar la cámara. Podés habilitarla en los permisos de esta página, o seguir con una foto.';
      case 'NotFoundError': case 'OverconstrainedError': return 'No se encontró una cámara en este teléfono. Se puede seguir con una foto.';
      case 'NotReadableError': case 'AbortError': return 'La cámara está ocupada o se desconectó. Cerrá lo que la esté usando y probá de nuevo, o seguí con una foto.';
      default: return 'No se pudo abrir la cámara. Se puede seguir con una foto.';
    }
  }
  // Cierra el visor porque no hay video: avisa y deja seguir con una foto.
  function sinVideo(H, nota) {
    detenerCamara(H);
    if (H.codigoPara) cambiarHoja({ estado: 'hecho', texto: nota, fallo: true, sinCodigo: true, idNuevo: H.codigoPara });
    else cambiarHoja({ estado: 'espera', nota });
  }
  /* Abre la cámara y mira un cuadro tras otro hasta dar con un código de barras. Con `paraId`, el código es
     para ese producto; sin él, lo leído se busca en la alacena o se carga como producto nuevo. */
  async function abrirCamara(paraId) {
    if (!puede()) return;
    if (!camaraPosible()) { abrirHoja({ tipo: 'escanear', estado: 'espera' }); return; }
    camaraFallo = camaraDudosa = false;
    abrirHoja({ tipo: 'escanear', estado: 'camara', codigoPara: paraId || null, urls: [], ctl: new AbortController(), modo: paraId ? null : E.modoEscaneo });
    const H = E.hoja, turno = E.turno;
    const vivo = () => E.turno === turno && E.hoja === H, mirando = () => vivo() && H.estado === 'camara';
    const fallo = e => {
      if (!mirando()) return;
      if (e && e.name === 'NotFoundError') sinCamara = true; else camaraFallo = true;
      sinVideo(H, textoCamara(e));
    };
    // El lector del navegador se arregla con menos; el propio necesita más píxeles por barra, así que
    // sin aquel se pide la mayor definición que dé la cámara.
    const nativo = await detectorNativo();
    if (!mirando()) return;
    const [ancho, alto] = nativo ? [1920, 1080] : [3840, 2160];
    let flujo;
    try {
      flujo = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: ancho }, height: { ideal: alto } } });
    } catch (e) { fallo(e); return; }
    if (!mirando()) { for (const pista of flujo.getTracks()) pista.stop(); return; }
    H.flujo = flujo;
    for (const pista of flujo.getVideoTracks()) pista.addEventListener('ended', () => { if (H.flujo === flujo) fallo({ name: 'NotReadableError' }); });
    // El video se vuelve a enganchar si la hoja se redibujó.
    const visor = () => {
      const v = $('#visor-video');
      if (v && v.srcObject !== flujo) { v.srcObject = flujo; const p = v.play(); if (p && p.catch) p.catch(() => {}); }
      return v;
    };
    const decir = texto => {
      const el = $('#visor-estado');
      if (!el || el.dataset.texto === texto) return;
      el.dataset.texto = texto;
      el.textContent = texto;
    };
    visor();

    /* Lector propio. Mira lo que se ve en el visor (el video recortado igual que en pantalla), achicado a
       1100 px. Si la cámara da más definición que eso, en los cuadros impares mira solo el centro, sin
       achicar: así un código chico o lejano conserva todos sus píxeles. */
    const lz = document.createElement('canvas'), ctx = lz.getContext('2d', { willReadFrequently: true });
    const propio = (v, vuelta) => {
      const vw = v.videoWidth, vh = v.videoHeight, k = Math.max((v.clientWidth || vw) / vw, (v.clientHeight || vh) / vh);
      let rw = Math.min(vw, (v.clientWidth || vw) / k), rh = Math.min(vh, (v.clientHeight || vh) / k), e = Math.min(1, 1100 / Math.max(rw, rh));
      if (e < 0.8 && vuelta % 2) { rw = Math.min(rw, 1600); rh = Math.min(rh, 900); e = 1; }
      const w = Math.max(1, Math.round(rw * e)), al = Math.max(1, Math.round(rh * e));
      if (lz.width !== w || lz.height !== al) { lz.width = w; lz.height = al; }
      ctx.drawImage(v, (vw - rw) / 2, (vh - rh) / 2, rw, rh, 0, 0, w, al);
      return Barras.leer(Imagen.grises(lz), w, al);
    };
    const hallado = async (codigo, v) => {
      let mini = '';
      try {   // el cuadro donde se leyó, para mostrar qué se escaneó
        const c = document.createElement('canvas'), k = Math.min(1, 360 / Math.max(v.videoWidth, v.videoHeight));
        c.width = Math.round(v.videoWidth * k); c.height = Math.round(v.videoHeight * k);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        mini = c.toDataURL('image/jpeg', 0.7);
      } catch (e) { mini = ''; }
      detenerCamara(H);
      try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* sin vibración */ }
      H.mini = mini;
      if (H.codigoPara) { cambiarHoja({ estado: 'leyendo', paso: 'guardando' }); await ponerCodigo(vivo, H.codigoPara, codigo); }
      else await trasLeer(H, vivo, codigo, null, false);
    };
    // Se da por bueno cuando el mismo código sale en dos cuadros. Si pasan dos minutos sin leer nada, la
    // cámara se apaga para no gastar batería.
    const desde = Date.now();
    let visto = null, vuelta = 0;
    const cuadro = async () => {
      H.reloj = 0;
      if (!mirando()) return;
      if (Date.now() - desde > 120000) { sinVideo(H, 'La cámara se apagó sola después de un rato sin leer ningún código.'); return; }
      const v = visor();
      let codigo = null;
      if (v && v.readyState >= 2 && v.videoWidth) {
        decir(Date.now() - desde > 12000 ? 'Si no lo toma, acercá o alejá el producto y buscá buena luz, sin reflejos.' : 'Apuntá al código de barras');
        try { codigo = (nativo && await conNativo(v)) || propio(v, vuelta++); } catch (e) { codigo = null; }
        if (!mirando()) return;
      }
      if (codigo) {
        const ahora = Date.now();
        if (visto && visto.codigo === codigo && ahora - visto.t < 2500) { hallado(codigo, v); return; }
        visto = { codigo, t: ahora };
      }
      H.reloj = setTimeout(cuadro, codigo ? 30 : 100);
    };
    cuadro();
  }

  /* ---------- guardar un producto ---------- */
  async function guardarProducto(forzar) {
    const H = E.hoja;
    if (!H || H.tipo !== 'producto' || H.ocupado || !puede()) return;
    const f = H.f, nombre = limpio(f.nombre);
    if (!nombre) return errorHoja('Falta el nombre del producto.', 'p-nombre');
    const txtPrecio = limpio(f.precio), precio = txtPrecio ? N.aNumero(txtPrecio) : 0;
    if (txtPrecio && !(precio > 0)) return errorHoja('El precio no se entiende. Escribilo así: 1.450,50', 'p-precio');
    const codigo = String(f.codigo).replace(/\D/g, '');
    if (codigo && !Barras.gtinValido(codigo)) return errorHoja('Ese código de barras no cierra: revisá los dígitos o dejalo vacío.', 'p-codigo');
    const stock = entero(f.stock, 0), comercio = limpio(f.comercio).slice(0, 60);
    const datos = { nombre, marca: limpio(f.marca), presentacion: limpio(f.presentacion), categoria: N.CATS_ALACENA.includes(f.categoria) ? f.categoria : 'otros', codigo, aviso: entero(f.aviso, 0), reponer: !!f.reponer, marcaFija: !!f.marcaFija };
    datos.diario = !!f.diario === N.diarioPorCategoria(datos.categoria) ? null : !!f.diario;      // solo se guarda si no es lo de su categoría
    if (H.id) {
      ocupar(true);
      const id = H.id;
      await volcar(id);
      const base = E.prod.get(id);
      if (!base) { cerrarHoja(); return; }
      const campos = { ...datos, act: new Date().toISOString() };
      // La cantidad y el precio solo se guardan si se cambiaron en este formulario: mientras estuvo abierto,
      // otra persona pudo haber consumido o comprado, y eso no hay que pisarlo.
      const f0 = H.f0 || {};
      if (f.stock !== f0.stock && stock !== (+base.stock || 0)) campos.stock = stock;
      // Un precio nuevo entra al historial con su comercio; si solo se corrigió dónde, se corrige el último precio.
      let nuevo = null;
      if (f.precio !== f0.precio) {
        if (precio > 0) nuevo = precioDe(precio, comercio);
        else if (base.precio) Object.assign(campos, N.quitarPrecio(base));
      } else if (precio > 0 && comercio !== limpio(f0.comercio) && N.fechaValida(base.precioFecha)) nuevo = precioDe(precio, comercio, base.precioFecha);
      const precioNuevo = !!nuevo && f.precio !== f0.precio, cambio = precioNuevo ? notaPrecio(id, f.precio) : '';
      if (nuevo && !Datos.mover) { const r = N.aplicarMovs(base, [], hoyDia(), nuevo); for (const k of ['precio', 'precioFecha', 'precioAnt', 'px']) if (k in r) campos[k] = r[k]; }
      try {
        await enCola(id, async () => {
          await escribir(() => E.db.doc('productos/' + id).update(campos));
          const a = E.prod.get(id);
          if (a) E.prod.set(id, { ...a, ...campos });
          if (nuevo && Datos.mover) await escribir(() => Datos.mover(id, [], nuevo));
        });
        if (nuevo) recordarComercio(comercio);
        if (E.hoja === H) cerrarHoja();
        avisar(cambio ? `Guardado · ${cambio}` : 'Guardado'); pintar();
        if (precioNuevo) trasCompra([{ id, precio, cant: 1 }], comercio).then(r => { if (r && r.baratos.length) avisar(avisoBarato(r.baratos[0].oferta), { rotulo: 'Ver', fn: () => verBaratos(r) }); });
      } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e, E.prod.has(id))); else falloGuardar(e, E.prod.has(id)); }
      return;
    }
    if (!forzar) {
      const par = (codigo && porCodigo(codigo)) || N.buscarParecido(prodReales(), N.textoProducto(datos));
      if (par) { H.parecido = par; H.error = ''; renderHoja(); const el = $('#hoja .nota:last-of-type'); if (el) el.scrollIntoView({ block: 'nearest' }); return; }
    }
    ocupar(true);
    try {
      const idNuevo = await crearProducto({ ...datos, stock, precio, comercio, ref: refDeComercio(comercio) });
      if (precio > 0) recordarComercio(comercio);
      const despues = precio > 0 ? trasCompra([{ id: idNuevo, precio, cant: Math.max(1, stock) }], comercio) : Promise.resolve(null);
      if (E.hoja !== H) { trasGuardarPropio(); pintar(); return; }
      if (H.deEscaneo) {
        cambiarHoja({ tipo: 'escanear', estado: 'hecho', texto: `${nombre} quedó en la alacena${stock ? ` con ${stock}` : ''}.`, ocupado: false, error: '', sucio: false, fallo: false, idNuevo, sinCodigo: !codigo, cerca: null });
        despues.then(r => { if (r && E.hoja === H && H.estado === 'hecho') { H.cerca = r; renderHoja(); } });
      } else {
        cerrarHoja(); avisar(`${nombre} quedó en la alacena`);
        despues.then(r => { if (r && r.baratos.length) avisar(avisoBarato(r.baratos[0].oferta), { rotulo: 'Ver', fn: () => verBaratos(r) }); });
      }
      trasGuardarPropio(); pintar();
    } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e)); else falloGuardar(e); }
  }
  async function sumarParecido() {
    const H = E.hoja;
    if (!H || !H.parecido || !puede()) return;
    const id = H.parecido, cant = Math.max(1, entero(H.f.stock, 1)), txt = limpio(H.f.precio), precio = txt ? N.aNumero(txt) : 0;
    ocupar(true);
    const ok = await mover(id, { c: cant }, precio > 0 ? precioDe(precio, H.f.comercio) : null, true);
    if (E.hoja !== H) return;
    if (!ok) { ocupar(false); return; }
    if (precio > 0) recordarComercio(limpio(H.f.comercio).slice(0, 60));
    const codigo = String(H.f.codigo || '').replace(/\D/g, ''), base = E.prod.get(id);
    if (base && !base.codigo && Barras.gtinValido(codigo) && !porCodigo(codigo)) guardarCodigo(id, codigo);
    const p = verProd(id) || {}, texto = `${p.nombre}: se ${N.plural(cant, 'sumó', 'sumaron')} ${cant}. Ahora hay ${p.stock}.`;
    if (H.deEscaneo) cambiarHoja({ tipo: 'escanear', estado: 'hecho', texto, ocupado: false, error: '', sucio: false, fallo: false, sinCodigo: false });
    else { cerrarHoja(); avisar(texto); }
  }
  async function borrarProducto() {
    const H = E.hoja;
    if (!H || !H.id || !puede()) return;
    const id = H.id, nombre = H.f.nombre;
    try {
      await enCola(id, () => escribir(() => E.db.doc('productos/' + id).delete()));
      E.prod.delete(id); cola.delete(id); E.marcados.delete(id);
      if (E.hoja === H) cerrarHoja();
      avisar(`${nombre} se borró de la alacena`); pintar();
    } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e)); else falloGuardar(e); }
  }

  /* ---------- tickets ---------- */
  function formTicket(t) {
    const hoyI = N.hoyISO(), fecha = t.fecha || hoyI, diaT = N.diaDe(fecha), reales = prodReales();
    const items = t.items.map(it => {
      let dest = 'no', ya = false;
      if (it.a) {
        const id = it.p && E.prod.has(it.p) ? it.p : N.buscarParecido(reales, it.n, 0.8);
        if (!id) dest = 'nuevo';
        else if ((E.prod.get(id).log || []).some(e => e[0] === diaT && e[2] > 0)) ya = true;
        else dest = id;
      }
      return { n: it.n, c: String(it.c), i: N.campoPlata(it.i), cat: it.cat, dest, ya, abierto: false };
    });
    return { comercio: t.comercio || '', fecha, total: N.campoPlata(t.total), items, cat: 'otros', aAlacena: N.diaDe(hoyI) - diaT <= 3 && items.some(it => it.dest !== 'no') };
  }
  const gastoVacio = () => ({ comercio: '', fecha: N.hoyISO(), total: '', items: [], cat: 'otros', aAlacena: false });
  // La foto de un ticket. Si hay quien la lea, vuelve con los renglones cargados para revisar; si no, queda
  // adjunta al gasto y los datos se completan mirándola.
  async function fotoTicket(archivos) {
    archivos = archivos.filter(Imagen.esImagen);
    if (!archivos.length || !puede()) return;
    if (!Lector.tickets()) {
      if (!Datos.fotos) { abrirHoja({ tipo: 'ticket', estado: 'espera' }); return; }
      const antes = E.hoja, archivo = archivos[0];
      try { (await Imagen.abrir(archivo)).cerrar(); }
      catch (e) { if (E.hoja === antes) abrirHoja({ tipo: 'ticket', estado: 'espera', nota: 'No se pudo abrir esa imagen. Probá con otra foto.' }); return; }
      if (E.hoja !== antes) return;
      const url = URL.createObjectURL(archivo);
      abrirHoja({ tipo: 'ticket', estado: 'revisar', origen: 'foto', t: gastoVacio(), urls: [url], foto: { archivo, url }, sucio: true });
      return;
    }
    const urls = archivos.slice(0, 3).map(f => URL.createObjectURL(f));
    abrirHoja({ tipo: 'ticket', estado: 'leyendo', urls, minis: urls, ctl: new AbortController() });
    const H = E.hoja, turno = E.turno, vivo = () => E.turno === turno && E.hoja === H;
    const lista = listaParaLector(), hoyI = N.hoyISO();
    let t;
    try {
      t = await Lector.ticket(archivos, lista, hoyI, {
        signal: H.ctl.signal,
        alAvanzar: n => {
          const el = vivo() && n ? document.getElementById('t-progreso') : null;
          if (el) el.textContent = `Leyendo el ticket… ${n} ${N.plural(n, 'renglón', 'renglones')}`;
        },
      });
    } catch (e) {
      if (!vivo() || (e && e.code === 'cancelled')) return;
      const nota = Lector.nota(e).replace('Completá los datos a mano.', 'Cargá el gasto a mano.').replace('completá los datos a mano', 'cargá el gasto a mano');
      cambiarHoja({ estado: 'espera', nota });
      return;
    }
    if (!vivo()) return;
    if (!t || !t.esTicket) { cambiarHoja({ estado: 'espera', nota: 'Eso no parece un ticket, o no se llegó a leer. Probá con otra foto, más de cerca y derecha, o cargá el gasto a mano.' }); return; }
    const notas = [];
    if (!t.fecha) notas.push('No se pudo leer la fecha: quedó la de hoy, revisala.');
    if (t.dudas) notas.push(`Para revisar: ${t.dudas}`);
    cambiarHoja({ estado: 'revisar', origen: 'foto', leido: true, t: formTicket(t), nota: notas.join(' '), sucio: true });
  }
  // Trae la foto guardada de un ticket y la muestra en la hoja abierta.
  async function verFotoTicket(H, id) {
    let blob = null;
    try { blob = await Datos.fotos.leer(id); } catch (e) { blob = null; }
    if (E.hoja !== H) return;
    if (blob) { H.fotoUrl = URL.createObjectURL(blob); H.urls.push(H.fotoUrl); }
    else H.fotoNota = Datos.hogar ? 'La foto de este ticket está en el teléfono donde se cargó.' : 'La foto de este ticket no está guardada en este navegador.';
    renderHoja();
  }
  async function guardarTicket() {
    const H = E.hoja;
    if (!H || H.tipo !== 'ticket' || H.estado !== 'revisar' || H.ocupado || !puede()) return;
    const t = H.t;
    if (!N.fechaValida(t.fecha)) return errorHoja('Falta la fecha de la compra.', 't-fecha');
    if (N.diaDe(t.fecha) > hoyDia() + 1) return errorHoja('La fecha no puede ser futura.', 't-fecha');
    const items = [];
    for (let i = 0; i < t.items.length; i++) {
      const it = t.items[i], n = limpio(it.n), txt = limpio(it.i);
      if (!n && !txt) continue;
      if (!n) return errorHoja(`Al renglón ${i + 1} le falta el nombre.`);
      const imp = N.aNumero(txt);
      if (!isFinite(imp)) return errorHoja(`El importe de «${n}» no se entiende. Escribilo así: 1.450,50`);
      items.push({ n, c: entero(it.c, 1, 1), i: N.redondear2(imp), cat: N.CATS[it.cat] ? it.cat : 'otros', dest: it.dest });
    }
    const suma = items.reduce((s, it) => s + it.i, 0);
    let total = limpio(t.total) ? N.aNumero(t.total) : NaN;
    if (!isFinite(total) && suma > 0) total = suma;
    if (!(total > 0)) return errorHoja('Falta el total del gasto.', 't-total');
    const comercio = limpio(t.comercio).slice(0, 60), lugar = refDeComercio(comercio);
    const doc = {
      comercio: comercio || 'Compra', fecha: t.fecha, total: N.redondear2(total),
      items: items.map(it => ({ n: it.n, c: it.c, i: it.i, cat: it.cat })), cat: items.length ? null : (N.CATS[t.cat] ? t.cat : 'otros'),
      origen: H.origen || 'manual', creado: H.creado || new Date().toISOString(),
    };
    if (H.ejemplo) doc.ejemplo = true;
    if (lugar) doc.ref = lugar;
    ocupar(true, 'Guardando…');
    const ref = H.id ? E.db.doc('tickets/' + H.id) : E.db.collection('tickets').doc();
    let fotoNueva = false, sinFoto = false;
    if (H.tieneFoto) doc.foto = true;
    else if (!H.id && H.foto && Datos.fotos) {
      // La foto se guarda aparte del gasto y achicada: el lado corto a 1500 px como mucho, que alcanza para
      // leer un ticket, sin dejar que una imagen muy larga (una captura de pantalla) quede ilegible.
      try {
        const im = await Imagen.abrir(H.foto.archivo);
        try {
          const k = Math.min(1, 1500 / Math.min(im.w, im.h), 6000 / Math.max(im.w, im.h));
          await Datos.fotos.guardar(ref.id, await Imagen.aBlob(Imagen.lienzo(im, Math.round(Math.max(im.w, im.h) * k)), 0.8));
        } finally { im.cerrar(); }
        doc.foto = fotoNueva = true;
      } catch (e) { sinFoto = true; }
    }
    try { await escribir(() => ref.set(doc)); }
    catch (e) {
      if (fotoNueva) Datos.fotos.borrar(ref.id).catch(() => {});
      if (E.hoja === H) errorHoja(textoFallo(e, H.id ? undefined : true)); else falloGuardar(e);
      return;
    }
    E.tickets = [{ id: ref.id, ...doc }].concat(E.tickets.filter(x => x.id !== ref.id)).sort((a, b) => String(b.fecha).localeCompare(String(a.fecha)));
    if (!H.id && !H.ejemplo && Datos.evento) Datos.evento('gasto', `${miNombre()} cargó ${doc.items.length ? 'una compra' : 'un gasto'} de ${N.plata(doc.total)}${doc.comercio && doc.comercio !== 'Compra' ? ` en ${doc.comercio}` : ''}`);
    let sumados = 0, fallidos = 0;
    const comprados = [];
    if (!H.id && comercio) recordarComercio(comercio);
    if (!H.id && t.aAlacena) {
      const para = items.filter(it => it.dest && it.dest !== 'no' && it.i > 0), diaT = N.diaDe(t.fecha), creados = new Map();
      for (let k = 0; k < para.length; k++) {
        const it = para[k], unidad = N.redondear2(it.i / it.c);
        if (E.hoja === H) ocupar(true, `Sumando a la alacena: ${k + 1} de ${para.length}…`);
        try {
          let id = it.dest === 'nuevo' ? creados.get(N.norm(it.n)) : (E.prod.has(it.dest) ? it.dest : null);
          if (id) { if (await mover(id, { c: it.c, dia: diaT }, precioDe(unidad, comercio, t.fecha), true)) { sumados++; comprados.push({ id, precio: unidad, cant: it.c }); } else fallidos++; }
          else if (it.dest === 'nuevo') {
            id = await crearProducto({ nombre: it.n, categoria: it.cat, stock: it.c, precio: unidad, precioFecha: t.fecha, comercio, ref: lugar }, diaT);
            creados.set(N.norm(it.n), id); sumados++;
          }
        } catch (e) { fallidos++; }
      }
    }
    E.mes = N.mesDe(t.fecha);
    if (E.hoja === H) cerrarHoja();
    irA('gastos');
    avisar(fallidos ? `Gasto guardado. ${fallidos} ${N.plural(fallidos, 'producto no se pudo', 'productos no se pudieron')} sumar a la alacena.`
      : sinFoto ? 'Gasto guardado, pero la foto no se pudo guardar en este navegador.'
        : sumados ? `Gasto guardado y ${sumados} ${N.plural(sumados, 'producto sumado', 'productos sumados')} a la alacena` : 'Gasto guardado');
    if (!H.ejemplo) trasGuardarPropio();
    if (comprados.length) trasCompra(comprados, comercio, t.fecha).then(r => { if (r && r.baratos.length) avisar(`Otros hogares consiguieron más barato ${r.baratos.length === 1 ? r.baratos[0].nombre : `${r.baratos.length} productos`}`, { rotulo: 'Ver', fn: () => verBaratos(r) }); });
  }
  async function borrarTicket() {
    const H = E.hoja;
    if (!H || !H.id || !puede()) return;
    const id = H.id;
    try {
      await escribir(() => E.db.doc('tickets/' + id).delete());
      E.tickets = E.tickets.filter(t => t.id !== id);
      if (Datos.fotos) Datos.fotos.borrar(id).catch(() => {});
      if (E.hoja === H) cerrarHoja();
      avisar('Gasto borrado'); pintar();
    } catch (e) { falloGuardar(e); }
  }
  async function guardarAjustes() {
    const H = E.hoja;
    if (!H || H.tipo !== 'ajustes' || !puede()) return;
    const txt = limpio(H.presupuesto), pres = txt ? N.aNumero(txt) : 0;
    if (txt && !(pres >= 0)) return errorHoja('El presupuesto no se entiende. Escribilo así: 600.000', 'aj-presupuesto');
    ocupar(true);
    try {
      await cambiarAjustes({ frecuencia: H.frecuencia, presupuesto: N.redondear2(pres || 0) });
      if (E.hoja === H) cerrarHoja();
      avisar('Ajustes guardados'); pintar();
    } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e)); else falloGuardar(e); }
  }

  /* ---------- acciones ---------- */
  const elegir = id => { const el = document.getElementById(id); el.value = ''; el.click(); };
  const alVerCopia = () => { const el = $('#hoja .dato:not(.hogar)'); if (el) el.scrollIntoView({ block: 'nearest' }); };
  const alVerHogar = () => { const el = $('#hoja .dato.hogar'); if (el) el.scrollIntoView({ block: 'nearest' }); };
  function cerrarConCuidado(porFuera) {
    const H = E.hoja;
    if (!H) return;
    if (H.sub) { if (!porFuera && !H.sub.ocupado) cerrarSub(); return; }      // la hoja de encima (el mapa, elegir el comercio)
    if (H.ocupado) return;
    if (H.tipo === 'ticket' && H.estado === 'revisar' && !H.id && H.origen === 'foto') {
      if (porFuera) return;
      if (!H.descartar) { H.descartar = true; renderHoja(true); return; }
    } else if (porFuera && H.sucio) return;
    cerrarHoja();
  }
  const ACC = {
    cerrar() { cerrarConCuidado(false); },
    'tostada-accion'() { const fn = E.tostadaFn; E.tostadaFn = null; $('#tostada').hidden = true; if (fn) fn(); },
    chip(el) { E.filtro.chip = el.dataset.chip; renderAlacena(); },
    menos(el) { toque(el.closest('[data-id]').dataset.id, 1, 0); },
    mas(el) { toque(el.closest('[data-id]').dataset.id, 0, 1); },
    producto(el) {
      const id = el.dataset.id, p = verProd(id);
      if (!p) return;
      const f = formProducto(p);
      pintarComercios();
      abrirHoja({ tipo: 'producto', id, f, f0: { stock: f.stock, precio: f.precio, comercio: f.comercio } });
    },
    'producto-nuevo'() { if (puede()) { pintarComercios(); abrirHoja({ tipo: 'producto', id: null, f: formProducto({}, true) }); } },
    // En el celular, escanear abre directamente la cámara: en vivo si se puede, y si no la de sacar fotos.
    escanear() {
      if (!puede()) return;
      E.codigoPara = null; E.modoEscaneo = null;
      if (camaraViva() && dedoGrueso()) { abrirCamara(null); return; }
      abrirHoja({ tipo: 'escanear', estado: 'espera' });
      if (dedoGrueso()) elegir('in-prod-cam');
    },
    camara() { abrirCamara(null); },
    'foto-prod-cam'() { if (puede()) { E.codigoPara = null; elegir('in-prod-cam'); } },
    'foto-prod-gal'() { if (puede()) { E.codigoPara = null; elegir('in-prod-gal'); } },
    // Con la cámara abierta para ponerle el código a un producto, se puede seguir con una foto.
    'foto-codigo'() { const H = E.hoja; if (H && H.codigoPara && puede()) { E.codigoPara = H.codigoPara; elegir('in-prod-gal'); } },
    'pedir-codigo'() {
      const H = E.hoja;
      if (!H || !H.idNuevo || !puede()) return;
      if (camaraViva()) { abrirCamara(H.idNuevo); return; }
      E.codigoPara = H.idNuevo;
      elegir(dedoGrueso() ? 'in-prod-cam' : 'in-prod-gal');
    },
    'foto-tic-cam'() { if (puede()) elegir('in-tic-cam'); },
    'foto-tic-gal'() { if (puede()) elegir('in-tic-gal'); },
    'cancelar-lectura'() { const H = E.hoja; if (H) abrirHoja({ tipo: H.tipo, estado: 'espera' }); },
    'leer-detalle'() { const H = E.hoja; if (H && H.archivo) fotoProducto(H.archivo, true); },
    'no-es-este'() {
      const H = E.hoja, l = H.leido;
      cambiarHoja({ tipo: 'producto', id: null, f: formProducto(l && l.legible ? { ...l, codigo: H.codigoNuevo || l.codigo } : { codigo: H.codigoNuevo || '' }, true), aviso: 'Completá o corregí los datos del producto.', deEscaneo: true, sucio: true, error: '' });
    },
    'sumar-parecido'() { sumarParecido(); },
    'guardar-igual'() { guardarProducto(true); },
    'borrar-producto'() { cambiarHoja({ borrar: true, error: '' }); const el = $('#hoja .nota:last-of-type'); if (el) el.scrollIntoView({ block: 'nearest' }); },
    'no-borrar'() { cambiarHoja({ borrar: false }); },
    'borrar-producto-si'() { borrarProducto(); },
    paso(el) {
      const inp = document.getElementById(el.dataset.para);
      if (!inp) return;
      inp.value = String(entero(entero(inp.value, 0) + Number(el.dataset.d), 0, Number(inp.min) || 0));
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    },
    frecuencia(el) {
      if (!puede()) return;
      cambiarAjustes({ frecuencia: +el.dataset.frec }).catch(falloGuardar);
      render();
    },
    'copiar-lista'() {
      const texto = textoLista();
      let p;
      try { p = navigator.clipboard.writeText(texto); } catch (e) { p = Promise.reject(e); }
      p.then(() => avisar('Lista copiada: pegala donde quieras'), () => {
        abrirHoja({ tipo: 'copiar', texto });
        const ta = $('#copiar-texto'); if (ta) { ta.focus(); ta.select(); }
      });
    },
    'sumar-marcados'() { abrirCompra(); },
    // en la góndola
    gondola() {
      if (!puede()) return;
      E.codigoPara = null; E.modoEscaneo = 'precio';
      if (camaraViva() && dedoGrueso()) { abrirCamara(null); return; }
      abrirHoja({ tipo: 'escanear', estado: 'espera', modo: 'precio' });
      if (dedoGrueso()) elegir('in-prod-cam');
    },
    'gondola-llevo'() { guardarGondola(true); },
    'mapa-vivo'() { abrirMapaZona(); },
    'oferta-mapa'(el) { abrirMapaZona({ foco: el.dataset.k }); },
    'ofertas-fuentes'() {
      const l = pbVigentes(C.ultimaPosicion()), f = [...new Set(l.map(p => p.fuente).filter(Boolean))];
      abrirHoja({ tipo: 'fuentes', fuentes: f, actualizado: (E.pb && E.pb.actualizado) || '' });
    },
    arranque() { if (puede()) abrirHoja({ tipo: 'arranque', sel: {}, ocupado: false, error: '' }); },
    'arranque-toque'(el) {
      const H = E.hoja;
      if (!H || H.tipo !== 'arranque' || H.ocupado) return;
      H.sel[el.dataset.n] = ((H.sel[el.dataset.n] || 0) + 1) % 3;
      renderHoja();
    },
    'arranque-listo'() { guardarArranque(); },
    confirmar(el) { abrirConfirmar(el.dataset.k); },
    'conf-sigue'(el) { confirmarPrecio(+el.dataset.i, false); },
    'conf-cambio'(el) { const H = E.hoja; if (H && H.tipo === 'confirmar') { H.items[+el.dataset.i].abierto = true; renderHoja(); const n = $('#cf-' + el.dataset.i); if (n) n.focus(); } },
    'conf-guardar'(el) { confirmarPrecio(+el.dataset.i, true); },
    'alerta-editar'(el) {
      const H = E.hoja, p = E.prod.get(el.dataset.id);
      if (!H || !p) return;
      H.alertaEdit = true; H.alertaPrecio = p.alerta > 0 ? N.plata(p.alerta).replace(/^\$\s*/, '') : p.precio > 0 ? N.plata(Math.round(p.precio * 0.9)).replace(/^\$\s*/, '') : '';
      renderHoja(); const n = $('#p-alerta'); if (n) n.focus();
    },
    'alerta-cancelar'() { if (E.hoja) { E.hoja.alertaEdit = false; renderHoja(); } },
    'alerta-guardar'(el) {
      const v = N.aNumero(limpio((E.hoja && E.hoja.alertaPrecio) || ''));
      if (!(v > 0)) { avisar('Escribí un precio: por ejemplo 4.500'); return; }
      guardarAlerta(el.dataset.id, N.redondear2(v));
    },
    'alerta-quitar'(el) { guardarAlerta(el.dataset.id, 0); },
    async 'compartir-ahorro'(el) {
      const cuando = el.dataset.cuando, m = cuando === 'semana' ? ahorroSemana() : ahorroDelMes();
      if (!(m > 0)) return;
      const img = await tarjetaAhorro(m, cuando);
      compartirTexto(`${cuando === 'semana' ? 'Esta semana' : 'Este mes'} ahorré ${N.plata(m)} con la Libreta del hogar 🛒, comprando donde otros hogares del barrio encontraron mejor precio. Es gratis, sumate: ${URL_APP()}`, img);
    },
    'invitar-barrio'() {
      const B = E.barrio || {};
      compartirTexto(B.precios > 5
        ? `En nuestro barrio ya hay ${B.precios} precios cargados por vecinos en la Libreta del hogar 🛒: dónde está más barato cada cosa, promos del día y combos. Es gratis, sumate y compartamos precios: ${URL_APP()}`
        : `Estoy usando la Libreta del hogar 🛒: entre vecinos nos pasamos dónde está más barato cada cosa del barrio. Es gratis, sumate así juntamos precios: ${URL_APP()}`);
    },
    async 'avisos-activar'() {
      const H = E.hoja;
      if (!H || H.tipo !== 'ajustes' || H.avisando) return;
      H.avisando = true; H.errorAvisos = ''; renderHoja();
      try { await Datos.avisos.activar(); } catch (e) { if (E.hoja === H) H.errorAvisos = (e && e.texto) || 'No se pudieron activar. Probá de nuevo.'; }
      if (E.hoja !== H) return;
      H.avisando = false; renderHoja();
      if (!H.errorAvisos) { if (!E.ajustes.avisos) cambiarAjustes({ avisos: true }).catch(() => {}); avisar('Notificaciones activadas en este teléfono'); const pos = C.ultimaPosicion(); try { localStorage.removeItem('libreta.pushZona'); } catch (e) { /* sin almacenamiento */ } if (pos) zonaParaAvisos(pos); }
    },
    async 'avisos-apagar'() {
      const H = E.hoja;
      await Datos.avisos.desactivar();
      if (E.hoja === H) renderHoja();
      avisar('Notificaciones desactivadas en este teléfono');
    },
    // avisarle a la zona un precio, de lo que sea y en cualquier comercio
    'avisar-precio'() {
      if (!puede()) return;
      pintarComercios(); pintarSueltos();
      abrirHoja({ tipo: 'escanear', modo: 'precio', estado: 'suelto', avisar: true, vende: 'unidad', comps: [], kilos: '1', nombre: '', clave: '', cat: 'otros', id: null, precio: '', comercio: ultimoComercio(), zona: null, estadoZona: 'sin', leyendo: false, aviso: '', error: '', ocupado: false, urls: [], ctl: new AbortController() });
    },
    // un precio de algo sin código de barras
    'sin-codigo'() {
      if (!puede()) return;
      pintarComercios(); pintarSueltos();
      abrirHoja({ tipo: 'escanear', modo: 'precio', estado: 'suelto', vende: 'unidad', comps: [], kilos: '1', nombre: '', clave: '', cat: 'otros', id: null, precio: '', comercio: ultimoComercio(), zona: null, estadoZona: 'sin', leyendo: false, aviso: '', error: '', ocupado: false, urls: [], ctl: new AbortController() });
      if (!hayIA()) { const n = $('#s-nombre'); if (n) n.focus(); }
    },
    'suelto-foto'() { if (E.hoja && E.hoja.estado === 'suelto' && !E.hoja.leyendo) elegir(dedoGrueso() ? 'in-suelto-cam' : 'in-suelto-gal'); },
    'suelto-galeria'() { if (E.hoja && E.hoja.estado === 'suelto' && !E.hoja.leyendo) elegir('in-suelto-gal'); },
    'suelto-llevo'() { guardarSuelto(true); },
    'suelto-vende'(el) {
      const H = E.hoja;
      if (!H || H.estado !== 'suelto' || H.ocupado) return;
      H.vende = el.dataset.v; H.vendeElegido = true; H.error = '';
      if (H.vende === 'combo' && !H.comps.length) { const l = partesCombo(H.nombre); H.comps = l.length ? l : [{ n: '', q: '', u: 'kg' }, { n: '', q: '', u: 'kg' }]; }
      H.clave = null; H.cmpFirma = null;
      actualizarSuelto(H);
    },
    'suelto-parte'() { const H = E.hoja; if (H && H.estado === 'suelto') { H.comps = H.comps.concat({ n: '', q: '', u: 'kg' }); renderHoja(); const n = $(`#s-q-${H.comps.length - 1}`); if (n) n.focus(); } },
    'suelto-parte-quitar'(el) { const H = E.hoja; if (H && H.estado === 'suelto') { H.comps = H.comps.filter((c, i) => i !== +el.dataset.i); H.clave = null; actualizarSuelto(H); } },
    // «aviso que voy»: una nota para la familia, para que anoten lo que falte
    async 'voy-al-super'() {
      if (!puede() || !Datos.notas) return;
      const c = ultimoComercio();
      try { await Datos.notas.agregar(`Voy a hacer las compras${c ? ` (${c})` : ''}. Si falta algo, anotalo en la lista.`, 1, 'voy'); avisar('Listo: tu familia ve el aviso en Notas'); }
      catch (e) { avisar((e && e.texto) || textoFallo(e)); }
      pintar();
    },
    // anotar un producto en la lista aunque no se haya terminado
    pedir(el) {
      const id = el.dataset.id, p = E.prod.get(id);
      if (!p || !puede()) return;
      const a = N.analizar(p, hoyDia(), E.ajustes.frecuencia), pedido = a.pedido ? 0 : hoyDia();
      E.prod.set(id, { ...p, pedido });
      el.textContent = pedido ? 'Sacar de la lista' : 'Anotar en la lista';
      el.classList.toggle('btn-principal', !pedido);
      enCola(id, () => escribir(() => E.db.doc('productos/' + id).update({ pedido }))).then(() => {
        avisar(pedido ? `${p.nombre}: anotado en la lista de compras` : `${p.nombre}: salió de la lista`);
        if (pedido && Datos.evento) Datos.evento('lista', `${miNombre()} anotó en la lista: ${p.nombre}`);
      }, falloGuardar);
      pintar();
    },
    // las promos
    'promo-nueva'() {
      if (!puede() || !puedeCerca()) return;
      pintarComercios();
      const fin = new Date(); fin.setMonth(fin.getMonth() + 1, 0);
      abrirHoja({ tipo: 'promo', comercio: ultimoComercio(), texto: '', pct: '', medio: PROMO_MEDIOS[0], dias: [], hasta: N.hoyISO(fin), error: '', ocupado: false });
    },
    'promo-foto'() { if (E.hoja && E.hoja.tipo === 'promo' && !E.hoja.leyendo) elegir(dedoGrueso() ? 'in-promo-cam' : 'in-promo-gal'); },
    'promo-galeria'() { if (E.hoja && E.hoja.tipo === 'promo' && !E.hoja.leyendo) elegir('in-promo-gal'); },
    // ¿Qué cocino?
    cocina() {
      if (!hayIA()) return;
      let personas = 4;
      try { personas = entero(localStorage.getItem('libreta.personas'), 4, 1) || 4; } catch (e) { /* queda 4 */ }
      abrirHoja({ tipo: 'cocina', paso: 'elegir', comida: 'comida', personas: String(personas), recetas: [], vistas: [], anotadas: [], pensando: false, error: '' });
    },
    'cocina-comida'(el) {
      const H = E.hoja;
      if (!H || H.tipo !== 'cocina' || H.pensando) return;
      H.comida = el.dataset.c;
      for (const b of $$('#hoja [data-act="cocina-comida"]')) { const si = b === el; b.classList.toggle('puesto', si); b.setAttribute('aria-pressed', si ? 'true' : 'false'); }
    },
    'cocina-pensar'() { pensarRecetas(false); },
    'cocina-otras'() { pensarRecetas(true); },
    'cocina-faltan'(el) { anotarFaltantes(+el.dataset.i); },
    'promo-dia'(el) {
      const H = E.hoja, d = +el.dataset.d;
      if (!H || H.tipo !== 'promo') return;
      H.dias = H.dias.includes(d) ? H.dias.filter(x => x !== d) : H.dias.concat(d);
      const si = H.dias.includes(d);
      el.classList.toggle('puesto', si); el.setAttribute('aria-pressed', si ? 'true' : 'false');
    },
    'copiar-alias'() {
      let p;
      try { p = navigator.clipboard.writeText(APORTES.alias); } catch (e) { p = Promise.reject(e); }
      p.then(() => avisar(`Alias copiado: ${APORTES.alias}. ¡Gracias!`), () => avisar(`El alias es ${APORTES.alias}`));
    },
    mes(el) { E.mes = el.dataset.mes; renderGastos(); const g = $$('#ga-cuerpo [data-act="mes"]').find(x => x.dataset.mes === E.mes); if (g) g.focus({ preventScroll: true }); },
    'mes-mover'(el) { E.mes = N.sumarMes(E.mes, +el.dataset.d); renderGastos(); const b = $(`#ga-cuerpo [data-act="mes-mover"][data-d="${el.dataset.d}"]`); if (b && !b.disabled) b.focus({ preventScroll: true }); },
    'subir-ticket'() {
      if (!puede()) return;
      pintarComercios();
      abrirHoja({ tipo: 'ticket', estado: 'espera' });
      if ((Lector.tickets() || Datos.fotos) && dedoGrueso()) elegir('in-tic-cam');
    },
    'gasto-manual'() { if (puede()) { pintarComercios(); abrirHoja({ tipo: 'ticket', estado: 'revisar', origen: 'manual', t: gastoVacio() }); } },
    'ticket-ver'(el) {
      const id = el.dataset.id, t = E.tickets.find(x => x.id === id);
      abrirHoja({ tipo: 'ticket-ver', id, urls: [] });
      if (t && t.foto && Datos.fotos) verFotoTicket(E.hoja, id);
    },
    'foto-zoom'() {
      const H = E.hoja, im = $('#hoja .t-foto');
      if (!H || !im) return;
      H.fotoGrande = !H.fotoGrande;
      im.classList.toggle('grande', H.fotoGrande);
    },
    'borrar-ticket'() { cambiarHoja({ borrar: true }); const el = $('#hoja .nota'); if (el) el.scrollIntoView({ block: 'nearest' }); },
    'borrar-ticket-si'() { borrarTicket(); },
    'editar-ticket'() {
      const H0 = E.hoja, t = E.tickets.find(x => x.id === H0.id);
      if (!t || !puede()) return;
      const fotoUrl = H0.fotoUrl || '';   // la foto ya cargada pasa a la hoja de edición
      if (fotoUrl) H0.urls = H0.urls.filter(u => u !== fotoUrl);
      abrirHoja({
        tipo: 'ticket', estado: 'revisar', id: t.id, origen: t.origen || 'manual', creado: t.creado, ejemplo: !!t.ejemplo,
        tieneFoto: !!t.foto, fotoUrl, urls: fotoUrl ? [fotoUrl] : [],
        t: { comercio: t.comercio || '', fecha: t.fecha, total: N.campoPlata(+t.total || 0), cat: t.cat || 'otros', aAlacena: false,
          items: (t.items || []).map(it => ({ n: it.n, c: String(it.c || 1), i: N.campoPlata(+it.i || 0), cat: it.cat, dest: 'no', abierto: false })) },
      });
    },
    'item-abrir'(el) { const it = E.hoja.t.items[+el.dataset.i]; if (!it) return; it.abierto = !it.abierto; renderHoja(); const b = $(`#hoja [data-act="item-abrir"][data-i="${el.dataset.i}"]`); if (b) b.focus({ preventScroll: true }); },
    'item-quitar'(el) { E.hoja.t.items.splice(+el.dataset.i, 1); E.hoja.sucio = true; renderHoja(); },
    'item-nuevo'() {
      const t = E.hoja.t;
      t.items.push({ n: '', c: '1', i: '', cat: 'otros', dest: 'no', abierto: true });
      E.hoja.sucio = true; renderHoja();
      const el = document.getElementById('t-n-' + (t.items.length - 1)); if (el) el.focus();
    },
    'seguir-ticket'() { cambiarHoja({ descartar: false }); },
    'descartar-ticket'() { cerrarHoja(); },
    ajustes() { abrirHoja({ tipo: 'ajustes', frecuencia: E.ajustes.frecuencia, presupuesto: N.campoPlata(E.ajustes.presupuesto), firma: Datos.hogar ? JSON.stringify(Datos.hogar.integrantes()) : '', ...SIN_PANEL }); },
    'aj-frecuencia'(el) { E.hoja.frecuencia = +el.dataset.frec; for (const b of $$('#hoja [data-act="aj-frecuencia"]')) b.setAttribute('aria-pressed', String(b === el)); },
    'borrar-ejemplos'() { if (!puede()) return; if (E.hoja) cerrarHoja(); borrarEjemplos('todo'); pintar(); },
    // la entrada: el tutorial, la cuenta de Google, y crear un hogar o entrar a uno con un código
    'tutorial-ver'() {
      if (E.puerta) { Object.assign(E.puerta, { modo: 'tutorial', paso: 0, error: '' }); render(); return; }
      abrirHoja({ tipo: 'tutorial', paso: 0 });
    },
    'tutorial-sigue'() {
      const X = E.puerta || E.hoja;
      if (!X) return;
      if (X.paso < pasosTutorial().length - 1) { X.paso++; if (E.puerta) render(); else renderHoja(true); return; }
      ACC['tutorial-saltar']();
    },
    'tutorial-atras'() { const H = E.hoja; if (H && H.tipo === 'tutorial' && H.paso > 0) { H.paso--; renderHoja(true); } },
    'tutorial-saltar'() {
      guardarLocal('libreta.tutorial', true);
      if (E.puerta) { Object.assign(E.puerta, { modo: 'inicio', paso: 0 }); render(); } else cerrarHoja();
    },
    'puerta-google'() {
      const P = E.puerta;
      if (!P || P.ocupado) return;
      const pedido = Datos.hogar.entrarConGoogle();            // sin esperar nada antes: la ventana de Google se abre dentro del toque
      Object.assign(P, { ocupado: true, error: '', errorBuscar: '', aviso: '' });
      render();
      pedido.then(entro => {
        if (entro || E.puerta !== P) return;
        Object.assign(P, { ocupado: false, modo: soloCodigo(P.codigo).length === 8 ? 'unirse' : 'inicio', nombre: Datos.hogar.nombreSugerido() });
        render();
      }, e => {
        if (E.puerta !== P) return;
        const texto = (e && e.texto) || 'No se pudo entrar. Probá de nuevo.';
        Object.assign(P, { ocupado: false, modo: 'inicio' }, Datos.hogar.yo() ? { errorBuscar: texto } : { error: texto });
        render();
      });
    },
    'puerta-buscar'() { buscarHogar(); },
    'puerta-salir'() { const P = E.puerta; if (!P || P.ocupado) return; P.ocupado = true; Datos.hogar.cerrarSesion(); },
    'puerta-borrar'() { Object.assign(E.puerta, { modo: 'borrar', error: '' }); render(); },
    'puerta-borrar-si'() {
      const P = E.puerta;
      if (!P || P.ocupado) return;
      const pedido = Datos.hogar.borrarCuenta(false);          // también directo en el toque: Google pide entrar de nuevo
      Object.assign(P, { ocupado: true, error: '' });
      render();
      pedido.catch(e => { if (E.puerta !== P) return; Object.assign(P, { ocupado: false, error: (e && e.texto) || 'No se pudo borrar la cuenta. Probá de nuevo.' }); render(); });
    },
    'puerta-crear'() { Object.assign(E.puerta, { modo: 'crear', error: '' }); render(); const c = $('#pu-nombre'); if (c) c.select(); },
    'puerta-unirse'() { Object.assign(E.puerta, { modo: 'unirse', error: '' }); render(); const c = $('#pu-codigo'); if (c) c.focus(); },
    'puerta-volver'() { Object.assign(E.puerta, { modo: 'inicio', error: '' }); render(); },
    'puerta-recargar'() { location.reload(); },
    async 'puerta-diagnostico'() {
      const P = E.puerta;
      P.diag = 'corriendo'; render();
      const pasos = await diagnosticar();
      if (E.puerta === P) { P.diag = pasos; render(); }
    },
    // lo que quedó de la libreta anterior en este teléfono
    async 'anterior-si'() {
      const a = E.anterior;
      if (!a || a.ocupado) return;
      a.ocupado = true; render();
      try { await Datos.hogar.traerAnterior(); E.anterior = null; avisar('Listo: lo de la libreta anterior ya está en este hogar'); }
      catch (e) { a.ocupado = false; avisar((e && e.texto) || 'No se pudieron traer. Probá de nuevo.'); }
      render();
    },
    'anterior-no'() { if (E.anterior) { E.anterior.confirmar = true; render(); } },
    'anterior-volver'() { if (E.anterior) { E.anterior.confirmar = false; render(); } },
    'anterior-descartar'() { Datos.hogar.descartarAnterior(); E.anterior = null; render(); avisar('Datos anteriores descartados'); },
    // el hogar, desde Ajustes
    async 'hogar-invitar'() {
      if (!puede()) return;
      abrirHoja({ tipo: 'invitar', estado: 'pidiendo' });
      const H = E.hoja;
      try { const inv = await Datos.hogar.invitar(); if (E.hoja === H) cambiarHoja({ estado: 'listo', inv }); }
      catch (e) { if (E.hoja === H) cambiarHoja({ estado: 'error', error: (e && e.texto) || 'No se pudo pedir el código.' }); }
    },
    'hogar-quitar'(el) { cambiarHoja({ ...SIN_PANEL, quitar: el.dataset.id }); alVerHogar(); },
    'hogar-salir'() { cambiarHoja({ ...SIN_PANEL, salir: true, ultimo: Datos.hogar.integrantes().length < 2 }); alVerHogar(); },
    'hogar-cerrar'() { cambiarHoja({ ...SIN_PANEL, cerrar: true }); alVerHogar(); },
    'hogar-borrar-cuenta'() { cambiarHoja({ ...SIN_PANEL, borrarCuenta: true }); alVerHogar(); },
    'hogar-renombrar'() {
      const yo = Datos.hogar.integrantes().find(d => d.yo);
      cambiarHoja({ ...SIN_PANEL, renombrar: yo ? yo.nombre : '' }); alVerHogar();
      const c = $('#aj-nombre'); if (c) c.select();
    },
    'hogar-no'() { cambiarHoja({ ...SIN_PANEL }); alVerHogar(); },
    async 'hogar-renombrar-si'() {
      const H = E.hoja;
      if (!H || H.ocupado || H.renombrar == null) return;
      const n = limpio(H.renombrar);
      if (!n) { cambiarHoja({ errorHogar: 'Escribí cómo te llaman.' }); alVerHogar(); return; }
      cambiarHoja({ ocupado: true, errorHogar: '' }); alVerHogar();
      try { await Datos.hogar.renombrar(n); if (E.hoja === H) cambiarHoja({ ...SIN_PANEL, ocupado: false }); avisar('Nombre cambiado'); }
      catch (e) { if (E.hoja === H) cambiarHoja({ ocupado: false, errorHogar: (e && e.texto) || 'No se pudo cambiar el nombre.' }); }
      if (E.hoja === H) alVerHogar();
    },
    async 'hogar-quitar-si'() {
      const H = E.hoja, id = H && H.quitar;
      if (!id || H.ocupado) return;
      H.ocupado = true;
      try { await Datos.hogar.quitar(id); if (E.hoja === H) { cambiarHoja({ ...SIN_PANEL, ocupado: false }); alVerHogar(); } avisar('Quitado del hogar'); }
      catch (e) { if (E.hoja === H) { cambiarHoja({ ocupado: false, errorHogar: (e && e.texto) || 'No se pudo quitar.' }); alVerHogar(); } }
    },
    async 'hogar-salir-si'() {
      const H = E.hoja;
      if (!H || H.ocupado) return;
      cambiarHoja({ ocupado: true, errorHogar: '' }); alVerHogar();
      try { await Datos.hogar.salir(!!H.ultimo); }       // al salir, la página vuelve sola a la entrada
      catch (e) {
        if (E.hoja !== H) return;
        // resultó ser la última persona del hogar y todavía no se le avisó que con ella se borran los datos
        if (e && e.code === 'nube/ultimo') cambiarHoja({ ocupado: false, ultimo: true });
        else cambiarHoja({ ocupado: false, errorHogar: (e && e.texto) || 'No se pudo salir.' });
        alVerHogar();
      }
    },
    'hogar-cerrar-si'() {
      const H = E.hoja;
      if (!H || H.ocupado) return;
      cambiarHoja({ ocupado: true, errorHogar: '' }); alVerHogar();
      // lo que todavía no salió de la app se le pasa al servidor (si hay conexión, llega); después la página vuelve sola a la entrada
      Promise.all([...cola.keys()].map(volcar)).catch(() => {}).then(() => Datos.hogar.cerrarSesion());
    },
    'hogar-borrar-cuenta-si'() {
      const H = E.hoja;
      if (!H || H.ocupado) return;
      const pedido = Datos.hogar.borrarCuenta(Datos.hogar.integrantes().length < 2);      // directo en el toque: Google pide entrar de nuevo
      cambiarHoja({ ocupado: true, errorHogar: '' }); alVerHogar();
      pedido.catch(e => { if (E.hoja !== H) return; cambiarHoja({ ocupado: false, errorHogar: (e && e.texto) || 'No se pudo borrar la cuenta.' }); alVerHogar(); });
    },
    // notas del hogar
    notas() {
      if (!Datos.notas || E.puerta) return;
      abrirHoja({ tipo: 'notas', texto: '', dias: 3 });
      marcarNotasLeidas(); renderAvisos(); pintarNotas();
    },
    'nota-dias'(el) {
      const H = E.hoja;
      if (!H || H.tipo !== 'notas') return;
      H.dias = +el.dataset.dias;
      for (const b of $$('#hoja [data-act="nota-dias"]')) b.setAttribute('aria-pressed', String(b === el));
    },
    async 'nota-borrar'(el) {
      if (!puede()) return;
      try { await Datos.notas.borrar(el.dataset.id); avisar('Nota borrada'); } catch (e) { avisar((e && e.texto) || textoFallo(e)); }
      pintar();
    },
    // el comercio, en el mapa
    'elegir-comercio'(el) { abrirElegirComercio(el.dataset.para, el.dataset.campo); },
    'comercio-marcar'() { marcarEnMapa(); },
    'comercio-aca'() { marcarAca(); },
    'comercio-rubro'(el) {
      const S = subComercio();
      if (!S) return;
      S.rubro = S.rubro === el.dataset.n ? '' : el.dataset.n;
      for (const b of $$('#hoja [data-act="comercio-rubro"]')) { const si = b.dataset.n === S.rubro; b.classList.toggle('puesto', si); b.setAttribute('aria-pressed', si ? 'true' : 'false'); }
    },
    // ¿lo recomienda este hogar? Va con los precios que comparte
    reco(el) {
      const id = el.dataset.id, p = E.prod.get(id), v = +el.dataset.v;
      if (!p || !puede()) return;
      const nuevo = p.reco === v ? 0 : v;
      E.prod.set(id, { ...p, reco: nuevo });
      for (const b of $$(`#hoja [data-act="reco"][data-id="${id}"]`)) { const si = +b.dataset.v === nuevo; b.classList.toggle('puesto', si); b.setAttribute('aria-pressed', si ? 'true' : 'false'); }
      enCola(id, () => escribir(() => E.db.doc('productos/' + id).update({ reco: nuevo }))).then(() => avisar(nuevo === 1 ? 'Lo recomendás: lo ven los hogares de tu zona cuando compartís el precio' : nuevo === -1 ? 'No lo recomendás: lo ven los hogares de tu zona cuando compartís el precio' : 'Sin opinión sobre este producto'), falloGuardar);
    },
    'comercio-cerca'() { buscarCercanos(true); },
    'comercio-elegir'(el) { elegirLugar(el.dataset.de, +el.dataset.i); },
    'comercio-usar'(el) { usarComercio(el.dataset.ref); },
    'comercio-quitar'(el) {
      const S = subComercio(), ref = el.dataset.ref;
      if (!S || !puede() || !E.ajustes.comercios[ref]) return;
      const quedan = Object.assign({}, E.ajustes.comercios), n = quedan[ref].n;
      delete quedan[ref];
      cambiarAjustes({ comercios: quedan }).then(() => avisar(`${n} ya no está entre tus comercios`), falloGuardar);
      pintarLugares();
    },
    'comercio-chip'(el) {
      const S = subComercio(), c = $('#lc-nombre'), e = $('#hoja .error');
      if (!S || !c) return;
      S.nombre = el.dataset.n; S.error = '';
      c.value = S.nombre;
      if (e) e.remove();
      c.focus();
    },
    'comercio-volver'() { const S = subComercio(); if (!S || S.ocupado) return; soltarMapa(S); Object.assign(S, { paso: 'lista', elegido: null, error: '' }); renderHoja(true); },
    // los precios de la zona
    async 'cerca-activar'() {
      if (!puedeCerca()) return;
      const H = E.hoja, enAjustes = () => H && E.hoja === H && H.tipo === 'ajustes' && !H.sub;
      let nota = '';
      try { if (!await C.posicion(true)) nota = 'No se pudo saber dónde estás.'; }
      catch (e) { nota = (e && e.texto) || 'No se pudo saber dónde estás.'; }
      if (nota) {
        E.cerca = { estado: 'sin', pos: null, porId: new Map(), firma: '', t: 0, nota };
        if (enAjustes()) avisar(nota);
        pintar();
        return;
      }
      if (enAjustes()) renderHoja();
      actualizarCerca();
    },
    'cerca-actualizar'() { actualizarCerca(); },
    'cerca-olvidar'() {
      const H = E.hoja;
      C.olvidarPosicion();
      E.cerca = { estado: 'sin', pos: null, porId: new Map(), firma: '', t: 0, nota: '' };
      if (H && H.tipo === 'ajustes' && !H.sub) renderHoja();
      avisar('Ubicación olvidada en este teléfono');
      pintar();
    },
    async 'compartir-si'() {
      const H = E.hoja, pend = E.porCompartir;
      if (!puede()) return;
      try { await cambiarAjustes({ compartir: true }); } catch (e) { falloGuardar(e); return; }
      E.porCompartir = null;
      let n = 0;
      if (pend) { try { n = await aportarZona(pend.items, pend.ref, pend.dia, E.ajustes.alias, lugarDe(pend.ref)); } catch (e) { n = 0; } }
      if (n) E.cerca.t = 0;
      if (H && E.hoja === H && H.cerca) { H.cerca.preguntar = false; H.cerca.compartidos = n; renderHoja(); }
      else avisar(n ? `Listo: ${n === 1 ? 'el precio que anotaste ya lo ve' : `los ${n} precios que anotaste ya los ve`} tu zona` : 'Listo: los precios que anotes se comparten con tu zona');
      pintar();
    },
    async 'compartir-no'() {
      const H = E.hoja;
      if (!puede()) return;
      E.porCompartir = null;
      try { await cambiarAjustes({ compartir: false }); } catch (e) { falloGuardar(e); return; }
      if (H && E.hoja === H && H.cerca) { H.cerca.preguntar = false; renderHoja(); }
      pintar();
    },
    'mapa-lista'() {
      const pines = pinesDe(V.compras.map(x => x.id)).filter(pn => pn.baratos);
      abrirMapa({ titulo: 'Dónde conviene comprar', bajada: 'Los comercios de tu zona donde otros hogares pagaron menos por lo que tenés en la lista.', pines, pin: pines.length ? pines[0].k : null });
    },
    'mapa-zona'() { abrirMapa({ titulo: 'Precios cerca tuyo', bajada: 'Lo que otros hogares de tu zona pagaron por los productos de tu alacena.', pines: pinesDe([...V.cerca.keys()]), pin: null }); },
    'mapa-producto'(el) { mapaDeProducto(el.dataset.id); },
    'mapa-compra'() { const H = E.hoja; if (H && H.cerca) verBaratos(H.cerca); },
    'mapa-pin'(el) { const M = mapaActual(); if (M) elegirPin(M, el.dataset.k, true); },
    async 'hogar-diagnostico'() {
      const H = E.hoja;
      cambiarHoja({ diag: 'corriendo' }); alVerHogar();
      const pasos = await diagnosticar();
      if (E.hoja === H) { cambiarHoja({ diag: pasos }); alVerHogar(); }
    },
    // copia de seguridad: un archivo con todo lo guardado, para bajar y para restaurar
    exportar() {
      try {
        const url = URL.createObjectURL(new Blob([JSON.stringify(Datos.copia.exportar(), null, 1)], { type: 'application/json' }));
        const a = document.createElement('a');
        a.href = url; a.download = `libreta-${N.hoyISO()}.json`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        avisar('Copia lista: quedó en las descargas');
      } catch (e) { avisar('No se pudo armar la copia.'); }
    },
    importar() { elegir('in-copia'); },
    'importar-no'() { cambiarHoja({ copia: null, errorCopia: '' }); },
    async 'importar-si'() {
      const H = E.hoja;
      if (!H || !H.copia || H.ocupado || !puede()) return;
      H.ocupado = true;
      try {
        await Promise.all([...cola.keys()].map(volcar));   // que no quede ningún cambio a medio guardar
        await Datos.copia.importar(H.copia.datos);
      } catch (e) {
        if (E.hoja === H) { cambiarHoja({ ocupado: false, copia: null, errorCopia: textoFallo(e) }); alVerCopia(); } else falloGuardar(e);
        return;
      }
      if (!H.copia.n.suma) { cola.clear(); E.marcados.clear(); guardarLocal('libreta.marcados', []); }
      const suma = H.copia.n.suma;
      if (E.hoja === H) cerrarHoja();
      avisar(suma ? 'Copia sumada al hogar' : 'Copia restaurada');
    },
  };
  const FORMS = { producto: () => guardarProducto(false), conocido: sumarConocido, ticket: guardarTicket, ajustes: guardarAjustes, gondola: () => guardarGondola(false), suelto: () => guardarSuelto(false), 'buscar-cerca': buscarCerca, promo: guardarPromo,
    compra: guardarCompra, nota: guardarNota, 'comercio-nombre': guardarComercioNuevo,
    'puerta-crear': () => entrarPorLaPuerta(true), 'puerta-unirse': () => entrarPorLaPuerta(false) };

  document.addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) { e.preventDefault(); irA(tab.dataset.tab); return; }
    const el = e.target.closest('[data-act]');
    if (!el) { if (e.target.id === 'fondo-hoja') cerrarConCuidado(true); return; }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
    const fn = ACC[el.dataset.act];
    if (fn) fn(el, e);
  });
  document.addEventListener('submit', e => {
    const f = e.target.closest('[data-form]');
    if (!f) return;
    e.preventDefault();
    const fn = FORMS[f.dataset.form];
    if (fn) fn();
  });
  function ponerEn(obj, ruta, v) {
    const ks = ruta.split('.');
    let o = obj;
    for (let i = 0; i < ks.length - 1; i++) { o = o[ks[i]]; if (o == null || typeof o !== 'object') return; }
    o[ks[ks.length - 1]] = v;
  }
  document.addEventListener('input', e => {
    const el = e.target;
    if (el.id === 'al-buscar') { E.filtro.texto = el.value; renderAlacena(); return; }
    if (el.id === 'bc-q') { E.buscaEscrito = el.value; return; }
    if (el.id === 'mz-filtro') { const H = mapaActual(); if (H && H.vivo) { H.filtro = el.value; actualizarZonaVivo(H); } return; }      // lo que se va escribiendo no se pierde si la pantalla se redibuja
    if (E.puerta && el.dataset && el.dataset.p) {
      if (el.dataset.p === 'codigo') el.value = conGuion(el.value);      // se acomoda solo: mayúsculas y guion al medio
      E.puerta[el.dataset.p] = el.value;
      return;
    }
    const k = el.dataset ? el.dataset.k : null;
    if (!k || !E.hoja) return;
    ponerEn(E.hoja, k, el.type === 'checkbox' ? el.checked : el.value);
    if (k.startsWith('sub.')) { if (el.id === 'lc-buscar') sugerirComercios(); return; }      // la hoja de encima: buscar un comercio
    E.hoja.sucio = true;
    if (E.hoja.tipo === 'ticket') ticketVivo();
    if (el.id === 'g-precio' && E.hoja.estado === 'suelto' && E.hoja.vende === 'combo') { pintarCuentaCombo(E.hoja); return; }
    if (el.id === 'g-precio' && (E.hoja.estado === 'gondola' || E.hoja.estado === 'suelto')) { const v = veredictoGondola(E.hoja), n = $('#g-veredicto'); if (n) { n.textContent = v.texto; n.className = 'gondola-veredicto ' + v.tono; } }
    if (el.id === 'p-diario' && E.hoja.f) E.hoja.f.diarioTocado = true;
    if (el.id === 'p-categoria' && E.hoja.f && !E.hoja.f.diarioTocado) {
      E.hoja.f.diario = N.diarioPorCategoria(el.value);
      const c = $('#p-diario');
      if (c) c.checked = E.hoja.f.diario;
    }
    // lo que se pone al día mientras se escribe: cuánto cambió el precio, si el comercio está ubicado, el total de la compra
    const nota = el.id ? $(`#hoja [data-nota-de="${el.id}"]`) : null;
    if (nota) nota.textContent = notaPrecio(nota.dataset.prod, el.value);
    if (el.dataset.comercio !== undefined) {
      const n = $(`#hoja [data-nota-comercio="${el.id}"]`), b = $(`#hoja [data-act="elegir-comercio"][data-campo="${el.id}"]`);
      if (n) n.textContent = notaComercio(el.value);
      if (b) b.classList.toggle('puesto', !!refDeComercio(el.value));
    }
    if (E.hoja.tipo === 'compra') { const t = $('#cp-total'); if (t) t.textContent = textoTotalCompra(E.hoja); }
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset && 'suelto' in el.dataset && E.hoja && E.hoja.estado === 'suelto') { actualizarSuelto(E.hoja); return; }
    if (el.dataset && 'combo' in el.dataset && E.hoja && E.hoja.estado === 'suelto') { E.hoja.clave = null; actualizarSuelto(E.hoja); return; }
    if (el.dataset && el.dataset.cambio === 'aviso') {      // qué notificaciones: vale para este teléfono
      Datos.avisos.preferencias({ [el.dataset.tipo]: el.checked }).catch(falloGuardar);
      return;
    }
    if (el.dataset && el.dataset.cambio === 'ia') {      // usar o no la IA: vale para este teléfono
      try { if (el.checked) localStorage.removeItem(CLAVE_IA); else localStorage.setItem(CLAVE_IA, 'no'); } catch (x) { /* sin almacenamiento */ }
      pintar();
      avisar(el.checked ? 'La IA queda encendida en este teléfono' : 'La IA queda apagada en este teléfono');
      return;
    }
    if (el.dataset && el.dataset.cambio === 'compartir') {      // compartir o no los precios con la zona: vale para todo el hogar
      if (!puede()) { el.checked = !el.checked; return; }
      const si = el.checked;
      cambiarAjustes({ compartir: si }).then(() => avisar(si ? 'Los precios que anotes con el comercio ubicado se comparten con tu zona' : 'Tus precios ya no se comparten'), falloGuardar);
      return;
    }
    if (el.dataset && el.dataset.cambio === 'alias') {      // el nombre con el que la zona ve al hogar
      const v = limpio(el.value).slice(0, 40);
      if (v === E.ajustes.alias) return;
      if (!puede()) { el.value = E.ajustes.alias; return; }
      cambiarAjustes({ alias: v }).then(() => avisar(v ? `Tu zona te va a ver como «${v}»` : 'Tu zona te va a ver como «otro hogar»'), falloGuardar);
      return;
    }
    if (!el.dataset || el.dataset.cambio !== 'marcar') return;
    if (el.checked) E.marcados.add(el.dataset.id); else E.marcados.delete(el.dataset.id);
    guardarLocal('libreta.marcados', [...E.marcados]);
    renderCompras();
    const otra = $$('#co-lista [data-cambio="marcar"]').find(x => x.dataset.id === el.dataset.id);
    if (otra) otra.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && E.hoja) { e.preventDefault(); cerrarConCuidado(false); return; }
    if (e.key === 'Enter' && e.target.id === 'aj-nombre') { e.preventDefault(); ACC['hogar-renombrar-si'](); return; }
    if (e.key === 'Enter' && e.target.id === 'aj-alias') { e.preventDefault(); e.target.blur(); return; }      // se guarda al salir del campo      // dentro de Ajustes, Enter guarda el nombre y no los ajustes
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('g[data-act], img[data-act]')) { e.preventDefault(); ACC[e.target.dataset.act](e.target, e); return; }
    if (e.key === 'Tab' && E.hoja) {   // el foco no sale del diálogo
      const hoja = $('#hoja'), fs = $$('button, [href], input, select, textarea', hoja).filter(x => !x.disabled && x.offsetParent !== null);
      if (!fs.length) return;
      const primero = fs[0], ultimo = fs[fs.length - 1];
      if (!hoja.contains(document.activeElement)) { e.preventDefault(); primero.focus(); }
      else if (e.shiftKey && (document.activeElement === primero || document.activeElement === hoja)) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
    }
  });

  // archivos: cámara, galería, arrastrar y pegar
  const alElegir = (id, fn) => document.getElementById(id).addEventListener('change', e => {
    const fs = Array.from(e.target.files || []);
    e.target.value = '';
    if (fs.length) fn(fs);
  });
  const alProducto = fs => { const id = E.codigoPara; E.codigoPara = null; if (id) fotoCodigo(fs[0], id); else fotoProducto(fs[0]); };
  alElegir('in-prod-cam', alProducto);
  alElegir('in-prod-gal', alProducto);
  alElegir('in-tic-cam', fs => fotoTicket(fs));
  alElegir('in-tic-gal', fs => fotoTicket(fs));
  if (document.getElementById('in-suelto-cam')) { alElegir('in-suelto-cam', fs => fotoSuelto(fs[0])); alElegir('in-suelto-gal', fs => fotoSuelto(fs[0])); }
  if (document.getElementById('in-promo-cam')) { alElegir('in-promo-cam', fs => fotoPromo(fs[0])); alElegir('in-promo-gal', fs => fotoPromo(fs[0])); }
  if (document.getElementById('in-copia')) alElegir('in-copia', async fs => {
    const H = E.hoja;
    if (!H || H.tipo !== 'ajustes' || !Datos.copia) return;
    let datos = null;
    try { datos = JSON.parse(await new Response(fs[0]).text()); } catch (e) { datos = null; }
    if (E.hoja !== H) return;
    const n = datos ? Datos.copia.revisar(datos) : null;
    cambiarHoja(n ? { copia: { datos, n }, errorCopia: '' } : { copia: null, errorCopia: 'Ese archivo no es una copia de la libreta.' });
    alVerCopia();
  });
  // Una imagen arrastrada o pegada vale mientras la hoja espera una foto, y también con el visor de la cámara abierto.
  const esperaFoto = () => {
    const H = E.hoja;
    return !!H && ((H.tipo === 'ticket' && H.estado === 'espera') || (H.tipo === 'escanear' && (H.estado === 'espera' || H.estado === 'camara')));
  };
  const recibir = fs => {
    fs = fs.filter(Imagen.esImagen);
    if (!fs.length) return false;
    const H = E.hoja;
    if (H.tipo === 'ticket') fotoTicket(fs); else if (H.codigoPara) fotoCodigo(fs[0], H.codigoPara); else fotoProducto(fs[0]);
    return true;
  };
  const fondo = $('#fondo-hoja');
  fondo.addEventListener('dragover', e => { if (esperaFoto()) { e.preventDefault(); fondo.classList.add('soltar'); } });
  fondo.addEventListener('dragleave', e => { if (e.target === fondo) fondo.classList.remove('soltar'); });
  fondo.addEventListener('drop', e => {
    fondo.classList.remove('soltar');
    if (!esperaFoto()) return;
    e.preventDefault();
    recibir(Array.from((e.dataTransfer && e.dataTransfer.files) || []));
  });
  document.addEventListener('paste', e => {
    if (!esperaFoto()) return;
    if (recibir(Array.from((e.clipboardData && e.clipboardData.files) || []))) e.preventDefault();
  });
  // Un archivo soltado en cualquier otro lado no hace nada: sin esto el navegador lo abriría en lugar de la libreta.
  const traeArchivos = e => !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragover', e => { if (traeArchivos(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (traeArchivos(e)) e.preventDefault(); });

  let relojAncho = 0;
  window.addEventListener('resize', () => { clearTimeout(relojAncho); relojAncho = setTimeout(() => { if (E.tab === 'gastos') renderGastos(); }, 150); });
  // Una dirección que termina en #unir=CÓDIGO (la del QR) trae el código para entrar a un hogar.
  function tomarCodigo() {
    const m = /^#unir=([A-Za-z0-9-]{8,9})$/.exec(location.hash);
    if (!m) return '';
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sin historial, no importa */ }
    return soloCodigo(m[1]);
  }
  window.addEventListener('hashchange', () => {
    const codigo = tomarCodigo();
    if (codigo) {
      if (E.puerta) { Object.assign(E.puerta, { codigo: conGuion(codigo), error: '' }, Datos.hogar.yo() && !E.puerta.buscando ? { modo: 'unirse' } : {}); render(); }
      else avisar('Ya estás en un hogar. Para entrar a otro, primero salí de este desde Ajustes.');
      return;
    }
    const t = location.hash.slice(1);
    if (t === 'cuenta') { verCuenta(); return; }
    if (t && t !== E.tab && !E.puerta && TABS.includes(t)) irA(t);
  });
  // La dirección que termina en #cuenta lleva a donde se cierra la sesión o se borra la cuenta.
  function verCuenta() {
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sin historial, no importa */ }
    if (E.puerta || !Datos.hogar || !E.db || E.hoja) return;
    ACC.ajustes();
    alVerHogar();
  }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { pintar(); return; }
    const H = E.hoja;   // con la página oculta la cámara no queda abierta
    if (H && H.tipo === 'escanear' && H.estado === 'camara') sinVideo(H, H.codigoPara ? 'Se cerró la cámara antes de leer el código.' : '');
  });

  /* ---------- arranque ---------- */
  E.marcados = new Set(leerLocal('libreta.marcados', []).filter(x => typeof x === 'string'));
  codigoEnlace = tomarCodigo();
  const inicial = location.hash.slice(1);
  let pideCuenta = inicial === 'cuenta';
  if (TABS.includes(inicial)) E.tab = inicial;
  render();
  iniciar().then(() => { if (pideCuenta) { pideCuenta = false; verCuenta(); } });
  let sinLeer = '';
  const alCambiarNotas = () => {      // el aviso de notas sin leer se rehace solo cuando cambia cuáles son
    pintarNotas();
    const firma = notasSinLeer().map(n => n.id).join();
    if (firma !== sinLeer) { sinLeer = firma; if (!E.puerta) renderAvisos(); }
  };
  if (Datos.hogar) {
    Datos.hogar.alCambiar(() => {
      pintarSinc();
      if (E.puerta) return;
      alCambiarNotas();
      const H = E.hoja, firma = JSON.stringify(Datos.hogar.integrantes());      // con Ajustes abierto, la lista de integrantes se mantiene al día
      if (H && H.tipo === 'ajustes' && !H.sub && !H.ocupado && H.firma !== firma) { H.firma = firma; renderHoja(); }
    });
    Datos.hogar.alRechazar(e => avisar((e && e.texto) || 'Un cambio no llegó a guardarse en el servidor.'));
    window.addEventListener('online', pintarSinc); window.addEventListener('offline', pintarSinc);
  }
  // instalada como app, abre también sin conexión
  if (Datos.instalable && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // lo que la página ya bajó de otros sitios (las tipografías) se guarda también, para la próxima vez sin conexión
    const guardarAjeno = () => navigator.serviceWorker.ready.then(r => {
      const urls = performance.getEntriesByType('resource').map(x => x.name).filter(u => /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));
      if (r.active && urls.length) r.active.postMessage({ guardar: urls });
    }).catch(() => {});
    if (document.readyState === 'complete') guardarAjeno(); else window.addEventListener('load', guardarAjeno, { once: true });
  }
  // con la libreta abierta mucho rato: al cambiar el día hay que rehacer las cuentas, y las notas van venciendo
  let diaVisto = N.hoyISO();
  setInterval(() => { const hoy = N.hoyISO(); if (hoy !== diaVisto) { diaVisto = hoy; pintar(); } if (!E.puerta) alCambiarNotas(); }, 60000);
  if (camaraPosible() && !dedoGrueso() && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(ds => {
      if (ds.some(d => d.kind === 'videoinput')) return;
      camaraDudosa = true;
      if (E.hoja && E.hoja.tipo === 'escanear' && E.hoja.estado === 'espera') renderHoja();
    }, () => {});
  }
})();
