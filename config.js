/* Conexión con tu proyecto de Firebase.

   Reemplazá el bloque de abajo por el que te muestra Firebase al registrar la app web
   (en la consola: Configuración del proyecto → General → Tus apps → Configuración del SDK → Config).
   Tiene que quedar solo ese bloque: desde «const firebaseConfig = {» hasta «};», sin las líneas de
   «import» ni las de «initializeApp» que Firebase muestra arriba y abajo.

   Estos datos no son secretos: identifican al proyecto. Lo que protege la información son las reglas
   de firestore.rules, que tienen que estar publicadas en la consola de Firebase. */
const firebaseConfig = {
  apiKey: "AIzaSyAxNDm-_qaWcsNHCOxNWfifBB-pCdf01yQ",
  authDomain: "libreta-hogar.firebaseapp.com",
  projectId: "libreta-hogar",
  storageBucket: "libreta-hogar.firebasestorage.app",
  messagingSenderId: "903231243553",
  appId: "1:903231243553:web:9e6ae0a7aa3a2cb0556a60"
};

/* El mapa y la comunidad de la zona.

   Los comercios y el mapa salen de OpenStreetMap: son libres, no piden clave ni tarjeta. Con el mapa
   encendido, cada hogar ubica sus comercios y ve dónde otros hogares de la zona consiguieron más barato.
   Para apagarlo (los comercios se anotan a mano y no hay precios de la zona), poné false. */
const mapasLibres = true;

/* Precios oficiales de los supermercados (SEPA).

   Los prepara todos los días la tarea «Precios oficiales» de GitHub (el archivo .github/workflows/precios-oficiales.yml)
   y quedan en la rama «datos» del repositorio. Va la dirección de esa carpeta; vacío, no se usan. */
const preciosOficiales = "https://raw.githubusercontent.com/aleedoob-pixel/Alacena/datos/sepa/";

/* Inteligencia artificial (optativo): Gemini, de Google, a través de Firebase AI Logic.

   Lee fotos de carteles de promos y propone comidas con lo que hay en la alacena. Se activa en la consola de
   Firebase (AI Logic, con la «Gemini Developer API», sin costo) y pide App Check: la clave de sitio de
   reCAPTCHA (Fraud Defense) registrada en App Check va en «recaptcha». Vacía, la IA no aparece. */
const inteligencia = {
  recaptcha: "6Ld-Au0tAAAAADa5utL1m79uLn37vTZxeDSZ8iUJ",
  modelo: "gemini-3.5-flash",
  respaldo: "gemini-3.5-flash-lite"
};

/* Aportes voluntarios (optativo).

   Si ponés un link de pago de Mercado Pago o tu alias, Ajustes invita a apoyar la libreta con un aporte.
   Dentro de la app de Google Play no se muestra. Dejalos vacíos para no mostrar nada. */
const aportes = {
  mercadoPago: "https://link.mercadopago.com.ar/libretadelhogar",
  alias: ""
};

/* Quién responde por esta app (obligatorio para publicarla en Google Play).

   Lo muestra la página de privacidad (privacidad.html), que es la que hay que declarar en la tienda.
   «responsable» es tu nombre o el de tu empresa; «email», una casilla donde te puedan escribir. */
const contacto = {
  responsable: "Alejo",
  email: "alee.do.ob@gmail.com"
};
