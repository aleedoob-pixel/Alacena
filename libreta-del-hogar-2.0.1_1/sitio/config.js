/* Conexión con tu proyecto de Firebase.

   Reemplazá el bloque de abajo por el que te muestra Firebase al registrar la app web
   (en la consola: Configuración del proyecto → General → Tus apps → Configuración del SDK → Config).
   Tiene que quedar solo ese bloque: desde «const firebaseConfig = {» hasta «};», sin las líneas de
   «import» ni las de «initializeApp» que Firebase muestra arriba y abajo.

   Estos datos no son secretos: identifican al proyecto. Lo que protege la información son las reglas
   de firestore.rules, que tienen que estar publicadas en la consola de Firebase. */
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: ""
};

/* Clave de Google Maps (opcional).

   Con ella, los comercios se eligen en Google Maps y se ven en el mapa los precios que comparten otros
   hogares de la zona. Sin ella, la libreta anda igual: los comercios se anotan a mano.
   Se crea en https://console.cloud.google.com (APIs y servicios → Credenciales), con «Maps JavaScript API»
   y «Places API (New)» habilitadas, y restringida a la dirección de tu sitio, como indica la guía.
   Va entre las comillas. */
const googleMapsKey = "";

/* Quién responde por esta app (obligatorio para publicarla en Google Play).

   Lo muestra la página de privacidad (privacidad.html), que es la que hay que declarar en la tienda.
   «responsable» es tu nombre o el de tu empresa; «email», una casilla donde te puedan escribir. */
const contacto = {
  responsable: "",
  email: ""
};
