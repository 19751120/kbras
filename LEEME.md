# Las Cabras (multijugador con servidor)

Archivos:
- `server.js`: el servidor. Guarda las partidas, lleva los temporizadores y aplica las reglas.
- `public/index.html`: la página del juego que abre cada jugador.
- `package.json`: le dice al hosting cómo arrancarlo (`npm start`).

## Subirlo gratis a Render

1. Crea una cuenta en github.com, pulsa "New repository", ponle de nombre `las-cabras` y créalo.
2. En el repositorio, pulsa "uploading an existing file" y arrastra TODO el contenido de esta carpeta
   (server.js, package.json, package-lock.json, .gitignore, LEEME.md y la carpeta public). Pulsa "Commit changes".
3. Crea una cuenta en render.com entrando con GitHub.
4. New > Web Service > elige el repositorio `las-cabras`.
5. Configura: Runtime `Node`, Build Command `npm install`, Start Command `npm start`, Instance Type `Free`.
6. Pulsa "Deploy". En 2-3 minutos te da un enlace tipo `https://las-cabras.onrender.com`.

Ese enlace es el que compartes. Uno crea la partida y los demás entran con el código o el enlace.

## A tener en cuenta (plan gratuito)
- Si nadie lo usa en 15 minutos, el servidor se duerme. La primera persona que entre después tardará
  alrededor de un minuto en ver la página. Abre el enlace un rato antes de jugar.
- Las partidas viven en memoria: si Render reinicia el servidor, la partida en curso se pierde.

## Probarlo en tu ordenador
Con Node.js instalado: `npm install` y luego `npm start`. Abre http://localhost:3000
