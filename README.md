# CHANCE — El Billetero de Todos
### Lotería Nacional de Panamá · PWA Instalable

---

## ¿Qué es este proyecto?

Una Progressive Web App (PWA) completa para la Lotería Nacional de Panamá con:
- 🛒 **Módulo Comprador** — buscar y comprar billetes/chances
- 🏪 **Módulo Vendedor** — gestión de inventario, sorteos y pedidos
- 🛵 **Módulo Repartidor** — entregas, batch routing, liquidación
- 👑 **Panel Admin** — gestión de usuarios, aprobaciones, configuración
- 🔐 **Autenticación completa** — registro multi-paso, sesión persistente

---

## ⚡ Instalación rápida (10 minutos)

### Paso 1 — Requisitos previos
```
Node.js v18 o superior → https://nodejs.org
```
Verifica: `node --version` (debe mostrar v18+)

---

### Paso 2 — Instalar dependencias
Abre una terminal en la carpeta `chance-pwa/` y ejecuta:
```bash
npm install
```
Esto instala React, Vite y el plugin PWA (~1-2 minutos).

---

### Paso 3 — Probar en tu computadora
```bash
npm run dev
```
Abre `http://localhost:5173` en tu navegador.

---

### Paso 4 — Construir para producción
```bash
npm run build
```
Genera la carpeta `dist/` lista para subir.

---

### Paso 5 — Subir a Netlify (GRATIS)

**Opción A — Arrastrar y soltar (más fácil):**
1. Ve a → https://app.netlify.com/drop
2. Arrastra la carpeta `dist/` al recuadro
3. Netlify genera una URL automáticamente (ej: `https://chance-lnb.netlify.app`)
4. ¡Listo!

**Opción B — Con cuenta Netlify (recomendado para actualizaciones):**
1. Crea cuenta en https://netlify.com
2. "New site" → "Import from Git" → conecta tu repositorio
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Deploy → Netlify auto-despliega en cada cambio

---

### Paso 6 — Instalar en tu Android 📱

1. Abre **Chrome** en tu Android
2. Visita la URL de tu app (ej: `https://chance-xyz.netlify.app`)
3. Espera que cargue completamente
4. Toca el menú (⋮ tres puntos) → **"Añadir a pantalla de inicio"**
5. Confirma → La app aparece en tu pantalla como ícono nativo

**O busca el banner automático** que Chrome muestra: "Instalar CHANCE"

---

### Paso 6 — Instalar en iPhone/iPad 🍎

1. Abre **Safari** (no Chrome) en tu iPhone
2. Visita la URL de tu app
3. Toca el ícono **Compartir** (cuadrado con flecha ↑)
4. Desliza hacia abajo → **"Añadir a pantalla de inicio"**
5. Confirma → Ícono en tu pantalla

---

## 👤 Usuarios de demostración

| Rol | Email | Contraseña |
|-----|-------|-----------|
| 👑 Admin | admin@chance.pa | Admin2024! |
| 🛒 Comprador | maria@demo.pa | Compra123 |
| 🏪 Vendedor | carlos@demo.pa | Vende123 |
| 🛵 Repartidor | juan@demo.pa | Reparte123 |

---

## 📁 Estructura del proyecto

```
chance-pwa/
├── src/
│   ├── App.jsx          ← App completa (5,900+ líneas)
│   └── main.jsx         ← Entry point + polyfill storage
├── public/
│   ├── logo192.png      ← Ícono app 192px (añadir manualmente)
│   └── logo512.png      ← Ícono app 512px (añadir manualmente)
├── index.html           ← HTML base con splash nativo
├── vite.config.js       ← Vite + PWA configuración
├── package.json         ← Dependencias
├── netlify.toml         ← Configuración Netlify (SPA routing)
└── .gitignore
```

---

## 🎨 Añadir íconos (opcional pero recomendado)

Para que la app tenga el logo oficial de CHANCE como ícono:

1. Usa el archivo `Logo_CHANCE_png.png` original
2. Redimensiona a **192×192 px** → guarda como `public/logo192.png`
3. Redimensiona a **512×512 px** → guarda como `public/logo512.png`
4. Herramienta gratuita: https://www.iloveimg.com/resize-image

---

## 🔧 Para versión APK nativa (opcional)

Si luego quieres un APK real de Android:

```bash
# 1. Instalar Capacitor
npm install @capacitor/core @capacitor/cli @capacitor/android

# 2. Inicializar
npx cap init "CHANCE LNB" "pa.lnb.chance"

# 3. Build y sync
npm run build
npx cap add android
npx cap sync

# 4. Abrir Android Studio
npx cap open android
# En Android Studio: Build → Generate Signed APK
```

Requiere **Android Studio** instalado: https://developer.android.com/studio

---

## 💾 Almacenamiento local

La app usa `localStorage` del navegador para:
- Usuarios registrados (`users_db`)
- Sesión activa (`active_session`)
- Plantillas del vendedor (`plantilla_V001_MIERCOLITO`, etc.)

Los datos persisten entre sesiones en el mismo dispositivo.

---

## 🆘 Soporte

Si encuentras problemas:
1. Verifica que Node.js ≥ 18: `node --version`
2. Borra caché: `rm -rf node_modules package-lock.json && npm install`
3. Limpia build: `rm -rf dist && npm run build`
