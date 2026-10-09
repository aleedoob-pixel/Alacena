/* Libreta del hogar — la alacena, las compras y los gastos de la casa.
   Va junto con index.html y estilos.css, los tres en la misma carpeta. No hay nada que instalar.

   Partes de este archivo, en orden:
     1. Barras     lee códigos de barras EAN-13, UPC-A y EAN-8 mirando los píxeles de una imagen
     2. Nucleo     fechas, plata, consumo, lista de compras y totales por mes: la lógica, sin pantalla
     3. Imagen     abrir fotos, achicarlas y pasarlas a grises
     4. Ejemplos   los datos de muestra que se ven la primera vez
     5. Datos      dónde se guarda todo: en este navegador (localStorage e IndexedDB)
     6. Lector     busca un producto por su código de barras en Open Food Facts
     7. la pantalla: alacena, compras, gastos, escáner, tickets y ajustes

   La pantalla le habla a Datos como a una base de documentos que podría estar en un servidor. Por eso
   contempla permisos, reintentos y un modo «solo lectura» que, guardando en el navegador, casi no se usan;
   sirven si algún día se cambia Datos por una base compartida. */

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

  /* ---------- movimientos de la alacena ----------
     Cada producto guarda `log`: una entrada [día, usados, comprados] por día con actividad. */
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
      const f = precio.fecha || isoDeDia(hoy);
      if (!p.precioFecha || f >= p.precioFecha) {
        const nuevo = redondear2(precio.valor);
        if (p.precio > 0 && Math.abs(p.precio - nuevo) > 0.004 && f > (p.precioFecha || '')) out.precioAnt = p.precio;
        out.precio = nuevo; out.precioFecha = f;
      }
    }
    return out;
  }

  /* ---------- consumo y compras sugeridas ---------- */
  const VENTANA = 56;      // días de historia que cuentan para el ritmo
  const MARGEN = 2;        // días de colchón sobre la frecuencia de compra
  const mediana = a => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };

  /* Devuelve cómo viene un producto:
     modo   'uso' (hay consumo anotado), 'compra' (se estima por cada cuánto se compra) o 'sin' datos
     ritmo  unidades por día · dias: para cuántos días alcanza
     motivo null (no hace falta) | 'agotado' | 'ritmo' | 'cadencia' | 'aviso'
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
    const horizonte = frec + MARGEN;
    const dias = ritmo > 0 ? stockEf / ritmo : Infinity;
    let motivo = null, cant = 0;
    if (p.reponer !== false) {
      if (stock <= 0) motivo = 'agotado';
      else if (ritmo > 0 && stockEf < ritmo * horizonte - 1e-9) motivo = modo === 'compra' ? 'cadencia' : 'ritmo';
      else if (modo !== 'compra' && aviso > 0 && stock <= aviso) motivo = 'aviso';
    }
    if (motivo) {
      if (ritmo > 0) cant = Math.ceil(ritmo * horizonte - stockEf - 1e-9);
      else cant = habitual;
      if (motivo === 'aviso') cant = Math.max(cant, aviso + 1 - stock);
      cant = Math.max(1, cant);
    }
    const urgencia = motivo === 'agotado' ? -1 : motivo === 'aviso' && !(ritmo > 0) ? 1000 + stock : dias;
    return { modo, ritmo, dias, stock, stockEf, aviso, motivo, cant, cadaDias, diasUltCompra: ult ? hoy - ult[0] : null, urgencia };
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
      default: return '';
    }
  }
  // Renglón corto para la alacena, haga falta comprar o no.
  function situacion(a) {
    if (a.motivo === 'agotado') return { tono: 'rojo', etiqueta: 'Sin stock', texto: a.modo === 'uso' ? `se usa ${ritmoTexto(a.ritmo)}` : '' };
    if (a.motivo === 'ritmo') return { tono: 'ambar', etiqueta: 'Queda poco', texto: alcanzaTexto(a.dias) };
    if (a.motivo === 'aviso') return { tono: 'ambar', etiqueta: 'Queda poco', texto: '' };
    if (a.motivo === 'cadencia') return { tono: 'ambar', etiqueta: 'Toca reponer', texto: `lo comprás cada ~${Math.max(1, Math.round(a.cadaDias))} días` };
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
    norm, parecido, textoProducto, buscarParecido, mayuscula, plural,
    aplicarMovs, analizar, ritmoTexto, alcanzaTexto, razon, situacion, listaCompras,
    repartoTicket, totalesPorMes, gastoHasta, porCategoria, escala,
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


/* Datos de ejemplo para ver la libreta funcionando: una alacena con historia de consumo y seis meses de
   tickets, armados alrededor de la fecha que se le pase. Todos llevan `ejemplo: true`, se muestran con un
   aviso y se borran solos cuando se carga el primer dato propio. */
const Ejemplos = (() => {
  'use strict';
  const N = Nucleo;

  // Números al azar repetibles (mulberry32), para que los ejemplos salgan siempre iguales.
  function azar(semilla) {
    let a = semilla >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // clave: [nombre, tamaño, categoría, precio de hoy]
  const P = {
    yerba: ['Yerba mate', '1 kg', 'almacen', 5900], fideos: ['Fideos tirabuzón', '500 g', 'almacen', 1650], arroz: ['Arroz largo fino', '1 kg', 'almacen', 2300],
    aceite: ['Aceite de girasol', '1,5 L', 'almacen', 5400], harina: ['Harina 000', '1 kg', 'almacen', 1150], pure: ['Puré de tomate', '520 g', 'almacen', 1200],
    cafe: ['Café molido', '500 g', 'almacen', 9800], azucar: ['Azúcar', '1 kg', 'almacen', 1500], galletitas: ['Galletitas de agua', '3 u', 'almacen', 2100],
    lentejas: ['Lentejas', '400 g', 'almacen', 1900], mermelada: ['Mermelada de durazno', '454 g', 'almacen', 3200],
    leche: ['Leche entera', '1 L', 'lacteos', 1750], yogur: ['Yogur natural', '190 g', 'lacteos', 950], huevos: ['Huevos', 'docena', 'lacteos', 4300],
    queso: ['Queso cremoso', 'por peso', 'lacteos', 7200], manteca: ['Manteca', '200 g', 'lacteos', 3400],
    papa: ['Papa', '2 kg', 'frescos', 2400], tomate: ['Tomate', '1 kg', 'frescos', 2800], banana: ['Banana', '1 kg', 'frescos', 2600], cebolla: ['Cebolla', '1 kg', 'frescos', 1500],
    manzana: ['Manzana', '1 kg', 'frescos', 3100], lechuga: ['Lechuga', 'planta', 'frescos', 1200], zanahoria: ['Zanahoria', '1 kg', 'frescos', 1400],
    picada: ['Carne picada', '1 kg', 'carnes', 9800], pollo: ['Pollo entero', 'por peso', 'carnes', 8900], milanesas: ['Milanesas de nalga', '1 kg', 'carnes', 13500], jamon: ['Jamón cocido', '200 g', 'carnes', 4200],
    pan: ['Pan lactal', '550 g', 'panaderia', 3300], facturas: ['Facturas', 'docena', 'panaderia', 7800],
    agua: ['Agua mineral', '2 L', 'bebidas', 1100], gaseosa: ['Gaseosa cola', '2,25 L', 'bebidas', 3400],
    detergente: ['Detergente', '750 ml', 'limpieza', 2900], lavandina: ['Lavandina', '1 L', 'limpieza', 1300], esponjas: ['Esponjas', '2 u', 'limpieza', 1600], ropa: ['Jabón para la ropa', '3 L', 'limpieza', 11500],
    papel: ['Papel higiénico', '4 rollos', 'higiene', 3600], jabon: ['Jabón de tocador', '3 u', 'higiene', 2400], pasta: ['Pasta dental', '90 g', 'higiene', 3100], shampoo: ['Shampoo', '400 ml', 'higiene', 5200],
    ibuprofeno: ['Ibuprofeno 400 mg', '10 comp.', 'farmacia', 4800], gel: ['Alcohol en gel', '250 ml', 'farmacia', 3300], curitas: ['Curitas', '20 u', 'farmacia', 2700],
  };
  const COMERCIOS = {
    'Supermercado del barrio': ['yerba', 'fideos', 'arroz', 'aceite', 'harina', 'pure', 'cafe', 'azucar', 'galletitas', 'lentejas', 'mermelada', 'leche', 'leche', 'yogur', 'huevos', 'queso', 'manteca', 'pan', 'agua', 'gaseosa', 'detergente', 'lavandina', 'esponjas', 'ropa', 'papel', 'jabon', 'pasta', 'shampoo', 'jamon'],
    'Verdulería': ['papa', 'tomate', 'banana', 'cebolla', 'manzana', 'lechuga', 'zanahoria'],
    'Carnicería': ['picada', 'pollo', 'milanesas'],
    'Farmacia': ['ibuprofeno', 'gel', 'curitas'],
  };
  // [clave, cuántos hay, aviso, días (hacia atrás) en que se usó uno, compras [días atrás, cantidad]]
  const ALACENA = [
    ['leche', 2, 0, [41, 39, 38, 36, 34, 33, 31, 29, 27, 26, 24, 22, 20, 19, 17, 15, 13, 12, 10, 8, 6, 5, 3, 1], [[44, 6], [30, 6], [16, 6], [7, 8]]],
    ['huevos', 1, 0, [40, 33, 27, 20, 14, 8, 2], [[45, 2], [28, 2], [16, 2], [7, 2]]],
    ['yogur', 16, 0, [], [[24, 4], [17, 4], [10, 4], [3, 4]]],
    ['yerba', 1, 0, [38, 29, 20, 11, 3], [[44, 2], [30, 2], [12, 2]]],
    ['fideos', 3, 0, [40, 36, 31, 27, 24, 19, 15, 12, 8, 4], [[44, 5], [26, 4], [9, 4]]],
    ['arroz', 2, 0, [37, 25, 13, 2], [[44, 3], [20, 3]]],
    ['aceite', 1, 0, [34, 9], [[44, 2], [30, 1]]],
    ['harina', 0, 0, [39, 24, 9], [[44, 2], [30, 1]]],
    ['pure', 4, 0, [41, 37, 32, 27, 23, 18, 14, 9, 5], [[44, 6], [22, 7]]],
    ['cafe', 1, 1, [], [[20, 1]]],
    ['agua', 6, 0, [40, 38, 35, 33, 31, 28, 26, 24, 21, 19, 17, 14, 12, 10, 7, 5, 3, 1], [[44, 12], [16, 12]]],
    ['detergente', 1, 0, [31, 2], [[44, 2], [30, 1]]],
    ['lavandina', 2, 0, [], [[12, 2]]],
    ['papel', 1, 0, [39, 31, 23, 15, 7], [[44, 3], [21, 3]]],
    ['jabon', 2, 0, [], [[30, 2]]],
  ];

  // Devuelve { 'productos/ej-…': documento, 'tickets/ej-…': documento }.
  function crear(hoyISO) {
    const hoy = N.diaDe(hoyISO), mesHoy = N.mesDe(hoyISO), diaHoy = +hoyISO.slice(8, 10), docs = {};
    for (const [k, stock, aviso, usos, compras] of ALACENA) {
      const [nombre, presentacion, categoria, precio] = P[k], m = new Map();
      for (const d of usos) { const e = m.get(hoy - d) || [hoy - d, 0, 0]; e[1]++; m.set(hoy - d, e); }
      for (const [d, c] of compras) { const e = m.get(hoy - d) || [hoy - d, 0, 0]; e[2] += c; m.set(hoy - d, e); }
      const ult = compras.reduce((a, b) => (b[0] < a[0] ? b : a));
      docs['productos/ej-' + k] = {
        nombre, marca: '', presentacion, categoria, codigo: '', stock, aviso, reponer: true,
        precio, precioFecha: N.isoDeDia(hoy - ult[0]), precioAnt: k === 'leche' ? 1620 : k === 'yerba' ? 5600 : null,
        log: [...m.values()].sort((a, b) => a[0] - b[0]), creado: N.isoDeDia(hoy - 45) + 'T12:00:00.000Z', ejemplo: true,
      };
    }
    const r = azar(20261008);
    const elegir = (lista, n) => { const l = lista.slice(), out = []; while (out.length < n && l.length) out.push(l.splice(Math.floor(r() * l.length), 1)[0]); return out; };
    let nt = 0;
    for (let atras = 5; atras >= 0; atras--) {
      const mes = N.sumarMes(mesHoy, -atras), tope = atras === 0 ? diaHoy : N.diasDelMes(mes), infl = Math.pow(1.026, -atras);
      const plan = atras === 0
        ? [['Supermercado del barrio', 15, Math.max(1, diaHoy - 5)], ['Verdulería', 4, Math.max(1, diaHoy - 3)], ['Carnicería', 2, Math.max(1, diaHoy - 1)]]
        : [['Supermercado del barrio', 18, 3], ['Verdulería', 5, 8], ['Supermercado del barrio', 16, 13], ['Carnicería', 3, 17], ['Supermercado del barrio', 17, 22]]
          .concat(atras % 2 ? [['Farmacia', 2, 27]] : [['Verdulería', 4, 27]]);
      for (const [comercio, n, dia] of plan) {
        const items = [], vistos = new Map();
        for (const k of elegir(COMERCIOS[comercio], n)) {
          const [nombre, presentacion, cat, precio] = P[k], c = 1 + (r() < 0.3 ? 1 : 0) + (r() < 0.08 ? 1 : 0);
          const unidad = Math.round(precio * infl * (0.96 + r() * 0.08) / 10) * 10;
          if (vistos.has(k)) { const it = vistos.get(k); it.c += c; it.i += unidad * c; continue; }
          const it = { n: `${nombre} ${presentacion}`, c, i: unidad * c, cat };
          vistos.set(k, it); items.push(it);
        }
        const suma = items.reduce((s, it) => s + it.i, 0);
        const total = comercio.startsWith('Super') && nt % 3 === 0 ? Math.round(suma * 0.93 / 10) * 10 : suma;   // algunos con descuento
        const fecha = `${mes}-${String(Math.min(dia, tope)).padStart(2, '0')}`;
        docs[`tickets/ej-${mes}-${String(++nt).padStart(2, '0')}`] = { comercio, fecha, total, items, cat: null, origen: 'manual', creado: fecha + 'T15:00:00.000Z', ejemplo: true };
      }
    }
    return docs;
  }

  return { crear };
})();


/* Dónde se guardan los datos cuando la libreta corre como archivos sueltos: en este navegador.
   Productos, tickets y ajustes van a localStorage (una clave por colección) y las fotos de los tickets
   a IndexedDB. Hacia la app se presenta como una base de documentos: colecciones, documentos y un aviso
   cada vez que algo cambia, también si el cambio se hizo desde otra pestaña. */
const Datos = (() => {
  'use strict';
  const PREFIJO = 'libreta:';
  const COLECCIONES = ['productos', 'tickets', 'ajustes'];
  const memoria = {};                 // si el navegador no deja usar localStorage, los datos quedan acá
  let persistente = true;
  try { localStorage.setItem(PREFIJO + 'prueba', '1'); localStorage.removeItem(PREFIJO + 'prueba'); } catch (e) { persistente = false; }

  const esObjeto = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const copiar = d => JSON.parse(JSON.stringify(d));

  // Una colección entera: { id: documento }.
  function leer(col) {
    try {
      const t = persistente ? localStorage.getItem(PREFIJO + col) : memoria[col];
      const docs = t ? JSON.parse(t) : {};
      return esObjeto(docs) ? docs : {};
    } catch (e) { return {}; }
  }
  function guardar(col, docs) {
    const t = JSON.stringify(docs);
    if (!persistente) { memoria[col] = t; return; }
    try { localStorage.setItem(PREFIJO + col, t); }
    catch (e) { throw { code: 'quota_exceeded', message: 'el navegador no tiene más lugar para guardar' }; }
  }
  // Los navegadores pueden descartar lo guardado si les falta lugar. Cuando ya hay datos propios se les
  // pide que no lo hagan (algunos lo conceden solos, otros preguntan). Se pide una sola vez por visita.
  let pedido = false;
  function conservar(d) {
    if (pedido || !persistente || !d || d.ejemplo) return;
    pedido = true;
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) { /* no se puede pedir */ }
  }

  /* ---------- avisos de cambio ---------- */
  const oyentes = new Set();
  function avisar(col) {
    for (const o of oyentes) if (o.col === col) setTimeout(() => { if (oyentes.has(o)) o.fn(); }, 0);
  }
  function escuchar(col, fn) {
    const o = { col, fn };
    oyentes.add(o);
    setTimeout(() => { if (oyentes.has(o)) fn(); }, 0);     // primera entrega: lo que hay ahora
    return () => oyentes.delete(o);
  }
  // Otra pestaña cambió algo (o vació todo, y entonces no viene la clave).
  window.addEventListener('storage', e => {
    if (e.key === null) COLECCIONES.forEach(avisar);
    else if (e.key.indexOf(PREFIJO) === 0) avisar(e.key.slice(PREFIJO.length));
  });

  /* ---------- documentos y colecciones ---------- */
  const META = { fromCache: false, hasPendingWrites: false };
  const fotoDoc = (id, d) => ({ id, exists: !!d, data: () => d, metadata: META });
  function fotoCol(col, q) {
    const docs = leer(col);
    let lista = Object.keys(docs).sort().map(id => fotoDoc(id, docs[id]));
    if (q.orden) {
      const campo = q.orden[0], s = q.orden[1] === 'desc' ? -1 : 1;
      lista.sort((a, b) => { const x = a.data()[campo], y = b.data()[campo]; return (x < y ? -1 : x > y ? 1 : 0) * s; });
    }
    if (q.limite) lista = lista.slice(0, q.limite);
    return { docs: lista, size: lista.length, empty: !lista.length, metadata: META };
  }
  let cuenta = 0;
  const idNuevo = () => Date.now().toString(36) + (cuenta++).toString(36) + Math.random().toString(36).slice(2, 7);
  const idValido = id => /^[A-Za-z0-9_-]{1,80}$/.test(id);
  function documento(col, id) {
    return {
      id, path: col + '/' + id,
      async get() { return fotoDoc(id, leer(col)[id]); },
      // reemplaza el documento entero (o lo crea)
      async set(d) { const docs = leer(col); docs[id] = copiar(d); guardar(col, docs); avisar(col); conservar(d); },
      // cambia solo los campos que se pasan; el documento tiene que existir
      async update(d) {
        const docs = leer(col);
        if (!docs[id]) throw { code: 'invalid_argument', message: 'ese documento no existe' };
        docs[id] = Object.assign({}, docs[id], copiar(d));
        guardar(col, docs); avisar(col);
      },
      async delete() { const docs = leer(col); if (docs[id]) { delete docs[id]; guardar(col, docs); avisar(col); } },
      onSnapshot(fn) { return escuchar(col, () => fn(fotoDoc(id, leer(col)[id]))); },
    };
  }
  function coleccion(col, q) {
    return {
      path: col,
      doc: id => documento(col, id || idNuevo()),
      orderBy: (campo, dir) => coleccion(col, Object.assign({}, q, { orden: [campo, dir || 'asc'] })),
      limit: n => coleccion(col, Object.assign({}, q, { limite: n })),
      async get() { return fotoCol(col, q); },
      onSnapshot(fn) { return escuchar(col, () => fn(fotoCol(col, q))); },
    };
  }
  const db = {
    doc(ruta) { const p = ruta.split('/'); return documento(p[0], p[1]); },
    collection: col => coleccion(col, {}),
  };

  /* ---------- fotos de los tickets ---------- */
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
  const fotos = {
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
  // Hay navegadores que no dejan usar IndexedDB (por ejemplo en modo privado): ahí los gastos van sin foto.
  if (!sinFotos) { try { abrirBase().catch(() => { sinFotos = true; }); } catch (e) { sinFotos = true; } }

  /* ---------- copia de seguridad ---------- */
  const copia = {
    // Todo lo guardado, menos las fotos, en un objeto listo para descargar. Los datos de ejemplo no van,
    // salvo que sean lo único que hay.
    exportar() {
      let productos = leer('productos'), tickets = leer('tickets');
      const propio = d => !d.ejemplo, soloPropios = docs => Object.fromEntries(Object.entries(docs).filter(e => propio(e[1])));
      if (Object.values(productos).some(propio) || Object.values(tickets).some(propio)) { productos = soloPropios(productos); tickets = soloPropios(tickets); }
      return { libreta: 1, fecha: new Date().toISOString(), productos, tickets, ajustes: leer('ajustes') };
    },
    // Revisa que el archivo sea una copia de la libreta y dice qué trae, sin tocar nada.
    revisar(o) {
      if (!esObjeto(o) || o.libreta !== 1 || !esObjeto(o.productos) || !esObjeto(o.tickets)) return null;
      return { productos: Object.keys(o.productos).length, tickets: Object.keys(o.tickets).length };
    },
    /* Reemplaza lo guardado por el contenido de la copia; si no entra, deja todo como estaba. Las fotos no
       viajan en la copia: un ticket conserva la suya solo si sigue guardada en este navegador, y las que
       quedan sin ticket se borran. */
    async importar(o) {
      if (!copia.revisar(o)) throw new Error('no es una copia de la libreta');
      let conFoto = [];
      if (!sinFotos) { try { conFoto = await fotos.claves(); } catch (e) { conFoto = []; } }
      const productos = {}, tickets = {};
      for (const id in o.productos) {
        const p = o.productos[id];
        if (esObjeto(p)) productos[idValido(id) ? id : idNuevo()] = Object.assign({}, p, { nombre: String(p.nombre || 'Sin nombre'), log: Array.isArray(p.log) ? p.log.filter(Array.isArray) : [] });
      }
      for (const id in o.tickets) {
        const t = o.tickets[id];
        if (esObjeto(t)) tickets[idValido(id) ? id : idNuevo()] = Object.assign({}, t, { items: Array.isArray(t.items) ? t.items.filter(esObjeto) : [], foto: conFoto.includes(id) });
      }
      const antes = COLECCIONES.map(c => (persistente ? localStorage.getItem(PREFIJO + c) : memoria[c]));
      try { guardar('productos', productos); guardar('tickets', tickets); guardar('ajustes', esObjeto(o.ajustes) ? o.ajustes : {}); }
      catch (e) {
        COLECCIONES.forEach((c, i) => {
          try {
            if (!persistente) memoria[c] = antes[i];
            else if (antes[i] == null) localStorage.removeItem(PREFIJO + c);
            else localStorage.setItem(PREFIJO + c, antes[i]);
          } catch (e2) { /* no se pudo volver atrás esta parte */ }
        });
        throw e;
      }
      try { if (persistente) localStorage.setItem(PREFIJO + 'sembrado', '1'); } catch (e) { /* no cambia nada */ }
      COLECCIONES.forEach(avisar);
      for (const id of conFoto) if (!tickets[id]) fotos.borrar(id).catch(() => {});
    },
  };

  // La primera vez, con todo vacío, carga los datos de ejemplo.
  function sembrar() {
    try { if (persistente && localStorage.getItem(PREFIJO + 'sembrado')) return; } catch (e) { return; }
    if (COLECCIONES.some(c => Object.keys(leer(c)).length)) return;
    const docs = Ejemplos.crear(Nucleo.hoyISO()), porCol = { productos: {}, tickets: {} };
    for (const ruta in docs) { const p = ruta.split('/'); porCol[p[0]][p[1]] = docs[ruta]; }
    try {
      guardar('productos', porCol.productos); guardar('tickets', porCol.tickets);
      if (persistente) localStorage.setItem(PREFIJO + 'sembrado', '1');
    } catch (e) { /* sin lugar para los ejemplos: arranca vacía */ }
  }

  return {
    local: true,
    persistente,
    camaraEnVivo: true,
    get fotos() { return sinFotos ? null : fotos; },
    copia,
    respiro: 0,   // acá las escrituras son inmediatas: no hace falta esperar entre una y otra
    textos: {
      sinConexion: 'Este navegador no deja guardar datos.',
      donde: 'Los datos se guardan en este navegador y en este dispositivo: no se suben a ningún servidor ni se sincronizan con otros dispositivos. Si se borran los datos del navegador, se pierden: conviene guardar una copia cada tanto.',
      fallo: 'No se pudo guardar en este navegador.',
    },
    // Devuelve { db, permiso }: acá siempre se puede escribir.
    async conectar() { sembrar(); return { db, permiso: Promise.resolve(true) }; },
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
      consulta: 'De tus datos, lo único que sale de acá es el código de barras de un producto nuevo: se consulta en Open Food Facts, una base pública, para completar su nombre.',
    },
    async etiqueta() { return null; },
    async ticket() { return null; },
    nota: () => 'No se pudo leer la foto. Completá los datos a mano.',
    interno: { categoria },
  };
})();


/* La pantalla de la libreta: alacena, compras y gastos. Los datos los guarda `Datos` y las fotos las lee `Lector`. */
(() => {
  'use strict';
  const N = Nucleo;
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
    ajustes: { frecuencia: 7, presupuesto: 0 },
    filtro: { texto: '', chip: 'todo' },
    mes: null, marcados: new Set(),
    hoja: null, turno: 0, tostadaFn: null, borrandoEj: false,
    codigoPara: null,   // el producto que espera la foto de su código de barras, mientras se elige el archivo
  };
  let V = { prods: [], compras: [], tickets: [] };   // lo que se ve, calculado en cada pintada

  const hoyDia = () => N.diaDe(N.hoyISO());
  const pausa = ms => new Promise(r => setTimeout(r, ms));
  const limpio = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
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
     (lo borraron desde otra pestaña o dispositivo): la base lo rechaza igual que la falta de permiso. Si el rechazo
     no se explica así y la plataforma no dijo si esta persona puede escribir, la libreta pasa a solo lectura. */
  function textoFallo(e, existe) {
    switch (e && e.code) {
      case 'quota_exceeded': return 'La libreta llegó al límite de lo que puede guardar. Borrá tickets o productos viejos y probá de nuevo.';
      case 'resource_exhausted': return 'Demasiados cambios seguidos. Esperá unos segundos y probá de nuevo.';
      case 'invalid_argument':
        if (existe === false) return 'Ese dato ya no está: puede que lo hayan borrado desde otra pestaña o dispositivo.';
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
    const doc = {
      nombre: d.nombre, marca: d.marca || '', presentacion: d.presentacion || '',
      categoria: N.CATS_ALACENA.includes(d.categoria) ? d.categoria : 'otros', codigo: d.codigo || '',
      stock, aviso: Math.max(0, Math.round(+d.aviso || 0)), reponer: d.reponer !== false,
      precio: d.precio > 0 ? N.redondear2(d.precio) : null, precioFecha: d.precio > 0 ? (d.precioFecha || hoyI) : null, precioAnt: null,
      log: stock > 0 && dia > hd - 200 && dia <= hd + 1 ? [[dia, 0, stock]] : [], creado: new Date().toISOString(),
    };
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
      E.conexion = 'sin'; pintar();
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
      const d = s.data() || {};
      E.ajustes = { frecuencia: [7, 15, 30].includes(d.frecuencia) ? d.frecuencia : 7, presupuesto: +d.presupuesto > 0 ? +d.presupuesto : 0 };
      pintar();
    }, alFallar('ajustes', ajustes));
    productos(); tickets(); ajustes();
  }
  async function iniciar() {
    Lector.iniciar(() => { if (E.hoja && E.hoja.estado === 'espera') renderHoja(); });
    let c = null;
    try { c = await Datos.conectar(); } catch (e) { c = null; }
    if (!c || !c.db) { E.conexion = 'sin'; pintar(); return; }
    E.db = c.db;
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
    V = { prods, tickets, compras: N.listaCompras(prods, hoyDia(), E.ajustes.frecuencia) };
  }
  function render() {
    calcular();
    document.documentElement.classList.toggle('solo-lectura', E.lectura || E.conexion === 'sin');
    renderAvisos();
    for (const a of $$('.pestanas a')) { if (a.dataset.tab === E.tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    const globo = $('#globo-compras');
    globo.hidden = !V.compras.length;
    globo.textContent = V.compras.length;
    for (const t of ['alacena', 'compras', 'gastos']) $('#tab-' + t).hidden = t !== E.tab;
    if (E.tab === 'alacena') renderAlacena(); else if (E.tab === 'compras') renderCompras(); else renderGastos();
  }
  function renderAvisos() {
    const partes = [];
    if (E.conexion === 'sin') partes.push(h`<div class="aviso aviso-rojo"><p><strong>No hay conexión con los datos guardados.</strong> ${Datos.textos.sinConexion}</p></div>`);
    else if (E.lectura) partes.push(h`<div class="aviso"><p><strong>Solo lectura.</strong> Podés ver la libreta, pero no modificarla.</p></div>`);
    if (!Datos.persistente) partes.push(h`<div class="aviso aviso-rojo"><p><strong>Este navegador no deja guardar datos.</strong> Lo que cargues se pierde al cerrar la página.</p></div>`);
    if (hayEjemplos() && !hayReales()) {
      partes.push(h`<div class="aviso aviso-ejemplo"><p><strong>Datos de ejemplo</strong>, para ver cómo funciona. Se borran solos cuando cargues tu primer producto o ticket.</p>
        <button type="button" class="enlace" data-act="borrar-ejemplos" data-escribe${atr('disabled', E.borrandoEj)}>Borrar ahora</button></div>`);
    }
    $('#avisos').innerHTML = val(partes);
  }
  const cargando = texto => h`<p class="cargando"><span class="giro"></span>${texto}</p>`;

  function irA(tab) {
    if (!['alacena', 'compras', 'gastos'].includes(tab)) tab = 'alacena';
    const cambio = tab !== E.tab;
    E.tab = tab;
    try { history.replaceState(null, '', '#' + tab); } catch (e) { /* sin historial, no importa */ }
    render();
    if (cambio) window.scrollTo(0, 0);
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
    $('#al-chips').innerHTML = val(chips.map(([v, t]) => h`<button type="button" class="chip" data-act="chip" data-chip="${v}" aria-pressed="${String(E.filtro.chip === v)}">${t}</button>`));

    const caja = $('#al-lista');
    if (!filas.length) {
      caja.innerHTML = val(h`<div class="vacio">
        ${E.conexion === 'esperando' || (E.conexion === 'lista' && !E.prodListo) ? cargando('Cargando lo guardado…') : ''}
        <h3>Acá va tu alacena</h3>
        <p>Cada producto con cuánto queda y para cuántos días alcanza según lo que se consume en casa. Para cargar el primero, tocá <strong>Escanear producto</strong> y ${Datos.camaraEnVivo ? 'apuntá la cámara a su código de barras' : 'sacale una foto al envase o al código de barras'}.</p></div>`);
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
    if (!filas.some(f => (f.p.log || []).some(e => e[1] > 0))) grupos.push(h`<p class="tenue chico" data-escribe>Tocá <strong>−</strong> cada vez que se termine uno. Con eso la libreta aprende cuánto se consume y avisa antes de que falte.</p>`);
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
  function renderCompras() {
    const frec = E.ajustes.frecuencia, compras = V.compras;
    for (const b of $$('#co-frec button')) b.setAttribute('aria-pressed', String(+b.dataset.frec === frec));
    const enLista = new Set(compras.map(x => x.id));
    for (const id of [...E.marcados]) if (!enLista.has(id) && E.prodListo) E.marcados.delete(id);
    $('#co-resumen').textContent = compras.length ? `${compras.length} ${N.plural(compras.length, 'producto', 'productos')} para llegar a la próxima compra` : '';
    const caja = $('#co-lista');
    if (!compras.length) {
      caja.innerHTML = val(V.prods.length
        ? h`<div class="vacio"><h3>No hace falta comprar nada</h3><p>Con lo que hay en la alacena alcanza para los próximos ${frec} días. A medida que se vaya usando, acá aparece qué reponer y cuánto.</p></div>`
        : h`<div class="vacio">${E.conexion === 'esperando' ? cargando('Cargando lo guardado…') : ''}<h3>Acá aparece qué comprar</h3>
          <p>La lista se arma sola con lo que se terminó o está por terminarse, y sugiere cuánto llevar según el ritmo de consumo de la casa.</p></div>`);
      return;
    }
    let total = 0, sinPrecio = 0, marcados = 0;
    const filas = compras.map(x => {
      const p = x.p, m = E.marcados.has(x.id), meta = [p.marca, p.presentacion].filter(Boolean).join(' · ');
      if (x.costo == null) sinPrecio++; else total += x.costo;
      if (m) marcados++;
      return h`<label class="compra${m ? ' marcada' : ''}">
        <input type="checkbox" data-cambio="marcar" data-id="${x.id}"${atr('checked', m)}>
        <span class="compra-nombre">${p.nombre}${meta ? h` <span class="tenue">· ${meta}</span>` : ''}</span>
        <span class="compra-cant"><mark>×${x.a.cant}</mark></span>
        <span class="compra-razon">${N.razon(x.a)}</span>
        ${x.costo != null ? h`<span class="compra-costo">≈ ${N.plata(x.costo, true)}</span>` : ''}
      </label>`;
    });
    caja.innerHTML = val(h`<p class="tenue chico">Tildá lo que vayas poniendo en el changuito.</p>
      <div class="grupo">${filas}</div>
      <div class="pie-compras">
        <p class="estimado">${total > 0 ? h`<span>Estimado</span><strong>${N.plata(total, true)}</strong>` : ''}
          ${sinPrecio ? h`<span class="tenue">${total > 0 ? 'sin contar ' : ''}${sinPrecio} ${N.plural(sinPrecio, 'producto', 'productos')} sin precio cargado</span>` : ''}</p>
        <div class="acciones">
          <button type="button" class="btn" data-act="copiar-lista">${ico('copiar')}Copiar la lista</button>
          <button type="button" class="btn btn-principal" data-act="sumar-marcados" data-escribe${atr('disabled', !marcados)}>${ico('ok')}Ya lo compré${marcados ? ` (${marcados})` : ''}</button>
        </div>
      </div>`);
  }
  function textoLista() {
    const l = V.compras.map(x => `• ${x.a.cant} × ${N.textoProducto(x.p)}`);
    return `Lista de compras (${N.fechaCorta(N.hoyISO())})\n${l.join('\n')}`;
  }
  async function sumarMarcados() {
    if (!puede()) return;
    const hechos = V.compras.filter(x => E.marcados.has(x.id)).map(x => ({ id: x.id, c: x.a.cant }));
    if (!hechos.length) return;
    for (const x of hechos) await mover(x.id, { c: x.c }, null, true);
    E.marcados.clear(); guardarLocal('libreta.marcados', []);
    pintar();
    avisar(`${hechos.length} ${N.plural(hechos.length, 'producto sumado', 'productos sumados')} a la alacena`, {
      rotulo: 'Deshacer', fn: () => { for (const x of hechos) mover(x.id, { c: -x.c }); avisar('Deshecho'); },
    });
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
    el.innerHTML = val(VISTAS[H.tipo](H));
    if (arriba) { el.scrollTop = 0; el.focus({ preventScroll: true }); }
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
        else l.push(h`<span>Todavía no hay consumo anotado. Tocá − en la alacena cada vez que se termine uno.</span>`);
        if (p.precio > 0 && p.precioAnt > 0) l.push(h`<span>Precio anterior ${N.plata(p.precioAnt)}: <strong class="${p.precio > p.precioAnt ? 'rojo' : 'verde'}">${p.precio > p.precioAnt ? 'subió' : 'bajó'} ${N.num(Math.abs(p.precio / p.precioAnt - 1) * 100)} %</strong>.</span>`);
        dato = h`<div class="dato">${l}</div>`;
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
        <label class="casilla"><input type="checkbox" id="p-reponer" data-k="f.reponer"${atr('checked', f.reponer)}><span>Recomendar la compra cuando falte</span></label>
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
      const titulo = H.codigoPara ? 'Código de barras' : 'Escanear producto';
      if (H.estado === 'camara') {
        return marco(titulo, h`<div class="hoja-cuerpo">
          <div class="visor"><video id="visor-video" playsinline muted autoplay aria-label="Lo que ve la cámara"></video><div class="visor-guia" aria-hidden="true"></div></div>
          <p class="leyendo-paso" id="visor-estado" role="status"><span class="giro"></span><span>Abriendo la cámara…</span></p>
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
          ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
          <div class="hoja-pie"><button type="button" class="btn" data-act="no-es-este">No es este</button>
            <button type="submit" class="btn btn-principal">Sumar a la alacena</button></div></form>`);
      }
      const viva = camaraViva(), tactil = dedoGrueso();
      if (H.estado === 'hecho') {
        return marco(titulo, h`<div class="${H.fallo ? 'nota gris' : 'hecho'}">${H.fallo ? '' : ico('ok')}<p>${H.texto}</p></div>
          ${H.sinCodigo ? h`<div class="dato"><span>Para que la próxima vez alcance con el código de barras, ${viva ? 'escaneá' : 'sacale una foto a'} el código de este producto.</span>
            <button type="button" class="enlace" data-act="pedir-codigo">${!H.fallo ? 'Sumarle el código de barras' : viva ? 'Probar otra vez' : 'Probar con otra foto del código'}</button></div>` : ''}
          <div class="hoja-pie"><button type="button" class="btn" data-act="cerrar">Listo</button>
            <button type="button" class="btn btn-principal" data-act="${viva ? 'camara' : tactil ? 'foto-prod-cam' : 'foto-prod-gal'}">${ico('escanear')}Escanear otro</button></div>`);
      }
      // `viva`: se escanea con la cámara en directo · si no, con una foto (del celular o de un archivo)
      return marco(titulo, h`<div class="hoja-cuerpo">
        ${H.nota ? h`<p class="error" role="alert">${H.nota}</p>` : ''}
        ${Lector.etiquetas() ? h`<p><strong>Producto nuevo:</strong> foto del frente del envase, para leer el nombre, la marca y el tamaño.</p>
          <p><strong>Uno que ya cargaste:</strong> alcanza con la foto del código de barras, o del frente otra vez.</p>`
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
        <button type="button" class="enlace" data-act="producto-nuevo">Cargar a mano, sin foto</button></div>`);
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
          ${campo('Comercio', h`<input type="text" id="t-comercio" data-k="t.comercio" value="${t.comercio}" maxlength="60" autocomplete="off" placeholder="Supermercado">`)}
          ${campo('Fecha', h`<input type="date" id="t-fecha" data-k="t.fecha" value="${t.fecha}" max="${N.hoyISO()}">`)}
        </div>
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
          <div class="segmentos" role="group" aria-labelledby="aj-frec-r">${[7, 15, 30].map(d => h`<button type="button" data-act="aj-frecuencia" data-frec="${d}" aria-pressed="${String(H.frecuencia === d)}">${d} días</button>`)}</div>
          <small>La lista de compras sugiere lo necesario para llegar hasta la próxima compra.</small></div>
        ${campo('Presupuesto mensual', h`<input type="text" id="aj-presupuesto" data-k="presupuesto" value="${H.presupuesto}" inputmode="decimal" autocomplete="off" placeholder="Opcional">`, 'En Gastos se ve cuánto queda del presupuesto cada mes.')}
        ${H.error ? h`<p class="error" role="alert">${H.error}</p>` : ''}
        <div class="hoja-pie" data-escribe><button type="submit" class="btn btn-principal">Guardar</button></div>
        ${!Datos.copia ? h`<p class="tenue chico">${Datos.textos.donde}</p>` : h`<div class="dato"><span>${Datos.textos.donde}</span>${Lector.textos.consulta ? h`<span>${Lector.textos.consulta}</span>` : ''}
          ${H.errorCopia ? h`<p class="error" role="alert">${H.errorCopia}</p>` : ''}
          ${H.copia ? h`<p><strong>Restaurar reemplaza todo lo que hay ahora</strong> por lo de la copia: ${H.copia.n.productos} ${N.plural(H.copia.n.productos, 'producto', 'productos')} y ${H.copia.n.tickets} ${N.plural(H.copia.n.tickets, 'gasto', 'gastos')}. Las fotos de los tickets no van en la copia.</p>
            <div class="acciones"><button type="button" class="btn btn-chico" data-act="importar-no">Cancelar</button><button type="button" class="btn btn-chico btn-peligro" data-act="importar-si">Restaurar</button></div>`
            : h`<div class="acciones"><button type="button" class="btn btn-chico" data-act="exportar">Guardar una copia</button><button type="button" class="btn btn-chico" data-act="importar">Restaurar una copia</button></div>`}</div>`}
        ${hayEjemplos() ? h`<button type="button" class="enlace rojo" data-act="borrar-ejemplos" data-escribe>Borrar los datos de ejemplo</button>` : ''}
      </form>`);
    },

    copiar(H) {
      return marco('Lista de compras', h`<div class="hoja-cuerpo"><p class="tenue chico">No se pudo copiar sola. Mantené apretado el texto para seleccionarlo y copiarlo.</p>
        <textarea id="copiar-texto" readonly>${H.texto}</textarea></div>`);
    },
  };

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
  const formProducto = d => ({
    nombre: d.nombre || '', marca: d.marca || '', presentacion: d.presentacion || '', categoria: d.categoria || 'almacen', codigo: d.codigo || '',
    stock: String(d.stock == null ? 1 : d.stock), aviso: String(d.aviso || 0), reponer: d.reponer !== false, precio: d.precio > 0 ? N.campoPlata(d.precio) : '',
  });
  const conocido = (id, extra) => cambiarHoja({ estado: 'conocido', id, cant: '1', precio: '', error: '', codigoNuevo: '', leido: null, ...extra });

  // Una foto del producto: del código de barras o del frente del envase.
  async function fotoProducto(archivo, detalle) {
    if (!puede() || !Imagen.esImagen(archivo)) return;
    const url = URL.createObjectURL(archivo);
    abrirHoja({ tipo: 'escanear', estado: 'leyendo', paso: 'codigo', mini: url, urls: [url], ctl: new AbortController(), archivo });
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
      tipo: 'producto', id: null, f: formProducto(ok ? { ...leido, codigo: cod } : { codigo: cod }), aviso, deEscaneo: true,
      puedeDetalle: !!leido && !ok && !detalle && !!H.archivo && Lector.etiquetas(), sucio: true, error: '',
    });
  }
  async function sumarConocido() {
    const H = E.hoja;
    if (!H || H.ocupado || !puede()) return;
    const cant = entero(H.cant, 1, 1), txt = limpio(H.precio), precio = txt ? N.aNumero(txt) : 0;
    if (txt && !(precio > 0)) return errorHoja('El precio no se entiende. Escribilo así: 1.450,50', 'c-precio');
    ocupar(true);
    const ok = await mover(H.id, { c: cant }, precio > 0 ? { valor: precio } : null, true);
    if (E.hoja !== H) return;
    if (!ok) { ocupar(false); return; }
    const base = E.prod.get(H.id);
    if (base && !base.codigo && H.codigoNuevo && !porCodigo(H.codigoNuevo)) guardarCodigo(H.id, H.codigoNuevo);
    const p = verProd(H.id) || {};
    cambiarHoja({ estado: 'hecho', texto: `${p.nombre}: se ${N.plural(cant, 'sumó', 'sumaron')} ${cant}. Ahora hay ${p.stock}.`, ocupado: false, error: '', fallo: false, sinCodigo: false });
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
  let sinCamara = false;      // se pidió la cámara y el dispositivo no tiene
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
      case 'NotFoundError': case 'OverconstrainedError': return 'No se encontró una cámara en este dispositivo. Se puede seguir con una foto.';
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
    abrirHoja({ tipo: 'escanear', estado: 'camara', codigoPara: paraId || null, urls: [], ctl: new AbortController() });
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
    const stock = entero(f.stock, 0), hoyI = N.hoyISO();
    const datos = { nombre, marca: limpio(f.marca), presentacion: limpio(f.presentacion), categoria: N.CATS_ALACENA.includes(f.categoria) ? f.categoria : 'otros', codigo, aviso: entero(f.aviso, 0), reponer: !!f.reponer };
    if (H.id) {
      ocupar(true);
      const id = H.id;
      await volcar(id);
      const base = E.prod.get(id);
      if (!base) { cerrarHoja(); return; }
      const campos = { ...datos, act: new Date().toISOString() };
      if (stock !== (+base.stock || 0)) campos.stock = stock;
      if (precio > 0 && N.redondear2(precio) !== base.precio) { campos.precio = N.redondear2(precio); campos.precioFecha = hoyI; if (base.precio > 0) campos.precioAnt = base.precio; }
      if (!(precio > 0) && base.precio) { campos.precio = null; campos.precioFecha = null; campos.precioAnt = null; }
      try {
        await enCola(id, () => escribir(() => E.db.doc('productos/' + id).update(campos)));
        const a = E.prod.get(id);
        if (a) E.prod.set(id, { ...a, ...campos });
        if (E.hoja === H) cerrarHoja();
        avisar('Guardado'); pintar();
      } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e, E.prod.has(id))); else falloGuardar(e, E.prod.has(id)); }
      return;
    }
    if (!forzar) {
      const par = (codigo && porCodigo(codigo)) || N.buscarParecido(prodReales(), N.textoProducto(datos));
      if (par) { H.parecido = par; H.error = ''; renderHoja(); const el = $('#hoja .nota:last-of-type'); if (el) el.scrollIntoView({ block: 'nearest' }); return; }
    }
    ocupar(true);
    try {
      const idNuevo = await crearProducto({ ...datos, stock, precio });
      if (E.hoja !== H) { trasGuardarPropio(); pintar(); return; }
      if (H.deEscaneo) cambiarHoja({ tipo: 'escanear', estado: 'hecho', texto: `${nombre} quedó en la alacena${stock ? ` con ${stock}` : ''}.`, ocupado: false, error: '', sucio: false, fallo: false, idNuevo, sinCodigo: !codigo });
      else { cerrarHoja(); avisar(`${nombre} quedó en la alacena`); }
      trasGuardarPropio(); pintar();
    } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e)); else falloGuardar(e); }
  }
  async function sumarParecido() {
    const H = E.hoja;
    if (!H || !H.parecido || !puede()) return;
    const id = H.parecido, cant = Math.max(1, entero(H.f.stock, 1)), txt = limpio(H.f.precio), precio = txt ? N.aNumero(txt) : 0;
    ocupar(true);
    const ok = await mover(id, { c: cant }, precio > 0 ? { valor: precio } : null, true);
    if (E.hoja !== H) return;
    if (!ok) { ocupar(false); return; }
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
    else H.fotoNota = 'La foto de este ticket no está guardada en este navegador.';
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
    const doc = {
      comercio: limpio(t.comercio) || 'Compra', fecha: t.fecha, total: N.redondear2(total),
      items: items.map(it => ({ n: it.n, c: it.c, i: it.i, cat: it.cat })), cat: items.length ? null : (N.CATS[t.cat] ? t.cat : 'otros'),
      origen: H.origen || 'manual', creado: H.creado || new Date().toISOString(),
    };
    if (H.ejemplo) doc.ejemplo = true;
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
    let sumados = 0, fallidos = 0;
    if (!H.id && t.aAlacena) {
      const para = items.filter(it => it.dest && it.dest !== 'no' && it.i > 0), diaT = N.diaDe(t.fecha), creados = new Map();
      for (let k = 0; k < para.length; k++) {
        const it = para[k], unidad = N.redondear2(it.i / it.c);
        if (E.hoja === H) ocupar(true, `Sumando a la alacena: ${k + 1} de ${para.length}…`);
        try {
          let id = it.dest === 'nuevo' ? creados.get(N.norm(it.n)) : (E.prod.has(it.dest) ? it.dest : null);
          if (id) { (await mover(id, { c: it.c, dia: diaT }, { valor: unidad, fecha: t.fecha }, true)) ? sumados++ : fallidos++; }
          else if (it.dest === 'nuevo') {
            id = await crearProducto({ nombre: it.n, categoria: it.cat, stock: it.c, precio: unidad, precioFecha: t.fecha }, diaT);
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
    const nuevo = { frecuencia: H.frecuencia, presupuesto: N.redondear2(pres || 0) };
    ocupar(true);
    try {
      await (colaAjustes = colaAjustes.then(() => escribir(() => E.db.doc('ajustes/hogar').set(nuevo))));
      E.ajustes = nuevo;
      if (E.hoja === H) cerrarHoja();
      avisar('Ajustes guardados'); pintar();
    } catch (e) { if (E.hoja === H) errorHoja(textoFallo(e)); else falloGuardar(e); }
  }

  let colaAjustes = Promise.resolve();   // una escritura por vez sobre el documento de ajustes

  /* ---------- acciones ---------- */
  const elegir = id => { const el = document.getElementById(id); el.value = ''; el.click(); };
  const alVerCopia = () => { const el = $('#hoja .dato'); if (el) el.scrollIntoView({ block: 'nearest' }); };
  function cerrarConCuidado(porFuera) {
    const H = E.hoja;
    if (!H || H.ocupado) return;
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
      if (p) abrirHoja({ tipo: 'producto', id, f: formProducto(p) });
    },
    'producto-nuevo'() { if (puede()) abrirHoja({ tipo: 'producto', id: null, f: formProducto({}) }); },
    // En el celular, escanear abre directamente la cámara: en vivo si se puede, y si no la de sacar fotos.
    escanear() {
      if (!puede()) return;
      E.codigoPara = null;
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
      cambiarHoja({ tipo: 'producto', id: null, f: formProducto(l && l.legible ? { ...l, codigo: H.codigoNuevo || l.codigo } : { codigo: H.codigoNuevo || '' }), aviso: 'Completá o corregí los datos del producto.', deEscaneo: true, sucio: true, error: '' });
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
      const frecuencia = +el.dataset.frec, nuevo = { frecuencia, presupuesto: E.ajustes.presupuesto };
      E.ajustes = nuevo; render();
      colaAjustes = colaAjustes.then(() => escribir(() => E.db.doc('ajustes/hogar').set(nuevo))).catch(falloGuardar);
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
    'sumar-marcados'() { sumarMarcados(); },
    mes(el) { E.mes = el.dataset.mes; renderGastos(); const g = $$('#ga-cuerpo [data-act="mes"]').find(x => x.dataset.mes === E.mes); if (g) g.focus({ preventScroll: true }); },
    'mes-mover'(el) { E.mes = N.sumarMes(E.mes, +el.dataset.d); renderGastos(); const b = $(`#ga-cuerpo [data-act="mes-mover"][data-d="${el.dataset.d}"]`); if (b && !b.disabled) b.focus({ preventScroll: true }); },
    'subir-ticket'() {
      if (!puede()) return;
      abrirHoja({ tipo: 'ticket', estado: 'espera' });
      if ((Lector.tickets() || Datos.fotos) && dedoGrueso()) elegir('in-tic-cam');
    },
    'gasto-manual'() { if (puede()) abrirHoja({ tipo: 'ticket', estado: 'revisar', origen: 'manual', t: gastoVacio() }); },
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
    ajustes() { abrirHoja({ tipo: 'ajustes', frecuencia: E.ajustes.frecuencia, presupuesto: N.campoPlata(E.ajustes.presupuesto) }); },
    'aj-frecuencia'(el) { E.hoja.frecuencia = +el.dataset.frec; for (const b of $$('#hoja [data-act="aj-frecuencia"]')) b.setAttribute('aria-pressed', String(b === el)); },
    'borrar-ejemplos'() { if (!puede()) return; if (E.hoja) cerrarHoja(); borrarEjemplos('todo'); pintar(); },
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
      cola.clear(); E.marcados.clear(); guardarLocal('libreta.marcados', []);
      if (E.hoja === H) cerrarHoja();
      avisar('Copia restaurada');
    },
  };
  const FORMS = { producto: () => guardarProducto(false), conocido: sumarConocido, ticket: guardarTicket, ajustes: guardarAjustes };

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
    const k = el.dataset ? el.dataset.k : null;
    if (!k || !E.hoja) return;
    ponerEn(E.hoja, k, el.type === 'checkbox' ? el.checked : el.value);
    E.hoja.sucio = true;
    if (E.hoja.tipo === 'ticket') ticketVivo();
  });
  document.addEventListener('change', e => {
    const el = e.target;
    if (!el.dataset || el.dataset.cambio !== 'marcar') return;
    if (el.checked) E.marcados.add(el.dataset.id); else E.marcados.delete(el.dataset.id);
    guardarLocal('libreta.marcados', [...E.marcados]);
    renderCompras();
    const otra = $$('#co-lista [data-cambio="marcar"]').find(x => x.dataset.id === el.dataset.id);
    if (otra) otra.focus({ preventScroll: true });
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && E.hoja) { e.preventDefault(); cerrarConCuidado(false); return; }
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
  window.addEventListener('hashchange', () => { const t = location.hash.slice(1); if (t && t !== E.tab) irA(t); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) { pintar(); return; }
    const H = E.hoja;   // con la página oculta la cámara no queda abierta
    if (H && H.tipo === 'escanear' && H.estado === 'camara') sinVideo(H, H.codigoPara ? 'Se cerró la cámara antes de leer el código.' : '');
  });

  /* ---------- arranque ---------- */
  E.marcados = new Set(leerLocal('libreta.marcados', []).filter(x => typeof x === 'string'));
  const inicial = location.hash.slice(1);
  if (['compras', 'gastos'].includes(inicial)) E.tab = inicial;
  render();
  iniciar();
  if (camaraPosible() && !dedoGrueso() && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(ds => {
      if (ds.some(d => d.kind === 'videoinput')) return;
      camaraDudosa = true;
      if (E.hoja && E.hoja.tipo === 'escanear' && E.hoja.estado === 'espera') renderHoja();
    }, () => {});
  }
})();
