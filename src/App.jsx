import { useState, useEffect, useRef } from "react";

// ═══════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN FIREBASE (Realtime Database)
// Para tracking en tiempo real de repartidores y pedidos
// ═══════════════════════════════════════════════════════════════════════
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyC4yrN4IBNFK10hAPf6inra7rOBinaVgdg",
  authDomain: "chanceloteria-2d356.firebaseapp.com",
  databaseURL: "https://chanceloteria-2d356-default-rtdb.firebaseio.com",
  projectId: "chanceloteria-2d356",
  storageBucket: "chanceloteria-2d356.firebasestorage.app",
  messagingSenderId: "232095792642",
  appId: "1:232095792642:web:7b8a9d1967f4401276b11b"
};

// Helper para construir URLs de la Realtime DB
const FB_DB_URL = FIREBASE_CONFIG.databaseURL;

// ─── API REST de Firebase Realtime DB (sin SDK, más liviano) ───
const fbWrite = async (path, data) => {
  try {
    const r = await fetch(`${FB_DB_URL}/${path}.json`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return r.ok;
  } catch (e) { console.warn("FB write error:", e.message); return false; }
};

const fbRead = async (path) => {
  try {
    const r = await fetch(`${FB_DB_URL}/${path}.json`);
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
};

const fbUpdate = async (path, data) => {
  try {
    const r = await fetch(`${FB_DB_URL}/${path}.json`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    return r.ok;
  } catch (e) { return false; }
};

/**
 * Quita las fotos en base64 antes de subir usuarios a Firebase.
 * Las fotos pueden ser ~300KB cada una y hacen el payload demasiado grande
 * para Firebase Realtime DB (timeout o límite). Solo viven en storage local.
 */
const stripUserPhotos = (users) => (users || []).map(u => {
  if (!u || typeof u !== "object") return u;
  const { photoIdData, photoBillData, photoLicData, ...rest } = u;
  return rest;
});

// ─── Listener en tiempo real (polling cada 3 segundos para piloto) ───
// Para producción se puede migrar a EventSource (SSE)
const fbListen = (path, callback, intervalMs = 3000) => {
  let active = true;
  let lastData = null;
  const poll = async () => {
    if (!active) return;
    const data = await fbRead(path);
    const dataStr = JSON.stringify(data);
    if (dataStr !== lastData) {
      lastData = dataStr;
      callback(data);
    }
    if (active) setTimeout(poll, intervalMs);
  };
  poll();
  return () => { active = false; };
};

// ─── Geolocalización del usuario ───
const obtenerUbicacion = () => {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Geolocalización no soportada"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        precision: pos.coords.accuracy
      }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );
  });
};

// ─── Calcular distancia entre 2 puntos (fórmula Haversine) en km ───
const calcularDistancia = (lat1, lng1, lat2, lng2) => {
  const R = 6371; // Radio de la Tierra en km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2) ** 2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
};

// ─── Calcular ETA en minutos ───
// Asume velocidad promedio 25 km/h en ciudad (motos delivery)
const calcularETA = (distKm, velocidadKmh = 25) => {
  return Math.max(1, Math.round((distKm / velocidadKmh) * 60));
};

// ─── Abrir Waze / Google Maps con la dirección del pedido ───
// Detecta el dispositivo y ofrece opciones de navegación
// Si se pasa `destinoCustom = {lat, lng, label}`, usa ese destino en lugar
// de la dirección de entrega del pedido (útil para fase de PICKUP del vendedor).
const abrirNavegacion = (order, destinoCustom = null) => {
  // Obtener coordenadas del destino (custom > delivery > fallback)
  const lat = destinoCustom?.lat ?? order?.deliveryAddress?.lat ?? order?.coordinates?.lat ?? 8.9824;
  const lng = destinoCustom?.lng ?? order?.deliveryAddress?.lng ?? order?.coordinates?.lng ?? -79.5199;
  const direccion = destinoCustom?.label || order?.deliveryAddress?.text || order?.deliveryAddress || "Cliente";

  // Detectar plataforma
  const ua = navigator.userAgent || '';
  const esIOS = /iPhone|iPad|iPod/i.test(ua);
  const esAndroid = /Android/i.test(ua);

  // Mostrar selector de app de navegación
  const opciones = [
    { nombre: "🚗 Waze", url: `https://waze.com/ul?ll=${lat},${lng}&navigate=yes` },
    { nombre: "🗺️ Google Maps", url: `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving` },
  ];
  if (esIOS) {
    opciones.push({ nombre: "🍎 Apple Maps", url: `https://maps.apple.com/?daddr=${lat},${lng}&dirflg=d` });
  }

  // Crear modal de selección
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;';

  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1A2C48;border-radius:16px;padding:20px;max-width:320px;width:100%;border:1px solid #2E4870;';

  const titulo = document.createElement('div');
  titulo.style.cssText = 'font-family:Bebas Neue,sans-serif;font-size:20px;color:#FFCC33;letter-spacing:2px;margin-bottom:6px;';
  titulo.textContent = 'CÓMO LLEGAR';
  modal.appendChild(titulo);

  const subtitulo = document.createElement('div');
  subtitulo.style.cssText = 'font-size:11px;color:#93ADCC;margin-bottom:14px;';
  subtitulo.textContent = `📍 ${direccion}`;
  modal.appendChild(subtitulo);

  opciones.forEach(op => {
    const btn = document.createElement('button');
    btn.style.cssText = 'display:block;width:100%;padding:12px;margin-bottom:8px;background:#243A58;border:1px solid #2E4870;border-radius:10px;color:#E8F0FA;font-size:14px;font-weight:700;cursor:pointer;font-family:DM Sans,sans-serif;text-align:left;';
    btn.textContent = op.nombre;
    btn.onclick = () => {
      window.open(op.url, '_blank');
      document.body.removeChild(overlay);
    };
    modal.appendChild(btn);
  });

  const cancel = document.createElement('button');
  cancel.style.cssText = 'display:block;width:100%;padding:10px;margin-top:6px;background:transparent;border:1px solid #2E4870;border-radius:10px;color:#93ADCC;font-size:12px;cursor:pointer;font-family:DM Sans,sans-serif;';
  cancel.textContent = 'Cancelar';
  cancel.onclick = () => document.body.removeChild(overlay);
  modal.appendChild(cancel);

  overlay.appendChild(modal);
  overlay.onclick = (e) => { if (e.target === overlay) document.body.removeChild(overlay); };
  document.body.appendChild(overlay);
};

// ═══════════════════════════════════════════════════════════════════════
// COMPONENTE: MapaLeaflet — mapa interactivo en tiempo real
// Props:
//   center: [lat, lng] — centro inicial
//   zoom: número (default 14)
//   markers: array de { lat, lng, type: 'comprador'|'vendedor'|'repartidor', label?, popup? }
//   route: array de [lat, lng] para dibujar ruta
//   height: altura del mapa (default 250)
// ═══════════════════════════════════════════════════════════════════════
function MapaLeaflet({ center = [8.9824, -79.5199], zoom = 14, markers = [], route = null, height = 250, draggablePinIndex = null, onPinMove = null, circles = [] }) {
  const mapRef = useRef(null);
  const containerRef = useRef(null);
  const markersRef = useRef([]);
  const routeRef = useRef(null);
  const circlesRef = useRef([]);

  // Iconos personalizados según tipo
  const getIcon = (type) => {
    if (!window.L) return null;
    const colors = {
      comprador: { emoji: "📍", color: "#FF5A78", size: 36 },
      vendedor:  { emoji: "🏪", color: "#00E5A0", size: 36 },
      repartidor:{ emoji: "🛵", color: "#FFCC33", size: 42 },
      casa:      { emoji: "🏠", color: "#4DB5FF", size: 36 },
    };
    const c = colors[type] || colors.comprador;
    const className = type === 'repartidor' ? 'moto-marker' : '';
    return window.L.divIcon({
      className: '',
      html: `<div class="${className}" style="font-size:${c.size}px;text-shadow:0 0 8px rgba(0,0,0,.8);text-align:center;line-height:1;">${c.emoji}</div>`,
      iconSize: [c.size, c.size],
      iconAnchor: [c.size/2, c.size]
    });
  };

  // Inicializar mapa una vez
  useEffect(() => {
    if (!window.L || !containerRef.current || mapRef.current) return;
    const map = window.L.map(containerRef.current, {
      center, zoom, zoomControl: true, attributionControl: true,
      scrollWheelZoom: false, // mejor en móvil
    });
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19,
    }).addTo(map);
    mapRef.current = map;

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  // Actualizar markers cuando cambian
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    // Limpiar markers anteriores
    markersRef.current.forEach(m => mapRef.current.removeLayer(m));
    markersRef.current = [];
    // Agregar nuevos
    markers.forEach((m, idx) => {
      const isDraggable = draggablePinIndex === idx;
      // Markers con flag hidden:true no muestran icono (transparente),
      // pero conservan el popup/tooltip al hacer click en el área.
      const iconToUse = m.hidden
        ? window.L.divIcon({ className: '', html: '<div></div>', iconSize: [1, 1] })
        : getIcon(m.type);
      const marker = window.L.marker([m.lat, m.lng], {
        icon: iconToUse,
        draggable: isDraggable,
        autoPan: true,
        interactive: !m.hidden,    // si es hidden, no interceptar clicks (deja pasar al círculo)
      }).addTo(mapRef.current);
      if (m.popup && !m.hidden) marker.bindPopup(m.popup);
      if (m.label && !m.hidden) marker.bindTooltip(m.label, { permanent: false, direction: 'top' });
      // Listener para cuando el usuario suelta el pin
      if (isDraggable && onPinMove) {
        marker.on('dragend', (e) => {
          const pos = e.target.getLatLng();
          onPinMove({ lat: pos.lat, lng: pos.lng });
        });
        // También permitir click en el mapa para mover el pin
        mapRef.current.on('click', (e) => {
          marker.setLatLng(e.latlng);
          onPinMove({ lat: e.latlng.lat, lng: e.latlng.lng });
        });
      }
      markersRef.current.push(marker);
    });
    // Auto-ajustar vista solo si no hay pin draggable (no recentrar mientras arrastra)
    if (draggablePinIndex === null) {
      // Combinar markers + centros de círculos para el bounds
      const allPoints = [
        ...markers.map(m => [m.lat, m.lng]),
        ...circles.map(c => [c.lat, c.lng]),
      ];
      if (allPoints.length > 1) {
        const bounds = window.L.latLngBounds(allPoints);
        mapRef.current.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
      } else if (allPoints.length === 1) {
        mapRef.current.setView(allPoints[0], zoom);
      }
    }
    return () => {
      // Limpiar listener click cuando cambian markers
      if (mapRef.current) mapRef.current.off('click');
    };
  }, [JSON.stringify(markers.map(m => [m.lat, m.lng, m.type])), draggablePinIndex]);

  // Dibujar ruta
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    if (routeRef.current) {
      mapRef.current.removeLayer(routeRef.current);
      routeRef.current = null;
    }
    if (route && route.length >= 2) {
      routeRef.current = window.L.polyline(route, {
        color: '#FFCC33', weight: 4, opacity: 0.8, dashArray: '10, 8'
      }).addTo(mapRef.current);
    }
  }, [route]);

  // Dibujar círculos de ubicación aproximada (privacidad estilo Uber Eats)
  // circles: array de { lat, lng, radius (metros), color, label }
  useEffect(() => {
    if (!mapRef.current || !window.L) return;
    // Limpiar círculos anteriores
    circlesRef.current.forEach(c => mapRef.current.removeLayer(c));
    circlesRef.current = [];
    circles.forEach(c => {
      const circle = window.L.circle([c.lat, c.lng], {
        radius: c.radius || 300,
        color: c.color || '#00E5A0',
        fillColor: c.color || '#00E5A0',
        fillOpacity: 0.15,
        weight: 2,
        dashArray: '6, 4',
      }).addTo(mapRef.current);
      if (c.label) circle.bindTooltip(c.label, { permanent: false, direction: 'top' });
      circlesRef.current.push(circle);
    });
  }, [JSON.stringify(circles.map(c => [c.lat, c.lng, c.radius, c.color]))]);

  return (
    <div ref={containerRef} style={{
      width: '100%', height: `${height}px`, borderRadius: 14,
      overflow: 'hidden', border: '1px solid var(--border)',
      background: '#1A2C48'
    }}>
      {!window.L && (
        <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100%', color:'var(--muted)', fontSize:12 }}>
          Cargando mapa...
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// HOOK: useTrackingUbicacion — envía ubicación del usuario cada vez que cambia
// Funciona para cualquier rol: vendedor, repartidor o comprador
// userId: identificador único del usuario (ej: "vendedor_carlos", "repartidor_juan")
// activo: si true, captura GPS y envía a Firebase
// ═══════════════════════════════════════════════════════════════════════
function useTrackingUbicacion(userId, activo) {
  useEffect(() => {
    if (!activo || !userId) return;
    if (!navigator.geolocation) {
      console.warn("Geolocalización no soportada");
      return;
    }

    let watchId = null;
    const enviarUbicacion = (pos) => {
      const data = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        timestamp: Date.now(),
        precision: pos.coords.accuracy,
        velocidad: pos.coords.speed ? Math.round(pos.coords.speed * 3.6) : 0,
        activo: true
      };
      fbWrite(`ubicaciones/${userId}`, data);
    };

    // Primera ubicación inmediata
    navigator.geolocation.getCurrentPosition(enviarUbicacion, (err) => {
      console.warn("GPS error:", err.message);
    }, { enableHighAccuracy: true, timeout: 10000 });

    // Watch continuo (alta precisión)
    watchId = navigator.geolocation.watchPosition(enviarUbicacion, (err) => {
      console.warn("GPS watch error:", err.message);
    }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 });

    // Marcar inactivo al desmontar
    return () => {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      fbUpdate(`ubicaciones/${userId}`, { activo: false });
    };
  }, [userId, activo]);
}

// Alias por compatibilidad
const useTrackingRepartidor = useTrackingUbicacion;

// ═══════════════════════════════════════════════════════════════════════
// HOOK: useUbicacionUsuario — escucha la ubicación de cualquier usuario
// Para uso del comprador, vendedor o repartidor
// ═══════════════════════════════════════════════════════════════════════
function useUbicacionUsuario(userId) {
  const [ubicacion, setUbicacion] = useState(null);
  useEffect(() => {
    if (!userId) return;
    const stop = fbListen(`ubicaciones/${userId}`, (data) => {
      if (data && data.lat && data.lng) {
        setUbicacion(data);
      }
    }, 3000); // poll cada 3s
    return stop;
  }, [userId]);
  return ubicacion;
}

// Alias por compatibilidad
const useUbicacionRepartidor = useUbicacionUsuario;

// ═══════════════════════════════════════════════════════════════════════
// COMPONENTE: RepartidorMapa — mapa para el repartidor con sus entregas
// Muestra:
//  - Su ubicación actual (GPS en vivo)
//  - Pins de cada cliente a entregar
//  - En fase pickup: vendedor + cliente + ruta planificada (su recorrido)
//  - En fase en-camino: solo cliente (ya recogió)
// ═══════════════════════════════════════════════════════════════════════
function RepartidorMapa({ orders = [], repartidorId = "repartidor_juan" }) {
  const ubicMia = useUbicacionRepartidor(repartidorId);
  // Por defecto centrado en Panamá ciudad
  const center = ubicMia ? [ubicMia.lat, ubicMia.lng] : [8.9824, -79.5199];

  const markers = [];
  // Lista de puntos para dibujar la ruta sugerida (mi posición → vendedor → cliente)
  const routePoints = [];

  // Mi ubicación
  if (ubicMia && ubicMia.activo) {
    markers.push({
      type: 'repartidor', lat: ubicMia.lat, lng: ubicMia.lng,
      label: 'Tú estás aquí', popup: `<b>🛵 Tu ubicación</b><br/>Velocidad: ${ubicMia.velocidad || 0} km/h`
    });
    routePoints.push([ubicMia.lat, ubicMia.lng]);
  }

  // Para CADA entrega activa, mostrar el recorrido visible:
  //   - APROBADO (pickup): mostrar VENDEDOR (recoger) + CLIENTE (entregar)
  //                        → el repartidor ve el recorrido completo planeado
  //   - EN_CAMINO (dropoff): mostrar SOLO CLIENTE (ya recogió, va a entregar)
  orders.forEach((o, i) => {
    // Coords del vendedor: prioridad GPS guardado en orden > coords static
    const vStatic = getVendorCoords(o.vendorId || "V001");
    const vLat = o.vendorLat || vStatic.lat;
    const vLng = o.vendorLng || vStatic.lng;
    const vName = vStatic.name;
    // Coords del cliente
    const cLat = o.deliveryAddress?.lat || o.coordinates?.lat || (8.9824 + (i * 0.005));
    const cLng = o.deliveryAddress?.lng || o.coordinates?.lng || (-79.5199 + (i * 0.005));

    if (o.status === "APROBADO") {
      // FASE PICKUP: mostrar AMBOS puntos (vendedor + cliente) + ruta
      markers.push({
        type: 'vendedor', lat: vLat, lng: vLng,
        label: `Recoger ${o.id}`,
        popup: `<b>🏪 ${vName}</b><br/>${vStatic.address}<br/><b>1️⃣ Recoger ${o.id}</b>`
      });
      markers.push({
        type: 'casa', lat: cLat, lng: cLng,
        label: `Entregar ${o.id}`,
        popup: `<b>📦 Entregar ${o.id}</b><br/>${o.deliveryAddress?.text || 'Cliente'}<br/><b>2️⃣ Destino final</b>`
      });
      // Ruta planeada: mi posición → vendedor → cliente
      routePoints.push([vLat, vLng]);
      routePoints.push([cLat, cLng]);
    } else {
      // FASE DROPOFF (EN_CAMINO): solo cliente (ya recogió del vendedor)
      markers.push({
        type: 'casa', lat: cLat, lng: cLng,
        label: o.id,
        popup: `<b>📦 ${o.id}</b><br/>${o.deliveryAddress?.text || 'Cliente'}<br/><b>$${o.lotteryValue || '0'}</b>`
      });
      routePoints.push([cLat, cLng]);
    }
  });

  // Solo dibujar ruta si hay al menos 2 puntos (origen + destino)
  const route = routePoints.length >= 2 ? routePoints : null;

  return (
    <div style={{position:"relative", marginBottom:12}}>
      <MapaLeaflet
        center={center}
        zoom={14}
        markers={markers}
        height={200}
      />
      <div style={{position:"absolute",top:8,left:8,background:"rgba(8,17,31,.92)",borderRadius:7,padding:"4px 9px",fontSize:9,color:"var(--green)",fontWeight:800,border:"1px solid rgba(0,214,143,.22)",zIndex:500,pointerEvents:'none'}}>
        {orders.length} ACTIVA{orders.length!==1?'S':''} {ubicMia?.activo && '· 📡 EN VIVO'}
      </div>
    </div>
  );
}

/* ── Logo CHANCE oficial ── */
const LOGO_CHANCE = "data:image/png;base64,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";

/* Componente Logo — usa el ícono PNG con fondo transparente */
function ChanceLogo({ height=48, style={} }) {
  return (
    <img
      src={LOGO_CHANCE}
      alt="CHANCE — El Billetero de Todos"
      style={{
        height,
        objectFit:"contain",
        filter:"drop-shadow(0 2px 8px rgba(255,204,51,.2))",
        ...style
      }}
    />
  );
}


/* ═══════════════════════════════════════════════════════
   DATOS REALES — LNB.GOB.PA  (extraídos 06 Apr 2026)
═══════════════════════════════════════════════════════ */
// ═══════════════════════════════════════════════════════════════════════
// CONFIGURACIÓN DEL AUTO-UPDATER
// El Worker "chance-updater" actualiza los sorteos automáticamente
// Dom/Mié/Vie 4-6 PM Panamá (hora de sorteos LNB)
// Si no está configurado, se usan los datos hardcoded como fallback
// ═══════════════════════════════════════════════════════════════════════
const UPDATER_URL = "https://chance-updater.edgarpino-d1e.workers.dev"; // ⚠️ AJUSTAR AL DESPLEGAR EL WORKER

// Datos seed (fallback si el Worker no responde)
// IMPORTANTE: estos son datos de respaldo. El Worker debería sobrescribirlos
// con los resultados reales más recientes desde suerteloteria.com / lnb.gob.pa
// ═══════════════════════════════════════════════════════════════════════
// SORTEOS RECIENTES — datos verificados manualmente desde LNB.gob.pa
// ═══════════════════════════════════════════════════════════════════════
// Fecha de actualización del seed: 5 de mayo de 2026
// Fuente primaria: https://www.lnb.gob.pa (sitio oficial)
// Fuentes secundarias confirmatorias:
//   - https://www.laestrella.com.pa  (publicación rápida, mismo día del sorteo)
//   - https://www.tvn-2.com           (transmisión oficial del sorteo)
//   - https://elcomercio.pe           (cobertura desde Perú, replica oficial)
//
// El Cloudflare Worker (chance-updater) debe scrapear lnb.gob.pa como
// fuente principal y caer en laestrella.com.pa como fallback. Los datos
// del seed se sustituyen automáticamente cuando el Worker responde.
// ═══════════════════════════════════════════════════════════════════════
const SORTEOS_RECIENTES_SEED = [
  {
    tipo: "MIERCOLITO", icon: "⚡", color: "#3B9EFF", bg: "rgba(59,158,255,.1)", border: "rgba(59,158,255,.28)",
    sorteoN: "3063", fecha: "6 de mayo de 2026",
    premios: [
      { pos: "1er Premio", num: "4757", letras: "BBCB", serie: "24", folio: "6" },
      { pos: "2do Premio", num: "6046", letras: "", serie: "", folio: "" },
      { pos: "3er Premio", num: "5808", letras: "", serie: "", folio: "" },
    ],
    premioMayor: "$100,000",
    proximoISO: "2026-05-13T15:00:00",
    frecuencia: "Cada miércoles",
    // datos confirmados desde nacionalloteria.com el 06/05/2026
  },
  {
    tipo: "EXTRAORDINARIA", icon: "💎", color: "#A78BFA", bg: "rgba(167,139,250,.1)", border: "rgba(167,139,250,.28)",
    sorteoN: "5548", fecha: "19 de abril de 2026",
    premios: [
      { pos: "1er Premio", num: "75212", letras: "", serie: "", folio: "" },
      { pos: "2do Premio", num: "47253", letras: "", serie: "", folio: "" },
      { pos: "3er Premio", num: "85747", letras: "", serie: "", folio: "" },
    ],
    premioMayor: "$1,000,000",
    proximoISO: null,
    frecuencia: "Fecha especial",
  },
  {
    tipo: "DOMINICAL", icon: "🌟", color: "#F4C430", bg: "rgba(244,196,48,.1)", border: "rgba(244,196,48,.28)",
    sorteoN: "5550", fecha: "3 de mayo de 2026",
    premios: [
      { pos: "1er Premio", num: "4924", letras: "DBAB", serie: "9", folio: "2" },
      { pos: "2do Premio", num: "1823", letras: "", serie: "", folio: "" },
      { pos: "3er Premio", num: "3400", letras: "", serie: "", folio: "" },
    ],
    premioMayor: "$100,000",
    proximoISO: "2026-05-10T15:00:00",
    frecuencia: "Cada domingo",
    // datos confirmados desde LNB.gob.pa el 05/05/2026
  },
  {
    tipo: "GORDITO", icon: "🍀", color: "#00D68F", bg: "rgba(0,214,143,.1)", border: "rgba(0,214,143,.28)",
    sorteoN: "408", fecha: "27 de marzo de 2026",
    premios: [
      { pos: "1er Premio", num: "4778", letras: "BCAA", serie: "9", folio: "5" },
      { pos: "2do Premio", num: "20", letras: "", serie: "", folio: "" },
      { pos: "3er Premio", num: "89", letras: "", serie: "", folio: "" },
    ],
    premioMayor: "$1,004,000",
    proximoISO: "2026-05-29T15:00:00",
    frecuencia: "Último viernes del mes",
    // datos confirmados desde LNB.gob.pa el 05/05/2026
  },
];

// Variable MUTABLE que usa el resto de la app
// Por defecto usa los datos seed, pero se actualiza con los datos del Worker al cargar
let SORTEOS_RECIENTES = [...SORTEOS_RECIENTES_SEED];

/**
 * Devuelve la fecha del PRÓXIMO sorteo basado en la fecha del último jugado.
 * Ejemplo: si el último Miercolito fue 6 de mayo, el próximo es 13 de mayo.
 * @param {object} sorteo - Item de SORTEOS_RECIENTES
 * @returns {string} fecha formateada en español "10 de mayo de 2026"
 */
function getProximaFecha(sorteo) {
  if (!sorteo) return "";
  // Si proximoISO existe, lo usamos como fuente de verdad
  if (sorteo.proximoISO) {
    const d = new Date(sorteo.proximoISO);
    if (!isNaN(d.getTime())) {
      const meses = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
      return `${d.getDate()} de ${meses[d.getMonth()]} de ${d.getFullYear()}`;
    }
  }
  // Si no, sumamos 7 días al último (DOMINICAL/MIERCOLITO) o usamos genérico
  return sorteo.fecha || "";
}

/**
 * Devuelve el número estimado del PRÓXIMO sorteo (último + 1).
 * @param {object} sorteo - Item de SORTEOS_RECIENTES
 * @returns {string} número del próximo sorteo
 */
function getProximoSorteoN(sorteo) {
  if (!sorteo?.sorteoN) return "";
  const n = parseInt(sorteo.sorteoN, 10);
  if (isNaN(n)) return sorteo.sorteoN;
  return String(n + 1);
}

/**
 * Devuelve el sorteo activo (PRÓXIMO sorteo) con datos actualizados.
 * El vendedor vende para el próximo sorteo, no para el último jugado.
 * @param {string} tipo - "MIERCOLITO" | "DOMINICAL" | "GORDITO" | "EXTRAORDINARIA"
 * @returns {object} sorteo activo con fecha del próximo
 */
function getSorteoActivo(tipo) {
  const ultimo = SORTEOS_RECIENTES.find(s => s.tipo === tipo);
  if (!ultimo) return null;
  return {
    ...ultimo,
    sorteoN: getProximoSorteoN(ultimo),  // próximo número
    fecha:   getProximaFecha(ultimo),     // próxima fecha
    fechaUltimo:   ultimo.fecha,           // referencia al último (para histórico)
    sorteoNUltimo: ultimo.sorteoN,         // número del último (para histórico)
    premiosUltimo: ultimo.premios,         // resultados del último (para Resultados)
    esProximo: true,                       // marca: este es el próximo, no el pasado
  };
}

/* Vendedores con inventario */
const VENDORS = [
  {
    id: 1, name: "Carlos Medina", rating: 4.9, reviews: 312,
    zone: "Calle 50 / San Francisco", distance: "1.2 km", time: "20–35 min",
    verified: true, sorteo: "DOM 12 ABR 2026",
    billetes: [
      { n: "3561", stock: 4, sold: 1 }, { n: "8364", stock: 4, sold: 4 },
      { n: "4778", stock: 4, sold: 2 }, { n: "0034", stock: 4, sold: 0 },
      { n: "7065", stock: 4, sold: 3 }, { n: "2408", stock: 4, sold: 4 },
      { n: "3657", stock: 4, sold: 1 }, { n: "3028", stock: 4, sold: 2 },
    ],
    chances: [
      { n: "07", stock: 50, sold: 20 }, { n: "14", stock: 50, sold: 50 },
      { n: "23", stock: 50, sold: 15 }, { n: "36", stock: 50, sold: 40 },
      { n: "51", stock: 50, sold: 0  }, { n: "68", stock: 50, sold: 48 },
      { n: "77", stock: 50, sold: 50 }, { n: "89", stock: 50, sold: 10 },
      { n: "92", stock: 50, sold: 25 }, { n: "99", stock: 50, sold: 30 },
    ],
  },
  {
    id: 2, name: "Rosa Jiménez", rating: 4.7, reviews: 188,
    zone: "El Cangrejo / Vía Argentina", distance: "2.4 km", time: "30–45 min",
    verified: true, sorteo: "DOM 12 ABR 2026",
    billetes: [
      { n: "0145", stock: 4, sold: 0 }, { n: "3561", stock: 4, sold: 2 },
      { n: "1990", stock: 4, sold: 4 }, { n: "7065", stock: 4, sold: 1 },
      { n: "3440", stock: 4, sold: 3 }, { n: "5120", stock: 4, sold: 4 },
    ],
    chances: [
      { n: "04", stock: 50, sold: 30 }, { n: "07", stock: 50, sold: 10 },
      { n: "28", stock: 50, sold: 50 }, { n: "35", stock: 50, sold: 20 },
      { n: "51", stock: 50, sold: 45 }, { n: "61", stock: 50, sold: 0  },
      { n: "75", stock: 50, sold: 25 }, { n: "88", stock: 50, sold: 50 },
    ],
  },
];

const ADDRESSES = [
  { id: 1, label: "Casa",   icon: "🏠", addr: "Calle 50, Torre del Pacífico, Apto 12B, San Francisco" },
  { id: 2, label: "Oficina",icon: "🏢", addr: "Vía España, Edif. Central Park, Piso 4" },
  { id: 3, label: "Mamá",   icon: "👩", addr: "Calle 74, El Cangrejo, Casa 7A" },
];

/* ═══════════════════════════════════════════════════════
   MOTOR DE PAGOS Y COMISIONES — CHANCE v1.0
   Precisión exacta con aritmética entera de centavos (×10000)
   Equivalente a big.js para el contexto del navegador/RN.

   Estructura de costos:
   ┌─────────────────────────────────────────────────────┐
   │  Comisión App   = 2.5% de lotteryValue → VENDEDOR  │
   │  Service Fee    = $1.00 fijo           → APP        │
   │  Delivery Fee   = 100%                 → REPARTIDOR │
   │  Propina        = 100%                 → REPARTIDOR │
   └─────────────────────────────────────────────────────┘
═══════════════════════════════════════════════════════ */

// Constantes en centavos×100 para evitar floats.
// IMPORTANTE: Son let (no const) para que puedan actualizarse desde el panel
// del admin. La función applyAdminCfg() las actualiza en runtime.
let PE = {
  COMMISSION_BP: 250,    // 2.50% = 250 basis points (paga el vendedor)
  SERVICE_FEE:   100,    // $1.00 × 100 (paga el cliente)
  SCALE:         100,    // multiplicador: $1.00 → 100
};

/** Convierte string "$X.XX" a entero de centavos */
const toCents = v => Math.round(parseFloat(v || 0) * PE.SCALE);

/** Convierte centavos a string "$X.XX" */
const fromCents = v => '$' + (Math.abs(v) / PE.SCALE).toFixed(2);

/** Formatea centavos como número decimal string (sin $) */
const centsToStr = v => (Math.abs(v) / PE.SCALE).toFixed(2);

/**
 * Calcula todos los montos de un pedido.
 * La comisión 2.5% es pagada por el VENDEDOR (se descuenta de su liquidación).
 *
 * @param {string} lotteryValue  Valor nominal del billete ej "2.00"
 * @param {string} deliveryFee   Costo de envío ej "2.50"
 * @param {string} tip           Propina opcional ej "0.50"
 * @returns {Object}  Todos los montos en centavos y como string formateado
 */
function calcOrderTotals(lotteryValue, deliveryFee, tip = '0') {
  const lottery  = toCents(lotteryValue);
  const delivery = toCents(deliveryFee);
  const tipAmt   = toCents(tip);

  // 2.5% lo paga el VENDEDOR → se descuenta de su liquidación
  const appCommission = Math.round(lottery * PE.COMMISSION_BP / 10000);
  const appServiceFee = PE.SERVICE_FEE;
  const appEarnings   = appCommission + appServiceFee;

  // Vendedor recibe valor nominal MENOS la comisión 2.5%
  const vendorReceives = lottery - appCommission;

  // Repartidor: 100% delivery + 100% propina (sin descuentos)
  const driverEarnings = delivery + tipAmt;

  // Cliente paga: lotería + service fee + delivery + propina
  const customerTotal = lottery + appServiceFee + delivery + tipAmt;

  return {
    // Centavos (para cálculos internos)
    _lottery:       lottery,
    _delivery:      delivery,
    _tip:           tipAmt,
    _appComm:       appCommission,
    _appSvc:        appServiceFee,
    _appTotal:      appEarnings,
    _vendor:        vendorReceives,
    _driver:        driverEarnings,
    _customerTotal: customerTotal,

    // Strings formateados (para UI)
    lotteryValue:   centsToStr(lottery),
    serviceFee:     centsToStr(appServiceFee),
    deliveryFee:    centsToStr(delivery),
    tip:            centsToStr(tipAmt),
    customerTotal:  centsToStr(customerTotal),
    appCommission:  centsToStr(appCommission),
    appEarnings:    centsToStr(appEarnings),
    driverEarnings: centsToStr(driverEarnings),
    vendorReceives: centsToStr(vendorReceives),
  };
}

/**
 * Flujo EFECTIVO:
 * Cliente → Repartidor: customerTotal
 * Repartidor → Vendedor: vendorReceives (ya descontada la comisión 2.5%)
 * Repartidor debe a App: serviceFee ($1.00) + comisión 2.5% del vendedor
 *   (ya que el Repartidor cobró el monto completo y retuvo la comisión que
 *    le correspondía al Vendedor pagar a la App)
 * Repartidor retiene: driverEarnings (delivery + tip)
 */
function calcCashFlow(t) {
  const collected     = t._customerTotal;
  const toVendor      = t._vendor;
  // Repartidor cobró el monto completo del cliente. Le entrega al Vendedor
  // su parte (lottery - 2.5%), pero la comisión 2.5% se la queda físicamente
  // y debe transferirla a la App al cierre del día. Por eso la deuda incluye
  // BOTH service fee ($1.00) Y la comisión 2.5%.
  const debtToApp     = t._appSvc + t._appComm;
  const driverRetains = t._driver;
  // Verificación: cobrado - al_vendedor - deuda_app = retención_repartidor
  const check = collected - toVendor - debtToApp;

  return {
    collectedFromCustomer: centsToStr(collected),
    paidToVendor:          centsToStr(toVendor),
    debtToApp:             centsToStr(debtToApp),
    debtServiceFee:        centsToStr(t._appSvc),
    debtCommission:        centsToStr(t._appComm),
    driverRetains:         centsToStr(driverRetains),
    balanced:              check === driverRetains,
    commissionNote:        `2.5% ($${centsToStr(t._appComm)}) cobrada al cliente, debes transferirla a la App`,
  };
}

/**
 * Flujo YAPPY:
 * Cliente paga vía Yappy a la App
 * App distribuye automáticamente a todos
 */
function calcYappyFlow(t) {
  return {
    receivedFromCustomer: centsToStr(t._customerTotal),
    creditedToVendor:     centsToStr(t._vendor),
    creditedToDriver:     centsToStr(t._driver),
    appRetains:           centsToStr(t._appTotal),
  };
}

/* ═══════════════════════════════════════════════════════
   TARIFAS DE DELIVERY POR DISTANCIA — CHANCE
   Best practices: Uber Eats / PedidosYa / DiDi Food adaptado a Panamá

   Tier  | Distancia    | Tarifa
   ──────┼──────────────┼─────────────────────────
   1     | 0 – 3 km     | $2.50 (tarifa mínima)
   2     | 3 – 6 km     | $3.50
   3     | 6 – 10 km    | $5.00
   4     | 10 – 15 km   | $7.00
   5     | 15 – 25 km   | $10.00
   6     | > 25 km      | $10.00 + $0.40/km extra
═══════════════════════════════════════════════════════ */
// Tarifas de delivery — let porque pueden ser actualizadas por el admin
let DELIVERY_TIERS = [
  { maxKm: 3,   fee: 2.50, label: "Zona local" },
  { maxKm: 6,   fee: 3.50, label: "Zona cercana" },
  { maxKm: 10,  fee: 5.00, label: "Zona media" },
  { maxKm: 15,  fee: 7.00, label: "Zona lejana" },
  { maxKm: 25,  fee: 10.00,label: "Zona extendida" },
];
let DELIVERY_EXTRA_PER_KM = 0.40; // $/km después de 25 km
const DELIVERY_EXTRA_BASE   = 10.00;
const DELIVERY_EXTRA_FROM   = 25;

/**
 * Aplica una configuración del admin al motor de cálculos del backend.
 * Cuando el admin guarda cambios en Comisiones/Delivery, esta función
 * actualiza las variables módulo para que `calcOrderTotals` y
 * `calcDeliveryFee` usen los nuevos valores en cálculos futuros.
 *
 * Nota: Pedidos ya creados conservan los valores con los que se calcularon.
 * Solo afecta cálculos NUEVOS (carritos, pedidos siguientes).
 */
function applyAdminCfg(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  // Comisión App
  if (typeof cfg.commissionPctVendor === "number" && cfg.commissionPctVendor >= 0) {
    PE.COMMISSION_BP = Math.round(cfg.commissionPctVendor * 100); // 2.5% → 250 bp
  }
  // Service fee
  if (typeof cfg.serviceFeeUSD === "number" && cfg.serviceFeeUSD >= 0) {
    PE.SERVICE_FEE = Math.round(cfg.serviceFeeUSD * 100); // $1.00 → 100
  }
  // Tarifas de delivery por distancia
  if (Array.isArray(cfg.deliveryTiers) && cfg.deliveryTiers.length > 0) {
    // Reusamos las labels originales si solo cambian montos
    DELIVERY_TIERS = cfg.deliveryTiers.map((t, i) => ({
      maxKm: t.maxKm,
      fee:   typeof t.fee === "number" ? t.fee : parseFloat(t.fee) || 0,
      label: t.label || (DELIVERY_TIERS[i] && DELIVERY_TIERS[i].label) || "Zona",
    }));
  }
  // Extra por km
  if (typeof cfg.deliveryExtraPerKm === "number" && cfg.deliveryExtraPerKm >= 0) {
    DELIVERY_EXTRA_PER_KM = cfg.deliveryExtraPerKm;
  }
}

/** Calcula la tarifa de delivery según distancia en km */
function calcDeliveryFee(distKm) {
  if (distKm == null || isNaN(distKm) || distKm < 0) return 2.50;
  for (const tier of DELIVERY_TIERS) {
    if (distKm <= tier.maxKm) {
      return { fee: tier.fee, label: tier.label, distKm: distKm.toFixed(1) };
    }
  }
  // Más de 25 km: base + extra por km
  const extraKm = distKm - DELIVERY_EXTRA_FROM;
  const fee = DELIVERY_EXTRA_BASE + (extraKm * DELIVERY_EXTRA_PER_KM);
  return { fee: Math.round(fee * 100) / 100, label: "Zona muy lejana", distKm: distKm.toFixed(1) };
}

/* ═══════════════════════════════════════════════════════
   COORDENADAS DE VENDEDORES — base para cálculo de distancia
   y datos de contacto para la fase de PICKUP del repartidor.
   En producción se leen desde Firebase /ubicaciones/{vendorUserId}
   y desde el perfil del vendedor.
═══════════════════════════════════════════════════════ */
const VENDOR_COORDS = {
  "V001": { lat: 8.9824, lng: -79.5199, zone: "Calle 50 / San Francisco",     name: "Carlos Medina", phone: "6111-2233", address: "Calle 50, esquina con Vía España, local 12" },
  "V002": { lat: 8.9892, lng: -79.5320, zone: "El Cangrejo / Vía Argentina",  name: "Rosa Jiménez",  phone: "6444-5566", address: "Vía Argentina 45, esquina con Av. 2A Norte" },
};
function getVendorCoords(vendorId) {
  return VENDOR_COORDS[vendorId] || VENDOR_COORDS["V001"];
}

/* ═══════════════════════════════════════════════════════
   ESTILOS
═══════════════════════════════════════════════════════ */
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&display=swap');
*{box-sizing:border-box;margin:0;padding:0}
:root{
  /* Fondo base — azul oscuro real */
  --bg:#08101E;
  /* Cards — significativamente más claras para contrastar */
  --bg2:#1A2C48;
  --bg3:#243A58;
  --bg4:#2E4870;

  /* Acento dorado brillante */
  --gold:#FFCC33;
  --gold2:#D4A218;

  /* Colores semánticos vibrantes */
  --green:#00E5A0;
  --red:#FF5A78;
  --blue:#4DB5FF;
  --purple:#C4A8FF;
  --orange:#FF8C55;

  /* TEXTO: blanco puro para máximo contraste */
  --text:#FFFFFF;
  /* TEXTO SECUNDARIO: gris claro legible, no azul oscuro */
  --muted:#B8CEDE;
  /* BORDES: visibles pero no agresivos */
  --border:#2E4870;
}

body{background:var(--bg);font-family:'DM Sans',sans-serif;color:var(--text)}

/* Shell con gradiente más suave para destacar el phone */
.shell{
  min-height:100vh;
  display:flex;flex-direction:column;align-items:center;
  background:linear-gradient(135deg,#08101E 0%,#0D1829 50%,#08101E 100%);
  padding:14px 0 28px
}

/* Phone mockup — borde luminoso */
.phone{
  width:393px;height:852px;
  background:var(--bg);
  border-radius:52px;overflow:hidden;
  display:flex;flex-direction:column;
  box-shadow:
    0 60px 140px rgba(0,0,0,.7),
    0 0 0 1.5px var(--bg3),
    0 0 60px rgba(245,200,66,.08),
    inset 0 1px 0 rgba(255,255,255,.05);
  flex-shrink:0
}

.sbar{padding:14px 28px 8px;display:flex;justify-content:space-between;align-items:center;font-size:11px;font-weight:700;color:var(--text);flex-shrink:0}
.scr{flex:1;overflow-y:auto;overflow-x:hidden;scrollbar-width:none}
.scr::-webkit-scrollbar{display:none}

/* Bottom nav — más contraste */
.bnav{
  background:var(--bg2);
  border-top:1.5px solid var(--border);
  padding:10px 0 18px;
  display:flex;justify-content:space-around;flex-shrink:0
}
.nb{display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;padding:4px 10px;border-radius:14px;transition:all .2s;font-size:10px;color:var(--muted);font-weight:600;border:none;background:none}
.nb.on{color:var(--gold)}

.sc{padding:14px 16px}

/* Cards — fondo más claro para contrastar con el bg */
.card{
  background:var(--bg2);
  border-radius:18px;padding:14px;
  border:1px solid var(--border);
  margin-bottom:10px
}
.card-g{background:linear-gradient(135deg,rgba(245,200,66,.12),rgba(245,200,66,.04));border:1px solid rgba(245,200,66,.25);border-radius:18px;padding:14px;margin-bottom:10px}

/* Labels de sección — color más legible */
.sec{font-size:10px;font-weight:800;color:var(--muted);letter-spacing:1.5px;text-transform:uppercase;margin-bottom:8px;margin-top:2px}

/* Botones */
.btn{background:linear-gradient(135deg,var(--gold),var(--gold2));color:#080F1E;border:none;border-radius:14px;padding:13px 18px;font-family:'DM Sans';font-weight:800;font-size:14px;cursor:pointer;width:100%;transition:all .18s;box-shadow:0 4px 20px rgba(245,200,66,.28)}
.btn:active{transform:scale(.98)}
.btn-sm{background:linear-gradient(135deg,var(--gold),var(--gold2));color:#080F1E;border:none;border-radius:11px;padding:9px 14px;font-family:'DM Sans';font-weight:800;font-size:12px;cursor:pointer;transition:all .18s}
.btng{background:rgba(245,200,66,.08);color:var(--gold);border:1.5px solid rgba(245,200,66,.4);border-radius:14px;padding:12px 18px;font-family:'DM Sans';font-weight:700;font-size:14px;cursor:pointer;width:100%;transition:all .18s}
.btng:hover{background:rgba(245,200,66,.14)}

/* Badges */
.badge{display:inline-flex;align-items:center;gap:3px;padding:3px 8px;border-radius:16px;font-size:9px;font-weight:800;letter-spacing:.7px;text-transform:uppercase}
.bg{background:rgba(5,224,163,.14);color:var(--green);border:1px solid rgba(5,224,163,.3)}
.by{background:rgba(245,200,66,.14);color:var(--gold);border:1px solid rgba(245,200,66,.3)}
.br{background:rgba(255,90,120,.14);color:var(--red);border:1px solid rgba(255,90,120,.3)}
.bb{background:rgba(75,168,255,.14);color:var(--blue);border:1px solid rgba(75,168,255,.3)}

.div{height:1px;background:var(--border);margin:10px 0}

/* Inputs */
.inp{
  background:var(--bg3);
  border:1.5px solid var(--border);
  border-radius:12px;padding:11px 14px;
  color:var(--text);font-family:'DM Sans';font-size:14px;
  width:100%;outline:none;transition:border .2s
}
.inp:focus{border-color:var(--gold);background:var(--bg4)}
.inp::placeholder{color:var(--muted)}

/* Chips */
.chip{
  display:inline-flex;align-items:center;gap:4px;
  background:var(--bg3);border:1px solid var(--border);
  border-radius:16px;padding:5px 12px;font-size:11px;
  color:var(--muted);font-weight:600;cursor:pointer;
  transition:all .2s;white-space:nowrap;font-family:'DM Sans'
}
.chip.on{background:rgba(245,200,66,.14);border-color:rgba(245,200,66,.45);color:var(--gold)}
.chip:hover:not(.on){border-color:var(--muted);color:var(--text)}

.row{display:flex;align-items:center;gap:10px}
.col{display:flex;flex-direction:column}

/* Notification dots */
.ndot{width:8px;height:8px;background:var(--red);border-radius:50%;position:absolute;top:-2px;right:-2px;border:2px solid var(--bg)}
.cbadge{position:absolute;top:-4px;right:-4px;background:var(--red);color:#fff;border-radius:50%;width:16px;height:16px;font-size:9px;font-weight:800;display:flex;align-items:center;justify-content:center;border:2px solid var(--bg)}

/* Tablero */
.board{
  background:linear-gradient(145deg,var(--bg3),var(--bg2));
  border-radius:20px;padding:14px;
  border:1px solid rgba(245,200,66,.2);
  position:relative;overflow:hidden;margin-bottom:10px
}
.nc{border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;border:none;padding:7px 2px;position:relative}
.nc.av{background:rgba(245,200,66,.1);border:1.5px solid rgba(245,200,66,.35)}
.nc.av:hover{background:rgba(245,200,66,.18);transform:scale(1.05)}
.nc.so{background:rgba(147,173,204,.05);border:1.5px solid rgba(147,173,204,.1);opacity:.35;cursor:default}
.nc.sel{background:rgba(245,200,66,.22);border:2px solid var(--gold);box-shadow:0 0 16px rgba(245,200,66,.28);transform:scale(1.05)}
.nc.ca{background:rgba(75,168,255,.1);border:1.5px solid rgba(75,168,255,.35)}
.nc.ca:hover{background:rgba(75,168,255,.18);transform:scale(1.05)}

/* Inputs numéricos sin flechas */
input[type=number]::-webkit-inner-spin-button,
input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;margin:0}
input[type=number]{-moz-appearance:textfield}

/* Stepper */
.stp{display:flex;align-items:center;background:var(--bg3);border-radius:10px;overflow:hidden;border:1px solid var(--border)}
.sb{width:36px;height:36px;display:flex;align-items:center;justify-content:center;cursor:pointer;border:none;background:transparent;color:var(--text);font-size:18px;font-weight:700;transition:all .15s;font-family:'DM Sans'}
.sb:hover:not(:disabled){background:rgba(245,200,66,.12);color:var(--gold)}
.sb:disabled{opacity:.25;cursor:default}
.sv{min-width:38px;text-align:center;font-weight:800;font-size:15px;color:var(--text)}

/* Sheet / overlay */
.overlay{position:absolute;inset:0;background:rgba(8,14,28,.8);backdrop-filter:blur(6px);z-index:20;display:flex;align-items:flex-end}
.sheet{background:var(--bg2);border-radius:24px 24px 0 0;width:100%;padding:18px 16px 28px;border-top:1px solid var(--border);max-height:82%;overflow-y:auto}
.sheet::-webkit-scrollbar{display:none}

/* Mapa */
.mapbox{background:linear-gradient(135deg,#0D1F3A,#152038);border-radius:16px;height:140px;border:1px solid var(--border);position:relative;overflow:hidden;margin-bottom:10px}
.mgrid{position:absolute;inset:0;opacity:.15;background-image:linear-gradient(rgba(75,168,255,.3) 1px,transparent 1px),linear-gradient(90deg,rgba(75,168,255,.3) 1px,transparent 1px);background-size:22px 22px}

/* Timeline */
.tld{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.tld.done{background:rgba(5,224,163,.16);border:2px solid var(--green)}
.tld.act{background:rgba(245,200,66,.16);border:2px solid var(--gold);animation:pulse 1.6s infinite}
.tld.pend{background:rgba(38,56,87,.6);border:2px solid var(--border)}

@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(245,200,66,.4)}50%{box-shadow:0 0 0 8px rgba(245,200,66,0)}}

/* Scanner */
.scanframe{width:180px;height:110px;border:3px solid var(--gold);border-radius:12px;margin:14px auto;position:relative;box-shadow:0 0 32px rgba(245,200,66,.2)}
.scanline{position:absolute;left:0;right:0;top:0;height:2px;background:linear-gradient(90deg,transparent,var(--gold),transparent);animation:scan 2s linear infinite}
@keyframes scan{0%{top:0}100%{top:100%}}

/* Tabs */
.tabs{display:flex;border-bottom:1.5px solid var(--border);margin-bottom:12px}
.tab{padding:9px 12px;font-size:12px;font-weight:700;color:var(--muted);cursor:pointer;border:none;background:none;border-bottom:2.5px solid transparent;margin-bottom:-1.5px;transition:all .2s;font-family:'DM Sans'}
.tab.on{color:var(--gold);border-bottom-color:var(--gold)}

/* Animaciones */
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.fu{animation:fadeUp .28s ease both}
@keyframes pop{0%{transform:scale(.88);opacity:0}100%{transform:scale(1);opacity:1}}
.pop{animation:pop .3s cubic-bezier(.34,1.56,.64,1) both}

/* Select options */
select option{background:#1A2C48;color:#FFFFFF} select{color:#FFFFFF}

/* Sorteo card */
.sort-card{border-radius:18px;padding:14px;border:1px solid;margin-bottom:10px;position:relative;overflow:hidden}

/* Tags */
.tag-b{background:rgba(245,200,66,.12);border:1.5px solid rgba(245,200,66,.35);border-radius:7px;padding:2px 7px;font-size:9px;font-weight:800;color:var(--gold);letter-spacing:.4px}
.tag-c{background:rgba(75,168,255,.12);border:1.5px solid rgba(75,168,255,.35);border-radius:7px;padding:2px 7px;font-size:9px;font-weight:800;color:var(--blue);letter-spacing:.4px}

/* Toggle */
.tog{width:42px;height:22px;border-radius:11px;position:relative;cursor:pointer;border:none;flex-shrink:0}
.tgt{width:16px;height:16px;border-radius:50%;background:#fff;position:absolute;top:3px;transition:left .2s}

/* Wallet */
.wallet{
  background:linear-gradient(135deg,var(--bg4),var(--bg3));
  border-radius:20px;padding:20px;
  border:1px solid rgba(245,200,66,.2);
  position:relative;overflow:hidden;margin-bottom:12px
}
.wallet::after{content:'$';position:absolute;right:-6px;top:-18px;font-family:'Bebas Neue';font-size:120px;color:rgba(245,200,66,.05);line-height:1}

/* Stats */
.stat{
  background:var(--bg3);
  border-radius:14px;padding:12px;
  border:1px solid var(--border)
}
.sval{font-family:'Bebas Neue';font-size:26px;color:var(--gold);line-height:1;letter-spacing:1px}
.slbl{font-size:9px;color:var(--muted);margin-top:3px;font-weight:700;text-transform:uppercase;letter-spacing:.4px}

/* Fracciones */
.frac-cell{flex:1;padding:8px 4px;border-radius:9px;text-align:center;transition:all .15s}

/* Modal */
.modal-bg{position:absolute;inset:0;background:rgba(5,10,22,.85);backdrop-filter:blur(8px);z-index:30;display:flex;align-items:center;justify-content:center;padding:20px}
.modal{background:var(--bg2);border-radius:22px;width:100%;padding:20px;border:1px solid var(--border);max-height:85%;overflow-y:auto}
.modal::-webkit-scrollbar{display:none}
`;

/* ═══ ICONOS ═══════════════════════════════════════════ */
const Ic = ({ n, s = 20, c = "currentColor", sw = 2 }) => {
  const d = {
    home:<><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
    search:<><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></>,
    cart:<><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></>,
    trophy:<><polyline points="8 21 12 17 16 21"/><line x1="12" y1="17" x2="12" y2="11"/><path d="M7 4v3a5 5 0 0 0 10 0V4"/><line x1="5" y1="4" x2="19" y2="4"/></>,
    user:<><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></>,
    bell:<><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>,
    scan:<><polyline points="4 7 4 4 7 4"/><polyline points="20 7 20 4 17 4"/><polyline points="4 17 4 20 7 20"/><polyline points="20 17 20 20 17 20"/><line x1="4" y1="12" x2="20" y2="12"/></>,
    history:<><path d="M12 8v4l3 3"/><path d="M3.05 11a9 9 0 1 0 .5-4"/><polyline points="3 3 3 7 7 7"/></>,
    truck:<><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></>,
    pkg:<><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></>,
    wallet:<><path d="M20 12V22H4V12"/><path d="M22 7H2v5h20V7z"/><path d="M12 22V7"/></>,
    map:<><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></>,
    check:<polyline points="20 6 9 17 4 12"/>,
    plus:<><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></>,
    trash:<><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></>,
    chevR:<polyline points="9 18 15 12 9 6"/>,
    chevL:<polyline points="15 18 9 12 15 6"/>,
    info:<><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></>,
    shield:<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>,
    zap:<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>,
    edit:<><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
    sliders:<><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></>,
    close:<><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    phone:<><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.6 19.79 19.79 0 0 1 1.61 5a2 2 0 0 1 1.98-2.18h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 10.4a16 16 0 0 0 6 6l.9-1.81a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></>,
    pin:<><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></>,
    star:<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>,
    refresh:<><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></>,
    grid:<><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></>,
    sparkle:<><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></>,
  };
  return <svg width={s} height={s} fill="none" stroke={c} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">{d[n]}</svg>;
};

/* ═══ STEPPER editable ═════════════════════════════════ */
function Stepper({ value, min=0, max=9999, step=1, onChange, size="md" }) {
  const big = size === "lg";
  const [raw, setRaw] = useState(String(value));

  // sync when value changes externally
  useEffect(() => { setRaw(String(value)); }, [value]);

  const commit = (str) => {
    const n = parseInt(str, 10);
    if (!isNaN(n)) {
      const clamped = Math.max(min, Math.min(max, n));
      // round to nearest step
      const stepped = step > 1 ? Math.round(clamped / step) * step : clamped;
      onChange(Math.max(min, Math.min(max, stepped)));
      setRaw(String(Math.max(min, Math.min(max, stepped))));
    } else {
      setRaw(String(value));
    }
  };

  return (
    <div className="stp" style={{ height: big?44:36 }}>
      <button className="sb" disabled={value<=min}
        onClick={()=>onChange(Math.max(min, value-step))}
        style={{width:big?44:36,fontSize:big?22:18}}>−</button>
      <input
        type="number"
        value={raw}
        onChange={e=>setRaw(e.target.value)}
        onBlur={()=>commit(raw)}
        onKeyDown={e=>e.key==="Enter"&&commit(raw)}
        style={{
          width:big?52:42, textAlign:"center", fontWeight:800,
          fontSize:big?17:14, color:"var(--text)", background:"transparent",
          border:"none", outline:"none", fontFamily:"'DM Sans'",
          padding:"0 2px",
          /* hide spin arrows */
          MozAppearance:"textfield",
        }}
      />
      <button className="sb" disabled={value>=max}
        onClick={()=>onChange(Math.min(max, value+step))}
        style={{width:big?44:36,fontSize:big?22:18}}>+</button>
    </div>
  );
}

/* ═══ COUNTDOWN helper ═════════════════════════════════ */
function useCountdown(isoDateStr) {
  const calcLeft = () => {
    if (!isoDateStr) return null;
    // Panama is UTC-5 always (no DST)
    const target = new Date(isoDateStr + "-05:00");
    const now = new Date();
    const diff = target - now;
    if (diff <= 0) return { d:0,h:0,m:0,s:0 };
    const d = Math.floor(diff/86400000);
    const h = Math.floor((diff%86400000)/3600000);
    const m = Math.floor((diff%3600000)/60000);
    const s = Math.floor((diff%60000)/1000);
    return { d,h,m,s };
  };
  const [left, setLeft] = useState(calcLeft);
  useEffect(() => {
    const t = setInterval(()=>setLeft(calcLeft()),1000);
    return ()=>clearInterval(t);
  },[isoDateStr]);
  return left;
}

/* ═══ Componente auxiliar: countdown por sorteo ═══════ */
function SorteoCountdown({ isoDateStr, color, border }) {
  const cd = useCountdown(isoDateStr);
  if (!cd) return null;
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {[["d","Días"],["h","Hrs"],["m","Min"],["s","Seg"]].map(([k,l]) => (
        <div key={k} style={{ flex:1, background:"rgba(8,17,31,.5)", borderRadius:8, padding:"5px 2px", textAlign:"center" }}>
          <div style={{ fontFamily:"'Bebas Neue'", fontSize:20, color, lineHeight:1 }}>{String(cd[k]).padStart(2,"0")}</div>
          <div style={{ fontSize:7, color:"var(--muted)", fontWeight:700, marginTop:1 }}>{l}</div>
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   PANTALLA: INICIO  (Comprador)
═══════════════════════════════════════════════════════ */
function ClienteHome({ cart, nav, sharedVendor, activeOrders=[], activeVendors=VENDORS }) {
  const countdown = useCountdown("2026-04-08T15:00:00");
  const [sorteoTab, setSorteoTab] = useState("MIERCOLITO");
  const [, forceRefresh] = useState(0);
  // Estado del botón Refrescar del banner "Verificando resultado oficial"
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState("");
  const cartCount = cart.reduce((a,i)=>a+i.qty,0);
  const modifiedOrders    = activeOrders.filter(o=>o.status==="MODIFICADO");
  const vendorCancelledOrders = activeOrders.filter(o=>o.status==="CANCELADO_VENDEDOR");

  // Re-renderizar cuando el Worker actualice los sorteos
  useEffect(() => {
    const handler = () => forceRefresh(v => v + 1);
    window.addEventListener('sorteos-actualizados', handler);
    return () => window.removeEventListener('sorteos-actualizados', handler);
  }, []);

  const sorted = [...SORTEOS_RECIENTES].sort((a,b)=>{
    const order=["MIERCOLITO","DOMINICAL","GORDITO","EXTRAORDINARIA"];
    return order.indexOf(a.tipo)-order.indexOf(b.tipo);
  });
  const selSorteo = sorted.find(s=>s.tipo===sorteoTab) || sorted[0];

  return (
    <div className="sc fu">
      {/* Header */}
      <div className="row" style={{justifyContent:"space-between",marginBottom:16}}>
        <div>
          <div style={{fontSize:11,color:"var(--muted)",fontWeight:500}}>Hola, María 👋</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:28,color:"var(--gold)",letterSpacing:3,lineHeight:1}}>CHANCE</div>
        </div>
        <div className="row" style={{gap:7}}>
          <button onClick={()=>nav("buscar")} style={{width:38,height:38,borderRadius:12,background:"var(--bg2)",border:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
            <Ic n="search" s={16} c="var(--muted)"/>
          </button>
          <button onClick={()=>nav("notif")} style={{width:38,height:38,borderRadius:12,background:"var(--bg2)",border:"1px solid var(--border)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",position:"relative"}}>
            <Ic n="bell" s={16} c="var(--muted)"/>
            {modifiedOrders.length>0&&<div className="ndot" style={{background:"var(--red)"}}/>}
          </button>
          <button onClick={()=>nav("carrito")} style={{width:38,height:38,borderRadius:12,background:"var(--bg2)",border:`1px solid ${cartCount>0?"rgba(244,196,48,.4)":"var(--border)"}`,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",position:"relative"}}>
            <Ic n="cart" s={16} c={cartCount>0?"var(--gold)":"var(--muted)"}/>
            {cartCount>0&&<div className="cbadge">{cartCount}</div>}
          </button>
        </div>
      </div>

      {/* Banner de pedido cancelado por vendedor */}
      {vendorCancelledOrders.length>0&&(
        <div style={{background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.35)",borderRadius:14,padding:"11px 14px",marginBottom:10,cursor:"pointer",display:"flex",gap:10,alignItems:"center"}} onClick={()=>nav("historial")}>
          <div style={{width:36,height:36,borderRadius:10,background:"rgba(255,75,110,.18)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:18}}>🚫</div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:800,color:"var(--red)",marginBottom:2}}>
              El vendedor canceló {vendorCancelledOrders.length} pedido(s)
            </div>
            <div style={{fontSize:10,color:"var(--muted)"}}>Los números fueron liberados · Toca para ver detalles</div>
          </div>
          <Ic n="chevR" s={14} c="var(--red)"/>
        </div>
      )}

      {/* Banner de modificación pendiente */}
      {modifiedOrders.length>0&&(
        <div style={{background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.35)",borderRadius:14,padding:"11px 14px",marginBottom:14,cursor:"pointer",display:"flex",gap:10,alignItems:"center"}} onClick={()=>nav("historial")}>
          <div style={{width:36,height:36,borderRadius:10,background:"rgba(255,75,110,.18)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:18}}>⚠️</div>
          <div style={{flex:1}}>
            <div style={{fontSize:12,fontWeight:800,color:"var(--red)",marginBottom:2}}>
              {modifiedOrders.length} pedido(s) modificados por el vendedor
            </div>
            <div style={{fontSize:10,color:"var(--muted)"}}>
              Toca para revisar los cambios y aprobar o buscar reemplazo
            </div>
          </div>
          <Ic n="chevR" s={14} c="var(--red)"/>
        </div>
      )}
      <div className="sec">Últimos Sorteos · lnb.gob.pa</div>
      <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:4,scrollbarWidth:"none",marginBottom:10}}>
        {sorted.map(s=>(
          <button key={s.tipo} className={`chip ${sorteoTab===s.tipo?"on":""}`}
            style={{flexShrink:0,gap:4}} onClick={()=>setSorteoTab(s.tipo)}>
            <span>{s.icon}</span><span style={{fontSize:10}}>{s.tipo}</span>
          </button>
        ))}
      </div>

      {/* Sorteo card con datos reales */}
      <div className="sort-card" style={{background:selSorteo.bg,borderColor:selSorteo.border,marginBottom:12,position:"relative"}}>
        <div style={{position:"absolute",right:-20,top:-20,width:90,height:90,borderRadius:"50%",background:selSorteo.bg}}/>
        <div className="row" style={{justifyContent:"space-between",marginBottom:8}}>
          <div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:selSorteo.color,letterSpacing:3,lineHeight:1}}>{selSorteo.icon} {selSorteo.tipo}</div>
            <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>{selSorteo.fecha} · Sorteo Nº {selSorteo.sorteoN}</div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,textTransform:"uppercase"}}>Premio Mayor</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:28,color:selSorteo.color,letterSpacing:2}}>{selSorteo.premioMayor}</div>
          </div>
        </div>
        {/* Banner: pendiente verificación oficial */}
        {selSorteo.pendienteVerificacion && (
          <div style={{background:"rgba(244,196,48,.12)",border:"1px dashed rgba(244,196,48,.4)",borderRadius:9,padding:"6px 10px",marginBottom:8,display:"flex",gap:7,alignItems:"center"}}>
            <span style={{fontSize:14}}>⏳</span>
            <div style={{flex:1}}>
              <div style={{fontSize:10,fontWeight:800,color:"var(--gold)"}}>Verificando resultado oficial…</div>
              <div style={{fontSize:9,color:"var(--muted)"}}>{refreshMsg || "Sincronizando con Lotería Nacional. Los números se actualizarán automáticamente."}</div>
            </div>
            <button
              disabled={refreshing}
              onClick={async ()=>{
                setRefreshing(true);
                setRefreshMsg("Consultando Lotería Nacional…");
                try {
                  const ok = await cargarSorteosAutomaticos();
                  if (ok) {
                    setRefreshMsg("✅ Sincronizado con LNB");
                    setTimeout(() => { setRefreshMsg(""); setRefreshing(false); }, 1500);
                  } else {
                    setRefreshMsg(UPDATER_URL.includes("AJUSTAR")
                      ? "⚠️ Worker no configurado"
                      : "⚠️ LNB aún no publica este sorteo. Reintenta en unos minutos.");
                    setTimeout(() => setRefreshing(false), 2000);
                  }
                } catch(e) {
                  setRefreshMsg("⚠️ Error de conexión");
                  setTimeout(() => setRefreshing(false), 2000);
                }
              }}
              style={{background:refreshing?"rgba(244,196,48,.08)":"rgba(244,196,48,.2)",border:"none",borderRadius:7,padding:"4px 8px",fontSize:9,fontWeight:800,color:"var(--gold)",cursor:refreshing?"wait":"pointer",opacity:refreshing?0.6:1,minWidth:54}}>
              {refreshing ? "⏳…" : "Refrescar"}
            </button>
          </div>
        )}
        {/* Premios */}
        <div style={{display:"flex",gap:8}}>
          {selSorteo.premios.map((p,pi)=>{
            const cols=["var(--gold)","var(--blue)","var(--green)"];
            const esPlaceholder = p.num === "0000" || p.num === "00000";
            return (
              <div key={p.pos} style={{flex:1,background:"rgba(8,17,31,.4)",borderRadius:10,padding:"8px 4px",textAlign:"center",opacity:esPlaceholder?0.4:1}}>
                <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",letterSpacing:.5,marginBottom:3}}>{p.pos}</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:p.num.length>4?14:18,color:esPlaceholder?"var(--muted)":cols[pi],letterSpacing:1,lineHeight:1}}>{esPlaceholder?"——":p.num}</div>
                {p.letras&&p.letras!=="----"&&<div style={{fontSize:8,color:selSorteo.color,fontWeight:800,marginTop:2,letterSpacing:.5}}>{p.letras}</div>}
                {p.serie&&p.serie!=="00"&&<div style={{fontSize:8,color:"var(--muted)",marginTop:1}}>S{p.serie} F{p.folio}</div>}
              </div>
            );
          })}
        </div>
        {selSorteo.proximoISO && (
          <div style={{marginTop:8,paddingTop:8,borderTop:`1px solid ${selSorteo.border}`}}>
            <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:6}}>Próximo · {selSorteo.frecuencia} · 3:00 PM</div>
            <SorteoCountdown isoDateStr={selSorteo.proximoISO} color={selSorteo.color} border={selSorteo.border}/>
          </div>
        )}
      </div>

      {/* Accesos rápidos */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
        {[
          {icon:"search",l:"Buscar Número",sub:"¿Quién lo tiene?",s:"buscar",c:"var(--blue)"},
          {icon:"history",l:"Mis pedidos",sub:"Activos y pasados",s:"historial",c:"var(--purple)"},
          {icon:"trophy",l:"Resultados",sub:"Mié, Sáb y Dom",s:"resultados",c:"var(--gold)"},
          {icon:"scan",l:"Verificar billete",sub:"Escanea tu número",s:"verificar",c:"var(--green)"},
        ].map(({icon,l,sub,s,c})=>(
          <div key={s} className="card" style={{cursor:"pointer",marginBottom:0}} onClick={()=>nav(s)}>
            <div style={{width:32,height:32,borderRadius:10,background:`${c}18`,border:`1px solid ${c}28`,display:"flex",alignItems:"center",justifyContent:"center",marginBottom:7}}>
              <Ic n={icon} s={15} c={c}/>
            </div>
            <div style={{fontWeight:700,fontSize:12,color:"var(--text)",marginBottom:1}}>{l}</div>
            <div style={{fontSize:10,color:"var(--muted)"}}>{sub}</div>
          </div>
        ))}
      </div>

      {/* Vendedores cercanos */}
      <div className="row" style={{justifyContent:"space-between",marginBottom:8}}>
        <div className="sec" style={{marginBottom:0}}>Vendedores Cercanos</div>
        <button onClick={()=>nav("explorar")} style={{fontSize:11,color:"var(--gold)",fontWeight:700,background:"none",border:"none",cursor:"pointer"}}>Ver todos →</button>
      </div>
      {activeVendors.map(v=>{
        // Para Carlos Medina (V001 demo o real), usar sharedVendor que tiene los datos
        // sincronizados (sorteo activo, billetes, chances actualizados).
        const isCarlosMedina = v.id === 1 || v.id === "V001";
        const vendorData = (isCarlosMedina && sharedVendor) ? { ...v, ...sharedVendor } : v;
        return (
        <div key={v.id} className="card" style={{cursor:"pointer"}} onClick={()=>nav({screen:"tablero",vendor:vendorData})}>
          <div className="row" style={{justifyContent:"space-between",marginBottom:7}}>
            <div className="row" style={{gap:9}}>
              <div style={{width:40,height:40,borderRadius:12,background:"rgba(244,196,48,.12)",border:"1px solid rgba(244,196,48,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:15,color:"var(--gold)",flexShrink:0}}>
                {vendorData.name.split(" ").map(w=>w[0]).join("")}
              </div>
              <div>
                <div style={{fontWeight:800,fontSize:13,color:"var(--text)"}}>{vendorData.name} {vendorData.verified&&"✅"}</div>
                <div style={{fontSize:10,color:"var(--muted)"}}>⭐{vendorData.rating} · {vendorData.distance} · {vendorData.time}</div>
              </div>
            </div>
          </div>
          <div className="row" style={{gap:8}}>
            <span className="tag-b">🎟 {vendorData.billetes.filter(b=>b.sold<b.stock).length} billetes</span>
            <span className="tag-c">⚡ {vendorData.chances.filter(c=>c.sold<c.stock).length} chances</span>
            <span style={{fontSize:11,color:"var(--gold)",fontWeight:700,marginLeft:"auto"}}>Ver →</span>
          </div>
        </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   PANTALLA: BUSCAR NÚMERO  ★ nueva funcionalidad
═══════════════════════════════════════════════════════ */
function BuscarScreen({ nav, sharedVendor, activeVendors=VENDORS }) {
  const [q, setQ] = useState("");
  const [tipo, setTipo] = useState("ambos"); // billete | chance | ambos

  // Buscar en inventario de vendedores (activos)
  const results = q.length >= 2 ? activeVendors.flatMap(v => {
    const hits = [];
    if (tipo !== "chance") {
      const b = (v.billetes||[]).find(b => b.n === q.padStart(4,"0") || b.n.includes(q));
      if (b) hits.push({ vendor: v, type: "billete", item: b });
    }
    if (tipo !== "billete") {
      const c = (v.chances||[]).find(c => c.n === q.padStart(2,"0") || c.n.includes(q));
      if (c) hits.push({ vendor: v, type: "chance", item: c });
    }
    return hits;
  }) : [];

  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:2,marginBottom:4}}>BUSCAR NÚMERO</div>
      <div style={{fontSize:11,color:"var(--muted)",marginBottom:12}}>Ingresa el número y te decimos quién lo tiene</div>

      {/* Campo de búsqueda */}
      <div style={{position:"relative",marginBottom:10}}>
        <div style={{position:"absolute",left:13,top:"50%",transform:"translateY(-50%)"}}>
          <Ic n="search" s={16} c="var(--muted)"/>
        </div>
        <input className="inp" placeholder="Ej: 3561 (billete) o 07 (chance)"
          value={q} onChange={e=>setQ(e.target.value)}
          style={{paddingLeft:40,paddingRight:q?40:14}}
          autoFocus/>
        {q&&<button onClick={()=>setQ("")} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:16}}>×</button>}
      </div>

      {/* Filtro tipo */}
      <div style={{display:"flex",gap:6,marginBottom:14}}>
        {[["ambos","🔍 Ambos"],["billete","🎟 Billetes"],["chance","⚡ Chances"]].map(([t,l])=>(
          <button key={t} className={`chip ${tipo===t?"on":""}`} onClick={()=>setTipo(t)}>{l}</button>
        ))}
      </div>

      {/* Info */}
      {q.length < 2 && (
        <div style={{background:"rgba(59,158,255,.07)",border:"1px solid rgba(59,158,255,.18)",borderRadius:12,padding:"10px 14px",display:"flex",gap:10,marginBottom:12}}>
          <Ic n="info" s={15} c="var(--blue)"/>
          <div style={{fontSize:11,color:"var(--muted)",lineHeight:1.5}}>
            <strong style={{color:"var(--text)"}}>Billetes:</strong> 4 cifras (ej: 3561, 8364)<br/>
            <strong style={{color:"var(--text)"}}>Chances:</strong> 2 cifras (ej: 07, 23)
          </div>
        </div>
      )}

      {/* Resultados */}
      {q.length >= 2 && results.length === 0 && (
        <div style={{textAlign:"center",padding:"30px 0"}}>
          <div style={{fontSize:42,marginBottom:10}}>🔍</div>
          <div style={{fontSize:14,fontWeight:700,color:"var(--text)",marginBottom:4}}>Sin resultados para "{q}"</div>
          <div style={{fontSize:11,color:"var(--muted)"}}>Ningún vendedor tiene este número disponible</div>
        </div>
      )}

      {results.length > 0 && (
        <>
          <div className="sec">{results.length} resultado{results.length>1?"s":""} para "{q}"</div>
          {results.map((r, i) => {
            const avail = r.item.stock - r.item.sold;
            const isChance = r.type === "chance";
            return (
              <div key={i} className="card" style={{cursor:"pointer",marginBottom:10,border:`1px solid ${isChance?"rgba(59,158,255,.25)":"rgba(244,196,48,.25)"}`}}
                onClick={()=>{
                  // Si el resultado es de Carlos Medina (V001 demo o real), usar sharedVendor con datos sincronizados
                  const isCarlosMedina = r.vendor.id === 1 || r.vendor.id === "V001";
                  const v = (isCarlosMedina && sharedVendor) ? { ...r.vendor, ...sharedVendor } : r.vendor;
                  nav({screen:"tablero",vendor:v});
                }}>
                {/* Cabecera vendedor */}
                <div className="row" style={{justifyContent:"space-between",marginBottom:10}}>
                  <div className="row" style={{gap:8}}>
                    <div style={{width:36,height:36,borderRadius:10,background:"rgba(244,196,48,.1)",border:"1px solid rgba(244,196,48,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:13,color:"var(--gold)",flexShrink:0}}>
                      {r.vendor.name.split(" ").map(w=>w[0]).join("")}
                    </div>
                    <div>
                      <div style={{fontWeight:800,fontSize:13,color:"var(--text)"}}>{r.vendor.name} {r.vendor.verified&&"✅"}</div>
                      <div style={{fontSize:10,color:"var(--muted)"}}>📍 {r.vendor.distance} · 🕐 {r.vendor.time}</div>
                    </div>
                  </div>
                  {isChance ? <span className="tag-c">⚡ CHANCE</span> : <span className="tag-b">🎟 BILLETE</span>}
                </div>

                {/* Número encontrado */}
                <div style={{background:"rgba(8,17,31,.5)",borderRadius:12,padding:"10px 14px",marginBottom:10}}>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:32,color:isChance?"var(--blue)":"var(--gold)",letterSpacing:3,lineHeight:1}}>
                    {isChance?"#":""}{r.item.n}
                  </div>
                  <div style={{fontSize:11,color:"var(--muted)",marginTop:2}}>{r.vendor.sorteo}</div>
                </div>

                {/* Disponibilidad */}
                {isChance ? (
                  <div>
                    <div style={{fontSize:10,color:"var(--muted)",fontWeight:700,marginBottom:6,textTransform:"uppercase",letterSpacing:.5}}>Disponibilidad</div>
                    <div style={{background:"var(--bg3)",borderRadius:10,padding:"8px 12px"}}>
                      <div className="row" style={{justifyContent:"space-between"}}>
                        <div>
                          <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:avail>0?"var(--green)":"var(--red)",letterSpacing:1}}>{avail} und</div>
                          <div style={{fontSize:10,color:"var(--muted)"}}>de {r.item.stock} totales</div>
                        </div>
                        <div style={{textAlign:"right"}}>
                          <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,textTransform:"uppercase"}}>Precio c/u</div>
                          <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--blue)",letterSpacing:1}}>$0.25</div>
                        </div>
                      </div>
                      {/* Barra de stock */}
                      <div style={{height:4,background:"rgba(255,255,255,.06)",borderRadius:2,overflow:"hidden",marginTop:8}}>
                        <div style={{height:"100%",width:`${(avail/r.item.stock)*100}%`,background:avail>10?"var(--green)":avail>0?"var(--gold)":"var(--red)",borderRadius:2}}/>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{fontSize:10,color:"var(--muted)",fontWeight:700,marginBottom:6,textTransform:"uppercase",letterSpacing:.5}}>Fracciones Disponibles</div>
                    <div style={{display:"flex",gap:6}}>
                      {Array.from({length:r.item.stock},(_,i)=>{
                        const isAvail = i >= r.item.sold;
                        return (
                          <div key={i} className="frac-cell" style={{background:isAvail?"rgba(244,196,48,.1)":"rgba(110,133,158,.05)",border:`1.5px solid ${isAvail?"rgba(244,196,48,.35)":"rgba(110,133,158,.12)"}`,opacity:isAvail?1:.4}}>
                            <div style={{fontSize:11,fontWeight:800,color:isAvail?"var(--text)":"var(--muted)"}}>{i+1}/{r.item.stock}</div>
                            <div style={{fontSize:8,color:isAvail?"var(--green)":"var(--red)",fontWeight:800,marginTop:1}}>{isAvail?"Disp":"Agot"}</div>
                            {isAvail&&<div style={{fontSize:8,color:"var(--gold)",fontWeight:700}}>$1.00</div>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <button className="btn-sm" style={{width:"100%",marginTop:10}}>
                  Comprar en tablero de {r.vendor.name.split(" ")[0]} →
                </button>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   PANTALLA: EXPLORAR — con buscador y filtro sorteo
═══════════════════════════════════════════════════════ */
function ExplorarScreen({ nav, sharedVendor, activeVendors=VENDORS }) {
  const [q, setQ] = useState("");
  const [sorteoF, setSorteoF] = useState("todos");

  // sorteos únicos de los vendedores
  const allSorteos = [...new Set(activeVendors.map(v => v.sorteoData?.tipo || v.sorteo))];

  const filtered = activeVendors.filter(v => {
    // El código del vendedor puede ser numérico (1, 2 demo) o string (V003, V004 reales)
    const codigo = typeof v.id === "string" ? v.id : `V${String(v.id).padStart(3,"0")}`;
    const matchQ = !q.trim() ||
      v.name.toLowerCase().includes(q.toLowerCase()) ||
      codigo.toUpperCase().includes(q.toUpperCase()) ||
      (v.zone || "").toLowerCase().includes(q.toLowerCase());
    const matchS = sorteoF === "todos" || v.sorteo === sorteoF;
    return matchQ && matchS;
  });

  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:2,marginBottom:4}}>VENDEDORES</div>
      <div style={{fontSize:11,color:"var(--muted)",marginBottom:12}}>
        {filtered.length} vendedor{filtered.length!==1?"es":""} encontrado{filtered.length!==1?"s":""}
      </div>

      {/* Buscador */}
      <div style={{position:"relative",marginBottom:8}}>
        <div style={{position:"absolute",left:13,top:"50%",transform:"translateY(-50%)"}}>
          <Ic n="search" s={15} c="var(--muted)"/>
        </div>
        <input className="inp" placeholder="Buscar por nombre, código (ej: V001) o zona..."
          value={q} onChange={e=>setQ(e.target.value)}
          style={{paddingLeft:38,paddingRight:q?36:14}}/>
        {q && <button onClick={()=>setQ("")} style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"var(--muted)",fontSize:16}}>×</button>}
      </div>

      {/* Filtro por sorteo activo */}
      <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4,scrollbarWidth:"none",marginBottom:14}}>
        <button className={`chip ${sorteoF==="todos"?"on":""}`} onClick={()=>setSorteoF("todos")}>
          Todos los sorteos
        </button>
        {allSorteos.map(s=>(
          <button key={s} className={`chip ${sorteoF===s?"on":""}`} style={{flexShrink:0}} onClick={()=>setSorteoF(s)}>
            📅 {s}
          </button>
        ))}
      </div>

      {/* Lista */}
      {filtered.length === 0 ? (
        <div style={{textAlign:"center",padding:"32px 0"}}>
          <div style={{fontSize:40,marginBottom:10}}>🔍</div>
          <div style={{fontSize:14,fontWeight:700,color:"var(--text)",marginBottom:4}}>Sin resultados</div>
          <div style={{fontSize:11,color:"var(--muted)"}}>Intenta con otro nombre, código o sorteo</div>
        </div>
      ) : filtered.map(vRaw=>{
        // Para Carlos Medina (V001 demo o real), reemplazar con sharedVendor sincronizado
        const isCarlosMedina = vRaw.id === 1 || vRaw.id === "V001";
        const v = (isCarlosMedina && sharedVendor) ? { ...vRaw, ...sharedVendor } : vRaw;
        return (
        <div key={v.id} className="card" style={{cursor:"pointer"}} onClick={()=>nav({screen:"tablero",vendor:v})}>
          <div className="row" style={{gap:10,marginBottom:10}}>
            <div style={{width:46,height:46,borderRadius:14,background:"rgba(244,196,48,.1)",border:"1px solid rgba(244,196,48,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:18,color:"var(--gold)",flexShrink:0}}>
              {v.name.split(" ").map(w=>w[0]).join("")}
            </div>
            <div style={{flex:1}}>
              <div className="row" style={{gap:7,marginBottom:2}}>
                <div style={{fontWeight:800,fontSize:14,color:"var(--text)"}}>{v.name} {v.verified&&"✅"}</div>
                <span style={{fontSize:9,fontWeight:800,color:"var(--muted)",background:"var(--bg3)",borderRadius:5,padding:"2px 5px"}}>
                  V{String(v.id).padStart(3,"0")}
                </span>
              </div>
              <div style={{fontSize:11,color:"var(--muted)",marginBottom:2}}>{v.zone}</div>
              <div style={{fontSize:11,color:"var(--muted)"}}>⭐{v.rating} ({v.reviews}) · {v.distance} · {v.time}</div>
            </div>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:7,marginBottom:10}}>
            {[{l:"Distancia",v:v.distance},{l:"Entrega",v:v.time},{l:"Sorteo activo",v:v.sorteo}].map(({l,v:val})=>(
              <div key={l} style={{background:"var(--bg3)",borderRadius:9,padding:"7px",textAlign:"center"}}>
                <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{l}</div>
                <div style={{fontSize:10,fontWeight:800,color:"var(--text)",lineHeight:1.2}}>{val}</div>
              </div>
            ))}
          </div>
          <div className="row" style={{gap:8,marginBottom:10}}>
            <span className="tag-b">🎟 {v.billetes.filter(b=>b.sold<b.stock).length} billetes</span>
            <span className="tag-c">⚡ {v.chances.filter(c=>c.sold<c.stock).length} chances</span>
          </div>
          <button className="btn" style={{fontSize:13}}>Ver tablero completo</button>
        </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   TABLERO  — Chances van de 5 en 5
═══════════════════════════════════════════════════════ */
function TableroScreen({ vendor, cart, setCart, nav, vendorActiveSorteo=null }) {
  const [tab, setTab] = useState("billetes");
  const [selected, setSelected] = useState(null);
  const [qty, setQty] = useState(1);
  // Cada vendedor tiene su propio path en Firebase con su sorteo activo.
  // El comprador lee ese path para ver SOLO los billetes del sorteo activo
  // de ESE vendedor (no del global de Carlos Medina).
  const [vendorOwnSorteo, setVendorOwnSorteo] = useState(null);
  useEffect(() => {
    const code = typeof vendor.id === "string" ? vendor.id : `V${String(vendor.id).padStart(3,"0")}`;
    let active = true;
    (async () => {
      try {
        const data = await fbRead(`vendedor_${code}/sorteoActivo`);
        if (active && data && data.tipo) setVendorOwnSorteo(data);
      } catch(e) { /* sin GPS, usar default */ }
    })();
    return () => { active = false; };
  }, [vendor.id]);

  const totalCartQty = cart.reduce((a,i)=>a+i.qty,0);
  const getAvail = item => item.stock - item.sold;

  const openItem = (type, item) => {
    if (getAvail(item)<=0) return;
    setSelected({type,item});
    setQty(type==="chance"?5:1);
  };

  const addToCart = () => {
    if (!selected) return;
    const {type,item} = selected;
    const id = `${vendor.id}-${type}-${item.n}`;
    const price = type==="billete"?1.00:0.25;
    setCart(prev=>{
      const ex=prev.find(i=>i.id===id);
      if(ex) return prev.map(i=>i.id===id?{...i,qty:Math.min(i.qty+qty,getAvail(item))}:i);
      return [...prev,{
        id,
        vendorId:vendor.id,
        vendor:vendor.name,
        // userId del vendedor: para vendedores reales viene en vendor.userId,
        // para demos hardcoded inferimos del v.id (V001=Carlos, V002=Rosa).
        vendorUserId: vendor.userId
          || (vendor.id === 1 || vendor.id === "V001" ? "vendedor_carlos"
            : vendor.id === 2 || vendor.id === "V002" ? "vendedor_rosa"
            : "vendedor_carlos"),
        // Zona/lugar real del vendedor para mostrar al comprador en el mapa
        vendorZone: vendor.zone || "",
        type, num:item.n, qty, price,
        sorteo:vendor.sorteo, maxQty:getAvail(item),
      }];
    });
    setSelected(null);
  };

  const getCartQty = (type,n) => cart.find(i=>i.id===`${vendor.id}-${type}-${n}`)?.qty||0;
  // Filtrar por sorteo activo del vendedor: solo se muestran al comprador los
  // billetes/chances asociados al mismo sorteo. Items legacy sin sorteoTipo
  // se consideran disponibles para cualquier sorteo (compatibilidad).
  // Prioridad: 1) sorteo del vendor leído directo de su path Firebase,
  // 2) sorteoData del vendor (demos), 3) vendorActiveSorteo del root,
  // 4) MIERCOLITO como default.
  const sorteoTipoActivoVendor = vendorOwnSorteo?.tipo || vendor.sorteoData?.tipo || vendorActiveSorteo?.tipo || "MIERCOLITO";
  const billetesFiltrados = (vendor.billetes||[]).filter(b => !b.sorteoTipo || b.sorteoTipo === sorteoTipoActivoVendor);
  const chancesFiltrados  = (vendor.chances ||[]).filter(c => !c.sorteoTipo || c.sorteoTipo === sorteoTipoActivoVendor);
  const items = tab==="billetes"?billetesFiltrados:chancesFiltrados;
  const isChanceTab = tab==="chances";

  return (
    <div className="sc fu" style={{position:"relative"}}>
      {/* Vendor info */}
      <div className="card" style={{marginBottom:10}}>
        <div className="row" style={{justifyContent:"space-between"}}>
          <div className="row" style={{gap:9}}>
            <div style={{width:42,height:42,borderRadius:12,background:"rgba(244,196,48,.1)",border:"1px solid rgba(244,196,48,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:15,color:"var(--gold)",flexShrink:0}}>
              {vendor.name.split(" ").map(w=>w[0]).join("")}
            </div>
            <div>
              <div style={{fontWeight:800,fontSize:13,color:"var(--text)"}}>{vendor.name} {vendor.verified&&"✅"}</div>
              <div style={{fontSize:10,color:"var(--muted)"}}>⭐{vendor.rating} · {vendor.distance} · {vendor.time}</div>
            </div>
          </div>
          <span className="badge bg">● En línea</span>
        </div>
      </div>

      {/* Sorteo */}
      <div style={{background:`${vendor.sorteoData?.bg||"rgba(244,196,48,.07)"}`,border:`1px solid ${vendor.sorteoData?.border||"rgba(244,196,48,.16)"}`,borderRadius:12,padding:"9px 13px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <div style={{fontSize:9,color:vendor.sorteoData?.color||"var(--gold)",fontWeight:800,letterSpacing:1.5,textTransform:"uppercase"}}>Sorteo Activo</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:17,color:"var(--text)",letterSpacing:2}}>
            {vendor.sorteoData?.icon||"🎟"} {vendor.sorteoData?.tipo||vendor.sorteo}
          </div>
          <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>{vendor.sorteoData?.fecha||vendor.sorteo}</div>
        </div>
        <div style={{textAlign:"right"}}>
          <div style={{fontSize:9,color:"var(--muted)",fontWeight:700}}>Premio Mayor</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:vendor.sorteoData?.color||"var(--gold)",letterSpacing:2}}>
            {vendor.sorteoData?.premioMayor||"$150K"}
          </div>
          {vendor.sorteoData?.premios?.[0]?.num&&(
            <div style={{fontSize:9,color:"var(--muted)"}}>Último: {vendor.sorteoData.premios[0].num}</div>
          )}
        </div>
      </div>

      {/* Pestañas producto */}
      <div style={{display:"flex",gap:7,marginBottom:12}}>
        {[
          {id:"billetes",icon:"🎟️",label:"Billetes",sub:"4 cifras · $1.00",color:"var(--gold)",count:billetesFiltrados.filter(b=>getAvail(b)>0).length},
          {id:"chances", icon:"⚡",label:"Chances", sub:"2 cifras · $0.25",color:"var(--blue)",count:chancesFiltrados.filter(c=>getAvail(c)>0).length},
        ].map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{flex:1,padding:"10px 8px",borderRadius:14,border:`2px solid ${tab===t.id?t.color:"var(--border)"}`,background:tab===t.id?`${t.color}12`:"var(--bg2)",cursor:"pointer",textAlign:"center",fontFamily:"'DM Sans'",transition:"all .2s"}}>
            <div style={{fontSize:13,fontWeight:800,color:tab===t.id?t.color:"var(--muted)"}}>{t.icon} {t.label}</div>
            <div style={{fontSize:10,color:"var(--muted)",marginTop:1}}>{t.sub}</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:15,color:t.color,marginTop:2,letterSpacing:1}}>{t.count} disp.</div>
          </button>
        ))}
      </div>

      {/* Leyenda */}
      <div className="row" style={{gap:12,marginBottom:10,flexWrap:"wrap"}}>
        {[["rgba(244,196,48,.3)","rgba(244,196,48,.07)","Disponible"],["rgba(110,133,158,.12)","rgba(110,133,158,.04)","Agotado"]].map(([bc,bg,l])=>(
          <div key={l} className="row" style={{gap:4}}>
            <div style={{width:11,height:11,borderRadius:3,background:bg,border:`1.5px solid ${bc}`}}/>
            <span style={{fontSize:10,color:"var(--muted)",fontWeight:600}}>{l}</span>
          </div>
        ))}
        <div className="row" style={{gap:4}}>
          <div style={{width:11,height:11,borderRadius:3,background:"rgba(244,196,48,.2)",border:"2px solid var(--gold)"}}/>
          <span style={{fontSize:10,color:"var(--muted)",fontWeight:600}}>En carrito</span>
        </div>
      </div>

      {/* Tablero grid */}
      <div className="board">
        <div style={{fontFamily:"'Bebas Neue'",fontSize:10,color:"var(--muted)",letterSpacing:3,marginBottom:10}}>
          {isChanceTab?"CHANCES — 2 CIFRAS — $0.25 c/u — SUMA DE 5 EN 5":"BILLETES — 4 CIFRAS — $1.00 por fracción"}
        </div>
        <div style={{display:"grid",gridTemplateColumns:isChanceTab?"repeat(5,1fr)":"repeat(4,1fr)",gap:7}}>
          {items.map(item=>{
            const avail=getAvail(item);
            const inCart=getCartQty(isChanceTab?"chance":"billete",item.n);
            const sold=avail<=0;
            return (
              <button key={item.n}
                className={`nc ${sold?"so":inCart>0?"sel":"av"}`}
                style={{padding:"8px 3px",minHeight:isChanceTab?62:70}}
                onClick={()=>openItem(isChanceTab?"chance":"billete",item)}>
                <div style={{fontSize:7,fontWeight:800,color:sold?"var(--muted)":isChanceTab?"var(--blue)":"var(--gold)",marginBottom:1,opacity:sold?.5:1}}>
                  {isChanceTab?"⚡":"🎟"}
                </div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:isChanceTab?20:16,color:sold?"var(--muted)":"var(--text)",letterSpacing:1,lineHeight:1}}>
                  {item.n}
                </div>
                {!sold?(
                  <>
                    <div style={{fontSize:8,color:"var(--muted)",marginTop:2,fontWeight:700}}>
                      {isChanceTab?`${avail} und`:`${avail}/${item.stock} fr`}
                    </div>
                    <div style={{fontSize:9,fontWeight:800,color:isChanceTab?"var(--blue)":"var(--gold)",marginTop:1}}>
                      {isChanceTab?"$0.25":"$1.00"}
                    </div>
                    {inCart>0&&<div style={{position:"absolute",top:3,right:3,width:14,height:14,borderRadius:"50%",background:"var(--gold)",color:"#08111F",fontSize:8,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{inCart}</div>}
                  </>
                ):(
                  <div style={{fontSize:8,color:"var(--red)",fontWeight:800,marginTop:2}}>AGOT</div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bottom sheet selector */}
      {selected && (
        <div className="overlay" onClick={()=>setSelected(null)}>
          <div className="sheet pop" onClick={e=>e.stopPropagation()}>
            <div style={{width:38,height:4,borderRadius:2,background:"var(--border)",margin:"0 auto 16px"}}/>
            {/* Producto header */}
            <div className="row" style={{gap:12,marginBottom:14}}>
              <div style={{width:56,height:56,borderRadius:14,background:selected.type==="billete"?"rgba(244,196,48,.12)":"rgba(59,158,255,.12)",border:`1.5px solid ${selected.type==="billete"?"rgba(244,196,48,.3)":"rgba(59,158,255,.3)"}`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <span style={{fontSize:22}}>{selected.type==="billete"?"🎟️":"⚡"}</span>
              </div>
              <div style={{flex:1}}>
                <div className="row" style={{gap:6,marginBottom:3}}>
                  {selected.type==="billete"?<span className="tag-b">BILLETE</span>:<span className="tag-c">CHANCE</span>}
                  <span style={{fontSize:10,color:"var(--muted)"}}>{vendor.sorteo}</span>
                </div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:30,color:"var(--gold)",letterSpacing:3,lineHeight:1}}>
                  {selected.type==="billete"?"Nº ":"#"}{selected.item.n}
                </div>
                <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>
                  {selected.type==="billete"
                    ?`${getAvail(selected.item)} fracciones disponibles`
                    :`${getAvail(selected.item)} unidades disponibles`}
                </div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:1}}>
                  {selected.type==="billete"?"$1.00":"$0.25"}
                </div>
                <div style={{fontSize:9,color:"var(--muted)"}}>c/u</div>
              </div>
            </div>

            {/* Fracciones billete */}
            {selected.type==="billete"&&(
              <div style={{background:"rgba(244,196,48,.05)",border:"1px solid rgba(244,196,48,.15)",borderRadius:12,padding:"10px 12px",marginBottom:14}}>
                <div style={{fontSize:10,color:"var(--muted)",fontWeight:700,marginBottom:7}}>Fracciones disponibles:</div>
                <div style={{display:"flex",gap:7}}>
                  {Array.from({length:selected.item.stock},(_,i)=>{
                    const av=i>=selected.item.sold;
                    return (
                      <div key={i} className="frac-cell" style={{background:av?"rgba(244,196,48,.1)":"rgba(110,133,158,.06)",border:`1.5px solid ${av?"rgba(244,196,48,.32)":"rgba(110,133,158,.12)"}`,opacity:av?1:.4}}>
                        <div style={{fontSize:11,fontWeight:800,color:av?"var(--text)":"var(--muted)"}}>{i+1}/{selected.item.stock}</div>
                        <div style={{fontSize:9,color:av?"var(--green)":"var(--red)",fontWeight:700,marginTop:1}}>{av?"Disp":"Agot"}</div>
                        {av&&<div style={{fontSize:8,color:"var(--gold)",fontWeight:700}}>$1.00</div>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Chance info */}
            {selected.type==="chance"&&(
              <div style={{background:"rgba(59,158,255,.06)",border:"1px solid rgba(59,158,255,.15)",borderRadius:12,padding:"9px 12px",marginBottom:14,display:"flex",gap:8,alignItems:"center"}}>
                <Ic n="info" s={14} c="var(--blue)"/>
                <span style={{fontSize:11,color:"var(--muted)",lineHeight:1.5}}>Las chances se suman de <strong style={{color:"var(--blue)"}}>5 en 5</strong>. Mínimo 5, máximo {getAvail(selected.item)}.</span>
              </div>
            )}

            {/* Selector cantidad */}
            <div style={{background:"var(--bg3)",borderRadius:14,padding:"14px",marginBottom:14}}>
              <div className="row" style={{justifyContent:"space-between"}}>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>Cantidad</div>
                  <div style={{fontSize:10,color:"var(--muted)",marginTop:1}}>
                    {selected.type==="chance"?"Incrementos de 5":"Fracciones disponibles"}
                  </div>
                </div>
                <Stepper
                  value={qty}
                  min={selected.type==="chance"?5:1}
                  max={selected.type==="chance"
                    ? Math.floor(getAvail(selected.item)/5)*5
                    : getAvail(selected.item)}
                  step={selected.type==="chance"?5:1}
                  onChange={setQty}
                  size="lg"
                />
              </div>
            </div>

            {/* Total */}
            <div className="row" style={{justifyContent:"space-between",background:"rgba(244,196,48,.06)",border:"1px solid rgba(244,196,48,.16)",borderRadius:12,padding:"11px 14px",marginBottom:14}}>
              <div>
                <div style={{fontSize:11,color:"var(--muted)"}}>Total a pagar</div>
                <div style={{fontSize:10,color:"var(--muted)"}}>{qty} × {selected.type==="billete"?"$1.00":"$0.25"}</div>
              </div>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:32,color:"var(--gold)",letterSpacing:1}}>
                ${(qty*(selected.type==="billete"?1.00:0.25)).toFixed(2)}
              </div>
            </div>
            <button className="btn" onClick={addToCart}>
              Añadir · {qty} {selected.type==="billete"?"fracción":"chance"}{qty>1?"s":""}
            </button>
            <button onClick={()=>setSelected(null)} style={{width:"100%",padding:"11px",background:"none",border:"none",color:"var(--muted)",fontSize:13,fontWeight:600,cursor:"pointer",marginTop:7,fontFamily:"'DM Sans'"}}>Cancelar</button>
          </div>
        </div>
      )}

      {totalCartQty>0&&!selected&&(
        <div style={{position:"sticky",bottom:10,marginTop:10}}>
          <button className="btn" style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingLeft:14,paddingRight:16}} onClick={()=>nav("carrito")}>
            <div style={{background:"rgba(0,0,0,.2)",borderRadius:7,padding:"2px 8px",fontSize:13,fontWeight:800}}>{totalCartQty}</div>
            <span>Ver carrito</span>
            <span>→</span>
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   CARRITO
═══════════════════════════════════════════════════════ */
function CarritoScreen({ cart, setCart, nav }) {
  const DELIVERY=2.50;
  const SERVICE_FEE=1.00;
  const subtotal=cart.reduce((a,i)=>a+i.price*i.qty,0);
  const total=subtotal+(cart.length>0?DELIVERY+SERVICE_FEE:0);
  const remove=id=>setCart(p=>p.filter(i=>i.id!==id));
  const updateQty=(id,q,step,maxQ)=>{
    if(q<step){remove(id);return;}
    setCart(p=>p.map(i=>i.id===id?{...i,qty:Math.min(q,maxQ||99)}:i));
  };

  if(!cart.length) return (
    <div className="sc fu" style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"80%"}}>
      <div style={{fontSize:54,marginBottom:12}}>🛒</div>
      <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:"var(--muted)",letterSpacing:2,marginBottom:6}}>CARRITO VACÍO</div>
      <div style={{fontSize:13,color:"var(--muted)",textAlign:"center",marginBottom:20,lineHeight:1.5}}>Explora los tableros y elige billetes o chances</div>
      <button className="btn" style={{width:"auto",padding:"11px 22px"}} onClick={()=>nav("explorar")}>Explorar vendedores</button>
    </div>
  );

  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:2,marginBottom:12}}>MI CARRITO</div>
      {VENDORS.filter(v=>cart.some(i=>i.vendorId===v.id)).map(v=>{
        const items=cart.filter(i=>i.vendorId===v.id);
        return (
          <div key={v.id} style={{marginBottom:12}}>
            <div className="row" style={{gap:7,marginBottom:7}}>
              <div style={{width:24,height:24,borderRadius:7,background:"rgba(244,196,48,.12)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:10,color:"var(--gold)"}}>
                {v.name.split(" ").map(w=>w[0]).join("")}
              </div>
              <div style={{fontWeight:700,fontSize:12,color:"var(--text)"}}>{v.name}</div>
              <span className="badge bg" style={{fontSize:8}}>✅</span>
            </div>
            <div className="card" style={{padding:"4px 13px"}}>
              {items.map((item,idx)=>{
                const stepVal=item.type==="chance"?5:1;
                return (
                  <div key={item.id}>
                    <div className="row" style={{justifyContent:"space-between",padding:"10px 0"}}>
                      <div className="row" style={{gap:9}}>
                        <div style={{width:38,height:38,borderRadius:11,background:item.type==="billete"?"rgba(244,196,48,.1)":"rgba(59,158,255,.1)",border:`1px solid ${item.type==="billete"?"rgba(244,196,48,.22)":"rgba(59,158,255,.22)"}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                          <span style={{fontSize:16}}>{item.type==="billete"?"🎟️":"⚡"}</span>
                        </div>
                        <div>
                          {item.type==="billete"?<span className="tag-b">BILLETE</span>:<span className="tag-c">CHANCE</span>}
                          <div style={{fontFamily:"'Bebas Neue'",fontSize:19,color:"var(--gold)",letterSpacing:2,lineHeight:1,marginTop:2}}>
                            {item.type==="billete"?"Nº ":"#"}{item.num}
                          </div>
                          <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>{item.sorteo}</div>
                        </div>
                      </div>
                      <div className="col" style={{alignItems:"flex-end",gap:6}}>
                        <button onClick={()=>remove(item.id)} style={{width:24,height:24,borderRadius:6,background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.2)",display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                          <Ic n="trash" s={11} c="var(--red)"/>
                        </button>
                        <Stepper value={item.qty} min={stepVal} max={item.maxQty||99} step={stepVal} onChange={q=>updateQty(item.id,q,stepVal,item.maxQty)}/>
                        <div style={{fontWeight:800,fontSize:13}}>${(item.price*item.qty).toFixed(2)}</div>
                      </div>
                    </div>
                    {idx<items.length-1&&<div className="div" style={{margin:"0"}}/>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div className="card">
        {[
          {l:"Billetes",v:`$${cart.filter(i=>i.type==="billete").reduce((a,i)=>a+i.price*i.qty,0).toFixed(2)}`},
          {l:"Chances",v:`$${cart.filter(i=>i.type==="chance").reduce((a,i)=>a+i.price*i.qty,0).toFixed(2)}`},
          {l:"Service fee (App)",v:"$1.00"},
          {l:"Delivery",v:`$${DELIVERY.toFixed(2)}`},
        ].map(({l,v})=>(
          <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
            <span style={{fontSize:12,color:"var(--muted)"}}>{l}</span>
            <span style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>{v}</span>
          </div>
        ))}
        <div className="div"/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontSize:14,fontWeight:800,color:"var(--text)"}}>TOTAL</span>
          <span style={{fontFamily:"'Bebas Neue'",fontSize:26,color:"var(--gold)",letterSpacing:1}}>${total.toFixed(2)}</span>
        </div>
        <div style={{fontSize:10,color:"var(--muted)",marginTop:4,textAlign:"right"}}>Comisión 2.5% → aplicada al vendedor</div>
      </div>
      <button className="btn" style={{marginBottom:8}} onClick={()=>nav("checkout")}>Confirmar pedido · ${total.toFixed(2)}</button>
      <button className="btng" onClick={()=>nav("explorar")}>Seguir comprando</button>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   CHECKOUT (simplificado)
═══════════════════════════════════════════════════════ */
function CheckoutScreen({ cart, setCart, nav, onConfirm }) {
  const [addr,setAddr]=useState(ADDRESSES[0]);
  const [pay,setPay]=useState("efectivo");
  const [step,setStep]=useState(1);
  // ─── NUEVO: Ubicación GPS del comprador ───
  const [usarGPS, setUsarGPS] = useState(false);
  const [ubicGPS, setUbicGPS] = useState(null);  // {lat, lng, precision}
  const [gpsLoading, setGpsLoading] = useState(false);
  const [gpsError, setGpsError] = useState(null);
  const [textoUbicacion, setTextoUbicacion] = useState(""); // referencia adicional (ej: "Apto 5B")

  // Capturar GPS del comprador
  const capturarGPS = async () => {
    setGpsLoading(true);
    setGpsError(null);
    try {
      const ubic = await obtenerUbicacion();
      setUbicGPS(ubic);
      setUsarGPS(true);
      setGpsLoading(false);
    } catch (err) {
      setGpsLoading(false);
      const errMsg = err.code === 1 ? "Permiso denegado. Activa la ubicación en el navegador" :
                     err.code === 2 ? "GPS no disponible. Verifica que esté activado" :
                     err.code === 3 ? "Tiempo agotado. Intenta de nuevo" :
                     "Error al obtener ubicación";
      setGpsError(errMsg);
    }
  };

  const subtotal=cart.reduce((a,i)=>a+i.price*i.qty,0);
  const serviceFee=1.00;

  // ─── Cálculo dinámico de delivery por distancia ───
  // Origen: ubicación del vendedor del primer item del carrito
  // Destino: GPS actual del comprador (si activo) o coords de la dirección guardada
  const vendorIdCart = cart[0]?.vendorId || "V001";
  const vendorCoordsCart = getVendorCoords(vendorIdCart);
  const destLat = usarGPS && ubicGPS ? ubicGPS.lat : (addr.lat || 8.9824);
  const destLng = usarGPS && ubicGPS ? ubicGPS.lng : (addr.lng || -79.5199);
  const distanciaKm = calcularDistancia(vendorCoordsCart.lat, vendorCoordsCart.lng, destLat, destLng);
  const deliveryInfo = calcDeliveryFee(distanciaKm);
  const deliveryFee = typeof deliveryInfo === 'object' ? deliveryInfo.fee : deliveryInfo;
  const deliveryLabel = typeof deliveryInfo === 'object' ? deliveryInfo.label : "Estándar";
  const total=subtotal+serviceFee+deliveryFee;
  const totals=calcOrderTotals(subtotal.toFixed(2), deliveryFee.toFixed(2), '0');
  const METHODS=[
    {id:"efectivo",icon:"💵",l:"Efectivo",sub:"El repartidor trae cambio"},
    {id:"yappy",   icon:"📱",l:"Yappy · Banco General",sub:"Pago QR — sin comisión bancaria"},
  ];
  const place=()=>{
    // Construir dirección final con coordenadas GPS si aplica
    const direccionFinal = usarGPS && ubicGPS ? {
      ...addr,
      label: "📍 Mi ubicación actual",
      addr: textoUbicacion || `Lat: ${ubicGPS.lat.toFixed(5)}, Lng: ${ubicGPS.lng.toFixed(5)}`,
      lat: ubicGPS.lat,
      lng: ubicGPS.lng,
      text: textoUbicacion || "Mi ubicación GPS"
    } : {
      ...addr,
      // Coordenadas default por dirección guardada (Bay View Tower)
      lat: addr.lat || 8.9824,
      lng: addr.lng || -79.5199,
      text: addr.addr
    };

    // Información del delivery calculado por distancia
    const deliveryMeta = {
      fee: deliveryFee.toFixed(2),
      distKm: distanciaKm.toFixed(1),
      label: deliveryLabel,
    };

    const orderId = onConfirm
      ? onConfirm(cart, pay==="yappy"?"YAPPY":"CASH", direccionFinal, deliveryMeta)
      : `CH-${2408+Math.floor(Math.random()*99)}`;
    setCart([]);
    nav({screen:"confirmacion", orderId: orderId||`CH-${Math.floor(Math.random()*9000+1000)}`});
  };

  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--gold)",letterSpacing:2,marginBottom:14}}>CONFIRMAR PEDIDO</div>
      <div className="row" style={{justifyContent:"center",gap:6,marginBottom:18}}>
        {[["1","Dirección"],["2","Pago"],["3","Confirmar"]].map(([n,l])=>(
          <div key={n} className="row" style={{gap:4,alignItems:"center"}}>
            <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
              <div style={{width:26,height:26,borderRadius:"50%",background:step>=+n?"var(--gold)":"var(--bg3)",border:`2px solid ${step>=+n?"var(--gold)":"var(--border)"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:10,fontWeight:800,color:step>=+n?"#08111F":"var(--muted)"}}>
                {step>+n?<Ic n="check" s={12} c="#08111F"/>:n}
              </div>
              <div style={{fontSize:8,color:step>=+n?"var(--gold)":"var(--muted)",fontWeight:700,marginTop:3}}>{l}</div>
            </div>
            {+n<3&&<div style={{width:26,height:1,background:step>+n?"var(--gold)":"var(--border)",marginBottom:12}}/>}
          </div>
        ))}
      </div>
      {step===1&&<div className="fu">
        <div className="sec">Dirección de Entrega</div>

        {/* OPCIÓN GPS: Usar ubicación actual */}
        <div
          className="card"
          style={{
            cursor:"pointer",
            border: usarGPS ? "1.5px solid rgba(0,229,160,.5)" : "1px solid var(--border)",
            background: usarGPS ? "rgba(0,229,160,.06)" : "var(--bg2)",
            marginBottom:8,
          }}
          onClick={() => { if (!usarGPS && !gpsLoading) capturarGPS(); }}
        >
          <div className="row" style={{justifyContent:"space-between"}}>
            <div className="row" style={{gap:9, flex:1}}>
              <span style={{fontSize:22}}>📍</span>
              <div style={{flex:1}}>
                <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>Mi ubicación actual</div>
                {gpsLoading && (
                  <div style={{fontSize:11,color:"var(--gold)"}}>🔄 Obteniendo GPS...</div>
                )}
                {gpsError && (
                  <div style={{fontSize:11,color:"var(--red)",lineHeight:1.3}}>⚠️ {gpsError}</div>
                )}
                {ubicGPS && !gpsLoading && (
                  <div style={{fontSize:10,color:"var(--green)",lineHeight:1.4}}>
                    ✅ GPS activo · Precisión: {Math.round(ubicGPS.precision)}m
                  </div>
                )}
                {!gpsLoading && !ubicGPS && !gpsError && (
                  <div style={{fontSize:11,color:"var(--muted)",lineHeight:1.4}}>Toca para usar GPS · más preciso para el repartidor</div>
                )}
              </div>
            </div>
            <div style={{
              width:18,height:18,borderRadius:"50%",
              border:`2px solid ${usarGPS?"var(--green)":"var(--border)"}`,
              display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0
            }}>
              {usarGPS && <div style={{width:9,height:9,borderRadius:"50%",background:"var(--green)"}}/>}
            </div>
          </div>

          {/* Mapa preview cuando hay GPS */}
          {usarGPS && ubicGPS && (
            <div style={{marginTop:10}} onClick={(e)=>e.stopPropagation()}>
              <div style={{fontSize:10,color:"var(--gold)",marginBottom:6,fontWeight:700,textAlign:"center"}}>
                ✋ Arrastra el pin o toca el mapa para ajustar tu ubicación exacta
              </div>
              <MapaLeaflet
                center={[ubicGPS.lat, ubicGPS.lng]}
                zoom={17}
                markers={[{
                  type: 'comprador',
                  lat: ubicGPS.lat,
                  lng: ubicGPS.lng,
                  label: 'Tu ubicación',
                  popup: '<b>📍 Aquí entregar</b>'
                }]}
                draggablePinIndex={0}
                onPinMove={(nuevaPos) => {
                  setUbicGPS(prev => ({
                    ...prev,
                    lat: nuevaPos.lat,
                    lng: nuevaPos.lng,
                  }));
                }}
                height={200}
              />
              <div style={{marginTop:10}}>
                <div style={{fontSize:10,color:"var(--muted)",marginBottom:5,fontWeight:700}}>
                  Referencia adicional (opcional)
                </div>
                <input
                  type="text"
                  value={textoUbicacion}
                  onChange={e=>setTextoUbicacion(e.target.value)}
                  placeholder="Ej: Apto 5B · Edificio azul · 2do piso"
                  style={{
                    width:"100%",
                    padding:"9px 12px",
                    background:"var(--bg3)",
                    border:"1px solid var(--border)",
                    borderRadius:9,
                    color:"var(--text)",
                    fontSize:12,
                    fontFamily:"'DM Sans'",
                    outline:"none"
                  }}
                  onClick={e=>e.stopPropagation()}
                />
              </div>
              <button
                onClick={(e)=>{e.stopPropagation(); capturarGPS();}}
                style={{
                  marginTop:8,
                  padding:"6px 11px",
                  background:"rgba(244,196,48,.1)",
                  border:"1px solid rgba(244,196,48,.3)",
                  borderRadius:8,
                  color:"var(--gold)",
                  fontSize:10,
                  fontWeight:700,
                  cursor:"pointer",
                  fontFamily:"'DM Sans'"
                }}
              >
                🔄 Volver a usar mi ubicación GPS
              </button>
            </div>
          )}
        </div>

        {/* Separador "O usar dirección guardada" */}
        <div style={{display:"flex",alignItems:"center",gap:10,margin:"4px 0 8px"}}>
          <div style={{flex:1,height:1,background:"var(--border)"}}/>
          <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,letterSpacing:1}}>O DIRECCIÓN GUARDADA</div>
          <div style={{flex:1,height:1,background:"var(--border)"}}/>
        </div>

        {ADDRESSES.map(a=>(
          <div key={a.id} className="card" style={{cursor:"pointer",border:`1px solid ${!usarGPS && addr.id===a.id?"rgba(244,196,48,.4)":"var(--border)"}`,background:!usarGPS && addr.id===a.id?"rgba(244,196,48,.04)":"var(--bg2)",marginBottom:8,opacity: usarGPS ? 0.55 : 1}} onClick={()=>{ setAddr(a); setUsarGPS(false); }}>
            <div className="row" style={{justifyContent:"space-between"}}>
              <div className="row" style={{gap:9}}>
                <span style={{fontSize:22}}>{a.icon}</span>
                <div><div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>{a.label}</div><div style={{fontSize:11,color:"var(--muted)",lineHeight:1.4}}>{a.addr}</div></div>
              </div>
              <div style={{width:18,height:18,borderRadius:"50%",border:`2px solid ${!usarGPS && addr.id===a.id?"var(--gold)":"var(--border)"}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {!usarGPS && addr.id===a.id&&<div style={{width:9,height:9,borderRadius:"50%",background:"var(--gold)"}}/>}
              </div>
            </div>
          </div>
        ))}
        <button
          className="btn"
          style={{marginTop:6, opacity: (usarGPS && !ubicGPS) ? 0.5 : 1}}
          disabled={usarGPS && !ubicGPS}
          onClick={()=>setStep(2)}
        >
          {usarGPS && !ubicGPS ? "Esperando GPS..." : "Continuar →"}
        </button>
      </div>}
      {step===2&&<div className="fu">
        <div className="sec">Método de Pago (Contra Entrega)</div>
        {METHODS.map(m=>(
          <div key={m.id} className="card" style={{cursor:"pointer",border:`1px solid ${pay===m.id?"rgba(244,196,48,.4)":"var(--border)"}`,background:pay===m.id?"rgba(244,196,48,.04)":"var(--bg2)",marginBottom:7}} onClick={()=>setPay(m.id)}>
            <div className="row" style={{justifyContent:"space-between"}}>
              <div className="row" style={{gap:10}}>
                <span style={{fontSize:24}}>{m.icon}</span>
                <div>
                  <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>{m.l}</div>
                  <div style={{fontSize:11,color:"var(--muted)"}}>{m.sub}</div>
                </div>
              </div>
              <div style={{width:18,height:18,borderRadius:"50%",border:`2px solid ${pay===m.id?"var(--gold)":"var(--border)"}`,display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                {pay===m.id&&<div style={{width:9,height:9,borderRadius:"50%",background:"var(--gold)"}}/>}
              </div>
            </div>
          </div>
        ))}
        {pay==="yappy"&&(
          <div style={{background:"rgba(59,158,255,.06)",border:"1px solid rgba(59,158,255,.2)",borderRadius:11,padding:"9px 13px",marginBottom:10,display:"flex",gap:8,alignItems:"flex-start"}}>
            <Ic n="zap" s={14} c="var(--blue)"/>
            <span style={{fontSize:11,color:"var(--muted)",lineHeight:1.5}}>Yappy es recomendado — sin comisión bancaria (3%+). El QR se genera al entregar.</span>
          </div>
        )}
        <div className="row" style={{gap:7,marginTop:8}}>
          <button className="btng" style={{flex:1}} onClick={()=>setStep(1)}>← Atrás</button>
          <button className="btn" style={{flex:2}} onClick={()=>setStep(3)}>Continuar →</button>
        </div>
      </div>}
      {step===3&&<div className="fu">
        <div className="sec">Resumen Final</div>
        <div className="card">
          {cart.map((item,i)=>(
            <div key={item.id}>
              <div className="row" style={{justifyContent:"space-between",padding:"3px 0"}}>
                <div>
                  <div className="row" style={{gap:6}}>
                    {item.type==="billete"?<span className="tag-b">BILLETE</span>:<span className="tag-c">CHANCE</span>}
                    <span style={{fontFamily:"'Bebas Neue'",fontSize:17,color:"var(--gold)",letterSpacing:1}}>{item.type==="billete"?"Nº ":"#"}{item.num}</span>
                  </div>
                  <div style={{fontSize:10,color:"var(--muted)"}}>{item.vendor} · ×{item.qty}</div>
                </div>
                <div style={{fontWeight:700,fontSize:13}}>${(item.price*item.qty).toFixed(2)}</div>
              </div>
              {i<cart.length-1&&<div className="div" style={{margin:"5px 0"}}/>}
            </div>
          ))}
          <div className="div"/>
          {[
            {l:"Service fee (App)",v:`$${serviceFee.toFixed(2)}`,sub:null},
            {l:"Delivery",v:`$${deliveryFee.toFixed(2)}`,sub:`${deliveryLabel} · ${distanciaKm.toFixed(1)} km`},
          ].map(({l,v,sub})=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:5,alignItems:"flex-start"}}>
              <div style={{flex:1}}>
                <span style={{fontSize:12,color:"var(--muted)"}}>{l}</span>
                {sub&&<div style={{fontSize:9,color:"var(--muted)",opacity:.7}}>{sub}</div>}
              </div>
              <span style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>{v}</span>
            </div>
          ))}
          <div className="div" style={{margin:"6px 0"}}/>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <span style={{fontWeight:800,color:"var(--text)"}}>TOTAL</span>
            <span style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--gold)",letterSpacing:1}}>${total.toFixed(2)}</span>
          </div>
        </div>
        {/* Desglose del motor de pagos */}
        <div className="card" style={{background:"rgba(0,214,143,.04)",border:"1px solid rgba(0,214,143,.18)",marginBottom:7}}>
          <div className="sec" style={{marginBottom:8}}>Distribución de este pago</div>
          {[
            {l:`Vendedor recibe (−2.5% comisión)`, v:`$${totals.vendorReceives}`, c:"var(--gold)"},
            {l:"Repartidor recibe (delivery)",      v:`$${totals.driverEarnings}`,c:"var(--blue)"},
            {l:"App (comisión 2.5% + service fee)", v:`$${totals.appEarnings}`,   c:"var(--green)"},
          ].map(({l,v,c})=>(
            <div key={l} className="row" style={{justifyContent:"space-between",marginBottom:5}}>
              <span style={{fontSize:11,color:"var(--muted)",flex:1}}>{l}</span>
              <span style={{fontSize:12,fontWeight:800,color:c,flexShrink:0}}>{v}</span>
            </div>
          ))}
        </div>
        <div className="card" style={{marginBottom:7}}>
          <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>Entrega en</div>
          {usarGPS && ubicGPS ? (
            <>
              <div style={{fontSize:12,fontWeight:600,color:"var(--text)"}}>
                📍 {textoUbicacion || "Mi ubicación actual"}
              </div>
              <div style={{fontSize:10,color:"var(--green)",marginTop:3}}>
                ✅ GPS · {ubicGPS.lat.toFixed(5)}, {ubicGPS.lng.toFixed(5)}
              </div>
            </>
          ) : (
            <div style={{fontSize:12,fontWeight:600,color:"var(--text)"}}>{addr.icon} {addr.label} — {addr.addr}</div>
          )}
        </div>
        <div className="card" style={{marginBottom:12}}>
          <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>Pago al recibir</div>
          <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>{METHODS.find(m=>m.id===pay)?.icon} {METHODS.find(m=>m.id===pay)?.l}</div>
          {pay==="efectivo"&&(
            <div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>Ten listo <strong style={{color:"var(--gold)"}}>${total.toFixed(2)}</strong> en efectivo</div>
          )}
          {pay==="yappy"&&(
            <div style={{fontSize:10,color:"var(--blue)",marginTop:4}}>El repartidor generará el QR al momento de la entrega</div>
          )}
        </div>
        <div className="row" style={{gap:7}}>
          <button className="btng" style={{flex:1}} onClick={()=>setStep(2)}>← Atrás</button>
          <button className="btn" style={{flex:2}} onClick={place}>¡Realizar Pedido!</button>
        </div>
      </div>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   CONFIRMACIÓN + TRACKING + HISTORIAL
═══════════════════════════════════════════════════════ */
function ConfirmacionScreen({ orderId, nav }) {
  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",padding:26,textAlign:"center"}} className="fu">
      <div style={{width:84,height:84,borderRadius:"50%",background:"rgba(0,214,143,.1)",border:"2px solid var(--green)",display:"flex",alignItems:"center",justifyContent:"center",marginBottom:16,fontSize:38}} className="pop">✓</div>
      <div style={{fontFamily:"'Bebas Neue'",fontSize:44,color:"var(--gold)",letterSpacing:5,marginBottom:4}}>¡LISTO!</div>
      <div style={{fontSize:13,color:"var(--muted)",marginBottom:7}}>Tu pedido fue confirmado</div>
      <div style={{background:"var(--bg3)",borderRadius:11,padding:"7px 18px",marginBottom:20}}>
        <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,letterSpacing:1}}>PEDIDO</div>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:"var(--gold)",letterSpacing:3}}>#{orderId}</div>
      </div>
      <button className="btn" style={{width:"100%",marginBottom:8}} onClick={()=>nav("tracking")}>🛵 Seguir mi pedido</button>
      <button className="btng" style={{width:"100%"}} onClick={()=>nav("home_cliente")}>Volver al inicio</button>
    </div>
  );
}

function TrackingScreen({ order }) {
  // Tracking en tiempo real del repartidor desde Firebase
  const ubicRepartidor = useUbicacionUsuario(order?.repartidorId || "repartidor_juan");

  // Coordenadas del comprador (ubicación de entrega que eligió en el pedido)
  const ubicComprador = order?.deliveryAddress?.lat
    ? { lat: order.deliveryAddress.lat, lng: order.deliveryAddress.lng }
    : { lat: 8.9824, lng: -79.5199 };

  // ─── Coordenadas del vendedor (ubicación REAL desde Firebase, aproximada por privacidad) ───
  // Prioridad de fuentes:
  //   1. GPS en vivo del vendedor desde Firebase (más reciente)
  //   2. Coords guardadas con el pedido (vendorLat/vendorLng al momento de crear)
  //   3. Coords estáticas del lookup (solo demos legacy V001/V002)
  const vendedorIdReal = order?.vendorUserId || "vendedor_carlos";
  const ubicVendedorFB = useUbicacionUsuario(vendedorIdReal);
  const vendorStatic = getVendorCoords(order?.vendorId || "V001");

  // Cuando hay GPS en vivo, derivamos un texto de zona aproximada del CORREGIMIENTO real
  // del vendedor (de su perfil), no del campo estático "zone" que apunta a otra zona.
  // El profile.lugarVende generalmente refleja "Calle X, Corregimiento" donde realmente está.
  const zonaAproxFromGPS = order?.vendorZone || order?.vendorLugar || vendorStatic.zone;

  let vendorCoords;
  if (ubicVendedorFB && ubicVendedorFB.lat && ubicVendedorFB.lng) {
    // Prioridad 1: GPS en vivo (vendedor activo ahora)
    vendorCoords = { lat: ubicVendedorFB.lat, lng: ubicVendedorFB.lng, zone: zonaAproxFromGPS, name: vendorStatic.name, address: vendorStatic.address, phone: vendorStatic.phone, fuente: "GPS" };
  } else if (order?.vendorLat && order?.vendorLng) {
    // Prioridad 2: coords guardadas con el pedido (al momento de crearlo)
    vendorCoords = { lat: order.vendorLat, lng: order.vendorLng, zone: zonaAproxFromGPS, name: vendorStatic.name, address: vendorStatic.address, phone: vendorStatic.phone, fuente: "order" };
  } else {
    // Prioridad 3: lookup estático (demos legacy)
    vendorCoords = { ...vendorStatic, fuente: "static" };
  }

  // Estado: ¿ya hay un repartidor asignado y en camino al vendedor?
  // pickupStarted = repartidor presionó "Iniciar recogida" → ya está en camino al vendedor
  const repartidorAsignado = order?.pickupStarted === true; // ya tiene repartidor asignado
  const repartidorEnCamino = order?.status === "EN_CAMINO"; // ya recogió, va al cliente
  const repartidorActivo   = repartidorAsignado || order?.status === "EN_CAMINO" || order?.status === "ENTREGADO";

  // Construir markers según el estado del pedido
  // Mientras NO está EN_CAMINO: mostrar Vendedor (aproximado) + Comprador
  // Cuando EN_CAMINO: mostrar Repartidor en vivo + Comprador (vendedor ya no aparece)
  const markers = [];
  const circles = [];

  // Marker del comprador (siempre visible — entregar aquí)
  markers.push({
    type: 'comprador', lat: ubicComprador.lat, lng: ubicComprador.lng,
    label: 'Tu ubicación', popup: `<b>📍 Entregar aquí</b><br/>${order?.deliveryAddress?.text || 'Tu dirección'}`
  });

  // Vendedor: solo se muestra mientras NO hay repartidor en camino
  // Aparece como CÍRCULO grande de zona aproximada (~900m radio) por privacidad estilo Airbnb.
  // ▸ Aplicamos un offset determinista al centro del círculo (basado en orderId)
  //   para que el vendedor NUNCA esté en el centro exacto del círculo. Su ubicación real
  //   queda en algún punto interno del círculo, indeterminado para el comprador.
  // ▸ NO mostramos marker exacto del vendedor (solo el círculo + un marker invisible
  //   para el popup informativo, ubicado en el centro del círculo desplazado).
  if (!repartidorActivo && order && (order.status === "PENDIENTE" || order.status === "APROBADO")) {
    // Offset determinista por orderId: ~150-300m en cualquier dirección
    const seed = (order.id || "CH-2400").split("").reduce((s,c)=>s+c.charCodeAt(0),0);
    const angRad = (seed % 360) * Math.PI / 180;
    const distOffsetDeg = 0.0020 + ((seed * 13) % 100) / 100000; // ~220-330m
    const centroDesplazadoLat = vendorCoords.lat + Math.sin(angRad) * distOffsetDeg;
    const centroDesplazadoLng = vendorCoords.lng + Math.cos(angRad) * distOffsetDeg;

    circles.push({
      lat: centroDesplazadoLat, lng: centroDesplazadoLng,
      radius: 900,                  // 900m de radio, área amplia tipo Airbnb
      color: '#00E5A0',
      label: `🏪 Zona del vendedor`,
    });
    // Marker invisible (radio 0) solo para que el popup aparezca al tocar el círculo
    markers.push({
      type: 'vendedor', lat: centroDesplazadoLat, lng: centroDesplazadoLng,
      label: 'Zona aproximada',
      hidden: true,                 // no renderizar el icono del marker
      popup: `<b>🏪 ${order?.vendor || vendorCoords.name || 'Vendedor'}</b><br/>📍 ${vendorCoords.zone}<br/><i>Ubicación aproximada por privacidad</i>${vendorCoords.fuente === "GPS" ? '<br/>📡 Posición en vivo' : ''}`
    });
  }

  // Marker del repartidor: aparece SOLO cuando está EN_CAMINO
  if (ubicRepartidor && ubicRepartidor.lat && ubicRepartidor.lng && order?.status === "EN_CAMINO") {
    const tiempoUlt = ubicRepartidor.timestamp ? Math.round((Date.now() - ubicRepartidor.timestamp) / 60000) : null;
    markers.push({
      type: 'repartidor', lat: ubicRepartidor.lat, lng: ubicRepartidor.lng,
      label: ubicRepartidor.activo ? 'Repartidor en vivo' : 'Última ubicación',
      popup: `<b>🛵 ${order?.repartidorName || 'Juan Rodríguez'}</b><br/>${ubicRepartidor.activo ? `Velocidad: ${ubicRepartidor.velocidad || 0} km/h` : `Hace ${tiempoUlt || 0} min`}`
    });
  }

  // Calcular ETA si tenemos ubicación del repartidor
  let etaMin = null;
  if (ubicRepartidor && ubicRepartidor.lat && order?.status === "EN_CAMINO") {
    const distKm = calcularDistancia(ubicRepartidor.lat, ubicRepartidor.lng, ubicComprador.lat, ubicComprador.lng);
    etaMin = calcularETA(distKm, ubicRepartidor.velocidad > 5 ? ubicRepartidor.velocidad : 25);
  }

  // Ruta del repartidor al comprador (línea recta como referencia)
  const route = (ubicRepartidor && ubicRepartidor.lat && order?.status === "EN_CAMINO")
    ? [[ubicRepartidor.lat, ubicRepartidor.lng], [ubicComprador.lat, ubicComprador.lng]]
    : null;

  const statusSteps = [
    {l:"Pedido confirmado",   key:"PENDIENTE",  ic:"check",  done:true},
    {l:"Vendedor preparando", key:"APROBADO",   ic:"pkg",    done:order&&["APROBADO","EN_CAMINO","ENTREGADO"].includes(order.status)},
    // "Repartidor asignado" se completa cuando el repartidor presiona "Iniciar recogida"
    // (pickupStarted=true) o cuando ya pasó a EN_CAMINO/ENTREGADO
    {l:"Repartidor asignado", key:"ASIGNADO",   ic:"truck",  done:order&&(order.pickupStarted===true||["EN_CAMINO","ENTREGADO"].includes(order.status))},
    // "En camino" sólo cuando ya recogió y va hacia el cliente
    {l:"En camino 🛵",        key:"EN_CAMINO",  ic:"truck",  done:order&&["EN_CAMINO","ENTREGADO"].includes(order.status), act:order?.status==="EN_CAMINO"},
    {l:"Entregado",           key:"ENTREGADO",  ic:"check",  done:order?.status==="ENTREGADO"},
  ];
  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--gold)",letterSpacing:2,marginBottom:10}}>SEGUIMIENTO</div>
      {order&&(
        <div style={{background:"rgba(0,214,143,.06)",border:"1px solid rgba(0,214,143,.2)",borderRadius:11,padding:"9px 13px",marginBottom:10}}>
          <div style={{fontWeight:800,fontSize:13,color:"var(--text)"}}>
            {order.type==="billete"?"🎟 Billete Nº ":"⚡ Chance #"}{order.num}
          </div>
          <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>
            {order.vendor||"Carlos Medina V001"} · {order.paymentMethod==="YAPPY"?"📱 Yappy":"💵 Efectivo"} · Pedido {order.id}
          </div>
        </div>
      )}

      {/* Mapa real con Leaflet + tracking en vivo */}
      {/* Centrado inteligente: mientras prepara, centra en vendedor; en camino, centra en comprador */}
      <div style={{position:"relative", marginBottom:10}}>
        <MapaLeaflet
          center={!repartidorActivo && order && (order.status === "PENDIENTE" || order.status === "APROBADO")
            ? [vendorCoords.lat, vendorCoords.lng]
            : [ubicComprador.lat, ubicComprador.lng]}
          zoom={14}
          markers={markers}
          route={route}
          circles={circles}
          height={250}
        />
        <div style={{position:"absolute",top:10,left:10,background:"rgba(8,17,31,.92)",borderRadius:9,padding:"6px 11px",border:`1px solid ${order?.status==="ENTREGADO"?"rgba(0,229,160,.4)":order?.status==="EN_CAMINO"?"rgba(244,196,48,.4)":"rgba(147,173,204,.3)"}`,zIndex:500,pointerEvents:'none'}}>
          <div style={{fontSize:10,color:order?.status==="ENTREGADO"?"var(--green)":"var(--gold)",fontWeight:800}}>
            {order?.status==="ENTREGADO"?"✅ ENTREGADO":
             order?.status==="EN_CAMINO"&&etaMin!==null?`🛵 EN CAMINO · ${etaMin} min`:
             order?.status==="EN_CAMINO"?"🛵 EN CAMINO · activando GPS...":
             "⏳ PREPARANDO"}
          </div>
        </div>
        {ubicRepartidor && ubicRepartidor.lat && order?.status === "EN_CAMINO" && (
          <div style={{position:"absolute",bottom:10,right:10,background:"rgba(8,17,31,.92)",borderRadius:9,padding:"5px 9px",border:`1px solid ${ubicRepartidor.activo ? "rgba(0,229,160,.3)" : "rgba(255,204,51,.3)"}`,zIndex:500,pointerEvents:'none'}}>
            <div style={{fontSize:9,color: ubicRepartidor.activo ? "var(--green)" : "var(--gold)",fontWeight:700}}>
              {ubicRepartidor.activo ? "● EN VIVO" : "⏸ PAUSADO"}
            </div>
          </div>
        )}
      </div>
      {/* Tarjeta del Repartidor: SOLO visible cuando está asignado (EN_CAMINO o ENTREGADO) */}
      {repartidorActivo && (
      <div className="card" style={{marginBottom:10}}>
        <div style={{fontSize:9,color:"var(--muted)",fontWeight:800,letterSpacing:1.5,marginBottom:6}}>REPARTIDOR ASIGNADO</div>
        <div className="row" style={{justifyContent:"space-between",marginBottom:9}}>
          <div className="row" style={{gap:9}}>
            <div style={{width:40,height:40,borderRadius:11,background:"rgba(59,158,255,.1)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"'Bebas Neue'",fontSize:13,color:"var(--blue)",flexShrink:0}}>JR</div>
            <div>
              <div style={{fontWeight:800,fontSize:13,color:"var(--text)"}}>Juan Rodríguez <span className="badge bg" style={{fontSize:8}}>✅</span></div>
              <div style={{fontSize:10,color:"var(--muted)"}}>⭐ 4.8 · 342 entregas</div>
              <div style={{fontSize:10,color:"var(--blue)",fontWeight:700,marginTop:2}}>📞 6333-4444</div>
            </div>
          </div>
        </div>
        {/* Botones de comunicación */}
        {order?.status==="EN_CAMINO"&&(
          <div style={{display:"flex",gap:6,marginTop:6}}>
            <a href="tel:+5076333-4444" style={{flex:1,padding:"9px",borderRadius:9,background:"rgba(0,214,143,.1)",border:"1px solid rgba(0,214,143,.3)",color:"var(--green)",fontSize:11,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
              📞 Llamar
            </a>
            <a href="https://wa.me/50763334444" target="_blank" rel="noopener" style={{flex:1,padding:"9px",borderRadius:9,background:"rgba(0,214,143,.1)",border:"1px solid rgba(0,214,143,.3)",color:"var(--green)",fontSize:11,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
              💬 WhatsApp
            </a>
            <a href="sms:+5076333-4444" style={{flex:1,padding:"9px",borderRadius:9,background:"rgba(59,158,255,.1)",border:"1px solid rgba(59,158,255,.3)",color:"var(--blue)",fontSize:11,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
              📩 SMS
            </a>
          </div>
        )}
      </div>
      )}
      {/* Mensaje informativo: cambia según fase */}
      {!repartidorEnCamino && order && (
      <div className="card" style={{marginBottom:10, background: repartidorAsignado ? "rgba(59,158,255,.06)" : "rgba(244,196,48,.06)", border: `1px solid ${repartidorAsignado ? "rgba(59,158,255,.25)" : "rgba(244,196,48,.2)"}`}}>
        <div className="row" style={{gap:10,alignItems:"center"}}>
          <div style={{fontSize:24}}>{repartidorAsignado ? "🛵" : "⏳"}</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:12,color: repartidorAsignado ? "var(--blue)" : "var(--gold)"}}>
              {repartidorAsignado ? "Repartidor asignado · En camino a recoger" : "Esperando asignación de repartidor"}
            </div>
            <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>
              {repartidorAsignado
                ? "Tu repartidor va al vendedor a recoger tu pedido"
                : (order?.status === "PENDIENTE" ? "El vendedor está revisando tu pedido…" : "El vendedor ya aprobó. Asignando repartidor…")}
            </div>
          </div>
        </div>
      </div>
      )}
      <div className="card">
        <div className="sec" style={{marginBottom:12}}>Estado del Pedido</div>
        {statusSteps.map((s,i,arr)=>{
          const isDone = s.done;
          const isAct  = s.act;
          const isPend = !isDone&&!isAct;
          return (
            <div key={s.l+i}>
              <div className="row" style={{gap:9}}>
                <div className={`tld ${isDone?"done":isAct?"act":"pend"}`}>
                  {isDone?<Ic n="check" s={13} c="var(--green)"/>:isAct?"🛵":<div style={{width:7,height:7,borderRadius:"50%",background:"var(--border)"}}/>}
                </div>
                <div style={{flex:1,paddingBottom:i<arr.length-1?12:0}}>
                  <div style={{fontWeight:isAct?800:500,fontSize:12,color:isPend?"var(--muted)":"var(--text)"}}>{s.l}</div>
                  <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>
                    {isDone?"✓ Completado":isAct?"En progreso...":"Pendiente"}
                  </div>
                </div>
              </div>
              {i<arr.length-1&&<div style={{width:2,height:10,background:isDone?"rgba(0,214,143,.3)":"var(--border)",margin:"2px 0 2px 14px"}}/>}
            </div>
          );
        })}
      </div>
      {!order&&(
        <div style={{textAlign:"center",padding:"16px 0",opacity:.5}}>
          <div style={{fontSize:11,color:"var(--muted)"}}>Realiza un pedido para ver el seguimiento en vivo</div>
        </div>
      )}
    </div>
  );
}

function HistorialScreen({ nav, orders=[], onClientApprove, onClientReject, onProposeReplacement, sharedVendor }) {
  const [f,setF]=useState("todos");
  const [replacingOrder, setReplacingOrder] = useState(null);  // orderId buscando reemplazo
  const [replaceNum, setReplaceNum]         = useState("");
  const [replaceType, setReplaceType]       = useState("billete");
  const [replaceQty, setReplaceQty]         = useState(1);

  const realOrders = orders.length>0 ? orders : [
    {id:"CH-2398",createdAt:"Ayer",num:"07",type:"chance",lotteryValue:"0.25",deliveryFee:"2.50",tip:"0",paymentMethod:"YAPPY",status:"ENTREGADO"},
  ];
  const stMap={
    EN_CAMINO:          {l:"En Camino",         cls:"by",ic:"🛵"},
    APROBADO:           {l:"Aprobado",          cls:"bb",ic:"✅"},
    PENDIENTE:          {l:"Pendiente",         cls:"bb",ic:"⏳"},
    MODIFICADO:         {l:"Modificado",        cls:"br",ic:"⚠️"},
    REEMPLAZO:          {l:"Reemplazo enviado", cls:"bb",ic:"🔄"},
    ENTREGADO:          {l:"Entregado",         cls:"bg",ic:"✅"},
    CANCELADO:          {l:"Cancelado",         cls:"br",ic:"❌"},
    CANCELADO_VENDEDOR: {l:"Cancelado por vendedor", cls:"br",ic:"🚫"},
  };
  const fil=realOrders.filter(o=>{
    const s=o.status?.toUpperCase();
    if(f==="todos")      return true;
    if(f==="activos")    return ["PENDIENTE","APROBADO","EN_CAMINO","MODIFICADO","REEMPLAZO"].includes(s);
    if(f==="entregados") return s==="ENTREGADO";
    if(f==="cancelados") return s==="CANCELADO";
    return true;
  }).sort((a,b)=>{
    // Más reciente primero. Usa createdAtMs (numérico) si existe; cae a parsear
    // el id "CH-2408" como tiebreaker (mayor número = más reciente)
    const aMs = typeof a.createdAtMs==='number' ? a.createdAtMs : 0;
    const bMs = typeof b.createdAtMs==='number' ? b.createdAtMs : 0;
    if (bMs !== aMs) return bMs - aMs;
    const aId = parseInt((a.id||'').replace(/\D/g,''))||0;
    const bId = parseInt((b.id||'').replace(/\D/g,''))||0;
    return bId - aId;
  });
  const totalAmt = o => {
    try{return '$'+(parseFloat(o.lotteryValue||0)+1+parseFloat(o.deliveryFee||0)).toFixed(2);}catch{return "$0.00";}
  };
  const modifiedCount = realOrders.filter(o=>o.status==="MODIFICADO").length;

  // Números disponibles en el vendedor para reemplazo
  const availBilletes = (sharedVendor?.billetes||[]).filter(b=>b.sold<b.stock);
  const availChances  = (sharedVendor?.chances||[]).filter(c=>c.sold<c.stock);
  const availNums     = replaceType==="billete" ? availBilletes : availChances;

  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:2,marginBottom:10}}>MIS PEDIDOS</div>

      {/* Alerta de pedido modificado */}
      {modifiedCount>0&&(
        <div style={{background:"rgba(255,75,110,.08)",border:"1px solid rgba(255,75,110,.3)",borderRadius:12,padding:"10px 14px",marginBottom:12,display:"flex",gap:10,alignItems:"flex-start"}}>
          <span style={{fontSize:20,flexShrink:0}}>⚠️</span>
          <div>
            <div style={{fontSize:12,fontWeight:800,color:"var(--red)",marginBottom:2}}>
              {modifiedCount} pedido(s) con cambios del vendedor
            </div>
            <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5}}>
              El vendedor ajustó tu pedido. Revísalo y aprueba o busca un número de reemplazo.
            </div>
          </div>
        </div>
      )}

      <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4,scrollbarWidth:"none",marginBottom:12}}>
        {["todos","activos","entregados","cancelados"].map(t=>(
          <button key={t} className={`chip ${f===t?"on":""}`} style={{flexShrink:0,textTransform:"capitalize"}} onClick={()=>setF(t)}>
            {t}{t==="activos"&&realOrders.filter(o=>["PENDIENTE","APROBADO","EN_CAMINO","MODIFICADO"].includes(o.status?.toUpperCase())).length>0&&
              ` (${realOrders.filter(o=>["PENDIENTE","APROBADO","EN_CAMINO","MODIFICADO"].includes(o.status?.toUpperCase())).length})`}
          </button>
        ))}
      </div>

      {fil.length===0?(
        <div style={{textAlign:"center",padding:"32px 0",opacity:.6}}>
          <div style={{fontSize:36,marginBottom:8}}>📋</div>
          <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Sin pedidos en esta categoría</div>
        </div>
      ):fil.map(o=>{
        const st=stMap[o.status?.toUpperCase()]||stMap[o.status]||{l:o.status||"—",cls:"bb",ic:"•"};
        const isActive      = ["PENDIENTE","APROBADO","EN_CAMINO"].includes(o.status?.toUpperCase());
        const isModified    = o.status==="MODIFICADO";
        const isReplSent    = o.status==="REEMPLAZO";   // cliente propuso, esperando vendedor
        const isReplacing   = replacingOrder===o.id;
        const roundLabel    = o.round>1 ? ` · Vuelta #${o.round}` : "";
        const itemList   = o.items||[{type:o.type,num:o.num,qty:o.qty||1,subtotal:o.lotteryValue||"1.00"}];

        return (
          <div key={o.id} className="card" style={{marginBottom:10,border:isModified?"1px solid rgba(255,75,110,.4)":"1px solid var(--border)",background:isModified?"rgba(255,75,110,.03)":"var(--bg2)"}}>
            <div className="row" style={{justifyContent:"space-between",marginBottom:7}}>
              <div>
                <div style={{fontSize:10,color:"var(--muted)",fontWeight:700}}>#{o.id} · {o.createdAt||"—"}</div>
                {o.modifiedAt&&<div style={{fontSize:9,color:"var(--red)"}}>Modificado a las {o.modifiedAt}</div>}
              </div>
              <span className={`badge ${st.cls}`}>{st.ic} {st.l}</span>
            </div>

            {/* Items del pedido */}
            <div style={{background:"var(--bg3)",borderRadius:9,padding:"8px 10px",marginBottom:8}}>
              {itemList.map((item,idx)=>{
                const wasRemoved = o.removedItems?.find(r=>r.num===item.num);
                return (
                  <div key={idx} style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:idx<itemList.length-1?5:0,marginBottom:idx<itemList.length-1?5:0,borderBottom:idx<itemList.length-1?"1px solid rgba(255,255,255,.05)":"none"}}>
                    <div style={{display:"flex",gap:5,alignItems:"center"}}>
                      {item.type==="billete"?<span className="tag-b">BILLETE</span>:<span className="tag-c">CHANCE</span>}
                      <span style={{fontFamily:"'Bebas Neue'",fontSize:14,color:"var(--gold)",letterSpacing:1}}>
                        {item.type==="billete"?"Nº ":"#"}{item.num}
                      </span>
                      {(item.qty||1)>1&&<span style={{fontSize:9,color:"var(--muted)"}}>×{item.qty}</span>}
                    </div>
                    <span style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>${item.subtotal}</span>
                  </div>
                );
              })}

              {/* Items eliminados/reducidos por el vendedor */}
              {isModified&&o.removedItems?.length>0&&(
                <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid rgba(255,75,110,.2)"}}>
                  <div style={{fontSize:9,color:"var(--red)",fontWeight:800,marginBottom:4}}>ELIMINADOS / REDUCIDOS POR EL VENDEDOR:</div>
                  {o.removedItems.map((item,idx)=>(
                    <div key={idx} style={{display:"flex",gap:5,alignItems:"center",opacity:.6,textDecoration:"line-through",marginBottom:2}}>
                      {item.type==="billete"?<span className="tag-b" style={{fontSize:8}}>BILLETE</span>:<span className="tag-c" style={{fontSize:8}}>CHANCE</span>}
                      <span style={{fontFamily:"'Bebas Neue'",fontSize:12,color:"var(--red)",letterSpacing:1}}>{item.type==="billete"?"Nº ":"#"}{item.num}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Nota del vendedor */}
              {o.vendorNote&&<div style={{fontSize:9,color:"var(--gold)",marginTop:6,fontStyle:"italic"}}>💬 "{o.vendorNote}"</div>}
            </div>

            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:isModified?10:0}}>
              <div style={{fontSize:10,color:"var(--muted)"}}>{o.paymentMethod==="YAPPY"?"📱 Yappy":"💵 Efectivo"}</div>
              <div style={{fontWeight:800,fontSize:14}}>{o.amount||totalAmt(o)}</div>
            </div>

            {/* BOTONES PARA PEDIDO MODIFICADO */}
            {isModified&&!isReplacing&&(
              <div style={{display:"flex",flexDirection:"column",gap:7}}>
                <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,padding:"7px 10px",background:"rgba(244,196,48,.06)",borderRadius:8}}>
                  El vendedor reservó los números del pedido original. Decide cómo proceder:
                </div>
                <div style={{display:"flex",gap:7}}>
                  <button onClick={()=>onClientReject&&onClientReject(o.id)}
                    style={{flex:1,padding:"9px 10px",background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.28)",borderRadius:10,color:"var(--red)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                    ❌ Rechazar
                  </button>
                  <button onClick={()=>{setReplacingOrder(o.id);setReplaceType(o.removedItems?.[0]?.type||"billete");setReplaceQty(1);setReplaceNum("");}}
                    style={{flex:1,padding:"9px 10px",background:"rgba(59,158,255,.1)",border:"1px solid rgba(59,158,255,.28)",borderRadius:10,color:"var(--blue)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                    🔄 Buscar reemplazo
                  </button>
                  <button onClick={()=>onClientApprove&&onClientApprove(o.id)}
                    style={{flex:1,padding:"9px 10px",background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",borderRadius:10,color:"var(--green)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                    ✓ Aprobar así
                  </button>
                </div>
              </div>
            )}

            {/* BUSCADOR DE REEMPLAZO */}
            {isModified&&isReplacing&&(
              <div style={{background:"rgba(59,158,255,.06)",border:"1px solid rgba(59,158,255,.2)",borderRadius:12,padding:"12px"}}>
                <div style={{fontSize:11,fontWeight:800,color:"var(--blue)",marginBottom:10}}>🔄 Buscar número de reemplazo</div>

                {/* Tipo */}
                <div style={{display:"flex",gap:6,marginBottom:10}}>
                  {["billete","chance"].map(t=>(
                    <button key={t} onClick={()=>{setReplaceType(t);setReplaceNum("");setReplaceQty(t==="chance"?5:1);}}
                      style={{flex:1,padding:"7px",borderRadius:9,border:`1.5px solid ${replaceType===t?"var(--blue)":"var(--border)"}`,background:replaceType===t?"rgba(59,158,255,.1)":"var(--bg3)",color:replaceType===t?"var(--blue)":"var(--muted)",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'",textTransform:"capitalize"}}>
                      {t==="billete"?"🎟 Billete":"⚡ Chance"}
                    </button>
                  ))}
                </div>

                {/* Números disponibles del vendedor */}
                <div style={{fontSize:10,color:"var(--muted)",marginBottom:6}}>Disponibles del vendedor:</div>
                <div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:10}}>
                  {availNums.slice(0,12).map(n=>(
                    <button key={n.n} onClick={()=>setReplaceNum(n.n)}
                      style={{padding:"5px 9px",borderRadius:8,border:`1.5px solid ${replaceNum===n.n?"var(--blue)":"rgba(59,158,255,.2)"}`,background:replaceNum===n.n?"rgba(59,158,255,.15)":"rgba(59,158,255,.05)",color:replaceNum===n.n?"var(--blue)":"var(--muted)",fontFamily:"'Bebas Neue'",fontSize:14,cursor:"pointer",letterSpacing:1}}>
                      {n.n}
                    </button>
                  ))}
                  {availNums.length===0&&<span style={{fontSize:10,color:"var(--muted)"}}>Sin stock disponible</span>}
                </div>

                {/* Cantidad */}
                {replaceNum&&(
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <span style={{fontSize:11,color:"var(--muted)"}}>Cantidad:</span>
                    <Stepper value={replaceQty} min={replaceType==="chance"?5:1} step={replaceType==="chance"?5:1} max={99} onChange={setReplaceQty}/>
                    <span style={{fontSize:11,fontWeight:700,color:"var(--green)"}}>
                      ${((replaceType==="billete"?1:0.25)*replaceQty).toFixed(2)}
                    </span>
                  </div>
                )}

                <div style={{display:"flex",gap:7}}>
                  <button onClick={()=>setReplacingOrder(null)}
                    style={{flex:1,padding:"9px",background:"rgba(110,133,158,.1)",border:"1px solid var(--border)",borderRadius:9,color:"var(--muted)",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                    Cancelar
                  </button>
                  <button
                    disabled={!replaceNum}
                    onClick={()=>{
                      if(!replaceNum||!onProposeReplacement) return;
                      onProposeReplacement(o.id,{type:replaceType,num:replaceNum,qty:replaceQty,price:replaceType==="billete"?1:0.25});
                      setReplacingOrder(null);
                      setReplaceNum("");
                    }}
                    style={{flex:2,padding:"9px",background:replaceNum?"rgba(59,158,255,.15)":"rgba(110,133,158,.1)",border:`1px solid ${replaceNum?"rgba(59,158,255,.3)":"var(--border)"}`,borderRadius:9,color:replaceNum?"var(--blue)":"var(--muted)",fontSize:11,fontWeight:800,cursor:replaceNum?"pointer":"default",fontFamily:"'DM Sans'"}}>
                    {replaceNum?`📨 Proponer ${replaceType==="billete"?"Nº":"#"}${replaceNum} al vendedor`:"Selecciona un número"}
                  </button>
                </div>
              </div>
            )}

            {/* ESPERANDO RESPUESTA DEL VENDEDOR al reemplazo */}
            {isReplSent&&!isReplacing&&(
              <div style={{background:"rgba(59,158,255,.07)",border:"1px solid rgba(59,158,255,.25)",borderRadius:12,padding:"10px 13px",display:"flex",gap:10,alignItems:"flex-start"}}>
                <div style={{fontSize:18,flexShrink:0}}>🔄</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:800,color:"var(--blue)",marginBottom:3}}>
                    Reemplazo enviado — esperando al vendedor{roundLabel}
                  </div>
                  <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginBottom:4}}>
                    {o.clientNote}
                  </div>
                  <div style={{fontSize:9,color:"var(--muted)"}}>
                    El vendedor puede: ✓ Aprobar → va al repartidor · ✏️ Modificar → debes revisar otra vez · ❌ Rechazar → cancelado
                  </div>
                </div>
              </div>
            )}

            {/* CANCELADO POR VENDEDOR: mensaje al comprador */}
            {o.status==="CANCELADO_VENDEDOR"&&(
              <div style={{background:"rgba(255,75,110,.08)",border:"1px solid rgba(255,75,110,.3)",borderRadius:12,padding:"10px 13px",display:"flex",gap:10,alignItems:"flex-start"}}>
                <div style={{fontSize:20,flexShrink:0}}>🚫</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:800,color:"var(--red)",marginBottom:3}}>
                    El vendedor canceló tu pedido
                  </div>
                  <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginBottom:4}}>
                    {o.vendorCancelNote||"El vendedor no puede procesar este pedido en este momento."}
                  </div>
                  <div style={{fontSize:9,color:"var(--muted)"}}>
                    Los números han sido liberados al stock · {o.cancelledAt}
                  </div>
                </div>
              </div>
            )}

            {isActive&&!isModified&&!isReplSent&&(
              <div style={{marginTop:8,background:"rgba(244,196,48,.07)",borderRadius:9,padding:"7px 11px",display:"flex",justifyContent:"space-between",cursor:"pointer"}} onClick={()=>nav("tracking")}>
                <span style={{fontSize:11,color:"var(--gold)",fontWeight:700}}>🛵 Ver seguimiento en vivo</span>
                <Ic n="chevR" s={13} c="var(--gold)"/>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   RESULTADOS + VERIFICAR + HISTORIAL
═══════════════════════════════════════════════════════ */

// Historial completo basado en datos oficiales lnb.gob.pa
// mes: 1-12, anio: número
// Se actualiza automáticamente desde el Worker updater al cargar la app
const HISTORIAL_SEED = [
  // ══════ 2026 ══════
  // Fuente: lnb.gob.pa (oficial) + laestrella.com.pa + telemetro.com (confirmatorias)
  // Numeración: Miercolito 3062 = 29 Abr 2026, Dominical 5550 = 03 May 2026, Gordito 408 = 27 Mar 2026
  // MAY 2026
  { tipo:"MIERCOLITO",  sorteoN:"3063", fecha:"06 May 2026", mes:5, anio:2026,
    premios:[{pos:"1er",num:"4757",letras:"BBCB",serie:"24",folio:"6"},{pos:"2do",num:"6046"},{pos:"3er",num:"5808"}] },
  { tipo:"DOMINICAL",   sorteoN:"5550", fecha:"03 May 2026", mes:5, anio:2026,
    premios:[{pos:"1er",num:"4924",letras:"DBAB",serie:"9",folio:"2"},{pos:"2do",num:"1823"},{pos:"3er",num:"3400"}] },
  // ABR 2026
  { tipo:"MIERCOLITO",  sorteoN:"3062", fecha:"29 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"2354",letras:"BDCA",serie:"13",folio:"11"},{pos:"2do",num:"7359"},{pos:"3er",num:"7329"}] },
  { tipo:"DOMINICAL",   sorteoN:"5549", fecha:"26 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"5144",letras:"BABD",serie:"6",folio:"13"},{pos:"2do",num:"2104"},{pos:"3er",num:"1579"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3061", fecha:"22 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"9864",letras:"CBBC",serie:"20",folio:"1"},{pos:"2do",num:"1117"},{pos:"3er",num:"1379"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5548", fecha:"19 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"75212",letras:"",serie:"",folio:""},{pos:"2do",num:"47253"},{pos:"3er",num:"85747"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3060", fecha:"15 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"5828",letras:"CCDC",serie:"20",folio:"10"},{pos:"2do",num:"8638"},{pos:"3er",num:"4883"}] },
  { tipo:"DOMINICAL",   sorteoN:"5547", fecha:"12 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"7964",letras:"",serie:"",folio:""},{pos:"2do",num:"5211"},{pos:"3er",num:"6713"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3059", fecha:"08 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"4252",letras:"BBCD",serie:"17",folio:"6"},{pos:"2do",num:"5459"},{pos:"3er",num:"3532"}] },
  { tipo:"DOMINICAL",   sorteoN:"5546", fecha:"05 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"5349",letras:"BAAB",serie:"8",folio:"13"},{pos:"2do",num:"8952"},{pos:"3er",num:"2891"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3058", fecha:"01 Abr 2026", mes:4, anio:2026,
    premios:[{pos:"1er",num:"3561",letras:"BBDD",serie:"1",folio:"1"},{pos:"2do",num:"7065"},{pos:"3er",num:"2408"}] },
  // MAR 2026
  { tipo:"DOMINICAL",   sorteoN:"5545", fecha:"29 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"8364",letras:"",serie:"",folio:""},{pos:"2do",num:"3657"},{pos:"3er",num:"3028"}] },
  { tipo:"GORDITO",     sorteoN:"408",  fecha:"27 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"4778",letras:"BCAA",serie:"9",folio:"5"},{pos:"2do",num:"20"},{pos:"3er",num:"89"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3057", fecha:"25 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"6915",letras:"",serie:"",folio:""},{pos:"2do",num:"1573"},{pos:"3er",num:"1871"}] },
  { tipo:"DOMINICAL",   sorteoN:"5544", fecha:"22 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"3522",letras:"CACC",serie:"1",folio:"11"},{pos:"2do",num:"6812"},{pos:"3er",num:"3143"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3056", fecha:"18 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"3755",letras:"BBAA",serie:"1",folio:"3"},{pos:"2do",num:"2949"},{pos:"3er",num:"9680"}] },
  { tipo:"DOMINICAL",   sorteoN:"5543", fecha:"15 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"0976",letras:"CACA",serie:"15",folio:"3"},{pos:"2do",num:"9775"},{pos:"3er",num:"0994"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3055", fecha:"11 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"0854",letras:"ACBD",serie:"17",folio:"6"},{pos:"2do",num:"1957"},{pos:"3er",num:"6371"}] },
  { tipo:"DOMINICAL",   sorteoN:"5542", fecha:"08 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"7565",letras:"CACC",serie:"8",folio:"1"},{pos:"2do",num:"0421"},{pos:"3er",num:"6513"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3054", fecha:"04 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"3975",letras:"AAAB",serie:"11",folio:"6"},{pos:"2do",num:"9484"},{pos:"3er",num:"2676"}] },
  { tipo:"DOMINICAL",   sorteoN:"5541", fecha:"01 Mar 2026", mes:3, anio:2026,
    premios:[{pos:"1er",num:"3047",letras:"CBCD",serie:"14",folio:"8"},{pos:"2do",num:"0361"},{pos:"3er",num:"4391"}] },
  // FEB 2026
  { tipo:"GORDITO",     sorteoN:"408",  fecha:"27 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"8763",letras:"CDCD",serie:"2",folio:"10"},{pos:"2do",num:"60"},{pos:"3er",num:"90"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3053", fecha:"25 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"2735",letras:"DBDC",serie:"10",folio:"13"},{pos:"2do",num:"7293"},{pos:"3er",num:"2674"}] },
  { tipo:"DOMINICAL",   sorteoN:"5540", fecha:"22 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"9775",letras:"DADD",serie:"2",folio:"2"},{pos:"2do",num:"5005"},{pos:"3er",num:"5979"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3052", fecha:"18 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"5828",letras:"ABDC",serie:"10",folio:"13"},{pos:"2do",num:"4949"},{pos:"3er",num:"9274"}] },
  { tipo:"DOMINICAL",   sorteoN:"5539", fecha:"15 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"0499",letras:"BACB",serie:"16",folio:"1"},{pos:"2do",num:"2975"},{pos:"3er",num:"3376"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3051", fecha:"11 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"6682",letras:"ACAB",serie:"22",folio:"5"},{pos:"2do",num:"5424"},{pos:"3er",num:"4412"}] },
  { tipo:"DOMINICAL",   sorteoN:"5538", fecha:"08 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"7501",letras:"ACCA",serie:"6",folio:"2"},{pos:"2do",num:"7097"},{pos:"3er",num:"8145"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3050", fecha:"04 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"7438",letras:"AADB",serie:"21",folio:"3"},{pos:"2do",num:"3826"},{pos:"3er",num:"7987"}] },
  { tipo:"DOMINICAL",   sorteoN:"5537", fecha:"01 Feb 2026", mes:2, anio:2026,
    premios:[{pos:"1er",num:"5863",letras:"ABBA",serie:"16",folio:"11"},{pos:"2do",num:"8102"},{pos:"3er",num:"1212"}] },
  // ENE 2026
  { tipo:"GORDITO",     sorteoN:"407",  fecha:"30 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"1661",letras:"AACD",serie:"6",folio:"10"},{pos:"2do",num:"35"},{pos:"3er",num:"61"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3049", fecha:"28 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"6829",letras:"BADD",serie:"7",folio:"2"},{pos:"2do",num:"3912"},{pos:"3er",num:"1883"}] },
  { tipo:"DOMINICAL",   sorteoN:"5536", fecha:"25 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"3942",letras:"AADC",serie:"25",folio:"11"},{pos:"2do",num:"6826"},{pos:"3er",num:"8408"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3048", fecha:"21 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"0551",letras:"BDCC",serie:"10",folio:"7"},{pos:"2do",num:"1476"},{pos:"3er",num:"3932"}] },
  { tipo:"DOMINICAL",   sorteoN:"5535", fecha:"18 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"9539",letras:"BACA",serie:"17",folio:"8"},{pos:"2do",num:"4257"},{pos:"3er",num:"2275"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3047", fecha:"14 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"3757",letras:"ADAD",serie:"3",folio:"12"},{pos:"2do",num:"7747"},{pos:"3er",num:"2802"}] },
  { tipo:"DOMINICAL",   sorteoN:"5534", fecha:"11 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"4259",letras:"BADD",serie:"3",folio:"12"},{pos:"2do",num:"6537"},{pos:"3er",num:"6530"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3046", fecha:"07 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"8884",letras:"BABB",serie:"16",folio:"3"},{pos:"2do",num:"4130"},{pos:"3er",num:"5506"}] },
  { tipo:"DOMINICAL",   sorteoN:"5533", fecha:"04 Ene 2026", mes:1, anio:2026,
    premios:[{pos:"1er",num:"0587",letras:"AAAC",serie:"15",folio:"11"},{pos:"2do",num:"6983"},{pos:"3er",num:"4590"}] },

  // ══════ 2025 ══════ — Fuente: suerteloteria.com (oficial)
  // DICIEMBRE 2025
  { tipo:"MIERCOLITO",  sorteoN:"3045", fecha:"31 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"6369",letras:"CADD",serie:"16",folio:"9"},{pos:"2do",num:"0846"},{pos:"3er",num:"4063"}] },
  { tipo:"DOMINICAL",   sorteoN:"5532", fecha:"28 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"5905",letras:"BBBD",serie:"21",folio:"9"},{pos:"2do",num:"2861"},{pos:"3er",num:"4691"}] },
  { tipo:"GORDITO"   ,    sorteoN:"406B", fecha:"26 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"7792",letras:"ABAA",serie:"1",folio:"19"},{pos:"2do",num:"10"},{pos:"3er",num:"77"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3044", fecha:"24 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"8937",letras:"BBDD",serie:"17",folio:"10"},{pos:"2do",num:"9611"},{pos:"3er",num:"5042"}] },
  { tipo:"DOMINICAL",   sorteoN:"5531", fecha:"21 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"5706",letras:"ACCB",serie:"9",folio:"9"},{pos:"2do",num:"2190"},{pos:"3er",num:"7965"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3043", fecha:"17 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"8301",letras:"DDAA",serie:"20",folio:"8"},{pos:"2do",num:"1955"},{pos:"3er",num:"3551"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5530", fecha:"14 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"49899",letras:"BCBD",serie:"1",folio:"2"},{pos:"2do",num:"70778"},{pos:"3er",num:"56853"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3042", fecha:"10 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"7850",letras:"BBBD",serie:"10",folio:"1"},{pos:"2do",num:"6360"},{pos:"3er",num:"5917"}] },
  { tipo:"DOMINICAL",   sorteoN:"5529", fecha:"07 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"0030",letras:"ACAD",serie:"14",folio:"5"},{pos:"2do",num:"6561"},{pos:"3er",num:"0447"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3041", fecha:"03 Dic 2025", mes:12, anio:2025,
    premios:[{pos:"1er",num:"4181",letras:"CADA",serie:"2",folio:"9"},{pos:"2do",num:"3419"},{pos:"3er",num:"7396"}] },
  // NOVIEMBRE 2025
  { tipo:"DOMINICAL",   sorteoN:"5528", fecha:"30 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"1124",letras:"DCCD",serie:"2",folio:"6"},{pos:"2do",num:"5512"},{pos:"3er",num:"6906"}] },
  { tipo:"GORDITO"   ,    sorteoN:"406A", fecha:"21 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"2240",letras:"DABC",serie:"2",folio:"4"},{pos:"2do",num:"58"},{pos:"3er",num:"33"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3040", fecha:"26 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"1783",letras:"CBBC",serie:"2",folio:"10"},{pos:"2do",num:"7836"},{pos:"3er",num:"5643"}] },
  { tipo:"DOMINICAL",   sorteoN:"5527", fecha:"23 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"7535",letras:"DDDB",serie:"13",folio:"3"},{pos:"2do",num:"9550"},{pos:"3er",num:"9531"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3039", fecha:"19 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"4740",letras:"AACD",serie:"16",folio:"2"},{pos:"2do",num:"8453"},{pos:"3er",num:"2032"}] },
  { tipo:"DOMINICAL",   sorteoN:"5526", fecha:"16 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"5560",letras:"DDDC",serie:"5",folio:"8"},{pos:"2do",num:"2570"},{pos:"3er",num:"9639"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3038", fecha:"12 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"7214",letras:"BDAD",serie:"15",folio:"15"},{pos:"2do",num:"1039"},{pos:"3er",num:"2371"}] },
  { tipo:"DOMINICAL",   sorteoN:"5525", fecha:"09 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"1404",letras:"BACC",serie:"1",folio:"5"},{pos:"2do",num:"2737"},{pos:"3er",num:"2704"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3037", fecha:"05 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"6921",letras:"CABC",serie:"1",folio:"14"},{pos:"2do",num:"3239"},{pos:"3er",num:"1027"}] },
  { tipo:"DOMINICAL",   sorteoN:"5524", fecha:"02 Nov 2025", mes:11, anio:2025,
    premios:[{pos:"1er",num:"3052",letras:"DACC",serie:"22",folio:"8"},{pos:"2do",num:"5196"},{pos:"3er",num:"3538"}] },
  // OCTUBRE 2025
  { tipo:"GORDITO"   ,    sorteoN:"406",  fecha:"31 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"4433",letras:"CCCC",serie:"7",folio:"21"},{pos:"2do",num:"34"},{pos:"3er",num:"31"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3036", fecha:"29 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"0096",letras:"AABA",serie:"9",folio:"9"},{pos:"2do",num:"3425"},{pos:"3er",num:"3709"}] },
  { tipo:"DOMINICAL",   sorteoN:"5523", fecha:"26 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"9376",letras:"DCCD",serie:"14",folio:"11"},{pos:"2do",num:"8053"},{pos:"3er",num:"8505"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3035", fecha:"22 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"4248",letras:"DADA",serie:"19",folio:"2"},{pos:"2do",num:"8577"},{pos:"3er",num:"8841"}] },
  { tipo:"DOMINICAL",   sorteoN:"5522", fecha:"19 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"1330",letras:"BDAB",serie:"25",folio:"2"},{pos:"2do",num:"0445"},{pos:"3er",num:"4548"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3034", fecha:"15 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"7707",letras:"DAAB",serie:"18",folio:"9"},{pos:"2do",num:"9577"},{pos:"3er",num:"3310"}] },
  { tipo:"DOMINICAL",   sorteoN:"5521", fecha:"12 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"9695",letras:"BACA",serie:"12",folio:"2"},{pos:"2do",num:"5798"},{pos:"3er",num:"3877"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3033", fecha:"08 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"8383",letras:"ACCA",serie:"5",folio:"10"},{pos:"2do",num:"1774"},{pos:"3er",num:"3301"}] },
  { tipo:"DOMINICAL",   sorteoN:"5520", fecha:"05 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"3349",letras:"ABBD",serie:"18",folio:"5"},{pos:"2do",num:"2350"},{pos:"3er",num:"3665"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3032", fecha:"01 Oct 2025", mes:10, anio:2025,
    premios:[{pos:"1er",num:"0108",letras:"ABAA",serie:"18",folio:"14"},{pos:"2do",num:"1127"},{pos:"3er",num:"8712"}] },
  // SEPTIEMBRE 2025
  { tipo:"DOMINICAL",   sorteoN:"5519", fecha:"28 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"5511",letras:"DDBA",serie:"10",folio:"9"},{pos:"2do",num:"5823"},{pos:"3er",num:"5823"}] },
  { tipo:"GORDITO"   ,    sorteoN:"405A", fecha:"26 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"2877",letras:"BDBA",serie:"2",folio:"25"},{pos:"2do",num:"13"},{pos:"3er",num:"01"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3031", fecha:"24 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"3704",letras:"CCAA",serie:"11",folio:"11"},{pos:"2do",num:"6336"},{pos:"3er",num:"3666"}] },
  { tipo:"DOMINICAL",   sorteoN:"5518", fecha:"21 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"2871",letras:"ACAC",serie:"21",folio:"6"},{pos:"2do",num:"7212"},{pos:"3er",num:"5244"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3030", fecha:"17 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"5151",letras:"CDBD",serie:"15",folio:"1"},{pos:"2do",num:"4721"},{pos:"3er",num:"8827"}] },
  { tipo:"DOMINICAL",   sorteoN:"5517", fecha:"14 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"7334",letras:"BAAD",serie:"16",folio:"9"},{pos:"2do",num:"6366"},{pos:"3er",num:"8033"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3029", fecha:"10 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"2305",letras:"ACDA",serie:"19",folio:"3"},{pos:"2do",num:"4744"},{pos:"3er",num:"0891"}] },
  { tipo:"DOMINICAL",   sorteoN:"5516", fecha:"07 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"5481",letras:"ACAA",serie:"4",folio:"13"},{pos:"2do",num:"2190"},{pos:"3er",num:"8113"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3028", fecha:"03 Sep 2025", mes:9, anio:2025,
    premios:[{pos:"1er",num:"0884",letras:"CAAC",serie:"22",folio:"9"},{pos:"2do",num:"5954"},{pos:"3er",num:"2810"}] },
  // AGOSTO 2025
  { tipo:"DOMINICAL",   sorteoN:"5515", fecha:"31 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"3471",letras:"BDCD",serie:"7",folio:"6"},{pos:"2do",num:"1174"},{pos:"3er",num:"0745"}] },
  { tipo:"GORDITO"   ,    sorteoN:"405",  fecha:"29 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"1353",letras:"BDBA",serie:"4",folio:"21"},{pos:"2do",num:"89"},{pos:"3er",num:"17"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3027", fecha:"27 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"1391",letras:"DDBA",serie:"12",folio:"6"},{pos:"2do",num:"3561"},{pos:"3er",num:"8225"}] },
  { tipo:"DOMINICAL",   sorteoN:"5514", fecha:"24 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"8679",letras:"CDDC",serie:"23",folio:"4"},{pos:"2do",num:"9487"},{pos:"3er",num:"3658"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3026", fecha:"20 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"4653",letras:"ADBC",serie:"16",folio:"5"},{pos:"2do",num:"8980"},{pos:"3er",num:"8752"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5513", fecha:"17 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"01545",letras:"DDDA",serie:"1",folio:"12"},{pos:"2do",num:"34375"},{pos:"3er",num:"42829"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3025", fecha:"13 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"1637",letras:"AACB",serie:"4",folio:"2"},{pos:"2do",num:"9665"},{pos:"3er",num:"6731"}] },
  { tipo:"DOMINICAL",   sorteoN:"5512", fecha:"10 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"4219",letras:"BBCA",serie:"7",folio:"12"},{pos:"2do",num:"9913"},{pos:"3er",num:"7020"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3024", fecha:"06 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"4318",letras:"ACBA",serie:"21",folio:"5"},{pos:"2do",num:"7053"},{pos:"3er",num:"3380"}] },
  { tipo:"DOMINICAL",   sorteoN:"5511", fecha:"03 Ago 2025", mes:8, anio:2025,
    premios:[{pos:"1er",num:"2832",letras:"BDAA",serie:"1",folio:"1"},{pos:"2do",num:"5831"},{pos:"3er",num:"8118"}] },
  // JULIO 2025
  { tipo:"MIERCOLITO",  sorteoN:"3023", fecha:"30 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"4641",letras:"CAAC",serie:"11",folio:"1"},{pos:"2do",num:"9081"},{pos:"3er",num:"4102"}] },
  { tipo:"DOMINICAL",   sorteoN:"5510", fecha:"27 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"7962",letras:"ABBD",serie:"15",folio:"15"},{pos:"2do",num:"8224"},{pos:"3er",num:"6765"}] },
  { tipo:"GORDITO"   ,    sorteoN:"404",  fecha:"25 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"7673",letras:"ADCD",serie:"6",folio:"16"},{pos:"2do",num:"26"},{pos:"3er",num:"97"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3022", fecha:"23 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"9447",letras:"CBAB",serie:"9",folio:"8"},{pos:"2do",num:"2630"},{pos:"3er",num:"1725"}] },
  { tipo:"DOMINICAL",   sorteoN:"5509", fecha:"20 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"2245",letras:"CACA",serie:"12",folio:"15"},{pos:"2do",num:"1273"},{pos:"3er",num:"7437"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3021", fecha:"16 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"5008",letras:"BCCA",serie:"5",folio:"2"},{pos:"2do",num:"3149"},{pos:"3er",num:"7834"}] },
  { tipo:"DOMINICAL",   sorteoN:"5508", fecha:"13 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"9512",letras:"CDAA",serie:"17",folio:"9"},{pos:"2do",num:"0032"},{pos:"3er",num:"6720"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3020", fecha:"09 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"3988",letras:"BBAD",serie:"10",folio:"2"},{pos:"2do",num:"4383"},{pos:"3er",num:"5783"}] },
  { tipo:"DOMINICAL",   sorteoN:"5507", fecha:"06 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"8473",letras:"BDAB",serie:"27",folio:"2"},{pos:"2do",num:"5475"},{pos:"3er",num:"0863"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3019", fecha:"02 Jul 2025", mes:7, anio:2025,
    premios:[{pos:"1er",num:"9591",letras:"BACA",serie:"14",folio:"11"},{pos:"2do",num:"1470"},{pos:"3er",num:"3669"}] },
  // JUNIO 2025
  { tipo:"DOMINICAL",   sorteoN:"5506", fecha:"29 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"4653",letras:"CCDA",serie:"14",folio:"15"},{pos:"2do",num:"0235"},{pos:"3er",num:"2751"}] },
  { tipo:"GORDITO"   ,    sorteoN:"403",  fecha:"27 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"6540",letras:"ACAD",serie:"4",folio:"10"},{pos:"2do",num:"20"},{pos:"3er",num:"77"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3018", fecha:"25 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"5212",letras:"BBAD",serie:"1",folio:"10"},{pos:"2do",num:"6503"},{pos:"3er",num:"7561"}] },
  { tipo:"DOMINICAL",   sorteoN:"5505", fecha:"22 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"6006",letras:"DBCC",serie:"6",folio:"3"},{pos:"2do",num:"5929"},{pos:"3er",num:"1615"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3017", fecha:"18 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"7756",letras:"AACD",serie:"1",folio:"2"},{pos:"2do",num:"7619"},{pos:"3er",num:"1524"}] },
  { tipo:"DOMINICAL",   sorteoN:"5504", fecha:"15 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"3134",letras:"DDCD",serie:"14",folio:"10"},{pos:"2do",num:"5370"},{pos:"3er",num:"6941"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3016", fecha:"11 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"6458",letras:"BDCC",serie:"9",folio:"10"},{pos:"2do",num:"3523"},{pos:"3er",num:"1833"}] },
  { tipo:"DOMINICAL",   sorteoN:"5503", fecha:"08 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"4987",letras:"CBAD",serie:"27",folio:"9"},{pos:"2do",num:"1966"},{pos:"3er",num:"0188"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3015", fecha:"04 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"3048",letras:"AADA",serie:"12",folio:"5"},{pos:"2do",num:"8215"},{pos:"3er",num:"1051"}] },
  { tipo:"DOMINICAL",   sorteoN:"5502", fecha:"01 Jun 2025", mes:6, anio:2025,
    premios:[{pos:"1er",num:"0350",letras:"CDDD",serie:"10",folio:"5"},{pos:"2do",num:"3466"},{pos:"3er",num:"9854"}] },
  // MAYO 2025
  { tipo:"GORDITO"   ,    sorteoN:"402A", fecha:"30 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"3966",letras:"ADDB",serie:"8",folio:"14"},{pos:"2do",num:"51"},{pos:"3er",num:"13"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3014", fecha:"28 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"6093",letras:"DCAB",serie:"6",folio:"12"},{pos:"2do",num:"9752"},{pos:"3er",num:"6091"}] },
  { tipo:"DOMINICAL",   sorteoN:"5501", fecha:"25 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"5730",letras:"BCCA",serie:"4",folio:"14"},{pos:"2do",num:"9647"},{pos:"3er",num:"6254"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3013", fecha:"21 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"4562",letras:"CCBD",serie:"3",folio:"13"},{pos:"2do",num:"9065"},{pos:"3er",num:"0203"}] },
  { tipo:"DOMINICAL",   sorteoN:"5500", fecha:"18 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"7838",letras:"ACDB",serie:"1",folio:"6"},{pos:"2do",num:"6820"},{pos:"3er",num:"7570"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3012", fecha:"14 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"5254",letras:"DBDB",serie:"7",folio:"7"},{pos:"2do",num:"5552"},{pos:"3er",num:"5406"}] },
  { tipo:"DOMINICAL",   sorteoN:"5499", fecha:"11 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"7824",letras:"ABDC",serie:"4",folio:"3"},{pos:"2do",num:"9499"},{pos:"3er",num:"0495"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3011", fecha:"07 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"8207",letras:"DDBB",serie:"11",folio:"10"},{pos:"2do",num:"3415"},{pos:"3er",num:"6838"}] },
  { tipo:"DOMINICAL",   sorteoN:"5498", fecha:"04 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"8798",letras:"DABA",serie:"13",folio:"1"},{pos:"2do",num:"1406"},{pos:"3er",num:"9784"}] },
  { tipo:"GORDITO"   ,    sorteoN:"402",  fecha:"02 May 2025", mes:5, anio:2025,
    premios:[{pos:"1er",num:"8040",letras:"CBBB",serie:"4",folio:"19"},{pos:"2do",num:"80"},{pos:"3er",num:"35"}] },
  // ABRIL 2025
  { tipo:"MIERCOLITO",  sorteoN:"3010", fecha:"30 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"4185",letras:"CBAD",serie:"6",folio:"12"},{pos:"2do",num:"4117"},{pos:"3er",num:"1017"}] },
  { tipo:"DOMINICAL",   sorteoN:"5497", fecha:"27 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"8401",letras:"DCBB",serie:"12",folio:"6"},{pos:"2do",num:"9864"},{pos:"3er",num:"2692"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3009", fecha:"23 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"5917",letras:"CDCD",serie:"1",folio:"14"},{pos:"2do",num:"3125"},{pos:"3er",num:"0653"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5496", fecha:"20 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"42233",letras:"ADDB",serie:"2",folio:"15"},{pos:"2do",num:"78283"},{pos:"3er",num:"89207"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3008", fecha:"16 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"1803",letras:"ACDA",serie:"15",folio:"7"},{pos:"2do",num:"4992"},{pos:"3er",num:"0285"}] },
  { tipo:"DOMINICAL",   sorteoN:"5495", fecha:"13 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"1378",letras:"CCAD",serie:"19",folio:"8"},{pos:"2do",num:"4898"},{pos:"3er",num:"1251"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3007", fecha:"09 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"3138",letras:"AAAB",serie:"5",folio:"2"},{pos:"2do",num:"1873"},{pos:"3er",num:"1151"}] },
  { tipo:"DOMINICAL",   sorteoN:"5494", fecha:"06 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"6064",letras:"ABAD",serie:"6",folio:"12"},{pos:"2do",num:"7959"},{pos:"3er",num:"0029"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3006", fecha:"02 Abr 2025", mes:4, anio:2025,
    premios:[{pos:"1er",num:"6119",letras:"CDDD",serie:"15",folio:"9"},{pos:"2do",num:"1832"},{pos:"3er",num:"8811"}] },
  // MARZO 2025
  { tipo:"DOMINICAL",   sorteoN:"5493", fecha:"30 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"6423",letras:"CADA",serie:"19",folio:"15"},{pos:"2do",num:"4341"},{pos:"3er",num:"3379"}] },
  { tipo:"GORDITO"   ,    sorteoN:"401A", fecha:"28 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"1475",letras:"DCAA",serie:"1",folio:"24"},{pos:"2do",num:"76"},{pos:"3er",num:"13"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3005", fecha:"26 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"9903",letras:"CBCA",serie:"3",folio:"8"},{pos:"2do",num:"0164"},{pos:"3er",num:"0581"}] },
  { tipo:"DOMINICAL",   sorteoN:"5492", fecha:"23 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"0123",letras:"ACAD",serie:"11",folio:"3"},{pos:"2do",num:"3838"},{pos:"3er",num:"1894"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3004", fecha:"19 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"9693",letras:"DBAA",serie:"1",folio:"9"},{pos:"2do",num:"0915"},{pos:"3er",num:"7500"}] },
  { tipo:"DOMINICAL",   sorteoN:"5491", fecha:"16 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"2504",letras:"BCAD",serie:"27",folio:"6"},{pos:"2do",num:"1425"},{pos:"3er",num:"2297"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3003", fecha:"12 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"8875",letras:"DBBC",serie:"7",folio:"15"},{pos:"2do",num:"1057"},{pos:"3er",num:"7257"}] },
  { tipo:"DOMINICAL",   sorteoN:"5490", fecha:"09 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"7201",letras:"BBDB",serie:"10",folio:"6"},{pos:"2do",num:"8607"},{pos:"3er",num:"4621"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3002", fecha:"05 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"0558",letras:"CBDC",serie:"13",folio:"8"},{pos:"2do",num:"2461"},{pos:"3er",num:"2176"}] },
  { tipo:"DOMINICAL",   sorteoN:"5489", fecha:"02 Mar 2025", mes:3, anio:2025,
    premios:[{pos:"1er",num:"0817",letras:"CCBC",serie:"27",folio:"8"},{pos:"2do",num:"6197"},{pos:"3er",num:"6414"}] },
  // FEBRERO 2025
  { tipo:"GORDITO"   ,    sorteoN:"401",  fecha:"28 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"0028",letras:"DBDB",serie:"9",folio:"18"},{pos:"2do",num:"21"},{pos:"3er",num:"56"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3001", fecha:"26 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"8443",letras:"BCAA",serie:"6",folio:"6"},{pos:"2do",num:"5376"},{pos:"3er",num:"5554"}] },
  { tipo:"DOMINICAL",   sorteoN:"5488", fecha:"23 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"5922",letras:"DCDC",serie:"4",folio:"5"},{pos:"2do",num:"1579"},{pos:"3er",num:"7919"}] },
  { tipo:"MIERCOLITO",  sorteoN:"3000", fecha:"19 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"9055",letras:"ACBC",serie:"10",folio:"1"},{pos:"2do",num:"7902"},{pos:"3er",num:"9676"}] },
  { tipo:"DOMINICAL",   sorteoN:"5487", fecha:"16 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"5531",letras:"BDCB",serie:"2",folio:"12"},{pos:"2do",num:"0177"},{pos:"3er",num:"2845"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2999", fecha:"12 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"1964",letras:"ADAA",serie:"11",folio:"2"},{pos:"2do",num:"5108"},{pos:"3er",num:"5436"}] },
  { tipo:"DOMINICAL",   sorteoN:"5486", fecha:"09 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"8870",letras:"CADA",serie:"20",folio:"6"},{pos:"2do",num:"3265"},{pos:"3er",num:"3531"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2998", fecha:"05 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"5332",letras:"ACBC",serie:"16",folio:"1"},{pos:"2do",num:"9483"},{pos:"3er",num:"3145"}] },
  { tipo:"DOMINICAL",   sorteoN:"5485", fecha:"02 Feb 2025", mes:2, anio:2025,
    premios:[{pos:"1er",num:"8287",letras:"DCDC",serie:"26",folio:"6"},{pos:"2do",num:"5646"},{pos:"3er",num:"9490"}] },
  // ENERO 2025
  { tipo:"GORDITO"   ,    sorteoN:"400",  fecha:"31 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"7459",letras:"CDDA",serie:"9",folio:"8"},{pos:"2do",num:"55"},{pos:"3er",num:"39"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2997", fecha:"29 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"5914",letras:"BBDB",serie:"20",folio:"4"},{pos:"2do",num:"8702"},{pos:"3er",num:"5979"}] },
  { tipo:"DOMINICAL",   sorteoN:"5484", fecha:"26 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"7931",letras:"CAAA",serie:"13",folio:"9"},{pos:"2do",num:"9451"},{pos:"3er",num:"9961"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2996", fecha:"22 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"9689",letras:"BCDD",serie:"19",folio:"1"},{pos:"2do",num:"7291"},{pos:"3er",num:"0414"}] },
  { tipo:"DOMINICAL",   sorteoN:"5483", fecha:"19 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"3045",letras:"BACD",serie:"20",folio:"2"},{pos:"2do",num:"4836"},{pos:"3er",num:"3698"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2995", fecha:"15 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"7473",letras:"ACBB",serie:"7",folio:"10"},{pos:"2do",num:"9397"},{pos:"3er",num:"4603"}] },
  { tipo:"DOMINICAL",   sorteoN:"5482", fecha:"12 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"9873",letras:"CBAD",serie:"8",folio:"14"},{pos:"2do",num:"9087"},{pos:"3er",num:"4513"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2994", fecha:"08 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"4784",letras:"ACDA",serie:"19",folio:"14"},{pos:"2do",num:"2891"},{pos:"3er",num:"4598"}] },
  { tipo:"DOMINICAL",   sorteoN:"5481", fecha:"05 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"2348",letras:"ADCA",serie:"2",folio:"11"},{pos:"2do",num:"4883"},{pos:"3er",num:"1917"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2993", fecha:"01 Ene 2025", mes:1, anio:2025,
    premios:[{pos:"1er",num:"4782",letras:"DABD",serie:"18",folio:"15"},{pos:"2do",num:"3482"},{pos:"3er",num:"4310"}] },
  // ══════ 2024 ══════ — Fuente: suerteloteria.com (oficial)
  // DICIEMBRE 2024
  { tipo:"GORDITO"   ,    sorteoN:"399",  fecha:"27 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"5048",letras:"AADC",serie:"6",folio:"16"},{pos:"2do",num:"58"},{pos:"3er",num:"14"}] },
  { tipo:"DOMINICAL",   sorteoN:"5480", fecha:"29 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"8556",letras:"BACC",serie:"15",folio:"12"},{pos:"2do",num:"7529"},{pos:"3er",num:"9348"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2992", fecha:"25 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"3667",letras:"DDBD",serie:"17",folio:"9"},{pos:"2do",num:"6295"},{pos:"3er",num:"3555"}] },
  { tipo:"DOMINICAL",   sorteoN:"5479", fecha:"22 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"1905",letras:"BABB",serie:"18",folio:"7"},{pos:"2do",num:"9590"},{pos:"3er",num:"2849"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2991", fecha:"18 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"0870",letras:"BDAB",serie:"16",folio:"9"},{pos:"2do",num:"0144"},{pos:"3er",num:"9658"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5478", fecha:"15 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"02586",letras:"CBBA",serie:"2",folio:"11"},{pos:"2do",num:"92776"},{pos:"3er",num:"17875"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2990", fecha:"11 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"0282",letras:"BBAB",serie:"21",folio:"15"},{pos:"2do",num:"4209"},{pos:"3er",num:"7944"}] },
  { tipo:"DOMINICAL",   sorteoN:"5477", fecha:"08 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"8466",letras:"BAAC",serie:"26",folio:"4"},{pos:"2do",num:"5181"},{pos:"3er",num:"6007"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2989", fecha:"04 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"4878",letras:"CDDB",serie:"3",folio:"12"},{pos:"2do",num:"1494"},{pos:"3er",num:"7806"}] },
  { tipo:"DOMINICAL",   sorteoN:"5476", fecha:"01 Dic 2024", mes:12, anio:2024,
    premios:[{pos:"1er",num:"0515",letras:"BDDA",serie:"28",folio:"5"},{pos:"2do",num:"0755"},{pos:"3er",num:"6514"}] },
  // NOVIEMBRE 2024
  { tipo:"GORDITO"   ,    sorteoN:"398",  fecha:"29 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"4892",letras:"BBDA",serie:"2",folio:"20"},{pos:"2do",num:"18"},{pos:"3er",num:"92"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2988", fecha:"27 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"2991",letras:"DBCA",serie:"17",folio:"9"},{pos:"2do",num:"5179"},{pos:"3er",num:"8395"}] },
  { tipo:"DOMINICAL",   sorteoN:"5475", fecha:"24 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"6888",letras:"BCBB",serie:"5",folio:"15"},{pos:"2do",num:"3095"},{pos:"3er",num:"4295"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2987", fecha:"20 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"0014",letras:"ACDA",serie:"16",folio:"8"},{pos:"2do",num:"5151"},{pos:"3er",num:"0348"}] },
  { tipo:"DOMINICAL",   sorteoN:"5474", fecha:"17 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"3957",letras:"BBAC",serie:"25",folio:"3"},{pos:"2do",num:"1639"},{pos:"3er",num:"7347"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2986", fecha:"13 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"0425",letras:"CADB",serie:"7",folio:"10"},{pos:"2do",num:"9473"},{pos:"3er",num:"4501"}] },
  { tipo:"DOMINICAL",   sorteoN:"5473", fecha:"10 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"5400",letras:"DCCC",serie:"12",folio:"12"},{pos:"2do",num:"4972"},{pos:"3er",num:"9987"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2985", fecha:"06 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"8468",letras:"DABA",serie:"2",folio:"9"},{pos:"2do",num:"8170"},{pos:"3er",num:"2003"}] },
  { tipo:"DOMINICAL",   sorteoN:"5472", fecha:"03 Nov 2024", mes:11, anio:2024,
    premios:[{pos:"1er",num:"8299",letras:"ABCD",serie:"20",folio:"12"},{pos:"2do",num:"9251"},{pos:"3er",num:"9877"}] },
  // OCTUBRE 2024
  { tipo:"MIERCOLITO",  sorteoN:"2984", fecha:"30 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"7533",letras:"CCCD",serie:"24",folio:"10"},{pos:"2do",num:"2978"},{pos:"3er",num:"7180"}] },
  { tipo:"DOMINICAL",   sorteoN:"5471", fecha:"27 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"2576",letras:"DBBD",serie:"5",folio:"1"},{pos:"2do",num:"4608"},{pos:"3er",num:"3726"}] },
  { tipo:"GORDITO"   ,    sorteoN:"397",  fecha:"25 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"3756",letras:"DADC",serie:"5",folio:"20"},{pos:"2do",num:"26"},{pos:"3er",num:"15"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2983", fecha:"23 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"9239",letras:"CACD",serie:"3",folio:"10"},{pos:"2do",num:"0879"},{pos:"3er",num:"1462"}] },
  { tipo:"DOMINICAL",   sorteoN:"5470", fecha:"20 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"8072",letras:"ABDB",serie:"10",folio:"10"},{pos:"2do",num:"2897"},{pos:"3er",num:"0144"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2982", fecha:"16 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"5109",letras:"DAAD",serie:"9",folio:"9"},{pos:"2do",num:"9459"},{pos:"3er",num:"7332"}] },
  { tipo:"DOMINICAL",   sorteoN:"5469", fecha:"13 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"9067",letras:"CBBD",serie:"2",folio:"11"},{pos:"2do",num:"9404"},{pos:"3er",num:"6526"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2981", fecha:"09 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"6312",letras:"BBBB",serie:"1",folio:"14"},{pos:"2do",num:"6205"},{pos:"3er",num:"6439"}] },
  { tipo:"DOMINICAL",   sorteoN:"5468", fecha:"06 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"8077",letras:"CABC",serie:"8",folio:"8"},{pos:"2do",num:"4537"},{pos:"3er",num:"1182"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2980", fecha:"02 Oct 2024", mes:10, anio:2024,
    premios:[{pos:"1er",num:"4297",letras:"CBBD",serie:"21",folio:"13"},{pos:"2do",num:"5619"},{pos:"3er",num:"9455"}] },
  // SEPTIEMBRE 2024
  { tipo:"DOMINICAL",   sorteoN:"5467", fecha:"29 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"9016",letras:"DDAC",serie:"27",folio:"11"},{pos:"2do",num:"6287"},{pos:"3er",num:"3231"}] },
  { tipo:"GORDITO"   ,    sorteoN:"396",  fecha:"27 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"0099",letras:"CBAD",serie:"3",folio:"5"},{pos:"2do",num:"95"},{pos:"3er",num:"37"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2979", fecha:"25 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"0436",letras:"BDCC",serie:"22",folio:"8"},{pos:"2do",num:"9347"},{pos:"3er",num:"8880"}] },
  { tipo:"DOMINICAL",   sorteoN:"5466", fecha:"22 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"6568",letras:"DACC",serie:"11",folio:"1"},{pos:"2do",num:"3455"},{pos:"3er",num:"1098"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2978", fecha:"18 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"3251",letras:"DDBC",serie:"9",folio:"5"},{pos:"2do",num:"1169"},{pos:"3er",num:"1643"}] },
  { tipo:"DOMINICAL",   sorteoN:"5465", fecha:"15 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"3139",letras:"DCBA",serie:"11",folio:"9"},{pos:"2do",num:"7752"},{pos:"3er",num:"3703"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2977", fecha:"11 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"8773",letras:"ACDA",serie:"18",folio:"1"},{pos:"2do",num:"2957"},{pos:"3er",num:"4993"}] },
  { tipo:"DOMINICAL",   sorteoN:"5464", fecha:"08 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"9330",letras:"DCAC",serie:"28",folio:"4"},{pos:"2do",num:"3584"},{pos:"3er",num:"4930"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2976", fecha:"04 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"1431",letras:"CDAA",serie:"1",folio:"10"},{pos:"2do",num:"5701"},{pos:"3er",num:"6256"}] },
  { tipo:"DOMINICAL",   sorteoN:"5463", fecha:"01 Sep 2024", mes:9, anio:2024,
    premios:[{pos:"1er",num:"8509",letras:"BDCD",serie:"18",folio:"2"},{pos:"2do",num:"9008"},{pos:"3er",num:"0319"}] },
  // AGOSTO 2024
  { tipo:"GORDITO"   ,    sorteoN:"395",  fecha:"30 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"5288",letras:"CCCA",serie:"7",folio:"7"},{pos:"2do",num:"78"},{pos:"3er",num:"85"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2975", fecha:"28 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"4091",letras:"CCBA",serie:"4",folio:"9"},{pos:"2do",num:"0689"},{pos:"3er",num:"3653"}] },
  { tipo:"DOMINICAL",   sorteoN:"5462", fecha:"25 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"5335",letras:"AABD",serie:"9",folio:"2"},{pos:"2do",num:"9709"},{pos:"3er",num:"4012"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2974", fecha:"21 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"3733",letras:"CBDA",serie:"2",folio:"3"},{pos:"2do",num:"7879"},{pos:"3er",num:"9572"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5461", fecha:"18 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"03776",letras:"ADCB",serie:"3",folio:"6"},{pos:"2do",num:"78865"},{pos:"3er",num:"74666"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2973", fecha:"14 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"2567",letras:"CABC",serie:"11",folio:"6"},{pos:"2do",num:"1366"},{pos:"3er",num:"8855"}] },
  { tipo:"DOMINICAL",   sorteoN:"5460", fecha:"11 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"4500",letras:"BBCD",serie:"18",folio:"9"},{pos:"2do",num:"3829"},{pos:"3er",num:"1492"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2972", fecha:"07 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"0903",letras:"CDAD",serie:"13",folio:"15"},{pos:"2do",num:"4125"},{pos:"3er",num:"6191"}] },
  { tipo:"DOMINICAL",   sorteoN:"5459", fecha:"04 Ago 2024", mes:8, anio:2024,
    premios:[{pos:"1er",num:"7852",letras:"CACC",serie:"11",folio:"9"},{pos:"2do",num:"3830"},{pos:"3er",num:"2133"}] },
  // JULIO 2024
  { tipo:"MIERCOLITO",  sorteoN:"2971", fecha:"31 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"7421",letras:"BCBA",serie:"17",folio:"9"},{pos:"2do",num:"5944"},{pos:"3er",num:"6050"}] },
  { tipo:"DOMINICAL",   sorteoN:"5458", fecha:"28 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"1424",letras:"DBCB",serie:"18",folio:"14"},{pos:"2do",num:"2066"},{pos:"3er",num:"6956"}] },
  { tipo:"GORDITO"   ,    sorteoN:"394",  fecha:"26 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"9294",letras:"DABC",serie:"2",folio:"22"},{pos:"2do",num:"74"},{pos:"3er",num:"27"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2970", fecha:"24 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"0021",letras:"DDDD",serie:"5",folio:"15"},{pos:"2do",num:"0693"},{pos:"3er",num:"3000"}] },
  { tipo:"DOMINICAL",   sorteoN:"5457", fecha:"21 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"8057",letras:"BADC",serie:"14",folio:"3"},{pos:"2do",num:"8358"},{pos:"3er",num:"5082"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2969", fecha:"17 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"8378",letras:"BDBD",serie:"6",folio:"2"},{pos:"2do",num:"7625"},{pos:"3er",num:"8883"}] },
  { tipo:"DOMINICAL",   sorteoN:"5456", fecha:"14 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"2046",letras:"DBDD",serie:"16",folio:"7"},{pos:"2do",num:"2016"},{pos:"3er",num:"3493"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2968", fecha:"10 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"7449",letras:"AAAB",serie:"12",folio:"10"},{pos:"2do",num:"8380"},{pos:"3er",num:"2054"}] },
  { tipo:"DOMINICAL",   sorteoN:"5455", fecha:"07 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"8551",letras:"ADAC",serie:"8",folio:"11"},{pos:"2do",num:"2710"},{pos:"3er",num:"0554"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2967", fecha:"03 Jul 2024", mes:7, anio:2024,
    premios:[{pos:"1er",num:"0923",letras:"DDCC",serie:"9",folio:"12"},{pos:"2do",num:"1143"},{pos:"3er",num:"4314"}] },
  // JUNIO 2024
  { tipo:"DOMINICAL",   sorteoN:"5454", fecha:"30 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"7203",letras:"CCCC",serie:"9",folio:"10"},{pos:"2do",num:"8286"},{pos:"3er",num:"7308"}] },
  { tipo:"GORDITO"   ,    sorteoN:"393",  fecha:"28 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"5750",letras:"DCCD",serie:"1",folio:"16"},{pos:"2do",num:"37"},{pos:"3er",num:"47"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2966", fecha:"26 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"3272",letras:"CBAB",serie:"16",folio:"5"},{pos:"2do",num:"0340"},{pos:"3er",num:"1745"}] },
  { tipo:"DOMINICAL",   sorteoN:"5453", fecha:"23 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"9721",letras:"AABC",serie:"22",folio:"5"},{pos:"2do",num:"9007"},{pos:"3er",num:"2279"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2965", fecha:"19 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"3312",letras:"DBCC",serie:"7",folio:"11"},{pos:"2do",num:"0492"},{pos:"3er",num:"0714"}] },
  { tipo:"DOMINICAL",   sorteoN:"5452", fecha:"16 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"2404",letras:"CBBC",serie:"4",folio:"15"},{pos:"2do",num:"2870"},{pos:"3er",num:"4089"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2964", fecha:"12 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"2100",letras:"ADAC",serie:"3",folio:"1"},{pos:"2do",num:"7735"},{pos:"3er",num:"7686"}] },
  { tipo:"DOMINICAL",   sorteoN:"5451", fecha:"09 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"0219",letras:"DCDA",serie:"14",folio:"13"},{pos:"2do",num:"4222"},{pos:"3er",num:"0796"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2963", fecha:"05 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"7016",letras:"ADBC",serie:"1",folio:"3"},{pos:"2do",num:"6731"},{pos:"3er",num:"1749"}] },
  { tipo:"DOMINICAL",   sorteoN:"5450", fecha:"02 Jun 2024", mes:6, anio:2024,
    premios:[{pos:"1er",num:"5350",letras:"ACAA",serie:"13",folio:"5"},{pos:"2do",num:"9051"},{pos:"3er",num:"0984"}] },
  // MAYO 2024
  { tipo:"GORDITO"   ,    sorteoN:"392",  fecha:"31 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"7429",letras:"BBBC",serie:"4",folio:"12"},{pos:"2do",num:"41"},{pos:"3er",num:"50"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2962", fecha:"29 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"4554",letras:"DABA",serie:"9",folio:"15"},{pos:"2do",num:"4716"},{pos:"3er",num:"6194"}] },
  { tipo:"DOMINICAL",   sorteoN:"5449", fecha:"26 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"4074",letras:"ACCB",serie:"12",folio:"11"},{pos:"2do",num:"8917"},{pos:"3er",num:"0990"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2961", fecha:"22 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"8612",letras:"CBBD",serie:"19",folio:"9"},{pos:"2do",num:"5903"},{pos:"3er",num:"4093"}] },
  { tipo:"DOMINICAL",   sorteoN:"5448", fecha:"19 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"3734",letras:"CBBC",serie:"21",folio:"4"},{pos:"2do",num:"6766"},{pos:"3er",num:"9542"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2960", fecha:"15 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"4816",letras:"DCDC",serie:"8",folio:"5"},{pos:"2do",num:"9524"},{pos:"3er",num:"4706"}] },
  { tipo:"DOMINICAL",   sorteoN:"5447", fecha:"12 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"5924",letras:"DABA",serie:"19",folio:"8"},{pos:"2do",num:"3826"},{pos:"3er",num:"4908"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2959", fecha:"08 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"9098",letras:"CAAA",serie:"14",folio:"14"},{pos:"2do",num:"4890"},{pos:"3er",num:"0002"}] },
  { tipo:"DOMINICAL",   sorteoN:"5446", fecha:"05 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"5444",letras:"ABCB",serie:"11",folio:"10"},{pos:"2do",num:"8809"},{pos:"3er",num:"8730"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2958", fecha:"01 May 2024", mes:5, anio:2024,
    premios:[{pos:"1er",num:"1560",letras:"ACDC",serie:"18",folio:"14"},{pos:"2do",num:"8842"},{pos:"3er",num:"7054"}] },
  // ABRIL 2024
  { tipo:"DOMINICAL",   sorteoN:"5445", fecha:"28 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"9917",letras:"DBAC",serie:"12",folio:"5"},{pos:"2do",num:"4559"},{pos:"3er",num:"6713"}] },
  { tipo:"GORDITO"   ,    sorteoN:"391",  fecha:"26 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"8641",letras:"BACD",serie:"5",folio:"17"},{pos:"2do",num:"09"},{pos:"3er",num:"46"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2957", fecha:"24 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"8144",letras:"DDBD",serie:"18",folio:"9"},{pos:"2do",num:"7223"},{pos:"3er",num:"8003"}] },
  { tipo:"DOMINICAL",   sorteoN:"5444", fecha:"21 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"8671",letras:"ADCA",serie:"12",folio:"3"},{pos:"2do",num:"9510"},{pos:"3er",num:"3701"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2956", fecha:"17 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"3553",letras:"ADBC",serie:"5",folio:"8"},{pos:"2do",num:"3949"},{pos:"3er",num:"5468"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5443", fecha:"14 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"37162",letras:"DCDA",serie:"2",folio:"12"},{pos:"2do",num:"83335"},{pos:"3er",num:"72408"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2955", fecha:"10 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"1420",letras:"DDCB",serie:"18",folio:"10"},{pos:"2do",num:"3087"},{pos:"3er",num:"6274"}] },
  { tipo:"DOMINICAL",   sorteoN:"5442", fecha:"07 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"3145",letras:"DDDA",serie:"24",folio:"6"},{pos:"2do",num:"3197"},{pos:"3er",num:"9078"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2954", fecha:"03 Abr 2024", mes:4, anio:2024,
    premios:[{pos:"1er",num:"9231",letras:"CCAC",serie:"21",folio:"4"},{pos:"2do",num:"6687"},{pos:"3er",num:"2110"}] },
  // MARZO 2024
  { tipo:"DOMINICAL",   sorteoN:"5441", fecha:"31 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"6140",letras:"DBDC",serie:"19",folio:"2"},{pos:"2do",num:"8536"},{pos:"3er",num:"5603"}] },
  { tipo:"GORDITO"   ,    sorteoN:"390",  fecha:"29 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"6920",letras:"DBAD",serie:"7",folio:"23"},{pos:"2do",num:"55"},{pos:"3er",num:"56"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2953", fecha:"27 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"0378",letras:"CCDC",serie:"22",folio:"2"},{pos:"2do",num:"5972"},{pos:"3er",num:"4786"}] },
  { tipo:"DOMINICAL",   sorteoN:"5440", fecha:"24 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"2881",letras:"ABCB",serie:"1",folio:"1"},{pos:"2do",num:"2689"},{pos:"3er",num:"1560"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2952", fecha:"20 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"1116",letras:"BADD",serie:"23",folio:"1"},{pos:"2do",num:"3687"},{pos:"3er",num:"2101"}] },
  { tipo:"DOMINICAL",   sorteoN:"5439", fecha:"17 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"9804",letras:"BACB",serie:"14",folio:"3"},{pos:"2do",num:"6970"},{pos:"3er",num:"5637"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2951", fecha:"13 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"4243",letras:"AAAC",serie:"21",folio:"9"},{pos:"2do",num:"5271"},{pos:"3er",num:"2470"}] },
  { tipo:"DOMINICAL",   sorteoN:"5438", fecha:"10 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"4585",letras:"BACB",serie:"7",folio:"13"},{pos:"2do",num:"0555"},{pos:"3er",num:"7784"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2950", fecha:"06 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"7584",letras:"DDBA",serie:"13",folio:"2"},{pos:"2do",num:"2996"},{pos:"3er",num:"0027"}] },
  { tipo:"DOMINICAL",   sorteoN:"5437", fecha:"03 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"5980",letras:"AAAB",serie:"11",folio:"14"},{pos:"2do",num:"9588"},{pos:"3er",num:"0896"}] },
  { tipo:"GORDITO"   ,    sorteoN:"389A", fecha:"01 Mar 2024", mes:3, anio:2024,
    premios:[{pos:"1er",num:"0490",letras:"CACA",serie:"1",folio:"1"},{pos:"2do",num:"84"},{pos:"3er",num:"31"}] },
  // FEBRERO 2024
  { tipo:"MIERCOLITO",  sorteoN:"2949", fecha:"28 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"4187",letras:"ABDC",serie:"11",folio:"7"},{pos:"2do",num:"6778"},{pos:"3er",num:"3360"}] },
  { tipo:"DOMINICAL",   sorteoN:"5436", fecha:"25 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"1894",letras:"BADB",serie:"17",folio:"9"},{pos:"2do",num:"8260"},{pos:"3er",num:"8437"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2948", fecha:"21 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"2661",letras:"DBAA",serie:"21",folio:"6"},{pos:"2do",num:"5015"},{pos:"3er",num:"1430"}] },
  { tipo:"DOMINICAL",   sorteoN:"5435", fecha:"18 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"8230",letras:"CDAC",serie:"13",folio:"10"},{pos:"2do",num:"1370"},{pos:"3er",num:"5381"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2947", fecha:"14 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"4302",letras:"DCCD",serie:"7",folio:"15"},{pos:"2do",num:"2044"},{pos:"3er",num:"0401"}] },
  { tipo:"DOMINICAL",   sorteoN:"5434", fecha:"11 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"6762",letras:"AAAB",serie:"4",folio:"15"},{pos:"2do",num:"6998"},{pos:"3er",num:"6452"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2946", fecha:"07 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"6937",letras:"CDDC",serie:"11",folio:"10"},{pos:"2do",num:"5939"},{pos:"3er",num:"5229"}] },
  { tipo:"DOMINICAL",   sorteoN:"5433", fecha:"04 Feb 2024", mes:2, anio:2024,
    premios:[{pos:"1er",num:"8286",letras:"DBDC",serie:"23",folio:"9"},{pos:"2do",num:"1565"},{pos:"3er",num:"8512"}] },
  // ENERO 2024
  { tipo:"MIERCOLITO",  sorteoN:"2945", fecha:"31 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"8924",letras:"CBDB",serie:"23",folio:"2"},{pos:"2do",num:"4397"},{pos:"3er",num:"9886"}] },
  { tipo:"DOMINICAL",   sorteoN:"5432", fecha:"28 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"8746",letras:"BADB",serie:"25",folio:"3"},{pos:"2do",num:"8066"},{pos:"3er",num:"3919"}] },
  { tipo:"GORDITO"   ,    sorteoN:"389",  fecha:"26 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"9999",letras:"CCAA",serie:"9",folio:"16"},{pos:"2do",num:"57"},{pos:"3er",num:"97"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2944", fecha:"24 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"2245",letras:"CAAB",serie:"17",folio:"2"},{pos:"2do",num:"3049"},{pos:"3er",num:"6599"}] },
  { tipo:"DOMINICAL",   sorteoN:"5431", fecha:"21 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"3621",letras:"BBCB",serie:"8",folio:"15"},{pos:"2do",num:"5802"},{pos:"3er",num:"6453"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2943", fecha:"17 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"4691",letras:"CCAC",serie:"23",folio:"5"},{pos:"2do",num:"4923"},{pos:"3er",num:"8464"}] },
  { tipo:"DOMINICAL",   sorteoN:"5430", fecha:"14 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"5049",letras:"DBAA",serie:"7",folio:"13"},{pos:"2do",num:"3118"},{pos:"3er",num:"8001"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2942", fecha:"10 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"8314",letras:"ADAB",serie:"20",folio:"14"},{pos:"2do",num:"7106"},{pos:"3er",num:"6621"}] },
  { tipo:"DOMINICAL",   sorteoN:"5429", fecha:"07 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"5968",letras:"AADD",serie:"22",folio:"6"},{pos:"2do",num:"6570"},{pos:"3er",num:"4439"}] },
  { tipo:"MIERCOLITO",  sorteoN:"2941", fecha:"03 Ene 2024", mes:1, anio:2024,
    premios:[{pos:"1er",num:"1003",letras:"AABA",serie:"19",folio:"9"},{pos:"2do",num:"0806"},{pos:"3er",num:"2214"}] },

  // ══════ 2023 ══════ — Datos verificados desde suerteloteria.com / lnb.gob.pa
  { tipo:"DOMINICAL", sorteoN:"5376", fecha:"01 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"5826",letras:"BDBB",serie:"25",folio:"12"},{pos:"2do",num:"5760"},{pos:"3er",num:"8026"}] },
  { tipo:"DOMINICAL", sorteoN:"5377", fecha:"08 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"4359",letras:"BACD",serie:"4",folio:"2"},{pos:"2do",num:"5975"},{pos:"3er",num:"4203"}] },
  { tipo:"DOMINICAL", sorteoN:"5378", fecha:"15 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"3358",letras:"DBDD",serie:"15",folio:"11"},{pos:"2do",num:"0815"},{pos:"3er",num:"2895"}] },
  { tipo:"DOMINICAL", sorteoN:"5379", fecha:"22 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"9483",letras:"CDAB",serie:"22",folio:"12"},{pos:"2do",num:"7369"},{pos:"3er",num:"8592"}] },
  { tipo:"DOMINICAL", sorteoN:"5380", fecha:"29 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"8380",letras:"DBDD",serie:"18",folio:"5"},{pos:"2do",num:"5685"},{pos:"3er",num:"8705"}] },
  { tipo:"MIERCOLITO", sorteoN:"2889", fecha:"04 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"5808",letras:"ACAD",serie:"19",folio:"6"},{pos:"2do",num:"3401"},{pos:"3er",num:"9217"}] },
  { tipo:"MIERCOLITO", sorteoN:"2890", fecha:"11 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"9527",letras:"DDBC",serie:"13",folio:"6"},{pos:"2do",num:"4609"},{pos:"3er",num:"1663"}] },
  { tipo:"MIERCOLITO", sorteoN:"2891", fecha:"18 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"2009",letras:"DADC",serie:"22",folio:"8"},{pos:"2do",num:"9671"},{pos:"3er",num:"5951"}] },
  { tipo:"MIERCOLITO", sorteoN:"2892", fecha:"25 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"8647",letras:"CCCA",serie:"15",folio:"9"},{pos:"2do",num:"0904"},{pos:"3er",num:"8576"}] },
  { tipo:"GORDITO", sorteoN:"370", fecha:"27 Ene 2023", mes:1, anio:2023,
    premios:[{pos:"1er",num:"7414",letras:"BDDC",serie:"7",folio:"9"},{pos:"2do",num:"28"},{pos:"3er",num:"43"}] },
  { tipo:"DOMINICAL", sorteoN:"5381", fecha:"05 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"1882",letras:"BDBC",serie:"26",folio:"11"},{pos:"2do",num:"1524"},{pos:"3er",num:"0103"}] },
  { tipo:"DOMINICAL", sorteoN:"5382", fecha:"12 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"7149",letras:"DBDA",serie:"4",folio:"13"},{pos:"2do",num:"1355"},{pos:"3er",num:"5660"}] },
  { tipo:"DOMINICAL", sorteoN:"5383", fecha:"19 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"6201",letras:"ACBB",serie:"6",folio:"15"},{pos:"2do",num:"5192"},{pos:"3er",num:"3962"}] },
  { tipo:"DOMINICAL", sorteoN:"5384", fecha:"26 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"4753",letras:"CBDA",serie:"3",folio:"4"},{pos:"2do",num:"7995"},{pos:"3er",num:"0083"}] },
  { tipo:"MIERCOLITO", sorteoN:"2893", fecha:"01 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"9953",letras:"ACBD",serie:"19",folio:"14"},{pos:"2do",num:"3013"},{pos:"3er",num:"2245"}] },
  { tipo:"MIERCOLITO", sorteoN:"2894", fecha:"08 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"6740",letras:"CDBD",serie:"9",folio:"2"},{pos:"2do",num:"2597"},{pos:"3er",num:"5693"}] },
  { tipo:"MIERCOLITO", sorteoN:"2895", fecha:"15 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"4572",letras:"CAAB",serie:"14",folio:"10"},{pos:"2do",num:"3442"},{pos:"3er",num:"2004"}] },
  { tipo:"MIERCOLITO", sorteoN:"2896", fecha:"22 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"0259",letras:"ABCC",serie:"6",folio:"5"},{pos:"2do",num:"4010"},{pos:"3er",num:"5916"}] },
  { tipo:"GORDITO", sorteoN:"371", fecha:"17 Feb 2023", mes:2, anio:2023,
    premios:[{pos:"1er",num:"6795",letras:"DCCA",serie:"4",folio:"10"},{pos:"2do",num:"36"},{pos:"3er",num:"56"}] },
  { tipo:"DOMINICAL", sorteoN:"5385", fecha:"05 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"5455",letras:"CABC",serie:"23",folio:"3"},{pos:"2do",num:"6121"},{pos:"3er",num:"3841"}] },
  { tipo:"DOMINICAL", sorteoN:"5386", fecha:"12 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"9485",letras:"DDCC",serie:"25",folio:"14"},{pos:"2do",num:"2302"},{pos:"3er",num:"3578"}] },
  { tipo:"DOMINICAL", sorteoN:"5387", fecha:"19 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"0046",letras:"ABDC",serie:"23",folio:"11"},{pos:"2do",num:"3909"},{pos:"3er",num:"3573"}] },
  { tipo:"DOMINICAL", sorteoN:"5388", fecha:"26 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"4965",letras:"DABC",serie:"9",folio:"4"},{pos:"2do",num:"4173"},{pos:"3er",num:"1003"}] },
  { tipo:"MIERCOLITO", sorteoN:"2897", fecha:"01 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"0961",letras:"BADB",serie:"22",folio:"3"},{pos:"2do",num:"1700"},{pos:"3er",num:"0687"}] },
  { tipo:"MIERCOLITO", sorteoN:"2898", fecha:"08 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"9555",letras:"CABB",serie:"4",folio:"10"},{pos:"2do",num:"5197"},{pos:"3er",num:"4244"}] },
  { tipo:"MIERCOLITO", sorteoN:"2899", fecha:"15 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"7212",letras:"DABD",serie:"16",folio:"8"},{pos:"2do",num:"3209"},{pos:"3er",num:"9336"}] },
  { tipo:"MIERCOLITO", sorteoN:"2900", fecha:"22 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"5310",letras:"DCAD",serie:"8",folio:"1"},{pos:"2do",num:"3821"},{pos:"3er",num:"4165"}] },
  { tipo:"MIERCOLITO", sorteoN:"2901", fecha:"29 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"9367",letras:"BDCC",serie:"17",folio:"5"},{pos:"2do",num:"7000"},{pos:"3er",num:"0528"}] },
  { tipo:"GORDITO", sorteoN:"372", fecha:"31 Mar 2023", mes:3, anio:2023,
    premios:[{pos:"1er",num:"0670",letras:"DBCC",serie:"4",folio:"6"},{pos:"2do",num:"40"},{pos:"3er",num:"19"}] },
  { tipo:"DOMINICAL", sorteoN:"5389", fecha:"02 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"9987",letras:"ADCC",serie:"13",folio:"14"},{pos:"2do",num:"0806"},{pos:"3er",num:"7726"}] },
  { tipo:"DOMINICAL", sorteoN:"5390", fecha:"09 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"5414",letras:"ABAB",serie:"17",folio:"12"},{pos:"2do",num:"8878"},{pos:"3er",num:"1857"}] },
  { tipo:"DOMINICAL", sorteoN:"5392", fecha:"23 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"1788",letras:"ACBD",serie:"19",folio:"8"},{pos:"2do",num:"1228"},{pos:"3er",num:"9680"}] },
  { tipo:"DOMINICAL", sorteoN:"5393", fecha:"30 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"3084",letras:"CBAD",serie:"12",folio:"5"},{pos:"2do",num:"4823"},{pos:"3er",num:"6068"}] },
  { tipo:"MIERCOLITO", sorteoN:"2902", fecha:"05 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"6419",letras:"BBAC",serie:"14",folio:"9"},{pos:"2do",num:"5499"},{pos:"3er",num:"4746"}] },
  { tipo:"MIERCOLITO", sorteoN:"2903", fecha:"12 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"1370",letras:"CBAB",serie:"1",folio:"4"},{pos:"2do",num:"6587"},{pos:"3er",num:"7311"}] },
  { tipo:"MIERCOLITO", sorteoN:"2904", fecha:"19 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"0533",letras:"DBBB",serie:"2",folio:"11"},{pos:"2do",num:"7487"},{pos:"3er",num:"6590"}] },
  { tipo:"MIERCOLITO", sorteoN:"2905", fecha:"26 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"5716",letras:"CDBA",serie:"3",folio:"3"},{pos:"2do",num:"7356"},{pos:"3er",num:"6849"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5391", fecha:"16 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"50478",letras:"CCBD",serie:"2",folio:"13"},{pos:"2do",num:"62970"},{pos:"3er",num:"52369"}] },
  { tipo:"GORDITO", sorteoN:"373", fecha:"28 Abr 2023", mes:4, anio:2023,
    premios:[{pos:"1er",num:"1305",letras:"CABD",serie:"1",folio:"19"},{pos:"2do",num:"38"},{pos:"3er",num:"52"}] },
  { tipo:"DOMINICAL", sorteoN:"5394", fecha:"07 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"7574",letras:"BABA",serie:"2",folio:"11"},{pos:"2do",num:"1132"},{pos:"3er",num:"8229"}] },
  { tipo:"DOMINICAL", sorteoN:"5395", fecha:"14 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"2929",letras:"CBBB",serie:"20",folio:"12"},{pos:"2do",num:"3754"},{pos:"3er",num:"5522"}] },
  { tipo:"DOMINICAL", sorteoN:"5396", fecha:"21 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"8947",letras:"DAAA",serie:"4",folio:"12"},{pos:"2do",num:"2879"},{pos:"3er",num:"1169"}] },
  { tipo:"DOMINICAL", sorteoN:"5397", fecha:"28 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"2854",letras:"DCCC",serie:"16",folio:"2"},{pos:"2do",num:"8811"},{pos:"3er",num:"8363"}] },
  { tipo:"MIERCOLITO", sorteoN:"2906", fecha:"03 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"5236",letras:"AADD",serie:"6",folio:"5"},{pos:"2do",num:"1732"},{pos:"3er",num:"8836"}] },
  { tipo:"MIERCOLITO", sorteoN:"2907", fecha:"10 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"1231",letras:"AADC",serie:"8",folio:"12"},{pos:"2do",num:"5567"},{pos:"3er",num:"6774"}] },
  { tipo:"MIERCOLITO", sorteoN:"2908", fecha:"17 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"2299",letras:"ACDB",serie:"12",folio:"13"},{pos:"2do",num:"2652"},{pos:"3er",num:"3698"}] },
  { tipo:"MIERCOLITO", sorteoN:"2909", fecha:"24 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"6840",letras:"DCCD",serie:"17",folio:"4"},{pos:"2do",num:"2118"},{pos:"3er",num:"8492"}] },
  { tipo:"MIERCOLITO", sorteoN:"2910", fecha:"31 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"0489",letras:"DBBD",serie:"20",folio:"8"},{pos:"2do",num:"0523"},{pos:"3er",num:"4257"}] },
  { tipo:"GORDITO", sorteoN:"374", fecha:"26 May 2023", mes:5, anio:2023,
    premios:[{pos:"1er",num:"7390",letras:"CADD",serie:"6",folio:"5"},{pos:"2do",num:"34"},{pos:"3er",num:"38"}] },
  { tipo:"DOMINICAL", sorteoN:"5398", fecha:"04 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"4625",letras:"BCDB",serie:"6",folio:"15"},{pos:"2do",num:"3816"},{pos:"3er",num:"7023"}] },
  { tipo:"DOMINICAL", sorteoN:"5399", fecha:"11 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"3938",letras:"DDCD",serie:"19",folio:"11"},{pos:"2do",num:"7613"},{pos:"3er",num:"3100"}] },
  { tipo:"DOMINICAL", sorteoN:"5400", fecha:"18 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"0083",letras:"ADAB",serie:"10",folio:"6"},{pos:"2do",num:"3699"},{pos:"3er",num:"0844"}] },
  { tipo:"DOMINICAL", sorteoN:"5401", fecha:"25 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"9640",letras:"BDBA",serie:"10",folio:"6"},{pos:"2do",num:"2149"},{pos:"3er",num:"5428"}] },
  { tipo:"MIERCOLITO", sorteoN:"2911", fecha:"07 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"3116",letras:"AACA",serie:"13",folio:"1"},{pos:"2do",num:"6421"},{pos:"3er",num:"2364"}] },
  { tipo:"MIERCOLITO", sorteoN:"2912", fecha:"14 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"9111",letras:"DAAC",serie:"11",folio:"7"},{pos:"2do",num:"5765"},{pos:"3er",num:"5930"}] },
  { tipo:"MIERCOLITO", sorteoN:"2913", fecha:"21 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"0395",letras:"DDCA",serie:"10",folio:"4"},{pos:"2do",num:"1958"},{pos:"3er",num:"5711"}] },
  { tipo:"MIERCOLITO", sorteoN:"2914", fecha:"28 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"5634",letras:"CDCD",serie:"14",folio:"3"},{pos:"2do",num:"9942"},{pos:"3er",num:"7125"}] },
  { tipo:"GORDITO", sorteoN:"375", fecha:"16 Jun 2023", mes:6, anio:2023,
    premios:[{pos:"1er",num:"0833",letras:"CDDB",serie:"7",folio:"18"},{pos:"2do",num:"74"},{pos:"3er",num:"52"}] },
  { tipo:"DOMINICAL", sorteoN:"5402", fecha:"02 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"3735",letras:"BACD",serie:"15",folio:"1"},{pos:"2do",num:"4047"},{pos:"3er",num:"4472"}] },
  { tipo:"DOMINICAL", sorteoN:"5403", fecha:"09 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"6368",letras:"BDCC",serie:"12",folio:"13"},{pos:"2do",num:"8051"},{pos:"3er",num:"5906"}] },
  { tipo:"DOMINICAL", sorteoN:"5404", fecha:"16 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"2770",letras:"BABC",serie:"20",folio:"13"},{pos:"2do",num:"7208"},{pos:"3er",num:"3630"}] },
  { tipo:"DOMINICAL", sorteoN:"5405", fecha:"23 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"1658",letras:"CCBC",serie:"18",folio:"4"},{pos:"2do",num:"3622"},{pos:"3er",num:"7784"}] },
  { tipo:"DOMINICAL", sorteoN:"5406", fecha:"30 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"7217",letras:"BDCC",serie:"2",folio:"3"},{pos:"2do",num:"2609"},{pos:"3er",num:"2270"}] },
  { tipo:"MIERCOLITO", sorteoN:"2915", fecha:"05 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"3411",letras:"ACDA",serie:"8",folio:"5"},{pos:"2do",num:"3323"},{pos:"3er",num:"8575"}] },
  { tipo:"MIERCOLITO", sorteoN:"2916", fecha:"12 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"1933",letras:"ABCC",serie:"15",folio:"10"},{pos:"2do",num:"8395"},{pos:"3er",num:"8608"}] },
  { tipo:"MIERCOLITO", sorteoN:"2917", fecha:"19 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"0221",letras:"DBCA",serie:"20",folio:"7"},{pos:"2do",num:"2004"},{pos:"3er",num:"8580"}] },
  { tipo:"MIERCOLITO", sorteoN:"2918", fecha:"26 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"3038",letras:"AABD",serie:"14",folio:"12"},{pos:"2do",num:"6249"},{pos:"3er",num:"9779"}] },
  { tipo:"GORDITO", sorteoN:"376", fecha:"21 Jul 2023", mes:7, anio:2023,
    premios:[{pos:"1er",num:"9889",letras:"ADCC",serie:"5",folio:"9"},{pos:"2do",num:"82"},{pos:"3er",num:"24"}] },
  { tipo:"DOMINICAL", sorteoN:"5407", fecha:"06 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"2781",letras:"DDAC",serie:"19",folio:"6"},{pos:"2do",num:"8416"},{pos:"3er",num:"4621"}] },
  { tipo:"DOMINICAL", sorteoN:"5408", fecha:"13 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"1985",letras:"AACC",serie:"19",folio:"8"},{pos:"2do",num:"3335"},{pos:"3er",num:"0001"}] },
  { tipo:"DOMINICAL", sorteoN:"5410", fecha:"27 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"4312",letras:"CADA",serie:"10",folio:"5"},{pos:"2do",num:"9089"},{pos:"3er",num:"6021"}] },
  { tipo:"MIERCOLITO", sorteoN:"2919", fecha:"02 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"6480",letras:"BCAC",serie:"8",folio:"11"},{pos:"2do",num:"9228"},{pos:"3er",num:"0417"}] },
  { tipo:"MIERCOLITO", sorteoN:"2920", fecha:"09 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"1859",letras:"CDDD",serie:"1",folio:"13"},{pos:"2do",num:"2563"},{pos:"3er",num:"0572"}] },
  { tipo:"MIERCOLITO", sorteoN:"2921", fecha:"16 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"7216",letras:"DBCD",serie:"14",folio:"1"},{pos:"2do",num:"4133"},{pos:"3er",num:"2604"}] },
  { tipo:"MIERCOLITO", sorteoN:"2922", fecha:"23 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"5167",letras:"CADC",serie:"1",folio:"13"},{pos:"2do",num:"8410"},{pos:"3er",num:"1940"}] },
  { tipo:"MIERCOLITO", sorteoN:"2923", fecha:"30 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"1765",letras:"DCDC",serie:"12",folio:"7"},{pos:"2do",num:"1273"},{pos:"3er",num:"1043"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5409", fecha:"20 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"77610",letras:"BBCB",serie:"2",folio:"14"},{pos:"2do",num:"25662"},{pos:"3er",num:"65848"}] },
  { tipo:"GORDITO", sorteoN:"377", fecha:"25 Ago 2023", mes:8, anio:2023,
    premios:[{pos:"1er",num:"4812",letras:"BDBD",serie:"5",folio:"25"},{pos:"2do",num:"41"},{pos:"3er",num:"80"}] },
  { tipo:"DOMINICAL", sorteoN:"5411", fecha:"03 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"9527",letras:"CDCB",serie:"2",folio:"1"},{pos:"2do",num:"4317"},{pos:"3er",num:"0168"}] },
  { tipo:"DOMINICAL", sorteoN:"5412", fecha:"10 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"0576",letras:"BDCD",serie:"15",folio:"1"},{pos:"2do",num:"3417"},{pos:"3er",num:"6562"}] },
  { tipo:"DOMINICAL", sorteoN:"5413", fecha:"17 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"1790",letras:"AABB",serie:"12",folio:"11"},{pos:"2do",num:"1793"},{pos:"3er",num:"5153"}] },
  { tipo:"DOMINICAL", sorteoN:"5414", fecha:"24 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"6209",letras:"DCDD",serie:"3",folio:"15"},{pos:"2do",num:"0600"},{pos:"3er",num:"8851"}] },
  { tipo:"MIERCOLITO", sorteoN:"2924", fecha:"06 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"6718",letras:"DBDB",serie:"18",folio:"11"},{pos:"2do",num:"0482"},{pos:"3er",num:"7281"}] },
  { tipo:"MIERCOLITO", sorteoN:"2925", fecha:"13 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"2251",letras:"ACAC",serie:"13",folio:"4"},{pos:"2do",num:"4090"},{pos:"3er",num:"4415"}] },
  { tipo:"MIERCOLITO", sorteoN:"2926", fecha:"20 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"2288",letras:"BBAC",serie:"7",folio:"1"},{pos:"2do",num:"6896"},{pos:"3er",num:"2571"}] },
  { tipo:"MIERCOLITO", sorteoN:"2927", fecha:"27 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"2406",letras:"AAAA",serie:"2",folio:"6"},{pos:"2do",num:"2054"},{pos:"3er",num:"0626"}] },
  { tipo:"GORDITO", sorteoN:"378", fecha:"29 Sep 2023", mes:9, anio:2023,
    premios:[{pos:"1er",num:"6698",letras:"ABCB",serie:"5",folio:"20"},{pos:"2do",num:"42"},{pos:"3er",num:"14"}] },
  { tipo:"DOMINICAL", sorteoN:"5415", fecha:"01 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"9076",letras:"CBAD",serie:"7",folio:"1"},{pos:"2do",num:"8719"},{pos:"3er",num:"2534"}] },
  { tipo:"DOMINICAL", sorteoN:"5416", fecha:"08 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"1600",letras:"CAAC",serie:"22",folio:"11"},{pos:"2do",num:"0348"},{pos:"3er",num:"4120"}] },
  { tipo:"DOMINICAL", sorteoN:"5417", fecha:"15 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"6012",letras:"BACC",serie:"25",folio:"15"},{pos:"2do",num:"1099"},{pos:"3er",num:"2766"}] },
  { tipo:"DOMINICAL", sorteoN:"5418", fecha:"22 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"7691",letras:"CDCC",serie:"22",folio:"13"},{pos:"2do",num:"7485"},{pos:"3er",num:"0308"}] },
  { tipo:"DOMINICAL", sorteoN:"5419", fecha:"29 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"6837",letras:"BCDA",serie:"11",folio:"12"},{pos:"2do",num:"7960"},{pos:"3er",num:"5436"}] },
  { tipo:"MIERCOLITO", sorteoN:"2928", fecha:"04 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"9066",letras:"CBAD",serie:"4",folio:"11"},{pos:"2do",num:"3720"},{pos:"3er",num:"9941"}] },
  { tipo:"MIERCOLITO", sorteoN:"2929", fecha:"11 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"4005",letras:"ABBB",serie:"22",folio:"11"},{pos:"2do",num:"6410"},{pos:"3er",num:"0753"}] },
  { tipo:"MIERCOLITO", sorteoN:"2930", fecha:"18 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"7350",letras:"CDBC",serie:"23",folio:"14"},{pos:"2do",num:"0057"},{pos:"3er",num:"8721"}] },
  { tipo:"MIERCOLITO", sorteoN:"2931", fecha:"25 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"9892",letras:"DCAD",serie:"14",folio:"13"},{pos:"2do",num:"3022"},{pos:"3er",num:"3129"}] },
  { tipo:"GORDITO", sorteoN:"379", fecha:"20 Oct 2023", mes:10, anio:2023,
    premios:[{pos:"1er",num:"6836",letras:"BBCA",serie:"2",folio:"24"},{pos:"2do",num:"59"},{pos:"3er",num:"71"}] },
  { tipo:"DOMINICAL", sorteoN:"5420", fecha:"05 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"6184",letras:"CDCD",serie:"16",folio:"15"},{pos:"2do",num:"5188"},{pos:"3er",num:"1788"}] },
  { tipo:"DOMINICAL", sorteoN:"5421", fecha:"12 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"4867",letras:"ACBD",serie:"13",folio:"13"},{pos:"2do",num:"8916"},{pos:"3er",num:"1119"}] },
  { tipo:"DOMINICAL", sorteoN:"5422", fecha:"19 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"5926",letras:"ABDC",serie:"15",folio:"15"},{pos:"2do",num:"4785"},{pos:"3er",num:"6039"}] },
  { tipo:"DOMINICAL", sorteoN:"5423", fecha:"26 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"3299",letras:"DACB",serie:"7",folio:"12"},{pos:"2do",num:"2334"},{pos:"3er",num:"7265"}] },
  { tipo:"MIERCOLITO", sorteoN:"2932", fecha:"01 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"3211",letras:"AADD",serie:"2",folio:"14"},{pos:"2do",num:"7509"},{pos:"3er",num:"9332"}] },
  { tipo:"MIERCOLITO", sorteoN:"2933", fecha:"08 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"6455",letras:"AACB",serie:"6",folio:"5"},{pos:"2do",num:"6390"},{pos:"3er",num:"5755"}] },
  { tipo:"MIERCOLITO", sorteoN:"2934", fecha:"15 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"6286",letras:"BCAC",serie:"11",folio:"5"},{pos:"2do",num:"7808"},{pos:"3er",num:"3826"}] },
  { tipo:"MIERCOLITO", sorteoN:"2935", fecha:"22 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"4573",letras:"AABD",serie:"16",folio:"4"},{pos:"2do",num:"3612"},{pos:"3er",num:"2145"}] },
  { tipo:"MIERCOLITO", sorteoN:"2936", fecha:"29 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"7950",letras:"BBBD",serie:"6",folio:"11"},{pos:"2do",num:"6823"},{pos:"3er",num:"2751"}] },
  { tipo:"GORDITO", sorteoN:"380", fecha:"17 Nov 2023", mes:11, anio:2023,
    premios:[{pos:"1er",num:"4231",letras:"CBBA",serie:"8",folio:"12"},{pos:"2do",num:"01"},{pos:"3er",num:"25"}] },
  { tipo:"DOMINICAL", sorteoN:"5424", fecha:"03 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"0991",letras:"DCDD",serie:"3",folio:"2"},{pos:"2do",num:"1886"},{pos:"3er",num:"8287"}] },
  { tipo:"DOMINICAL", sorteoN:"5425", fecha:"10 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"7300",letras:"DBCD",serie:"2",folio:"4"},{pos:"2do",num:"1920"},{pos:"3er",num:"6301"}] },
  { tipo:"DOMINICAL", sorteoN:"5427", fecha:"24 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"9059",letras:"BCDA",serie:"4",folio:"4"},{pos:"2do",num:"7290"},{pos:"3er",num:"2327"}] },
  { tipo:"DOMINICAL", sorteoN:"5428", fecha:"31 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"3700",letras:"DACC",serie:"4",folio:"9"},{pos:"2do",num:"9265"},{pos:"3er",num:"7842"}] },
  { tipo:"MIERCOLITO", sorteoN:"2937", fecha:"06 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"4394",letras:"ADCD",serie:"21",folio:"7"},{pos:"2do",num:"9518"},{pos:"3er",num:"3699"}] },
  { tipo:"MIERCOLITO", sorteoN:"2938", fecha:"13 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"3094",letras:"ADCA",serie:"12",folio:"10"},{pos:"2do",num:"5071"},{pos:"3er",num:"9330"}] },
  { tipo:"MIERCOLITO", sorteoN:"2939", fecha:"20 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"2619",letras:"DACD",serie:"10",folio:"7"},{pos:"2do",num:"4650"},{pos:"3er",num:"0614"}] },
  { tipo:"MIERCOLITO", sorteoN:"2940", fecha:"27 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"9395",letras:"ABAD",serie:"17",folio:"11"},{pos:"2do",num:"4894"},{pos:"3er",num:"1974"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5426", fecha:"17 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"50611",letras:"CCCD",serie:"2",folio:"7"},{pos:"2do",num:"02349"},{pos:"3er",num:"55598"}] },
  { tipo:"GORDITO", sorteoN:"381", fecha:"29 Dic 2023", mes:12, anio:2023,
    premios:[{pos:"1er",num:"0312",letras:"CDAB",serie:"9",folio:"18"},{pos:"2do",num:"69"},{pos:"3er",num:"86"}] },
  // ══════ 2022 ══════ — Datos verificados desde suerteloteria.com / lnb.gob.pa
  { tipo:"DOMINICAL", sorteoN:"5324", fecha:"02 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"3019",letras:"BAAC",serie:"9",folio:"3"},{pos:"2do",num:"5237"},{pos:"3er",num:"8527"}] },
  { tipo:"DOMINICAL", sorteoN:"5325", fecha:"09 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"0234",letras:"CBBA",serie:"18",folio:"13"},{pos:"2do",num:"6702"},{pos:"3er",num:"2588"}] },
  { tipo:"DOMINICAL", sorteoN:"5326", fecha:"16 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"4982",letras:"CABB",serie:"1",folio:"1"},{pos:"2do",num:"4286"},{pos:"3er",num:"3103"}] },
  { tipo:"DOMINICAL", sorteoN:"5327", fecha:"23 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"5586",letras:"CDCA",serie:"18",folio:"13"},{pos:"2do",num:"0343"},{pos:"3er",num:"2713"}] },
  { tipo:"DOMINICAL", sorteoN:"5328", fecha:"30 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"1369",letras:"BDAD",serie:"11",folio:"12"},{pos:"2do",num:"2776"},{pos:"3er",num:"5787"}] },
  { tipo:"MIERCOLITO", sorteoN:"2837", fecha:"05 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"8526",letras:"DDDB",serie:"19",folio:"13"},{pos:"2do",num:"3305"},{pos:"3er",num:"3235"}] },
  { tipo:"MIERCOLITO", sorteoN:"2838", fecha:"12 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"8116",letras:"CDCD",serie:"11",folio:"6"},{pos:"2do",num:"5603"},{pos:"3er",num:"2345"}] },
  { tipo:"MIERCOLITO", sorteoN:"2839", fecha:"19 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"8462",letras:"DCBB",serie:"8",folio:"15"},{pos:"2do",num:"1488"},{pos:"3er",num:"1223"}] },
  { tipo:"MIERCOLITO", sorteoN:"2840", fecha:"26 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"0034",letras:"AACC",serie:"14",folio:"8"},{pos:"2do",num:"9845"},{pos:"3er",num:"0707"}] },
  { tipo:"GORDITO", sorteoN:"358", fecha:"28 Ene 2022", mes:1, anio:2022,
    premios:[{pos:"1er",num:"5969",letras:"BCCD",serie:"3",folio:"13"},{pos:"2do",num:"11"},{pos:"3er",num:"24"}] },
  { tipo:"DOMINICAL", sorteoN:"5329", fecha:"06 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"2763",letras:"CCBD",serie:"20",folio:"8"},{pos:"2do",num:"2710"},{pos:"3er",num:"6554"}] },
  { tipo:"DOMINICAL", sorteoN:"5330", fecha:"13 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"9432",letras:"CBAB",serie:"11",folio:"12"},{pos:"2do",num:"3642"},{pos:"3er",num:"9859"}] },
  { tipo:"DOMINICAL", sorteoN:"5331", fecha:"20 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"6646",letras:"BDCA",serie:"7",folio:"1"},{pos:"2do",num:"2385"},{pos:"3er",num:"8337"}] },
  { tipo:"DOMINICAL", sorteoN:"5332", fecha:"27 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"8349",letras:"BDDB",serie:"13",folio:"1"},{pos:"2do",num:"7431"},{pos:"3er",num:"3702"}] },
  { tipo:"MIERCOLITO", sorteoN:"2841", fecha:"02 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"6417",letras:"ABCC",serie:"18",folio:"5"},{pos:"2do",num:"8566"},{pos:"3er",num:"8692"}] },
  { tipo:"MIERCOLITO", sorteoN:"2842", fecha:"09 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"8676",letras:"BABC",serie:"7",folio:"9"},{pos:"2do",num:"8709"},{pos:"3er",num:"8509"}] },
  { tipo:"MIERCOLITO", sorteoN:"2843", fecha:"16 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"2616",letras:"DDBB",serie:"11",folio:"3"},{pos:"2do",num:"1781"},{pos:"3er",num:"8009"}] },
  { tipo:"MIERCOLITO", sorteoN:"2844", fecha:"23 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"0090",letras:"ACAC",serie:"22",folio:"1"},{pos:"2do",num:"9907"},{pos:"3er",num:"7326"}] },
  { tipo:"GORDITO", sorteoN:"359", fecha:"25 Feb 2022", mes:2, anio:2022,
    premios:[{pos:"1er",num:"5871",letras:"ADAB",serie:"2",folio:"15"},{pos:"2do",num:"82"},{pos:"3er",num:"77"}] },
  { tipo:"DOMINICAL", sorteoN:"5333", fecha:"06 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"9994",letras:"ABDA",serie:"8",folio:"11"},{pos:"2do",num:"1069"},{pos:"3er",num:"3195"}] },
  { tipo:"DOMINICAL", sorteoN:"5334", fecha:"13 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"0712",letras:"BBBC",serie:"14",folio:"3"},{pos:"2do",num:"6536"},{pos:"3er",num:"9826"}] },
  { tipo:"DOMINICAL", sorteoN:"5335", fecha:"20 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"6274",letras:"BBBB",serie:"13",folio:"9"},{pos:"2do",num:"7696"},{pos:"3er",num:"5421"}] },
  { tipo:"DOMINICAL", sorteoN:"5336", fecha:"27 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"3247",letras:"BBDC",serie:"26",folio:"13"},{pos:"2do",num:"3524"},{pos:"3er",num:"3257"}] },
  { tipo:"MIERCOLITO", sorteoN:"2845", fecha:"02 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"8371",letras:"BAAC",serie:"13",folio:"9"},{pos:"2do",num:"4558"},{pos:"3er",num:"0924"}] },
  { tipo:"MIERCOLITO", sorteoN:"2846", fecha:"09 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"3667",letras:"AABC",serie:"18",folio:"15"},{pos:"2do",num:"5943"},{pos:"3er",num:"7058"}] },
  { tipo:"MIERCOLITO", sorteoN:"2847", fecha:"16 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"5202",letras:"CCDB",serie:"8",folio:"6"},{pos:"2do",num:"0766"},{pos:"3er",num:"6160"}] },
  { tipo:"MIERCOLITO", sorteoN:"2848", fecha:"23 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"2439",letras:"BDDB",serie:"7",folio:"1"},{pos:"2do",num:"1076"},{pos:"3er",num:"5496"}] },
  { tipo:"MIERCOLITO", sorteoN:"2849", fecha:"30 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"4251",letras:"ADAC",serie:"18",folio:"14"},{pos:"2do",num:"3388"},{pos:"3er",num:"2220"}] },
  { tipo:"GORDITO", sorteoN:"360", fecha:"25 Mar 2022", mes:3, anio:2022,
    premios:[{pos:"1er",num:"7402",letras:"DDDA",serie:"5",folio:"3"},{pos:"2do",num:"30"},{pos:"3er",num:"47"}] },
  { tipo:"DOMINICAL", sorteoN:"5337", fecha:"03 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"5503",letras:"ABAD",serie:"22",folio:"13"},{pos:"2do",num:"8743"},{pos:"3er",num:"9648"}] },
  { tipo:"DOMINICAL", sorteoN:"5338", fecha:"10 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"4957",letras:"BDAA",serie:"9",folio:"5"},{pos:"2do",num:"2853"},{pos:"3er",num:"7526"}] },
  { tipo:"DOMINICAL", sorteoN:"5340", fecha:"24 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"6816",letras:"ACBD",serie:"14",folio:"5"},{pos:"2do",num:"7314"},{pos:"3er",num:"6954"}] },
  { tipo:"MIERCOLITO", sorteoN:"2850", fecha:"06 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"3910",letras:"BDAA",serie:"16",folio:"15"},{pos:"2do",num:"0043"},{pos:"3er",num:"2912"}] },
  { tipo:"MIERCOLITO", sorteoN:"2851", fecha:"13 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"9601",letras:"CBDB",serie:"8",folio:"6"},{pos:"2do",num:"0201"},{pos:"3er",num:"4630"}] },
  { tipo:"MIERCOLITO", sorteoN:"2852", fecha:"20 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"0050",letras:"AABB",serie:"4",folio:"15"},{pos:"2do",num:"4518"},{pos:"3er",num:"7004"}] },
  { tipo:"MIERCOLITO", sorteoN:"2853", fecha:"27 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"0066",letras:"CBAC",serie:"3",folio:"2"},{pos:"2do",num:"3733"},{pos:"3er",num:"3237"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5339", fecha:"17 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"24004",letras:"AABC",serie:"1",folio:"4"},{pos:"2do",num:"41828"},{pos:"3er",num:"16739"}] },
  { tipo:"GORDITO", sorteoN:"361", fecha:"29 Abr 2022", mes:4, anio:2022,
    premios:[{pos:"1er",num:"0231",letras:"CCCA",serie:"7",folio:"9"},{pos:"2do",num:"58"},{pos:"3er",num:"68"}] },
  { tipo:"DOMINICAL", sorteoN:"5341", fecha:"01 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"6220",letras:"ABDA",serie:"17",folio:"6"},{pos:"2do",num:"8143"},{pos:"3er",num:"8039"}] },
  { tipo:"DOMINICAL", sorteoN:"5342", fecha:"08 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"6376",letras:"CCCA",serie:"3",folio:"8"},{pos:"2do",num:"9404"},{pos:"3er",num:"6093"}] },
  { tipo:"DOMINICAL", sorteoN:"5343", fecha:"15 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"4037",letras:"AADB",serie:"2",folio:"10"},{pos:"2do",num:"6303"},{pos:"3er",num:"1095"}] },
  { tipo:"DOMINICAL", sorteoN:"5344", fecha:"22 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"4708",letras:"DBCA",serie:"18",folio:"6"},{pos:"2do",num:"4221"},{pos:"3er",num:"7747"}] },
  { tipo:"DOMINICAL", sorteoN:"5345", fecha:"29 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"0913",letras:"AACA",serie:"25",folio:"10"},{pos:"2do",num:"8168"},{pos:"3er",num:"7499"}] },
  { tipo:"MIERCOLITO", sorteoN:"2854", fecha:"04 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"9338",letras:"DBBD",serie:"15",folio:"8"},{pos:"2do",num:"4604"},{pos:"3er",num:"8396"}] },
  { tipo:"MIERCOLITO", sorteoN:"2855", fecha:"11 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"3640",letras:"CADC",serie:"4",folio:"7"},{pos:"2do",num:"4060"},{pos:"3er",num:"3510"}] },
  { tipo:"MIERCOLITO", sorteoN:"2856", fecha:"18 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"3240",letras:"BBDD",serie:"18",folio:"9"},{pos:"2do",num:"1285"},{pos:"3er",num:"9697"}] },
  { tipo:"MIERCOLITO", sorteoN:"2857", fecha:"25 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"4701",letras:"ADCA",serie:"20",folio:"13"},{pos:"2do",num:"7622"},{pos:"3er",num:"4314"}] },
  { tipo:"GORDITO", sorteoN:"362", fecha:"27 May 2022", mes:5, anio:2022,
    premios:[{pos:"1er",num:"0731",letras:"CAAD",serie:"2",folio:"12"},{pos:"2do",num:"40"},{pos:"3er",num:"08"}] },
  { tipo:"DOMINICAL", sorteoN:"5346", fecha:"05 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"5380",letras:"BDBD",serie:"7",folio:"10"},{pos:"2do",num:"2276"},{pos:"3er",num:"4705"}] },
  { tipo:"DOMINICAL", sorteoN:"5347", fecha:"12 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"4415",letras:"BCBB",serie:"21",folio:"14"},{pos:"2do",num:"1704"},{pos:"3er",num:"2966"}] },
  { tipo:"DOMINICAL", sorteoN:"5348", fecha:"19 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"5076",letras:"CACA",serie:"19",folio:"13"},{pos:"2do",num:"5084"},{pos:"3er",num:"3709"}] },
  { tipo:"DOMINICAL", sorteoN:"5349", fecha:"26 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"3665",letras:"BDCA",serie:"16",folio:"7"},{pos:"2do",num:"3985"},{pos:"3er",num:"3639"}] },
  { tipo:"MIERCOLITO", sorteoN:"2858", fecha:"01 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"9914",letras:"ABCC",serie:"22",folio:"5"},{pos:"2do",num:"5652"},{pos:"3er",num:"6161"}] },
  { tipo:"MIERCOLITO", sorteoN:"2859", fecha:"08 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"2822",letras:"ACCD",serie:"20",folio:"6"},{pos:"2do",num:"4167"},{pos:"3er",num:"7949"}] },
  { tipo:"MIERCOLITO", sorteoN:"2860", fecha:"15 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"5881",letras:"AABB",serie:"5",folio:"8"},{pos:"2do",num:"2339"},{pos:"3er",num:"5082"}] },
  { tipo:"MIERCOLITO", sorteoN:"2861", fecha:"22 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"2200",letras:"BCCC",serie:"20",folio:"14"},{pos:"2do",num:"9849"},{pos:"3er",num:"9854"}] },
  { tipo:"MIERCOLITO", sorteoN:"2862", fecha:"29 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"5727",letras:"BDBD",serie:"14",folio:"8"},{pos:"2do",num:"6958"},{pos:"3er",num:"5336"}] },
  { tipo:"GORDITO", sorteoN:"363", fecha:"24 Jun 2022", mes:6, anio:2022,
    premios:[{pos:"1er",num:"9016",letras:"CBCB",serie:"3",folio:"10"},{pos:"2do",num:"67"},{pos:"3er",num:"41"}] },
  { tipo:"DOMINICAL", sorteoN:"5350", fecha:"03 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"2114",letras:"DACB",serie:"14",folio:"6"},{pos:"2do",num:"8317"},{pos:"3er",num:"9963"}] },
  { tipo:"DOMINICAL", sorteoN:"5351", fecha:"10 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"7479",letras:"ADAD",serie:"1",folio:"12"},{pos:"2do",num:"9318"},{pos:"3er",num:"0673"}] },
  { tipo:"DOMINICAL", sorteoN:"5352", fecha:"17 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"7042",letras:"ACBA",serie:"18",folio:"3"},{pos:"2do",num:"4594"},{pos:"3er",num:"1453"}] },
  { tipo:"DOMINICAL", sorteoN:"5353", fecha:"24 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"6896",letras:"DBDC",serie:"11",folio:"2"},{pos:"2do",num:"9613"},{pos:"3er",num:"1134"}] },
  { tipo:"DOMINICAL", sorteoN:"5354", fecha:"31 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"3492",letras:"CDDD",serie:"21",folio:"5"},{pos:"2do",num:"5249"},{pos:"3er",num:"3799"}] },
  { tipo:"MIERCOLITO", sorteoN:"2863", fecha:"06 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"3029",letras:"DAAD",serie:"15",folio:"12"},{pos:"2do",num:"8754"},{pos:"3er",num:"2831"}] },
  { tipo:"MIERCOLITO", sorteoN:"2864", fecha:"13 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"3183",letras:"BCCC",serie:"1",folio:"8"},{pos:"2do",num:"7059"},{pos:"3er",num:"2741"}] },
  { tipo:"MIERCOLITO", sorteoN:"2865", fecha:"20 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"1741",letras:"CBAA",serie:"12",folio:"5"},{pos:"2do",num:"5135"},{pos:"3er",num:"6671"}] },
  { tipo:"MIERCOLITO", sorteoN:"2866", fecha:"27 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"1360",letras:"ADBA",serie:"11",folio:"13"},{pos:"2do",num:"3019"},{pos:"3er",num:"4457"}] },
  { tipo:"GORDITO", sorteoN:"364", fecha:"29 Jul 2022", mes:7, anio:2022,
    premios:[{pos:"1er",num:"7590",letras:"DBBC",serie:"3",folio:"10"},{pos:"2do",num:"03"},{pos:"3er",num:"53"}] },
  { tipo:"DOMINICAL", sorteoN:"5355", fecha:"07 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"8595",letras:"CDBB",serie:"2",folio:"2"},{pos:"2do",num:"6034"},{pos:"3er",num:"9990"}] },
  { tipo:"DOMINICAL", sorteoN:"5357", fecha:"21 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"0080",letras:"BBDD",serie:"24",folio:"7"},{pos:"2do",num:"5477"},{pos:"3er",num:"7079"}] },
  { tipo:"DOMINICAL", sorteoN:"5358", fecha:"28 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"3636",letras:"BCDB",serie:"22",folio:"5"},{pos:"2do",num:"3320"},{pos:"3er",num:"8432"}] },
  { tipo:"MIERCOLITO", sorteoN:"2867", fecha:"03 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"2032",letras:"BBBD",serie:"7",folio:"4"},{pos:"2do",num:"0776"},{pos:"3er",num:"5517"}] },
  { tipo:"MIERCOLITO", sorteoN:"2868", fecha:"10 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"8928",letras:"CDBC",serie:"10",folio:"2"},{pos:"2do",num:"6294"},{pos:"3er",num:"6851"}] },
  { tipo:"MIERCOLITO", sorteoN:"2869", fecha:"17 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"3047",letras:"DDBA",serie:"20",folio:"15"},{pos:"2do",num:"6140"},{pos:"3er",num:"3092"}] },
  { tipo:"MIERCOLITO", sorteoN:"2870", fecha:"24 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"8432",letras:"CDDA",serie:"13",folio:"9"},{pos:"2do",num:"0458"},{pos:"3er",num:"2834"}] },
  { tipo:"MIERCOLITO", sorteoN:"2871", fecha:"31 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"1342",letras:"CBCC",serie:"20",folio:"5"},{pos:"2do",num:"6307"},{pos:"3er",num:"3186"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5356", fecha:"14 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"14527",letras:"ADAC",serie:"3",folio:"9"},{pos:"2do",num:"45101"},{pos:"3er",num:"24976"}] },
  { tipo:"GORDITO", sorteoN:"365", fecha:"26 Ago 2022", mes:8, anio:2022,
    premios:[{pos:"1er",num:"4201",letras:"CACC",serie:"8",folio:"21"},{pos:"2do",num:"93"},{pos:"3er",num:"69"}] },
  { tipo:"DOMINICAL", sorteoN:"5359", fecha:"04 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"3520",letras:"AADD",serie:"8",folio:"4"},{pos:"2do",num:"1616"},{pos:"3er",num:"7779"}] },
  { tipo:"DOMINICAL", sorteoN:"5360", fecha:"11 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"3278",letras:"CBCB",serie:"5",folio:"2"},{pos:"2do",num:"4997"},{pos:"3er",num:"6666"}] },
  { tipo:"DOMINICAL", sorteoN:"5361", fecha:"18 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"3266",letras:"DDAA",serie:"16",folio:"12"},{pos:"2do",num:"8321"},{pos:"3er",num:"6984"}] },
  { tipo:"DOMINICAL", sorteoN:"5362", fecha:"25 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"4898",letras:"CDAD",serie:"14",folio:"8"},{pos:"2do",num:"4525"},{pos:"3er",num:"2635"}] },
  { tipo:"MIERCOLITO", sorteoN:"2872", fecha:"07 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"7606",letras:"BDAC",serie:"11",folio:"4"},{pos:"2do",num:"1033"},{pos:"3er",num:"0637"}] },
  { tipo:"MIERCOLITO", sorteoN:"2873", fecha:"14 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"6080",letras:"CDAC",serie:"11",folio:"4"},{pos:"2do",num:"1033"},{pos:"3er",num:"0637"}] },
  { tipo:"MIERCOLITO", sorteoN:"2874", fecha:"21 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"3639",letras:"CACC",serie:"14",folio:"9"},{pos:"2do",num:"4680"},{pos:"3er",num:"0440"}] },
  { tipo:"MIERCOLITO", sorteoN:"2875", fecha:"28 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"1006",letras:"BBBC",serie:"22",folio:"3"},{pos:"2do",num:"9392"},{pos:"3er",num:"6417"}] },
  { tipo:"GORDITO", sorteoN:"366", fecha:"30 Sep 2022", mes:9, anio:2022,
    premios:[{pos:"1er",num:"4747",letras:"CDBA",serie:"7",folio:"24"},{pos:"2do",num:"74"},{pos:"3er",num:"80"}] },
  { tipo:"DOMINICAL", sorteoN:"5363", fecha:"02 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"4779",letras:"ABBB",serie:"12",folio:"14"},{pos:"2do",num:"9559"},{pos:"3er",num:"4532"}] },
  { tipo:"DOMINICAL", sorteoN:"5364", fecha:"09 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"9966",letras:"ACAA",serie:"4",folio:"9"},{pos:"2do",num:"8959"},{pos:"3er",num:"2507"}] },
  { tipo:"DOMINICAL", sorteoN:"5365", fecha:"16 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"8538",letras:"BDCB",serie:"6",folio:"10"},{pos:"2do",num:"1308"},{pos:"3er",num:"4003"}] },
  { tipo:"DOMINICAL", sorteoN:"5366", fecha:"23 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"8498",letras:"CABD",serie:"11",folio:"6"},{pos:"2do",num:"1097"},{pos:"3er",num:"8916"}] },
  { tipo:"DOMINICAL", sorteoN:"5367", fecha:"30 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"9660",letras:"DCCD",serie:"7",folio:"7"},{pos:"2do",num:"6230"},{pos:"3er",num:"9763"}] },
  { tipo:"MIERCOLITO", sorteoN:"2876", fecha:"05 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"9951",letras:"CBCA",serie:"20",folio:"4"},{pos:"2do",num:"1265"},{pos:"3er",num:"7783"}] },
  { tipo:"MIERCOLITO", sorteoN:"2877", fecha:"12 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"2456",letras:"ABDB",serie:"9",folio:"10"},{pos:"2do",num:"7293"},{pos:"3er",num:"3555"}] },
  { tipo:"MIERCOLITO", sorteoN:"2878", fecha:"19 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"0976",letras:"BCDC",serie:"19",folio:"15"},{pos:"2do",num:"8370"},{pos:"3er",num:"8905"}] },
  { tipo:"MIERCOLITO", sorteoN:"2879", fecha:"26 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"6985",letras:"BCAB",serie:"19",folio:"13"},{pos:"2do",num:"1296"},{pos:"3er",num:"5577"}] },
  { tipo:"GORDITO", sorteoN:"367", fecha:"28 Oct 2022", mes:10, anio:2022,
    premios:[{pos:"1er",num:"3106",letras:"DDAA",serie:"7",folio:"18"},{pos:"2do",num:"47"},{pos:"3er",num:"85"}] },
  { tipo:"DOMINICAL", sorteoN:"5368", fecha:"06 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"4560",letras:"DCAC",serie:"25",folio:"7"},{pos:"2do",num:"3085"},{pos:"3er",num:"1201"}] },
  { tipo:"DOMINICAL", sorteoN:"5369", fecha:"13 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"2063",letras:"BAAB",serie:"13",folio:"7"},{pos:"2do",num:"8667"},{pos:"3er",num:"6818"}] },
  { tipo:"DOMINICAL", sorteoN:"5370", fecha:"20 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"1254",letras:"ACBA",serie:"15",folio:"14"},{pos:"2do",num:"3559"},{pos:"3er",num:"8876"}] },
  { tipo:"DOMINICAL", sorteoN:"5371", fecha:"27 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"7257",letras:"ADDB",serie:"23",folio:"7"},{pos:"2do",num:"8158"},{pos:"3er",num:"5914"}] },
  { tipo:"MIERCOLITO", sorteoN:"2880", fecha:"02 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"0238",letras:"DCBA",serie:"1",folio:"12"},{pos:"2do",num:"1025"},{pos:"3er",num:"3871"}] },
  { tipo:"MIERCOLITO", sorteoN:"2881", fecha:"09 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"9860",letras:"ACAB",serie:"11",folio:"1"},{pos:"2do",num:"7479"},{pos:"3er",num:"6624"}] },
  { tipo:"MIERCOLITO", sorteoN:"2882", fecha:"16 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"4574",letras:"BAAC",serie:"4",folio:"1"},{pos:"2do",num:"0347"},{pos:"3er",num:"1751"}] },
  { tipo:"MIERCOLITO", sorteoN:"2883", fecha:"23 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"6968",letras:"BBBA",serie:"1",folio:"2"},{pos:"2do",num:"0137"},{pos:"3er",num:"5271"}] },
  { tipo:"MIERCOLITO", sorteoN:"2884", fecha:"30 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"5251",letras:"AAAC",serie:"4",folio:"13"},{pos:"2do",num:"9259"},{pos:"3er",num:"3385"}] },
  { tipo:"GORDITO", sorteoN:"368", fecha:"25 Nov 2022", mes:11, anio:2022,
    premios:[{pos:"1er",num:"3861",letras:"DADC",serie:"5",folio:"23"},{pos:"2do",num:"88"},{pos:"3er",num:"56"}] },
  { tipo:"DOMINICAL", sorteoN:"5372", fecha:"04 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"0411",letras:"BBDC",serie:"19",folio:"7"},{pos:"2do",num:"8502"},{pos:"3er",num:"7303"}] },
  { tipo:"DOMINICAL", sorteoN:"5373", fecha:"11 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"0667",letras:"DCDD",serie:"19",folio:"1"},{pos:"2do",num:"6284"},{pos:"3er",num:"2642"}] },
  { tipo:"DOMINICAL", sorteoN:"5375", fecha:"24 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"6098",letras:"AABA",serie:"15",folio:"11"},{pos:"2do",num:"1339"},{pos:"3er",num:"9971"}] },
  { tipo:"MIERCOLITO", sorteoN:"2885", fecha:"07 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"8421",letras:"ADCD",serie:"8",folio:"15"},{pos:"2do",num:"8912"},{pos:"3er",num:"0405"}] },
  { tipo:"MIERCOLITO", sorteoN:"2886", fecha:"14 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"1394",letras:"CBBB",serie:"7",folio:"12"},{pos:"2do",num:"2585"},{pos:"3er",num:"4582"}] },
  { tipo:"MIERCOLITO", sorteoN:"2887", fecha:"21 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"4637",letras:"DDBA",serie:"8",folio:"5"},{pos:"2do",num:"1238"},{pos:"3er",num:"5439"}] },
  { tipo:"MIERCOLITO", sorteoN:"2888", fecha:"28 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"3189",letras:"BDAA",serie:"20",folio:"6"},{pos:"2do",num:"1633"},{pos:"3er",num:"5915"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5374", fecha:"18 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"04588",letras:"BABA",serie:"1",folio:"6"},{pos:"2do",num:"97513"},{pos:"3er",num:"53685"}] },
  { tipo:"GORDITO", sorteoN:"369", fecha:"30 Dic 2022", mes:12, anio:2022,
    premios:[{pos:"1er",num:"2013",letras:"BDDD",serie:"2",folio:"6"},{pos:"2do",num:"39"},{pos:"3er",num:"39"}] },

  // ══════ 2021 ══════ — Datos verificados desde balotas.com (j2021.php). Marzo no jugó por COVID-19
  { tipo:"DOMINICAL", sorteoN:"5275", fecha:"24 Ene 2021", mes:1, anio:2021,
    premios:[{pos:"1er",num:"5982",letras:"CDDB",serie:"13",folio:"1"},{pos:"2do",num:"5756"},{pos:"3er",num:"3194"}] },
  { tipo:"DOMINICAL", sorteoN:"5276", fecha:"31 Ene 2021", mes:1, anio:2021,
    premios:[{pos:"1er",num:"0686",letras:"BCDD",serie:"19",folio:"7"},{pos:"2do",num:"0483"},{pos:"3er",num:"0673"}] },
  { tipo:"MIERCOLITO", sorteoN:"2788", fecha:"27 Ene 2021", mes:1, anio:2021,
    premios:[{pos:"1er",num:"3520",letras:"ADDD",serie:"12",folio:"9"},{pos:"2do",num:"7804"},{pos:"3er",num:"0263"}] },
  { tipo:"DOMINICAL", sorteoN:"5277", fecha:"07 Feb 2021", mes:2, anio:2021,
    premios:[{pos:"1er",num:"9016",letras:"AAAC",serie:"4",folio:"8"},{pos:"2do",num:"6923"},{pos:"3er",num:"5506"}] },
  { tipo:"DOMINICAL", sorteoN:"5278", fecha:"14 Feb 2021", mes:2, anio:2021,
    premios:[{pos:"1er",num:"4013",letras:"BDBC",serie:"19",folio:"9"},{pos:"2do",num:"1920"},{pos:"3er",num:"5472"}] },
  { tipo:"DOMINICAL", sorteoN:"5279", fecha:"21 Feb 2021", mes:2, anio:2021,
    premios:[{pos:"1er",num:"3918",letras:"CCAA",serie:"3",folio:"10"},{pos:"2do",num:"9331"},{pos:"3er",num:"3318"}] },
  { tipo:"MIERCOLITO", sorteoN:"2789", fecha:"03 Feb 2021", mes:2, anio:2021,
    premios:[{pos:"1er",num:"1769",letras:"BDDC",serie:"10",folio:"14"},{pos:"2do",num:"0639"},{pos:"3er",num:"2784"}] },
  { tipo:"MIERCOLITO", sorteoN:"2790", fecha:"10 Feb 2021", mes:2, anio:2021,
    premios:[{pos:"1er",num:"4123",letras:"CDCB",serie:"16",folio:"15"},{pos:"2do",num:"8750"},{pos:"3er",num:"0806"}] },
  { tipo:"MIERCOLITO", sorteoN:"2791", fecha:"17 Feb 2021", mes:2, anio:2021,
    premios:[{pos:"1er",num:"8989",letras:"CBBC",serie:"19",folio:"13"},{pos:"2do",num:"3961"},{pos:"3er",num:"3694"}] },
  { tipo:"MIERCOLITO", sorteoN:"2792", fecha:"24 Feb 2021", mes:2, anio:2021,
    premios:[{pos:"1er",num:"1044",letras:"DDDD",serie:"7",folio:"14"},{pos:"2do",num:"9045"},{pos:"3er",num:"0320"}] },
  { tipo:"DOMINICAL", sorteoN:"5288", fecha:"25 Abr 2021", mes:4, anio:2021,
    premios:[{pos:"1er",num:"6255",letras:"BBAC",serie:"12",folio:"2"},{pos:"2do",num:"2656"},{pos:"3er",num:"5282"}] },
  { tipo:"MIERCOLITO", sorteoN:"2801", fecha:"28 Abr 2021", mes:4, anio:2021,
    premios:[{pos:"1er",num:"4511",letras:"CBAB",serie:"13",folio:"5"},{pos:"2do",num:"3827"},{pos:"3er",num:"9195"}] },
  { tipo:"DOMINICAL", sorteoN:"5289", fecha:"02 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"1464",letras:"ABAC",serie:"3",folio:"3"},{pos:"2do",num:"4002"},{pos:"3er",num:"2658"}] },
  { tipo:"DOMINICAL", sorteoN:"5290", fecha:"09 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"1021",letras:"BBCC",serie:"16",folio:"5"},{pos:"2do",num:"8630"},{pos:"3er",num:"9531"}] },
  { tipo:"DOMINICAL", sorteoN:"5291", fecha:"16 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"2814",letras:"DBAA",serie:"6",folio:"3"},{pos:"2do",num:"3989"},{pos:"3er",num:"0486"}] },
  { tipo:"DOMINICAL", sorteoN:"5292", fecha:"23 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"2359",letras:"DDCB",serie:"20",folio:"13"},{pos:"2do",num:"8562"},{pos:"3er",num:"7547"}] },
  { tipo:"DOMINICAL", sorteoN:"5293", fecha:"30 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"9574",letras:"ADCD",serie:"9",folio:"7"},{pos:"2do",num:"4364"},{pos:"3er",num:"1308"}] },
  { tipo:"MIERCOLITO", sorteoN:"2802", fecha:"05 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"5491",letras:"CDDC",serie:"4",folio:"8"},{pos:"2do",num:"0692"},{pos:"3er",num:"6376"}] },
  { tipo:"MIERCOLITO", sorteoN:"2803", fecha:"12 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"4959",letras:"ABCB",serie:"6",folio:"3"},{pos:"2do",num:"9671"},{pos:"3er",num:"7399"}] },
  { tipo:"MIERCOLITO", sorteoN:"2804", fecha:"19 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"0755",letras:"CBAA",serie:"21",folio:"4"},{pos:"2do",num:"4896"},{pos:"3er",num:"5439"}] },
  { tipo:"MIERCOLITO", sorteoN:"2805", fecha:"26 May 2021", mes:5, anio:2021,
    premios:[{pos:"1er",num:"4762",letras:"DDDB",serie:"19",folio:"5"},{pos:"2do",num:"9292"},{pos:"3er",num:"3804"}] },
  { tipo:"DOMINICAL", sorteoN:"5294", fecha:"06 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"9145",letras:"ABDA",serie:"23",folio:"7"},{pos:"2do",num:"0432"},{pos:"3er",num:"0686"}] },
  { tipo:"DOMINICAL", sorteoN:"5295", fecha:"13 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"5139",letras:"BDDD",serie:"14",folio:"13"},{pos:"2do",num:"2401"},{pos:"3er",num:"6484"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5296", fecha:"20 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"54808",letras:"BDAD",serie:"3",folio:"5"},{pos:"2do",num:"01008"},{pos:"3er",num:"03340"}] },
  { tipo:"DOMINICAL", sorteoN:"5297", fecha:"27 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"4374",letras:"DDDA",serie:"14",folio:"8"},{pos:"2do",num:"3227"},{pos:"3er",num:"6342"}] },
  { tipo:"MIERCOLITO", sorteoN:"2806", fecha:"02 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"8171",letras:"DCAC",serie:"16",folio:"4"},{pos:"2do",num:"9893"},{pos:"3er",num:"5970"}] },
  { tipo:"MIERCOLITO", sorteoN:"2807", fecha:"09 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"4025",letras:"DBAA",serie:"4",folio:"12"},{pos:"2do",num:"6520"},{pos:"3er",num:"4910"}] },
  { tipo:"MIERCOLITO", sorteoN:"2808", fecha:"16 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"6352",letras:"BDBB",serie:"6",folio:"14"},{pos:"2do",num:"1124"},{pos:"3er",num:"8907"}] },
  { tipo:"MIERCOLITO", sorteoN:"2809", fecha:"23 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"1542",letras:"DBCB",serie:"21",folio:"5"},{pos:"2do",num:"4214"},{pos:"3er",num:"8374"}] },
  { tipo:"MIERCOLITO", sorteoN:"2810", fecha:"30 Jun 2021", mes:6, anio:2021,
    premios:[{pos:"1er",num:"8805",letras:"BABA",serie:"4",folio:"13"},{pos:"2do",num:"9180"},{pos:"3er",num:"6037"}] },
  { tipo:"DOMINICAL", sorteoN:"5298", fecha:"04 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"9775",letras:"BBCA",serie:"15",folio:"1"},{pos:"2do",num:"4449"},{pos:"3er",num:"9786"}] },
  { tipo:"DOMINICAL", sorteoN:"5299", fecha:"11 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"6634",letras:"CAAB",serie:"12",folio:"4"},{pos:"2do",num:"3356"},{pos:"3er",num:"9173"}] },
  { tipo:"DOMINICAL", sorteoN:"5300", fecha:"18 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"6882",letras:"ADDB",serie:"24",folio:"2"},{pos:"2do",num:"8056"},{pos:"3er",num:"6658"}] },
  { tipo:"DOMINICAL", sorteoN:"5301", fecha:"25 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"9755",letras:"BBBA",serie:"7",folio:"7"},{pos:"2do",num:"7183"},{pos:"3er",num:"2928"}] },
  { tipo:"MIERCOLITO", sorteoN:"2811", fecha:"07 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"8597",letras:"CACD",serie:"11",folio:"3"},{pos:"2do",num:"3558"},{pos:"3er",num:"2042"}] },
  { tipo:"MIERCOLITO", sorteoN:"2812", fecha:"14 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"1954",letras:"ACBD",serie:"2",folio:"10"},{pos:"2do",num:"2169"},{pos:"3er",num:"6807"}] },
  { tipo:"MIERCOLITO", sorteoN:"2813", fecha:"21 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"1513",letras:"DCCD",serie:"19",folio:"5"},{pos:"2do",num:"2076"},{pos:"3er",num:"6257"}] },
  { tipo:"MIERCOLITO", sorteoN:"2814", fecha:"28 Jul 2021", mes:7, anio:2021,
    premios:[{pos:"1er",num:"3838",letras:"AAAB",serie:"13",folio:"11"},{pos:"2do",num:"0394"},{pos:"3er",num:"9675"}] },
  { tipo:"DOMINICAL", sorteoN:"5302", fecha:"02 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"6589",letras:"BCCA",serie:"8",folio:"4"},{pos:"2do",num:"3700"},{pos:"3er",num:"8464"}] },
  { tipo:"DOMINICAL", sorteoN:"5303", fecha:"08 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"2319",letras:"DACA",serie:"8",folio:"5"},{pos:"2do",num:"0335"},{pos:"3er",num:"2395"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5304", fecha:"15 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"06398",letras:"ADAB",serie:"3",folio:"3"},{pos:"2do",num:"26998"},{pos:"3er",num:"63479"}] },
  { tipo:"DOMINICAL", sorteoN:"5305", fecha:"22 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"2468",letras:"BBBA",serie:"13",folio:"10"},{pos:"2do",num:"0765"},{pos:"3er",num:"6728"}] },
  { tipo:"DOMINICAL", sorteoN:"5306", fecha:"29 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"9416",letras:"CCAC",serie:"8",folio:"13"},{pos:"2do",num:"8696"},{pos:"3er",num:"7454"}] },
  { tipo:"MIERCOLITO", sorteoN:"2815", fecha:"05 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"1871",letras:"CABD",serie:"2",folio:"6"},{pos:"2do",num:"2350"},{pos:"3er",num:"9383"}] },
  { tipo:"MIERCOLITO", sorteoN:"2816", fecha:"11 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"7177",letras:"BACA",serie:"17",folio:"15"},{pos:"2do",num:"0805"},{pos:"3er",num:"2678"}] },
  { tipo:"MIERCOLITO", sorteoN:"2817", fecha:"18 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"5114",letras:"CDBA",serie:"17",folio:"9"},{pos:"2do",num:"8939"},{pos:"3er",num:"3055"}] },
  { tipo:"MIERCOLITO", sorteoN:"2818", fecha:"25 Ago 2021", mes:8, anio:2021,
    premios:[{pos:"1er",num:"0587",letras:"BAAD",serie:"22",folio:"7"},{pos:"2do",num:"5719"},{pos:"3er",num:"2479"}] },
  { tipo:"DOMINICAL", sorteoN:"5307", fecha:"05 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"6943",letras:"DADB",serie:"9",folio:"7"},{pos:"2do",num:"7385"},{pos:"3er",num:"4983"}] },
  { tipo:"DOMINICAL", sorteoN:"5308", fecha:"12 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"8772",letras:"DDAB",serie:"23",folio:"1"},{pos:"2do",num:"6210"},{pos:"3er",num:"0090"}] },
  { tipo:"DOMINICAL", sorteoN:"5309", fecha:"19 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"5767",letras:"CAAD",serie:"4",folio:"3"},{pos:"2do",num:"3345"},{pos:"3er",num:"1632"}] },
  { tipo:"DOMINICAL", sorteoN:"5310", fecha:"26 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"2852",letras:"DABA",serie:"26",folio:"8"},{pos:"2do",num:"7115"},{pos:"3er",num:"8173"}] },
  { tipo:"MIERCOLITO", sorteoN:"2819", fecha:"01 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"5058",letras:"BBAA",serie:"8",folio:"2"},{pos:"2do",num:"9507"},{pos:"3er",num:"2139"}] },
  { tipo:"MIERCOLITO", sorteoN:"2820", fecha:"08 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"4987",letras:"ACBD",serie:"20",folio:"9"},{pos:"2do",num:"4124"},{pos:"3er",num:"4477"}] },
  { tipo:"MIERCOLITO", sorteoN:"2821", fecha:"15 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"4306",letras:"CADC",serie:"12",folio:"9"},{pos:"2do",num:"2764"},{pos:"3er",num:"3126"}] },
  { tipo:"MIERCOLITO", sorteoN:"2822", fecha:"22 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"4642",letras:"DBCD",serie:"13",folio:"13"},{pos:"2do",num:"9825"},{pos:"3er",num:"1065"}] },
  { tipo:"MIERCOLITO", sorteoN:"2823", fecha:"29 Sep 2021", mes:9, anio:2021,
    premios:[{pos:"1er",num:"9990",letras:"BBAD",serie:"3",folio:"4"},{pos:"2do",num:"5932"},{pos:"3er",num:"0641"}] },
  { tipo:"DOMINICAL", sorteoN:"5311", fecha:"03 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"7247",letras:"CACC",serie:"5",folio:"2"},{pos:"2do",num:"0226"},{pos:"3er",num:"5995"}] },
  { tipo:"DOMINICAL", sorteoN:"5312", fecha:"10 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"7467",letras:"AAAB",serie:"21",folio:"10"},{pos:"2do",num:"7418"},{pos:"3er",num:"7365"}] },
  { tipo:"DOMINICAL", sorteoN:"5313", fecha:"17 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"1962",letras:"AABD",serie:"6",folio:"12"},{pos:"2do",num:"9301"},{pos:"3er",num:"8493"}] },
  { tipo:"DOMINICAL", sorteoN:"5314", fecha:"24 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"4239",letras:"BBAB",serie:"1",folio:"15"},{pos:"2do",num:"7277"},{pos:"3er",num:"6730"}] },
  { tipo:"MIERCOLITO", sorteoN:"2824", fecha:"06 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"1378",letras:"ABDB",serie:"4",folio:"8"},{pos:"2do",num:"1944"},{pos:"3er",num:"0905"}] },
  { tipo:"MIERCOLITO", sorteoN:"2825", fecha:"13 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"6999",letras:"CBBB",serie:"20",folio:"9"},{pos:"2do",num:"1551"},{pos:"3er",num:"0916"}] },
  { tipo:"MIERCOLITO", sorteoN:"2826", fecha:"20 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"7865",letras:"BDDB",serie:"14",folio:"11"},{pos:"2do",num:"8223"},{pos:"3er",num:"4259"}] },
  { tipo:"MIERCOLITO", sorteoN:"2827", fecha:"27 Oct 2021", mes:10, anio:2021,
    premios:[{pos:"1er",num:"9096",letras:"CBDD",serie:"3",folio:"8"},{pos:"2do",num:"1204"},{pos:"3er",num:"3097"}] },
  { tipo:"DOMINICAL", sorteoN:"5315", fecha:"01 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"8399",letras:"CDAD",serie:"8",folio:"8"},{pos:"2do",num:"1084"},{pos:"3er",num:"4395"}] },
  { tipo:"DOMINICAL", sorteoN:"5316", fecha:"07 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"8958",letras:"BABA",serie:"18",folio:"4"},{pos:"2do",num:"4629"},{pos:"3er",num:"3736"}] },
  { tipo:"DOMINICAL", sorteoN:"5317", fecha:"14 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"3120",letras:"ACDD",serie:"7",folio:"2"},{pos:"2do",num:"3308"},{pos:"3er",num:"7903"}] },
  { tipo:"DOMINICAL", sorteoN:"5318", fecha:"21 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"6004",letras:"DCAC",serie:"19",folio:"7"},{pos:"2do",num:"5112"},{pos:"3er",num:"9977"}] },
  { tipo:"DOMINICAL", sorteoN:"5319", fecha:"28 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"8708",letras:"ABBC",serie:"11",folio:"14"},{pos:"2do",num:"0892"},{pos:"3er",num:"7864"}] },
  { tipo:"MIERCOLITO", sorteoN:"2828", fecha:"03 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"0309",letras:"DBBB",serie:"18",folio:"11"},{pos:"2do",num:"8500"},{pos:"3er",num:"1630"}] },
  { tipo:"MIERCOLITO", sorteoN:"2829", fecha:"10 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"7832",letras:"AACD",serie:"11",folio:"15"},{pos:"2do",num:"8716"},{pos:"3er",num:"9225"}] },
  { tipo:"MIERCOLITO", sorteoN:"2830", fecha:"17 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"9563",letras:"AADD",serie:"21",folio:"9"},{pos:"2do",num:"1728"},{pos:"3er",num:"6398"}] },
  { tipo:"MIERCOLITO", sorteoN:"2831", fecha:"24 Nov 2021", mes:11, anio:2021,
    premios:[{pos:"1er",num:"1193",letras:"CDBD",serie:"14",folio:"7"},{pos:"2do",num:"8605"},{pos:"3er",num:"0378"}] },
  { tipo:"DOMINICAL", sorteoN:"5320", fecha:"05 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"7618",letras:"BBCB",serie:"22",folio:"15"},{pos:"2do",num:"2233"},{pos:"3er",num:"7147"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5321", fecha:"12 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"44557",letras:"DACB",serie:"2",folio:"15"},{pos:"2do",num:"47698"},{pos:"3er",num:"05162"}] },
  { tipo:"DOMINICAL", sorteoN:"5322", fecha:"19 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"7189",letras:"DBCC",serie:"12",folio:"10"},{pos:"2do",num:"3446"},{pos:"3er",num:"4690"}] },
  { tipo:"DOMINICAL", sorteoN:"5323", fecha:"26 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"8613",letras:"CBCC",serie:"10",folio:"7"},{pos:"2do",num:"9170"},{pos:"3er",num:"8891"}] },
  { tipo:"MIERCOLITO", sorteoN:"2832", fecha:"01 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"8060",letras:"CBCB",serie:"7",folio:"7"},{pos:"2do",num:"6731"},{pos:"3er",num:"4420"}] },
  { tipo:"MIERCOLITO", sorteoN:"2833", fecha:"08 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"4382",letras:"CDDD",serie:"15",folio:"15"},{pos:"2do",num:"1856"},{pos:"3er",num:"9239"}] },
  { tipo:"MIERCOLITO", sorteoN:"2834", fecha:"15 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"1730",letras:"ABAA",serie:"11",folio:"7"},{pos:"2do",num:"6678"},{pos:"3er",num:"9139"}] },
  { tipo:"MIERCOLITO", sorteoN:"2835", fecha:"22 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"3154",letras:"CDDB",serie:"13",folio:"3"},{pos:"2do",num:"4632"},{pos:"3er",num:"9230"}] },
  { tipo:"MIERCOLITO", sorteoN:"2836", fecha:"29 Dic 2021", mes:12, anio:2021,
    premios:[{pos:"1er",num:"7343",letras:"DBBC",serie:"12",folio:"3"},{pos:"2do",num:"2401"},{pos:"3er",num:"1074"}] },
  // ══════ 2020 ══════ — Datos verificados desde balotas.com (j2020.php). Sorteos suspendidos del 17 jun por COVID-19
  { tipo:"DOMINICAL", sorteoN:"5220", fecha:"05 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"2122",letras:"ADDB",serie:"9",folio:"8"},{pos:"2do",num:"8140"},{pos:"3er",num:"3389"}] },
  { tipo:"DOMINICAL", sorteoN:"5221", fecha:"12 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"3378",letras:"DBAD",serie:"25",folio:"15"},{pos:"2do",num:"0533"},{pos:"3er",num:"7273"}] },
  { tipo:"DOMINICAL", sorteoN:"5222", fecha:"19 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"6173",letras:"CDCA",serie:"4",folio:"2"},{pos:"2do",num:"6376"},{pos:"3er",num:"0165"}] },
  { tipo:"DOMINICAL", sorteoN:"5223", fecha:"26 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"7318",letras:"BCCC",serie:"10",folio:"4"},{pos:"2do",num:"8822"},{pos:"3er",num:"2552"}] },
  { tipo:"MIERCOLITO", sorteoN:"2732", fecha:"02 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"3462",letras:"DADA",serie:"16",folio:"15"},{pos:"2do",num:"8509"},{pos:"3er",num:"3767"}] },
  { tipo:"MIERCOLITO", sorteoN:"2733", fecha:"08 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"7909",letras:"CDBC",serie:"14",folio:"14"},{pos:"2do",num:"4349"},{pos:"3er",num:"0563"}] },
  { tipo:"MIERCOLITO", sorteoN:"2734", fecha:"15 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"6700",letras:"CBDA",serie:"10",folio:"2"},{pos:"2do",num:"7315"},{pos:"3er",num:"8868"}] },
  { tipo:"MIERCOLITO", sorteoN:"2735", fecha:"22 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"3149",letras:"ABBD",serie:"3",folio:"11"},{pos:"2do",num:"8067"},{pos:"3er",num:"8501"}] },
  { tipo:"MIERCOLITO", sorteoN:"2736", fecha:"29 Ene 2020", mes:1, anio:2020,
    premios:[{pos:"1er",num:"3084",letras:"CADA",serie:"21",folio:"9"},{pos:"2do",num:"8465"},{pos:"3er",num:"1723"}] },
  { tipo:"DOMINICAL", sorteoN:"5224", fecha:"02 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"9722",letras:"DDBD",serie:"6",folio:"14"},{pos:"2do",num:"3513"},{pos:"3er",num:"9021"}] },
  { tipo:"DOMINICAL", sorteoN:"5225", fecha:"09 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"6967",letras:"ADAC",serie:"15",folio:"4"},{pos:"2do",num:"8332"},{pos:"3er",num:"5352"}] },
  { tipo:"DOMINICAL", sorteoN:"5226", fecha:"16 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"7266",letras:"AACB",serie:"2",folio:"2"},{pos:"2do",num:"4272"},{pos:"3er",num:"0589"}] },
  { tipo:"DOMINICAL", sorteoN:"5227", fecha:"22 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"9331",letras:"DAAB",serie:"23",folio:"3"},{pos:"2do",num:"5533"},{pos:"3er",num:"0525"}] },
  { tipo:"MIERCOLITO", sorteoN:"2737", fecha:"05 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"7915",letras:"DDDA",serie:"2",folio:"5"},{pos:"2do",num:"1037"},{pos:"3er",num:"3068"}] },
  { tipo:"MIERCOLITO", sorteoN:"2738", fecha:"12 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"9118",letras:"DAAB",serie:"18",folio:"14"},{pos:"2do",num:"7100"},{pos:"3er",num:"0634"}] },
  { tipo:"MIERCOLITO", sorteoN:"2739", fecha:"19 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"5134",letras:"ABBC",serie:"13",folio:"13"},{pos:"2do",num:"6622"},{pos:"3er",num:"1284"}] },
  { tipo:"MIERCOLITO", sorteoN:"2740", fecha:"27 Feb 2020", mes:2, anio:2020,
    premios:[{pos:"1er",num:"0035",letras:"ADAD",serie:"9",folio:"3"},{pos:"2do",num:"6798"},{pos:"3er",num:"3639"}] },
  { tipo:"DOMINICAL", sorteoN:"5228", fecha:"01 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"7728",letras:"ABDB",serie:"6",folio:"12"},{pos:"2do",num:"0143"},{pos:"3er",num:"4002"}] },
  { tipo:"DOMINICAL", sorteoN:"5229", fecha:"08 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"0074",letras:"CBDD",serie:"10",folio:"13"},{pos:"2do",num:"9353"},{pos:"3er",num:"3126"}] },
  { tipo:"DOMINICAL", sorteoN:"5230", fecha:"15 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"2431",letras:"DBBA",serie:"15",folio:"2"},{pos:"2do",num:"8005"},{pos:"3er",num:"7137"}] },
  { tipo:"DOMINICAL", sorteoN:"5231", fecha:"22 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"1129",letras:"DABB",serie:"19",folio:"6"},{pos:"2do",num:"8303"},{pos:"3er",num:"3475"}] },
  { tipo:"DOMINICAL", sorteoN:"5232", fecha:"29 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"2875",letras:"DAAD",serie:"10",folio:"14"},{pos:"2do",num:"7928"},{pos:"3er",num:"9039"}] },
  { tipo:"MIERCOLITO", sorteoN:"2741", fecha:"04 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"4534",letras:"DACC",serie:"17",folio:"2"},{pos:"2do",num:"9357"},{pos:"3er",num:"6109"}] },
  { tipo:"MIERCOLITO", sorteoN:"2742", fecha:"11 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"8433",letras:"CDAC",serie:"18",folio:"7"},{pos:"2do",num:"0220"},{pos:"3er",num:"0664"}] },
  { tipo:"MIERCOLITO", sorteoN:"2743", fecha:"18 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"9206",letras:"DBDA",serie:"6",folio:"8"},{pos:"2do",num:"5423"},{pos:"3er",num:"5590"}] },
  { tipo:"MIERCOLITO", sorteoN:"2744", fecha:"25 Mar 2020", mes:3, anio:2020,
    premios:[{pos:"1er",num:"5564",letras:"AACD",serie:"19",folio:"15"},{pos:"2do",num:"5038"},{pos:"3er",num:"9421"}] },
  { tipo:"DOMINICAL", sorteoN:"5233", fecha:"05 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"8266",letras:"DCCA",serie:"22",folio:"4"},{pos:"2do",num:"3371"},{pos:"3er",num:"6408"}] },
  { tipo:"DOMINICAL", sorteoN:"5234", fecha:"12 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"8462",letras:"DCCD",serie:"13",folio:"15"},{pos:"2do",num:"6057"},{pos:"3er",num:"5299"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5235", fecha:"19 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"29579",letras:"DCCB",serie:"2",folio:"7"},{pos:"2do",num:"24297"},{pos:"3er",num:"91863"}] },
  { tipo:"DOMINICAL", sorteoN:"5236", fecha:"26 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"3252",letras:"BBCD",serie:"15",folio:"11"},{pos:"2do",num:"8741"},{pos:"3er",num:"6606"}] },
  { tipo:"MIERCOLITO", sorteoN:"2745", fecha:"01 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"2976",letras:"CBAA",serie:"5",folio:"7"},{pos:"2do",num:"4054"},{pos:"3er",num:"2036"}] },
  { tipo:"MIERCOLITO", sorteoN:"2746", fecha:"08 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"1297",letras:"ABBB",serie:"18",folio:"13"},{pos:"2do",num:"8635"},{pos:"3er",num:"2117"}] },
  { tipo:"MIERCOLITO", sorteoN:"2747", fecha:"15 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"2663",letras:"ABCA",serie:"2",folio:"10"},{pos:"2do",num:"1510"},{pos:"3er",num:"6306"}] },
  { tipo:"MIERCOLITO", sorteoN:"2748", fecha:"22 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"4195",letras:"BDDD",serie:"21",folio:"6"},{pos:"2do",num:"4479"},{pos:"3er",num:"2480"}] },
  { tipo:"MIERCOLITO", sorteoN:"2749", fecha:"29 Abr 2020", mes:4, anio:2020,
    premios:[{pos:"1er",num:"2385",letras:"CACB",serie:"7",folio:"10"},{pos:"2do",num:"6263"},{pos:"3er",num:"1021"}] },
  { tipo:"DOMINICAL", sorteoN:"5237", fecha:"03 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"0334",letras:"ABCA",serie:"14",folio:"8"},{pos:"2do",num:"7247"},{pos:"3er",num:"9378"}] },
  { tipo:"DOMINICAL", sorteoN:"5238", fecha:"10 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"2020",letras:"CCAC",serie:"24",folio:"11"},{pos:"2do",num:"0513"},{pos:"3er",num:"1483"}] },
  { tipo:"DOMINICAL", sorteoN:"5239", fecha:"17 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"2436",letras:"CDAB",serie:"3",folio:"14"},{pos:"2do",num:"3981"},{pos:"3er",num:"6555"}] },
  { tipo:"DOMINICAL", sorteoN:"5240", fecha:"24 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"0866",letras:"CCAC",serie:"11",folio:"10"},{pos:"2do",num:"7986"},{pos:"3er",num:"5987"}] },
  { tipo:"DOMINICAL", sorteoN:"5241", fecha:"31 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"8056",letras:"DDBB",serie:"14",folio:"4"},{pos:"2do",num:"7356"},{pos:"3er",num:"5163"}] },
  { tipo:"MIERCOLITO", sorteoN:"2750", fecha:"06 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"2783",letras:"AABB",serie:"16",folio:"9"},{pos:"2do",num:"2486"},{pos:"3er",num:"3197"}] },
  { tipo:"MIERCOLITO", sorteoN:"2751", fecha:"13 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"0795",letras:"ADCB",serie:"10",folio:"9"},{pos:"2do",num:"7096"},{pos:"3er",num:"1736"}] },
  { tipo:"MIERCOLITO", sorteoN:"2752", fecha:"20 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"9298",letras:"BBCB",serie:"22",folio:"12"},{pos:"2do",num:"5409"},{pos:"3er",num:"6289"}] },
  { tipo:"MIERCOLITO", sorteoN:"2753", fecha:"27 May 2020", mes:5, anio:2020,
    premios:[{pos:"1er",num:"7112",letras:"DBCD",serie:"12",folio:"5"},{pos:"2do",num:"3631"},{pos:"3er",num:"0547"}] },
  { tipo:"DOMINICAL", sorteoN:"5242", fecha:"07 Jun 2020", mes:6, anio:2020,
    premios:[{pos:"1er",num:"2682",letras:"DBBC",serie:"3",folio:"9"},{pos:"2do",num:"1567"},{pos:"3er",num:"7655"}] },
  { tipo:"DOMINICAL", sorteoN:"5243", fecha:"14 Jun 2020", mes:6, anio:2020,
    premios:[{pos:"1er",num:"9211",letras:"BBAB",serie:"1",folio:"8"},{pos:"2do",num:"7457"},{pos:"3er",num:"1835"}] },
  { tipo:"MIERCOLITO", sorteoN:"2754", fecha:"03 Jun 2020", mes:6, anio:2020,
    premios:[{pos:"1er",num:"2234",letras:"ACDB",serie:"3",folio:"8"},{pos:"2do",num:"2125"},{pos:"3er",num:"3419"}] },
  { tipo:"MIERCOLITO", sorteoN:"2755", fecha:"10 Jun 2020", mes:6, anio:2020,
    premios:[{pos:"1er",num:"5561",letras:"ACBD",serie:"14",folio:"3"},{pos:"2do",num:"4572"},{pos:"3er",num:"3305"}] },
  { tipo:"MIERCOLITO", sorteoN:"2756", fecha:"17 Jun 2020", mes:6, anio:2020,
    premios:[{pos:"1er",num:"1998",letras:"CDBD",serie:"14",folio:"4"},{pos:"2do",num:"2785"},{pos:"3er",num:"2950"}] },
  // ══════ 2019 ══════ — Datos verificados desde balotas.com (j2019.php)
  { tipo:"DOMINICAL", sorteoN:"5168", fecha:"06 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"5199",letras:"CDAD",serie:"16",folio:"2"},{pos:"2do",num:"4859"},{pos:"3er",num:"8892"}] },
  { tipo:"DOMINICAL", sorteoN:"5169", fecha:"13 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"1081",letras:"DCDD",serie:"20",folio:"2"},{pos:"2do",num:"3599"},{pos:"3er",num:"7225"}] },
  { tipo:"DOMINICAL", sorteoN:"5170", fecha:"20 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"9744",letras:"BADC",serie:"11",folio:"10"},{pos:"2do",num:"7103"},{pos:"3er",num:"0612"}] },
  { tipo:"DOMINICAL", sorteoN:"5171", fecha:"26 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"9986",letras:"DDAD",serie:"20",folio:"11"},{pos:"2do",num:"2957"},{pos:"3er",num:"1659"}] },
  { tipo:"MIERCOLITO", sorteoN:"2680", fecha:"03 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"4379",letras:"ABBA",serie:"18",folio:"3"},{pos:"2do",num:"7777"},{pos:"3er",num:"9401"}] },
  { tipo:"MIERCOLITO", sorteoN:"2681", fecha:"10 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"8555",letras:"CBCC",serie:"13",folio:"14"},{pos:"2do",num:"2279"},{pos:"3er",num:"2710"}] },
  { tipo:"MIERCOLITO", sorteoN:"2682", fecha:"16 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"7207",letras:"CBAC",serie:"12",folio:"1"},{pos:"2do",num:"5622"},{pos:"3er",num:"9964"}] },
  { tipo:"MIERCOLITO", sorteoN:"2683", fecha:"23 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"6048",letras:"DDCD",serie:"9",folio:"5"},{pos:"2do",num:"6727"},{pos:"3er",num:"3427"}] },
  { tipo:"MIERCOLITO", sorteoN:"2684", fecha:"30 Ene 2019", mes:1, anio:2019,
    premios:[{pos:"1er",num:"1662",letras:"DCAD",serie:"6",folio:"8"},{pos:"2do",num:"1361"},{pos:"3er",num:"1211"}] },
  { tipo:"DOMINICAL", sorteoN:"5172", fecha:"03 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"8079",letras:"BDAB",serie:"10",folio:"11"},{pos:"2do",num:"8484"},{pos:"3er",num:"7154"}] },
  { tipo:"DOMINICAL", sorteoN:"5173", fecha:"10 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"3640",letras:"CAAA",serie:"12",folio:"9"},{pos:"2do",num:"1036"},{pos:"3er",num:"1783"}] },
  { tipo:"DOMINICAL", sorteoN:"5174", fecha:"17 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"7084",letras:"DACC",serie:"3",folio:"11"},{pos:"2do",num:"8098"},{pos:"3er",num:"4935"}] },
  { tipo:"DOMINICAL", sorteoN:"5175", fecha:"24 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"9826",letras:"CDDA",serie:"19",folio:"1"},{pos:"2do",num:"2538"},{pos:"3er",num:"8236"}] },
  { tipo:"MIERCOLITO", sorteoN:"2685", fecha:"06 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"6054",letras:"BABC",serie:"15",folio:"10"},{pos:"2do",num:"4598"},{pos:"3er",num:"5821"}] },
  { tipo:"MIERCOLITO", sorteoN:"2686", fecha:"13 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"4488",letras:"BCDC",serie:"1",folio:"13"},{pos:"2do",num:"7293"},{pos:"3er",num:"8530"}] },
  { tipo:"MIERCOLITO", sorteoN:"2687", fecha:"20 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"1730",letras:"CAAC",serie:"7",folio:"10"},{pos:"2do",num:"1671"},{pos:"3er",num:"1095"}] },
  { tipo:"MIERCOLITO", sorteoN:"2688", fecha:"27 Feb 2019", mes:2, anio:2019,
    premios:[{pos:"1er",num:"1670",letras:"CCAC",serie:"2",folio:"1"},{pos:"2do",num:"3149"},{pos:"3er",num:"4525"}] },
  { tipo:"DOMINICAL", sorteoN:"5176", fecha:"02 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"4265",letras:"DCBD",serie:"9",folio:"11"},{pos:"2do",num:"2437"},{pos:"3er",num:"0832"}] },
  { tipo:"DOMINICAL", sorteoN:"5177", fecha:"10 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"1514",letras:"BBDA",serie:"4",folio:"5"},{pos:"2do",num:"5435"},{pos:"3er",num:"9668"}] },
  { tipo:"DOMINICAL", sorteoN:"5178", fecha:"17 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"0630",letras:"ADDA",serie:"25",folio:"13"},{pos:"2do",num:"0550"},{pos:"3er",num:"7624"}] },
  { tipo:"DOMINICAL", sorteoN:"5179", fecha:"24 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"2054",letras:"DCAB",serie:"12",folio:"15"},{pos:"2do",num:"0409"},{pos:"3er",num:"9112"}] },
  { tipo:"DOMINICAL", sorteoN:"5180", fecha:"31 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"7717",letras:"BBDB",serie:"11",folio:"11"},{pos:"2do",num:"6770"},{pos:"3er",num:"3855"}] },
  { tipo:"MIERCOLITO", sorteoN:"2689", fecha:"07 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"7705",letras:"CCDA",serie:"3",folio:"3"},{pos:"2do",num:"8009"},{pos:"3er",num:"0425"}] },
  { tipo:"MIERCOLITO", sorteoN:"2690", fecha:"13 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"3277",letras:"DDAB",serie:"7",folio:"6"},{pos:"2do",num:"1228"},{pos:"3er",num:"7142"}] },
  { tipo:"MIERCOLITO", sorteoN:"2691", fecha:"20 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"3270",letras:"ADAB",serie:"6",folio:"2"},{pos:"2do",num:"6003"},{pos:"3er",num:"6206"}] },
  { tipo:"MIERCOLITO", sorteoN:"2692", fecha:"27 Mar 2019", mes:3, anio:2019,
    premios:[{pos:"1er",num:"4187",letras:"ABAC",serie:"1",folio:"3"},{pos:"2do",num:"6645"},{pos:"3er",num:"4774"}] },
  { tipo:"DOMINICAL", sorteoN:"5181", fecha:"07 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"0879",letras:"BADD",serie:"11",folio:"15"},{pos:"2do",num:"5379"},{pos:"3er",num:"6169"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5182", fecha:"14 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"15426",letras:"CDDB",serie:"3",folio:"7"},{pos:"2do",num:"77448"},{pos:"3er",num:"24726"}] },
  { tipo:"DOMINICAL", sorteoN:"5183", fecha:"22 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"2509",letras:"DCCB",serie:"4",folio:"7"},{pos:"2do",num:"1518"},{pos:"3er",num:"0711"}] },
  { tipo:"DOMINICAL", sorteoN:"5184", fecha:"28 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"8823",letras:"AABD",serie:"1",folio:"9"},{pos:"2do",num:"9611"},{pos:"3er",num:"8788"}] },
  { tipo:"MIERCOLITO", sorteoN:"2693", fecha:"03 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"4961",letras:"BAAA",serie:"21",folio:"4"},{pos:"2do",num:"4566"},{pos:"3er",num:"5588"}] },
  { tipo:"MIERCOLITO", sorteoN:"2694", fecha:"10 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"0994",letras:"DDCC",serie:"10",folio:"5"},{pos:"2do",num:"5328"},{pos:"3er",num:"4729"}] },
  { tipo:"MIERCOLITO", sorteoN:"2695", fecha:"17 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"1867",letras:"DCCC",serie:"8",folio:"6"},{pos:"2do",num:"2342"},{pos:"3er",num:"1279"}] },
  { tipo:"MIERCOLITO", sorteoN:"2696", fecha:"25 Abr 2019", mes:4, anio:2019,
    premios:[{pos:"1er",num:"3961",letras:"CBCC",serie:"21",folio:"11"},{pos:"2do",num:"0036"},{pos:"3er",num:"4853"}] },
  { tipo:"DOMINICAL", sorteoN:"5185", fecha:"06 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"6714",letras:"CBDD",serie:"14",folio:"6"},{pos:"2do",num:"9916"},{pos:"3er",num:"7040"}] },
  { tipo:"DOMINICAL", sorteoN:"5186", fecha:"12 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"3664",letras:"CADB",serie:"2",folio:"3"},{pos:"2do",num:"0915"},{pos:"3er",num:"0274"}] },
  { tipo:"DOMINICAL", sorteoN:"5187", fecha:"19 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"0874",letras:"ADCA",serie:"6",folio:"15"},{pos:"2do",num:"3604"},{pos:"3er",num:"9131"}] },
  { tipo:"DOMINICAL", sorteoN:"5188", fecha:"26 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"8664",letras:"CDDC",serie:"16",folio:"5"},{pos:"2do",num:"3858"},{pos:"3er",num:"9142"}] },
  { tipo:"MIERCOLITO", sorteoN:"2697", fecha:"01 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"1405",letras:"DDBD",serie:"8",folio:"12"},{pos:"2do",num:"0543"},{pos:"3er",num:"8114"}] },
  { tipo:"MIERCOLITO", sorteoN:"2698", fecha:"09 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"4358",letras:"DACD",serie:"1",folio:"7"},{pos:"2do",num:"2118"},{pos:"3er",num:"8852"}] },
  { tipo:"MIERCOLITO", sorteoN:"2699", fecha:"15 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"5191",letras:"ABCD",serie:"15",folio:"7"},{pos:"2do",num:"8013"},{pos:"3er",num:"5288"}] },
  { tipo:"MIERCOLITO", sorteoN:"2700", fecha:"22 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"0600",letras:"ACBC",serie:"17",folio:"10"},{pos:"2do",num:"4684"},{pos:"3er",num:"8600"}] },
  { tipo:"MIERCOLITO", sorteoN:"2701", fecha:"29 May 2019", mes:5, anio:2019,
    premios:[{pos:"1er",num:"8598",letras:"DABB",serie:"11",folio:"11"},{pos:"2do",num:"7945"},{pos:"3er",num:"1521"}] },
  { tipo:"DOMINICAL", sorteoN:"5189", fecha:"02 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"3942",letras:"DAAD",serie:"15",folio:"15"},{pos:"2do",num:"0529"},{pos:"3er",num:"0351"}] },
  { tipo:"DOMINICAL", sorteoN:"5190", fecha:"09 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"7747",letras:"DDCA",serie:"14",folio:"2"},{pos:"2do",num:"6021"},{pos:"3er",num:"2242"}] },
  { tipo:"DOMINICAL", sorteoN:"5191", fecha:"16 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"0952",letras:"ABDB",serie:"10",folio:"3"},{pos:"2do",num:"4074"},{pos:"3er",num:"8252"}] },
  { tipo:"DOMINICAL", sorteoN:"5192", fecha:"23 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"4615",letras:"CDDD",serie:"7",folio:"9"},{pos:"2do",num:"6703"},{pos:"3er",num:"6807"}] },
  { tipo:"DOMINICAL", sorteoN:"5193", fecha:"30 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"7145",letras:"CCDB",serie:"2",folio:"2"},{pos:"2do",num:"0432"},{pos:"3er",num:"5990"}] },
  { tipo:"MIERCOLITO", sorteoN:"2702", fecha:"05 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"5973",letras:"DAAD",serie:"13",folio:"6"},{pos:"2do",num:"0735"},{pos:"3er",num:"5167"}] },
  { tipo:"MIERCOLITO", sorteoN:"2703", fecha:"12 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"4541",letras:"AAAA",serie:"20",folio:"12"},{pos:"2do",num:"5904"},{pos:"3er",num:"1113"}] },
  { tipo:"MIERCOLITO", sorteoN:"2704", fecha:"19 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"9051",letras:"BADD",serie:"13",folio:"13"},{pos:"2do",num:"1257"},{pos:"3er",num:"6403"}] },
  { tipo:"MIERCOLITO", sorteoN:"2705", fecha:"26 Jun 2019", mes:6, anio:2019,
    premios:[{pos:"1er",num:"8109",letras:"BBDA",serie:"17",folio:"8"},{pos:"2do",num:"8735"},{pos:"3er",num:"5446"}] },
  { tipo:"DOMINICAL", sorteoN:"5194", fecha:"07 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"0611",letras:"DBDC",serie:"2",folio:"6"},{pos:"2do",num:"6218"},{pos:"3er",num:"1008"}] },
  { tipo:"DOMINICAL", sorteoN:"5195", fecha:"14 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"6311",letras:"CBDD",serie:"18",folio:"7"},{pos:"2do",num:"3561"},{pos:"3er",num:"2291"}] },
  { tipo:"DOMINICAL", sorteoN:"5196", fecha:"21 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"0768",letras:"ACCB",serie:"10",folio:"13"},{pos:"2do",num:"6752"},{pos:"3er",num:"8565"}] },
  { tipo:"DOMINICAL", sorteoN:"5197", fecha:"28 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"8896",letras:"BCCC",serie:"15",folio:"11"},{pos:"2do",num:"9944"},{pos:"3er",num:"0066"}] },
  { tipo:"MIERCOLITO", sorteoN:"2706", fecha:"03 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"0433",letras:"DCAB",serie:"1",folio:"4"},{pos:"2do",num:"8194"},{pos:"3er",num:"1041"}] },
  { tipo:"MIERCOLITO", sorteoN:"2707", fecha:"10 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"3640",letras:"BCBB",serie:"8",folio:"2"},{pos:"2do",num:"8424"},{pos:"3er",num:"6719"}] },
  { tipo:"MIERCOLITO", sorteoN:"2708", fecha:"17 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"2149",letras:"CADA",serie:"12",folio:"9"},{pos:"2do",num:"6279"},{pos:"3er",num:"6451"}] },
  { tipo:"MIERCOLITO", sorteoN:"2709", fecha:"24 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"9878",letras:"BBCA",serie:"19",folio:"10"},{pos:"2do",num:"3801"},{pos:"3er",num:"3239"}] },
  { tipo:"MIERCOLITO", sorteoN:"2710", fecha:"31 Jul 2019", mes:7, anio:2019,
    premios:[{pos:"1er",num:"3827",letras:"DAAB",serie:"8",folio:"15"},{pos:"2do",num:"5496"},{pos:"3er",num:"2342"}] },
  { tipo:"DOMINICAL", sorteoN:"5198", fecha:"04 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"4316",letras:"ACAD",serie:"8",folio:"4"},{pos:"2do",num:"3927"},{pos:"3er",num:"2156"}] },
  { tipo:"DOMINICAL", sorteoN:"5199", fecha:"11 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"2649",letras:"BABD",serie:"15",folio:"14"},{pos:"2do",num:"9289"},{pos:"3er",num:"8715"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5200", fecha:"18 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"05309",letras:"BCCC",serie:"3",folio:"6"},{pos:"2do",num:"98327"},{pos:"3er",num:"61748"}] },
  { tipo:"DOMINICAL", sorteoN:"5201", fecha:"25 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"0129",letras:"BCCD",serie:"24",folio:"11"},{pos:"2do",num:"3157"},{pos:"3er",num:"7165"}] },
  { tipo:"MIERCOLITO", sorteoN:"2711", fecha:"07 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"6543",letras:"ADBB",serie:"14",folio:"9"},{pos:"2do",num:"6619"},{pos:"3er",num:"9208"}] },
  { tipo:"MIERCOLITO", sorteoN:"2712", fecha:"14 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"4334",letras:"ADDC",serie:"12",folio:"6"},{pos:"2do",num:"2620"},{pos:"3er",num:"9183"}] },
  { tipo:"MIERCOLITO", sorteoN:"2713", fecha:"21 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"7708",letras:"ABDB",serie:"1",folio:"11"},{pos:"2do",num:"9210"},{pos:"3er",num:"6640"}] },
  { tipo:"MIERCOLITO", sorteoN:"2714", fecha:"28 Ago 2019", mes:8, anio:2019,
    premios:[{pos:"1er",num:"6003",letras:"DCCD",serie:"7",folio:"7"},{pos:"2do",num:"4463"},{pos:"3er",num:"8946"}] },
  { tipo:"DOMINICAL", sorteoN:"5202", fecha:"01 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"9209",letras:"DCBC",serie:"10",folio:"14"},{pos:"2do",num:"0306"},{pos:"3er",num:"1669"}] },
  { tipo:"DOMINICAL", sorteoN:"5203", fecha:"08 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"7042",letras:"DBDD",serie:"25",folio:"10"},{pos:"2do",num:"7358"},{pos:"3er",num:"5641"}] },
  { tipo:"DOMINICAL", sorteoN:"5204", fecha:"15 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"0039",letras:"ACCA",serie:"22",folio:"3"},{pos:"2do",num:"9760"},{pos:"3er",num:"8200"}] },
  { tipo:"DOMINICAL", sorteoN:"5205", fecha:"22 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"9284",letras:"BADD",serie:"3",folio:"14"},{pos:"2do",num:"2952"},{pos:"3er",num:"8947"}] },
  { tipo:"DOMINICAL", sorteoN:"5206", fecha:"29 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"6477",letras:"BACA",serie:"1",folio:"7"},{pos:"2do",num:"0697"},{pos:"3er",num:"9177"}] },
  { tipo:"MIERCOLITO", sorteoN:"2715", fecha:"04 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"3147",letras:"ADBD",serie:"5",folio:"12"},{pos:"2do",num:"0011"},{pos:"3er",num:"6325"}] },
  { tipo:"MIERCOLITO", sorteoN:"2716", fecha:"11 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"8028",letras:"AADD",serie:"3",folio:"8"},{pos:"2do",num:"2231"},{pos:"3er",num:"2924"}] },
  { tipo:"MIERCOLITO", sorteoN:"2717", fecha:"18 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"1339",letras:"DCCA",serie:"21",folio:"3"},{pos:"2do",num:"9886"},{pos:"3er",num:"1627"}] },
  { tipo:"MIERCOLITO", sorteoN:"2718", fecha:"25 Sep 2019", mes:9, anio:2019,
    premios:[{pos:"1er",num:"1663",letras:"AACC",serie:"21",folio:"10"},{pos:"2do",num:"3333"},{pos:"3er",num:"7492"}] },
  { tipo:"DOMINICAL", sorteoN:"5207", fecha:"06 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"1418",letras:"DACA",serie:"23",folio:"2"},{pos:"2do",num:"8832"},{pos:"3er",num:"9346"}] },
  { tipo:"DOMINICAL", sorteoN:"5208", fecha:"13 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"1725",letras:"DDBC",serie:"6",folio:"3"},{pos:"2do",num:"5472"},{pos:"3er",num:"4486"}] },
  { tipo:"DOMINICAL", sorteoN:"5209", fecha:"20 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"8470",letras:"CDDA",serie:"10",folio:"12"},{pos:"2do",num:"7993"},{pos:"3er",num:"2019"}] },
  { tipo:"DOMINICAL", sorteoN:"5210", fecha:"27 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"5685",letras:"BADB",serie:"20",folio:"1"},{pos:"2do",num:"5034"},{pos:"3er",num:"3519"}] },
  { tipo:"MIERCOLITO", sorteoN:"2719", fecha:"02 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"3354",letras:"DCCD",serie:"17",folio:"9"},{pos:"2do",num:"8538"},{pos:"3er",num:"2080"}] },
  { tipo:"MIERCOLITO", sorteoN:"2720", fecha:"09 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"5254",letras:"DBAA",serie:"10",folio:"8"},{pos:"2do",num:"5695"},{pos:"3er",num:"0252"}] },
  { tipo:"MIERCOLITO", sorteoN:"2721", fecha:"16 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"0448",letras:"ACCA",serie:"14",folio:"10"},{pos:"2do",num:"2619"},{pos:"3er",num:"8838"}] },
  { tipo:"MIERCOLITO", sorteoN:"2722", fecha:"23 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"4868",letras:"ABBC",serie:"1",folio:"11"},{pos:"2do",num:"4281"},{pos:"3er",num:"2040"}] },
  { tipo:"MIERCOLITO", sorteoN:"2723", fecha:"30 Oct 2019", mes:10, anio:2019,
    premios:[{pos:"1er",num:"0025",letras:"BCDD",serie:"20",folio:"11"},{pos:"2do",num:"0232"},{pos:"3er",num:"0117"}] },
  { tipo:"DOMINICAL", sorteoN:"5211", fecha:"02 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"8138",letras:"ABCB",serie:"7",folio:"11"},{pos:"2do",num:"2025"},{pos:"3er",num:"3488"}] },
  { tipo:"DOMINICAL", sorteoN:"5212", fecha:"11 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"2239",letras:"CBCC",serie:"19",folio:"9"},{pos:"2do",num:"8910"},{pos:"3er",num:"2616"}] },
  { tipo:"DOMINICAL", sorteoN:"5213", fecha:"17 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"2059",letras:"BADD",serie:"16",folio:"15"},{pos:"2do",num:"4777"},{pos:"3er",num:"4109"}] },
  { tipo:"DOMINICAL", sorteoN:"5214", fecha:"24 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"9703",letras:"CDBA",serie:"23",folio:"6"},{pos:"2do",num:"1773"},{pos:"3er",num:"8842"}] },
  { tipo:"MIERCOLITO", sorteoN:"2724", fecha:"07 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"2955",letras:"DCAB",serie:"12",folio:"15"},{pos:"2do",num:"8187"},{pos:"3er",num:"9356"}] },
  { tipo:"MIERCOLITO", sorteoN:"2725", fecha:"14 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"5308",letras:"ACAC",serie:"6",folio:"2"},{pos:"2do",num:"8815"},{pos:"3er",num:"6792"}] },
  { tipo:"MIERCOLITO", sorteoN:"2726", fecha:"20 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"4189",letras:"DDDB",serie:"8",folio:"7"},{pos:"2do",num:"8025"},{pos:"3er",num:"4855"}] },
  { tipo:"MIERCOLITO", sorteoN:"2727", fecha:"27 Nov 2019", mes:11, anio:2019,
    premios:[{pos:"1er",num:"6744",letras:"ADCC",serie:"9",folio:"2"},{pos:"2do",num:"1148"},{pos:"3er",num:"7258"}] },
  { tipo:"DOMINICAL", sorteoN:"5215", fecha:"01 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"3370",letras:"DDBD",serie:"3",folio:"9"},{pos:"2do",num:"2358"},{pos:"3er",num:"1116"}] },
  { tipo:"DOMINICAL", sorteoN:"5216", fecha:"07 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"9858",letras:"CACA",serie:"22",folio:"5"},{pos:"2do",num:"3435"},{pos:"3er",num:"4673"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5217", fecha:"15 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"41435",letras:"BBAA",serie:"2",folio:"12"},{pos:"2do",num:"20035"},{pos:"3er",num:"49304"}] },
  { tipo:"DOMINICAL", sorteoN:"5218", fecha:"22 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"4397",letras:"BBAA",serie:"14",folio:"12"},{pos:"2do",num:"3798"},{pos:"3er",num:"4577"}] },
  { tipo:"DOMINICAL", sorteoN:"5219", fecha:"29 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"0635",letras:"BBCA",serie:"10",folio:"2"},{pos:"2do",num:"6894"},{pos:"3er",num:"4229"}] },
  { tipo:"MIERCOLITO", sorteoN:"2728", fecha:"04 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"8925",letras:"ACBC",serie:"1",folio:"1"},{pos:"2do",num:"2766"},{pos:"3er",num:"7246"}] },
  { tipo:"MIERCOLITO", sorteoN:"2729", fecha:"11 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"1457",letras:"CCDC",serie:"21",folio:"5"},{pos:"2do",num:"4253"},{pos:"3er",num:"7920"}] },
  { tipo:"MIERCOLITO", sorteoN:"2730", fecha:"18 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"3469",letras:"ADCC",serie:"5",folio:"2"},{pos:"2do",num:"7378"},{pos:"3er",num:"5221"}] },
  { tipo:"MIERCOLITO", sorteoN:"2731", fecha:"26 Dic 2019", mes:12, anio:2019,
    premios:[{pos:"1er",num:"5755",letras:"AACB",serie:"20",folio:"7"},{pos:"2do",num:"9932"},{pos:"3er",num:"6638"}] },
  // ══════ 2018 ══════ — Datos verificados desde balotas.com (j2018.php)
  { tipo:"DOMINICAL", sorteoN:"5116", fecha:"07 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"8045",letras:"BBAC",serie:"13",folio:"10"},{pos:"2do",num:"1978"},{pos:"3er",num:"0138"}] },
  { tipo:"DOMINICAL", sorteoN:"5117", fecha:"14 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"6200",letras:"DCAA",serie:"24",folio:"5"},{pos:"2do",num:"7120"},{pos:"3er",num:"7696"}] },
  { tipo:"DOMINICAL", sorteoN:"5118", fecha:"21 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"2118",letras:"AADA",serie:"21",folio:"9"},{pos:"2do",num:"0484"},{pos:"3er",num:"7571"}] },
  { tipo:"DOMINICAL", sorteoN:"5119", fecha:"28 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"6315",letras:"CABC",serie:"24",folio:"8"},{pos:"2do",num:"7677"},{pos:"3er",num:"9476"}] },
  { tipo:"MIERCOLITO", sorteoN:"2628", fecha:"03 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"4855",letras:"DBCC",serie:"7",folio:"11"},{pos:"2do",num:"6924"},{pos:"3er",num:"0714"}] },
  { tipo:"MIERCOLITO", sorteoN:"2629", fecha:"10 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"4249",letras:"BCAB",serie:"7",folio:"9"},{pos:"2do",num:"9953"},{pos:"3er",num:"5640"}] },
  { tipo:"MIERCOLITO", sorteoN:"2630", fecha:"17 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"8401",letras:"BBCA",serie:"4",folio:"9"},{pos:"2do",num:"7600"},{pos:"3er",num:"4478"}] },
  { tipo:"MIERCOLITO", sorteoN:"2631", fecha:"24 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"9745",letras:"BCAA",serie:"19",folio:"8"},{pos:"2do",num:"4163"},{pos:"3er",num:"9245"}] },
  { tipo:"MIERCOLITO", sorteoN:"2632", fecha:"31 Ene 2018", mes:1, anio:2018,
    premios:[{pos:"1er",num:"8003",letras:"CDCD",serie:"5",folio:"14"},{pos:"2do",num:"3050"},{pos:"3er",num:"6785"}] },
  { tipo:"DOMINICAL", sorteoN:"5120", fecha:"04 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"3198",letras:"BDAB",serie:"13",folio:"2"},{pos:"2do",num:"7720"},{pos:"3er",num:"8778"}] },
  { tipo:"DOMINICAL", sorteoN:"5121", fecha:"10 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"0401",letras:"ABDA",serie:"8",folio:"2"},{pos:"2do",num:"8834"},{pos:"3er",num:"0327"}] },
  { tipo:"DOMINICAL", sorteoN:"5122", fecha:"18 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"4011",letras:"BDCD",serie:"24",folio:"12"},{pos:"2do",num:"3804"},{pos:"3er",num:"4986"}] },
  { tipo:"DOMINICAL", sorteoN:"5123", fecha:"25 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"9646",letras:"DADB",serie:"6",folio:"4"},{pos:"2do",num:"2806"},{pos:"3er",num:"0073"}] },
  { tipo:"MIERCOLITO", sorteoN:"2633", fecha:"07 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"3030",letras:"ABDB",serie:"5",folio:"6"},{pos:"2do",num:"4674"},{pos:"3er",num:"5783"}] },
  { tipo:"MIERCOLITO", sorteoN:"2634", fecha:"15 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"0192",letras:"CBCA",serie:"3",folio:"15"},{pos:"2do",num:"5652"},{pos:"3er",num:"9641"}] },
  { tipo:"MIERCOLITO", sorteoN:"2635", fecha:"21 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"8212",letras:"DDDA",serie:"5",folio:"1"},{pos:"2do",num:"6402"},{pos:"3er",num:"0459"}] },
  { tipo:"MIERCOLITO", sorteoN:"2636", fecha:"28 Feb 2018", mes:2, anio:2018,
    premios:[{pos:"1er",num:"6766",letras:"AABC",serie:"18",folio:"5"},{pos:"2do",num:"0379"},{pos:"3er",num:"3392"}] },
  { tipo:"DOMINICAL", sorteoN:"5124", fecha:"04 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"1514",letras:"ADDB",serie:"19",folio:"4"},{pos:"2do",num:"8823"},{pos:"3er",num:"5211"}] },
  { tipo:"DOMINICAL", sorteoN:"5125", fecha:"11 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"0120",letras:"ABAC",serie:"12",folio:"1"},{pos:"2do",num:"1409"},{pos:"3er",num:"0052"}] },
  { tipo:"DOMINICAL", sorteoN:"5126", fecha:"18 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"9701",letras:"CCAA",serie:"11",folio:"5"},{pos:"2do",num:"9518"},{pos:"3er",num:"8308"}] },
  { tipo:"DOMINICAL", sorteoN:"5127", fecha:"25 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"9522",letras:"BBDC",serie:"11",folio:"11"},{pos:"2do",num:"7316"},{pos:"3er",num:"4182"}] },
  { tipo:"MIERCOLITO", sorteoN:"2637", fecha:"07 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"8312",letras:"BCBA",serie:"5",folio:"10"},{pos:"2do",num:"3582"},{pos:"3er",num:"5297"}] },
  { tipo:"MIERCOLITO", sorteoN:"2638", fecha:"14 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"7200",letras:"ABCA",serie:"13",folio:"4"},{pos:"2do",num:"4092"},{pos:"3er",num:"2845"}] },
  { tipo:"MIERCOLITO", sorteoN:"2639", fecha:"21 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"8166",letras:"BBAB",serie:"14",folio:"10"},{pos:"2do",num:"1409"},{pos:"3er",num:"9373"}] },
  { tipo:"MIERCOLITO", sorteoN:"2640", fecha:"28 Mar 2018", mes:3, anio:2018,
    premios:[{pos:"1er",num:"1250",letras:"ACDA",serie:"13",folio:"14"},{pos:"2do",num:"9372"},{pos:"3er",num:"1156"}] },
  { tipo:"DOMINICAL", sorteoN:"5128", fecha:"02 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"6960",letras:"DACC",serie:"13",folio:"1"},{pos:"2do",num:"0591"},{pos:"3er",num:"1038"}] },
  { tipo:"DOMINICAL", sorteoN:"5129", fecha:"08 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"1575",letras:"CDAA",serie:"6",folio:"1"},{pos:"2do",num:"9954"},{pos:"3er",num:"3630"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5130", fecha:"15 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"36045",letras:"AABA",serie:"2",folio:"8"},{pos:"2do",num:"12438"},{pos:"3er",num:"94729"}] },
  { tipo:"DOMINICAL", sorteoN:"5131", fecha:"22 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"9277",letras:"CBCB",serie:"21",folio:"7"},{pos:"2do",num:"6804"},{pos:"3er",num:"2770"}] },
  { tipo:"DOMINICAL", sorteoN:"5132", fecha:"29 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"2986",letras:"BCCD",serie:"18",folio:"1"},{pos:"2do",num:"4181"},{pos:"3er",num:"3963"}] },
  { tipo:"MIERCOLITO", sorteoN:"2641", fecha:"05 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"7613",letras:"DCAC",serie:"1",folio:"10"},{pos:"2do",num:"9744"},{pos:"3er",num:"0211"}] },
  { tipo:"MIERCOLITO", sorteoN:"2642", fecha:"11 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"1834",letras:"BDBC",serie:"20",folio:"9"},{pos:"2do",num:"5667"},{pos:"3er",num:"4637"}] },
  { tipo:"MIERCOLITO", sorteoN:"2643", fecha:"18 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"5471",letras:"DCAB",serie:"14",folio:"9"},{pos:"2do",num:"1282"},{pos:"3er",num:"2921"}] },
  { tipo:"MIERCOLITO", sorteoN:"2644", fecha:"25 Abr 2018", mes:4, anio:2018,
    premios:[{pos:"1er",num:"6828",letras:"DDAC",serie:"20",folio:"11"},{pos:"2do",num:"2933"},{pos:"3er",num:"5475"}] },
  { tipo:"DOMINICAL", sorteoN:"5133", fecha:"06 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"0311",letras:"ADDA",serie:"8",folio:"5"},{pos:"2do",num:"0783"},{pos:"3er",num:"6840"}] },
  { tipo:"DOMINICAL", sorteoN:"5134", fecha:"13 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"0151",letras:"DDCB",serie:"13",folio:"2"},{pos:"2do",num:"7983"},{pos:"3er",num:"9348"}] },
  { tipo:"DOMINICAL", sorteoN:"5135", fecha:"20 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"9429",letras:"CDCB",serie:"2",folio:"2"},{pos:"2do",num:"7375"},{pos:"3er",num:"1631"}] },
  { tipo:"DOMINICAL", sorteoN:"5136", fecha:"27 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"5796",letras:"ABBA",serie:"13",folio:"15"},{pos:"2do",num:"5336"},{pos:"3er",num:"9425"}] },
  { tipo:"MIERCOLITO", sorteoN:"2645", fecha:"02 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"5742",letras:"CBBD",serie:"1",folio:"6"},{pos:"2do",num:"2007"},{pos:"3er",num:"3381"}] },
  { tipo:"MIERCOLITO", sorteoN:"2646", fecha:"09 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"3327",letras:"CDAB",serie:"12",folio:"5"},{pos:"2do",num:"6431"},{pos:"3er",num:"3493"}] },
  { tipo:"MIERCOLITO", sorteoN:"2647", fecha:"16 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"7907",letras:"BAAB",serie:"4",folio:"8"},{pos:"2do",num:"4789"},{pos:"3er",num:"0163"}] },
  { tipo:"MIERCOLITO", sorteoN:"2648", fecha:"23 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"8590",letras:"CBAA",serie:"16",folio:"1"},{pos:"2do",num:"4943"},{pos:"3er",num:"6729"}] },
  { tipo:"MIERCOLITO", sorteoN:"2649", fecha:"30 May 2018", mes:5, anio:2018,
    premios:[{pos:"1er",num:"2987",letras:"ACCD",serie:"18",folio:"4"},{pos:"2do",num:"6947"},{pos:"3er",num:"9758"}] },
  { tipo:"DOMINICAL", sorteoN:"5137", fecha:"03 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"6456",letras:"DCBC",serie:"20",folio:"7"},{pos:"2do",num:"2475"},{pos:"3er",num:"4592"}] },
  { tipo:"DOMINICAL", sorteoN:"5138", fecha:"10 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"6794",letras:"ABAB",serie:"17",folio:"14"},{pos:"2do",num:"0850"},{pos:"3er",num:"2117"}] },
  { tipo:"DOMINICAL", sorteoN:"5139", fecha:"17 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"7478",letras:"CBAB",serie:"15",folio:"9"},{pos:"2do",num:"7722"},{pos:"3er",num:"6637"}] },
  { tipo:"DOMINICAL", sorteoN:"5140", fecha:"23 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"6242",letras:"ABBB",serie:"24",folio:"15"},{pos:"2do",num:"6276"},{pos:"3er",num:"1050"}] },
  { tipo:"MIERCOLITO", sorteoN:"2650", fecha:"06 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"9403",letras:"DDAD",serie:"19",folio:"12"},{pos:"2do",num:"4851"},{pos:"3er",num:"4064"}] },
  { tipo:"MIERCOLITO", sorteoN:"2651", fecha:"13 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"9895",letras:"DBBC",serie:"1",folio:"7"},{pos:"2do",num:"6289"},{pos:"3er",num:"7281"}] },
  { tipo:"MIERCOLITO", sorteoN:"2652", fecha:"20 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"7019",letras:"DDCB",serie:"3",folio:"8"},{pos:"2do",num:"2206"},{pos:"3er",num:"7503"}] },
  { tipo:"MIERCOLITO", sorteoN:"2653", fecha:"27 Jun 2018", mes:6, anio:2018,
    premios:[{pos:"1er",num:"3693",letras:"CDCA",serie:"8",folio:"14"},{pos:"2do",num:"3186"},{pos:"3er",num:"5882"}] },
  { tipo:"DOMINICAL", sorteoN:"5141", fecha:"01 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"8373",letras:"BADD",serie:"16",folio:"1"},{pos:"2do",num:"9387"},{pos:"3er",num:"1216"}] },
  { tipo:"DOMINICAL", sorteoN:"5142", fecha:"08 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"5380",letras:"DCBB",serie:"10",folio:"12"},{pos:"2do",num:"4487"},{pos:"3er",num:"2630"}] },
  { tipo:"DOMINICAL", sorteoN:"5143", fecha:"15 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"9783",letras:"CAAD",serie:"12",folio:"15"},{pos:"2do",num:"2697"},{pos:"3er",num:"8169"}] },
  { tipo:"DOMINICAL", sorteoN:"5144", fecha:"22 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"9033",letras:"DADB",serie:"12",folio:"12"},{pos:"2do",num:"8375"},{pos:"3er",num:"8150"}] },
  { tipo:"DOMINICAL", sorteoN:"5145", fecha:"29 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"5716",letras:"CADB",serie:"19",folio:"2"},{pos:"2do",num:"7581"},{pos:"3er",num:"9672"}] },
  { tipo:"MIERCOLITO", sorteoN:"2654", fecha:"04 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"2228",letras:"ACDD",serie:"20",folio:"7"},{pos:"2do",num:"1630"},{pos:"3er",num:"0260"}] },
  { tipo:"MIERCOLITO", sorteoN:"2655", fecha:"11 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"9680",letras:"CBDC",serie:"19",folio:"14"},{pos:"2do",num:"1211"},{pos:"3er",num:"9421"}] },
  { tipo:"MIERCOLITO", sorteoN:"2656", fecha:"18 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"5960",letras:"CABC",serie:"19",folio:"9"},{pos:"2do",num:"3358"},{pos:"3er",num:"4744"}] },
  { tipo:"MIERCOLITO", sorteoN:"2657", fecha:"25 Jul 2018", mes:7, anio:2018,
    premios:[{pos:"1er",num:"8159",letras:"BDAA",serie:"6",folio:"11"},{pos:"2do",num:"3507"},{pos:"3er",num:"4459"}] },
  { tipo:"DOMINICAL", sorteoN:"5146", fecha:"05 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"3086",letras:"BACD",serie:"1",folio:"15"},{pos:"2do",num:"7238"},{pos:"3er",num:"5358"}] },
  { tipo:"DOMINICAL", sorteoN:"5147", fecha:"12 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"6330",letras:"BDAC",serie:"15",folio:"15"},{pos:"2do",num:"1414"},{pos:"3er",num:"3203"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5148", fecha:"19 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"17743",letras:"BABB",serie:"2",folio:"7"},{pos:"2do",num:"17824"},{pos:"3er",num:"97399"}] },
  { tipo:"DOMINICAL", sorteoN:"5149", fecha:"26 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"7128",letras:"BACB",serie:"14",folio:"7"},{pos:"2do",num:"1167"},{pos:"3er",num:"9607"}] },
  { tipo:"MIERCOLITO", sorteoN:"2658", fecha:"01 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"8794",letras:"ABCD",serie:"9",folio:"5"},{pos:"2do",num:"1331"},{pos:"3er",num:"0074"}] },
  { tipo:"MIERCOLITO", sorteoN:"2659", fecha:"08 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"6103",letras:"BDBD",serie:"4",folio:"5"},{pos:"2do",num:"7020"},{pos:"3er",num:"0131"}] },
  { tipo:"MIERCOLITO", sorteoN:"2660", fecha:"15 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"2409",letras:"DCAD",serie:"5",folio:"8"},{pos:"2do",num:"3610"},{pos:"3er",num:"1029"}] },
  { tipo:"MIERCOLITO", sorteoN:"2661", fecha:"22 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"9038",letras:"CCCD",serie:"10",folio:"5"},{pos:"2do",num:"2967"},{pos:"3er",num:"1660"}] },
  { tipo:"MIERCOLITO", sorteoN:"2662", fecha:"29 Ago 2018", mes:8, anio:2018,
    premios:[{pos:"1er",num:"6234",letras:"ACDC",serie:"10",folio:"3"},{pos:"2do",num:"4395"},{pos:"3er",num:"4862"}] },
  { tipo:"DOMINICAL", sorteoN:"5150", fecha:"02 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"6576",letras:"BCAD",serie:"24",folio:"3"},{pos:"2do",num:"5593"},{pos:"3er",num:"5008"}] },
  { tipo:"DOMINICAL", sorteoN:"5151", fecha:"09 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"0146",letras:"BCCA",serie:"22",folio:"2"},{pos:"2do",num:"0159"},{pos:"3er",num:"0195"}] },
  { tipo:"DOMINICAL", sorteoN:"5152", fecha:"16 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"7179",letras:"ABAA",serie:"3",folio:"5"},{pos:"2do",num:"7137"},{pos:"3er",num:"8730"}] },
  { tipo:"DOMINICAL", sorteoN:"5153", fecha:"23 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"6254",letras:"BDAA",serie:"19",folio:"3"},{pos:"2do",num:"2492"},{pos:"3er",num:"0782"}] },
  { tipo:"DOMINICAL", sorteoN:"5154", fecha:"30 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"7487",letras:"ABBA",serie:"23",folio:"4"},{pos:"2do",num:"5009"},{pos:"3er",num:"4070"}] },
  { tipo:"MIERCOLITO", sorteoN:"2663", fecha:"05 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"2393",letras:"BBDA",serie:"1",folio:"15"},{pos:"2do",num:"7494"},{pos:"3er",num:"1807"}] },
  { tipo:"MIERCOLITO", sorteoN:"2664", fecha:"12 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"5087",letras:"CAAA",serie:"8",folio:"4"},{pos:"2do",num:"8650"},{pos:"3er",num:"7324"}] },
  { tipo:"MIERCOLITO", sorteoN:"2665", fecha:"19 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"7472",letras:"CBBA",serie:"5",folio:"5"},{pos:"2do",num:"8555"},{pos:"3er",num:"0439"}] },
  { tipo:"MIERCOLITO", sorteoN:"2666", fecha:"26 Sep 2018", mes:9, anio:2018,
    premios:[{pos:"1er",num:"1935",letras:"BBDC",serie:"15",folio:"3"},{pos:"2do",num:"5645"},{pos:"3er",num:"8694"}] },
  { tipo:"DOMINICAL", sorteoN:"5155", fecha:"07 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"5895",letras:"BADB",serie:"17",folio:"3"},{pos:"2do",num:"2661"},{pos:"3er",num:"8726"}] },
  { tipo:"DOMINICAL", sorteoN:"5156", fecha:"14 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"5444",letras:"BACB",serie:"21",folio:"13"},{pos:"2do",num:"3416"},{pos:"3er",num:"4613"}] },
  { tipo:"DOMINICAL", sorteoN:"5157", fecha:"21 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"2358",letras:"ADDA",serie:"12",folio:"14"},{pos:"2do",num:"4972"},{pos:"3er",num:"9319"}] },
  { tipo:"DOMINICAL", sorteoN:"5158", fecha:"28 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"8274",letras:"DCDB",serie:"10",folio:"5"},{pos:"2do",num:"0214"},{pos:"3er",num:"0552"}] },
  { tipo:"MIERCOLITO", sorteoN:"2667", fecha:"03 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"9238",letras:"BABA",serie:"18",folio:"2"},{pos:"2do",num:"4385"},{pos:"3er",num:"0955"}] },
  { tipo:"MIERCOLITO", sorteoN:"2668", fecha:"10 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"0342",letras:"CAAC",serie:"7",folio:"6"},{pos:"2do",num:"9447"},{pos:"3er",num:"0302"}] },
  { tipo:"MIERCOLITO", sorteoN:"2669", fecha:"17 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"1379",letras:"CADB",serie:"21",folio:"10"},{pos:"2do",num:"9879"},{pos:"3er",num:"5703"}] },
  { tipo:"MIERCOLITO", sorteoN:"2670", fecha:"24 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"6749",letras:"CCAB",serie:"15",folio:"10"},{pos:"2do",num:"0543"},{pos:"3er",num:"5540"}] },
  { tipo:"MIERCOLITO", sorteoN:"2671", fecha:"31 Oct 2018", mes:10, anio:2018,
    premios:[{pos:"1er",num:"8704",letras:"CDBB",serie:"8",folio:"14"},{pos:"2do",num:"9274"},{pos:"3er",num:"6149"}] },
  { tipo:"DOMINICAL", sorteoN:"5159", fecha:"03 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"2245",letras:"CBDB",serie:"18",folio:"14"},{pos:"2do",num:"6002"},{pos:"3er",num:"8962"}] },
  { tipo:"DOMINICAL", sorteoN:"5160", fecha:"11 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"4371",letras:"DBBA",serie:"4",folio:"12"},{pos:"2do",num:"2881"},{pos:"3er",num:"6627"}] },
  { tipo:"DOMINICAL", sorteoN:"5161", fecha:"18 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"9133",letras:"ACBC",serie:"5",folio:"10"},{pos:"2do",num:"8330"},{pos:"3er",num:"1521"}] },
  { tipo:"DOMINICAL", sorteoN:"5162", fecha:"25 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"4551",letras:"ABDC",serie:"19",folio:"1"},{pos:"2do",num:"2247"},{pos:"3er",num:"9691"}] },
  { tipo:"MIERCOLITO", sorteoN:"2672", fecha:"07 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"1532",letras:"AADC",serie:"16",folio:"14"},{pos:"2do",num:"7777"},{pos:"3er",num:"9761"}] },
  { tipo:"MIERCOLITO", sorteoN:"2673", fecha:"14 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"2059",letras:"CAAC",serie:"1",folio:"8"},{pos:"2do",num:"1641"},{pos:"3er",num:"1301"}] },
  { tipo:"MIERCOLITO", sorteoN:"2674", fecha:"21 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"1294",letras:"CCBC",serie:"20",folio:"9"},{pos:"2do",num:"2918"},{pos:"3er",num:"3957"}] },
  { tipo:"MIERCOLITO", sorteoN:"2675", fecha:"28 Nov 2018", mes:11, anio:2018,
    premios:[{pos:"1er",num:"4730",letras:"DDAC",serie:"11",folio:"15"},{pos:"2do",num:"3300"},{pos:"3er",num:"0667"}] },
  { tipo:"DOMINICAL", sorteoN:"5163", fecha:"02 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"4218",letras:"BCAA",serie:"6",folio:"12"},{pos:"2do",num:"4611"},{pos:"3er",num:"6004"}] },
  { tipo:"DOMINICAL", sorteoN:"5164", fecha:"09 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"8640",letras:"ADBB",serie:"22",folio:"10"},{pos:"2do",num:"0953"},{pos:"3er",num:"9051"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5165", fecha:"16 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"55222",letras:"DBAA",serie:"1",folio:"9"},{pos:"2do",num:"50555"},{pos:"3er",num:"24009"}] },
  { tipo:"DOMINICAL", sorteoN:"5166", fecha:"23 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"0263",letras:"BCBC",serie:"4",folio:"6"},{pos:"2do",num:"1475"},{pos:"3er",num:"3551"}] },
  { tipo:"DOMINICAL", sorteoN:"5167", fecha:"30 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"6458",letras:"CDCB",serie:"15",folio:"9"},{pos:"2do",num:"0912"},{pos:"3er",num:"2403"}] },
  { tipo:"MIERCOLITO", sorteoN:"2676", fecha:"05 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"9762",letras:"ABAB",serie:"15",folio:"6"},{pos:"2do",num:"5207"},{pos:"3er",num:"0635"}] },
  { tipo:"MIERCOLITO", sorteoN:"2677", fecha:"12 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"6152",letras:"DCCA",serie:"16",folio:"8"},{pos:"2do",num:"1812"},{pos:"3er",num:"7402"}] },
  { tipo:"MIERCOLITO", sorteoN:"2678", fecha:"19 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"2807",letras:"CAAD",serie:"20",folio:"8"},{pos:"2do",num:"8291"},{pos:"3er",num:"0779"}] },
  { tipo:"MIERCOLITO", sorteoN:"2679", fecha:"26 Dic 2018", mes:12, anio:2018,
    premios:[{pos:"1er",num:"2998",letras:"DBBD",serie:"7",folio:"15"},{pos:"2do",num:"0487"},{pos:"3er",num:"4472"}] },
  // ══════ 2017 ══════ — Datos verificados desde balotas.com (j2017.php)
  { tipo:"DOMINICAL", sorteoN:"5063", fecha:"02 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"8362",letras:"DBAD",serie:"16",folio:"7"},{pos:"2do",num:"7755"},{pos:"3er",num:"9184"}] },
  { tipo:"DOMINICAL", sorteoN:"5064", fecha:"08 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"5518",letras:"BCCC",serie:"3",folio:"4"},{pos:"2do",num:"1817"},{pos:"3er",num:"1338"}] },
  { tipo:"DOMINICAL", sorteoN:"5065", fecha:"15 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"1140",letras:"ADDB",serie:"19",folio:"9"},{pos:"2do",num:"4790"},{pos:"3er",num:"3738"}] },
  { tipo:"DOMINICAL", sorteoN:"5066", fecha:"22 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"5193",letras:"ADDD",serie:"10",folio:"4"},{pos:"2do",num:"3134"},{pos:"3er",num:"8274"}] },
  { tipo:"DOMINICAL", sorteoN:"5067", fecha:"29 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"8899",letras:"ADCB",serie:"8",folio:"14"},{pos:"2do",num:"9600"},{pos:"3er",num:"4523"}] },
  { tipo:"MIERCOLITO", sorteoN:"2576", fecha:"05 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"0843",letras:"ADCC",serie:"14",folio:"15"},{pos:"2do",num:"1896"},{pos:"3er",num:"3608"}] },
  { tipo:"MIERCOLITO", sorteoN:"2577", fecha:"11 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"2126",letras:"CBDD",serie:"11",folio:"1"},{pos:"2do",num:"7441"},{pos:"3er",num:"8136"}] },
  { tipo:"MIERCOLITO", sorteoN:"2578", fecha:"18 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"1502",letras:"CABB",serie:"19",folio:"5"},{pos:"2do",num:"4686"},{pos:"3er",num:"9944"}] },
  { tipo:"MIERCOLITO", sorteoN:"2579", fecha:"25 Ene 2017", mes:1, anio:2017,
    premios:[{pos:"1er",num:"5458",letras:"BDCD",serie:"12",folio:"5"},{pos:"2do",num:"3792"},{pos:"3er",num:"5456"}] },
  { tipo:"DOMINICAL", sorteoN:"5068", fecha:"05 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"1085",letras:"CCDB",serie:"5",folio:"11"},{pos:"2do",num:"5520"},{pos:"3er",num:"6407"}] },
  { tipo:"DOMINICAL", sorteoN:"5069", fecha:"12 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"7308",letras:"BCCA",serie:"5",folio:"8"},{pos:"2do",num:"8052"},{pos:"3er",num:"0447"}] },
  { tipo:"DOMINICAL", sorteoN:"5070", fecha:"19 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"1686",letras:"DADD",serie:"3",folio:"12"},{pos:"2do",num:"0734"},{pos:"3er",num:"2299"}] },
  { tipo:"DOMINICAL", sorteoN:"5071", fecha:"25 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"6988",letras:"AAAA",serie:"7",folio:"6"},{pos:"2do",num:"5977"},{pos:"3er",num:"9957"}] },
  { tipo:"MIERCOLITO", sorteoN:"2580", fecha:"01 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"3631",letras:"DDDB",serie:"16",folio:"3"},{pos:"2do",num:"9371"},{pos:"3er",num:"3138"}] },
  { tipo:"MIERCOLITO", sorteoN:"2581", fecha:"08 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"9649",letras:"DDBB",serie:"10",folio:"5"},{pos:"2do",num:"5555"},{pos:"3er",num:"8919"}] },
  { tipo:"MIERCOLITO", sorteoN:"2582", fecha:"15 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"1911",letras:"DDBA",serie:"6",folio:"15"},{pos:"2do",num:"0681"},{pos:"3er",num:"2279"}] },
  { tipo:"MIERCOLITO", sorteoN:"2583", fecha:"22 Feb 2017", mes:2, anio:2017,
    premios:[{pos:"1er",num:"3418",letras:"DCDC",serie:"9",folio:"11"},{pos:"2do",num:"0491"},{pos:"3er",num:"4912"}] },
  { tipo:"DOMINICAL", sorteoN:"5072", fecha:"05 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"1332",letras:"ADBC",serie:"12",folio:"14"},{pos:"2do",num:"3229"},{pos:"3er",num:"1838"}] },
  { tipo:"DOMINICAL", sorteoN:"5073", fecha:"12 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"4886",letras:"BDBC",serie:"11",folio:"11"},{pos:"2do",num:"6657"},{pos:"3er",num:"9529"}] },
  { tipo:"DOMINICAL", sorteoN:"5074", fecha:"19 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"4387",letras:"CCBC",serie:"8",folio:"4"},{pos:"2do",num:"1537"},{pos:"3er",num:"2369"}] },
  { tipo:"DOMINICAL", sorteoN:"5075", fecha:"26 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"5529",letras:"ADAA",serie:"4",folio:"3"},{pos:"2do",num:"1396"},{pos:"3er",num:"7855"}] },
  { tipo:"MIERCOLITO", sorteoN:"2584", fecha:"02 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"0842",letras:"BBDB",serie:"4",folio:"7"},{pos:"2do",num:"1481"},{pos:"3er",num:"2609"}] },
  { tipo:"MIERCOLITO", sorteoN:"2585", fecha:"08 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"2965",letras:"CADA",serie:"6",folio:"11"},{pos:"2do",num:"4370"},{pos:"3er",num:"1616"}] },
  { tipo:"MIERCOLITO", sorteoN:"2586", fecha:"15 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"6770",letras:"CACD",serie:"17",folio:"15"},{pos:"2do",num:"6299"},{pos:"3er",num:"0892"}] },
  { tipo:"MIERCOLITO", sorteoN:"2587", fecha:"22 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"3505",letras:"BBCA",serie:"4",folio:"8"},{pos:"2do",num:"7058"},{pos:"3er",num:"6560"}] },
  { tipo:"MIERCOLITO", sorteoN:"2588", fecha:"29 Mar 2017", mes:3, anio:2017,
    premios:[{pos:"1er",num:"9045",letras:"BBCD",serie:"3",folio:"10"},{pos:"2do",num:"1818"},{pos:"3er",num:"8934"}] },
  { tipo:"DOMINICAL", sorteoN:"5076", fecha:"02 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"4621",letras:"BACA",serie:"11",folio:"6"},{pos:"2do",num:"9582"},{pos:"3er",num:"6217"}] },
  { tipo:"DOMINICAL", sorteoN:"5077", fecha:"09 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"0592",letras:"ADDC",serie:"7",folio:"7"},{pos:"2do",num:"1598"},{pos:"3er",num:"6827"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5078", fecha:"17 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"76515",letras:"CDAD",serie:"3",folio:"9"},{pos:"2do",num:"30642"},{pos:"3er",num:"89292"}] },
  { tipo:"DOMINICAL", sorteoN:"5079", fecha:"23 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"1203",letras:"ABCA",serie:"10",folio:"1"},{pos:"2do",num:"9874"},{pos:"3er",num:"6335"}] },
  { tipo:"DOMINICAL", sorteoN:"5080", fecha:"30 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"1893",letras:"CDDA",serie:"12",folio:"10"},{pos:"2do",num:"3959"},{pos:"3er",num:"0376"}] },
  { tipo:"MIERCOLITO", sorteoN:"2589", fecha:"05 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"1194",letras:"CADD",serie:"18",folio:"15"},{pos:"2do",num:"7090"},{pos:"3er",num:"8686"}] },
  { tipo:"MIERCOLITO", sorteoN:"2590", fecha:"12 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"7440",letras:"CBDA",serie:"20",folio:"9"},{pos:"2do",num:"2419"},{pos:"3er",num:"6307"}] },
  { tipo:"MIERCOLITO", sorteoN:"2591", fecha:"20 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"5244",letras:"ABDB",serie:"4",folio:"5"},{pos:"2do",num:"6779"},{pos:"3er",num:"5383"}] },
  { tipo:"MIERCOLITO", sorteoN:"2592", fecha:"26 Abr 2017", mes:4, anio:2017,
    premios:[{pos:"1er",num:"5187",letras:"BDBB",serie:"2",folio:"14"},{pos:"2do",num:"0632"},{pos:"3er",num:"1386"}] },
  { tipo:"DOMINICAL", sorteoN:"5081", fecha:"07 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"5351",letras:"BDDD",serie:"14",folio:"5"},{pos:"2do",num:"4345"},{pos:"3er",num:"3250"}] },
  { tipo:"DOMINICAL", sorteoN:"5082", fecha:"14 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"4977",letras:"ADAD",serie:"23",folio:"6"},{pos:"2do",num:"8998"},{pos:"3er",num:"5284"}] },
  { tipo:"DOMINICAL", sorteoN:"5083", fecha:"21 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"6471",letras:"CACD",serie:"19",folio:"3"},{pos:"2do",num:"0895"},{pos:"3er",num:"9726"}] },
  { tipo:"DOMINICAL", sorteoN:"5084", fecha:"28 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"8291",letras:"ABAB",serie:"24",folio:"8"},{pos:"2do",num:"6198"},{pos:"3er",num:"1304"}] },
  { tipo:"MIERCOLITO", sorteoN:"2593", fecha:"03 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"3527",letras:"DBCB",serie:"6",folio:"9"},{pos:"2do",num:"8204"},{pos:"3er",num:"9137"}] },
  { tipo:"MIERCOLITO", sorteoN:"2594", fecha:"10 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"4263",letras:"DBAD",serie:"16",folio:"12"},{pos:"2do",num:"9157"},{pos:"3er",num:"0466"}] },
  { tipo:"MIERCOLITO", sorteoN:"2595", fecha:"17 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"2996",letras:"BCCB",serie:"2",folio:"4"},{pos:"2do",num:"9465"},{pos:"3er",num:"9913"}] },
  { tipo:"MIERCOLITO", sorteoN:"2596", fecha:"24 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"8394",letras:"AACB",serie:"3",folio:"11"},{pos:"2do",num:"5974"},{pos:"3er",num:"7634"}] },
  { tipo:"MIERCOLITO", sorteoN:"2597", fecha:"31 May 2017", mes:5, anio:2017,
    premios:[{pos:"1er",num:"7490",letras:"DADA",serie:"20",folio:"13"},{pos:"2do",num:"7682"},{pos:"3er",num:"6240"}] },
  { tipo:"DOMINICAL", sorteoN:"5085", fecha:"04 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"9169",letras:"DCCC",serie:"3",folio:"7"},{pos:"2do",num:"5963"},{pos:"3er",num:"7971"}] },
  { tipo:"DOMINICAL", sorteoN:"5086", fecha:"11 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"6070",letras:"ACCB",serie:"10",folio:"11"},{pos:"2do",num:"7141"},{pos:"3er",num:"2905"}] },
  { tipo:"DOMINICAL", sorteoN:"5087", fecha:"18 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"2951",letras:"DCDB",serie:"21",folio:"6"},{pos:"2do",num:"4640"},{pos:"3er",num:"2107"}] },
  { tipo:"DOMINICAL", sorteoN:"5088", fecha:"25 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"8984",letras:"BBAD",serie:"21",folio:"4"},{pos:"2do",num:"6710"},{pos:"3er",num:"5570"}] },
  { tipo:"MIERCOLITO", sorteoN:"2598", fecha:"07 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"7642",letras:"BDDB",serie:"4",folio:"1"},{pos:"2do",num:"2266"},{pos:"3er",num:"6059"}] },
  { tipo:"MIERCOLITO", sorteoN:"2599", fecha:"14 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"3141",letras:"CCBA",serie:"15",folio:"11"},{pos:"2do",num:"1785"},{pos:"3er",num:"0944"}] },
  { tipo:"MIERCOLITO", sorteoN:"2600", fecha:"21 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"4183",letras:"CBBB",serie:"20",folio:"9"},{pos:"2do",num:"3006"},{pos:"3er",num:"0364"}] },
  { tipo:"MIERCOLITO", sorteoN:"2601", fecha:"28 Jun 2017", mes:6, anio:2017,
    premios:[{pos:"1er",num:"4497",letras:"DBAC",serie:"8",folio:"4"},{pos:"2do",num:"6250"},{pos:"3er",num:"9772"}] },
  { tipo:"DOMINICAL", sorteoN:"5089", fecha:"02 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"6526",letras:"DDCA",serie:"24",folio:"7"},{pos:"2do",num:"1681"},{pos:"3er",num:"6808"}] },
  { tipo:"DOMINICAL", sorteoN:"5090", fecha:"09 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"6304",letras:"CCDA",serie:"11",folio:"7"},{pos:"2do",num:"8213"},{pos:"3er",num:"9237"}] },
  { tipo:"DOMINICAL", sorteoN:"5091", fecha:"16 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"6596",letras:"CBDD",serie:"13",folio:"7"},{pos:"2do",num:"8767"},{pos:"3er",num:"9824"}] },
  { tipo:"DOMINICAL", sorteoN:"5092", fecha:"23 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"6415",letras:"BADC",serie:"6",folio:"13"},{pos:"2do",num:"0129"},{pos:"3er",num:"3908"}] },
  { tipo:"DOMINICAL", sorteoN:"5093", fecha:"30 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"7759",letras:"ACCA",serie:"1",folio:"10"},{pos:"2do",num:"2362"},{pos:"3er",num:"8116"}] },
  { tipo:"MIERCOLITO", sorteoN:"2602", fecha:"05 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"3475",letras:"DBBB",serie:"3",folio:"13"},{pos:"2do",num:"3535"},{pos:"3er",num:"7648"}] },
  { tipo:"MIERCOLITO", sorteoN:"2603", fecha:"12 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"8129",letras:"ABBA",serie:"19",folio:"13"},{pos:"2do",num:"8447"},{pos:"3er",num:"7940"}] },
  { tipo:"MIERCOLITO", sorteoN:"2604", fecha:"19 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"0566",letras:"AAAA",serie:"19",folio:"8"},{pos:"2do",num:"6522"},{pos:"3er",num:"2296"}] },
  { tipo:"MIERCOLITO", sorteoN:"2605", fecha:"26 Jul 2017", mes:7, anio:2017,
    premios:[{pos:"1er",num:"6089",letras:"DDCA",serie:"6",folio:"13"},{pos:"2do",num:"5725"},{pos:"3er",num:"4150"}] },
  { tipo:"DOMINICAL", sorteoN:"5094", fecha:"06 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"5477",letras:"BCDD",serie:"2",folio:"5"},{pos:"2do",num:"8842"},{pos:"3er",num:"9759"}] },
  { tipo:"DOMINICAL", sorteoN:"5095", fecha:"13 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"0274",letras:"DDDC",serie:"24",folio:"6"},{pos:"2do",num:"4193"},{pos:"3er",num:"9820"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5096", fecha:"20 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"53316",letras:"BADD",serie:"3",folio:"8"},{pos:"2do",num:"74679"},{pos:"3er",num:"25036"}] },
  { tipo:"DOMINICAL", sorteoN:"5097", fecha:"27 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"7421",letras:"BBCA",serie:"3",folio:"11"},{pos:"2do",num:"4726"},{pos:"3er",num:"6307"}] },
  { tipo:"MIERCOLITO", sorteoN:"2606", fecha:"02 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"6502",letras:"DDCA",serie:"18",folio:"11"},{pos:"2do",num:"4798"},{pos:"3er",num:"6589"}] },
  { tipo:"MIERCOLITO", sorteoN:"2607", fecha:"09 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"7684",letras:"CBBA",serie:"18",folio:"1"},{pos:"2do",num:"7179"},{pos:"3er",num:"2717"}] },
  { tipo:"MIERCOLITO", sorteoN:"2608", fecha:"16 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"7894",letras:"DBDC",serie:"14",folio:"7"},{pos:"2do",num:"6122"},{pos:"3er",num:"5195"}] },
  { tipo:"MIERCOLITO", sorteoN:"2609", fecha:"23 Ago 2017", mes:8, anio:2017,
    premios:[{pos:"1er",num:"8301",letras:"ACCD",serie:"19",folio:"11"},{pos:"2do",num:"3552"},{pos:"3er",num:"1426"}] },
  { tipo:"DOMINICAL", sorteoN:"5098", fecha:"03 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"2728",letras:"CAAB",serie:"16",folio:"13"},{pos:"2do",num:"3979"},{pos:"3er",num:"0676"}] },
  { tipo:"DOMINICAL", sorteoN:"5099", fecha:"10 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"8930",letras:"ACAB",serie:"3",folio:"4"},{pos:"2do",num:"7443"},{pos:"3er",num:"9682"}] },
  { tipo:"DOMINICAL", sorteoN:"5100", fecha:"17 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"7842",letras:"ACBC",serie:"13",folio:"13"},{pos:"2do",num:"1718"},{pos:"3er",num:"2529"}] },
  { tipo:"DOMINICAL", sorteoN:"5101", fecha:"24 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"1071",letras:"ACDA",serie:"23",folio:"11"},{pos:"2do",num:"8324"},{pos:"3er",num:"5691"}] },
  { tipo:"MIERCOLITO", sorteoN:"2611", fecha:"06 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"0841",letras:"DAAB",serie:"6",folio:"9"},{pos:"2do",num:"1705"},{pos:"3er",num:"7736"}] },
  { tipo:"MIERCOLITO", sorteoN:"2612", fecha:"13 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"2076",letras:"ABCD",serie:"8",folio:"13"},{pos:"2do",num:"8318"},{pos:"3er",num:"2893"}] },
  { tipo:"MIERCOLITO", sorteoN:"2613", fecha:"20 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"7634",letras:"BAAB",serie:"14",folio:"4"},{pos:"2do",num:"8739"},{pos:"3er",num:"8290"}] },
  { tipo:"MIERCOLITO", sorteoN:"2614", fecha:"27 Sep 2017", mes:9, anio:2017,
    premios:[{pos:"1er",num:"9619",letras:"ABDD",serie:"3",folio:"3"},{pos:"2do",num:"6862"},{pos:"3er",num:"2474"}] },
  { tipo:"DOMINICAL", sorteoN:"5102", fecha:"01 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"0413",letras:"AADB",serie:"24",folio:"10"},{pos:"2do",num:"6624"},{pos:"3er",num:"0058"}] },
  { tipo:"DOMINICAL", sorteoN:"5103", fecha:"08 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"2990",letras:"ADDA",serie:"15",folio:"1"},{pos:"2do",num:"1976"},{pos:"3er",num:"6017"}] },
  { tipo:"DOMINICAL", sorteoN:"5104", fecha:"15 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"6048",letras:"BDDC",serie:"7",folio:"8"},{pos:"2do",num:"5559"},{pos:"3er",num:"9849"}] },
  { tipo:"DOMINICAL", sorteoN:"5105", fecha:"22 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"1858",letras:"BDAC",serie:"14",folio:"15"},{pos:"2do",num:"1668"},{pos:"3er",num:"1396"}] },
  { tipo:"DOMINICAL", sorteoN:"5106", fecha:"29 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"9904",letras:"CACC",serie:"10",folio:"5"},{pos:"2do",num:"9344"},{pos:"3er",num:"6326"}] },
  { tipo:"MIERCOLITO", sorteoN:"2615", fecha:"04 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"0244",letras:"BBAD",serie:"18",folio:"9"},{pos:"2do",num:"5384"},{pos:"3er",num:"0072"}] },
  { tipo:"MIERCOLITO", sorteoN:"2616", fecha:"12 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"5563",letras:"AACD",serie:"2",folio:"10"},{pos:"2do",num:"4176"},{pos:"3er",num:"2737"}] },
  { tipo:"MIERCOLITO", sorteoN:"2617", fecha:"18 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"3281",letras:"ABAD",serie:"12",folio:"5"},{pos:"2do",num:"3063"},{pos:"3er",num:"2981"}] },
  { tipo:"MIERCOLITO", sorteoN:"2618", fecha:"25 Oct 2017", mes:10, anio:2017,
    premios:[{pos:"1er",num:"1500",letras:"BADC",serie:"20",folio:"7"},{pos:"2do",num:"8237"},{pos:"3er",num:"4461"}] },
  { tipo:"DOMINICAL", sorteoN:"5107", fecha:"06 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"8110",letras:"BABA",serie:"19",folio:"14"},{pos:"2do",num:"2322"},{pos:"3er",num:"2627"}] },
  { tipo:"DOMINICAL", sorteoN:"5108", fecha:"12 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"0178",letras:"DABA",serie:"13",folio:"7"},{pos:"2do",num:"6677"},{pos:"3er",num:"6235"}] },
  { tipo:"DOMINICAL", sorteoN:"5109", fecha:"19 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"8056",letras:"CCAA",serie:"13",folio:"12"},{pos:"2do",num:"9078"},{pos:"3er",num:"3785"}] },
  { tipo:"DOMINICAL", sorteoN:"5110", fecha:"26 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"3539",letras:"AADA",serie:"2",folio:"14"},{pos:"2do",num:"0397"},{pos:"3er",num:"6673"}] },
  { tipo:"MIERCOLITO", sorteoN:"2619", fecha:"01 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"7076",letras:"DBDD",serie:"19",folio:"12"},{pos:"2do",num:"5516"},{pos:"3er",num:"1880"}] },
  { tipo:"MIERCOLITO", sorteoN:"2620", fecha:"09 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"2192",letras:"AADB",serie:"17",folio:"7"},{pos:"2do",num:"5860"},{pos:"3er",num:"5486"}] },
  { tipo:"MIERCOLITO", sorteoN:"2621", fecha:"15 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"4729",letras:"BABB",serie:"20",folio:"11"},{pos:"2do",num:"5026"},{pos:"3er",num:"9314"}] },
  { tipo:"MIERCOLITO", sorteoN:"2622", fecha:"22 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"3515",letras:"BBAC",serie:"13",folio:"15"},{pos:"2do",num:"4722"},{pos:"3er",num:"5119"}] },
  { tipo:"MIERCOLITO", sorteoN:"2623", fecha:"29 Nov 2017", mes:11, anio:2017,
    premios:[{pos:"1er",num:"7477",letras:"DDCC",serie:"12",folio:"12"},{pos:"2do",num:"6548"},{pos:"3er",num:"2232"}] },
  { tipo:"DOMINICAL", sorteoN:"5111", fecha:"03 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"0187",letras:"ABCA",serie:"20",folio:"13"},{pos:"2do",num:"0427"},{pos:"3er",num:"8462"}] },
  { tipo:"DOMINICAL", sorteoN:"5112", fecha:"10 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"1799",letras:"CAAB",serie:"10",folio:"14"},{pos:"2do",num:"6088"},{pos:"3er",num:"4097"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5113", fecha:"17 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"25943",letras:"DBAA",serie:"2",folio:"5"},{pos:"2do",num:"80054"},{pos:"3er",num:"69362"}] },
  { tipo:"DOMINICAL", sorteoN:"5114", fecha:"23 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"8561",letras:"BDBC",serie:"17",folio:"8"},{pos:"2do",num:"4395"},{pos:"3er",num:"5932"}] },
  { tipo:"DOMINICAL", sorteoN:"5115", fecha:"31 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"0646",letras:"ABAB",serie:"10",folio:"9"},{pos:"2do",num:"8290"},{pos:"3er",num:"8511"}] },
  { tipo:"MIERCOLITO", sorteoN:"2624", fecha:"06 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"3907",letras:"ACBA",serie:"2",folio:"1"},{pos:"2do",num:"0783"},{pos:"3er",num:"9877"}] },
  { tipo:"MIERCOLITO", sorteoN:"2625", fecha:"13 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"0454",letras:"DAAD",serie:"7",folio:"1"},{pos:"2do",num:"1238"},{pos:"3er",num:"1041"}] },
  { tipo:"MIERCOLITO", sorteoN:"2626", fecha:"20 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"8924",letras:"DDCD",serie:"4",folio:"11"},{pos:"2do",num:"2194"},{pos:"3er",num:"9133"}] },
  { tipo:"MIERCOLITO", sorteoN:"2627", fecha:"27 Dic 2017", mes:12, anio:2017,
    premios:[{pos:"1er",num:"3966",letras:"ADDC",serie:"12",folio:"11"},{pos:"2do",num:"5326"},{pos:"3er",num:"8134"}] },
  // ══════ 2016 ══════ — Datos verificados desde balotas.com (j2016.php)
  { tipo:"DOMINICAL", sorteoN:"5011", fecha:"03 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"1179",letras:"CABA",serie:"11",folio:"3"},{pos:"2do",num:"5731"},{pos:"3er",num:"9138"}] },
  { tipo:"DOMINICAL", sorteoN:"5012", fecha:"10 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"5356",letras:"DBDD",serie:"1",folio:"3"},{pos:"2do",num:"6383"},{pos:"3er",num:"3401"}] },
  { tipo:"DOMINICAL", sorteoN:"5013", fecha:"17 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"7848",letras:"AADA",serie:"15",folio:"9"},{pos:"2do",num:"4129"},{pos:"3er",num:"2224"}] },
  { tipo:"DOMINICAL", sorteoN:"5014", fecha:"24 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"1857",letras:"DDBC",serie:"12",folio:"6"},{pos:"2do",num:"9794"},{pos:"3er",num:"4673"}] },
  { tipo:"DOMINICAL", sorteoN:"5015", fecha:"31 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"4614",letras:"ACBD",serie:"3",folio:"5"},{pos:"2do",num:"2256"},{pos:"3er",num:"3733"}] },
  { tipo:"MIERCOLITO", sorteoN:"2524", fecha:"06 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"9475",letras:"DADD",serie:"19",folio:"5"},{pos:"2do",num:"9657"},{pos:"3er",num:"0966"}] },
  { tipo:"MIERCOLITO", sorteoN:"2525", fecha:"13 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"9125",letras:"BDDD",serie:"1",folio:"13"},{pos:"2do",num:"3761"},{pos:"3er",num:"9835"}] },
  { tipo:"MIERCOLITO", sorteoN:"2526", fecha:"20 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"3563",letras:"DDBC",serie:"10",folio:"12"},{pos:"2do",num:"6226"},{pos:"3er",num:"2035"}] },
  { tipo:"MIERCOLITO", sorteoN:"2527", fecha:"27 Ene 2016", mes:1, anio:2016,
    premios:[{pos:"1er",num:"8762",letras:"DBBC",serie:"6",folio:"9"},{pos:"2do",num:"3735"},{pos:"3er",num:"0545"}] },
  { tipo:"DOMINICAL", sorteoN:"5016", fecha:"06 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"8329",letras:"BDDA",serie:"4",folio:"12"},{pos:"2do",num:"7317"},{pos:"3er",num:"7598"}] },
  { tipo:"DOMINICAL", sorteoN:"5017", fecha:"14 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"5497",letras:"BCDA",serie:"4",folio:"8"},{pos:"2do",num:"8050"},{pos:"3er",num:"2333"}] },
  { tipo:"DOMINICAL", sorteoN:"5018", fecha:"21 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"8483",letras:"DCBA",serie:"21",folio:"9"},{pos:"2do",num:"1656"},{pos:"3er",num:"0235"}] },
  { tipo:"DOMINICAL", sorteoN:"5019", fecha:"28 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"5822",letras:"BDDB",serie:"17",folio:"5"},{pos:"2do",num:"4158"},{pos:"3er",num:"6799"}] },
  { tipo:"MIERCOLITO", sorteoN:"2528", fecha:"03 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"5440",letras:"ABDD",serie:"11",folio:"2"},{pos:"2do",num:"2095"},{pos:"3er",num:"6375"}] },
  { tipo:"MIERCOLITO", sorteoN:"2529", fecha:"11 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"4227",letras:"BADC",serie:"19",folio:"15"},{pos:"2do",num:"6681"},{pos:"3er",num:"5471"}] },
  { tipo:"MIERCOLITO", sorteoN:"2530", fecha:"17 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"5217",letras:"ABBC",serie:"4",folio:"12"},{pos:"2do",num:"0381"},{pos:"3er",num:"1558"}] },
  { tipo:"MIERCOLITO", sorteoN:"2531", fecha:"24 Feb 2016", mes:2, anio:2016,
    premios:[{pos:"1er",num:"6471",letras:"CDCB",serie:"7",folio:"6"},{pos:"2do",num:"1810"},{pos:"3er",num:"0666"}] },
  { tipo:"DOMINICAL", sorteoN:"5020", fecha:"06 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"7758",letras:"DBBA",serie:"11",folio:"3"},{pos:"2do",num:"9217"},{pos:"3er",num:"4994"}] },
  { tipo:"DOMINICAL", sorteoN:"5021", fecha:"13 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"7983",letras:"BDCC",serie:"13",folio:"15"},{pos:"2do",num:"0671"},{pos:"3er",num:"8984"}] },
  { tipo:"DOMINICAL", sorteoN:"5022", fecha:"20 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"3386",letras:"DDCB",serie:"8",folio:"8"},{pos:"2do",num:"8833"},{pos:"3er",num:"7173"}] },
  { tipo:"DOMINICAL", sorteoN:"5023", fecha:"28 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"7602",letras:"DADB",serie:"4",folio:"9"},{pos:"2do",num:"6309"},{pos:"3er",num:"3487"}] },
  { tipo:"MIERCOLITO", sorteoN:"2532", fecha:"02 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"4418",letras:"BCBC",serie:"12",folio:"5"},{pos:"2do",num:"4427"},{pos:"3er",num:"0136"}] },
  { tipo:"MIERCOLITO", sorteoN:"2533", fecha:"09 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"9241",letras:"CCAB",serie:"1",folio:"15"},{pos:"2do",num:"6537"},{pos:"3er",num:"6950"}] },
  { tipo:"MIERCOLITO", sorteoN:"2534", fecha:"16 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"4585",letras:"CDDC",serie:"8",folio:"11"},{pos:"2do",num:"7517"},{pos:"3er",num:"9096"}] },
  { tipo:"MIERCOLITO", sorteoN:"2535", fecha:"23 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"7486",letras:"DBDA",serie:"1",folio:"15"},{pos:"2do",num:"6922"},{pos:"3er",num:"0364"}] },
  { tipo:"MIERCOLITO", sorteoN:"2536", fecha:"31 Mar 2016", mes:3, anio:2016,
    premios:[{pos:"1er",num:"8391",letras:"DCCD",serie:"5",folio:"13"},{pos:"2do",num:"6580"},{pos:"3er",num:"2796"}] },
  { tipo:"DOMINICAL", sorteoN:"5024", fecha:"03 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"5844",letras:"DCCA",serie:"13",folio:"9"},{pos:"2do",num:"0653"},{pos:"3er",num:"8764"}] },
  { tipo:"DOMINICAL", sorteoN:"5025", fecha:"10 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"9725",letras:"DDAC",serie:"8",folio:"15"},{pos:"2do",num:"2206"},{pos:"3er",num:"8057"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5026", fecha:"17 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"16047",letras:"CCDD",serie:"3",folio:"13"},{pos:"2do",num:"29904"},{pos:"3er",num:"74849"}] },
  { tipo:"DOMINICAL", sorteoN:"5027", fecha:"24 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"6178",letras:"DCBD",serie:"14",folio:"7"},{pos:"2do",num:"0347"},{pos:"3er",num:"5889"}] },
  { tipo:"MIERCOLITO", sorteoN:"2537", fecha:"06 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"5490",letras:"CBBC",serie:"4",folio:"3"},{pos:"2do",num:"6623"},{pos:"3er",num:"4221"}] },
  { tipo:"MIERCOLITO", sorteoN:"2538", fecha:"13 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"1529",letras:"BCCB",serie:"15",folio:"2"},{pos:"2do",num:"8514"},{pos:"3er",num:"8300"}] },
  { tipo:"MIERCOLITO", sorteoN:"2539", fecha:"20 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"2612",letras:"ADDA",serie:"7",folio:"6"},{pos:"2do",num:"2575"},{pos:"3er",num:"4786"}] },
  { tipo:"MIERCOLITO", sorteoN:"2540", fecha:"27 Abr 2016", mes:4, anio:2016,
    premios:[{pos:"1er",num:"5088",letras:"ACAC",serie:"16",folio:"2"},{pos:"2do",num:"6812"},{pos:"3er",num:"7547"}] },
  { tipo:"DOMINICAL", sorteoN:"5028", fecha:"01 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"6984",letras:"BCAA",serie:"10",folio:"3"},{pos:"2do",num:"8625"},{pos:"3er",num:"8670"}] },
  { tipo:"DOMINICAL", sorteoN:"5029", fecha:"08 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"3431",letras:"DCCA",serie:"4",folio:"11"},{pos:"2do",num:"5412"},{pos:"3er",num:"6188"}] },
  { tipo:"DOMINICAL", sorteoN:"5030", fecha:"15 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"7630",letras:"AABC",serie:"12",folio:"9"},{pos:"2do",num:"0376"},{pos:"3er",num:"9679"}] },
  { tipo:"DOMINICAL", sorteoN:"5031", fecha:"22 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"2577",letras:"ADAA",serie:"20",folio:"6"},{pos:"2do",num:"1092"},{pos:"3er",num:"5591"}] },
  { tipo:"DOMINICAL", sorteoN:"5032", fecha:"29 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"9865",letras:"CDBD",serie:"1",folio:"13"},{pos:"2do",num:"1018"},{pos:"3er",num:"6967"}] },
  { tipo:"MIERCOLITO", sorteoN:"2541", fecha:"04 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"3938",letras:"DBBB",serie:"3",folio:"15"},{pos:"2do",num:"9782"},{pos:"3er",num:"1308"}] },
  { tipo:"MIERCOLITO", sorteoN:"2542", fecha:"11 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"7560",letras:"BDBC",serie:"17",folio:"6"},{pos:"2do",num:"1926"},{pos:"3er",num:"3828"}] },
  { tipo:"MIERCOLITO", sorteoN:"2543", fecha:"18 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"0047",letras:"AADA",serie:"1",folio:"4"},{pos:"2do",num:"2773"},{pos:"3er",num:"4961"}] },
  { tipo:"MIERCOLITO", sorteoN:"2544", fecha:"25 May 2016", mes:5, anio:2016,
    premios:[{pos:"1er",num:"4990",letras:"AADA",serie:"19",folio:"15"},{pos:"2do",num:"4614"},{pos:"3er",num:"0830"}] },
  { tipo:"DOMINICAL", sorteoN:"5033", fecha:"05 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"4675",letras:"DAAD",serie:"6",folio:"5"},{pos:"2do",num:"5720"},{pos:"3er",num:"0381"}] },
  { tipo:"DOMINICAL", sorteoN:"5034", fecha:"12 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"2861",letras:"DDBC",serie:"19",folio:"11"},{pos:"2do",num:"8530"},{pos:"3er",num:"5646"}] },
  { tipo:"DOMINICAL", sorteoN:"5035", fecha:"19 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"0780",letras:"BCCD",serie:"3",folio:"10"},{pos:"2do",num:"9951"},{pos:"3er",num:"4354"}] },
  { tipo:"DOMINICAL", sorteoN:"5036", fecha:"27 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"5068",letras:"DCCB",serie:"20",folio:"8"},{pos:"2do",num:"7398"},{pos:"3er",num:"8996"}] },
  { tipo:"MIERCOLITO", sorteoN:"2545", fecha:"01 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"0027",letras:"DDAC",serie:"15",folio:"6"},{pos:"2do",num:"8584"},{pos:"3er",num:"0386"}] },
  { tipo:"MIERCOLITO", sorteoN:"2546", fecha:"08 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"6630",letras:"ADDA",serie:"20",folio:"11"},{pos:"2do",num:"1695"},{pos:"3er",num:"4372"}] },
  { tipo:"MIERCOLITO", sorteoN:"2547", fecha:"15 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"1409",letras:"DDCB",serie:"11",folio:"2"},{pos:"2do",num:"7246"},{pos:"3er",num:"5401"}] },
  { tipo:"MIERCOLITO", sorteoN:"2548", fecha:"22 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"3097",letras:"CBDA",serie:"3",folio:"3"},{pos:"2do",num:"9406"},{pos:"3er",num:"3677"}] },
  { tipo:"MIERCOLITO", sorteoN:"2549", fecha:"30 Jun 2016", mes:6, anio:2016,
    premios:[{pos:"1er",num:"5564",letras:"AAAC",serie:"4",folio:"1"},{pos:"2do",num:"2551"},{pos:"3er",num:"9667"}] },
  { tipo:"DOMINICAL", sorteoN:"5037", fecha:"03 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"5365",letras:"ADDC",serie:"21",folio:"5"},{pos:"2do",num:"1171"},{pos:"3er",num:"6567"}] },
  { tipo:"DOMINICAL", sorteoN:"5038", fecha:"10 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"0020",letras:"BBCB",serie:"21",folio:"3"},{pos:"2do",num:"4182"},{pos:"3er",num:"4642"}] },
  { tipo:"DOMINICAL", sorteoN:"5039", fecha:"17 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"1472",letras:"BCBC",serie:"24",folio:"8"},{pos:"2do",num:"9390"},{pos:"3er",num:"9156"}] },
  { tipo:"DOMINICAL", sorteoN:"5040", fecha:"24 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"0170",letras:"DADA",serie:"11",folio:"10"},{pos:"2do",num:"3784"},{pos:"3er",num:"4235"}] },
  { tipo:"DOMINICAL", sorteoN:"5041", fecha:"31 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"7783",letras:"DBAA",serie:"23",folio:"4"},{pos:"2do",num:"8155"},{pos:"3er",num:"0150"}] },
  { tipo:"MIERCOLITO", sorteoN:"2550", fecha:"06 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"8742",letras:"ACCA",serie:"14",folio:"6"},{pos:"2do",num:"4522"},{pos:"3er",num:"7773"}] },
  { tipo:"MIERCOLITO", sorteoN:"2551", fecha:"13 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"7701",letras:"AACB",serie:"17",folio:"13"},{pos:"2do",num:"0894"},{pos:"3er",num:"9378"}] },
  { tipo:"MIERCOLITO", sorteoN:"2552", fecha:"20 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"8484",letras:"BADC",serie:"7",folio:"14"},{pos:"2do",num:"5562"},{pos:"3er",num:"0807"}] },
  { tipo:"MIERCOLITO", sorteoN:"2553", fecha:"27 Jul 2016", mes:7, anio:2016,
    premios:[{pos:"1er",num:"6155",letras:"CACC",serie:"19",folio:"8"},{pos:"2do",num:"7916"},{pos:"3er",num:"3259"}] },
  { tipo:"DOMINICAL", sorteoN:"5042", fecha:"07 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"8425",letras:"DACC",serie:"2",folio:"12"},{pos:"2do",num:"2197"},{pos:"3er",num:"0153"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5043", fecha:"14 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"82551",letras:"ABAB",serie:"3",folio:"8"},{pos:"2do",num:"24314"},{pos:"3er",num:"54079"}] },
  { tipo:"DOMINICAL", sorteoN:"5044", fecha:"21 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"4854",letras:"AABD",serie:"22",folio:"8"},{pos:"2do",num:"3236"},{pos:"3er",num:"6864"}] },
  { tipo:"DOMINICAL", sorteoN:"5045", fecha:"28 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"2289",letras:"ADCA",serie:"22",folio:"4"},{pos:"2do",num:"1703"},{pos:"3er",num:"5051"}] },
  { tipo:"MIERCOLITO", sorteoN:"2554", fecha:"03 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"9062",letras:"CBBC",serie:"19",folio:"7"},{pos:"2do",num:"0901"},{pos:"3er",num:"7046"}] },
  { tipo:"MIERCOLITO", sorteoN:"2555", fecha:"10 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"9571",letras:"CADB",serie:"18",folio:"8"},{pos:"2do",num:"3989"},{pos:"3er",num:"4159"}] },
  { tipo:"MIERCOLITO", sorteoN:"2556", fecha:"17 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"3009",letras:"BAAA",serie:"7",folio:"14"},{pos:"2do",num:"7382"},{pos:"3er",num:"1824"}] },
  { tipo:"MIERCOLITO", sorteoN:"2557", fecha:"24 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"1929",letras:"DCCD",serie:"4",folio:"13"},{pos:"2do",num:"0829"},{pos:"3er",num:"4782"}] },
  { tipo:"MIERCOLITO", sorteoN:"2558", fecha:"31 Ago 2016", mes:8, anio:2016,
    premios:[{pos:"1er",num:"0034",letras:"DADB",serie:"6",folio:"11"},{pos:"2do",num:"1515"},{pos:"3er",num:"8567"}] },
  { tipo:"DOMINICAL", sorteoN:"5046", fecha:"04 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"5933",letras:"AABB",serie:"12",folio:"7"},{pos:"2do",num:"0608"},{pos:"3er",num:"4757"}] },
  { tipo:"DOMINICAL", sorteoN:"5047", fecha:"11 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"4535",letras:"CADD",serie:"22",folio:"1"},{pos:"2do",num:"0198"},{pos:"3er",num:"0872"}] },
  { tipo:"DOMINICAL", sorteoN:"5048", fecha:"18 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"1342",letras:"CBBB",serie:"3",folio:"15"},{pos:"2do",num:"2147"},{pos:"3er",num:"3054"}] },
  { tipo:"DOMINICAL", sorteoN:"5049", fecha:"25 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"0836",letras:"AACD",serie:"4",folio:"13"},{pos:"2do",num:"0000"},{pos:"3er",num:"1983"}] },
  { tipo:"MIERCOLITO", sorteoN:"2559", fecha:"07 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"1414",letras:"BADD",serie:"6",folio:"7"},{pos:"2do",num:"3973"},{pos:"3er",num:"3780"}] },
  { tipo:"MIERCOLITO", sorteoN:"2560", fecha:"14 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"4924",letras:"ACCD",serie:"6",folio:"4"},{pos:"2do",num:"8051"},{pos:"3er",num:"9390"}] },
  { tipo:"MIERCOLITO", sorteoN:"2561", fecha:"21 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"7767",letras:"DDCC",serie:"7",folio:"1"},{pos:"2do",num:"8939"},{pos:"3er",num:"7126"}] },
  { tipo:"MIERCOLITO", sorteoN:"2562", fecha:"28 Sep 2016", mes:9, anio:2016,
    premios:[{pos:"1er",num:"1537",letras:"DACB",serie:"3",folio:"9"},{pos:"2do",num:"9606"},{pos:"3er",num:"2551"}] },
  { tipo:"DOMINICAL", sorteoN:"5050", fecha:"02 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"1258",letras:"ACBB",serie:"15",folio:"14"},{pos:"2do",num:"0099"},{pos:"3er",num:"6721"}] },
  { tipo:"DOMINICAL", sorteoN:"5051", fecha:"09 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"2505",letras:"BCBA",serie:"24",folio:"5"},{pos:"2do",num:"1413"},{pos:"3er",num:"0615"}] },
  { tipo:"DOMINICAL", sorteoN:"5052", fecha:"16 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"6654",letras:"DADB",serie:"12",folio:"9"},{pos:"2do",num:"8146"},{pos:"3er",num:"5047"}] },
  { tipo:"DOMINICAL", sorteoN:"5053", fecha:"23 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"6969",letras:"CBAB",serie:"1",folio:"8"},{pos:"2do",num:"1091"},{pos:"3er",num:"3705"}] },
  { tipo:"DOMINICAL", sorteoN:"5054", fecha:"30 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"6084",letras:"DDAB",serie:"4",folio:"6"},{pos:"2do",num:"6526"},{pos:"3er",num:"9539"}] },
  { tipo:"MIERCOLITO", sorteoN:"2563", fecha:"05 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"8529",letras:"ABDD",serie:"12",folio:"15"},{pos:"2do",num:"4322"},{pos:"3er",num:"4782"}] },
  { tipo:"MIERCOLITO", sorteoN:"2564", fecha:"12 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"2348",letras:"DBBC",serie:"1",folio:"12"},{pos:"2do",num:"5396"},{pos:"3er",num:"0664"}] },
  { tipo:"MIERCOLITO", sorteoN:"2565", fecha:"19 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"7280",letras:"BBAC",serie:"4",folio:"7"},{pos:"2do",num:"0263"},{pos:"3er",num:"9123"}] },
  { tipo:"MIERCOLITO", sorteoN:"2566", fecha:"26 Oct 2016", mes:10, anio:2016,
    premios:[{pos:"1er",num:"5435",letras:"BABD",serie:"14",folio:"3"},{pos:"2do",num:"5961"},{pos:"3er",num:"6617"}] },
  { tipo:"DOMINICAL", sorteoN:"5055", fecha:"06 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"8637",letras:"DACC",serie:"11",folio:"9"},{pos:"2do",num:"0825"},{pos:"3er",num:"1220"}] },
  { tipo:"DOMINICAL", sorteoN:"5056", fecha:"13 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"1419",letras:"AADB",serie:"16",folio:"1"},{pos:"2do",num:"7962"},{pos:"3er",num:"9722"}] },
  { tipo:"DOMINICAL", sorteoN:"5057", fecha:"20 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"7294",letras:"BDAD",serie:"10",folio:"1"},{pos:"2do",num:"4862"},{pos:"3er",num:"2804"}] },
  { tipo:"DOMINICAL", sorteoN:"5058", fecha:"27 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"6940",letras:"BCAD",serie:"20",folio:"1"},{pos:"2do",num:"4826"},{pos:"3er",num:"6912"}] },
  { tipo:"MIERCOLITO", sorteoN:"2567", fecha:"02 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"8468",letras:"ABAD",serie:"10",folio:"1"},{pos:"2do",num:"9540"},{pos:"3er",num:"6680"}] },
  { tipo:"MIERCOLITO", sorteoN:"2568", fecha:"09 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"1346",letras:"BCAC",serie:"18",folio:"13"},{pos:"2do",num:"8518"},{pos:"3er",num:"4253"}] },
  { tipo:"MIERCOLITO", sorteoN:"2569", fecha:"16 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"0726",letras:"CCDB",serie:"19",folio:"4"},{pos:"2do",num:"7517"},{pos:"3er",num:"6302"}] },
  { tipo:"MIERCOLITO", sorteoN:"2570", fecha:"23 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"0360",letras:"BCBD",serie:"17",folio:"7"},{pos:"2do",num:"8320"},{pos:"3er",num:"7979"}] },
  { tipo:"MIERCOLITO", sorteoN:"2571", fecha:"30 Nov 2016", mes:11, anio:2016,
    premios:[{pos:"1er",num:"2897",letras:"BADA",serie:"17",folio:"11"},{pos:"2do",num:"9191"},{pos:"3er",num:"5984"}] },
  { tipo:"DOMINICAL", sorteoN:"5059", fecha:"04 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"6681",letras:"ABDC",serie:"5",folio:"10"},{pos:"2do",num:"1325"},{pos:"3er",num:"4063"}] },
  { tipo:"DOMINICAL", sorteoN:"5060", fecha:"11 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"9554",letras:"DDAD",serie:"13",folio:"13"},{pos:"2do",num:"7277"},{pos:"3er",num:"1924"}] },
  { tipo:"EXTRAORDINARIA", sorteoN:"5061", fecha:"18 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"59546",letras:"DCBD",serie:"2",folio:"1"},{pos:"2do",num:"80436"},{pos:"3er",num:"18338"}] },
  { tipo:"DOMINICAL", sorteoN:"5062", fecha:"24 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"3470",letras:"DCCB",serie:"12",folio:"8"},{pos:"2do",num:"5678"},{pos:"3er",num:"1305"}] },
  { tipo:"MIERCOLITO", sorteoN:"2572", fecha:"07 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"6785",letras:"DCBB",serie:"3",folio:"1"},{pos:"2do",num:"1903"},{pos:"3er",num:"7954"}] },
  { tipo:"MIERCOLITO", sorteoN:"2573", fecha:"14 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"8788",letras:"BACD",serie:"9",folio:"4"},{pos:"2do",num:"7700"},{pos:"3er",num:"7300"}] },
  { tipo:"MIERCOLITO", sorteoN:"2574", fecha:"21 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"0676",letras:"BCDD",serie:"15",folio:"12"},{pos:"2do",num:"3685"},{pos:"3er",num:"5999"}] },
  { tipo:"MIERCOLITO", sorteoN:"2575", fecha:"28 Dic 2016", mes:12, anio:2016,
    premios:[{pos:"1er",num:"7061",letras:"BDBC",serie:"4",folio:"2"},{pos:"2do",num:"6311"},{pos:"3er",num:"4340"}] },
];

// Variable MUTABLE que usa el resto de la app
// Por defecto tiene los datos seed, se enriquece con datos del Worker al cargar
let HISTORIAL = [...HISTORIAL_SEED];

// ═══════════════════════════════════════════════════════════════════════
// FUNCIÓN para cargar sorteos actualizados del Worker
// Se llama una vez al iniciar la app desde ChanceRoot
// ═══════════════════════════════════════════════════════════════════════
//
// ▼ GUÍA PARA EL WORKER `chance-updater` (Cloudflare Workers) ▼
//
// El Worker debe scrapear estas fuentes en cascada (intentar 1, fallback a 2, etc.):
//
// 1. https://www.lnb.gob.pa  ← FUENTE OFICIAL PRIMARIA
//    Estructura HTML predecible. Buscar los 3 bloques con clase Tablero[D|I|Z]
//    (D = Dominical, I = Intermedio/Miercolito, Z = Zodiaco/Gordito).
//    Patrón de extracción:
//      - "SORTEO Nº" + número
//      - Fecha en formato "29 de Abril de 2026"
//      - "PRIMER PREMIO" + 4 dígitos + "Letras" + 4 letras + "Serie" + N + "Folio" + N
//      - "SEGUNDO PREMIO" + 4 dígitos
//      - "TERCER PREMIO" + 4 dígitos
//
// 2. https://www.laestrella.com.pa  ← FALLBACK 1 (publica el mismo día)
//    URL diaria: /panama/nacional/en-vivo-loteria-nacional-de-panama-resultados-del-sorteo-de-este-{DD-DE-MMM-DE-YYYY}
//
// 3. https://www.tvn-2.com  ← FALLBACK 2 (transmisión oficial del sorteo)
//    URL: /la-loteria/resultados-sorteo-loteria-{dia}-{DD}-{mmm}-{YYYY}-hoy_*.html
//
// 4. https://elcomercio.pe (sección Lotería de Panamá)  ← FALLBACK 3
//
// 5. https://www.panamaloteria.com  ← FALLBACK 4 (sitio especializado, HTML simple)
//
// ⚠️ NUNCA usar suerteloteria.com — esa fuente está desactualizada y cerrada.
//
// El Worker debe responder con JSON:
//   {
//     "recientes": [ { tipo, sorteoN, fecha, premios: [{pos, num, letras?, serie?, folio?}] } ],
//     "historial": [ ... ]
//   }
//
// Cron recomendado: 16:00, 17:00, 18:00, 20:00 UTC (~11:00, 12:00, 13:00, 15:00 hora Panamá,
// suficientes intentos para captar sorteos que se publican entre 15:30 y 18:00)
// ═══════════════════════════════════════════════════════════════════════
async function cargarSorteosAutomaticos() {
  if (!UPDATER_URL || UPDATER_URL.includes("AJUSTAR")) return false;
  try {
    const response = await fetch(`${UPDATER_URL}/sorteos`, {
      method: "GET",
      signal: AbortSignal.timeout(5000) // 5 seg timeout
    });
    if (!response.ok) return false;
    const data = await response.json();

    // Actualizar SORTEOS_RECIENTES si hay datos del Worker
    if (Array.isArray(data.recientes) && data.recientes.length > 0) {
      // Convertir formato Worker → formato UI
      const mapTipoColor = {
        DOMINICAL: { icon: "🌟", color: "#F4C430", bg: "rgba(244,196,48,.1)", border: "rgba(244,196,48,.28)", premioMayor: "$100,000", frecuencia: "Cada domingo" },
        MIERCOLITO: { icon: "⚡", color: "#3B9EFF", bg: "rgba(59,158,255,.1)", border: "rgba(59,158,255,.28)", premioMayor: "$100,000", frecuencia: "Cada miércoles" },
        GORDITO: { icon: "🍀", color: "#00D68F", bg: "rgba(0,214,143,.1)", border: "rgba(0,214,143,.28)", premioMayor: "$1,004,000", frecuencia: "Último viernes del mes" },
        EXTRAORDINARIA: { icon: "💎", color: "#A78BFA", bg: "rgba(167,139,250,.1)", border: "rgba(167,139,250,.28)", premioMayor: "$1,000,000", frecuencia: "Fecha especial" },
      };

      // MEZCLAR: para cada tipo, mantener el más reciente entre Worker y SEED
      // Esto evita que desaparezca GORDITO y EXTRAORDINARIA cuando el Worker solo devuelve DOMINICAL/MIERCOLITO
      const recientesPorTipo = {};

      // Primero inicializar con los datos seed (todos los tipos)
      for (const s of SORTEOS_RECIENTES_SEED) {
        recientesPorTipo[s.tipo] = s;
      }

      // Luego sobrescribir con datos del Worker si son más recientes
      for (const s of data.recientes) {
        const style = mapTipoColor[s.tipo] || mapTipoColor.DOMINICAL;
        const fechaLarga = convertirFechaLarga(s.fecha);
        const nuevoRecord = {
          tipo: s.tipo,
          icon: style.icon,
          color: style.color,
          bg: style.bg,
          border: style.border,
          sorteoN: s.sorteoN,
          fecha: fechaLarga,
          premios: s.premios.map(p => ({
            pos: p.pos === "1er" ? "1er Premio" : p.pos === "2do" ? "2do Premio" : p.pos === "3er" ? "3er Premio" : p.pos,
            num: p.num,
            letras: p.letras || "",
            serie: p.serie || "",
            folio: p.folio || "",
          })),
          premioMayor: style.premioMayor,
          proximoISO: null,
          frecuencia: style.frecuencia,
        };

        // Solo sobrescribir si el Worker tiene un sorteoN mayor (más reciente)
        const seedDelTipo = recientesPorTipo[s.tipo];
        if (!seedDelTipo || parseInt(s.sorteoN) >= parseInt(seedDelTipo.sorteoN)) {
          recientesPorTipo[s.tipo] = nuevoRecord;
        }
      }

      // Reemplazar el array manteniendo el orden: Miercolito, Dominical, Gordito, Extraordinaria
      SORTEOS_RECIENTES.length = 0;
      const ordenTipos = ["MIERCOLITO", "DOMINICAL", "GORDITO", "EXTRAORDINARIA"];
      for (const tipo of ordenTipos) {
        if (recientesPorTipo[tipo]) SORTEOS_RECIENTES.push(recientesPorTipo[tipo]);
      }
    }

    // Agregar sorteos nuevos al HISTORIAL (sin duplicar)
    if (Array.isArray(data.historial)) {
      const existentes = new Set(HISTORIAL.map(h => `${h.tipo}-${h.sorteoN}`));
      for (const s of data.historial) {
        const key = `${s.tipo}-${s.sorteoN}`;
        if (!existentes.has(key)) {
          HISTORIAL.unshift(s); // agregar al inicio (más reciente)
          existentes.add(key);
        }
      }
    }

    console.log(`✅ Sorteos actualizados automáticamente desde ${UPDATER_URL}`);
    // Disparar evento global para que componentes React se re-rendericen
    if (typeof window !== 'undefined') {
      window.__sorteosVersion = (window.__sorteosVersion || 0) + 1;
      window.dispatchEvent(new CustomEvent('sorteos-actualizados', {
        detail: { version: window.__sorteosVersion }
      }));
    }
    return true;
  } catch (err) {
    console.warn("No se pudieron cargar sorteos automáticos:", err.message);
    return false;
  }
}

function convertirFechaLarga(fechaCorta) {
  // "22 Abr 2026" → "22 de abril de 2026"
  const meses = { Ene:"enero", Feb:"febrero", Mar:"marzo", Abr:"abril", May:"mayo", Jun:"junio", Jul:"julio", Ago:"agosto", Sep:"septiembre", Oct:"octubre", Nov:"noviembre", Dic:"diciembre" };
  const m = String(fechaCorta).match(/(\d+)\s+(\w+)\s+(\d+)/);
  if (!m) return fechaCorta;
  return `${parseInt(m[1])} de ${meses[m[2]] || m[2].toLowerCase()} de ${m[3]}`;
}

/* ── Sub-componente Historial (necesita sus propios hooks) ── */
function HistorialTab({ tipoF, setTipoF, cols }) {
  const MESES=["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"];
  const allAnios=[...new Set(HISTORIAL.map(h=>h.anio))].sort((a,b)=>b-a);
  const allMeses=[...new Set(HISTORIAL.map(h=>h.mes))].sort((a,b)=>a-b);
  const [mesF,setMesF]=useState(0);
  const [anioF,setAnioF]=useState(0);

  const filtered=HISTORIAL.filter(h=>{
    const mt=tipoF==="TODOS"||h.tipo===tipoF;
    const mm=mesF===0||h.mes===mesF;
    const my=anioF===0||h.anio===anioF;
    return mt&&mm&&my;
  });

  return <>
    <div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>
      Sorteos históricos · Fuente: <strong style={{color:"var(--text)"}}>lnb.gob.pa</strong>
    </div>

    {/* Filtro tipo */}
    <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:4,scrollbarWidth:"none",marginBottom:8}}>
      <button className={`chip ${tipoF==="TODOS"?"on":""}`} style={{flexShrink:0}} onClick={()=>setTipoF("TODOS")}>Todos</button>
      {Object.entries(TIPO_META).filter(([k])=>k!=="ZODIACAL" && k!=="DEFAULT").map(([k,v])=>(
        <button key={k} className={`chip ${tipoF===k?"on":""}`} style={{flexShrink:0}} onClick={()=>setTipoF(k)}>
          {v.icon} {k}
        </button>
      ))}
    </div>

    {/* Filtros Mes y Año */}
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
      <div>
        <div style={{fontSize:9,color:"var(--muted)",fontWeight:800,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>Mes</div>
        <div style={{position:"relative"}}>
          <select value={mesF} onChange={e=>setMesF(Number(e.target.value))}
            style={{width:"100%",background:"var(--bg2)",border:"1.5px solid var(--border)",borderRadius:11,padding:"9px 12px 9px 12px",color:mesF===0?"var(--muted)":"var(--text)",fontFamily:"'DM Sans'",fontSize:12,fontWeight:600,outline:"none",appearance:"none",cursor:"pointer"}}>
            <option value={0}>Todos los meses</option>
            {allMeses.map(m=><option key={m} value={m}>{MESES[m-1]}</option>)}
          </select>
          <div style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%) rotate(90deg)",pointerEvents:"none"}}>
            <Ic n="chevR" s={12} c="var(--muted)" sw={2.5}/>
          </div>
        </div>
      </div>
      <div>
        <div style={{fontSize:9,color:"var(--muted)",fontWeight:800,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>Año</div>
        <div style={{position:"relative"}}>
          <select value={anioF} onChange={e=>setAnioF(Number(e.target.value))}
            style={{width:"100%",background:"var(--bg2)",border:"1.5px solid var(--border)",borderRadius:11,padding:"9px 12px",color:anioF===0?"var(--muted)":"var(--text)",fontFamily:"'DM Sans'",fontSize:12,fontWeight:600,outline:"none",appearance:"none",cursor:"pointer"}}>
            <option value={0}>Todos los años</option>
            {allAnios.map(a=><option key={a} value={a}>{a}</option>)}
          </select>
          <div style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%) rotate(90deg)",pointerEvents:"none"}}>
            <Ic n="chevR" s={12} c="var(--muted)" sw={2.5}/>
          </div>
        </div>
      </div>
    </div>

    {/* Reset + conteo */}
    {(tipoF!=="TODOS"||mesF!==0||anioF!==0)&&(
      <button onClick={()=>{setTipoF("TODOS");setMesF(0);setAnioF(0);}}
        style={{background:"rgba(255,75,110,.07)",border:"1px solid rgba(255,75,110,.18)",borderRadius:9,padding:"5px 12px",color:"var(--red)",fontSize:11,fontWeight:700,cursor:"pointer",marginBottom:10,fontFamily:"'DM Sans'"}}>
        ✕ Limpiar · {filtered.length} resultado{filtered.length!==1?"s":""}
      </button>
    )}

    {filtered.length===0?(
      <div style={{textAlign:"center",padding:"28px 0"}}>
        <div style={{fontSize:36,marginBottom:8}}>📭</div>
        <div style={{fontSize:13,fontWeight:700,color:"var(--text)",marginBottom:3}}>Sin resultados</div>
        <div style={{fontSize:11,color:"var(--muted)"}}>Prueba con otro mes, año o tipo</div>
      </div>
    ):filtered.map((h,i)=>{
      const m=TIPO_META[h.tipo] || TIPO_META.DEFAULT;
      return (
        <div key={`${h.tipo}-${h.sorteoN}-${h.fecha}-${i}`} className="card" style={{marginBottom:9,borderLeft:`3px solid ${m.color}`}}>
          <div className="row" style={{justifyContent:"space-between",marginBottom:8}}>
            <div>
              <div className="row" style={{gap:6}}>
                <span style={{fontFamily:"'Bebas Neue'",fontSize:14,color:m.color,letterSpacing:2}}>{m.icon} {h.tipo}</span>
                <span style={{fontSize:9,fontWeight:800,color:"var(--muted)",background:"var(--bg3)",borderRadius:5,padding:"2px 5px"}}>#{h.sorteoN}</span>
              </div>
              <div style={{fontSize:10,color:"var(--muted)",marginTop:1}}>📅 {h.fecha}</div>
            </div>
            <span className="badge" style={{background:`${m.color}12`,color:m.color,border:`1px solid ${m.color}28`,fontSize:8}}>Oficial ✓</span>
          </div>
          <div style={{display:"flex",gap:6}}>
            {h.premios.map((p,pi)=>(
              <div key={p.pos} style={{flex:1,background:"rgba(8,17,31,.5)",borderRadius:8,padding:"6px 3px",textAlign:"center"}}>
                <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,marginBottom:2}}>{p.pos}</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:p.num?.length>4?12:17,color:cols[pi].c,letterSpacing:1,lineHeight:1}}>{p.num||"—"}</div>
                {p.letras&&<div style={{fontSize:7,color:m.color,fontWeight:800,marginTop:1}}>{p.letras} S{p.serie}F{p.folio}</div>}
              </div>
            ))}
          </div>
        </div>
      );
    })}
    <div style={{textAlign:"center",padding:"8px 0 4px"}}>
      <div style={{fontSize:10,color:"var(--muted)"}}>
        {filtered.length} sorteo{filtered.length!==1?"s":""} · lnb.gob.pa
      </div>
    </div>
  </>;
}
const TIPO_META = {
  MIERCOLITO:     { icon:"⚡", color:"#3B9EFF" },
  DOMINICAL:      { icon:"🌟", color:"#F4C430" },
  GORDITO:        { icon:"🍀", color:"#00D68F" },
  EXTRAORDINARIA: { icon:"💎", color:"#A78BFA" },
  ZODIACAL:       { icon:"🍀", color:"#00D68F" }, // Alias de GORDITO
  DEFAULT:        { icon:"🎲", color:"#9DB3CC" }, // Fallback para tipos desconocidos
};

function ResultadosScreen({ initTab="resultados" }) {
  const [tab,setTab]=useState(initTab);
  const [q,setQ]=useState("");
  const [scanned,setScanned]=useState(false);
  const [verifResult,setVerifResult]=useState(null);
  const [cameraActive,setCameraActive]=useState(false);
  const [cameraError,setCameraError]=useState("");
  const [scannerLoading,setScannerLoading]=useState(false);
  const [notif,setNotif]=useState(true);
  const [tipoF,setTipoF]=useState("TODOS");
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const detectorRef = useRef(null);
  const scanIntervalRef = useRef(null);

  const cols=[
    {c:"var(--gold)",bg:"rgba(244,196,48,.12)",bc:"rgba(244,196,48,.35)"},
    {c:"var(--blue)",bg:"rgba(59,158,255,.1)",bc:"rgba(59,158,255,.3)"},
    {c:"var(--green)",bg:"rgba(0,214,143,.1)",bc:"rgba(0,214,143,.3)"},
  ];

  /* ╔══════════════════════════════════════════════════════════════╗
     ║  DECODIFICADOR DE CÓDIGOS DE BARRAS LNB                      ║
     ║                                                               ║
     ║  BILLETE (Dominical/Miercolito) — 19 dígitos:                ║
     ║  [1-4] Sorteo · [5-6] Serie · [7-10] Número · [11-12] Folio  ║
     ║  [13-15] Control · [16-19] Fracción                          ║
     ║  Ejemplo: 5542 18 2583 13 230 2400                           ║
     ║                                                               ║
     ║  BILLETE ESPECIAL (Sorteo de Oro) — 20 dígitos:              ║
     ║  [1-4] Sorteo · [5-6] Serie · [7-10] Número · [11-12] Folio  ║
     ║  [13-16] Control · [17-20] Fracción                          ║
     ║  Ejemplo: 5542 12 9327 09 3086 9995                          ║
     ║                                                               ║
     ║  CHANCE — 16 dígitos:                                        ║
     ║  [1-4] Sorteo · [5-8] Serie · [9-10] Número · [11-12] Folio  ║
     ║  [13-16] Control                                              ║
     ║  Ejemplo: 4050 4298 24 07 0834                               ║
     ╚══════════════════════════════════════════════════════════════╝ */
  const decodificarCodigo = (codigo) => {
    const clean = codigo.replace(/\D/g, "");

    // BILLETE ESPECIAL (Sorteo de Oro, Gordito, etc.) — 20 dígitos
    if (clean.length === 20) {
      return {
        tipo: "BILLETE",
        subtipo: "ESPECIAL",
        sorteo: clean.substring(0, 4),
        serie: clean.substring(4, 6),
        numero: clean.substring(6, 10),
        folio: clean.substring(10, 12),
        control: clean.substring(12, 16),
        fraccion: clean.substring(16, 20),
        raw: clean,
      };
    }

    // BILLETE estándar — 19 dígitos
    if (clean.length === 19) {
      return {
        tipo: "BILLETE",
        subtipo: "ESTANDAR",
        sorteo: clean.substring(0, 4),
        serie: clean.substring(4, 6),
        numero: clean.substring(6, 10),
        folio: clean.substring(10, 12),
        control: clean.substring(12, 15),
        fraccion: clean.substring(15, 19),
        raw: clean,
      };
    }

    // CHANCE — 16 dígitos
    if (clean.length === 16) {
      return {
        tipo: "CHANCE",
        sorteo: clean.substring(0, 4),
        serie: clean.substring(4, 8),
        numero: clean.substring(8, 10),
        folio: clean.substring(10, 12),
        control: clean.substring(12, 16),
        raw: clean,
      };
    }

    // Fallback: si el código tiene al menos 4 dígitos, extraer primer sorteo
    if (clean.length >= 4) {
      return {
        tipo: "DESCONOCIDO",
        sorteo: clean.substring(0, 4),
        numero: clean.length >= 10 ? clean.substring(6, 10) : clean.substring(0, 4),
        raw: clean,
      };
    }

    return null;
  };

  /* ╔══════════════════════════════════════════════════════════════╗
     ║  CALCULADORA DE PREMIOS                                       ║
     ║  Compara el número escaneado con los sorteos recientes       ║
     ╚══════════════════════════════════════════════════════════════╝ */
  const calcularPremio = (decoded, numeroManual) => {
    // Si no viene decoded, usar número manual contra todos los sorteos
    const numero = decoded?.numero || numeroManual;
    if (!numero) return null;

    let mejorMatch = null;

    // Buscar primero en SORTEOS_RECIENTES (datos completos con colores/estilos)
    // Luego en HISTORIAL (convertido al mismo formato)
    const HISTORIAL_COMO_SORTEOS = HISTORIAL.map(h => {
      const base = SORTEOS_RECIENTES.find(s => s.tipo === h.tipo) || SORTEOS_RECIENTES[0];
      return {
        tipo: h.tipo,
        icon: base.icon,
        color: base.color,
        bg: base.bg,
        border: base.border,
        sorteoN: h.sorteoN,
        fecha: h.fecha,
        premios: h.premios.map(p => ({
          pos: p.pos === "1er" ? "1er Premio" : p.pos === "2do" ? "2do Premio" : p.pos === "3er" ? "3er Premio" : p.pos,
          num: p.num,
          letras: p.letras || "",
          serie: p.serie || "",
          folio: p.folio || "",
        })),
        premioMayor: base.premioMayor,
        frecuencia: base.frecuencia,
      };
    });

    // Si el billete tiene sorteoN específico, priorizar ese sorteo
    let fuentesBusqueda;
    if (decoded?.sorteo) {
      const exacto = [...SORTEOS_RECIENTES, ...HISTORIAL_COMO_SORTEOS].find(s => s.sorteoN === decoded.sorteo);
      if (exacto) {
        fuentesBusqueda = [exacto];
      } else {
        fuentesBusqueda = [...SORTEOS_RECIENTES, ...HISTORIAL_COMO_SORTEOS];
      }
    } else {
      fuentesBusqueda = [...SORTEOS_RECIENTES, ...HISTORIAL_COMO_SORTEOS];
    }

    for (const sorteo of fuentesBusqueda) {
      const esChance = decoded?.tipo === "CHANCE" || (!decoded && numero.length === 2);

      for (let i = 0; i < sorteo.premios.length; i++) {
        const p = sorteo.premios[i];
        const premioNum = p.num;

        let match = false;
        let tipoPremio = "";
        let montoPremio = 0;

        if (esChance) {
          const ult2 = premioNum.slice(-2).padStart(2, "0");
          const numN = numero.slice(-2).padStart(2, "0");
          if (ult2 === numN) {
            match = true;
            tipoPremio = `${p.pos} (Chance)`;
            if (i === 0) montoPremio = 14;
            else if (i === 1) montoPremio = 3;
            else if (i === 2) montoPremio = 2;
          }
        } else {
          if (premioNum === numero) {
            match = true;
            if (decoded?.serie === p.serie && decoded?.folio === p.folio) {
              tipoPremio = `${p.pos} con Serie y Folio`;
              if (i === 0) montoPremio = 2000;
              else if (i === 1) montoPremio = 600;
              else montoPremio = 300;
            } else {
              tipoPremio = `${p.pos} (4 cifras)`;
              if (i === 0) montoPremio = 200;
              else if (i === 1) montoPremio = 50;
              else montoPremio = 30;
            }
          } else if (premioNum.slice(-3) === numero.slice(-3)) {
            match = true;
            tipoPremio = "Aproximación 3 cifras";
            montoPremio = 5;
          } else if (premioNum.slice(-2) === numero.slice(-2) && i === 0) {
            match = true;
            tipoPremio = "Últimas 2 cifras del 1er premio";
            montoPremio = 2;
          }
        }

        if (match) {
          if (!mejorMatch || montoPremio > mejorMatch.monto) {
            mejorMatch = {
              sorteo: sorteo,
              posicion: i,
              premio: p,
              tipoPremio: tipoPremio,
              monto: montoPremio,
            };
          }
        }
      }
    }

    return mejorMatch;
  };

  /* ╔══════════════════════════════════════════════════════════════╗
     ║  CÁMARA — Activar/Desactivar con soporte robusto móvil       ║
     ║  Fix para Samsung Chrome: setTimeout + onloadedmetadata      ║
     ╚══════════════════════════════════════════════════════════════╝ */
  const [needsTap, setNeedsTap] = useState(false); // Estado: si autoplay falló

  const activarCamara = async () => {
    setCameraError("");
    setScannerLoading(true);
    setNeedsTap(false);

    try {
      if (window.location.protocol !== "https:" && window.location.hostname !== "localhost") {
        throw new Error("La cámara requiere HTTPS.");
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error("Tu navegador no soporta acceso a la cámara. Usa Chrome o Safari actualizado.");
      }

      // Intentar con cámara trasera primero
      let stream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" } },
          audio: false
        });
      } catch (e) {
        // Fallback: cualquier cámara disponible
        console.warn("Cámara trasera falló, usando cualquiera:", e);
        stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      }

      streamRef.current = stream;
      setCameraActive(true);
      setScannerLoading(false);
    } catch (err) {
      setScannerLoading(false);
      let msg = "No se pudo acceder a la cámara.";
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        msg = "Permiso de cámara denegado. Abre Configuración → Sitios → " + window.location.hostname + " → Cámara → Permitir.";
      } else if (err.name === "NotFoundError") {
        msg = "No se encontró cámara en este dispositivo.";
      } else if (err.name === "NotReadableError") {
        msg = "La cámara está siendo usada por otra app. Cierra apps con cámara (WhatsApp, Zoom, etc.) e intenta de nuevo.";
      } else if (err.message) {
        msg = err.message;
      }
      setCameraError(msg);
    }
  };

  // Conectar el stream al <video> — se ejecuta después que React renderiza el elemento
  useEffect(() => {
    if (!cameraActive) return;

    // Esperar a que el DOM esté actualizado (doble RAF para garantía en móvil)
    let cancelled = false;
    let rafId;

    const conectar = () => {
      if (cancelled) return;
      const vid = videoRef.current;
      const stream = streamRef.current;
      if (!vid || !stream) {
        // Reintentar en el próximo frame si aún no están listos
        rafId = requestAnimationFrame(conectar);
        return;
      }

      // Atributos CRÍTICOS para móviles (iOS + Android Chrome)
      vid.muted = true;
      vid.defaultMuted = true;
      vid.playsInline = true;
      vid.setAttribute("muted", "");
      vid.setAttribute("playsinline", "");
      vid.setAttribute("webkit-playsinline", "");
      vid.setAttribute("autoplay", "");

      // Asignar stream
      vid.srcObject = stream;

      // Cuando el video tenga metadata (dimensiones), intentar reproducir
      const onMeta = () => {
        const playPromise = vid.play();
        if (playPromise) {
          playPromise
            .then(() => setNeedsTap(false))
            .catch(err => {
              console.warn("play() rechazado:", err);
              setNeedsTap(true); // Mostrar botón "Toca para activar"
            });
        }
      };

      // Escuchar cuando esté listo
      vid.addEventListener("loadedmetadata", onMeta, { once: true });

      // También intentar reproducir ya (por si metadata ya está disponible)
      if (vid.readyState >= 1) onMeta();

      // Cuando empiece a reproducirse, iniciar detección de códigos
      const onPlaying = () => {
        if ("BarcodeDetector" in window && !detectorRef.current) {
          try {
            detectorRef.current = new window.BarcodeDetector({
              formats: ["code_128", "ean_13", "itf", "code_39"]
            });
            iniciarEscaneo();
          } catch (e) {
            console.warn("BarcodeDetector no disponible:", e);
          }
        }
      };
      vid.addEventListener("playing", onPlaying, { once: true });
    };

    rafId = requestAnimationFrame(conectar);

    return () => {
      cancelled = true;
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [cameraActive]);

  // Función para iniciar play manualmente (si autoplay falló)
  const playVideoManual = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.play()
      .then(() => setNeedsTap(false))
      .catch(err => {
        console.error("Play manual falló:", err);
        setCameraError("No se pudo reproducir el video: " + err.message);
      });
  };

  const iniciarEscaneo = () => {
    if (scanIntervalRef.current) clearInterval(scanIntervalRef.current);
    scanIntervalRef.current = setInterval(async () => {
      if (!videoRef.current || !detectorRef.current) return;
      try {
        const barcodes = await detectorRef.current.detect(videoRef.current);
        if (barcodes.length > 0) {
          const codigo = barcodes[0].rawValue;
          procesarCodigo(codigo);
        }
      } catch (e) {}
    }, 500);
  };

  const desactivarCamara = () => {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraActive(false);
    detectorRef.current = null;
  };

  // Limpiar al desmontar
  useEffect(() => () => desactivarCamara(), []);

  const procesarCodigo = (codigoRaw) => {
    desactivarCamara();
    const decoded = decodificarCodigo(codigoRaw);
    const premio = calcularPremio(decoded, null);
    setQ(decoded?.numero || codigoRaw);
    setVerifResult({ decoded, premio, rawCode: codigoRaw });
    setScanned(true);
  };

  const verificarManual = () => {
    if (!q.trim()) return;
    const clean = q.trim().replace(/\D/g, "");
    const decoded = decodificarCodigo(clean);
    const premio = calcularPremio(decoded, clean);
    setVerifResult({ decoded, premio, rawCode: clean });
    setScanned(true);
  };

  const resetVerif = () => {
    setScanned(false);
    setVerifResult(null);
    setQ("");
    setCameraError("");
  };

  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:2,marginBottom:4}}>SORTEOS</div>
      <div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>Lotería Nacional de Beneficencia · lnb.gob.pa</div>
      <div className="tabs">
        {["resultados","historial","verificar"].map(t=>(
          <button key={t} className={`tab ${tab===t?"on":""}`} style={{textTransform:"capitalize"}} onClick={()=>{ setTab(t); if(t!=="verificar") desactivarCamara(); }}>{t}</button>
        ))}
      </div>

      {/* ── RESULTADOS RECIENTES ── */}
      {tab==="resultados"&&<>
        <div className="card" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
          <div className="row" style={{gap:9}}>
            <div style={{width:32,height:32,borderRadius:9,background:"rgba(244,196,48,.1)",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="bell" s={14} c="var(--gold)"/></div>
            <div><div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>Alertas de sorteos</div><div style={{fontSize:10,color:"var(--muted)"}}>Resultados al instante</div></div>
          </div>
          <button className="tog" style={{background:notif?"var(--gold)":"var(--bg3)",border:`1px solid ${notif?"var(--gold)":"var(--border)"}`}} onClick={()=>setNotif(!notif)}>
            <div className="tgt" style={{left:notif?23:3}}/>
          </button>
        </div>
        {SORTEOS_RECIENTES.map(s=>(
          <div key={s.tipo} className="sort-card" style={{background:s.bg,borderColor:s.border,marginBottom:10}}>
            <div style={{position:"absolute",right:-20,top:-20,width:80,height:80,borderRadius:"50%",background:s.bg}}/>
            <div className="row" style={{justifyContent:"space-between",marginBottom:10}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:s.color,letterSpacing:3}}>{s.icon} {s.tipo}</div>
                <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>{s.fecha} · Sorteo Nº {s.sorteoN}</div>
              </div>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase"}}>Premio Mayor</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:s.color,letterSpacing:1}}>{s.premioMayor}</div>
              </div>
            </div>
            <div style={{display:"flex",gap:7}}>
              {s.premios.map((p,pi)=>(
                <div key={p.pos} style={{flex:1,background:"rgba(8,17,31,.4)",borderRadius:9,padding:"7px 3px",textAlign:"center"}}>
                  <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{p.pos}</div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:p.num.length>4?13:17,color:cols[pi].c,letterSpacing:1,lineHeight:1}}>{p.num}</div>
                  {p.letras&&<div style={{fontSize:8,color:s.color,fontWeight:800,marginTop:1,letterSpacing:.4}}>{p.letras}</div>}
                  {p.serie&&<div style={{fontSize:7,color:"var(--muted)",marginTop:1}}>S{p.serie} F{p.folio}</div>}
                </div>
              ))}
            </div>
          </div>
        ))}
        <div style={{background:"rgba(59,158,255,.07)",border:"1px solid rgba(59,158,255,.18)",borderRadius:11,padding:"9px 12px",display:"flex",gap:8,alignItems:"center"}}>
          <Ic n="info" s={14} c="var(--blue)"/>
          <span style={{fontSize:10,color:"var(--muted)"}}>Fuente oficial: <strong style={{color:"var(--text)"}}>lnb.gob.pa</strong> · Sorteos a las 3:00 PM hora Panamá</span>
        </div>
      </>}

      {/* ── HISTORIAL ── */}
      {tab==="historial"&&<HistorialTab tipoF={tipoF} setTipoF={setTipoF} cols={cols}/>}

      {/* ══ VERIFICAR ══ Con cámara real y decodificador LNB */}
      {tab==="verificar"&&<>
        {!scanned && (
          <>
            {/* Scanner area */}
            <div style={{background:"var(--bg2)",border:"1px solid var(--border)",borderRadius:16,padding:cameraActive?0:16,textAlign:"center",marginBottom:12,overflow:"hidden"}}>
              {!cameraActive && (
                <>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text)",marginBottom:3}}>🎯 Escanea tu billete o chance</div>
                  <div style={{fontSize:10,color:"var(--muted)",marginBottom:12}}>Coloca el código de barras frente a la cámara</div>
                  <button onClick={activarCamara} disabled={scannerLoading}
                    style={{width:"100%",padding:"15px",borderRadius:14,border:"none",background:scannerLoading?"rgba(255,204,51,.4)":"linear-gradient(135deg,#FFCC33,#D4A218)",color:"#08101E",fontFamily:"'DM Sans',sans-serif",fontWeight:800,fontSize:14,cursor:scannerLoading?"default":"pointer",boxShadow:"0 4px 20px rgba(255,204,51,.35)",display:"flex",alignItems:"center",justifyContent:"center",gap:10,marginBottom:12}}>
                    {scannerLoading ? (
                      <>
                        <div style={{width:16,height:16,border:"3px solid rgba(8,16,30,.3)",borderTopColor:"#08101E",borderRadius:"50%",animation:"spin .7s linear infinite"}}/>
                        Activando cámara…
                      </>
                    ) : (
                      <>📷 Abrir cámara</>
                    )}
                  </button>
                  <div className="scanframe"><div className="scanline"/>
                    {[["top:0,left:0","borderRight:none,borderBottom:none"],["top:0,right:0","borderLeft:none,borderBottom:none"],["bottom:0,left:0","borderRight:none,borderTop:none"],["bottom:0,right:0","borderLeft:none,borderTop:none"]].map(([pos,br],i)=>(
                      <div key={i} style={{position:"absolute",...Object.fromEntries(pos.split(",").map(p=>p.split(":"))),width:16,height:16,border:"3px solid var(--gold)",...Object.fromEntries(br.split(",").map(b=>b.split(":")))}}/>
                    ))}
                  </div>
                </>
              )}
              {cameraActive && (
                <div style={{position:"relative",background:"#000",minHeight:320}}>
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    muted
                    onClick={playVideoManual}
                    style={{
                      width:"100%",
                      height:"auto",
                      minHeight:320,
                      maxHeight:"65vh",
                      display:"block",
                      objectFit:"cover",
                      background:"#000"
                    }}
                  />
                  {/* Overlay: "Toca para activar" si autoplay falló */}
                  {needsTap && (
                    <div onClick={playVideoManual}
                      style={{position:"absolute",inset:0,background:"rgba(0,0,0,.6)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",zIndex:5}}>
                      <div style={{fontSize:48,marginBottom:10}}>▶️</div>
                      <div style={{color:"#fff",fontSize:14,fontWeight:700}}>Toca aquí para activar la cámara</div>
                    </div>
                  )}
                  {/* Overlay del frame de escaneo */}
                  <div style={{position:"absolute",top:"50%",left:"50%",transform:"translate(-50%,-50%)",width:"80%",height:"40%",border:"3px solid rgba(255,204,51,.8)",borderRadius:12,boxShadow:"0 0 0 9999px rgba(0,0,0,.4)",pointerEvents:"none"}}>
                    <div style={{position:"absolute",left:0,right:0,top:"50%",height:2,background:"#FFCC33",boxShadow:"0 0 10px #FFCC33",animation:"scanlineMove 2s ease-in-out infinite"}}/>
                  </div>
                  <button onClick={desactivarCamara}
                    style={{position:"absolute",top:10,right:10,width:36,height:36,borderRadius:"50%",background:"rgba(0,0,0,.7)",border:"1px solid rgba(255,255,255,.2)",color:"#fff",fontSize:18,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",zIndex:10}}>✕</button>
                  <div style={{position:"absolute",bottom:10,left:"50%",transform:"translateX(-50%)",background:"rgba(0,0,0,.7)",color:"#fff",padding:"6px 14px",borderRadius:20,fontSize:10,fontWeight:600,zIndex:6}}>
                    {"BarcodeDetector" in window ? "🔍 Buscando código…" : "ℹ️ Ingresa código manualmente abajo"}
                  </div>
                </div>
              )}
            </div>
            <style>{`@keyframes scanlineMove{0%,100%{top:10%}50%{top:85%}}`}</style>

            {cameraError && (
              <div style={{background:"rgba(255,90,120,.1)",border:"1px solid rgba(255,90,120,.3)",borderRadius:11,padding:"12px 14px",fontSize:12,color:"var(--red)",marginBottom:12,lineHeight:1.5}}>
                ⚠️ {cameraError}
              </div>
            )}

            {/* Input manual */}
            <div style={{fontSize:10,color:"var(--muted)",marginBottom:8,textAlign:"center"}}>O ingresa el número manualmente:</div>
            <div className="row" style={{gap:7,marginBottom:10}}>
              <input className="inp" placeholder="Número o código completo (16 o 19 dígitos)" value={q}
                onChange={e=>setQ(e.target.value)}
                onKeyDown={e=>{if(e.key==="Enter")verificarManual();}}
                style={{flex:1}}/>
              <button className="btn-sm" onClick={verificarManual}>
                <Ic n="search" s={14} c="#08111F"/>
              </button>
            </div>

            {/* Guía de formatos */}
            <div style={{background:"rgba(59,158,255,.05)",border:"1px solid rgba(59,158,255,.18)",borderRadius:11,padding:"11px 13px",marginTop:10}}>
              <div style={{fontSize:10,fontWeight:800,color:"var(--blue)",letterSpacing:.8,marginBottom:6}}>📖 FORMATOS DE CÓDIGO</div>
              <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.6}}>
                • <strong style={{color:"var(--text)"}}>CHANCE</strong> (16 dígitos)<br/>
                • <strong style={{color:"var(--text)"}}>BILLETE</strong> estándar (19 dígitos)<br/>
                • <strong style={{color:"var(--text)"}}>BILLETE ESPECIAL</strong> (20 dígitos) — Sorteo de Oro, Gordito<br/>
                • <strong style={{color:"var(--text)"}}>NÚMERO CORTO</strong> (2 ó 4 dígitos)
              </div>
            </div>
          </>
        )}

        {/* RESULTADO VERIFICACIÓN */}
        {scanned && verifResult && (
          <div className="pop">
            {/* Resultado principal: Ganador o No ganador */}
            {verifResult.premio ? (
              <div style={{background:"linear-gradient(135deg,rgba(0,214,143,.15),rgba(0,214,143,.04))",border:"2px solid rgba(0,214,143,.4)",borderRadius:18,padding:20,textAlign:"center",marginBottom:12}}>
                <div style={{fontSize:48,marginBottom:6}}>🏆</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:36,color:"var(--green)",letterSpacing:4,marginBottom:4,lineHeight:1}}>¡GANADOR!</div>
                <div style={{fontSize:11,color:"var(--muted)",marginBottom:10}}>{verifResult.premio.tipoPremio}</div>
                <div style={{background:"rgba(8,17,31,.5)",borderRadius:12,padding:"12px 22px",display:"inline-block",marginBottom:10}}>
                  <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,marginBottom:2}}>GANASTE</div>
                  <div style={{fontFamily:"'Bebas Neue'",fontSize:42,color:"var(--gold)",letterSpacing:2,lineHeight:1}}>${verifResult.premio.monto.toLocaleString()}</div>
                  <div style={{fontSize:9,color:"var(--muted)",marginTop:2}}>por dólar apostado</div>
                </div>
                <div style={{fontSize:11,color:"var(--text)",fontWeight:600,marginBottom:3}}>
                  {verifResult.premio.sorteo.icon} {verifResult.premio.sorteo.tipo} Nº{verifResult.premio.sorteo.sorteoN}
                </div>
                <div style={{fontSize:10,color:"var(--muted)"}}>{verifResult.premio.sorteo.fecha}</div>
              </div>
            ) : (
              <div style={{background:"linear-gradient(135deg,rgba(147,173,204,.1),rgba(147,173,204,.03))",border:"2px solid rgba(147,173,204,.3)",borderRadius:18,padding:20,textAlign:"center",marginBottom:12}}>
                <div style={{fontSize:44,marginBottom:6}}>😔</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:28,color:"var(--muted)",letterSpacing:2,marginBottom:4,lineHeight:1}}>No ganador</div>
                <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.5}}>
                  Este número no coincide con ningún premio de los sorteos recientes.<br/>
                  <strong style={{color:"var(--text)"}}>¡Sigue intentando, la próxima puede ser tuya!</strong>
                </div>
              </div>
            )}

            {/* Detalle del billete/chance escaneado */}
            {verifResult.decoded && (
              <div style={{background:"var(--bg2)",border:"1px solid var(--border)",borderRadius:14,padding:"14px",marginBottom:12}}>
                <div style={{fontSize:11,fontWeight:800,color:"var(--gold)",letterSpacing:1,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>
                  📋 DETALLE DEL {verifResult.decoded.tipo}
                </div>
                {[
                  ["📝 Tipo",verifResult.decoded.tipo],
                  ["🎲 Sorteo Nº",verifResult.decoded.sorteo],
                  ["📘 Serie",verifResult.decoded.serie],
                  ["🔢 Número jugado",verifResult.decoded.numero],
                  ["📑 Folio",verifResult.decoded.folio],
                  verifResult.decoded.fraccion ? ["🎟 Fracción",verifResult.decoded.fraccion] : null,
                  ["🔐 Código de Control",verifResult.decoded.control],
                ].filter(Boolean).map(([l,v])=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"7px 0",borderBottom:"1px solid var(--border)"}}>
                    <span style={{fontSize:11,color:"var(--muted)"}}>{l}</span>
                    <span style={{fontSize:12,fontWeight:700,color:"var(--text)",fontFamily:"'Bebas Neue'",letterSpacing:1}}>{v}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Detalle del sorteo que está siendo consultado (SIEMPRE visible) */}
            {(() => {
              // Determinar QUÉ sorteo mostrar:
              // 1) Si ganó → el sorteo donde ganó (match exacto)
              // 2) Si escaneó billete/chance → buscar el sorteoN exacto en registros
              // 3) Si no hay match exacto → mostrar mensaje de "sorteo no disponible"
              let sorteoMostrar = null;
              let posicionGanadora = -1;
              let esSorteoNoDisponible = false;
              let sorteoNumeroSolicitado = null;

              if (verifResult.premio) {
                sorteoMostrar = verifResult.premio.sorteo;
                posicionGanadora = verifResult.premio.posicion;
              } else if (verifResult.decoded && verifResult.decoded.sorteo) {
                sorteoNumeroSolicitado = verifResult.decoded.sorteo;
                // Buscar primero en sorteos recientes
                sorteoMostrar = SORTEOS_RECIENTES.find(s => s.sorteoN === sorteoNumeroSolicitado);

                // Si no está en recientes, buscar en HISTORIAL
                if (!sorteoMostrar) {
                  const histMatch = HISTORIAL.find(h => h.sorteoN === sorteoNumeroSolicitado);
                  if (histMatch) {
                    const base = SORTEOS_RECIENTES.find(s => s.tipo === histMatch.tipo) || SORTEOS_RECIENTES[0];
                    sorteoMostrar = {
                      tipo: histMatch.tipo,
                      icon: base.icon,
                      color: base.color,
                      bg: base.bg,
                      border: base.border,
                      sorteoN: histMatch.sorteoN,
                      fecha: histMatch.fecha,
                      premios: histMatch.premios.map(p => ({
                        pos: p.pos === "1er" ? "1er Premio" : p.pos === "2do" ? "2do Premio" : p.pos === "3er" ? "3er Premio" : p.pos,
                        num: p.num,
                        letras: p.letras || "",
                        serie: p.serie || "",
                        folio: p.folio || "",
                      })),
                      premioMayor: base.premioMayor,
                      frecuencia: base.frecuencia,
                    };
                  } else {
                    esSorteoNoDisponible = true;
                  }
                }
              } else {
                // Número manual sin estructura decoded → sorteo más reciente
                sorteoMostrar = SORTEOS_RECIENTES[0];
              }

              // Caso: sorteo solicitado no está en registros
              if (esSorteoNoDisponible) {
                return (
                  <div style={{background:"rgba(59,158,255,.07)",border:"1px solid rgba(59,158,255,.25)",borderRadius:14,padding:"16px",marginBottom:12,textAlign:"center"}}>
                    <div style={{fontSize:32,marginBottom:6}}>📭</div>
                    <div style={{fontSize:13,fontWeight:800,color:"var(--blue)",letterSpacing:.8,marginBottom:6}}>
                      SORTEO Nº {sorteoNumeroSolicitado}
                    </div>
                    <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.6,marginBottom:12}}>
                      No tenemos los resultados de este sorteo en nuestros registros recientes.
                      <br/>Verifica en el sitio oficial:
                    </div>
                    <a href="https://www.lnb.gob.pa" target="_blank" rel="noopener noreferrer"
                      style={{display:"inline-block",padding:"10px 18px",background:"rgba(59,158,255,.15)",border:"1px solid rgba(59,158,255,.4)",borderRadius:10,color:"var(--blue)",fontSize:12,fontWeight:700,textDecoration:"none"}}>
                      🌐 lnb.gob.pa
                    </a>
                  </div>
                );
              }

              if (!sorteoMostrar) return null;

              return (
                <div style={{background:sorteoMostrar.bg,border:`1px solid ${sorteoMostrar.border}`,borderRadius:14,padding:"14px",marginBottom:12}}>
                  <div style={{fontSize:11,fontWeight:800,color:sorteoMostrar.color,letterSpacing:1,marginBottom:10}}>
                    🎰 SORTEO {sorteoMostrar.tipo} Nº{sorteoMostrar.sorteoN}
                  </div>
                  <div style={{fontSize:10,color:"var(--muted)",marginBottom:10}}>
                    {sorteoMostrar.fecha} · {sorteoMostrar.frecuencia}
                  </div>
                  <div style={{display:"flex",gap:7,marginBottom:8}}>
                    {sorteoMostrar.premios.map((p,pi)=>(
                      <div key={p.pos} style={{
                        flex:1,
                        background:"rgba(8,17,31,.4)",
                        borderRadius:9,
                        padding:"8px 3px",
                        textAlign:"center",
                        border: pi===posicionGanadora ? `2px solid ${sorteoMostrar.color}` : "1px solid transparent",
                        boxShadow: pi===posicionGanadora ? `0 0 12px ${sorteoMostrar.color}60` : "none"
                      }}>
                        <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>{p.pos}</div>
                        <div style={{fontFamily:"'Bebas Neue'",fontSize:p.num.length>4?14:18,color:cols[pi].c,letterSpacing:1,lineHeight:1}}>{p.num}</div>
                        {p.letras&&<div style={{fontSize:8,color:sorteoMostrar.color,fontWeight:800,marginTop:1}}>{p.letras}</div>}
                        {p.serie&&<div style={{fontSize:7,color:"var(--muted)",marginTop:1}}>S{p.serie} F{p.folio}</div>}
                      </div>
                    ))}
                  </div>
                  <div style={{background:"rgba(8,17,31,.3)",borderRadius:8,padding:"8px 10px",display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:8}}>
                    <span style={{fontSize:9,color:"var(--muted)",fontWeight:700,textTransform:"uppercase"}}>Premio Mayor</span>
                    <span style={{fontFamily:"'Bebas Neue'",fontSize:18,color:sorteoMostrar.color,letterSpacing:1}}>{sorteoMostrar.premioMayor}</span>
                  </div>
                </div>
              );
            })()}

            {/* Botones */}
            <div style={{display:"flex",gap:8}}>
              <button onClick={resetVerif}
                style={{flex:1,padding:"12px",borderRadius:12,border:"1px solid var(--border)",background:"var(--bg2)",color:"var(--text)",fontSize:13,fontWeight:700,cursor:"pointer"}}>
                🔄 Verificar otro
              </button>
              {verifResult.premio && (
                <button style={{flex:1,padding:"12px",borderRadius:12,border:"none",background:"linear-gradient(135deg,#00D68F,#00A367)",color:"#08101E",fontSize:13,fontWeight:800,cursor:"pointer"}}>
                  💰 Cómo cobrar
                </button>
              )}
            </div>
          </div>
        )}
      </>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MÓDULO VENDEDOR  ★ con AÑADIR + pestañas separadas
═══════════════════════════════════════════════════════ */
/* ╔══════════════════════════════════════════════════════════════╗
   ║  PANTALLA MI SUERTE — Sueños IA + Análisis Estadístico       ║
   ╚══════════════════════════════════════════════════════════════╝ */
/* ╔══════════════════════════════════════════════════════════════╗
   ║  PANTALLA MI SUERTE — Sueños (IA Claude) + Estadísticas LNB  ║
   ║  - Usa Cloudflare Pages Function como proxy seguro a Gemini  ║
   ║  - Si el API falla, muestra error claro al usuario           ║
   ╚══════════════════════════════════════════════════════════════╝ */

// ─── Componente: lista detallada de apariciones de un número ───
// Muestra cada sorteo donde salió: tipo, fecha, posición (1er/2do/3er) y número completo.
function Apariciones({ num, apariciones = [], GOLD = "#FFCC33", GREEN = "#00E5A0", BLUE = "#4DB5FF" }) {
  const [expanded, setExpanded] = useState(false);
  const VISIBLE_INICIAL = 5;
  const lista = expanded ? apariciones : apariciones.slice(0, VISIBLE_INICIAL);

  // Color por posición de premio
  const colorPos = pos => {
    if (pos === "1er" || pos === "1°") return GOLD;
    if (pos === "2do" || pos === "2°") return BLUE;
    return GREEN;
  };
  // Color por tipo de sorteo (para identificar visualmente)
  const colorTipo = tipo => {
    if (tipo === "MIERCOLITO") return "#3B9EFF";
    if (tipo === "DOMINICAL") return "#F4C430";
    if (tipo === "GORDITO") return "#00D68F";
    if (tipo === "EXTRAORDINARIA") return "#A78BFA";
    return "#9CB8D4";
  };
  const iconoTipo = tipo => {
    if (tipo === "MIERCOLITO") return "⚡";
    if (tipo === "DOMINICAL") return "🌟";
    if (tipo === "GORDITO") return "🍀";
    if (tipo === "EXTRAORDINARIA") return "💎";
    return "🎲";
  };

  if (apariciones.length === 0) {
    return (
      <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px", marginBottom: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)", marginBottom: 8, letterSpacing: .5 }}>
          🗓️ Detalle de apariciones del <span style={{ color: GOLD, fontFamily: "'Bebas Neue',sans-serif", fontSize: 16 }}>{num}</span>
        </div>
        <div style={{ textAlign: "center", padding: "16px 0", opacity: .6 }}>
          <div style={{ fontSize: 28, marginBottom: 6 }}>❄️</div>
          <div style={{ fontSize: 11, color: "var(--muted)" }}>El número {num} no ha salido en el historial registrado</div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px", marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)", letterSpacing: .5 }}>
          🗓️ Detalle de apariciones del <span style={{ color: GOLD, fontFamily: "'Bebas Neue',sans-serif", fontSize: 16 }}>{num}</span>
        </div>
        <span style={{ fontSize: 10, color: "var(--muted)", background: "rgba(255,204,51,.1)", border: "1px solid rgba(255,204,51,.3)", borderRadius: 6, padding: "2px 6px", fontWeight: 700 }}>
          {apariciones.length} {apariciones.length === 1 ? "vez" : "veces"}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {lista.map((a, idx) => (
          <div key={`${a.tipo}-${a.sorteoN}-${idx}`}
            style={{
              display: "flex", gap: 10, alignItems: "center",
              padding: "8px 10px", borderRadius: 9,
              background: "rgba(8,17,31,.4)",
              borderLeft: `3px solid ${colorTipo(a.tipo)}`,
            }}>
            {/* Icono + tipo */}
            <div style={{ width: 38, textAlign: "center", flexShrink: 0 }}>
              <div style={{ fontSize: 18 }}>{iconoTipo(a.tipo)}</div>
              <div style={{ fontSize: 7, fontWeight: 800, color: colorTipo(a.tipo), letterSpacing: .3, marginTop: 1 }}>{a.tipo}</div>
            </div>
            {/* Detalle: fecha + sorteo */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)" }}>{a.fecha}</div>
              <div style={{ fontSize: 9, color: "var(--muted)", marginTop: 1 }}>Sorteo Nº {a.sorteoN}</div>
            </div>
            {/* Premio: posición + número completo */}
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <div style={{
                fontSize: 9, fontWeight: 800, letterSpacing: .5,
                color: colorPos(a.pos),
                background: `${colorPos(a.pos)}20`, border: `1px solid ${colorPos(a.pos)}40`,
                borderRadius: 5, padding: "2px 6px", display: "inline-block", marginBottom: 3,
              }}>
                {a.posLabel}
              </div>
              <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 16, color: colorPos(a.pos), letterSpacing: 1, lineHeight: 1 }}>
                {a.numCompleto}
              </div>
            </div>
          </div>
        ))}
      </div>

      {apariciones.length > VISIBLE_INICIAL && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            width: "100%", marginTop: 10, padding: "8px",
            background: "transparent", border: "1px dashed var(--border)",
            borderRadius: 9, color: "var(--muted)", fontSize: 11, fontWeight: 700,
            cursor: "pointer", fontFamily: "'DM Sans',sans-serif",
          }}>
          {expanded
            ? `▲ Mostrar menos`
            : `▼ Ver las otras ${apariciones.length - VISIBLE_INICIAL} apariciones`}
        </button>
      )}
    </div>
  );
}

function SuerteScreen() {
  const [tab, setTab] = useState("suenos");

  // ── SUEÑOS ──
  const [suenoText, setSuenoText] = useState("");
  const [suenoResult, setSuenoResult] = useState(null);
  const [suenoLoading, setSuenoLoading] = useState(false);
  const [suenoError, setSuenoError] = useState("");

  // ── ESTADÍSTICAS ──
  const [numSelected, setNumSelected] = useState("07");

  // Llamar a la Cloudflare Pages Function que proxea Gemini con prompt Chakatín
  const analizarSueno = async () => {
    if (!suenoText.trim()) {
      setSuenoError("Escribe tu sueño o evento primero.");
      return;
    }
    setSuenoLoading(true);
    setSuenoError("");
    setSuenoResult(null);

    try {
      const resp = await fetch("/api/analizar-sueno", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ texto: suenoText })
      });

      // Diagnóstico por código de respuesta
      if (resp.status === 404) {
        throw new Error(
          "La función de Cloudflare Pages no está desplegada. " +
          "Verifica que exista el archivo functions/api/analizar-sueno.js en el repositorio de GitHub " +
          "y que el deploy de Cloudflare Pages haya sido exitoso."
        );
      }

      if (resp.status === 500) {
        const errData = await resp.json().catch(() => ({}));
        if (errData.error && errData.error.includes("API_KEY")) {
          throw new Error(
            "La variable GEMINI_API_KEY no está configurada en Cloudflare Pages. " +
            "Ve a tu proyecto → Settings → Environment variables → Add variable."
          );
        }
        throw new Error(errData.error || "Error del servidor");
      }

      if (resp.status === 502) {
        const errData = await resp.json().catch(() => ({}));
        let msg = errData.error || "Error desconocido";
        if (errData.debug) {
          msg += " | Detalle: " + errData.debug;
        }
        throw new Error(msg);
      }

      if (!resp.ok) {
        // Si el servidor devuelve cualquier error, dar mensaje amigable
        const errData = await resp.json().catch(() => ({}));
        if (resp.status === 503 || resp.status === 429) {
          throw new Error(
            "El servidor de IA está muy ocupado ahora mismo. Espera unos segundos y vuelve a intentar."
          );
        }
        throw new Error(errData.error || `Error ${resp.status}. Intenta de nuevo en un momento.`);
      }

      const data = await resp.json();

      if (!data.numeros || data.numeros.length !== 3 ||
          !data.explicaciones || data.explicaciones.length !== 3) {
        throw new Error("La IA devolvió una respuesta incompleta. Intenta con otro texto.");
      }

      setSuenoResult(data);
    } catch (err) {
      console.error("Error análisis IA:", err);
      setSuenoError(err.message || "Error desconocido");
    }

    setSuenoLoading(false);
  };

  // ── ANÁLISIS ESTADÍSTICO basado en HISTORIAL real ──
  const calcStats = (num) => {
    // ─── Helper: extrae los chances (terminaciones de 2 dígitos) de un sorteo ───
    // Considera los 3 premios. Para billetes de 4-5 dígitos, los últimos 2 dígitos
    // forman el chance ganador (estándar Lotería Nacional Panamá).
    const extraerChances = (h) => h.premios.flatMap(p => {
      const n = p.num || "";
      if (n.length <= 2) return [n.padStart(2, "0")];
      if (n.length === 4 || n.length === 5) return [n.slice(-2)];
      return [];
    });

    // Total de sorteos en el historial (no chances individuales)
    const total = HISTORIAL.length;
    // Sorteos en los que el número salió como cualquiera de los 3 premios
    const sorteosConMatch = HISTORIAL.filter(h => extraerChances(h).includes(num)).length;

    // ─── Detalle de apariciones: lista de cada PREMIO donde salió este número ───
    // Un mismo sorteo puede aparecer múltiples veces si el chance salió como
    // 1er Y 2do premio, por ejemplo.
    const apariciones = [];
    for (const h of HISTORIAL) {
      h.premios.forEach((p, idx) => {
        const num4 = p.num || "";
        let coincide = false;
        let etiqueta = "";
        if (num4.length <= 2) {
          if (num4.padStart(2, "0") === num) {
            coincide = true;
            etiqueta = num4.padStart(2, "0");
          }
        } else if (num4.length === 4 || num4.length === 5) {
          if (num4.slice(-2) === num) {
            coincide = true;
            etiqueta = num4;
          }
        }
        if (coincide) {
          apariciones.push({
            tipo: h.tipo,
            sorteoN: h.sorteoN,
            fecha: h.fecha,
            mes: h.mes,
            anio: h.anio,
            pos: ["1er", "2do", "3er"][idx] || `${idx+1}°`,
            posLabel: ["1er Premio", "2do Premio", "3er Premio"][idx] || `Premio ${idx+1}`,
            numCompleto: etiqueta,
          });
        }
      });
    }
    // Ordenar de más reciente a más antiguo
    apariciones.sort((a, b) => {
      if (a.anio !== b.anio) return b.anio - a.anio;
      if (a.mes !== b.mes) return b.mes - a.mes;
      return parseInt(b.sorteoN || 0) - parseInt(a.sorteoN || 0);
    });

    // freq = número de premios donde salió (coincide con apariciones.length y con
    // el badge "N veces" de la sección Detalle de apariciones)
    const freq = apariciones.length;
    const pct = total > 0 ? ((sorteosConMatch / total) * 100).toFixed(1) : "0.0";

    let ultimaSalida = null;
    let sorteosSinSalir = 0;
    let encontrado = false;
    for (let i = 0; i < HISTORIAL.length; i++) {
      const h = HISTORIAL[i];
      if (!encontrado) {
        if (extraerChances(h).includes(num)) { ultimaSalida = h.fecha; encontrado = true; }
        else sorteosSinSalir++;
      }
    }

    const ultimos10 = HISTORIAL.filter(h => h.tipo === "GORDITO").slice(0, 10);
    const freq10 = ultimos10.filter(h => extraerChances(h).includes(num)).length;

    const caliente = sorteosSinSalir < 5;
    const probabilidad = Math.min(99, Math.max(1, Math.round(
      (freq10 * 15) + (freq * 2) + (caliente ? 20 : 5) + Math.random() * 10
    )));

    return { freq, total, sorteosConMatch, pct, ultimaSalida, sorteosSinSalir, caliente, probabilidad, freq10, apariciones };
  };

  const stats = calcStats(numSelected);
  const numeros = Array.from({ length: 100 }, (_, i) => i.toString().padStart(2, "0"));

  const GOLD = "#FFCC33"; const GREEN = "#00E5A0"; const RED = "#FF5A78"; const BLUE = "#4DB5FF";

  return (
    <div className="sc fu" style={{ paddingBottom: 20 }}>
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 18 }}>
        <div style={{ fontSize: 28, marginBottom: 4 }}>🔮</div>
        <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, color: GOLD, letterSpacing: 3, lineHeight: 1 }}>MI SUERTE</div>
        <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 3 }}>Sueños · Análisis · Números de la Fortuna</div>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, marginBottom: 18, background: "var(--bg2)", borderRadius: 14, padding: 4, border: "1px solid var(--border)" }}>
        {[
          { id: "suenos", label: "🌙 Sueños & Eventos" },
          { id: "stats",  label: "📊 Estadísticas" },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            flex: 1, padding: "10px 6px", borderRadius: 11, border: "none",
            fontFamily: "'DM Sans',sans-serif", fontWeight: 700, fontSize: 12, cursor: "pointer", transition: "all .2s",
            background: tab === t.id ? "linear-gradient(135deg,#FFCC33,#D4A218)" : "transparent",
            color: tab === t.id ? "#08101E" : "var(--muted)",
            boxShadow: tab === t.id ? "0 2px 12px rgba(255,204,51,.3)" : undefined
          }}>{t.label}</button>
        ))}
      </div>

      {/* ══ TAB SUEÑOS ══ */}
      {tab === "suenos" && (
        <div>
          {/* Intro */}
          <div style={{ background: "rgba(255,204,51,.07)", border: "1px solid rgba(255,204,51,.25)", borderRadius: 16, padding: "14px", marginBottom: 14 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: GOLD, marginBottom: 6 }}>💡 ¿Cómo funciona?</div>
            <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6 }}>
              Describe tu sueño, un evento que viviste o cualquier señal del destino. Nuestra IA Chakatín analizará y te dará tus 3 números según la <strong style={{ color: "var(--text)" }}>tradición panameña del billetero</strong>.
            </div>
          </div>

          {/* Input */}
          <div style={{ marginBottom: 12 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: "#9CB8D4", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
              Cuéntame tu sueño o evento ✍️
            </label>
            <textarea
              value={suenoText}
              onChange={e => setSuenoText(e.target.value)}
              placeholder='Ej: "Soñé con una inundación y vi un perro blanco corriendo"&#10;Ej: "Vi un accidente de un carro azul en la Vía España"&#10;Ej: "Mi abuela difunta me visitó en sueños"'
              rows={5}
              style={{
                display: "block", width: "100%", padding: "14px", boxSizing: "border-box",
                background: "#1A2C48", border: "1.5px solid rgba(255,255,255,.15)",
                borderRadius: 14, color: "#FFFFFF", fontSize: 13,
                fontFamily: "'DM Sans',sans-serif", outline: "none",
                resize: "none", lineHeight: 1.6,
                boxShadow: "inset 0 2px 8px rgba(0,0,0,.2)"
              }}
            />
          </div>

          {suenoError && (
            <div style={{ background: "rgba(255,90,120,.1)", border: "1px solid rgba(255,90,120,.3)", borderRadius: 11, padding: "12px 14px", fontSize: 12, color: RED, marginBottom: 12, lineHeight: 1.5 }}>
              ⚠️ {suenoError}
            </div>
          )}

          {/* Botón analizar */}
          <button onClick={analizarSueno} disabled={suenoLoading} style={{
            width: "100%", padding: "15px", borderRadius: 14, border: "none",
            background: suenoLoading ? "rgba(255,204,51,.4)" : "linear-gradient(135deg,#FFCC33,#D4A218)",
            color: "#08101E", fontFamily: "'DM Sans',sans-serif", fontWeight: 800, fontSize: 15,
            cursor: suenoLoading ? "default" : "pointer",
            boxShadow: "0 4px 20px rgba(255,204,51,.35)", marginBottom: 16,
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8
          }}>
            {suenoLoading ? (
              <>
                <div style={{ width: 18, height: 18, border: "3px solid rgba(8,16,30,.3)", borderTopColor: "#08101E", borderRadius: "50%", animation: "spin .7s linear infinite" }} />
                Consultando a la IA…
              </>
            ) : (
              <>🔮 ¡Descifrar mis números!</>
            )}
          </button>

          {/* Resultado */}
          {suenoResult && (
            <div className="pop">
              <div style={{ background: "linear-gradient(135deg,rgba(255,204,51,.15),rgba(255,204,51,.05))", border: "2px solid rgba(255,204,51,.4)", borderRadius: 18, padding: "18px", marginBottom: 12 }}>
                <div style={{ textAlign: "center", marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 800, color: GOLD, letterSpacing: 1.5, textTransform: "uppercase", marginBottom: 4 }}>✨ Tus Números de la Suerte</div>
                  {suenoResult.elementos?.length > 0 && (
                    <div style={{ fontSize: 10, color: "var(--muted)" }}>
                      Detecté: {suenoResult.elementos.join(" · ")}
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", gap: 10, justifyContent: "center", marginBottom: 16 }}>
                  {(suenoResult.numeros || []).map((n, i) => (
                    <div key={i} style={{
                      width: 72, height: 72, borderRadius: "50%",
                      background: `linear-gradient(135deg,${GOLD},#D4A218)`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      boxShadow: `0 6px 20px rgba(255,204,51,.5)`, flexShrink: 0
                    }}>
                      <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 30, color: "#08101E", letterSpacing: 2, lineHeight: 1 }}>{n}</div>
                    </div>
                  ))}
                </div>
                {(suenoResult.explicaciones || []).map((exp, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8, background: "rgba(255,255,255,.05)", borderRadius: 10, padding: "11px 12px" }}>
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: `${GOLD}25`, border: `1.5px solid ${GOLD}60`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      <span style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 14, color: GOLD }}>{suenoResult.numeros[i]}</span>
                    </div>
                    <div style={{ fontSize: 12, color: "var(--muted)", lineHeight: 1.6, flex: 1 }}>{exp}</div>
                  </div>
                ))}
              </div>
              {suenoResult.frase_motivadora && (
                <div style={{ background: "rgba(0,229,160,.08)", border: "1px solid rgba(0,229,160,.25)", borderRadius: 14, padding: "13px", textAlign: "center", marginBottom: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: GREEN, lineHeight: 1.5 }}>
                    💬 "{suenoResult.frase_motivadora}"
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Guía rápida */}
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#9CB8D4", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 8 }}>📖 Guía rápida — Tradición panameña</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {[["💀 Muerto","48"],["🐍 Serpiente","35"],["🩸 Sangre","07"],["🐟 Pescado","19"],["💧 Agua","14"],["🔥 Fuego","08"],["👶 Bebé","01"],["🐕 Perro","04"],["🚗 Accidente","73"],["💰 Dinero","50"],["🌙 Luna","09"],["☀️ Sol","51"],["👿 Diablo","66"],["🐦 Pájaro","55"]].map(([label, num]) => (
                <div key={num} style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 10, padding: "5px 10px", display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: 11, color: "var(--text)", fontWeight: 600 }}>{label}</span>
                  <span style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 14, color: GOLD, letterSpacing: 1 }}>{num}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ══ TAB ESTADÍSTICAS ══ */}
      {tab === "stats" && (
        <div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 800, color: "#9CB8D4", letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>
              Selecciona tu número de chance (00–99)
            </label>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <div style={{
                width: 80, height: 80, borderRadius: 18, flexShrink: 0,
                background: "linear-gradient(135deg,#FFCC33,#D4A218)",
                display: "flex", alignItems: "center", justifyContent: "center",
                boxShadow: "0 6px 24px rgba(255,204,51,.4)"
              }}>
                <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 40, color: "#08101E", letterSpacing: 3, lineHeight: 1 }}>{numSelected}</div>
              </div>
              <select
                value={numSelected}
                onChange={e => setNumSelected(e.target.value)}
                style={{
                  flex: 1, padding: "13px 16px", background: "#1A2C48",
                  border: "1.5px solid rgba(255,255,255,.15)", borderRadius: 14,
                  color: "#FFFFFF", fontSize: 16, fontFamily: "'Bebas Neue',sans-serif",
                  letterSpacing: 2, outline: "none", appearance: "none", WebkitAppearance: "none"
                }}>
                {numeros.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }}>
            <div style={{
              background: stats.caliente ? "rgba(0,229,160,.1)" : "rgba(77,181,255,.1)",
              border: `1px solid ${stats.caliente ? "rgba(0,229,160,.3)" : "rgba(77,181,255,.3)"}`,
              borderRadius: 14, padding: "14px", textAlign: "center"
            }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>{stats.caliente ? "🔥" : "❄️"}</div>
              <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 18, color: stats.caliente ? GREEN : BLUE, letterSpacing: 1 }}>
                {stats.caliente ? "CALIENTE" : "FRÍO"}
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2, lineHeight: 1.4 }}>
                {stats.caliente ? "Salió recientemente" : "Lleva tiempo sin salir"}
              </div>
            </div>
            <div style={{ background: "rgba(255,204,51,.1)", border: "1px solid rgba(255,204,51,.3)", borderRadius: 14, padding: "14px", textAlign: "center" }}>
              <div style={{ fontSize: 24, marginBottom: 4 }}>🎯</div>
              <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 26, color: GOLD, letterSpacing: 1 }}>{stats.probabilidad}%</div>
              <div style={{ fontSize: 10, color: "var(--muted)", marginTop: 2 }}>Prob. percibida</div>
            </div>
          </div>

          <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px", marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: "var(--text)" }}>Índice de tendencia</div>
              <div style={{ fontFamily: "'Bebas Neue',sans-serif", fontSize: 18, color: GOLD }}>{stats.probabilidad}%</div>
            </div>
            <div style={{ background: "var(--bg3)", borderRadius: 8, height: 12, overflow: "hidden" }}>
              <div style={{
                width: `${stats.probabilidad}%`, height: "100%", borderRadius: 8,
                background: `linear-gradient(90deg,${stats.caliente ? GREEN : BLUE},${GOLD})`,
                transition: "width 1s ease",
                boxShadow: `0 0 10px ${GOLD}60`
              }} />
            </div>
          </div>

          <div style={{ background: "var(--bg2)", border: "1px solid var(--border)", borderRadius: 14, padding: "14px", marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, color: "var(--text)", marginBottom: 12, letterSpacing: .5 }}>📈 Detalle estadístico del número <span style={{ color: GOLD, fontFamily: "'Bebas Neue',sans-serif", fontSize: 16 }}>{numSelected}</span></div>
            {[
              { ic: "🏆", l: "Apariciones como premio", v: `${stats.freq} ${stats.freq === 1 ? "vez" : "veces"}` },
              { ic: "🔢", l: "Sorteos donde salió", v: `${stats.sorteosConMatch} de ${stats.total}` },
              { ic: "📅", l: "Último sorteo que salió", v: stats.ultimaSalida || "No registrado" },
              { ic: "⏳", l: "Sorteos sin aparecer", v: `${stats.sorteosSinSalir} sorteos` },
              { ic: "📊", l: "Tendencia (últimos 10 Gorditos)", v: `${stats.freq10} apariciones` },
              { ic: "🌡️", l: "Temperatura", v: stats.caliente ? "🔥 Número caliente" : "❄️ Número frío" },
            ].map(item => (
              <div key={item.l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 0", borderBottom: "1px solid var(--border)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <span style={{ fontSize: 14 }}>{item.ic}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{item.l}</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: "var(--text)", textAlign: "right", maxWidth: "45%" }}>{item.v}</span>
              </div>
            ))}
          </div>

          {/* ── Detalle de cada aparición histórica (premio + fecha + sorteo) ── */}
          <Apariciones num={numSelected} apariciones={stats.apariciones} GOLD={GOLD} GREEN={GREEN} BLUE={BLUE} />

          <div style={{ background: "rgba(196,168,255,.08)", border: "1px solid rgba(196,168,255,.25)", borderRadius: 14, padding: "14px", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#C4A8FF", letterSpacing: 1, marginBottom: 8 }}>🤖 CONSEJO DEL EXPERTO</div>
            <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
              {stats.caliente
                ? `¡El ${numSelected} está en racha! Salió recientemente ${stats.freq} veces en el historial. Los billeteros dicen que cuando sale, vuelve a salir. ¡Dale!`
                : `El ${numSelected} lleva ${stats.sorteosSinSalir} sorteos sin salir. Según la teoría del "número frío", podría ser el momento perfecto — ¡la probabilidad de que salga aumenta! ¡Atrévete!`
              }
            </div>
          </div>

          <div style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: "#9CB8D4", letterSpacing: 1.2, textTransform: "uppercase", marginBottom: 8 }}>🔥 Números más populares (histórico)</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {["07", "14", "48", "19", "35", "50", "22", "09", "33", "55"].map(n => (
                <button key={n} onClick={() => setNumSelected(n)}
                  style={{
                    width: 42, height: 42, borderRadius: 10, border: `2px solid ${n === numSelected ? GOLD : "rgba(255,255,255,.12)"}`,
                    background: n === numSelected ? "rgba(255,204,51,.15)" : "var(--bg2)",
                    color: n === numSelected ? GOLD : "var(--muted)",
                    fontFamily: "'Bebas Neue',sans-serif", fontSize: 16, letterSpacing: 1,
                    cursor: "pointer", fontWeight: 700
                  }}>{n}</button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── DISCLAIMER ── */}
      <div style={{ marginTop: 20, background: "rgba(147,173,204,.06)", border: "1px solid rgba(147,173,204,.15)", borderRadius: 12, padding: "12px 14px" }}>
        <div style={{ fontSize: 10, color: "var(--muted)", lineHeight: 1.6, textAlign: "center" }}>
          ⚠️ <strong style={{ color: "var(--text)" }}>Aviso Legal:</strong> Los análisis y sugerencias de esta sección son exclusivamente para <strong style={{ color: "var(--text)" }}>entretenimiento y fines recreativos</strong>. No garantizan premios ni predicen resultados reales de la Lotería Nacional de Beneficencia de Panamá. La LNB es un juego de azar. Juega con responsabilidad. Si sientes que el juego te está afectando, llama a la Línea de Ayuda: <strong style={{ color: GOLD }}>800-0400</strong>.
        </div>
      </div>
    </div>
  );
}


function VendedorHome({ authUser=null, billetes=[], setBilletes, chances=[], setChances, orders=[], onApprove, onModify, onApproveReplacement, onRejectReplacement, onCancelByVendor, activeSorteo: propActiveSorteo, setActiveSorteo: propSetActiveSorteo, initTab="tablero", showOnlyTab=null }) {
  const [mainTab, setMainTab] = useState(initTab);
  const [prodTab, setProdTab] = useState("billetes");
  const [showAdd, setShowAdd] = useState(false);
  const [addType, setAddType] = useState("billete");
  const [newNum, setNewNum] = useState("");
  const [newStock, setNewStock] = useState(1);
  const [addSuccess, setAddSuccess] = useState(false);
  // Estado para edición de items en pedidos
  const [editingOrder, setEditingOrder] = useState(null);  // orderId siendo editado
  const [editedItems,  setEditedItems]  = useState([]);    // items editados

  // ── IDENTIDAD DEL VENDEDOR ─────────────────────────────────────────────
  // Cada vendedor tiene su propia identidad basada en su cuenta. Si no
  // hay authUser (modo demo), usamos Carlos Medina V001 como fallback.
  const vendorCode    = authUser?.numeroBilletero || "V001";
  const vendorName    = authUser?.nombre          || "Carlos Medina";
  const vendorUserId  = authUser?.id              || "vendedor_carlos";
  const vendorAddress = authUser?.lugarVende      || "Calle 50, San Francisco";
  const vendorPhone   = authUser?.telefono        || "6111-2233";

  // ── SORTEO ACTIVO DEL VENDEDOR ────────────────────────────────────────────
  // (Se declara temprano porque handleAdd y los filtros del tablero lo necesitan)
  // SORTEOS_VENDEDOR ahora usa los sorteos PRÓXIMOS (no los pasados).
  // El vendedor vende para el sorteo que ESTÁ POR JUGAR, no para uno ya celebrado.
  const SORTEOS_VENDEDOR = ["MIERCOLITO","DOMINICAL","GORDITO","EXTRAORDINARIA"]
    .map(t => getSorteoActivo(t))
    .filter(Boolean);
  const [localSorteo, setLocalSorteo] = useState(SORTEOS_VENDEDOR[0]);
  const activeSorteo    = propActiveSorteo    || localSorteo;
  const setActiveSorteo = propSetActiveSorteo || setLocalSorteo;

  // ─── TRACKING GPS DEL VENDEDOR ───
  // El vendedor envía su ubicación a Firebase mientras está activo.
  // Se usa para que el comprador y el repartidor sepan dónde está exactamente
  // (no la zona estática hardcoded). Si el navegador no tiene permiso GPS,
  // el comprador verá las coords aproximadas del corregimiento del perfil.
  useTrackingUbicacion(vendorUserId, true);

  // ─── SINCRONIZACIÓN DEL SORTEO ACTIVO POR VENDEDOR ───
  // Cada vendedor publica su sorteo activo en su propio path Firebase.
  // Esto permite que cada comprador, al entrar al tablero de un vendedor
  // específico, lea SOLO el sorteo activo de ESE vendedor (no el global).
  const lastSorteoSyncRef = useRef(null);
  useEffect(() => {
    if (!vendorCode || !activeSorteo?.tipo) return;
    const payload = {
      tipo: activeSorteo.tipo,
      sorteoN: activeSorteo.sorteoN || "",
      fecha: activeSorteo.fecha || "",
      at: Date.now(),
    };
    const key = JSON.stringify({tipo: payload.tipo, sorteoN: payload.sorteoN});
    if (key === lastSorteoSyncRef.current) return;
    lastSorteoSyncRef.current = key;
    fbWrite(`vendedor_${vendorCode}/sorteoActivo`, payload);
  }, [vendorCode, activeSorteo?.tipo, activeSorteo?.sorteoN]);

  // ─── AUTO-CLEAR DEL TABLERO AL PASAR LA HORA TOPE ───
  // Lee la configuración del admin (hora tope, ej "15:00"). Si la hora actual
  // ya cruzó esa hora HOY, y todavía hay inventario marcado como del sorteo
  // que ya jugó, lo borra para que el vendedor pueda ingresar el nuevo.
  const [cierreCfg, setCierreCfg] = useState({ horaTope: "15:00", activo: true });
  useEffect(() => {
    let active = true;
    const cargar = async () => {
      try {
        const cfg = await fbRead("admin_cfg");
        if (active && cfg) {
          setCierreCfg({
            horaTope: cfg.cierreHoraTope || "15:00",
            activo:   cfg.cierreActivo !== false,
          });
        }
      } catch(e) {}
    };
    cargar();
    const t = setInterval(cargar, 60000); // refrescar cada minuto
    return () => { active = false; clearInterval(t); };
  }, []);

  // Detectar si ya pasó la hora tope HOY y si el último auto-clear fue ayer
  const ultimoClearKey = `chance_last_clear_${vendorCode}`;
  useEffect(() => {
    if (!cierreCfg.activo) return;
    if (!setBilletes || !setChances) return;
    const checkClear = async () => {
      const ahora = new Date();
      const [hh, mm] = (cierreCfg.horaTope || "15:00").split(":").map(Number);
      const horaTopeMs = new Date(ahora);
      horaTopeMs.setHours(hh, mm, 0, 0);
      // Solo limpiar si: 1) ya pasó la hora tope HOY, 2) no hemos limpiado hoy
      if (ahora.getTime() < horaTopeMs.getTime()) return;
      const hoyStr = ahora.toISOString().split("T")[0]; // "2026-05-07"
      try {
        const r = await window.storage.get(ultimoClearKey);
        const ultimoClearDia = r?.value || null;
        if (ultimoClearDia === hoyStr) return; // ya limpiamos hoy
        // Limpiar inventario del vendedor (solo el del sorteo viejo)
        const sorteoTipoActual = activeSorteo?.tipo;
        if (!sorteoTipoActual) return;
        // Filtrar: borrar items de ESTE vendedor cuyo sorteoN es anterior al actual
        // (el activeSorteo ya es el PRÓXIMO con número incrementado, así que items
        // con sorteoN viejo son los del sorteo que acaba de jugar).
        const sorteoNActual = parseInt(activeSorteo.sorteoN || "0", 10);
        const noEsViejo = item => {
          if ((item.vendorOwnerId || "vendedor_carlos") !== vendorUserId) return true; // no es mío
          if (item.sorteoTipo !== sorteoTipoActual) return true; // otro tipo de sorteo
          const itemN = parseInt(item.sorteoN || "0", 10);
          return itemN >= sorteoNActual; // si es del actual o posterior, mantener
        };
        setBilletes(prev => prev.filter(noEsViejo));
        setChances(prev => prev.filter(noEsViejo));
        await window.storage.set(ultimoClearKey, hoyStr);
        toast(`🔄 Tablero limpiado — Sorteo ${sorteoTipoActual} ya jugó. Ingresa el inventario del próximo.`);
      } catch(e) { console.warn("Auto-clear error:", e); }
    };
    checkClear();
    const t = setInterval(checkClear, 5 * 60 * 1000); // chequear cada 5 min
    return () => clearInterval(t);
  }, [cierreCfg.activo, cierreCfg.horaTope, activeSorteo?.tipo, activeSorteo?.sorteoN, vendorCode, vendorUserId]);

  // Estado del GPS del vendedor — para mostrar un banner si NO se ha podido
  // capturar la ubicación. Sin GPS, el comprador ve un punto incorrecto.
  const [gpsVendedor, setGpsVendedor] = useState({ status: "checking", error: null });
  useEffect(() => {
    if (!navigator.geolocation) {
      setGpsVendedor({ status: "unsupported", error: "GPS no disponible en este dispositivo" });
      return;
    }
    navigator.geolocation.getCurrentPosition(
      () => setGpsVendedor({ status: "ok", error: null }),
      (err) => {
        const msg = err.code === 1 ? "Permiso denegado — habilita ubicación en el navegador"
                   : err.code === 2 ? "Señal GPS no disponible"
                   : err.code === 3 ? "Tiempo de espera excedido"
                   : "Error desconocido de GPS";
        setGpsVendedor({ status: "error", error: msg });
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  // CORRECCIÓN: useEffect (no useState) para sincronizar tab con nav inferior
  useEffect(() => { setMainTab(initTab); }, [initTab]);

  const handleAdd = () => {
    if (!newNum.trim()) return;
    const n = newNum.trim().padStart(addType==="billete"?4:2,"0");
    // Asociamos cada billete/chance al sorteo activo del vendedor para que
    // el comprador SOLO vea los billetes correspondientes al sorteo seleccionado.
    // También etiquetamos con vendorOwnerId para que cada vendedor vea SOLO
    // sus propios items (Israel ≠ Carlos, aunque compartan la lista global).
    const itemMeta = {
      sorteoTipo:    activeSorteo?.tipo || "MIERCOLITO",
      sorteoN:       activeSorteo?.sorteoN || "",
      vendorOwnerId: vendorUserId,
      vendorCode:    vendorCode,
    };
    if (addType==="billete") {
      // Mismo número en sorteos/vendedores diferentes es OK
      const yaExiste = billetes.find(b => b.n===n
        && b.sorteoTipo===itemMeta.sorteoTipo
        && (b.vendorOwnerId||"vendedor_carlos")===vendorUserId);
      if (!yaExiste) setBilletes&&setBilletes(p=>[...p,{n,stock:newStock,sold:0,...itemMeta}]);
    } else {
      const yaExiste = chances.find(c => c.n===n
        && c.sorteoTipo===itemMeta.sorteoTipo
        && (c.vendorOwnerId||"vendedor_carlos")===vendorUserId);
      if (!yaExiste) setChances&&setChances(p=>[...p,{n,stock:newStock,sold:0,...itemMeta}]);
    }
    setNewNum(""); setNewStock(1);
    setAddSuccess(true); setTimeout(()=>{setAddSuccess(false);setShowAdd(false);},1600);
  };

  // ─── Filtrar billetes/chances por sorteo activo + dueño ───
  // Cada vendedor solo ve los items que le pertenecen (etiquetados con
  // vendorOwnerId). Backward-compat: items sin tag se asumen como Carlos.
  const sorteoActivoTipo = activeSorteo?.tipo || "MIERCOLITO";
  const esMio = item => (item.vendorOwnerId || "vendedor_carlos") === vendorUserId;
  const billetesDelSorteo = (billetes||[]).filter(b => esMio(b) && (!b.sorteoTipo || b.sorteoTipo === sorteoActivoTipo));
  const chancesDelSorteo  = (chances ||[]).filter(c => esMio(c) && (!c.sorteoTipo || c.sorteoTipo === sorteoActivoTipo));

  // ── EDICIÓN INLINE DE ITEMS DEL TABLERO ───────────────────────────────────
  // Cuando el vendedor toca un billete/chance, se abre un panel para
  // aumentar stock, reducir stock o eliminar. Sincroniza con Kardex automático.
  const [selectedItem, setSelectedItem] = useState(null); // {n, isChance}
  const [editStock,    setEditStock]    = useState(0);

  const openItemEditor = (item, chanceFlag) => {
    setSelectedItem({ n: item.n, isChance: chanceFlag, sorteoTipo: item.sorteoTipo || sorteoActivoTipo });
    setEditStock(item.stock);
  };
  const closeItemEditor = () => { setSelectedItem(null); setEditStock(0); };

  /** Aumenta el stock del item seleccionado en delta unidades */
  const adjustStock = (delta) => {
    if (!selectedItem) return;
    const { n, isChance: ic, sorteoTipo: st } = selectedItem;
    const updater = arr => arr.map(item => {
      // Solo modificar mi item (mi vendorOwnerId, mi sorteo, mismo número)
      const isMine    = (item.vendorOwnerId || "vendedor_carlos") === vendorUserId;
      const matches   = isMine && item.n === n && (!item.sorteoTipo || item.sorteoTipo === st);
      if (!matches) return item;
      const newStock = Math.max(item.sold, item.stock + delta); // no menor a lo ya vendido
      return { ...item, stock: newStock };
    });
    if (ic) setChances && setChances(updater);
    else    setBilletes && setBilletes(updater);
    setEditStock(s => Math.max(0, s + delta));
  };

  /** Elimina por completo el item del tablero (solo si no se ha vendido nada) */
  const removeItem = () => {
    if (!selectedItem) return;
    const { n, isChance: ic, sorteoTipo: st } = selectedItem;
    const filtrar = arr => arr.filter(item => {
      const isMine    = (item.vendorOwnerId || "vendedor_carlos") === vendorUserId;
      const matches   = isMine && item.n === n && (!item.sorteoTipo || item.sorteoTipo === st);
      if (!matches) return true;            // mantener (no es mío o no es este)
      if (item.sold > 0) return true;        // no eliminar si ya hay ventas
      return false;                           // eliminar
    });
    if (ic) setChances && setChances(filtrar);
    else    setBilletes && setBilletes(filtrar);
    closeItemEditor();
  };

  // Si el item seleccionado ya no existe (eliminado externamente o cambio de sorteo),
  // cerrar el modal limpiamente. Lo hacemos en un effect para no llamar setState durante render.
  useEffect(() => {
    if (!selectedItem) return;
    const arr = selectedItem.isChance ? (chances || []) : (billetes || []);
    const stillExists = arr.find(x =>
      x.n === selectedItem.n &&
      (!x.sorteoTipo || x.sorteoTipo === selectedItem.sorteoTipo)
    );
    if (!stillExists) closeItemEditor();
  }, [selectedItem, billetes, chances]);

  const allItems = prodTab==="billetes"?billetesDelSorteo:chancesDelSorteo;
  const isChance = prodTab==="chances";

  // Pedidos reales del estado compartido (ordenados del más nuevo al más antiguo)
  // Usa createdAtMs numérico; cae al ID como tiebreaker para datos demo sin timestamp
  const sortNew = (a,b)=>{
    const aMs = typeof a.createdAtMs==='number' ? a.createdAtMs : 0;
    const bMs = typeof b.createdAtMs==='number' ? b.createdAtMs : 0;
    if (bMs !== aMs) return bMs - aMs;
    const aId = parseInt((a.id||'').replace(/\D/g,''))||0;
    const bId = parseInt((b.id||'').replace(/\D/g,''))||0;
    return bId - aId;
  };
  // Filtrar solo los pedidos que le pertenecen a ESTE vendedor
  // Backward-compat: pedidos sin vendorUserId se asumen como Carlos
  const esMioOrder = o => (o.vendorUserId || "vendedor_carlos") === vendorUserId;
  const myOrders          = orders.filter(esMioOrder);
  const pendingOrders     = myOrders.filter(o=>o.status==="PENDIENTE").sort(sortNew);
  const replacementOrders = myOrders.filter(o=>o.status==="REEMPLAZO").sort(sortNew);
  const approvedOrders    = myOrders.filter(o=>o.status==="APROBADO").sort(sortNew);
  const allVOrders        = myOrders.filter(o=>["PENDIENTE","REEMPLAZO","MODIFICADO","APROBADO","EN_CAMINO","ENTREGADO","CANCELADO"].includes(o.status)).sort(sortNew);

  // ── SISTEMA DE PLANTILLAS POR SORTEO (Persistent Storage) ────────────────
  // Clave: "plantilla_V001_MIERCOLITO" → {billetes:[...], chances:[...], savedAt:"..."}
  const VENDOR_CODE = vendorCode;
  const storageKey  = tipo => `plantilla_${VENDOR_CODE}_${tipo}`;

  const [templates,     setTemplates]     = useState({});  // {MIERCOLITO:{billetes,chances,savedAt}, ...}
  const [templateState, setTemplateState] = useState("idle"); // "idle"|"saving"|"loading"|"saved"|"loaded"|"error"
  const [showTemplates, setShowTemplates] = useState(false);

  // Cargar todas las plantillas guardadas al montar
  useEffect(() => {
    (async () => {
      const loaded = {};
      for (const s of SORTEOS_VENDEDOR) {
        try {
          const res = await window.storage.get(storageKey(s.tipo));
          if (res?.value) loaded[s.tipo] = JSON.parse(res.value);
        } catch(e) {}
      }
      setTemplates(loaded);
    })();
  }, []);

  // Guardar plantilla del tablero actual para el sorteo activo
  const saveTemplate = async () => {
    setTemplateState("saving");
    const data = {
      billetes: billetes.map(b=>({n:b.n,stock:b.stock})),
      chances:  chances.map(c=>({n:c.n,stock:c.stock})),
      savedAt:  new Date().toLocaleString("es-PA",{day:"2-digit",month:"short",year:"numeric",hour:"2-digit",minute:"2-digit"}),
      sorteoN:  activeSorteo.sorteoN,
    };
    try {
      await window.storage.set(storageKey(activeSorteo.tipo), JSON.stringify(data));
      setTemplates(prev=>({...prev,[activeSorteo.tipo]:data}));
      setTemplateState("saved");
      setTimeout(()=>setTemplateState("idle"), 2500);
    } catch {
      setTemplateState("error");
      setTimeout(()=>setTemplateState("idle"), 2500);
    }
  };

  // Cargar plantilla guardada y reemplazar el tablero actual
  const loadTemplate = async (tipo) => {
    setTemplateState("loading");
    try {
      const res = await window.storage.get(storageKey(tipo));
      if (!res?.value) { setTemplateState("error"); setTimeout(()=>setTemplateState("idle"),2000); return; }
      const data = JSON.parse(res.value);
      // Restablecer sold=0 (nueva temporada)
      setBilletes&&setBilletes(data.billetes.map(b=>({...b,sold:0})));
      setChances &&setChances (data.chances.map(c=>({...c,sold:0})));
      // Cambiar al sorteo correspondiente
      const s = SORTEOS_VENDEDOR.find(x=>x.tipo===tipo);
      if(s) setActiveSorteo(s);
      setTemplateState("loaded");
      setShowTemplates(false);
      setTimeout(()=>setTemplateState("idle"), 2500);
    } catch {
      setTemplateState("error");
      setTimeout(()=>setTemplateState("idle"), 2000);
    }
  };

  // Eliminar plantilla guardada
  const deleteTemplate = async (tipo) => {
    try {
      await window.storage.delete(storageKey(tipo));
      setTemplates(prev=>{ const n={...prev}; delete n[tipo]; return n; });
    } catch(e) {}
  };

  const templateCount = Object.keys(templates).length;
  const hasTemplateForActive = !!templates[activeSorteo.tipo];

  return (
    <div className="sc fu" style={{position:"relative"}}>
      {/* Header */}
      <div className="row" style={{justifyContent:"space-between",marginBottom:10}}>
        <div>
          <div style={{fontSize:10,color:"var(--muted)"}}>Vendedor</div>
          <div className="row" style={{gap:8,alignItems:"center",marginTop:1}}>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:2,lineHeight:1,textTransform:"uppercase"}}>{vendorName}</div>
            <div style={{background:"rgba(244,196,48,.12)",border:"1px solid rgba(244,196,48,.3)",borderRadius:7,padding:"3px 8px",display:"flex",alignItems:"center",gap:4}}>
              <span style={{fontSize:9,color:"var(--muted)",fontWeight:700}}>CÓDIGO</span>
              <span style={{fontFamily:"'Bebas Neue'",fontSize:15,color:"var(--gold)",letterSpacing:1.5,lineHeight:1}}>{vendorCode}</span>
            </div>
          </div>
        </div>
        <button onClick={()=>setShowAdd(true)} style={{padding:"9px 14px",background:"linear-gradient(135deg,var(--gold),var(--gold2))",borderRadius:11,display:"flex",alignItems:"center",gap:6,cursor:"pointer",border:"none",color:"#08111F",fontFamily:"'DM Sans'",fontWeight:800,fontSize:12,boxShadow:"0 3px 14px rgba(244,196,48,.25)"}}>
          <Ic n="plus" s={13} c="#08111F"/> AÑADIR
        </button>
      </div>

      {/* ── SELECTOR DE SORTEO ACTIVO + PLANTILLAS — solo en pantalla Tablero ── */}
      {!showOnlyTab&&(
      <>
      <div style={{marginBottom:14}}>
        <div style={{fontSize:9,color:"var(--muted)",fontWeight:800,letterSpacing:1.5,textTransform:"uppercase",marginBottom:7}}>
          Sorteo activo de tu tablero
        </div>

        {/* Chips de selección rápida */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
          {SORTEOS_VENDEDOR.map(s=>{
            const isActive = activeSorteo.tipo===s.tipo;
            return (
              <button key={s.tipo} onClick={()=>setActiveSorteo(s)}
                style={{display:"flex",alignItems:"center",gap:5,padding:"7px 12px",borderRadius:20,
                  border:`2px solid ${isActive?s.color:"var(--border)"}`,
                  background:isActive?s.bg:"transparent",
                  cursor:"pointer",fontFamily:"'DM Sans'",transition:"all .2s"}}>
                <span style={{fontSize:14}}>{s.icon}</span>
                <div style={{textAlign:"left"}}>
                  <div style={{fontSize:10,fontWeight:800,color:isActive?s.color:"var(--muted)",lineHeight:1,letterSpacing:.3}}>
                    {s.tipo}
                  </div>
                  <div style={{fontSize:8,color:"var(--muted)",marginTop:1}}>{s.frecuencia}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* Card del sorteo activo con countdown */}
        <div style={{borderRadius:14,background:activeSorteo.bg,border:`1px solid ${activeSorteo.border}`,padding:"12px 14px",position:"relative",overflow:"hidden"}}>
          <div style={{position:"absolute",right:-16,top:-16,width:70,height:70,borderRadius:"50%",background:activeSorteo.bg}}/>
          <div className="row" style={{justifyContent:"space-between",marginBottom:activeSorteo.proximoISO?10:0}}>
            <div>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:activeSorteo.color,letterSpacing:2,lineHeight:1}}>
                {activeSorteo.icon} {activeSorteo.tipo}
              </div>
              <div style={{fontSize:9,color:"var(--muted)",marginTop:2}}>
                Sorteo Nº {activeSorteo.sorteoN} · Último: {activeSorteo.fecha}
              </div>
              <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>
                Premio Mayor: <strong style={{color:activeSorteo.color}}>{activeSorteo.premioMayor}</strong>
              </div>
            </div>
            <div style={{textAlign:"right",flexShrink:0}}>
              <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:2}}>Último ganador</div>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:activeSorteo.color,letterSpacing:2,lineHeight:1}}>
                {activeSorteo.premios[0]?.num}
              </div>
              {activeSorteo.premios[0]?.letras&&(
                <div style={{fontSize:9,color:activeSorteo.color,fontWeight:800,letterSpacing:.5}}>
                  {activeSorteo.premios[0].letras}
                </div>
              )}
            </div>
          </div>

          {/* Countdown próximo sorteo */}
          {activeSorteo.proximoISO&&(
            <div style={{paddingTop:8,borderTop:`1px solid ${activeSorteo.border}`}}>
              <div style={{fontSize:8,color:"var(--muted)",fontWeight:800,textTransform:"uppercase",letterSpacing:1,marginBottom:5}}>
                Próximo sorteo · {activeSorteo.frecuencia}
              </div>
              <SorteoCountdown isoDateStr={activeSorteo.proximoISO} color={activeSorteo.color} border={activeSorteo.border}/>
            </div>
          )}

          {/* Nota informativa para el vendedor */}
          <div style={{marginTop:8,background:"rgba(8,17,31,.3)",borderRadius:8,padding:"6px 10px",fontSize:9,color:"var(--muted)"}}>
            Los números de tu tablero aplican para <strong style={{color:activeSorteo.color}}>{activeSorteo.tipo}</strong> · Los compradores verán este sorteo en tu perfil
          </div>
        </div>

        {/* ── PLANTILLAS DE TABLERO ── */}
        <div style={{marginTop:10}}>
          {/* Barra de acciones */}
          <div style={{display:"flex",gap:7,alignItems:"center"}}>
            {/* Guardar plantilla */}
            <button onClick={saveTemplate}
              disabled={templateState==="saving"}
              style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                padding:"9px 10px",borderRadius:11,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:800,fontSize:11,
                border:`1.5px solid ${hasTemplateForActive?"rgba(0,214,143,.4)":"rgba(244,196,48,.4)"}`,
                background:hasTemplateForActive?"rgba(0,214,143,.1)":"rgba(244,196,48,.1)",
                color:hasTemplateForActive?"var(--green)":"var(--gold)",
                opacity:templateState==="saving"?.6:1}}>
              {templateState==="saving" ? "💾 Guardando…"
                : hasTemplateForActive   ? "💾 Actualizar plantilla"
                : "💾 Guardar plantilla"}
              {hasTemplateForActive&&<span style={{fontSize:8,background:"var(--green)",color:"#08111F",borderRadius:6,padding:"1px 5px",fontWeight:900}}>✓</span>}
            </button>

            {/* Cargar / Gestionar */}
            <button onClick={()=>setShowTemplates(true)}
              style={{flex:1,display:"flex",alignItems:"center",justifyContent:"center",gap:6,
                padding:"9px 10px",borderRadius:11,cursor:"pointer",fontFamily:"'DM Sans'",fontWeight:800,fontSize:11,
                border:"1.5px solid rgba(59,158,255,.35)",background:"rgba(59,158,255,.08)",color:"var(--blue)"}}>
              📂 Mis plantillas
              {templateCount>0&&<span style={{fontSize:8,background:"var(--blue)",color:"#fff",borderRadius:6,padding:"1px 5px",fontWeight:900}}>{templateCount}</span>}
            </button>
          </div>

          {/* Feedback de estado */}
          {templateState==="saved"&&(
            <div className="pop" style={{background:"rgba(0,214,143,.1)",border:"1px solid rgba(0,214,143,.28)",borderRadius:10,padding:"8px 12px",marginTop:8,display:"flex",gap:7,alignItems:"center"}}>
              <span style={{fontSize:16}}>✅</span>
              <div>
                <div style={{fontSize:11,fontWeight:800,color:"var(--green)"}}>Plantilla guardada</div>
                <div style={{fontSize:9,color:"var(--muted)"}}>
                  {billetes.length} billetes · {chances.length} chances · {activeSorteo.tipo}
                </div>
              </div>
            </div>
          )}
          {templateState==="loaded"&&(
            <div className="pop" style={{background:"rgba(59,158,255,.1)",border:"1px solid rgba(59,158,255,.28)",borderRadius:10,padding:"8px 12px",marginTop:8,display:"flex",gap:7,alignItems:"center"}}>
              <span style={{fontSize:16}}>📂</span>
              <div>
                <div style={{fontSize:11,fontWeight:800,color:"var(--blue)"}}>Tablero cargado</div>
                <div style={{fontSize:9,color:"var(--muted)"}}>Stock reiniciado a 0 vendidos · listo para nuevo sorteo</div>
              </div>
            </div>
          )}
          {templateState==="error"&&(
            <div style={{background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.28)",borderRadius:10,padding:"8px 12px",marginTop:8,fontSize:10,color:"var(--red)",fontWeight:700}}>
              ⚠️ Error al acceder al almacenamiento. Intenta de nuevo.
            </div>
          )}
        </div>
      </div>

      {/* ═══ MODAL DE PLANTILLAS ═══ */}
      {showTemplates&&(
        <div className="modal-bg" onClick={()=>setShowTemplates(false)}>
          <div className="modal pop" onClick={e=>e.stopPropagation()} style={{maxHeight:"80vh",display:"flex",flexDirection:"column"}}>
            {/* Header modal */}
            <div className="row" style={{justifyContent:"space-between",marginBottom:16,flexShrink:0}}>
              <div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"var(--gold)",letterSpacing:2}}>MIS PLANTILLAS</div>
                <div style={{fontSize:10,color:"var(--muted)"}}>Tableros guardados por sorteo</div>
              </div>
              <button onClick={()=>setShowTemplates(false)} style={{background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:9,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                <Ic n="close" s={14} c="var(--muted)"/>
              </button>
            </div>

            {/* Lista de plantillas guardadas */}
            <div style={{overflowY:"auto",flex:1}}>
              {SORTEOS_VENDEDOR.map(s=>{
                const tpl = templates[s.tipo];
                return (
                  <div key={s.tipo} className="card" style={{marginBottom:9,border:tpl?`1px solid ${s.color}40`:"1px solid var(--border)",background:tpl?s.bg:"var(--bg2)"}}>
                    <div className="row" style={{justifyContent:"space-between",marginBottom:tpl?8:0}}>
                      <div className="row" style={{gap:8,alignItems:"center"}}>
                        <div style={{width:36,height:36,borderRadius:10,background:tpl?`${s.color}20`:"var(--bg3)",border:`1px solid ${tpl?s.color+"40":"var(--border)"}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
                          {s.icon}
                        </div>
                        <div>
                          <div style={{fontWeight:800,fontSize:12,color:tpl?s.color:"var(--muted)"}}>{s.tipo}</div>
                          <div style={{fontSize:9,color:"var(--muted)"}}>{s.frecuencia}</div>
                        </div>
                      </div>
                      {tpl
                        ? <span style={{fontSize:9,fontWeight:800,color:"var(--green)",background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.25)",borderRadius:8,padding:"2px 7px"}}>✓ Guardada</span>
                        : <span style={{fontSize:9,color:"var(--muted)"}}>Sin plantilla</span>
                      }
                    </div>

                    {tpl&&(
                      <>
                        {/* Resumen de la plantilla */}
                        <div style={{display:"flex",gap:8,marginBottom:8}}>
                          <div style={{flex:1,background:"rgba(8,17,31,.4)",borderRadius:8,padding:"6px 9px",textAlign:"center"}}>
                            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"var(--gold)",letterSpacing:1}}>{tpl.billetes?.length||0}</div>
                            <div style={{fontSize:8,color:"var(--muted)",fontWeight:700}}>BILLETES</div>
                          </div>
                          <div style={{flex:1,background:"rgba(8,17,31,.4)",borderRadius:8,padding:"6px 9px",textAlign:"center"}}>
                            <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:"var(--blue)",letterSpacing:1}}>{tpl.chances?.length||0}</div>
                            <div style={{fontSize:8,color:"var(--muted)",fontWeight:700}}>CHANCES</div>
                          </div>
                          <div style={{flex:2,background:"rgba(8,17,31,.4)",borderRadius:8,padding:"6px 9px"}}>
                            <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,marginBottom:2}}>GUARDADA</div>
                            <div style={{fontSize:9,color:"var(--text)",fontWeight:600,lineHeight:1.3}}>{tpl.savedAt}</div>
                          </div>
                        </div>

                        {/* Preview de números */}
                        <div style={{marginBottom:9}}>
                          <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Billetes</div>
                          <div style={{display:"flex",gap:4,flexWrap:"wrap",marginBottom:6}}>
                            {(tpl.billetes||[]).map(b=>(
                              <span key={b.n} style={{fontFamily:"'Bebas Neue'",fontSize:13,color:"var(--gold)",background:"rgba(244,196,48,.1)",border:"1px solid rgba(244,196,48,.2)",borderRadius:6,padding:"2px 6px",letterSpacing:1}}>
                                {b.n} <span style={{fontSize:9,color:"var(--muted)"}}>×{b.stock}</span>
                              </span>
                            ))}
                          </div>
                          <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:4}}>Chances</div>
                          <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                            {(tpl.chances||[]).map(c=>(
                              <span key={c.n} style={{fontFamily:"'Bebas Neue'",fontSize:13,color:"var(--blue)",background:"rgba(59,158,255,.1)",border:"1px solid rgba(59,158,255,.2)",borderRadius:6,padding:"2px 6px",letterSpacing:1}}>
                                #{c.n} <span style={{fontSize:9,color:"var(--muted)"}}>×{c.stock}</span>
                              </span>
                            ))}
                          </div>
                        </div>

                        {/* Botones acción */}
                        <div style={{display:"flex",gap:7}}>
                          <button onClick={()=>deleteTemplate(s.tipo)}
                            style={{padding:"7px 10px",background:"rgba(255,75,110,.08)",border:"1px solid rgba(255,75,110,.22)",borderRadius:9,color:"var(--red)",fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                            🗑 Eliminar
                          </button>
                          <button onClick={()=>loadTemplate(s.tipo)}
                            style={{flex:1,padding:"9px 12px",background:`${s.color}18`,border:`1.5px solid ${s.color}50`,borderRadius:10,color:s.color,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                            {templateState==="loading"?"⏳ Cargando…":"📂 Cargar este tablero"}
                          </button>
                        </div>
                      </>
                    )}

                    {/* Sin plantilla — invitar a guardar */}
                    {!tpl&&(
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:6,lineHeight:1.5}}>
                        Selecciona {s.tipo} y arma tu tablero, luego toca <strong style={{color:"var(--gold)"}}>💾 Guardar plantilla</strong> para guardarlo aquí.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Footer con instrucción */}
            <div style={{marginTop:12,background:"rgba(244,196,48,.06)",borderRadius:10,padding:"9px 12px",flexShrink:0}}>
              <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.6}}>
                Al <strong style={{color:"var(--gold)"}}>cargar</strong> una plantilla, los vendidos se reinician a 0 para que puedas comenzar fresco en el nuevo sorteo. Los números y cantidades se conservan exactamente como los guardaste.
              </div>
            </div>
          </div>
        </div>
      )}

      </>
      )}

      {/* Stats + info — solo en Tablero y Pedidos, no en Kardex puro */}
      {showOnlyTab!=="kardex"&&(
      <>
      {/* Stats + reemplazos banner — solo en pestaña Pedidos */}
      {mainTab==="pedidos" && (
      <>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7,marginBottom:12}}>
        {[
          {v:String(pendingOrders.length),                                         l:"⏳ Nuevos"},
          {v:String(replacementOrders.length),                                     l:"🔄 Reemplazos"},
          {v:String(approvedOrders.length),                                        l:"✅ Aprobados"},
          {v:String(myOrders.filter(o=>o.status==="ENTREGADO").length),              l:"📦 Entregados"},
        ].map(s=>(
          <div key={s.l} className="stat"><div className="sval">{s.v}</div><div className="slbl">{s.l}</div></div>
        ))}
      </div>
      {replacementOrders.length>0&&(
        <div style={{background:"rgba(59,158,255,.07)",border:"1px solid rgba(59,158,255,.25)",borderRadius:11,padding:"8px 13px",display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
          <Ic n="refresh" s={14} c="var(--blue)"/>
          <span style={{fontSize:11,color:"var(--muted)"}}>
            <strong style={{color:"var(--blue)"}}>{replacementOrders.length} reemplazo(s)</strong> propuesto(s) por el cliente — requieren tu aprobación
          </span>
        </div>
      )}
      </>
      )}
      {/* Banner GPS — solo si hay error o falta permiso */}
      {(gpsVendedor.status === "error" || gpsVendedor.status === "unsupported") && (
        <div style={{background:"rgba(255,75,110,.07)",border:"1px solid rgba(255,75,110,.3)",borderRadius:11,padding:"10px 13px",display:"flex",gap:9,marginBottom:10,alignItems:"flex-start"}}>
          <span style={{fontSize:16}}>⚠️</span>
          <div style={{fontSize:11,color:"var(--text)",lineHeight:1.5}}>
            <strong style={{color:"var(--red)"}}>GPS no disponible.</strong> Sin GPS, los compradores no verán tu ubicación correcta en el mapa. {gpsVendedor.error}
            <br/>
            <button onClick={()=>{
              navigator.geolocation.getCurrentPosition(
                ()=>{setGpsVendedor({status:"ok",error:null}); toast("✅ GPS activado");},
                (err)=>toast("❌ "+(err.code===1?"Permiso denegado":"GPS error")),
                { enableHighAccuracy:true, timeout:10000 }
              );
            }} style={{marginTop:6,padding:"5px 10px",background:"rgba(255,204,51,.1)",border:"1px solid rgba(255,204,51,.4)",borderRadius:7,color:"var(--gold)",fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
              📍 Activar GPS
            </button>
          </div>
        </div>
      )}
      <div style={{background:"rgba(244,196,48,.06)",border:"1px solid rgba(244,196,48,.18)",borderRadius:11,padding:"8px 13px",display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
        <Ic n="info" s={14} c="var(--gold)"/>
        <span style={{fontSize:11,color:"var(--muted)"}}>
          La comisión del <strong style={{color:"var(--gold)"}}>2.5%</strong> se descuenta de tu liquidación. El cliente paga un service fee de $1.00 separado.
        </span>
      </div>

      {/* Alert agotados */}
      <div style={{background:"rgba(255,75,110,.06)",border:"1px solid rgba(255,75,110,.2)",borderRadius:11,padding:"8px 13px",display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
        <span style={{fontSize:14}}>⚠️</span>
        <span style={{fontSize:11,color:"var(--red)",fontWeight:700}}>
          {(billetes||[]).filter(b=>esMio(b) && b.sold>=b.stock).length} billetes y {(chances||[]).filter(c=>esMio(c) && c.sold>=c.stock).length} chances agotados
        </span>
      </div>
      </>
      )}

      {/* Tabs principales */}
      <div className="tabs">
        {["tablero","kardex","pedidos"].map(t=>(
          <button key={t} className={`tab ${mainTab===t?"on":""}`} style={{textTransform:"capitalize"}} onClick={()=>setMainTab(t)}>{t}</button>
        ))}
      </div>

      {/* Sub-tabs Billetes / Chances (para tablero y kardex) */}
      {(mainTab==="tablero"||mainTab==="kardex")&&(
        <div style={{display:"flex",gap:7,marginBottom:12}}>
          {[
            {id:"billetes",icon:"🎟️",label:"Billetes",sub:"4 cifras · $1.00",color:"var(--gold)"},
            {id:"chances", icon:"⚡", label:"Chances", sub:"2 cifras · $0.25",color:"var(--blue)"},
          ].map(t=>(
            <button key={t.id} onClick={()=>setProdTab(t.id)} style={{flex:1,padding:"9px 7px",borderRadius:12,border:`2px solid ${prodTab===t.id?t.color:"var(--border)"}`,background:prodTab===t.id?`${t.color}10`:"var(--bg2)",cursor:"pointer",textAlign:"center",fontFamily:"'DM Sans'",transition:"all .2s"}}>
              <div style={{fontSize:12,fontWeight:800,color:prodTab===t.id?t.color:"var(--muted)"}}>{t.icon} {t.label}</div>
              <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>{t.sub}</div>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:14,color:t.color,marginTop:2,letterSpacing:1}}>
                {(t.id==="billetes"?billetes:chances).filter(i=>i.sold<i.stock).length} disponibles
              </div>
            </button>
          ))}
        </div>
      )}

      {/* TABLERO */}
      {mainTab==="tablero"&&(
        <div style={{display:"grid",gridTemplateColumns:isChance?"repeat(5,1fr)":"repeat(4,1fr)",gap:7}}>
          {allItems.map(item=>{
            const av=item.stock-item.sold;
            return (
              <div key={item.n}
                onClick={()=>openItemEditor(item, isChance)}
                style={{borderRadius:11,padding:"9px 4px",background:av===0?"rgba(110,133,158,.05)":`${isChance?"rgba(59,158,255,.08)":"rgba(244,196,48,.08)"}`,border:`1.5px solid ${av===0?"rgba(110,133,158,.12)":isChance?"rgba(59,158,255,.26)":"rgba(244,196,48,.26)"}`,textAlign:"center",opacity:av===0?.38:1,cursor:"pointer"}}>
                <div style={{fontSize:8,color:isChance?"var(--blue)":"var(--gold)",fontWeight:800}}>{isChance?"⚡":"🎟"}</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:isChance?19:16,color:"var(--text)",letterSpacing:1,lineHeight:1,marginTop:1}}>{item.n}</div>
                <div style={{fontSize:8,color:av===0?"var(--red)":isChance?"var(--blue)":"var(--green)",fontWeight:800,marginTop:2}}>
                  {av===0?"AGOT":isChance?`${av} und`:`${av}/${item.stock}`}
                </div>
              </div>
            );
          })}
          {/* Botón añadir en tablero */}
          <div style={{borderRadius:11,padding:"9px 4px",background:"transparent",border:"1.5px dashed var(--border)",textAlign:"center",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"pointer",minHeight:62,opacity:.6}} onClick={()=>setShowAdd(true)}>
            <Ic n="plus" s={16} c="var(--muted)"/>
            <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,marginTop:3}}>Añadir</div>
          </div>
        </div>
      )}

      {/* KARDEX */}
      {mainTab==="kardex"&&(
        <div className="card" style={{padding:"4px 13px"}}>
          <div style={{display:"grid",gridTemplateColumns:"1.8fr 1fr 1fr 1.6fr",gap:6,padding:"7px 0",borderBottom:"1px solid var(--border)",marginBottom:3}}>
            {["Número","Stock","Vendido","Disponible / Stock"].map(h=><div key={h} style={{fontSize:8,color:"var(--muted)",fontWeight:800,textTransform:"uppercase",lineHeight:1.3}}>{h}</div>)}
          </div>
          {allItems.map(item=>{
            const av=item.stock-item.sold;
            const pct=item.stock>0?(av/item.stock)*100:0;
            return (
              <div key={item.n}
                onClick={()=>openItemEditor(item, isChance)}
                style={{display:"grid",gridTemplateColumns:"1.8fr 1fr 1fr 1.6fr",gap:6,alignItems:"center",padding:"8px 0",borderBottom:"1px solid var(--border)",cursor:"pointer"}}>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:16,color:isChance?"var(--blue)":"var(--gold)",letterSpacing:1}}>
                  {isChance?"⚡":"🎟"} {item.n}
                </div>
                <div style={{fontSize:12,color:"var(--muted)",fontWeight:700}}>{item.stock}</div>
                <div style={{fontSize:12,color:item.sold===item.stock?"var(--red)":"var(--green)",fontWeight:800}}>{item.sold}</div>
                <div>
                  <div style={{fontSize:11,fontWeight:800,color:av===0?"var(--red)":isChance?"var(--blue)":"var(--green)"}}>
                    {av} / {item.stock}
                  </div>
                  <div style={{height:3,background:"rgba(255,255,255,.06)",borderRadius:2,overflow:"hidden",marginTop:3}}>
                    <div style={{height:"100%",width:`${pct}%`,background:av===0?"var(--red)":av/item.stock>0.5?"var(--green)":"var(--gold)",borderRadius:2,transition:"width .4s"}}/>
                  </div>
                </div>
              </div>
            );
          })}
          <div style={{padding:"9px 0",textAlign:"center",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7,opacity:.6}} onClick={()=>setShowAdd(true)}>
            <Ic n="plus" s={14} c="var(--muted)"/>
            <span style={{fontSize:11,color:"var(--muted)",fontWeight:700}}>Añadir {isChance?"chance":"billete"}</span>
          </div>
        </div>
      )}

      {/* PEDIDOS — datos reales del estado compartido */}
      {mainTab==="pedidos"&&(
        <div>
          {allVOrders.length===0?(
            <div style={{textAlign:"center",padding:"32px 0"}}>
              <div style={{fontSize:40,marginBottom:10}}>📭</div>
              <div style={{fontSize:14,fontWeight:700,color:"var(--text)",marginBottom:4}}>Sin pedidos aún</div>
              <div style={{fontSize:11,color:"var(--muted)"}}>Cuando un comprador haga un pedido aparecerá aquí</div>
            </div>
          ):allVOrders.map(o=>{
            const stMap={
              PENDIENTE:   {cls:"by",lbl:"Nuevo"},
              APROBADO:    {cls:"bg",lbl:"Aprobado"},
              MODIFICADO:  {cls:"br",lbl:"Modificado"},
              REEMPLAZO:   {cls:"bb",lbl:"Reemplazo Cliente"},
              EN_CAMINO:   {cls:"bb",lbl:"En camino"},
              ENTREGADO:   {cls:"bg",lbl:"Entregado"},
              CANCELADO:   {cls:"br",lbl:"Cancelado"},
            };
            const st=stMap[o.status]||{cls:"by",lbl:o.status};
            const totals=calcOrderTotals((o.lotteryValue||"1.00"),"2.50","0");
            const itemCount=o.items?.length||1;
            const isEditing=editingOrder===o.id;
            const currentItems=isEditing?editedItems:(o.items||[{type:o.type,num:o.num,qty:o.qty||1,price:o.type==="billete"?1:0.25,subtotal:o.lotteryValue||"1.00"}]);

            return (
              <div key={o.id} className="card" style={{marginBottom:10,border:o.status==="PENDIENTE"?"1px solid rgba(244,196,48,.3)":"1px solid var(--border)"}}>
                {/* Header */}
                <div className="row" style={{justifyContent:"space-between",marginBottom:8}}>
                  <div>
                    <div style={{fontWeight:800,fontSize:12,color:"var(--gold)"}}>{o.id}</div>
                    <div style={{fontSize:10,color:"var(--muted)"}}>{o.createdAt} · {o.paymentMethod==="YAPPY"?"📱 Yappy":"💵 Efectivo"}</div>
                  </div>
                  <div style={{display:"flex",gap:6,alignItems:"center"}}>
                    {itemCount>1&&<span style={{fontSize:9,fontWeight:800,color:"var(--blue)",background:"rgba(59,158,255,.1)",border:"1px solid rgba(59,158,255,.2)",borderRadius:8,padding:"2px 7px"}}>{itemCount} items</span>}
                    <span className={`badge ${st.cls}`}>{st.lbl}</span>
                  </div>
                </div>

                {/* Items con edición si PENDIENTE */}
                <div style={{background:"var(--bg3)",borderRadius:10,padding:"8px 10px",marginBottom:9}}>
                  {currentItems.map((item,idx)=>{
                    const avail=item.type==="billete"
                      ?(billetes.find(b=>b.n===item.num)?.stock||99)-(billetes.find(b=>b.n===item.num)?.sold||0)
                      :(chances.find(c=>c.n===item.num)?.stock||999)-(chances.find(c=>c.n===item.num)?.sold||0);
                    const shortage=(item.qty||1)>avail;
                    const step=item.type==="chance"?5:1;
                    return (
                      <div key={idx} style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:idx<currentItems.length-1?8:0,marginBottom:idx<currentItems.length-1?8:0,borderBottom:idx<currentItems.length-1?"1px solid rgba(255,255,255,.05)":"none"}}>
                        <div style={{flex:1}}>
                          <div style={{display:"flex",gap:5,alignItems:"center"}}>
                            {item.type==="billete"?<span className="tag-b">BILLETE</span>:<span className="tag-c">CHANCE</span>}
                            <span style={{fontFamily:"'Bebas Neue'",fontSize:14,color:"var(--gold)",letterSpacing:1}}>{item.type==="billete"?"Nº ":"#"}{item.num}</span>
                          </div>
                          {shortage&&!isEditing&&<div style={{fontSize:9,color:"var(--red)",fontWeight:700,marginTop:2}}>⚠️ Stock insuf. · Disp: {Math.max(0,avail)}</div>}
                        </div>
                        {isEditing&&(o.status==="PENDIENTE"||o.status==="REEMPLAZO")?(
                          <div style={{display:"flex",alignItems:"center",gap:5}}>
                            <button onClick={()=>setEditedItems(p=>p.map((it,i)=>i===idx?{...it,qty:Math.max(step,(it.qty||1)-step),subtotal:((it.price||1)*Math.max(step,(it.qty||1)-step)).toFixed(2)}:it))}
                              style={{width:26,height:26,borderRadius:6,background:"var(--bg2)",border:"1px solid var(--border)",cursor:"pointer",color:"var(--text)",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center"}}>−</button>
                            <span style={{minWidth:22,textAlign:"center",fontWeight:800,fontSize:13,color:"var(--text)"}}>{item.qty||1}</span>
                            <button onClick={()=>setEditedItems(p=>p.map((it,i)=>i===idx?{...it,qty:Math.min(avail,(it.qty||1)+step),subtotal:((it.price||1)*Math.min(avail,(it.qty||1)+step)).toFixed(2)}:it))}
                              style={{width:26,height:26,borderRadius:6,background:"var(--bg2)",border:"1px solid var(--border)",cursor:"pointer",color:"var(--text)",fontSize:15,display:"flex",alignItems:"center",justifyContent:"center"}}>+</button>
                            <span style={{fontSize:11,fontWeight:700,color:"var(--green)",minWidth:38,textAlign:"right"}}>${item.subtotal}</span>
                          </div>
                        ):(
                          <div style={{display:"flex",alignItems:"center",gap:6}}>
                            {(item.qty||1)>1&&<span style={{fontSize:9,color:"var(--muted)"}}>×{item.qty}</span>}
                            <span style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>${item.subtotal}</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Lo que el vendedor recibe — destacado y grande */}
                <div style={{
                  background:"rgba(0,214,143,.08)",
                  border:"1px solid rgba(0,214,143,.3)",
                  borderRadius:11, padding:"10px 14px",
                  display:"flex", alignItems:"center", justifyContent:"space-between",
                  marginBottom:8
                }}>
                  <div>
                    <div style={{fontSize:9, color:"var(--muted)", fontWeight:800, letterSpacing:.8, textTransform:"uppercase"}}>Recibirás</div>
                    <div style={{fontSize:10, color:"var(--muted)", marginTop:1}}>{o.vendor} · 📍 {o.deliveryAddr}</div>
                  </div>
                  <div style={{
                    fontFamily:"'Bebas Neue', sans-serif",
                    fontSize:28, color:"var(--green)", letterSpacing:1, lineHeight:1
                  }}>
                    ${totals.vendorReceives}
                  </div>
                </div>

                <div className="row" style={{gap:7,flexWrap:"wrap"}}>
                  {/* Ajustar (PENDIENTE o REEMPLAZO sin estar editando) */}
                  {(o.status==="PENDIENTE"||o.status==="REEMPLAZO")&&!isEditing&&(
                    <button onClick={()=>{
                      setEditingOrder(o.id);
                      setEditedItems([...(o.items||[{type:o.type,num:o.num,qty:o.qty||1,price:o.type==="billete"?1:0.25,subtotal:o.lotteryValue||"1.00"}])]);
                    }}
                      style={{padding:"7px 11px",background:"rgba(59,158,255,.1)",border:"1px solid rgba(59,158,255,.28)",borderRadius:9,color:"var(--blue)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                      ✏️ {o.status==="REEMPLAZO"?"Ajustar reemplazo":"Ajustar"}
                    </button>
                  )}
                  {isEditing&&(
                    <>
                      <button onClick={()=>setEditingOrder(null)}
                        style={{padding:"7px 11px",background:"rgba(110,133,158,.1)",border:"1px solid var(--border)",borderRadius:9,color:"var(--muted)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                        Cancelar
                      </button>
                      <button onClick={()=>{
                        const orig = o.items||[];
                        const removed = orig.filter(oi=>!editedItems.find(ei=>ei.num===oi.num&&ei.qty>=oi.qty));
                        const reduced = orig.filter(oi=>{const ei=editedItems.find(e=>e.num===oi.num);return ei&&ei.qty<oi.qty;});
                        const allChanged = [...removed,...reduced.map(oi=>({...oi,reducedTo:editedItems.find(e=>e.num===oi.num)?.qty}))];
                        const note = o.status==="REEMPLAZO"
                          ? "El vendedor ajustó el reemplazo que propusiste"
                          : "El vendedor ajustó las cantidades de tu pedido";
                        onModify&&onModify(o.id, editedItems, allChanged, note);
                        setEditingOrder(null);
                      }}
                        style={{padding:"7px 13px",background:"rgba(244,196,48,.15)",border:"1px solid rgba(244,196,48,.4)",borderRadius:9,color:"var(--gold)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'",flex:1}}>
                        💾 Guardar y notificar cliente
                      </button>
                    </>
                  )}
                  {/* Aprobar (PENDIENTE sin editar) */}
                  {o.status==="PENDIENTE"&&!isEditing&&onApprove&&(
                    <button onClick={()=>{setEditingOrder(null);onApprove(o.id);}}
                      style={{padding:"9px 14px",background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",borderRadius:10,color:"var(--green)",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'",flex:1}}>
                      ✓ Aprobar pedido
                    </button>
                  )}
                  {/* Cancelar pedido (vendedor) — disponible en PENDIENTE, MODIFICADO, REEMPLAZO */}
                  {["PENDIENTE","MODIFICADO","REEMPLAZO"].includes(o.status)&&!isEditing&&(
                    <button onClick={()=>onCancelByVendor&&onCancelByVendor(o.id)}
                      style={{padding:"7px 10px",background:"rgba(255,75,110,.08)",border:"1px solid rgba(255,75,110,.22)",borderRadius:9,color:"var(--red)",fontSize:10,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                      🚫 Cancelar
                    </button>
                  )}
                  {/* MODIFICADO */}
                  {o.status==="MODIFICADO"&&!isEditing&&(
                    <div style={{width:"100%",background:"rgba(255,75,110,.07)",border:"1px solid rgba(255,75,110,.2)",borderRadius:10,padding:"9px 12px"}}>
                      <div style={{fontSize:11,fontWeight:800,color:"var(--red)",marginBottom:4}}>
                        🔒 Números reservados — esperando al cliente
                      </div>
                      <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5}}>
                        No vendas estos números al público hasta que el cliente decida.
                        {o.reservedNums?.length>0&&<> Reservados: <strong style={{color:"var(--gold)"}}>{o.reservedNums.join(", ")}</strong></>}
                      </div>
                      <div style={{fontSize:9,color:"var(--muted)",marginTop:4}}>
                        Vuelta #{o.round||1} · {o.modifiedAt}
                      </div>
                    </div>
                  )}
                  {/* REEMPLAZO: cliente propuso un número, vendedor debe decidir */}
                  {o.status==="REEMPLAZO"&&(
                    <div style={{width:"100%"}}>
                      <div style={{background:"rgba(59,158,255,.07)",border:"1px solid rgba(59,158,255,.25)",borderRadius:10,padding:"9px 12px",marginBottom:8}}>
                        <div style={{fontSize:11,fontWeight:800,color:"var(--blue)",marginBottom:4}}>
                          🔄 El cliente propone un reemplazo — Vuelta #{o.round||1}
                        </div>
                        <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5,marginBottom:4}}>{o.clientNote}</div>
                        {/* Mostrar el item de reemplazo destacado */}
                        {o.items?.filter(i=>i.isReplacement).map((item,idx)=>(
                          <div key={idx} style={{display:"flex",gap:5,alignItems:"center",background:"rgba(59,158,255,.1)",borderRadius:7,padding:"5px 8px"}}>
                            <span style={{fontSize:10,color:"var(--blue)",fontWeight:800}}>REEMPLAZO:</span>
                            {item.type==="billete"?<span className="tag-b">BILLETE</span>:<span className="tag-c">CHANCE</span>}
                            <span style={{fontFamily:"'Bebas Neue'",fontSize:14,color:"var(--gold)",letterSpacing:1}}>
                              {item.type==="billete"?"Nº ":"#"}{item.num} ×{item.qty}
                            </span>
                            <span style={{fontSize:11,fontWeight:700,color:"var(--green)",marginLeft:"auto"}}>${item.subtotal}</span>
                          </div>
                        ))}
                      </div>
                      <div style={{display:"flex",gap:7}}>
                        <button onClick={()=>onRejectReplacement&&onRejectReplacement(o.id)}
                          style={{flex:1,padding:"9px 10px",background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.28)",borderRadius:10,color:"var(--red)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                          ❌ Rechazar
                        </button>
                        <button onClick={()=>{
                          // Vendedor puede ajustar el reemplazo también
                          const orig=o.items?.filter(i=>!i.isReplacement)||[];
                          setEditingOrder(o.id);
                          setEditedItems(o.items||[]);
                        }}
                          style={{flex:1,padding:"9px 10px",background:"rgba(244,196,48,.1)",border:"1px solid rgba(244,196,48,.28)",borderRadius:10,color:"var(--gold)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                          ✏️ Modificar
                        </button>
                        <button onClick={()=>onApproveReplacement&&onApproveReplacement(o.id)}
                          style={{flex:1,padding:"9px 10px",background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",borderRadius:10,color:"var(--green)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                          ✓ Aprobar
                        </button>
                      </div>
                    </div>
                  )}
                  {o.status==="APROBADO"&&<span className="badge bg" style={{padding:"7px 12px",fontSize:11}}>✅ Listo para repartidor 🛵</span>}
                  {o.status==="EN_CAMINO"&&<span className="badge bb" style={{padding:"7px 12px",fontSize:11}}>🛵 En camino</span>}
                  {o.status==="ENTREGADO"&&<span className="badge bg" style={{padding:"7px 12px",fontSize:11}}>📦 Entregado ✓</span>}
                  {o.status==="CANCELADO"&&<span className="badge br" style={{padding:"7px 12px",fontSize:11}}>❌ Cancelado por cliente</span>}
                  {o.status==="CANCELADO_VENDEDOR"&&<span className="badge br" style={{padding:"7px 12px",fontSize:11}}>🚫 Cancelado por ti</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* ═══ MODAL EDITAR ITEM (eliminar / aumentar / reducir stock) ═══ */}
      {selectedItem && (() => {
        const arr = selectedItem.isChance ? chancesDelSorteo : billetesDelSorteo;
        const item = arr.find(x => x.n === selectedItem.n);
        // Si el item ya no existe (puede haberse eliminado), no renderizamos nada.
        // El useEffect de arriba se encarga de limpiar el estado en el siguiente tick.
        if (!item) return null;
        const av = item.stock - item.sold;
        const cnf = selectedItem.isChance
          ? { c:"var(--blue)",  bg:"rgba(59,158,255,.10)",  border:"rgba(59,158,255,.28)", icon:"⚡", price:0.25, label:"Chance" }
          : { c:"var(--gold)",  bg:"rgba(244,196,48,.10)",  border:"rgba(244,196,48,.28)", icon:"🎟", price:1.00, label:"Billete" };
        return (
          <div className="modal-bg" onClick={closeItemEditor}>
            <div className="modal pop" onClick={e=>e.stopPropagation()}>
              <div className="row" style={{justifyContent:"space-between",marginBottom:10}}>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:cnf.c,letterSpacing:2}}>EDITAR {cnf.label.toUpperCase()}</div>
                <button onClick={closeItemEditor} style={{background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:9,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                  <Ic n="close" s={14} c="var(--muted)"/>
                </button>
              </div>

              {/* Info del item */}
              <div style={{background:cnf.bg,border:`1.5px solid ${cnf.border}`,borderRadius:13,padding:"14px 16px",marginBottom:14,textAlign:"center"}}>
                <div style={{fontSize:32,marginBottom:4}}>{cnf.icon}</div>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:38,color:cnf.c,letterSpacing:3,lineHeight:1}}>{item.n}</div>
                <div style={{fontSize:10,color:"var(--muted)",marginTop:4,fontWeight:700}}>
                  {sorteoActivoTipo} · ${cnf.price.toFixed(2)} c/u
                </div>
              </div>

              {/* Estado actual */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:7,marginBottom:14}}>
                <div style={{background:"var(--bg3)",borderRadius:9,padding:"8px 4px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:"var(--muted)",fontWeight:700}}>Stock</div>
                  <div style={{fontSize:18,fontWeight:800,color:"var(--text)",fontFamily:"'Bebas Neue'",letterSpacing:1}}>{item.stock}</div>
                </div>
                <div style={{background:"var(--bg3)",borderRadius:9,padding:"8px 4px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:"var(--muted)",fontWeight:700}}>Vendidos</div>
                  <div style={{fontSize:18,fontWeight:800,color:item.sold>0?"var(--red)":"var(--muted)",fontFamily:"'Bebas Neue'",letterSpacing:1}}>{item.sold}</div>
                </div>
                <div style={{background:"var(--bg3)",borderRadius:9,padding:"8px 4px",textAlign:"center"}}>
                  <div style={{fontSize:9,color:"var(--muted)",fontWeight:700}}>Disponible</div>
                  <div style={{fontSize:18,fontWeight:800,color:av===0?"var(--red)":"var(--green)",fontFamily:"'Bebas Neue'",letterSpacing:1}}>{av}</div>
                </div>
              </div>

              {/* Botones aumentar/reducir */}
              <div className="sec">Ajustar stock</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                <button onClick={()=>adjustStock(-1)}
                  disabled={item.stock <= item.sold}
                  style={{padding:"12px",background:item.stock<=item.sold?"var(--bg3)":"rgba(255,75,110,.1)",border:`1.5px solid ${item.stock<=item.sold?"var(--border)":"rgba(255,75,110,.3)"}`,borderRadius:11,color:item.stock<=item.sold?"var(--muted)":"var(--red)",fontSize:13,fontWeight:800,cursor:item.stock<=item.sold?"not-allowed":"pointer",fontFamily:"'DM Sans'"}}>
                  ➖ Reducir 1
                </button>
                <button onClick={()=>adjustStock(1)}
                  style={{padding:"12px",background:`${cnf.c}1A`,border:`1.5px solid ${cnf.c}50`,borderRadius:11,color:cnf.c,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                  ➕ Aumentar 1
                </button>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                <button onClick={()=>adjustStock(-5)}
                  disabled={item.stock - 5 < item.sold}
                  style={{padding:"10px",background:(item.stock-5<item.sold)?"var(--bg3)":"rgba(255,75,110,.07)",border:`1px solid ${(item.stock-5<item.sold)?"var(--border)":"rgba(255,75,110,.2)"}`,borderRadius:10,color:(item.stock-5<item.sold)?"var(--muted)":"var(--red)",fontSize:11,fontWeight:700,cursor:(item.stock-5<item.sold)?"not-allowed":"pointer",fontFamily:"'DM Sans'"}}>
                  ➖ Reducir 5
                </button>
                <button onClick={()=>adjustStock(5)}
                  style={{padding:"10px",background:`${cnf.c}10`,border:`1px solid ${cnf.c}30`,borderRadius:10,color:cnf.c,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                  ➕ Aumentar 5
                </button>
              </div>

              {/* Eliminar */}
              <div className="sec">Eliminar del tablero</div>
              {item.sold > 0 ? (
                <div style={{background:"rgba(255,204,51,.06)",border:"1px solid rgba(255,204,51,.2)",borderRadius:10,padding:"10px 13px",fontSize:11,color:"var(--gold)",marginBottom:6}}>
                  ⚠️ No se puede eliminar — ya hay {item.sold} venta{item.sold!==1?"s":""}.
                  Reduce el stock al máximo posible (hasta {item.sold}).
                </div>
              ) : (
                <button onClick={removeItem}
                  style={{width:"100%",padding:"12px",background:"rgba(255,75,110,.12)",border:"1.5px solid rgba(255,75,110,.4)",borderRadius:11,color:"var(--red)",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                  🗑️ Eliminar {cnf.label} {item.n}
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* ═══ MODAL AÑADIR ═══ */}
      {showAdd&&(
        <div className="modal-bg" onClick={()=>setShowAdd(false)}>
          <div className="modal pop" onClick={e=>e.stopPropagation()}>
            <div className="row" style={{justifyContent:"space-between",marginBottom:10}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--gold)",letterSpacing:2}}>AÑADIR NÚMERO</div>
              <button onClick={()=>setShowAdd(false)} style={{background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:9,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                <Ic n="close" s={14} c="var(--muted)"/>
              </button>
            </div>
            {/* Sorteo activo reminder */}
            <div style={{background:activeSorteo.bg,border:`1px solid ${activeSorteo.border}`,borderRadius:10,padding:"7px 11px",marginBottom:14,display:"flex",gap:7,alignItems:"center"}}>
              <span style={{fontSize:16}}>{activeSorteo.icon}</span>
              <div style={{flex:1}}>
                <div style={{fontSize:10,fontWeight:800,color:activeSorteo.color}}>Añadiendo para {activeSorteo.tipo}</div>
                <div style={{fontSize:9,color:"var(--muted)"}}>Sorteo Nº {activeSorteo.sorteoN} · {activeSorteo.frecuencia}</div>
              </div>
            </div>

            {/* Tipo */}
            <div className="sec">Tipo de Producto</div>
            <div style={{display:"flex",gap:7,marginBottom:14}}>
              {[{id:"billete",icon:"🎟️",l:"Billete",sub:"4 cifras · $1.00",c:"var(--gold)"},{id:"chance",icon:"⚡",l:"Chance",sub:"2 cifras · $0.25",c:"var(--blue)"}].map(t=>(
                <button key={t.id} onClick={()=>{setAddType(t.id);setNewNum("");setNewStock(t.id==="billete"?1:50);}} style={{flex:1,padding:"10px 7px",borderRadius:12,border:`2px solid ${addType===t.id?t.c:"var(--border)"}`,background:addType===t.id?`${t.c}12`:"var(--bg3)",cursor:"pointer",textAlign:"center",fontFamily:"'DM Sans'",transition:"all .18s"}}>
                  <div style={{fontSize:20,marginBottom:4}}>{t.icon}</div>
                  <div style={{fontSize:13,fontWeight:800,color:addType===t.id?t.c:"var(--muted)"}}>{t.l}</div>
                  <div style={{fontSize:10,color:"var(--muted)",marginTop:1}}>{t.sub}</div>
                </button>
              ))}
            </div>

            {/* Número */}
            <div className="sec">Número</div>
            <input className="inp" style={{marginBottom:12,fontFamily:"'Bebas Neue'",fontSize:22,letterSpacing:3,color:"var(--gold)"}}
              placeholder={addType==="billete"?"Ej: 3561":"Ej: 07"}
              value={newNum} onChange={e=>setNewNum(e.target.value)}
              maxLength={addType==="billete"?4:2}/>

            {/* Stock */}
            <div className="sec">{addType==="billete"?"Billetes disponibles (sin límite)":"Unidades disponibles"}</div>
            <div className="row" style={{justifyContent:"space-between",background:"var(--bg3)",borderRadius:12,padding:"12px 14px",marginBottom:16}}>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>
                  {addType==="billete"?`${newStock} billete${newStock!==1?"s":""}`:`${newStock} unidades`}
                </div>
                <div style={{fontSize:10,color:"var(--muted)",marginTop:1}}>
                  Total: <strong style={{color:"var(--gold)"}}>${(newStock*(addType==="billete"?1:0.25)).toFixed(2)}</strong>
                </div>
              </div>
              <Stepper value={newStock} min={addType==="billete"?1:5} max={addType==="billete"?9999:9999}
                step={addType==="chance"?5:1} onChange={setNewStock} size="lg"/>
            </div>

            {addSuccess ? (
              <div className="pop" style={{background:"rgba(0,214,143,.1)",border:"1px solid rgba(0,214,143,.28)",borderRadius:12,padding:"14px",textAlign:"center"}}>
                <div style={{fontSize:28,marginBottom:4}}>✅</div>
                <div style={{fontWeight:800,fontSize:14,color:"var(--green)"}}>¡Añadido correctamente!</div>
              </div>
            ) : (
              <button className="btn" onClick={handleAdd} disabled={!newNum.trim()}>
                Añadir {addType==="billete"?"Billete":"Chance"} al inventario
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MOTOR DE BATCHING — CHANCE v1.0
   Precisión entera de centavos (×100).
   Escala degresiva de delivery:
     Posición 1 → Rider 100% | App   0%
     Posición 2 → Rider  70% | App  30%
     Posición 3+ → Rider  60% | App  40%
═══════════════════════════════════════════════════════ */

const BATCH = {
  TIME_WINDOW_MS:     10 * 60 * 1000,   // 10 minutos
  MAX_ORDERS:         5,
  PROXIMITY_METERS:   500,
  SPLITS: [
    { riderBP: 10000, appBP:    0, label: "100% rider" },
    { riderBP:  7000, appBP: 3000, label: "70% rider"  },
    { riderBP:  6000, appBP: 4000, label: "60% rider"  },
  ],
};

/** Retorna el split según posición (0-indexed internamente, 1-indexed externamente) */
const batchSplit = pos => pos <= 1 ? BATCH.SPLITS[0] : pos === 2 ? BATCH.SPLITS[1] : BATCH.SPLITS[2];

/**
 * Fórmula Haversine — distancia en metros entre dos coords GPS.
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 */
function haversineMeters(a, b) {
  const R   = 6_371_000;
  const rad = d => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Verifica si dos pedidos son candidatos para el mismo batch */
function areProximate(a, b) {
  if (a.buildingId && b.buildingId && a.buildingId === b.buildingId) return true;
  if (a.coordinates && b.coordinates) {
    return haversineMeters(a.coordinates, b.coordinates) <= BATCH.PROXIMITY_METERS;
  }
  return false;
}

/**
 * Agrupa pedidos pendientes en batches.
 * Criterios: ventana 10min + mismo buildingId o ≤500m + máx 5.
 * @param {Array} pendingOrders
 * @returns {Array<Array>} grupos de pedidos
 */
function groupOrdersIntoBatches(pendingOrders) {
  const sorted   = [...pendingOrders].sort((a, b) => a.createdAt - b.createdAt);
  const batches  = [];
  const assigned = new Set();

  for (const anchor of sorted) {
    if (assigned.has(anchor.id)) continue;
    const batch   = [anchor];
    assigned.add(anchor.id);
    const winEnd  = anchor.createdAt + BATCH.TIME_WINDOW_MS;

    for (const cand of sorted) {
      if (assigned.has(cand.id)) continue;
      if (batch.length >= BATCH.MAX_ORDERS) break;
      if (cand.createdAt > winEnd) continue;
      if (batch.every(e => areProximate(e, cand))) {
        batch.push(cand);
        assigned.add(cand.id);
      }
    }
    batches.push(batch);
  }
  return batches;
}

/**
 * Calcula el payout completo de un batch.
 * Usa aritmética entera (×100) para precisión exacta.
 *
 * @param {Array}  orders   Pedidos agrupados (máx 5)
 * @param {string} driverId ID del repartidor
 * @returns {Object}        BatchPayoutResult con todos los desgloses
 */
function calculateBatchPayout(orders, driverId) {
  if (!orders.length) throw new Error("Batch vacío");
  if (orders.length > BATCH.MAX_ORDERS) throw new Error(`Máximo ${BATCH.MAX_ORDERS} pedidos`);

  let totRiderDel = 0, totRiderTip = 0;
  let totAppSvc   = 0, totAppComm  = 0, totAppDel = 0;
  let totVendor   = 0, totCustomer = 0;
  let cashColl    = 0, cashDebt    = 0, yappyCred  = 0;

  const batchedOrders = orders.map((o, idx) => {
    const pos      = idx + 1;
    const split    = batchSplit(pos);
    const lottery  = toCents(o.lotteryValue);
    const delivery = toCents(o.deliveryFee);
    const tip      = toCents(o.tip || "0");

    const appComm    = Math.round(lottery * PE.COMMISSION_BP / 10000);
    const appSvc     = PE.SERVICE_FEE;
    const vendor     = lottery - appComm;
    const riderDel   = Math.round(delivery * split.riderBP / 10000);
    const appDel     = Math.round(delivery * split.appBP  / 10000);
    const riderOrder = riderDel + tip;
    const appOrder   = appSvc + appComm + appDel;
    const custTotal  = lottery + appSvc + delivery + tip;

    totRiderDel += riderDel;
    totRiderTip += tip;
    totAppSvc   += appSvc;
    totAppComm  += appComm;
    totAppDel   += appDel;
    totVendor   += vendor;
    totCustomer += custTotal;

    let cashFlow = null;
    if (o.paymentMethod === "CASH") {
      const debt = appSvc + appDel;   // service fee + delivery retenido
      cashColl += custTotal;
      cashDebt += debt;
      cashFlow  = {
        riderCollects:  centsToStr(custTotal),
        riderDebtToApp: centsToStr(debt),
        riderRetains:   centsToStr(riderOrder),
      };
    } else {
      yappyCred += riderOrder;
    }

    return {
      orderId:              o.id,
      batchPosition:        pos,
      splitLabel:           split.label,
      lotteryValue:         centsToStr(lottery),
      serviceFee:           centsToStr(appSvc),
      deliveryFee:          centsToStr(delivery),
      tip:                  centsToStr(tip),
      customerTotal:        centsToStr(custTotal),
      riderDeliveryEarning: centsToStr(riderDel),
      riderTipEarning:      centsToStr(tip),
      riderOrderTotal:      centsToStr(riderOrder),
      appServiceFee:        centsToStr(appSvc),
      appVendorCommission:  centsToStr(appComm),
      appDeliveryRetained:  centsToStr(appDel),
      appOrderTotal:        centsToStr(appOrder),
      vendorReceives:       centsToStr(vendor),
      paymentMethod:        o.paymentMethod,
      cashFlow,
    };
  });

  const totRider   = totRiderDel + totRiderTip;
  const totApp     = totAppSvc + totAppComm + totAppDel;
  const totalIn    = totCustomer + totAppComm;
  const totalOut   = totRider + totApp + totVendor;
  const balanced   = Math.abs(totalIn - totalOut) <= 1;

  return {
    batchId:              `BATCH-${Date.now().toString(36).toUpperCase()}`,
    driverId:             driverId || null,
    orderCount:           orders.length,
    orders:               batchedOrders,

    riderTotalPayout:     centsToStr(totRider),
    riderDeliveryTotal:   centsToStr(totRiderDel),
    riderTipTotal:        centsToStr(totRiderTip),

    appRevenue:           centsToStr(totApp),
    appServiceFees:       centsToStr(totAppSvc),
    appVendorCommissions: centsToStr(totAppComm),
    appDeliveryRetained:  centsToStr(totAppDel),

    totalVendorPayout:    centsToStr(totVendor),
    totalCustomerPaid:    centsToStr(totCustomer),

    cashSummary: {
      totalCashCollected: centsToStr(cashColl),
      totalRiderCashDebt: centsToStr(cashDebt),
      yappyAutoCredited:  centsToStr(yappyCred),
    },
    balanceCheck: { balanced, totalIn: centsToStr(totalIn), totalOut: centsToStr(totalOut) },
  };
}

/* ═══════════════════════════════════════════════════════
   COMPONENTE: BatchTripCard
   Muestra al repartidor su ganancia proyectada del batch
═══════════════════════════════════════════════════════ */
function BatchTripCard({ batch, onAccept, onDecline, isActive }) {
  const posColor = pos => pos === 1
    ? { bg:"rgba(0,214,143,.12)", c:"var(--green)" }
    : pos === 2
    ? { bg:"rgba(59,158,255,.12)",  c:"var(--blue)"  }
    : { bg:"rgba(255,75,110,.12)",  c:"var(--red)"   };

  const single = parseFloat(batch.orders[0]?.riderOrderTotal || "0");
  const total  = parseFloat(batch.riderTotalPayout);
  const extra  = (total - single).toFixed(2);

  return (
    <div className="fu">
      {/* Banner ganancia */}
      <div style={{background:"linear-gradient(135deg,rgba(244,196,48,.12),rgba(244,196,48,.04))",border:"1px solid rgba(244,196,48,.3)",borderRadius:18,padding:"16px 18px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center",position:"relative",overflow:"hidden"}}>
        <div style={{position:"absolute",right:-14,top:-14,width:80,height:80,borderRadius:"50%",background:"rgba(244,196,48,.07)"}}/>
        <div>
          <div style={{fontSize:10,color:"var(--gold)",fontWeight:800,letterSpacing:1.5,textTransform:"uppercase",marginBottom:3}}>
            {isActive ? "🛵 Viaje en Curso" : "⚡ ¡Viaje Optimizado!"}
          </div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:36,color:"var(--gold)",letterSpacing:2,lineHeight:1}}>
            Ganancia: ${batch.riderTotalPayout}
          </div>
          <div style={{fontSize:11,color:"var(--muted)",marginTop:3}}>
            {batch.orderCount} entregas · <span style={{color:"var(--green)"}}>+${extra} extra</span> vs viaje normal
          </div>
        </div>
        <div style={{width:52,height:52,borderRadius:"50%",background:"rgba(244,196,48,.15)",border:"2px solid rgba(244,196,48,.35)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--gold)",lineHeight:1}}>{batch.orderCount}</div>
          <div style={{fontSize:8,color:"var(--muted)",fontWeight:700}}>pedidos</div>
        </div>
      </div>

      {/* Leyenda de splits */}
      <div style={{display:"flex",gap:7,marginBottom:12}}>
        {[{pos:1,pct:"100%",lbl:"#1"},{pos:2,pct:"70%",lbl:"#2"},{pos:3,pct:"60%",lbl:"3+"}].map(s=>{
          const pc = posColor(s.pos);
          return (
            <div key={s.pos} style={{flex:1,background:pc.bg,border:`1px solid ${pc.c}28`,borderRadius:11,padding:"8px 4px",textAlign:"center"}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:pc.c,lineHeight:1}}>{s.pct}</div>
              <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,marginTop:2}}>Pedido {s.lbl}</div>
            </div>
          );
        })}
      </div>

      {/* Pedidos del batch */}
      <div className="sec">Pedidos de este viaje</div>
      {batch.orders.map(o=>{
        const pc = posColor(o.batchPosition);
        return (
          <div key={o.orderId} className="card" style={{marginBottom:8}}>
            <div style={{display:"flex",gap:10,alignItems:"center"}}>
              <div style={{width:44,height:44,borderRadius:11,background:pc.bg,border:`1px solid ${pc.c}28`,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                <div style={{fontFamily:"'Bebas Neue'",fontSize:18,color:pc.c,lineHeight:1}}>{o.batchPosition}</div>
                <div style={{fontSize:8,color:pc.c,fontWeight:800}}>{o.splitLabel.split(" ")[0]}</div>
              </div>
              <div style={{flex:1}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>Pedido {o.orderId}</div>
                    <div style={{fontSize:10,color:"var(--muted)"}}>
                      {o.paymentMethod==="CASH"?"💵 Efectivo":"📱 Yappy"} · Lotería ${o.lotteryValue}
                    </div>
                    <div style={{fontSize:10,color:"var(--muted)"}}>
                      Delivery: ${o.riderDeliveryEarning} · Propina: ${o.riderTipEarning}
                    </div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:pc.c,letterSpacing:1}}>${o.riderOrderTotal}</div>
                    <div style={{fontSize:9,color:"var(--muted)"}}>tu ganancia</div>
                  </div>
                </div>
                {o.cashFlow&&(
                  <div style={{marginTop:6,background:"rgba(255,75,110,.07)",borderRadius:7,padding:"5px 9px",display:"flex",justifyContent:"space-between"}}>
                    <span style={{fontSize:10,color:"var(--red)",fontWeight:700}}>Cobras: ${o.cashFlow.riderCollects}</span>
                    <span style={{fontSize:10,color:"var(--red)"}}>Debes App: ${o.cashFlow.riderDebtToApp}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Resumen del viaje */}
      <div className="card" style={{border:"1px solid rgba(0,214,143,.22)",background:"rgba(0,214,143,.04)",marginBottom:10}}>
        <div className="sec" style={{marginBottom:9,color:"var(--green)"}}>Tu Resumen del Viaje</div>
        {[
          {l:"Delivery fees cobrados", v:`$${batch.riderDeliveryTotal}`, c:"var(--green)"},
          {l:"Propinas",               v:`$${batch.riderTipTotal}`,      c:"var(--green)"},
        ].map(r=>(
          <div key={r.l} style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
            <span style={{fontSize:12,color:"var(--muted)"}}>{r.l}</span>
            <span style={{fontSize:12,fontWeight:700,color:r.c}}>{r.v}</span>
          </div>
        ))}
        <div className="div" style={{margin:"7px 0"}}/>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontWeight:800,fontSize:14,color:"var(--text)"}}>TOTAL GANANCIA</span>
          <span style={{fontFamily:"'Bebas Neue'",fontSize:30,color:"var(--gold)",letterSpacing:1}}>${batch.riderTotalPayout}</span>
        </div>
      </div>

      {/* Flujo efectivo si aplica */}
      {parseFloat(batch.cashSummary.totalRiderCashDebt) > 0 && (
        <div className="card" style={{border:"1px solid rgba(255,75,110,.22)",background:"rgba(255,75,110,.04)",marginBottom:10}}>
          <div className="sec" style={{marginBottom:8,color:"var(--red)"}}>⚠️ Efectivo — Deuda con App</div>
          {[
            {l:"Cobrado del cliente",  v:batch.cashSummary.totalCashCollected, c:"var(--gold)"},
            {l:"Deuda a liquidar",     v:batch.cashSummary.totalRiderCashDebt, c:"var(--red)"},
            {l:"Yappy acreditado",     v:batch.cashSummary.yappyAutoCredited,  c:"var(--blue)"},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
              <span style={{fontSize:11,color:"var(--muted)"}}>{r.l}</span>
              <span style={{fontSize:12,fontWeight:800,color:r.c}}>${r.v}</span>
            </div>
          ))}
          <div style={{fontSize:9,color:"var(--muted)",marginTop:6,padding:"5px 9px",background:"rgba(244,196,48,.06)",borderRadius:7}}>
            El 2.5% de lotería ya fue descontado al vendedor. Tu deuda es solo el service fee + % de delivery retenido.
          </div>
        </div>
      )}

      {/* Verificación de balance */}
      <div style={{background:"rgba(0,214,143,.06)",border:"1px solid rgba(0,214,143,.2)",borderRadius:11,padding:"9px 13px",marginBottom:10}}>
        <div style={{fontSize:10,fontWeight:700,color:batch.balanceCheck.balanced?"var(--green)":"var(--red)"}}>
          {batch.balanceCheck.balanced ? "✓ Balance verificado" : "✗ Error de balance"}
        </div>
        <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>
          Total In: ${batch.balanceCheck.totalIn} = Total Out: ${batch.balanceCheck.totalOut}
        </div>
      </div>

      {/* App revenue (solo para admin/debug) */}
      <div className="card" style={{opacity:.7}}>
        <div className="sec" style={{marginBottom:8}}>App Revenue (este batch)</div>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          {[
            {l:"Service fees",   v:`$${batch.appServiceFees}`},
            {l:"Comisiones 2.5%",v:`$${batch.appVendorCommissions}`},
            {l:"Delivery ret.",  v:`$${batch.appDeliveryRetained}`},
            {l:"TOTAL App",      v:`$${batch.appRevenue}`,bold:true},
          ].map(r=>(
            <div key={r.l} style={{flex:1,background:"var(--bg3)",borderRadius:9,padding:"7px",textAlign:"center",minWidth:70}}>
              <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,textTransform:"uppercase",marginBottom:3}}>{r.l}</div>
              <div style={{fontSize:r.bold?16:13,fontWeight:800,color:r.bold?"var(--blue)":"var(--text)"}}>{r.v}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Botones de acción */}
      {!isActive&&onAccept&&(
        <div style={{display:"flex",gap:8,marginTop:8}}>
          <button onClick={()=>onDecline&&onDecline(batch.batchId)} className="btng" style={{flex:1,color:"var(--red)",borderColor:"rgba(255,75,110,.4)"}}>Rechazar</button>
          <button onClick={()=>onAccept(batch.batchId)} className="btn" style={{flex:2}}>
            Aceptar viaje · ${batch.riderTotalPayout}
          </button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   MÓDULO REPARTIDOR — con Motor de Pagos integrado
═══════════════════════════════════════════════════════ */
function RepartidorHome({ authUser=null, orders=[], onAssign, onDeliver, onStartPickup, initTab="inicio" }) {
  const [rTab, setRTab] = useState(initTab);
  const [batchAccepted, setBatchAccepted] = useState(false);

  // ── IDENTIDAD DEL REPARTIDOR ─────────────────────────────────────────────
  // Se deriva del authUser logueado. Fallback a Juan Rodríguez (demo).
  const repartidorUserId = authUser?.id || "repartidor_juan";
  const repartidorName   = authUser?.nombre || "Juan Rodríguez";

  // CORRECCIÓN: useEffect para sincronizar tab con nav inferior
  useEffect(() => { setRTab(initTab); }, [initTab]);

  const sortNewR = (a,b)=>{
    const aMs = typeof a.createdAtMs==='number' ? a.createdAtMs : 0;
    const bMs = typeof b.createdAtMs==='number' ? b.createdAtMs : 0;
    if (bMs !== aMs) return bMs - aMs;
    const aId = parseInt((a.id||'').replace(/\D/g,''))||0;
    const bId = parseInt((b.id||'').replace(/\D/g,''))||0;
    return bId - aId;
  };
  // Cada repartidor solo ve los pedidos que le fueron asignados específicamente,
  // los pendientes (que cualquiera puede tomar), y los suyos ya en camino/entregados.
  // Backward-compat: pedidos sin assignedRepartidorId se asumen como Juan.
  const esMioR = o => {
    const asignado = o.assignedRepartidorId || (o.status === "APROBADO" || o.status === "PENDIENTE" ? null : "repartidor_juan");
    return !asignado || asignado === repartidorUserId;
  };
  const myOrders        = orders.filter(esMioR);
  const approvedOrders  = myOrders.filter(o=>o.status==="APROBADO").sort(sortNewR);
  const inTransitOrders = myOrders.filter(o=>o.status==="EN_CAMINO").sort(sortNewR);
  const deliveredOrders = myOrders.filter(o=>o.status==="ENTREGADO").sort(sortNewR);
  // Pedidos PENDIENTES: el repartidor los ve para saber que están en cola, pero no puede iniciarlos
  const pendingOrders   = orders.filter(o=>["PENDIENTE","MODIFICADO","REEMPLAZO"].includes(o.status)).sort(sortNewR);

  // ─── TRACKING GPS EN VIVO ───
  // Se activa automáticamente cuando el repartidor tiene al menos 1 entrega EN_CAMINO
  // Envía la ubicación a Firebase cada vez que cambia (watchPosition)
  const tieneEntregaActiva = inTransitOrders.length > 0;
  useTrackingUbicacion(repartidorUserId, tieneEntregaActiva);

  // Estado del GPS (para mostrar al repartidor)
  const [gpsStatus, setGpsStatus] = useState(null);
  useEffect(() => {
    if (!tieneEntregaActiva) { setGpsStatus(null); return; }
    if (!navigator.geolocation) { setGpsStatus("error"); return; }
    setGpsStatus("solicitando");
    navigator.geolocation.getCurrentPosition(
      () => setGpsStatus("activo"),
      (err) => setGpsStatus(err.code === 1 ? "denegado" : "error"),
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, [tieneEntregaActiva]);

  const NOW = Date.now();
  const batchSource = approvedOrders.length>=2
    ? approvedOrders.slice(0,Math.min(5,approvedOrders.length)).map(o=>({
        id:o.id, lotteryValue:o.lotteryValue||"1.00",
        deliveryFee:o.deliveryFee||"2.50", tip:o.tip||"0",
        paymentMethod:o.paymentMethod==="YAPPY"?"YAPPY":"CASH",
        buildingId:"panama_zone", coordinates:{lat:8.9936,lng:-79.5197}, createdAt:NOW,
      }))
    : [
        {id:"CH-DEMO1",lotteryValue:"10.00",deliveryFee:"2.00",tip:"0",paymentMethod:"CASH",buildingId:"torre_pacific_ph",coordinates:{lat:8.9936,lng:-79.5197},createdAt:NOW},
        {id:"CH-DEMO2",lotteryValue:"10.00",deliveryFee:"2.00",tip:"0",paymentMethod:"YAPPY",buildingId:"torre_pacific_ph",coordinates:{lat:8.9936,lng:-79.5197},createdAt:NOW+60000},
        {id:"CH-DEMO3",lotteryValue:"10.00",deliveryFee:"2.00",tip:"0",paymentMethod:"CASH",buildingId:"torre_pacific_ph",coordinates:{lat:8.9936,lng:-79.5197},createdAt:NOW+120000},
      ];
  const demoBatch = calculateBatchPayout(batchSource, "driver_juan");

  const [balance, setBalance] = useState({
    wallet:8450, debtToApp:0, earned:1200, deliveries:0, cashHeld:0, yappyBalance:1200,
  });

  const [calcLottery,  setCalcLottery]  = useState("2.00");
  const [calcDelivery, setCalcDelivery] = useState("2.50");
  const [calcTip,      setCalcTip]      = useState("0.00");
  const [calcMethod,   setCalcMethod]   = useState("efectivo");

  const liveT = (() => {
    try { return calcOrderTotals(calcLottery||"0", calcDelivery||"0", calcTip||"0"); }
    catch { return null; }
  })();

  const simulateDelivery = () => {
    if (!liveT) return;
    const gain = liveT._driver;
    // En efectivo: el Repartidor debe a la App el service fee $1.00 + la comisión 2.5%
    // (ambos cobrados físicamente por él al cliente)
    const debt = calcMethod==="efectivo" ? (liveT._appSvc + liveT._appComm) : 0;
    setBalance(b=>({
      wallet:b.wallet+gain, debtToApp:b.debtToApp+debt, earned:b.earned+gain,
      deliveries:b.deliveries+1,
      cashHeld:calcMethod==="efectivo"?b.cashHeld+liveT._customerTotal:b.cashHeld,
      yappyBalance:calcMethod==="yappy"?b.yappyBalance+gain:b.yappyBalance,
    }));
  };

  const settleDebt = () => {
    if(balance.debtToApp<=0) return;
    setBalance(b=>({...b,debtToApp:0,cashHeld:Math.max(0,b.cashHeld-b.debtToApp)}));
  };

  const handleDeliver = (orderId) => {
    onDeliver&&onDeliver(orderId);
    setBalance(b=>({...b,deliveries:b.deliveries+1,earned:b.earned+250}));
  };

  const fmt = cents => '$'+(Math.abs(cents)/100).toFixed(2);

  const tabs = [
    {id:"inicio",      l:"Inicio",    ic:"home"},
    {id:"batch",       l:"Batch 🔥",  ic:"zap"},
    {id:"calculadora", l:"Calc.",     ic:"zap"},
    {id:"liquidacion", l:"Liquidar",  ic:"wallet"},
  ];

  return (
    <div className="sc fu" style={{position:"relative"}}>
      <div className="tabs" style={{margin:"0 0 14px"}}>
        {tabs.map(t=>(
          <button key={t.id} className={`tab ${rTab===t.id?"on":""}`}
            onClick={()=>setRTab(t.id)} style={{position:"relative"}}>
            {t.l}
            {t.id==="inicio"&&approvedOrders.length>0&&<span style={{position:"absolute",top:2,right:2,width:7,height:7,borderRadius:"50%",background:"var(--green)"}}/>}
          </button>
        ))}
      </div>

      {/* ── TAB: INICIO ── */}
      {rTab==="inicio"&&<>
        {/* Banner de estado GPS cuando hay entrega activa */}
        {tieneEntregaActiva && (
          <div style={{
            background: gpsStatus==="activo" ? "rgba(0,214,143,.08)" : gpsStatus==="denegado" ? "rgba(255,90,120,.08)" : "rgba(244,196,48,.08)",
            border: `1px solid ${gpsStatus==="activo" ? "rgba(0,214,143,.3)" : gpsStatus==="denegado" ? "rgba(255,90,120,.3)" : "rgba(244,196,48,.3)"}`,
            borderRadius:12,padding:"10px 13px",display:"flex",gap:10,alignItems:"center",marginBottom:12
          }}>
            <div style={{width:36,height:36,borderRadius:10,background:"rgba(255,255,255,.05)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:18}}>
              {gpsStatus==="activo" ? "📡" : gpsStatus==="denegado" ? "🚫" : "🔍"}
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:11,fontWeight:800,color: gpsStatus==="activo" ? "var(--green)" : gpsStatus==="denegado" ? "var(--red)" : "var(--gold)"}}>
                {gpsStatus==="activo" ? "● GPS ACTIVO · enviando ubicación" :
                 gpsStatus==="denegado" ? "⚠️ Permiso de ubicación denegado" :
                 gpsStatus==="error" ? "⚠️ Error de GPS" :
                 "🔍 Buscando GPS..."}
              </div>
              <div style={{fontSize:10,color:"var(--muted)"}}>
                {gpsStatus==="activo" ? "El comprador ve tu ubicación en vivo" :
                 gpsStatus==="denegado" ? "Activa la ubicación en Configuración del navegador" :
                 "Asegúrate de tener GPS encendido"}
              </div>
            </div>
          </div>
        )}

        {approvedOrders.length>0&&(
          <div style={{background:"rgba(0,214,143,.08)",border:"1px solid rgba(0,214,143,.3)",borderRadius:12,padding:"10px 13px",display:"flex",gap:10,alignItems:"center",marginBottom:12,cursor:"pointer"}} onClick={()=>setRTab("batch")}>
            <div style={{width:36,height:36,borderRadius:10,background:"rgba(0,214,143,.15)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic n="truck" s={16} c="var(--green)"/></div>
            <div style={{flex:1}}>
              <div style={{fontSize:11,fontWeight:800,color:"var(--green)"}}>✅ {approvedOrders.length} pedido(s) listos para entregar</div>
              <div style={{fontSize:10,color:"var(--muted)"}}>El vendedor aprobó · Toca para ver batch</div>
            </div>
            <Ic n="chevR" s={14} c="var(--green)"/>
          </div>
        )}
        {approvedOrders.length===0&&!batchAccepted&&(
          <div style={{background:"rgba(244,196,48,.08)",border:"1px solid rgba(244,196,48,.3)",borderRadius:12,padding:"10px 13px",display:"flex",gap:10,alignItems:"center",marginBottom:12,cursor:"pointer"}} onClick={()=>setRTab("batch")}>
            <div style={{width:36,height:36,borderRadius:10,background:"rgba(244,196,48,.15)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic n="zap" s={16} c="var(--gold)"/></div>
            <div style={{flex:1}}>
              <div style={{fontSize:11,fontWeight:800,color:"var(--gold)"}}>⚡ Batch demo disponible</div>
              <div style={{fontSize:10,color:"var(--muted)"}}>3 pedidos agrupados · Ganancia: ${demoBatch.riderTotalPayout}</div>
            </div>
            <Ic n="chevR" s={14} c="var(--gold)"/>
          </div>
        )}
        <div className="row" style={{justifyContent:"space-between",marginBottom:12}}>
          <div>
            <div style={{fontSize:10,color:"var(--muted)"}}>Repartidor</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--gold)",letterSpacing:2}}>JUAN RODRÍGUEZ</div>
          </div>
          <span className="badge bg">● Online</span>
        </div>
        <div className="wallet">
          <div style={{fontSize:9,color:"var(--muted)",fontWeight:800,textTransform:"uppercase",letterSpacing:1.5}}>Billetera Virtual</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:44,color:"var(--gold)",letterSpacing:2,lineHeight:1,margin:"5px 0"}}>{fmt(balance.wallet)}</div>
          <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
            {[["Ganado hoy",fmt(balance.earned),"var(--green)"],["Entregas",String(balance.deliveries+deliveredOrders.length),"var(--text)"],["Deuda App",fmt(balance.debtToApp),balance.debtToApp>0?"var(--red)":"var(--green)"]].map(([l,v,c])=>(
              <div key={l}><div style={{fontSize:9,color:"var(--muted)"}}>{l}</div><div style={{fontSize:12,fontWeight:800,color:c}}>{v}</div></div>
            ))}
          </div>
        </div>
        <div className="card" style={{marginBottom:10}}>
          <div className="sec" style={{marginBottom:9}}>Estructura de Comisiones</div>
          {[
            ["Comisión 2.5% del Vendedor","efectivo: debes a App","var(--orange)","2.5%"],
            ["Service fee $1.00","efectivo: debes a App","var(--red)","−$1.00"],
            ["Delivery fee","100% para ti","var(--green)","100%"],
            ["Propina","100% para ti","var(--green)","100%"],
          ].map(([l,sub,c,v])=>(
            <div key={l} className="row" style={{justifyContent:"space-between",marginBottom:7,alignItems:"flex-start"}}>
              <div className="row" style={{gap:7,alignItems:"flex-start",flex:1}}>
                <div style={{width:7,height:7,borderRadius:2,background:c,flexShrink:0,marginTop:5}}/>
                <div>
                  <div style={{fontSize:11,color:"var(--text)",fontWeight:600}}>{l}</div>
                  <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>{sub}</div>
                </div>
              </div>
              <span style={{fontSize:11,fontWeight:800,color:c,flexShrink:0}}>{v}</span>
            </div>
          ))}
          <div style={{background:"rgba(255,140,85,.07)",border:"1px solid rgba(255,140,85,.2)",borderRadius:9,padding:"7px 11px",marginTop:8}}>
            <div style={{fontSize:10,color:"var(--orange)",fontWeight:800,marginBottom:2}}>ℹ️ Cómo funciona en efectivo</div>
            <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.4}}>
              Tú cobras el monto completo al cliente. Le pagas al Vendedor el valor de la lotería menos su 2.5%. Esa comisión <strong style={{color:"var(--orange)"}}>+ el service fee $1.00</strong> los debes a la App. Se descontarán automáticamente de tu billetera al cierre del día.
            </div>
          </div>
          <div style={{background:"rgba(244,196,48,.07)",border:"1px solid rgba(244,196,48,.18)",borderRadius:9,padding:"7px 11px",marginTop:8}}>
            <div style={{fontSize:10,color:"var(--gold)",fontWeight:800,marginBottom:2}}>💡 Yappy recomendado</div>
            <div style={{fontSize:10,color:"var(--muted)"}}>Con Yappy no manejas efectivo y la App distribuye todo automáticamente.</div>
          </div>
        </div>
        {/* Mapa real con Leaflet del repartidor */}
        {(approvedOrders.length>0 || inTransitOrders.length>0) ? (
          <RepartidorMapa orders={[...approvedOrders, ...inTransitOrders]} repartidorId={repartidorUserId} />
        ) : (
          <div style={{
            height:160, borderRadius:14, background:"var(--bg2)",
            border:"1px solid var(--border)", display:"flex",
            alignItems:"center", justifyContent:"center", marginBottom:12
          }}>
            <div style={{textAlign:"center",opacity:.6}}>
              <div style={{fontSize:36,marginBottom:6}}>🗺️</div>
              <div style={{fontSize:11,color:"var(--muted)"}}>El mapa aparecerá cuando tengas entregas</div>
            </div>
          </div>
        )}
        <div className="sec">
          Entregas del Día
          {(approvedOrders.length+inTransitOrders.length)>0&&<span style={{marginLeft:8,fontFamily:"'DM Sans'",background:"var(--green)",color:"#08111F",borderRadius:8,padding:"1px 6px",fontSize:9,fontWeight:800}}>{approvedOrders.length+inTransitOrders.length} activas</span>}
        </div>
        {approvedOrders.length===0&&inTransitOrders.length===0&&deliveredOrders.length===0&&pendingOrders.length===0?(
          <div style={{textAlign:"center",padding:"24px 0",opacity:.6}}>
            <div style={{fontSize:36,marginBottom:8}}>🛵</div>
            <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Sin entregas activas</div>
            <div style={{fontSize:11,color:"var(--muted)"}}>Los pedidos aprobados por el vendedor aparecerán aquí</div>
          </div>
        ):[...pendingOrders,...approvedOrders,...inTransitOrders,...deliveredOrders].map(o=>{
          const et=calcOrderTotals(o.lotteryValue||"1.00",o.deliveryFee||"2.50",o.tip||"0");
          const cf=o.paymentMethod==="CASH"?calcCashFlow(et):null;
          const isInTransit=o.status==="EN_CAMINO";
          const isDelivered=o.status==="ENTREGADO";
          const isApproved=o.status==="APROBADO";
          const itemList = o.items || [{type:o.type,num:o.num,qty:o.qty||1,subtotal:o.lotteryValue||"1.00"}];

          // ─── FASES DEL DELIVERY (estilo Uber Eats / Rappi / DiDi Food) ───
          // FASE 1 — PICKUP: status APROBADO → Repartidor va al VENDEDOR a recoger
          // FASE 2 — DROPOFF: status EN_CAMINO → Repartidor lleva al CLIENTE
          const fase = isApproved ? "pickup" : isInTransit ? "dropoff" : isDelivered ? "done" : "espera";
          const vendorInfo = getVendorCoords(o.vendorId || "V001");

          return (
            <div key={o.id} className="card" style={{marginBottom:9,border:isInTransit?"1px solid rgba(59,158,255,.3)":isDelivered?"1px solid rgba(0,214,143,.2)":isApproved?"1px solid rgba(244,196,48,.4)":"1px solid rgba(147,173,204,.2)"}}>
              <div className="row" style={{justifyContent:"space-between",marginBottom:7}}>
                <div>
                  <span style={{fontSize:10,color:"var(--muted)",fontWeight:700}}>{o.id}</span>
                  {itemList.length>1&&<span style={{marginLeft:7,fontSize:9,fontWeight:800,color:"var(--blue)",background:"rgba(59,158,255,.1)",borderRadius:7,padding:"2px 6px"}}>{itemList.length} items</span>}
                </div>
                <span className={`badge ${isDelivered?"bg":isInTransit?"bb":isApproved?(o.pickupStarted?"bb":"by"):"br"}`}>{isDelivered?"📦 Entregado":isInTransit?"🛵 En Camino":isApproved?(o.pickupStarted?"🛵 Asignado a mí":"📦 Recoger"):"⏳ Pendiente vendedor"}</span>
              </div>

              {/* Indicador de fase: Pickup → Dropoff (timeline horizontal) */}
              {(isApproved || isInTransit) && (
                <div style={{background:"var(--bg3)",borderRadius:9,padding:"8px 10px",marginBottom:8}}>
                  <div className="row" style={{gap:6,alignItems:"center"}}>
                    {/* Step 1: Recogida */}
                    <div style={{display:"flex",alignItems:"center",gap:5,flex:1}}>
                      <div style={{width:22,height:22,borderRadius:"50%",background:fase==="pickup"?"var(--gold)":"var(--green)",color:"#08111F",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:11,flexShrink:0}}>
                        {fase==="pickup" ? "1" : "✓"}
                      </div>
                      <div style={{minWidth:0}}>
                        <div style={{fontSize:9,fontWeight:800,color:fase==="pickup"?"var(--gold)":"var(--green)",letterSpacing:.5}}>RECOGER</div>
                        <div style={{fontSize:9,color:"var(--muted)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>Vendedor</div>
                      </div>
                    </div>
                    {/* Línea conectora */}
                    <div style={{flex:0.5,height:2,background:fase==="dropoff"?"var(--green)":"var(--border)",minWidth:14}}/>
                    {/* Step 2: Entrega */}
                    <div style={{display:"flex",alignItems:"center",gap:5,flex:1,justifyContent:"flex-end"}}>
                      <div style={{minWidth:0,textAlign:"right"}}>
                        <div style={{fontSize:9,fontWeight:800,color:fase==="dropoff"?"var(--blue)":"var(--muted)",letterSpacing:.5}}>ENTREGAR</div>
                        <div style={{fontSize:9,color:"var(--muted)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>Cliente</div>
                      </div>
                      <div style={{width:22,height:22,borderRadius:"50%",background:fase==="dropoff"?"var(--blue)":"var(--bg2)",border:fase==="dropoff"?"none":"1px solid var(--border)",color:fase==="dropoff"?"#08111F":"var(--muted)",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:11,flexShrink:0}}>
                        2
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Todos los items del pedido consolidado */}
              <div style={{background:"var(--bg3)",borderRadius:9,padding:"8px 10px",marginBottom:8}}>
                {itemList.map((item,idx)=>(
                  <div key={idx} style={{display:"flex",justifyContent:"space-between",alignItems:"center",paddingBottom:idx<itemList.length-1?6:0,marginBottom:idx<itemList.length-1?6:0,borderBottom:idx<itemList.length-1?"1px solid rgba(255,255,255,.05)":"none"}}>
                    <div style={{display:"flex",gap:5,alignItems:"center"}}>
                      {item.type==="billete"?<span className="tag-b">BILLETE</span>:<span className="tag-c">CHANCE</span>}
                      <span style={{fontFamily:"'Bebas Neue'",fontSize:14,color:"var(--gold)",letterSpacing:1}}>
                        {item.type==="billete"?"Nº ":"#"}{item.num}
                      </span>
                      {(item.qty||1)>1&&<span style={{fontSize:9,color:"var(--muted)"}}>×{item.qty}</span>}
                    </div>
                    <span style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>${item.subtotal}</span>
                  </div>
                ))}
              </div>

              {/* ═══════════════════════════════════════════════════════════
                   FASE 1 — RECOGER DEL VENDEDOR (status: APROBADO)
                   Muestra dirección y contacto del VENDEDOR
              ═══════════════════════════════════════════════════════════ */}
              {fase === "pickup" && (
                <div style={{background:"rgba(244,196,48,.08)",border:"1px solid rgba(244,196,48,.3)",borderRadius:9,padding:"10px 11px",marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:8,color:"var(--gold)",fontWeight:800,textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>🏪 Recoger en</div>
                      <div style={{fontSize:12,fontWeight:800,color:"var(--text)"}}>{vendorInfo.name}</div>
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:1,lineHeight:1.3}}>📍 {vendorInfo.address}</div>
                      <div style={{fontSize:9,color:"var(--gold)",marginTop:2}}>{vendorInfo.zone}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:5}}>
                    <a href={`tel:+507${(vendorInfo.phone||"").replace(/-/g,"")}`} style={{flex:1,padding:"7px",borderRadius:7,background:"rgba(244,196,48,.12)",border:"1px solid rgba(244,196,48,.3)",color:"var(--gold)",fontSize:10,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
                      📞 Llamar vendedor
                    </a>
                    <a href={`https://wa.me/507${(vendorInfo.phone||"").replace(/-/g,"")}`} target="_blank" rel="noopener" style={{flex:1,padding:"7px",borderRadius:7,background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",color:"var(--green)",fontSize:10,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
                      💬 WhatsApp
                    </a>
                  </div>
                </div>
              )}

              {/* ═══════════════════════════════════════════════════════════
                   FASE 2 — ENTREGAR AL CLIENTE (status: EN_CAMINO o ENTREGADO)
                   Muestra dirección y contacto del CLIENTE
              ═══════════════════════════════════════════════════════════ */}
              {(fase === "dropoff" || fase === "done") && (
                <div style={{background:"rgba(0,229,160,.06)",border:"1px solid rgba(0,229,160,.2)",borderRadius:9,padding:"10px 11px",marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:8,color:"var(--green)",fontWeight:800,textTransform:"uppercase",letterSpacing:1,marginBottom:2}}>📍 Entregar a</div>
                      <div style={{fontSize:12,fontWeight:800,color:"var(--text)"}}>{o.customerName||"Cliente"}</div>
                      <div style={{fontSize:10,color:"var(--muted)",marginTop:1,lineHeight:1.3}}>📍 {o.deliveryAddress?.text||o.deliveryAddr||"Panamá"}</div>
                      <div style={{fontSize:9,color:"var(--blue)",fontWeight:700,marginTop:2}}>📞 {o.customerPhone||"6555-1234"}</div>
                    </div>
                  </div>
                  {!isDelivered && (
                    <div style={{display:"flex",gap:5}}>
                      <a href={`tel:+507${(o.customerPhone||"6555-1234").replace(/-/g,"")}`} style={{flex:1,padding:"6px",borderRadius:7,background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",color:"var(--green)",fontSize:9,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
                        📞 Llamar
                      </a>
                      <a href={`https://wa.me/507${(o.customerPhone||"6555-1234").replace(/-/g,"")}`} target="_blank" rel="noopener" style={{flex:1,padding:"6px",borderRadius:7,background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",color:"var(--green)",fontSize:9,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
                        💬 WhatsApp
                      </a>
                      <a href={`sms:+507${(o.customerPhone||"6555-1234").replace(/-/g,"")}`} style={{flex:1,padding:"6px",borderRadius:7,background:"rgba(59,158,255,.12)",border:"1px solid rgba(59,158,255,.3)",color:"var(--blue)",fontSize:9,fontWeight:800,textAlign:"center",textDecoration:"none",fontFamily:"'DM Sans'"}}>
                        📩 SMS
                      </a>
                    </div>
                  )}
                </div>
              )}

              {/* Desglose financiero */}
              <div style={{background:"var(--bg2)",borderRadius:9,padding:"8px 10px",marginBottom:8}}>
                <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
                  <div><div style={{fontSize:8,color:"var(--muted)",fontWeight:700}}>Cliente paga</div><div style={{fontSize:13,fontWeight:800,color:"var(--gold)"}}>${et.customerTotal}</div></div>
                  <div>
                    <div style={{fontSize:8,color:"var(--muted)",fontWeight:700}}>Tu ganancia (delivery)</div>
                    <div style={{fontSize:13,fontWeight:800,color:"var(--green)"}}>${et.driverEarnings}</div>
                    {o.deliveryDistKm && <div style={{fontSize:8,color:"var(--muted)",marginTop:1}}>📏 {o.deliveryDistKm} km · {o.deliveryLabel||"Estándar"}</div>}
                  </div>
                  {cf&&<div><div style={{fontSize:8,color:"var(--muted)",fontWeight:700}}>Debes App</div><div style={{fontSize:13,fontWeight:800,color:"var(--red)"}}>${cf.debtToApp}</div></div>}
                  <div><div style={{fontSize:8,color:"var(--muted)",fontWeight:700}}>Método</div><div style={{fontSize:10,fontWeight:700,color:"var(--text)"}}>{o.paymentMethod==="YAPPY"?"📱 Yappy":"💵 Efectivo"}</div></div>
                </div>
              </div>

              <div className="row" style={{gap:7,justifyContent:"flex-end",flexWrap:"wrap"}}>
                {/* Estado: PENDIENTE — Esperando aprobación del vendedor */}
                {fase === "espera" && (
                  <div style={{padding:"7px 13px",background:"rgba(244,196,48,.08)",border:"1px dashed rgba(244,196,48,.3)",borderRadius:9,color:"var(--gold)",fontSize:11,fontWeight:700,fontFamily:"'DM Sans'",display:"flex",alignItems:"center",gap:5}}>
                    ⏳ Esperando aprobación del vendedor
                  </div>
                )}

                {/* FASE 1 — PICKUP: navegar al vendedor + confirmar recogida */}
                {fase === "pickup" && (
                  <>
                    <button onClick={()=>abrirNavegacion(o, {lat: vendorInfo.lat, lng: vendorInfo.lng, label: `🏪 ${vendorInfo.name} · ${vendorInfo.zone}`})}
                      style={{padding:"7px 13px",background:"rgba(244,196,48,.12)",border:"1px solid rgba(244,196,48,.3)",borderRadius:9,color:"var(--gold)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'",display:"flex",alignItems:"center",gap:5}}>
                      🗺️ Cómo llegar al vendedor
                    </button>
                    {/* PASO 1A — Iniciar recogida (asignarse a sí mismo el pedido) */}
                    {!o.pickupStarted && onStartPickup && (
                      <button onClick={()=>onStartPickup(o.id)}
                        style={{padding:"7px 13px",background:"linear-gradient(135deg,#3B9EFF,#2585E5)",border:"none",borderRadius:9,color:"#fff",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                        🛵 Iniciar recogida
                      </button>
                    )}
                    {/* PASO 1B — Confirmar recogida (solo aparece después de iniciar) */}
                    {o.pickupStarted && onAssign && (
                      <button onClick={async ()=>{
                        // Capturar ubicación inicial antes de marcar EN_CAMINO
                        try {
                          const pos = await new Promise((resolve, reject) => {
                            navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 8000 });
                          });
                          await fbWrite(`ubicaciones/${repartidorUserId}`, {
                            lat: pos.coords.latitude,
                            lng: pos.coords.longitude,
                            timestamp: Date.now(),
                            precision: pos.coords.accuracy,
                            velocidad: 0,
                            activo: true
                          });
                        } catch(e) {
                          console.warn("No se pudo obtener GPS inicial:", e.message);
                        }
                        // Marcar como EN_CAMINO (recogió → ahora va al cliente)
                        onAssign(o.id);
                        // Sugerir navegación al cliente automáticamente
                        setTimeout(() => abrirNavegacion(o), 300);
                      }} style={{padding:"7px 13px",background:"linear-gradient(135deg,#00E5A0,#00C088)",border:"none",borderRadius:9,color:"#08111F",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                        ✅ Recogí el pedido
                      </button>
                    )}
                  </>
                )}

                {/* FASE 2 — DROPOFF: navegar al cliente + marcar entregado */}
                {fase === "dropoff" && (
                  <>
                    <button onClick={()=>abrirNavegacion(o)} style={{padding:"7px 13px",background:"rgba(59,158,255,.12)",border:"1px solid rgba(59,158,255,.3)",borderRadius:9,color:"var(--blue)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'",display:"flex",alignItems:"center",gap:5}}>
                      🗺️ Cómo llegar al cliente
                    </button>
                    {onDeliver && (
                      <button onClick={()=>handleDeliver(o.id)} style={{padding:"7px 13px",background:"linear-gradient(135deg,#00D68F,#00B077)",border:"none",borderRadius:9,color:"#08111F",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans'"}}>
                        ✓ Marcar entregado
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </>}
      {/* ── TAB: BATCH ── */}
      {rTab==="batch"&&<>
        <div style={{background:"rgba(255,75,110,.07)",border:"1px solid rgba(255,75,110,.2)",borderRadius:11,padding:"9px 13px",display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
          <Ic n="zap" s={14} c="var(--red)"/>
          <div style={{flex:1}}>
            <div style={{fontSize:11,color:"var(--red)",fontWeight:800}}>Viaje Agrupado Disponible</div>
            <div style={{fontSize:10,color:"var(--muted)"}}>3 pedidos · Torre Pacific PH · mismo edificio</div>
          </div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"var(--gold)",letterSpacing:1}}>
            ${demoBatch.riderTotalPayout}
          </div>
        </div>

        {/* Algoritmo de agrupación — visual explicativo */}
        <div className="card" style={{marginBottom:10}}>
          <div className="sec" style={{marginBottom:9}}>Algoritmo de Agrupación</div>
          {[
            {icon:"⏱",l:"Ventana de tiempo",  v:"10 minutos",                    c:"var(--blue)"},
            {icon:"📍",l:"Criterio GPS",       v:"≤ 500 m o mismo edificio",      c:"var(--gold)"},
            {icon:"📦",l:"Máximo por viaje",   v:"5 pedidos",                     c:"var(--purple)"},
            {icon:"✅",l:"Pedidos agrupados",  v:`${demoBatch.orderCount} / ${BATCH.MAX_ORDERS}`,c:"var(--green)"},
          ].map(r=>(
            <div key={r.l} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:7}}>
              <div style={{display:"flex",gap:8,alignItems:"center"}}>
                <span style={{fontSize:16,width:22,textAlign:"center",flexShrink:0}}>{r.icon}</span>
                <span style={{fontSize:11,color:"var(--muted)"}}>{r.l}</span>
              </div>
              <span style={{fontSize:12,fontWeight:800,color:r.c}}>{r.v}</span>
            </div>
          ))}
        </div>

        <BatchTripCard
          batch={demoBatch}
          isActive={batchAccepted}
          onAccept={()=>setBatchAccepted(true)}
          onDecline={()=>setRTab("inicio")}
        />
      </>}

      {/* ── TAB: CALCULADORA ── */}
      {rTab==="calculadora"&&<>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:22,color:"var(--gold)",letterSpacing:2,marginBottom:14}}>CALCULADORA DE PAGO</div>

        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9,marginBottom:9}}>
          {[
            {l:"Valor Billete",id:"lot",val:calcLottery,fn:setCalcLottery},
            {l:"Delivery Fee", id:"del",val:calcDelivery,fn:setCalcDelivery},
            {l:"Propina",      id:"tip",val:calcTip,     fn:setCalcTip},
          ].map(({l,id,val,fn})=>(
            <div key={id}>
              <div style={{fontSize:10,color:"var(--muted)",fontWeight:700,marginBottom:5,textTransform:"uppercase",letterSpacing:.5}}>{l}</div>
              <div style={{position:"relative"}}>
                <span style={{position:"absolute",left:11,top:"50%",transform:"translateY(-50%)",fontSize:13,color:"var(--muted)"}}>$</span>
                <input className="inp" type="number" value={val} min="0" step="0.25" style={{paddingLeft:24}}
                  onChange={e=>fn(e.target.value)}/>
              </div>
            </div>
          ))}
          <div>
            <div style={{fontSize:10,color:"var(--muted)",fontWeight:700,marginBottom:5,textTransform:"uppercase",letterSpacing:.5}}>Método</div>
            <div style={{display:"flex",gap:6}}>
              {["efectivo","yappy"].map(m=>(
                <button key={m} onClick={()=>setCalcMethod(m)} style={{flex:1,padding:"10px 6px",borderRadius:11,border:`1.5px solid ${calcMethod===m?"var(--gold)":"var(--border)"}`,background:calcMethod===m?"rgba(244,196,48,.1)":"var(--bg2)",cursor:"pointer",fontSize:11,fontWeight:700,color:calcMethod===m?"var(--gold)":"var(--muted)",fontFamily:"'DM Sans'"}}>
                  {m==="yappy"?"📱 Yappy":"💵 Efect."}
                </button>
              ))}
            </div>
          </div>
        </div>

        {liveT&&<>
          {/* Resumen comprador */}
          <div className="card">
            <div className="sec" style={{marginBottom:8}}>Lo que paga el Cliente</div>
            {[
              {l:"Billete",         v:`$${liveT.lotteryValue}`},
              {l:"Service fee",     v:`$${liveT.serviceFee}`},
              {l:"Delivery",        v:`$${liveT.deliveryFee}`},
              {l:"Propina",         v:`$${liveT.tip}`},
            ].map(({l,v})=>(
              <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
                <span style={{fontSize:12,color:"var(--muted)"}}>{l}</span>
                <span style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>{v}</span>
              </div>
            ))}
            <div className="div" style={{margin:"6px 0"}}/>
            <div style={{display:"flex",justifyContent:"space-between"}}>
              <span style={{fontWeight:800,fontSize:14}}>TOTAL</span>
              <span style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:1}}>${liveT.customerTotal}</span>
            </div>
          </div>

          {/* Tu ganancia */}
          <div className="card" style={{border:"1px solid rgba(0,214,143,.25)",background:"rgba(0,214,143,.04)"}}>
            <div className="sec" style={{marginBottom:8,color:"var(--green)"}}>Tu Ganancia</div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
              <span style={{fontSize:12,color:"var(--muted)"}}>Delivery (100%)</span>
              <span style={{fontSize:12,fontWeight:700,color:"var(--green)"}}>${liveT.deliveryFee}</span>
            </div>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
              <span style={{fontSize:12,color:"var(--muted)"}}>Propina (100%)</span>
              <span style={{fontSize:12,fontWeight:700,color:"var(--green)"}}>${liveT.tip}</span>
            </div>
            <div className="div" style={{margin:"6px 0"}}/>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontWeight:800,fontSize:14}}>GANAS</span>
              <span style={{fontFamily:"'Bebas Neue'",fontSize:28,color:"var(--green)",letterSpacing:1}}>${liveT.driverEarnings}</span>
            </div>
          </div>

          {/* Flujo según método */}
          {calcMethod==="efectivo"&&(()=>{
            const cf = calcCashFlow(liveT);
            return (
              <div className="card" style={{border:"1px solid rgba(255,75,110,.22)",background:"rgba(255,75,110,.04)"}}>
                <div className="sec" style={{marginBottom:8,color:"var(--red)"}}>Flujo Efectivo — debes liquidar</div>
                {[
                  {l:"1. Cobras al cliente",            v:fromCents(liveT._customerTotal),c:"var(--gold)"},
                  {l:"2. Pagas al vendedor (−2.5%)",    v:fromCents(liveT._vendor),c:"var(--blue)"},
                  {l:"3. Debes a App (service fee)",    v:fromCents(liveT._appSvc),c:"var(--red)"},
                  {l:"4. Retienes (delivery+propina)",  v:fromCents(liveT._driver),c:"var(--green)"},
                ].map(({l,v,c})=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontSize:11,color:"var(--muted)",flex:1}}>{l}</span>
                    <span style={{fontSize:12,fontWeight:800,color:c,flexShrink:0}}>{v}</span>
                  </div>
                ))}
                <div style={{fontSize:9,color:"var(--muted)",marginTop:6,padding:"6px 10px",background:"rgba(244,196,48,.06)",borderRadius:7}}>
                  {cf.commissionNote}
                </div>
              </div>
            );
          })()}
          {calcMethod==="yappy"&&(()=>{
            const yf = calcYappyFlow(liveT);
            return (
              <div className="card" style={{border:"1px solid rgba(59,158,255,.22)",background:"rgba(59,158,255,.04)"}}>
                <div className="sec" style={{marginBottom:8,color:"var(--blue)"}}>Flujo Yappy — automático</div>
                {[
                  {l:"App recibe de Yappy",         v:yf.receivedFromCustomer,c:"var(--blue)"},
                  {l:"App acredita al vendedor",    v:yf.creditedToVendor,    c:"var(--gold)"},
                  {l:"App acredita a tu billetera", v:yf.creditedToDriver,    c:"var(--green)"},
                  {l:"App retiene",                 v:yf.appRetains,          c:"var(--muted)"},
                ].map(({l,v,c})=>(
                  <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{fontSize:11,color:"var(--muted)",flex:1}}>{l}</span>
                    <span style={{fontSize:12,fontWeight:800,color:c,flexShrink:0}}>${v}</span>
                  </div>
                ))}
                <div style={{fontSize:10,color:"var(--blue)",marginTop:6,fontWeight:700}}>✓ Sin deuda. Sin efectivo. Pago automático.</div>
              </div>
            );
          })()}

          <button className="btn" style={{marginBottom:8}} onClick={simulateDelivery}>
            + Simular esta entrega al balance
          </button>
        </>}
      </>}

      {/* ── TAB: LIQUIDACIÓN ── */}
      {rTab==="liquidacion"&&<>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:"var(--gold)",letterSpacing:2,marginBottom:14}}>RESUMEN DE LIQUIDACIÓN</div>

        {/* Billetera */}
        <div className="wallet">
          <div style={{fontSize:9,color:"var(--muted)",fontWeight:800,textTransform:"uppercase",letterSpacing:1.5}}>Saldo Billetera</div>
          <div style={{fontFamily:"'Bebas Neue'",fontSize:40,color:"var(--gold)",letterSpacing:2,lineHeight:1,margin:"5px 0"}}>{fmt(balance.wallet)}</div>
          <div style={{display:"flex",gap:10}}>
            <div style={{flex:1,background:"rgba(0,214,143,.08)",borderRadius:10,padding:"8px 10px",border:"1px solid rgba(0,214,143,.18)"}}>
              <div style={{fontSize:9,color:"var(--muted)"}}>💵 Efectivo en mano</div>
              <div style={{fontSize:15,fontWeight:800,color:"var(--gold)",marginTop:2}}>{fmt(balance.cashHeld)}</div>
            </div>
            <div style={{flex:1,background:"rgba(59,158,255,.08)",borderRadius:10,padding:"8px 10px",border:"1px solid rgba(59,158,255,.18)"}}>
              <div style={{fontSize:9,color:"var(--muted)"}}>📱 Yappy acreditado</div>
              <div style={{fontSize:15,fontWeight:800,color:"var(--blue)",marginTop:2}}>{fmt(balance.yappyBalance)}</div>
            </div>
          </div>
        </div>

        {/* Ganancia del día */}
        <div className="card">
          <div className="sec" style={{marginBottom:10}}>Ganancia del Día</div>
          {[
            {l:"Total ganado (delivery + propinas)", v:fmt(balance.earned), c:"var(--green)"},
            {l:"Entregas realizadas",                v:String(balance.deliveries), c:"var(--text)"},
          ].map(({l,v,c})=>(
            <div key={l} style={{display:"flex",justifyContent:"space-between",marginBottom:7}}>
              <span style={{fontSize:13,color:"var(--muted)"}}>{l}</span>
              <span style={{fontSize:15,fontWeight:800,color:c}}>{v}</span>
            </div>
          ))}
        </div>

        {/* Deuda pendiente */}
        {balance.debtToApp>0?(
          <div className="card" style={{border:"1px solid rgba(255,75,110,.28)",background:"rgba(255,75,110,.05)"}}>
            <div className="sec" style={{marginBottom:8,color:"var(--red)"}}>⚠️ Deuda Pendiente con App</div>
            <div style={{fontSize:11,color:"var(--muted)",marginBottom:8,lineHeight:1.5}}>
              Por pedidos en efectivo no liquidados. Corresponde al service fee ($1.00 por pedido).
              La comisión 2.5% ya fue descontada del vendedor.
            </div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
              <span style={{fontSize:14,color:"var(--text)",fontWeight:700}}>Total a liquidar</span>
              <span style={{fontFamily:"'Bebas Neue'",fontSize:28,color:"var(--red)",letterSpacing:1}}>{fmt(balance.debtToApp)}</span>
            </div>
            <button className="btn" style={{background:"linear-gradient(135deg,var(--red),#cc2a4e)"}} onClick={settleDebt}>
              Liquidar {fmt(balance.debtToApp)} vía Yappy
            </button>
          </div>
        ):(
          <div className="card" style={{border:"1px solid rgba(0,214,143,.25)",background:"rgba(0,214,143,.06)",textAlign:"center"}}>
            <div style={{fontSize:32,marginBottom:6}}>✓</div>
            <div style={{fontWeight:800,fontSize:14,color:"var(--green)"}}>Sin deudas pendientes</div>
            <div style={{fontSize:11,color:"var(--muted)",marginTop:3}}>Estás al día con la App</div>
          </div>
        )}

        {/* Guía de comisiones */}
        <div className="card" style={{marginTop:4}}>
          <div className="sec" style={{marginBottom:10}}>¿Cómo funciona tu pago?</div>
          {[
            {icon:"🎟",l:"Delivery fee","d":"100% para ti, siempre",c:"var(--green)"},
            {icon:"💰",l:"Propinas","d":"100% para ti",c:"var(--green)"},
            {icon:"📊",l:"Comisión 2.5%","d":"La paga el VENDEDOR (no tú)",c:"var(--gold)"},
            {icon:"💵",l:"Service fee $1.00","d":"Efectivo: debes a App / Yappy: automático",c:"var(--red)"},
          ].map(({icon,l,d,c})=>(
            <div key={l} style={{display:"flex",gap:10,alignItems:"flex-start",marginBottom:10}}>
              <span style={{fontSize:18,width:26,textAlign:"center",flexShrink:0}}>{icon}</span>
              <div>
                <div style={{fontWeight:700,fontSize:13,color:c}}>{l}</div>
                <div style={{fontSize:11,color:"var(--muted)"}}>{d}</div>
              </div>
            </div>
          ))}
        </div>
      </>}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   SPLASH + ROLE SELECT
═══════════════════════════════════════════════════════ */
function SplashScreen({ onNext }) {
  const [sorteoTab, setSorteoTab] = useState("MIERCOLITO");
  const sorted = [...SORTEOS_RECIENTES].sort((a,b)=>{
    const order=["MIERCOLITO","DOMINICAL","GORDITO","EXTRAORDINARIA"];
    return order.indexOf(a.tipo)-order.indexOf(b.tipo);
  });
  const sel = sorted.find(s=>s.tipo===sorteoTab)||sorted[0];
  const cols=["var(--gold)","var(--blue)","var(--green)"];

  return (
    <div style={{
      background:"linear-gradient(180deg,var(--bg) 0%,var(--bg2) 100%)",
      height:"100%",display:"flex",flexDirection:"column",
      alignItems:"center",padding:"28px 18px 24px",
      position:"relative",overflow:"hidden",overflowY:"auto"
    }}>
      {/* Glow de fondo */}
      <div style={{position:"absolute",top:-60,left:"50%",transform:"translateX(-50%)",
        width:300,height:300,borderRadius:"50%",
        background:"radial-gradient(circle,rgba(244,196,48,.09),transparent 70%)",
        pointerEvents:"none"}}/>

      {/* Logo */}
      <ChanceLogo height={80} style={{marginBottom:6}}/>
      <div style={{fontSize:9,color:"var(--muted)",letterSpacing:4,
        textTransform:"uppercase",textAlign:"center",marginBottom:18,fontWeight:600}}>
        Lotería Nacional · Panamá
      </div>

      {/* Tabs de sorteo */}
      <div style={{display:"flex",gap:5,overflowX:"auto",paddingBottom:4,
        scrollbarWidth:"none",marginBottom:10,width:"100%",justifyContent:"center"}}>
        {sorted.map(s=>(
          <button key={s.tipo}
            onClick={()=>setSorteoTab(s.tipo)}
            style={{
              flexShrink:0,padding:"5px 10px",borderRadius:20,
              background:sorteoTab===s.tipo?s.bg:"transparent",
              border:`1px solid ${sorteoTab===s.tipo?s.border:"rgba(255,255,255,.1)"}`,
              color:sorteoTab===s.tipo?s.color:"var(--muted)",
              fontSize:9,fontWeight:800,letterSpacing:.5,
              cursor:"pointer",fontFamily:"'DM Sans'",
              display:"flex",alignItems:"center",gap:4,transition:"all .2s"
            }}>
            <span>{s.icon}</span><span>{s.tipo}</span>
          </button>
        ))}
      </div>

      {/* Sorteo card — igual al módulo Comprador */}
      <div className="sort-card" style={{
        background:sel.bg,borderColor:sel.border,
        width:"100%",marginBottom:14
      }}>
        <div style={{position:"absolute",right:-20,top:-20,width:90,height:90,
          borderRadius:"50%",background:sel.bg}}/>

        {/* Cabecera: tipo + premio mayor */}
        <div className="row" style={{justifyContent:"space-between",marginBottom:10}}>
          <div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:sel.color,
              letterSpacing:3,lineHeight:1}}>{sel.icon} {sel.tipo}</div>
            <div style={{fontSize:9,color:"var(--muted)",marginTop:2}}>
              {sel.fecha} · Sorteo Nº {sel.sorteoN}
            </div>
          </div>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,
              textTransform:"uppercase"}}>Premio Mayor</div>
            <div style={{fontFamily:"'Bebas Neue'",fontSize:26,color:sel.color,
              letterSpacing:2,lineHeight:1}}>{sel.premioMayor}</div>
          </div>
        </div>

        {/* Premios 1er / 2do / 3er */}
        <div style={{display:"flex",gap:7,marginBottom:sel.proximoISO?10:0}}>
          {sel.premios.map((p,pi)=>(
            <div key={p.pos} style={{flex:1,background:"rgba(8,17,31,.4)",
              borderRadius:10,padding:"8px 4px",textAlign:"center"}}>
              <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,
                textTransform:"uppercase",letterSpacing:.4,marginBottom:3}}>{p.pos}</div>
              <div style={{fontFamily:"'Bebas Neue'",
                fontSize:p.num.length>4?13:18,
                color:cols[pi],letterSpacing:1,lineHeight:1}}>{p.num}</div>
              {p.letras&&<div style={{fontSize:7,color:sel.color,fontWeight:800,
                marginTop:2,letterSpacing:.4}}>{p.letras}</div>}
              {p.serie&&<div style={{fontSize:7,color:"var(--muted)",marginTop:1}}>
                S{p.serie} F{p.folio}</div>}
            </div>
          ))}
        </div>

        {/* Countdown próximo sorteo */}
        {sel.proximoISO&&(
          <div style={{paddingTop:9,borderTop:`1px solid ${sel.border}`}}>
            <div style={{fontSize:8,color:"var(--muted)",fontWeight:700,
              textTransform:"uppercase",letterSpacing:1,marginBottom:6}}>
              Próximo · {sel.frecuencia} · 3:00 PM
            </div>
            <SorteoCountdown isoDateStr={sel.proximoISO} color={sel.color} border={sel.border}/>
          </div>
        )}
      </div>

      {/* Botones */}
      <div style={{width:"100%",display:"flex",flexDirection:"column",gap:9,marginTop:"auto"}}>
        <button className="btn" onClick={onNext}>Comenzar</button>
        <button className="btng" style={{opacity:.75}}>Ya tengo cuenta</button>
      </div>

      {/* Badge oficial */}
      <div style={{marginTop:12,display:"flex",gap:6,alignItems:"center"}}>
        <Ic n="shield" s={11} c="var(--muted)"/>
        <span style={{fontSize:9,color:"var(--muted)",fontWeight:600}}>
          Datos oficiales · lnb.gob.pa · 100% Seguro
        </span>
      </div>
    </div>
  );
}

function RoleSelect({ onSelect }) {
  return (
    <div className="sc fu">
      <div style={{textAlign:"center",paddingTop:14,marginBottom:20}}>
        <div style={{fontFamily:"'Bebas Neue'",fontSize:36,color:"var(--gold)",letterSpacing:4}}>CHANCE</div>
        <div style={{fontSize:12,color:"var(--muted)",fontWeight:600}}>¿Cómo vas a usar la app?</div>
      </div>
      {[
        {role:"cliente",  emoji:"🛒",l:"Soy Comprador",  d:"Busca y compra billetes y chances"},
        {role:"vendedor", emoji:"🏪",l:"Soy Vendedor",   d:"Gestiona tu inventario y ventas"},
        {role:"repartidor",emoji:"🛵",l:"Soy Repartidor",d:"Gestiona tus entregas y ganancias"},
      ].map(({role,emoji,l,d})=>(
        <div key={role} className="card" style={{cursor:"pointer",display:"flex",alignItems:"center",gap:13,marginBottom:9}} onClick={()=>onSelect(role)}>
          <div style={{width:50,height:50,borderRadius:15,background:"rgba(244,196,48,.08)",border:"1px solid rgba(244,196,48,.18)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:24,flexShrink:0}}>{emoji}</div>
          <div style={{flex:1}}>
            <div style={{fontWeight:800,fontSize:14,color:"var(--text)",marginBottom:2}}>{l}</div>
            <div style={{fontSize:12,color:"var(--muted)"}}>{d}</div>
          </div>
          <Ic n="chevR" s={17} c="var(--muted)"/>
        </div>
      ))}
    </div>
  );
}

/* ═══ NOTIFICACIONES / PERFIL ════════════════════════ */
function NotifScreen() {
  const notifs=[
    {ic:"🛵",t:"Tu pedido está en camino",s:"#CH-2408 · Juan a 15 min",time:"Hace 5 min",c:"var(--gold)",u:true},
    {ic:"🏆",t:"Resultados del Miercolito",s:"Sorteo 3058 · 01 Abr 2026",time:"Hace 2h",c:"var(--blue)",u:true},
    {ic:"✅",t:"Pedido entregado",s:"#CH-2398 · Chance #07 × 10",time:"Ayer",c:"var(--green)",u:false},
    {ic:"💥",t:"Próximo sorteo en 2 días",s:"Miercolito · 8 Abr · 3:00 PM",time:"Ayer",c:"var(--gold)",u:false},
  ];
  return (
    <div className="sc fu">
      <div style={{fontFamily:"'Bebas Neue'",fontSize:24,color:"var(--gold)",letterSpacing:2,marginBottom:12}}>NOTIFICACIONES</div>
      {notifs.map((n,i)=>(
        <div key={i} className="card" style={{display:"flex",gap:10,border:n.u?"1px solid rgba(244,196,48,.18)":"1px solid var(--border)",background:n.u?"rgba(244,196,48,.02)":"var(--bg2)",marginBottom:8}}>
          <div style={{width:38,height:38,borderRadius:11,background:`${n.c}16`,border:`1px solid ${n.c}26`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{n.ic}</div>
          <div style={{flex:1}}>
            <div className="row" style={{justifyContent:"space-between"}}>
              <div style={{fontWeight:700,fontSize:12,color:"var(--text)"}}>{n.t}</div>
              {n.u&&<div style={{width:6,height:6,borderRadius:"50%",background:"var(--gold)",flexShrink:0}}/>}
            </div>
            <div style={{fontSize:10,color:"var(--muted)",margin:"2px 0"}}>{n.s}</div>
            <div style={{fontSize:9,color:"var(--muted)",opacity:.7}}>{n.time}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function PerfilScreen({ authUser=null, onLogout=null, currentRole=null, onSwitchRole=null }) {
  const [switchedToComprador, setSwitchedToComprador] = useState(currentRole==="cliente");

  // Initials from name
  const initials = authUser?.nombre
    ? authUser.nombre.split(" ").map(w=>w[0]).slice(0,2).join("").toUpperCase()
    : "U";

  const baseRole = authUser?.rol || "cliente"; // original role from registration
  const isVendedor   = baseRole==="vendedor";
  const isRepartidor = baseRole==="repartidor";
  const canSwitchRole = isVendedor || isRepartidor;
  const activeRole   = currentRole || baseRole;
  const showingAsComprador = activeRole==="cliente" && canSwitchRole;

  const roleColor  = baseRole==="vendedor"?"#FFCC33":baseRole==="repartidor"?"#4DB5FF":"#00E5A0";
  const roleEmoji  = baseRole==="vendedor"?"🏪":baseRole==="repartidor"?"🛵":"🛒";
  const roleLabel  = baseRole==="vendedor"?"Vendedor":baseRole==="repartidor"?"Repartidor":"Comprador";

  return (
    <div className="sc fu">
      {/* ── HEADER PERFIL ── */}
      <div style={{background:"linear-gradient(145deg,var(--bg2),var(--bg3))",border:`1px solid ${roleColor}22`,borderRadius:20,padding:18,marginBottom:14,textAlign:"center"}}>
        <div style={{
          width:66,height:66,borderRadius:"50%",
          background:`${roleColor}18`,border:`2px solid ${roleColor}50`,
          display:"flex",alignItems:"center",justifyContent:"center",
          margin:"0 auto 10px",fontFamily:"'Bebas Neue'",fontSize:24,color:roleColor
        }}>{initials}</div>
        <div style={{fontWeight:800,fontSize:16,color:"var(--text)",marginBottom:2}}>
          {authUser?.nombre || "Usuario"}
        </div>
        <div style={{fontSize:11,color:"var(--muted)",marginBottom:6}}>{authUser?.email}</div>
        {/* Badge de rol */}
        <div style={{display:"inline-flex",alignItems:"center",gap:5,padding:"4px 12px",borderRadius:12,background:`${roleColor}18`,border:`1px solid ${roleColor}40`,marginBottom:10}}>
          <span style={{fontSize:14}}>{roleEmoji}</span>
          <span style={{fontSize:11,fontWeight:800,color:roleColor,letterSpacing:.4}}>{roleLabel}</span>
          {canSwitchRole&&showingAsComprador&&(
            <span style={{fontSize:9,color:"var(--muted)",fontWeight:600,marginLeft:4}}>· modo comprador</span>
          )}
        </div>
        {/* Stats */}
        <div className="row" style={{justifyContent:"center",gap:22}}>
          {[["12","Pedidos"],["5","Billetes"],["3","Chances"]].map(([n,l])=>(
            <div key={l} style={{textAlign:"center"}}>
              <div style={{fontFamily:"'Bebas Neue'",fontSize:20,color:roleColor,letterSpacing:1}}>{n}</div>
              <div style={{fontSize:9,color:"var(--muted)",fontWeight:700}}>{l}</div>
            </div>
          ))}
        </div>
      </div>

      {/* ── CAMBIO DE ROL (solo Vendedor / Repartidor) ── */}
      {canSwitchRole&&(
        <div style={{background:"rgba(255,255,255,.03)",border:"1px solid rgba(255,255,255,.1)",borderRadius:16,padding:"16px",marginBottom:14}}>
          <div className="sec" style={{marginBottom:12}}>Cambiar modo de uso</div>
          <div style={{display:"flex",gap:8}}>
            {/* Botón volver a rol principal */}
            <button
              onClick={()=>onSwitchRole&&onSwitchRole(baseRole)}
              style={{
                flex:1,padding:"12px 8px",borderRadius:13,cursor:"pointer",
                fontFamily:"'DM Sans'",fontWeight:700,fontSize:12,
                border:`2px solid ${!showingAsComprador?roleColor+"80":"rgba(255,255,255,.12)"}`,
                background:!showingAsComprador?`${roleColor}14`:"transparent",
                color:!showingAsComprador?roleColor:"var(--muted)",
                transition:"all .2s"
              }}>
              <div style={{fontSize:20,marginBottom:4}}>{roleEmoji}</div>
              <div>{roleLabel}</div>
              <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>Mi rol principal</div>
            </button>
            {/* Botón modo Comprador */}
            <button
              onClick={()=>onSwitchRole&&onSwitchRole("cliente")}
              style={{
                flex:1,padding:"12px 8px",borderRadius:13,cursor:"pointer",
                fontFamily:"'DM Sans'",fontWeight:700,fontSize:12,
                border:`2px solid ${showingAsComprador?"#00E5A080":"rgba(255,255,255,.12)"}`,
                background:showingAsComprador?"rgba(0,229,160,.1)":"transparent",
                color:showingAsComprador?"#00E5A0":"var(--muted)",
                transition:"all .2s"
              }}>
              <div style={{fontSize:20,marginBottom:4}}>🛒</div>
              <div>Comprador</div>
              <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>Comprar tickets</div>
            </button>
          </div>
          <div style={{fontSize:10,color:"var(--muted)",marginTop:10,lineHeight:1.6,textAlign:"center"}}>
            Puedes alternar entre tu rol de <strong style={{color:roleColor}}>{roleLabel}</strong> y el módulo de <strong style={{color:"#00E5A0"}}>Comprador</strong> en cualquier momento.
          </div>
        </div>
      )}

      {/* ── INFO DEL USUARIO ── */}
      {authUser&&(
        <div className="card" style={{marginBottom:12}}>
          <div className="sec" style={{marginBottom:10}}>Información personal</div>
          {[
            {ic:"user",  l:"Cédula",    v:authUser.cedula||"—"},
            {ic:"phone", l:"Teléfono",  v:authUser.telefono||"—"},
            {ic:"pin",   l:"Provincia", v:[authUser.provincia,authUser.distrito,authUser.corregimiento].filter(Boolean).join(" · ")||"—"},
            authUser.numeroBilletero&&{ic:"star",l:"Nº Billetero",v:authUser.numeroBilletero},
            authUser.vehiculo&&{ic:"truck",l:"Vehículo",v:authUser.vehiculo},
            authUser.banco&&{ic:"wallet",l:"Banco",v:authUser.banco+(authUser.tipoCuenta?` · ${authUser.tipoCuenta}`:"")},
          ].filter(Boolean).map(item=>(
            <div key={item.l} className="row" style={{justifyContent:"space-between",marginBottom:8}}>
              <div className="row" style={{gap:8}}>
                <div style={{width:28,height:28,borderRadius:8,background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center"}}>
                  <Ic n={item.ic} s={12} c="var(--muted)"/>
                </div>
                <span style={{fontSize:12,color:"var(--muted)"}}>{item.l}</span>
              </div>
              <span style={{fontSize:12,fontWeight:700,color:"var(--text)",textAlign:"right",maxWidth:"55%"}}>{item.v}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── MENÚ OPCIONES ── */}
      {[
        {title:"Mi Cuenta",items:[{ic:"edit",l:"Editar perfil"},{ic:"pin",l:"Mis direcciones"},{ic:"shield",l:"Seguridad y 2FA"}]},
        {title:"Preferencias",items:[{ic:"bell",l:"Notificaciones push",tog:true},{ic:"star",l:"Sorteos favoritos"}]},
        {title:"Soporte",items:[{ic:"info",l:"Preguntas frecuentes"},{ic:"phone",l:"Soporte 24/7"}]},
      ].map(sec=>(
        <div key={sec.title} style={{marginBottom:12}}>
          <div className="sec">{sec.title}</div>
          <div className="card" style={{padding:0,overflow:"hidden"}}>
            {sec.items.map((item,i)=>(
              <div key={item.l} className="row" style={{justifyContent:"space-between",padding:"12px 15px",borderBottom:i<sec.items.length-1?"1px solid var(--border)":"none",cursor:"pointer"}}>
                <div className="row" style={{gap:9}}>
                  <div style={{width:30,height:30,borderRadius:8,background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n={item.ic} s={13} c="var(--muted)"/></div>
                  <span style={{fontWeight:600,fontSize:12,color:"var(--text)"}}>{item.l}</span>
                </div>
                {item.tog?<button className="tog" style={{background:"var(--gold)",border:"1px solid var(--gold)"}}><div className="tgt" style={{left:23}}/></button>:<Ic n="chevR" s={15} c="var(--muted)"/>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* ── ZONA DEMO/PRUEBAS: Limpiar todos los datos ── */}
      <button
        onClick={async () => {
          if (!confirm("⚠️ Esto borrará TODOS los pedidos, billetes y chances de Firebase para empezar pruebas limpias.\n\n¿Continuar?")) return;
          try {
            // Limpiar todo en Firebase
            await Promise.all([
              fbWrite("pedidos", []),
              fbWrite("billetes", []),
              fbWrite("chances", []),
              fetch(`${FB_DB_URL}/ubicaciones.json`, { method: "DELETE" }),
            ]);
            alert("✅ Datos limpiados. La app se recargará.");
            window.location.reload();
          } catch(e) {
            alert("Error: " + e.message);
          }
        }}
        style={{width:"100%",padding:"11px",borderRadius:14,background:"rgba(244,196,48,.07)",border:"1px dashed rgba(244,196,48,.3)",color:"var(--gold)",fontFamily:"'DM Sans'",fontWeight:700,fontSize:12,cursor:"pointer",marginBottom:10}}>
        🧹 Limpiar datos demo (Firebase)
      </button>

      {/* ── CERRAR SESIÓN ── */}
      <button
        onClick={onLogout}
        style={{width:"100%",padding:"13px",borderRadius:14,background:"rgba(255,75,110,.07)",border:"1px solid rgba(255,75,110,.18)",color:"var(--red)",fontFamily:"'DM Sans'",fontWeight:700,fontSize:14,cursor:"pointer"}}>
        🚪 Cerrar sesión
      </button>
      <div style={{height:14}}/>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════
   NAV + APP PRINCIPAL — Estado Compartido Interconectado
═══════════════════════════════════════════════════════ */
const NAV={
  cliente:[
    {id:"home_cliente",  l:"Inicio",   ic:"home"},
    {id:"buscar",        l:"Buscar",   ic:"search"},
    {id:"historial",     l:"Pedidos",  ic:"history"},
    {id:"suerte",        l:"Mi Suerte",ic:"sparkle"},
    {id:"resultados",    l:"Sorteos",  ic:"trophy"},
    {id:"perfil_c",      l:"Perfil",   ic:"user"},
  ],
  vendedor:[
    {id:"home_vendedor", l:"Tablero",  ic:"home"},
    {id:"pedidos_v",     l:"Pedidos",  ic:"pkg"},
    {id:"kardex_v",      l:"Kardex",   ic:"grid"},
    {id:"perfil_v",      l:"Perfil",   ic:"user"},
  ],
  repartidor:[
    {id:"home_repartidor",l:"Inicio",  ic:"home"},
    {id:"entregas_r",    l:"Entregas", ic:"truck"},
    {id:"batch_r",       l:"Batch",    ic:"zap"},
    {id:"billetera_r",   l:"Billetera",ic:"wallet"},
  ],
};

function App({ forceRole=null, authUser=null, onLogout=null,
  sharedBilletes, setSharedBilletes,
  sharedChances, setSharedChances,
  sharedOrders, setSharedOrders,
  vendorActiveSorteo, setVendorActiveSorteo,
  activeVendors=VENDORS }) {
  const [phase,        setPhase]       = useState(forceRole?"app":"splash");
  const [role,         setRole]        = useState(forceRole);
  const [activeRole,   setActiveRole]  = useState(forceRole);
  // Initialize screen directly from forceRole so the correct home shows on first render
  const initScreen = forceRole==="vendedor"?"home_vendedor":forceRole==="repartidor"?"home_repartidor":forceRole==="cliente"?"home_cliente":null;
  const [screen,       setScreen]      = useState(initScreen);
  const [screenData,   setScreenData]  = useState(null);
  const [cart,         setCart]        = useState([]);

  // ── ESTADO COMPARTIDO GLOBAL (ahora viene de ChanceRoot, persistido en storage) ──

  /*
   ╔══════════════════════════════════════════════════════════════════════╗
   ║  CICLO DE VIDA — Negociación bidireccional (bucle infinito)          ║
   ║                                                                      ║
   ║  PENDIENTE ──────────────────────────────────────────► APROBADO      ║
   ║      │ (vendedor ajusta)              (vendedor ok)       │           ║
   ║      ▼                                                   │           ║
   ║  MODIFICADO ◄──── (vendedor re-modifica) ◄────────────   │           ║
   ║      │                                                   │           ║
   ║      ├─ cliente aprueba así ──────────────────────────► APROBADO     ║
   ║      ├─ cliente rechaza ────────────────────────────── CANCELADO     ║
   ║      └─ cliente propone reemplazo ──────────────────► REEMPLAZO     ║
   ║                                                            │         ║
   ║                                  REEMPLAZO ─────────────  │         ║
   ║                                      ├─ vendedor ok ──► APROBADO    ║
   ║                                      ├─ vendedor modifica ► MODIFICADO║
   ║                                      └─ vendedor rechaza ► CANCELADO ║
   ╚══════════════════════════════════════════════════════════════════════╝
  */

  const ts = () => new Date().toLocaleTimeString("es-PA",{hour:"2-digit",minute:"2-digit"});

  // Contadores para badges
  const pendingForVendor     = sharedOrders.filter(o=>o.status==="PENDIENTE").length;
  const replacementForVendor = sharedOrders.filter(o=>o.status==="REEMPLAZO").length;
  const vendorActionNeeded   = pendingForVendor + replacementForVendor;
  const modifiedForClient    = sharedOrders.filter(o=>o.status==="MODIFICADO").length;
  const approvedForDriver    = sharedOrders.filter(o=>o.status==="APROBADO").length;

  // ── HELPERS ──────────────────────────────────────────────────────────────

  /** Crear UN solo pedido consolidado con todos los items del carrito */
  const placeOrder = async (items, method, addr, deliveryMeta) => {
    if (!items?.length) return null;
    const id = `CH-${2408 + sharedOrders.length}`;
    const lotteryTotal = items.reduce((s,i) => s + i.price * i.qty, 0);
    // Datos del vendedor para tracking — incluyen su corregimiento real (no la zone hardcoded)
    const vendorIdOrder = items[0].vendorId || "V001";
    const vendorStaticOrder = getVendorCoords(vendorIdOrder);
    // El vendorUserId se toma del primer item del carrito (etiquetado al añadirlo).
    // Fallback legacy según el código del vendedor para demos viejos.
    const vendorUserIdOrder = items[0].vendorUserId
      || (vendorIdOrder === "V001" ? "vendedor_carlos"
        : vendorIdOrder === "V002" ? "vendedor_rosa"
        : "vendedor_carlos");

    // Intentar leer la última ubicación GPS conocida del vendedor en Firebase.
    // Si el vendedor tiene GPS activo, usamos esas coords. Si no, fallback al
    // VENDOR_COORDS estático. Esto resuelve el bug de "vendedor en Bella Vista
    // cuando realmente está en Brisas del Golf".
    let vendorLat = vendorStaticOrder.lat;
    let vendorLng = vendorStaticOrder.lng;
    try {
      const ubicVendedor = await fbRead(`ubicaciones/${vendorUserIdOrder}`);
      if (ubicVendedor && ubicVendedor.lat && ubicVendedor.lng) {
        // GPS reciente del vendedor (última hora)
        const ageMs = Date.now() - (ubicVendedor.timestamp || 0);
        if (ageMs < 60 * 60 * 1000) {
          vendorLat = ubicVendedor.lat;
          vendorLng = ubicVendedor.lng;
        }
      }
    } catch(e) { /* sin GPS, usar static */ }
    items.forEach(item => {
      if (item.type==="billete")
        setSharedBilletes(p=>p.map(b=>b.n===item.num?{...b,sold:Math.min(b.stock,b.sold+item.qty)}:b));
      else
        setSharedChances(p=>p.map(c=>c.n===item.num?{...c,sold:Math.min(c.stock,c.sold+item.qty)}:c));
    });
    setSharedOrders(p=>[...p,{
      id, type:items[0].type, num:items[0].num, qty:items[0].qty,
      items:items.map(i=>({type:i.type,num:i.num,qty:i.qty,price:i.price,subtotal:(i.price*i.qty).toFixed(2)})),
      itemCount:items.length, vendor:items[0].vendor||"Carlos Medina V001",
      vendorId: vendorIdOrder, lotteryValue:lotteryTotal.toFixed(2),
      vendorUserId: vendorUserIdOrder,
      // Zona aproximada del vendedor para mostrar al comprador en el mapa.
      // Prioridad: zona del item del carrito (vendedor real) > zona estática (demo).
      vendorZone:  items[0].vendorZone || vendorStaticOrder.zone,
      vendorLugar: items[0].vendorZone || vendorStaticOrder.zone,
      // Coordenadas del vendedor al momento del pedido (de GPS o fallback static).
      // El comprador usará esto para mostrar el círculo aproximado en el mapa.
      vendorLat,
      vendorLng,
      // Delivery dinámico según distancia (fallback $2.50 si no se calculó)
      deliveryFee: deliveryMeta?.fee || "2.50",
      deliveryDistKm: deliveryMeta?.distKm || null,
      deliveryLabel:  deliveryMeta?.label  || "Estándar",
      tip:"0", paymentMethod:method,
      deliveryAddr:addr?.label||"Casa",
      // ─── NUEVO: Dirección completa con coordenadas para GPS/navegación ───
      deliveryAddress: {
        label: addr?.label || "Casa",
        text: addr?.text || addr?.addr || "",
        lat: addr?.lat || 8.9824,
        lng: addr?.lng || -79.5199,
      },
      customerId: authUser?.id || "cliente_maria",
      customerName: authUser?.nombre || "Cliente",
      customerPhone: authUser?.telefono || "6555-1234",
      status:"PENDIENTE", round:1,          // round: número de vuelta de negociación
      history:[{by:"cliente",action:"Pedido creado",at:ts()}],
      createdAt:ts(),
      createdAtMs: Date.now(),  // Timestamp numérico para sorting confiable
    }]);
    return id;
  };

  /** Vendedor modifica → status MODIFICADO, números reservados */
  const modifyOrder = (orderId, newItems, removedItems, vendorNote) => {
    const newTotal = newItems.reduce((s,i)=>s+(i.price||1)*(i.qty||1),0);
    setSharedOrders(p=>p.map(o=>o.id!==orderId?o:{
      ...o,
      status:       "MODIFICADO",
      items:        newItems,
      itemCount:    newItems.length,
      lotteryValue: newTotal.toFixed(2),
      originalItems:o.items,           // snapshot para comparar
      removedItems: removedItems,
      vendorNote:   vendorNote||"El vendedor ajustó tu pedido",
      reservedNums: removedItems.map(i=>i.num),
      modifiedAt:   ts(),
      round:        (o.round||1)+1,
      history:      [...(o.history||[]),{by:"vendedor",action:`Ajustó pedido (vuelta ${(o.round||1)+1})`,at:ts()}],
    }));
  };

  /** Cliente aprueba la modificación del vendedor → directo al repartidor */
  const clientApproveModification = (orderId) => {
    setSharedOrders(p=>p.map(o=>o.id!==orderId?o:{
      ...o, status:"APROBADO", clientApprovedAt:ts(),
      history:[...(o.history||[]),{by:"cliente",action:"Aprobó modificación del vendedor",at:ts()}],
    }));
  };

  /** Cliente rechaza → CANCELADO, libera números reservados al stock */
  const clientRejectModification = (orderId) => {
    const order = sharedOrders.find(o=>o.id===orderId);
    order?.reservedNums?.forEach(num=>{
      setSharedBilletes(p=>p.map(b=>b.n===num?{...b,sold:Math.max(0,b.sold-1)}:b));
      setSharedChances(p=>p.map(c=>c.n===num?{...c,sold:Math.max(0,c.sold-1)}:c));
    });
    setSharedOrders(p=>p.map(o=>o.id!==orderId?o:{
      ...o, status:"CANCELADO", cancelledAt:ts(),
      history:[...(o.history||[]),{by:"cliente",action:"Rechazó — pedido cancelado",at:ts()}],
    }));
  };

  /**
   * Cliente propone número de reemplazo → status REEMPLAZO.
   * El vendedor debe revisar y aprobar, modificar de nuevo, o rechazar.
   * NO va al repartidor todavía.
   */
  const proposeReplacement = (orderId, replacementItem) => {
    const newItem = {
      type:replacementItem.type, num:replacementItem.num,
      qty:replacementItem.qty, price:replacementItem.price,
      subtotal:(replacementItem.price*replacementItem.qty).toFixed(2),
      isReplacement:true,   // flag para que el vendedor lo vea claramente
    };
    // Descontar del inventario temporalmente (reservar)
    if (replacementItem.type==="billete")
      setSharedBilletes(p=>p.map(b=>b.n===replacementItem.num?{...b,sold:Math.min(b.stock,b.sold+replacementItem.qty)}:b));
    else
      setSharedChances(p=>p.map(c=>c.n===replacementItem.num?{...c,sold:Math.min(c.stock,c.sold+replacementItem.qty)}:c));

    setSharedOrders(p=>p.map(o=>{
      if(o.id!==orderId) return o;
      const updatedItems = [...(o.items||[]), newItem];
      const newTotal = updatedItems.reduce((s,i)=>s+(i.price||1)*(i.qty||1),0);
      return {
        ...o,
        status:          "REEMPLAZO",
        items:           updatedItems,
        itemCount:       updatedItems.length,
        lotteryValue:    newTotal.toFixed(2),
        proposedAt:      ts(),
        clientNote:      `Cliente propone reemplazo: ${replacementItem.type==="billete"?"Nº":"#"}${replacementItem.num} ×${replacementItem.qty}`,
        history:         [...(o.history||[]),{by:"cliente",action:`Propuso reemplazo ${replacementItem.type==="billete"?"Nº":"#"}${replacementItem.num}`,at:ts()}],
      };
    }));
  };

  /**
   * Vendedor aprueba el reemplazo del cliente → APROBADO → va al repartidor.
   */
  const vendorApproveReplacement = (orderId) => {
    setSharedOrders(p=>p.map(o=>o.id!==orderId?o:{
      ...o, status:"APROBADO",
      // Limpiar los flags de iteración
      items: (o.items||[]).map(i=>({...i,isReplacement:undefined})),
      vendorApprovedAt:ts(),
      history:[...(o.history||[]),{by:"vendedor",action:"Aprobó reemplazo del cliente → a repartidor",at:ts()}],
    }));
  };

  /**
   * Vendedor rechaza el reemplazo → CANCELADO, libera stock del reemplazo.
   */
  const vendorRejectReplacement = (orderId) => {
    const order = sharedOrders.find(o=>o.id===orderId);
    const replacement = order?.items?.find(i=>i.isReplacement);
    if (replacement) {
      if (replacement.type==="billete")
        setSharedBilletes(p=>p.map(b=>b.n===replacement.num?{...b,sold:Math.max(0,b.sold-replacement.qty)}:b));
      else
        setSharedChances(p=>p.map(c=>c.n===replacement.num?{...c,sold:Math.max(0,c.sold-replacement.qty)}:c));
    }
    setSharedOrders(p=>p.map(o=>o.id!==orderId?o:{
      ...o, status:"CANCELADO", cancelledAt:ts(),
      history:[...(o.history||[]),{by:"vendedor",action:"Rechazó reemplazo — pedido cancelado",at:ts()}],
    }));
  };

  /**
   * Vendedor modifica el reemplazo propuesto por el cliente.
   * → vuelve a MODIFICADO (cliente debe revisar de nuevo — bucle continúa).
   */
  const vendorModifyReplacement = (orderId, newItems, removedItems, vendorNote) => {
    modifyOrder(orderId, newItems, removedItems, vendorNote||"El vendedor ajustó el reemplazo que propusiste");
  };

  const approveOrder = id => {
    notifySound("approve");
    setSharedOrders(p=>p.map(o=>o.id!==id?o:{...o,status:"APROBADO",approvedAt:ts(),history:[...(o.history||[]),{by:"vendedor",action:"Aprobó pedido",at:ts()}]}));
  };

  /**
   * El repartidor "se asigna" el pedido sin cambiar de estado todavía.
   * Marca el order con pickupStarted:true y un timestamp. El order sigue en APROBADO,
   * pero el botón "Iniciar recogida" se reemplaza por "Recogí el pedido".
   * En producción aquí también se reservaría el pedido para este repartidor específico,
   * impidiendo que otros lo tomen.
   */
  const startPickupOrder = id => setSharedOrders(p=>p.map(o=>{
    if (o.id !== id || o.status !== "APROBADO") return o;
    return {
      ...o,
      pickupStarted: true,
      pickupStartedAt: ts(),
      pickupStartedAtMs: Date.now(),
      assignedRepartidorId: authUser?.id || "repartidor_juan", // ID real del repartidor logueado
      assignedRepartidorName: authUser?.nombre || "Juan Rodríguez",
      history: [...(o.history||[]), { by: "repartidor", action: `${authUser?.nombre||"Juan Rodríguez"} inició recogida`, at: ts() }],
    };
  }));
  const assignOrder  = id => setSharedOrders(p=>p.map(o=>{
    if (o.id !== id) return o;
    // VALIDACIÓN: solo permitir pasar a EN_CAMINO si el vendedor ya APROBÓ
    if (o.status !== "APROBADO") {
      console.warn(`No se puede iniciar entrega de ${id}: el vendedor no ha aprobado (estado actual: ${o.status})`);
      return o; // No cambia el estado
    }
    return {
      ...o,
      status:"EN_CAMINO",
      assignedAt:ts(),
      // Asegurar identidad del repartidor real (por si llega por flujo legacy sin pickupStarted)
      assignedRepartidorId:   o.assignedRepartidorId   || authUser?.id     || "repartidor_juan",
      assignedRepartidorName: o.assignedRepartidorName || authUser?.nombre || "Juan Rodríguez",
    };
  }));
  const deliverOrder = id => setSharedOrders(p=>p.map(o=>o.id!==id?o:{...o,status:"ENTREGADO",deliveredAt:ts()}));

  /** Vendedor cancela el pedido y notifica al comprador */
  const vendorCancelOrder = (orderId) => {
    notifySound("cancel");
    const order = sharedOrders.find(o=>o.id===orderId);
    // Liberar stock de todos los items del pedido
    order?.items?.forEach(item=>{
      if(item.type==="billete")
        setSharedBilletes(p=>p.map(b=>b.n===item.num?{...b,sold:Math.max(0,b.sold-(item.qty||1))}:b));
      else
        setSharedChances(p=>p.map(c=>c.n===item.num?{...c,sold:Math.max(0,c.sold-(item.qty||1))}:c));
    });
    setSharedOrders(p=>p.map(o=>o.id!==orderId?o:{
      ...o, status:"CANCELADO_VENDEDOR",
      cancelledAt:ts(),
      cancelledBy:"vendedor",
      vendorCancelNote:"El vendedor canceló tu pedido. Los números han sido liberados.",
      history:[...(o.history||[]),{by:"vendedor",action:"Canceló el pedido",at:ts()}],
    }));
  };

  // ── MOTOR DE NOTIFICACIONES CON SONIDO ───────────────────────────────────
  /**
   * Genera sonidos de notificación usando Web Audio API.
   * No requiere librerías externas ni archivos de audio.
   * type: "new_order"|"modify"|"approve"|"cancel"|"replacement"|"waiting"
   */
  const notifySound = (type) => {
    try {
      const ctx = new (window.AudioContext||window.webkitAudioContext)();
      const patterns = {
        // Pedido nuevo (do-mi-sol ascendente fuerte)
        new_order:   [{f:523,d:.12},{f:659,d:.12},{f:784,d:.25}],
        // Modificación (tres beeps urgentes)
        modify:      [{f:440,d:.1},{f:440,d:.1},{f:440,d:.2}],
        // Aprobado (do-sol-do armonioso)
        approve:     [{f:523,d:.1},{f:784,d:.1},{f:1046,d:.3}],
        // Cancelado (descendente triste)
        cancel:      [{f:500,d:.15},{f:350,d:.15},{f:220,d:.35}],
        // Reemplazo propuesto (pregunta — subida)
        replacement: [{f:440,d:.1},{f:554,d:.1},{f:659,d:.2},{f:784,d:.25}],
        // Esperando (ping suave)
        waiting:     [{f:880,d:.08},{f:660,d:.15}],
      };
      const notes = patterns[type] || patterns.new_order;
      let t = ctx.currentTime;
      notes.forEach(note=>{
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.setValueAtTime(note.f, t);
        gain.gain.setValueAtTime(0.5, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + note.d);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(t);
        osc.stop(t + note.d);
        t += note.d + 0.03;
      });
    } catch(e) { /* Silenciar si el browser bloquea audio sin interacción */ }
  };

  // Wrap all notification-triggering functions with sound
  const modifyOrderWithSound = (orderId, newItems, removedItems, vendorNote) => {
    notifySound("modify");
    modifyOrder(orderId, newItems, removedItems, vendorNote);
  };
  const clientApproveWithSound = (orderId) => {
    notifySound("approve");
    clientApproveModification(orderId);
  };
  const clientRejectWithSound = (orderId) => {
    notifySound("cancel");
    clientRejectModification(orderId);
  };
  const proposeReplacementWithSound = (orderId, item) => {
    notifySound("replacement");
    proposeReplacement(orderId, item);
  };
  const vendorApproveReplacementWithSound = (orderId) => {
    notifySound("approve");
    vendorApproveReplacement(orderId);
  };
  const vendorRejectReplacementWithSound = (orderId) => {
    notifySound("cancel");
    vendorRejectReplacement(orderId);
  };
  const placeOrderWithSound = async (items, method, addr, deliveryMeta) => {
    notifySound("new_order");
    return await placeOrder(items, method, addr, deliveryMeta);
  };

  const nav = target => {
    if(typeof target==="string"){setScreen(target);setScreenData(null);}
    else{setScreen(target.screen);setScreenData(target);}
  };

  const selectRole = r => {
    setRole(r);
    setActiveRole(r);
    setScreen(r==="cliente"?"home_cliente":r==="vendedor"?"home_vendedor":"home_repartidor");
    setScreenData(null);setPhase("app");
  };

  // Vendedor/Repartidor switching between their native role and Comprador mode
  const switchRole = (targetRole) => {
    setRole(targetRole);
    setActiveRole(targetRole);
    setScreen(targetRole==="cliente"?"home_cliente":targetRole==="vendedor"?"home_vendedor":"home_repartidor");
    setScreenData(null);
  };

  // Auto-start if forceRole is provided (authenticated user)
  useEffect(()=>{
    if(forceRole&&phase!=="app"){ selectRole(forceRole); }
  },[forceRole]);

  const cartCount = cart.reduce((a,i)=>a+i.qty,0);
  const navItems  = role?NAV[role]||[]:[];

  const screenToNav = {
    home_vendedor:"home_vendedor",pedidos_v:"pedidos_v",kardex_v:"kardex_v",perfil_v:"perfil_v",
    home_repartidor:"home_repartidor",entregas_r:"entregas_r",batch_r:"batch_r",billetera_r:"billetera_r",
    home_cliente:"home_cliente",buscar:"buscar",historial:"historial",
    resultados:"resultados",verificar:"resultados",perfil_c:"perfil_c",
  };
  const activeNav = screenToNav[screen]||null;

  const navBadge = {
    pedidos_v:    vendorActionNeeded,
    entregas_r:   approvedForDriver,
    batch_r:      approvedForDriver,
    historial:    sharedOrders.filter(o=>(o.customerId===(authUser?.id||"cliente_maria")||o.customerId==="cliente_maria")&&["PENDIENTE","APROBADO","EN_CAMINO","MODIFICADO","REEMPLAZO"].includes(o.status)).length,
    home_cliente: modifiedForClient,
  };

  // ── Sorteo activo del vendedor (compartido con el comprador) ─────────────
  // Viene de ChanceRoot como prop para sincronizar via Firebase
  const sorteoInicialFallback = getSorteoActivo("MIERCOLITO") || (SORTEOS_RECIENTES && SORTEOS_RECIENTES[0]) || SORTEOS_RECIENTES_SEED[0];
  const sorteoEffective = vendorActiveSorteo || sorteoInicialFallback;

  const sharedVendor = {
    ...VENDORS[0],
    billetes: sharedBilletes,
    chances:  sharedChances,
    sorteo:   `${sorteoEffective?.icon||"⚡"} ${sorteoEffective?.tipo||"MIERCOLITO"} · ${sorteoEffective?.fecha||""}`,
    sorteoData: sorteoEffective,
  };

  const renderScreen = () => {
    if(phase==="splash") return <SplashScreen onNext={()=>setPhase("roles")}/>;
    if(phase==="roles")  return <RoleSelect onSelect={selectRole}/>;
    switch(screen){
      // ── CLIENTE
      case "home_cliente": return <ClienteHome cart={cart} nav={nav}
        sharedVendor={sharedVendor} activeVendors={activeVendors}
        activeOrders={sharedOrders.filter(o=>(o.customerId===(authUser?.id||"cliente_maria")||o.customerId==="cliente_maria"))}/>;
      case "buscar":       return <BuscarScreen nav={nav} sharedVendor={sharedVendor} activeVendors={activeVendors}/>;
      case "suerte":       return <SuerteScreen/>
      case "explorar":     return <ExplorarScreen nav={nav} sharedVendor={sharedVendor} activeVendors={activeVendors}/>;
      case "tablero":      return <TableroScreen
        vendor={screenData?.vendor||sharedVendor}
        vendorActiveSorteo={vendorActiveSorteo}
        cart={cart} setCart={setCart} nav={nav}/>;
      case "carrito":      return <CarritoScreen cart={cart} setCart={setCart} nav={nav}
        onPlaceOrder={placeOrderWithSound}/>;
      case "checkout":     return <CheckoutScreen cart={cart} setCart={setCart} nav={nav}
        onConfirm={placeOrderWithSound}/>;
      case "confirmacion": return <ConfirmacionScreen orderId={screenData?.orderId||"CH-2408"} nav={nav}/>;
      case "tracking":     return <TrackingScreen
        order={sharedOrders.find(o=>["EN_CAMINO","APROBADO"].includes(o.status)&&(o.customerId===(authUser?.id||"cliente_maria")||o.customerId==="cliente_maria"))||null}/>;
      case "historial":    return <HistorialScreen nav={nav}
        orders={sharedOrders.filter(o=>(o.customerId===(authUser?.id||"cliente_maria")||o.customerId==="cliente_maria"))}
        onClientApprove={clientApproveWithSound}
        onClientReject={clientRejectWithSound}
        onProposeReplacement={proposeReplacementWithSound}
        sharedVendor={sharedVendor}/>;
      case "resultados":   return <ResultadosScreen initTab="resultados"/>;
      case "verificar":    return <ResultadosScreen initTab="verificar"/>;
      case "notif":        return <NotifScreen orders={sharedOrders}/>;
      case "perfil_c":     return <PerfilScreen authUser={authUser} onLogout={onLogout} currentRole={role} onSwitchRole={switchRole}/>;
      // ── VENDEDOR
      case "home_vendedor": return <VendedorHome
        authUser={authUser}
        billetes={sharedBilletes} setBilletes={setSharedBilletes}
        chances={sharedChances}   setChances={setSharedChances}
        orders={sharedOrders}     onApprove={approveOrder}
        onModify={modifyOrderWithSound}
        onApproveReplacement={vendorApproveReplacementWithSound}
        onRejectReplacement={vendorRejectReplacementWithSound}
        onCancelByVendor={vendorCancelOrder}
        activeSorteo={vendorActiveSorteo}
        setActiveSorteo={setVendorActiveSorteo}
        initTab="tablero"/>;
      case "pedidos_v":    return <VendedorHome
        authUser={authUser}
        billetes={sharedBilletes} setBilletes={setSharedBilletes}
        chances={sharedChances}   setChances={setSharedChances}
        orders={sharedOrders}     onApprove={approveOrder}
        onModify={modifyOrderWithSound}
        onApproveReplacement={vendorApproveReplacementWithSound}
        onRejectReplacement={vendorRejectReplacementWithSound}
        onCancelByVendor={vendorCancelOrder}
        activeSorteo={vendorActiveSorteo}
        setActiveSorteo={setVendorActiveSorteo}
        initTab="pedidos"
        showOnlyTab="pedidos"/>;
      case "kardex_v":     return <VendedorHome
        authUser={authUser}
        billetes={sharedBilletes} setBilletes={setSharedBilletes}
        chances={sharedChances}   setChances={setSharedChances}
        orders={sharedOrders}     onApprove={approveOrder}
        onModify={modifyOrderWithSound}
        onApproveReplacement={vendorApproveReplacementWithSound}
        onRejectReplacement={vendorRejectReplacementWithSound}
        onCancelByVendor={vendorCancelOrder}
        activeSorteo={vendorActiveSorteo}
        setActiveSorteo={setVendorActiveSorteo}
        initTab="kardex"
        showOnlyTab="kardex"/>;
      case "perfil_v":     return <PerfilScreen authUser={authUser} onLogout={onLogout} currentRole={role} onSwitchRole={switchRole}/>;
      // ── REPARTIDOR
      case "home_repartidor": return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="inicio"/>;
      case "entregas_r":   return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="inicio"/>;
      case "batch_r":      return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="batch"/>;
      case "billetera_r":  return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="liquidacion"/>;
      case "perfil_v":     return <PerfilScreen authUser={authUser} onLogout={onLogout} currentRole={role} onSwitchRole={switchRole}/>;
      // ── REPARTIDOR
      case "home_repartidor": return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="inicio"/>;
      case "entregas_r":   return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="inicio"/>;
      case "batch_r":      return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="batch"/>;
      case "billetera_r":  return <RepartidorHome authUser={authUser}
        orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="liquidacion"/>;
      default:
        if (role==="vendedor")   return <VendedorHome   authUser={authUser} billetes={sharedBilletes} setBilletes={setSharedBilletes} chances={sharedChances} setChances={setSharedChances} orders={sharedOrders} onApprove={approveOrder} onModify={modifyOrderWithSound} onApproveReplacement={vendorApproveReplacementWithSound} onRejectReplacement={vendorRejectReplacementWithSound} onCancelByVendor={vendorCancelOrder} activeSorteo={vendorActiveSorteo} setActiveSorteo={setVendorActiveSorteo} initTab="tablero"/>;
        if (role==="repartidor") return <RepartidorHome authUser={authUser} orders={sharedOrders} onAssign={assignOrder} onDeliver={deliverOrder} onStartPickup={startPickupOrder} initTab="inicio"/>;
        return <ClienteHome cart={cart} nav={nav} sharedVendor={sharedVendor} activeVendors={activeVendors} activeOrders={sharedOrders.filter(o=>(o.customerId===(authUser?.id||"cliente_maria")||o.customerId==="cliente_maria"))}/>;
    }
  };

  return (
    <>
      <style>{CSS}</style>
      <div className="shell">
        {/* Header externo: info del usuario autenticado + cambiar rol en modo demo */}
        {phase==="app"&&(
          <div style={{marginBottom:8,display:"flex",gap:6,alignItems:"center",justifyContent:"center",flexWrap:"wrap"}}>
            {authUser ? (
              /* Usuario autenticado — mostrar nombre y rol */
              <div style={{display:"flex",alignItems:"center",gap:8,background:"var(--bg2)",borderRadius:20,padding:"5px 14px",border:"1px solid var(--border)"}}>
                <div style={{width:24,height:24,borderRadius:"50%",background:
                  authUser.rol==="vendedor"?"rgba(255,204,51,.2)":
                  authUser.rol==="repartidor"?"rgba(77,181,255,.2)":"rgba(0,229,160,.2)",
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>
                  {authUser.rol==="vendedor"?"🏪":authUser.rol==="repartidor"?"🛵":"🛒"}
                </div>
                <span style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>{authUser.nombre?.split(" ")[0]}</span>
                <span style={{fontSize:9,fontWeight:700,color:"var(--muted)",textTransform:"uppercase",letterSpacing:.5}}>
                  {authUser.rol==="vendedor"?"Vendedor":authUser.rol==="repartidor"?"Repartidor":"Comprador"}
                </span>
              </div>
            ) : (
              /* Modo demo — selector de rol */
              [
                {r:"cliente",l:"🛒 Comprador"},
                {r:"vendedor",l:"🏪 Vendedor"},
                {r:"repartidor",l:"🛵 Repartidor"},
              ].map(({r,l})=>(
                <button key={r} onClick={()=>selectRole(r)}
                  style={{padding:"5px 12px",borderRadius:18,
                    background:role===r?"var(--gold)":"var(--bg2)",
                    color:role===r?"#08101E":"var(--muted)",
                    border:`1px solid ${role===r?"var(--gold)":"var(--border)"}`,
                    fontFamily:"'DM Sans'",fontWeight:700,fontSize:11,cursor:"pointer",position:"relative"}}>
                  {l}
                  {r==="vendedor"&&vendorActionNeeded>0&&<span style={{position:"absolute",top:-4,right:-4,width:15,height:15,borderRadius:"50%",background:"var(--red)",color:"#fff",fontSize:8,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{vendorActionNeeded}</span>}
                  {r==="repartidor"&&approvedForDriver>0&&<span style={{position:"absolute",top:-4,right:-4,width:15,height:15,borderRadius:"50%",background:"var(--green)",color:"#fff",fontSize:8,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center"}}>{approvedForDriver}</span>}
                </button>
              ))
            )}
          </div>
        )}

        {/* Indicador de flujo de pedidos (desarrollo) */}
        {phase==="app"&&sharedOrders.length>0&&(
          <div style={{marginBottom:6,display:"flex",gap:5,flexWrap:"wrap",justifyContent:"center"}}>
            {[
              {s:"PENDIENTE",l:"⏳",c:"var(--gold)"},
              {s:"APROBADO", l:"✅",c:"var(--green)"},
              {s:"EN_CAMINO",l:"🛵",c:"var(--blue)"},
              {s:"ENTREGADO",l:"📦",c:"var(--muted)"},
            ].map(({s,l,c})=>{
              const cnt=sharedOrders.filter(o=>o.status===s).length;
              if(!cnt) return null;
              return <span key={s} style={{fontSize:10,color:c,fontWeight:700,background:"var(--bg2)",border:`1px solid ${c}40`,borderRadius:10,padding:"2px 7px"}}>{l} {cnt}</span>;
            })}
          </div>
        )}

        <div className="phone">
          <div className="sbar">
            <span>9:41</span>
            <div className="row" style={{gap:4,fontSize:10}}><span>▌▌▌</span><span>WiFi</span><span>🔋</span></div>
          </div>

          {phase==="app"&&(
            <div style={{background:"var(--bg2)",padding:"5px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",borderBottom:"1px solid var(--border)",flexShrink:0}}>
              <button onClick={()=>{if(onLogout){onLogout();}else{setPhase("roles");}}} style={{background:"none",border:"none",color:"var(--muted)",cursor:"pointer",display:"flex",alignItems:"center",gap:3,fontFamily:"'DM Sans'",fontSize:10,fontWeight:600}}>
                <Ic n="chevL" s={11} c="var(--muted)"/> {onLogout?"Salir":"Rol"}
              </button>
              <ChanceLogo height={28}/>
              {role==="cliente"?(
                <button onClick={()=>nav("carrito")} style={{background:"none",border:"none",cursor:"pointer",position:"relative"}}>
                  <Ic n="cart" s={17} c={cartCount>0?"var(--gold)":"var(--muted)"}/>
                  {cartCount>0&&<div className="cbadge">{cartCount}</div>}
                </button>
              ):role==="vendedor"?(
                <button onClick={()=>nav("pedidos_v")} style={{background:"none",border:"none",cursor:"pointer",position:"relative"}}>
                  <Ic n="pkg" s={17} c={vendorActionNeeded>0?"var(--red)":"var(--muted)"}/>
                  {vendorActionNeeded>0&&<div className="cbadge">{vendorActionNeeded}</div>}
                </button>
              ):role==="repartidor"?(
                <button onClick={()=>nav("entregas_r")} style={{background:"none",border:"none",cursor:"pointer",position:"relative"}}>
                  <Ic n="truck" s={17} c={approvedForDriver>0?"var(--green)":"var(--muted)"}/>
                  {approvedForDriver>0&&<div className="cbadge" style={{background:"var(--green)"}}>{approvedForDriver}</div>}
                </button>
              ):<div style={{width:26}}/>}
            </div>
          )}

          <div className="scr">{renderScreen()}</div>

          {phase==="app"&&role&&(
            <div className="bnav">
              {navItems.map(({id,l,ic})=>{
                const badge=navBadge[id]||0;
                const isOn=activeNav===id;
                return (
                  <button key={id} className={`nb ${isOn?"on":""}`} onClick={()=>nav(id)} style={{position:"relative"}}>
                    <Ic n={ic} s={20} c={isOn?"var(--gold)":"var(--muted)"}/>
                    {badge>0&&<div style={{position:"absolute",top:0,right:8,width:14,height:14,borderRadius:"50%",background:ic==="truck"?"var(--green)":"var(--red)",color:"#fff",fontSize:8,fontWeight:800,display:"flex",alignItems:"center",justifyContent:"center",border:"1.5px solid var(--bg2)"}}>{badge}</div>}
                    <span>{l}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div style={{marginTop:9,textAlign:"center",fontSize:11,color:"var(--muted)",fontFamily:"'DM Sans'"}}>
          {phase==="app"&&<span>🔗 Negociación · {pendingForVendor} nuevo(s) · {replacementForVendor} reemplazo(s) · {modifiedForClient} modificado(s) · {approvedForDriver} aprobado(s) 🛵</span>}
          {phase!=="app"&&"Toca 'Comenzar' para explorar"}
        </div>
      </div>
    </>
  );
}

/* ╔═══════════════════════════════════════════════════════════════════════╗
   ║          SISTEMA DE AUTENTICACIÓN — CHANCE LNB PANAMÁ                 ║
   ║  Login · Registro multi-paso por rol · Aprobación admin · Admin Panel  ║
   ╚═══════════════════════════════════════════════════════════════════════╝ */

/* ── Datos geográficos de Panamá ───────────────────────────────────────── */
/* Estructura: { provincia: { distrito: [corregimiento] } } */
const GEO_PANAMA = {
  "Panamá": {
    "Panamá":       ["Ancón","Betania","Bella Vista","Calidonia","Chilibre","Curundú","El Chorrillo","Juan Díaz","Las Cumbres","Mañanitas","Pacora","Pedregal","Pueblo Nuevo","San Felipe","San Francisco","Santa Ana","Tocumen"],
    "San Miguelito": ["Amelia Denis de Icaza","Belisario Frías","Belisario Porras","José Domingo Espinar","Mateo Iturralde","Rufina Alfaro","Victoriano Lorenzo"],
    "Chepo":        ["Las Margaritas","Cañita","Chepillo","El Llano","La Palma","Mamón"],
    "Balboa":       ["Balboa","La Guinea","Otoque Occidente"],
  },
  "Panamá Oeste": {
    "Arraiján":     ["Arraiján","Burunga","Cerro Silvestre","Juan Demóstenes Arosemena","Nuevo Emperador","Vista Alegre"],
    "La Chorrera":  ["Amador","Barrio Colón","Feuillet","Guadalupe","Herrera","Hurtado","La Chorrera","Mendoza","Obaldía","Playa Leona","Puerto Caimito","Ojo de Agua"],
    "Capira":       ["Capira","Caimito","Cermeño","El Cacao","La Laguna","San Carlos"],
    "Chame":        ["Bejuco","Nueva Gorgona","Punta Chame","San Carlos"],
    "San Carlos":   ["San Carlos","El Espino","El Higo","La Trinidad","Las Uvas"],
  },
  "Colón": {
    "Colón":        ["Barrio Norte","Barrio Sur","Buena Vista","Cativá","Cristóbal","Escobal","Limón","Sabanitas","Salamanca"],
    "Portobelo":    ["Portobelo","Garrote","María Chiquita"],
    "Chagres":      ["Chagres","Nuevo Chagres","Palmas Bellas"],
    "Donoso":       ["Coclé del Norte","El Guásimo","El Pantano","Miguel de la Borda","Río Indio"],
  },
  "Chiriquí": {
    "David":        ["Alamique","David","Guabal","Las Lomas","Los Algarrobos","Pedregal","San Pablo Nuevo","San Pablo Viejo","San Carlos"],
    "Boquete":      ["Boquete","Caldera","Cochea","Dolega","Los Naranjos","Palmira","Potrerillos"],
    "Bugaba":       ["Bugaba","Alanje","Concepción","Las Lajas","Rovira"],
    "Barú":         ["Puerto Armuelles","Boca Chica","Boqueron","Chiriquí","Jacú"],
    "Dolega":       ["Dolega","Los Algarrobos","Los Palacios","Potrerillos","Tinajas"],
  },
  "Coclé": {
    "Penonomé":     ["Penonomé","Caimito","Chiguirí Arriba","Coclé","El Harino","Pajonal","Río Grande","Tulú"],
    "Aguadulce":    ["Aguadulce","El Roble","Pocrí"],
    "Antón":        ["Antón","El Valle","Juan Díaz","Río Hato"],
    "La Pintada":   ["La Pintada","El Harino","Toabre"],
    "Natá":         ["Natá","Calobre","El Caño"],
  },
  "Veraguas": {
    "Santiago":     ["Santiago","La Colorada","La Mesa","La Raya de Santa María","Los Ángeles","Ponuga","Quebro","Rincón","San Pedro del Espino"],
    "Soná":         ["Soná","Bahía Honda","Mariato","Trinidad de las Minas"],
    "Atalaya":      ["Atalaya","El Barrito","San Antonio"],
    "Las Palmas":   ["Las Palmas","Pixvae","Puerto Vidal","Río de Jesús"],
    "Montijo":      ["Montijo","La Garceana","Gobea","Leones","Pilón"],
  },
  "Herrera": {
    "Chitré":       ["Chitré","Llano Bonito","Monagrillo","San Juan Bautista"],
    "Las Minas":    ["Las Minas","Chepo","El Toro","La Pava"],
    "Los Pozos":    ["Los Pozos","Cerro Largo","El Calabacito"],
    "Parita":       ["Parita","Los Castillos","Portobelillo"],
    "Ocú":          ["Ocú","El Tijeras","Llano Grande"],
    "Pesé":         ["Pesé","El Caño","La Arena"],
    "Santa María":  ["Santa María","Los Canelos","Los Llanos"],
  },
  "Los Santos": {
    "Las Tablas":   ["Las Tablas","El Cacique","Flores","La Palma","Paritilla","Pedasí","Pocrí"],
    "Los Santos":   ["Los Santos","El Guásimo","Macaracas","Quebrada Honda"],
    "Guararé":      ["Guararé","El Espigón","La Enea","Llano Abajo"],
    "Macaracas":    ["Macaracas","Bahía Honda","Corozal","El Cedro","Lajamina"],
    "Pedasí":       ["Pedasí","Oria Arriba","Parita"],
    "Tonosí":       ["Tonosí","Cambutal","Flores","Los Asientos","Quebro"],
  },
  "Darién": {
    "La Palma":     ["La Palma","El Real de Santa María","Garachiné","Sambú"],
    "Chepigana":    ["Metetí","Agua Fría","Cucunatí","La Palma","Río Congo","Río Iglesias"],
    "Pinogana":     ["El Real","Boca de Cupe","Manené","Paya","Púcuro","Yape"],
  },
  "Bocas del Toro": {
    "Bocas del Toro":["Bocas del Toro","Almirante","Bastimentos","Cauchero","Guabito","Punta Laurel"],
    "Changuinola":  ["Changuinola","Almirante","El Empalme","Las Delicias","Margarita","Miramar","Valle de Risco"],
    "Chiriquí Grande":["Chiriquí Grande","Boca del Drago","Cricamola"],
  },
  "Guna Yala":    {"El Porvenir":["El Porvenir","Narganá","Tupile","Ustupu"]},
  "Ngäbe-Buglé":  {"Kankintú":["Kankintú","Calovébora"],"Kusapín":["Kusapín"],"Mironó":["Mironó"]},
  "Emberá":        {"Cémaco":["Cémaco","La Marea","Lajas Blancas"],"Sambú":["Sambú"]},
};

// Helpers para acceso fácil
const getDistritos = (prov) => prov && GEO_PANAMA[prov] ? Object.keys(GEO_PANAMA[prov]) : [];
const getCorregimientos = (prov, dist) => (prov && dist && GEO_PANAMA[prov]?.[dist]) || [];

const VEHICULOS    = ["🏍 Motocicleta","🚲 Bicicleta","🚗 Automóvil","🛴 Patineta eléctrica","🦶 A pie"];
const SORTEOS_OPTS = ["⚡ Miercolito (Miércoles)","🌟 Dominical (Domingo)","🍀 Gordito del Zulia (Sábado)","💎 Extraordinaria"];
const ZONAS_PTY    = ["Panamá Centro","San Francisco","Punta Pacífica","El Cangrejo","Via España","Marbella","Bella Vista","Obarrio","Clayton","Albrook","Tocumen","Juan Díaz","Las Cumbres","Arraiján","La Chorrera","Colón","David","Santiago","Toda la República"];
const HORARIOS     = ["Mañana (6am–12pm)","Tarde (12pm–6pm)","Noche (6pm–11pm)","Tiempo completo","Fines de semana"];
const BANCOS       = ["Banco General","BAC Credomatic","Banistmo","Banco Nacional","Caja de Ahorros","Global Bank","MultiCredit Bank","Yappy (BG)","Nequi","Tigo Money","Otro"];
const TIPOS_CUENTA = ["Cuenta Corriente","Cuenta de Ahorros","Cuenta de Cheques"];
// Métodos para recibir pagos en efectivo (comprador / vendedor)
const METODOS_COBRO_EFECTIVO = ["💵 Efectivo en mano","📱 Yappy (Banco General)","📱 Nequi","📱 Tigo Money","🏦 Depósito bancario","Otro"];

/* ── CSS adicional para Auth ─────────────────────────────────────────────── */
const AUTH_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700;800&display=swap');

/* Shell de autenticación */
.auth-shell{
  width:100%;max-width:480px;margin:0 auto;min-height:100vh;
  background:linear-gradient(160deg,#08101E 0%,#0C1526 100%);
  display:flex;flex-direction:column;align-items:center;
  padding:0 0 40px;font-family:'DM Sans',sans-serif;overflow-x:hidden;
}

/* Logo con brillo visible */
.auth-logo{
  font-family:'Bebas Neue',sans-serif;font-size:54px;
  color:#FFCC33;letter-spacing:14px;
  text-shadow:0 0 30px rgba(255,204,51,.6),0 0 60px rgba(255,204,51,.25);
  line-height:1;
}

/* Card con contraste real sobre el fondo */
.auth-card{
  width:100%;
  background:#1A2C48;
  border:1px solid rgba(255,255,255,.1);
  border-radius:22px;padding:26px 22px;margin:0 0 14px;
  box-shadow:0 8px 32px rgba(0,0,0,.4);
}

/* Inputs: fondo visible y texto blanco */
.auth-inp{
  width:100%;padding:13px 15px;
  background:#243A58;
  border:1.5px solid rgba(255,255,255,.15);
  border-radius:12px;
  color:#FFFFFF;
  font-family:'DM Sans',sans-serif;font-size:14px;
  outline:none;transition:all .2s;box-sizing:border-box;
}
.auth-inp:focus{
  border-color:#FFCC33;
  background:#2E4870;
  box-shadow:0 0 0 3px rgba(255,204,51,.15);
}
.auth-inp::placeholder{color:#7A96B8;}

/* Botón primario dorado — muy visible */
.auth-btn{
  width:100%;padding:15px;
  background:linear-gradient(135deg,#FFCC33,#D4A218);
  border:none;border-radius:13px;
  color:#08101E;
  font-family:'DM Sans',sans-serif;font-weight:800;font-size:15px;
  cursor:pointer;letter-spacing:.3px;
  box-shadow:0 4px 24px rgba(255,204,51,.4);
  transition:all .18s;
}
.auth-btn:hover{transform:translateY(-1px);box-shadow:0 6px 28px rgba(255,204,51,.5);}
.auth-btn:active{transform:translateY(0);}
.auth-btn:disabled{opacity:.5;cursor:default;transform:none;}

/* Botón secundario */
.auth-btn-sec{
  width:100%;padding:14px;
  background:rgba(255,255,255,.06);
  border:1.5px solid rgba(255,255,255,.2);
  border-radius:13px;
  color:#B8CEDE;
  font-family:'DM Sans',sans-serif;font-weight:700;font-size:14px;
  cursor:pointer;transition:all .18s;
}
.auth-btn-sec:hover{border-color:#FFCC33;color:#FFCC33;background:rgba(255,204,51,.06);}

/* Labels — claramente legibles */
.auth-label{
  font-size:11px;font-weight:800;
  color:#9CB8D4;
  letter-spacing:1px;text-transform:uppercase;
  margin-bottom:6px;display:block;
}

/* Steps indicator */
.auth-step{display:flex;gap:6px;justify-content:center;margin:12px 0;}
.auth-dot{width:8px;height:8px;border-radius:50%;background:rgba(255,255,255,.2);transition:all .25s;}
.auth-dot.on{background:#FFCC33;width:24px;border-radius:4px;box-shadow:0 0 12px rgba(255,204,51,.5);}

/* Select */
.auth-sel{
  width:100%;padding:13px 15px;
  background:#243A58;
  border:1.5px solid rgba(255,255,255,.15);
  border-radius:12px;
  color:#FFFFFF;
  font-family:'DM Sans',sans-serif;font-size:14px;
  outline:none;cursor:pointer;appearance:none;-webkit-appearance:none;
}
.auth-sel:focus{border-color:#FFCC33;background:#2E4870;}
.auth-sel option{background:#1A2C48;color:#FFFFFF;}

/* Chips de selección */
.auth-chip{
  padding:8px 14px;border-radius:20px;
  border:1.5px solid rgba(255,255,255,.2);
  background:rgba(255,255,255,.05);
  color:#B8CEDE;font-size:11px;font-weight:700;
  cursor:pointer;font-family:'DM Sans',sans-serif;
  transition:all .18s;white-space:nowrap;
}
.auth-chip.on{
  border-color:#FFCC33;
  background:rgba(255,204,51,.15);
  color:#FFCC33;
  box-shadow:0 0 14px rgba(255,204,51,.2);
}
.auth-chip:hover:not(.on){border-color:rgba(255,255,255,.4);color:#FFFFFF;}

/* Upload area */
.auth-upload{
  width:100%;padding:22px;
  border:2px dashed rgba(255,255,255,.2);
  border-radius:13px;text-align:center;
  cursor:pointer;background:rgba(255,255,255,.04);
  transition:all .2s;
}
.auth-upload:hover{border-color:#FFCC33;background:rgba(255,204,51,.05);}

/* Pantalla pendiente */
.pend-card{
  background:rgba(255,204,51,.08);
  border:1px solid rgba(255,204,51,.25);
  border-radius:20px;padding:30px 24px;
  text-align:center;margin:16px 0;
}

/* Admin panel */
.admin-card{background:#1A2C48;border:1px solid rgba(255,255,255,.1);border-radius:16px;overflow:hidden;margin-bottom:10px;}
.admin-row{display:flex;align-items:center;gap:12px;padding:13px 16px;border-bottom:1px solid rgba(255,255,255,.07);}
.admin-row:last-child{border-bottom:none;}

/* Badges de rol */
.role-pill{padding:3px 9px;border-radius:8px;font-size:9px;font-weight:800;letter-spacing:.3px;text-transform:uppercase;}
.r-cliente{background:rgba(0,229,160,.18);color:#00E5A0;}
.r-vendedor{background:rgba(255,204,51,.18);color:#FFCC33;}
.r-repartidor{background:rgba(77,181,255,.18);color:#4DB5FF;}
.r-admin{background:rgba(196,168,255,.18);color:#C4A8FF;}
.st-pending{background:rgba(255,90,120,.18);color:#FF5A78;}
.st-active{background:rgba(0,229,160,.18);color:#00E5A0;}
.st-suspended{background:rgba(184,206,222,.14);color:#B8CEDE;}
`;

/* ── useStorage hook ─────────────────────────────────────────────────────── */
function useStorage(key, def) {
  const [val, setVal] = useState(def);
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get(key);
        if (r?.value) {
          try {
            const parsed = JSON.parse(r.value);
            // Si default era array y vino objeto (Firebase artifact), convertir
            if (Array.isArray(def) && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              setVal(Object.values(parsed));
            } else {
              setVal(parsed);
            }
          } catch(parseErr) { console.warn("useStorage parse:", parseErr); }
        }
      } catch(e) {}
    })();
  }, [key]);
  const save = async (v) => {
    setVal(v);
    try { await window.storage.set(key, JSON.stringify(v)); } catch(e) {}
  };
  return [val, save];
}

/* ─────────────────────────────────────────────────────────────────────────
   PANTALLA DE INICIO DE SESIÓN
───────────────────────────────────────────────────────────────────────── */
function LoginScreen({ onLogin, onGoRegister, registerSuccess=null }) {
  const [email, setEmail]   = useState(registerSuccess?.email||"");
  const [pass,  setPass]    = useState("");
  const [err,   setErr]     = useState("");
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  // Demo users hardcoded as fallback — always work even if storage isn't seeded
  const DEMO_USERS = [
    {id:"admin1", email:"admin@chance.pa",  password:"Admin2024!", nombre:"Admin CHANCE",   rol:"admin",      cedula:"8-999-0001",telefono:"6000-0001",status:"ACTIVO",createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"San Francisco",sorteos:[],zonas:[],horarios:[],banco:"Banco General",cuentaBanco:"",tipoCuenta:"",metodoCobro:""},
    {id:"demo_c", email:"maria@demo.pa",    password:"Compra123",  nombre:"María González", rol:"cliente",    cedula:"8-123-4567",telefono:"6234-5678",status:"ACTIVO",createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"San Francisco",sorteos:[],zonas:[],horarios:[],banco:"Yappy (BG)",cuentaBanco:"",tipoCuenta:"",metodoCobro:"💵 Efectivo en mano"},
    {id:"demo_v", email:"carlos@demo.pa",   password:"Vende123",   nombre:"Carlos Medina",  rol:"vendedor",   cedula:"8-222-3333",telefono:"6111-2222",status:"ACTIVO",createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"San Francisco",numeroBilletero:"V001",sorteos:["⚡ Miercolito (Miércoles)","🌟 Dominical (Domingo)"],zonas:[],horarios:[],banco:"Banco General",cuentaBanco:"04-12-345678-0",tipoCuenta:"Cuenta Corriente",metodoCobro:"📱 Yappy (Banco General)",lugarVende:"Calle 50, San Francisco"},
    {id:"demo_r", email:"juan@demo.pa",     password:"Reparte123", nombre:"Juan Rodríguez", rol:"repartidor", cedula:"8-444-5555",telefono:"6333-4444",status:"ACTIVO",createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"El Cangrejo",vehiculo:"🏍 Motocicleta",zonas:["Panamá Centro","San Francisco","El Cangrejo"],horarios:["Tarde (12pm–6pm)"],banco:"Nequi",cuentaBanco:"6333-4444",tipoCuenta:"Cuenta de Ahorros",metodoCobro:"",sorteos:[]},
  ];

  const handleLogin = async () => {
    if (!email.trim() || !pass.trim()) { setErr("Ingresa tu correo y contraseña."); return; }
    setLoading(true); setErr("");

    const emailLow = email.toLowerCase().trim();

    // 1. Demos hardcodeados (siempre funciona)
    try {
      const demo = DEMO_USERS.find(u => u.email === emailLow && u.password === pass);
      if (demo) { onLogin(demo); setLoading(false); return; }
    } catch(e) { console.warn("demo check failed:", e); }

    // 2. Lee usuarios locales — cada paso protegido
    let users = [];
    try {
      const r = await window.storage.get("users_db");
      if (r?.value) {
        try {
          const parsed = JSON.parse(r.value);
          if (Array.isArray(parsed)) users = parsed;
          else if (parsed && typeof parsed === "object") users = Object.values(parsed);
        } catch(parseErr) { console.warn("parse users_db failed:", parseErr); }
      }
    } catch(storageErr) { console.warn("storage read failed:", storageErr); }

    // 3. Buscar match en local
    let user = null;
    try {
      user = users.find(u => {
        if (!u || typeof u !== "object") return false;
        const e = (u.email || "").toLowerCase().trim();
        return e === emailLow && u.password === pass;
      });
    } catch(e) { console.warn("local find failed:", e); }

    // 4. Si no está local, busca en Firebase
    if (!user) {
      try {
        let fbUsers = await fbRead("users");
        if (fbUsers && !Array.isArray(fbUsers) && typeof fbUsers === "object") {
          fbUsers = Object.values(fbUsers);
        }
        if (Array.isArray(fbUsers)) {
          user = fbUsers.find(u => {
            if (!u || typeof u !== "object") return false;
            const e = (u.email || "").toLowerCase().trim();
            return e === emailLow && u.password === pass;
          });
          // Sincronizar al storage local
          if (user) {
            try {
              users = [...users.filter(u => (u?.email || "").toLowerCase().trim() !== emailLow), user];
              await window.storage.set("users_db", JSON.stringify(users));
            } catch(syncErr) { console.warn("sync failed:", syncErr); }
          }
        }
      } catch(fbErr) { console.warn("FB lookup failed:", fbErr); }
    }

    // 5. Resolver
    if (user) {
      try {
        if (user.status === "SUSPENDIDO") {
          setErr("Tu cuenta está suspendida. Contacta al administrador.");
          setLoading(false); return;
        }
        onLogin(user);
        setLoading(false);
        return;
      } catch(loginErr) {
        console.error("onLogin failed:", loginErr);
        setErr("Error inesperado al entrar. Recarga la página.");
        setLoading(false);
        return;
      }
    }

    // 6. Diagnóstico
    let userByEmail = null;
    try {
      userByEmail = users.find(u => u?.email && u.email.toLowerCase().trim() === emailLow);
      // También checa Firebase para diagnóstico
      if (!userByEmail) {
        let fbUsers = await fbRead("users");
        if (fbUsers && !Array.isArray(fbUsers) && typeof fbUsers === "object") {
          fbUsers = Object.values(fbUsers);
        }
        if (Array.isArray(fbUsers)) {
          userByEmail = fbUsers.find(u => u?.email && u.email.toLowerCase().trim() === emailLow);
        }
      }
    } catch(e) { console.warn("diag failed:", e); }

    if (userByEmail) {
      setErr(`Contraseña incorrecta para ${emailLow}. Verifica e intenta de nuevo.`);
    } else {
      setErr(`No encontramos una cuenta con "${emailLow}". ¿Te registraste correctamente?`);
    }
    setLoading(false);
  };


  return (
    <div style={{
      minHeight:"100vh",
      background:"linear-gradient(160deg,#08101E 0%,#0D1829 100%)",
      display:"flex",flexDirection:"column",alignItems:"center",
      fontFamily:"'DM Sans',sans-serif",overflowX:"hidden"
    }}>
      <div style={{width:"100%",maxWidth:480,padding:"0 20px 32px",boxSizing:"border-box",paddingTop:44}}>

        {/* ── Banner de éxito al crear cuenta ── */}
        {registerSuccess&&(
          <div style={{background:"rgba(0,229,160,.1)",border:"1px solid rgba(0,229,160,.3)",borderRadius:14,padding:"14px 16px",marginBottom:14,display:"flex",gap:12,alignItems:"center"}}>
            <span style={{fontSize:28,flexShrink:0}}>🎉</span>
            <div>
              <div style={{fontWeight:800,fontSize:13,color:"#00E5A0",marginBottom:3}}>¡Cuenta creada con éxito!</div>
              <div style={{fontSize:12,color:"#B8CEDE",lineHeight:1.5}}>
                Bienvenido, <strong style={{color:"#FFFFFF"}}>{registerSuccess.nombre}</strong>. Ya puedes iniciar sesión con tu correo y contraseña.
              </div>
            </div>
          </div>
        )}

        {/* CARD */}
        <div style={{background:"#1A2C48",border:"1px solid rgba(255,255,255,.1)",borderRadius:22,padding:"28px 24px",marginBottom:14,boxShadow:"0 12px 40px rgba(0,0,0,.5)"}}>
          {/* BIENVENIDO centrado */}
          <div style={{textAlign:"center",marginBottom:22}}>
            <div style={{display:"flex",justifyContent:"center",marginBottom:12}}>
              <ChanceLogo height={64}/>
            </div>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:30,color:"#FFFFFF",letterSpacing:4,lineHeight:1}}>BIENVENIDO</div>
            <div style={{fontSize:13,color:"#93ADCC",marginTop:6}}>Inicia sesión en tu cuenta</div>
          </div>

          {/* Email */}
          <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:7}}>Correo electrónico</label>
          <input type="email" placeholder="tu@correo.com" value={email}
            onChange={e=>setEmail(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()}
            style={{display:"block",width:"100%",padding:"13px 15px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:12,color:"#FFFFFF",fontSize:14,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:14}}/>

          {/* Contraseña */}
          <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:7}}>Contraseña</label>
          <div style={{position:"relative",marginBottom:18}}>
            <input type={showPass?"text":"password"} placeholder="••••••••" value={pass}
              onChange={e=>setPass(e.target.value)} onKeyDown={e=>e.key==="Enter"&&handleLogin()}
              style={{display:"block",width:"100%",padding:"13px 72px 13px 15px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:12,color:"#FFFFFF",fontSize:14,fontFamily:"'DM Sans',sans-serif",outline:"none"}}/>
            <button onClick={()=>setShowPass(p=>!p)}
              style={{position:"absolute",right:12,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",color:"#9CB8D4",cursor:"pointer",fontSize:12,fontFamily:"'DM Sans',sans-serif",fontWeight:600}}>
              {showPass?"Ocultar":"Ver"}
            </button>
          </div>

          {err&&<div style={{background:"rgba(255,90,120,.12)",border:"1px solid rgba(255,90,120,.3)",borderRadius:10,padding:"10px 14px",fontSize:12,color:"#FF8FAC",marginBottom:14,lineHeight:1.5}}>{err}</div>}

          <button onClick={handleLogin} disabled={loading}
            style={{display:"block",width:"100%",padding:"14px",borderRadius:13,border:"none",background:loading?"rgba(255,204,51,.5)":"linear-gradient(135deg,#FFCC33,#D4A218)",color:"#08101E",fontFamily:"'DM Sans',sans-serif",fontWeight:800,fontSize:15,cursor:loading?"default":"pointer",boxShadow:"0 4px 24px rgba(255,204,51,.35)"}}>
            {loading?"Verificando…":"Iniciar sesión →"}
          </button>

          <div style={{display:"flex",alignItems:"center",gap:10,margin:"16px 0"}}>
            <div style={{flex:1,height:1,background:"rgba(255,255,255,.1)"}}/>
            <span style={{fontSize:11,color:"#7A96B8",fontWeight:600,whiteSpace:"nowrap"}}>o continúa con</span>
            <div style={{flex:1,height:1,background:"rgba(255,255,255,.1)"}}/>
          </div>

          <button onClick={()=>alert("Google Sign-In: En producción se integra con Firebase Auth / Google OAuth 2.0.")}
            style={{display:"flex",width:"100%",padding:"13px 16px",borderRadius:12,border:"1px solid rgba(255,255,255,.15)",background:"#FFFFFF",alignItems:"center",justifyContent:"center",gap:12,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,color:"#1F2937",boxShadow:"0 2px 14px rgba(0,0,0,.4)",boxSizing:"border-box"}}>
            <svg width="20" height="20" viewBox="0 0 24 24" style={{flexShrink:0}}>
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continuar con Google (Gmail)
          </button>

          <div style={{textAlign:"center",marginTop:14,fontSize:12,color:"#7A96B8"}}>
            ¿Olvidaste tu contraseña?{" "}
            <span style={{color:"#FFCC33",cursor:"pointer",fontWeight:700}}>Recuperar</span>
          </div>
        </div>

        {/* DEMO USERS */}
        <div style={{background:"rgba(77,181,255,.07)",border:"1px solid rgba(77,181,255,.2)",borderRadius:14,padding:"14px 16px",marginBottom:14}}>
          <div style={{fontSize:10,fontWeight:800,color:"#4DB5FF",letterSpacing:1.2,marginBottom:12,textTransform:"uppercase"}}>👤 Usuarios de demostración</div>
          {[
            {role:"Admin",      emoji:"👑",color:"#C4A8FF",email:"admin@chance.pa",  pass:"Admin2024!"},
            {role:"Comprador",  emoji:"🛒",color:"#00E5A0",email:"maria@demo.pa",    pass:"Compra123"},
            {role:"Vendedor",   emoji:"🏪",color:"#FFCC33",email:"carlos@demo.pa",   pass:"Vende123"},
            {role:"Repartidor", emoji:"🛵",color:"#4DB5FF",email:"juan@demo.pa",     pass:"Reparte123"},
          ].map((u,idx,arr)=>(
            <div key={u.role} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:idx<arr.length-1?"1px solid rgba(255,255,255,.06)":"none"}}>
              <div style={{display:"flex",gap:10,alignItems:"center"}}>
                <div style={{width:34,height:34,borderRadius:10,background:`${u.color}18`,border:`1px solid ${u.color}40`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0}}>{u.emoji}</div>
                <div>
                  <div style={{fontSize:12,fontWeight:700,color:u.color,marginBottom:1}}>{u.role}</div>
                  <div style={{fontSize:10,color:"#93ADCC"}}>{u.email}</div>
                </div>
              </div>
              <button onClick={()=>{setEmail(u.email);setPass(u.pass);setErr("");}}
                style={{padding:"7px 14px",borderRadius:10,border:`1px solid ${u.color}50`,background:`${u.color}15`,color:u.color,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>
                Usar →
              </button>
            </div>
          ))}
        </div>

        <button onClick={onGoRegister}
          style={{display:"block",width:"100%",padding:"14px",borderRadius:13,background:"rgba(255,255,255,.05)",border:"1.5px solid rgba(255,255,255,.18)",color:"#B8CEDE",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}}>
          Crear nueva cuenta
        </button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   PANTALLA DE REGISTRO — Multi-paso por rol
───────────────────────────────────────────────────────────────────────── */
function RegisterScreen({ onRegister, onGoLogin }) {
  const [step,  setStep]  = useState(0); // 0=rol, 1=básico, 2=rol-específico, 3=foto/docs
  const [role,  setRole]  = useState("");
  const [form,  setForm]  = useState({
    nombre:"",apellido:"",email:"",password:"",confirmPassword:"",
    cedula:"",telefono:"",provincia:"",distrito:"",corregimiento:"",lugarVende:"",
    numeroBilletero:"",sorteos:[],otrosDetalles:"",
    vehiculo:"",zonas:[],horarios:[],banco:"",cuentaBanco:"",tipoCuenta:"",
    metodosCobro:[],licencia:"",experiencia:"",
    photoId:null, photoBill:null, photoLic:null,
  });
  const [err,     setErr]     = useState("");
  const [loading, setLoading] = useState(false);

  const set = (k,v) => setForm(p=>({...p,[k]:v}));
  const toggleArr = (k,v) => setForm(p=>({...p,[k]:p[k].includes(v)?p[k].filter(x=>x!==v):[...p[k],v]}));

  /**
   * Convierte un File de imagen a una data URL comprimida (max ~600KB).
   * Mantiene la calidad razonable para que el admin pueda validar la cédula.
   * Para PDFs u otros tipos, devuelve la data URL sin compresión.
   */
  const fileToCompressedDataURL = (file) => new Promise((resolve, reject) => {
    if (!file) { resolve(null); return; }
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const dataUrl = reader.result;
      // Si NO es imagen (ej. PDF), guardar tal cual
      if (!file.type.startsWith("image/")) { resolve(dataUrl); return; }
      // Comprimir imagen: redimensionar y bajar calidad JPEG
      const img = new Image();
      img.onerror = () => resolve(dataUrl); // si falla, dejar original
      img.onload = () => {
        const MAX_DIM = 1280; // ancho/alto máximo
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const ratio = Math.min(MAX_DIM/width, MAX_DIM/height);
          width  = Math.round(width  * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
        // JPEG calidad 0.75 para reducir tamaño manteniendo legibilidad
        resolve(canvas.toDataURL("image/jpeg", 0.75));
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
  });

  /** Handler unificado para inputs file de fotos/documentos */
  const handlePhotoUpload = async (key, e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await fileToCompressedDataURL(file);
      set(key, dataUrl);
    } catch(err) {
      console.warn("Error procesando archivo:", err);
      setErr("No se pudo procesar el archivo. Intenta otro.");
    }
  };

  const STEPS_PER_ROLE = {
    cliente:     2,
    vendedor:    4,
    repartidor:  4,
  };
  const totalSteps = STEPS_PER_ROLE[role] || 3;

  const validateStep = () => {
    setErr("");
    if (step===0 && !role)   { setErr("Selecciona un tipo de cuenta."); return false; }
    if (step===1) {
      if (!form.nombre.trim())      { setErr("Ingresa tu nombre."); return false; }
      if (!form.apellido.trim())    { setErr("Ingresa tu apellido."); return false; }
      if (!form.email.includes("@")){ setErr("Correo inválido."); return false; }
      if (form.password.length<8)   { setErr("La contraseña debe tener al menos 8 caracteres."); return false; }
      if (form.password!==form.confirmPassword){ setErr("Las contraseñas no coinciden."); return false; }
      if (!form.cedula.trim())      { setErr("Ingresa tu cédula panameña."); return false; }
      if (!form.telefono.trim())    { setErr("Ingresa tu teléfono."); return false; }
    }
    if (step===2 && role==="vendedor") {
      if (!form.numeroBilletero.trim()){ setErr("Ingresa tu número de billetero (LNB)."); return false; }
      if (!form.provincia)            { setErr("Selecciona tu provincia."); return false; }
      if (form.sorteos.length===0)    { setErr("Selecciona al menos un sorteo."); return false; }
    }
    if (step===2 && role==="repartidor") {
      if (!form.vehiculo)             { setErr("Selecciona tu tipo de vehículo."); return false; }
      if (!form.provincia)            { setErr("Selecciona la provincia donde trabajas."); return false; }
    }
    return true;
  };

  const next = () => { if (validateStep()) setStep(s=>s+1); };
  const back = () => { setErr(""); setStep(s=>s-1); };

  const submit = async () => {
    if (!validateStep()) return;
    setLoading(true); setErr("");
    try {
      let users = [];
      try {
        const r = await window.storage.get("users_db");
        users = r?.value ? JSON.parse(r.value) : [];
      } catch(e) {}
      if (users.find(u=>u.email.toLowerCase()===form.email.toLowerCase())) {
        setErr("Ya existe una cuenta con ese correo."); setLoading(false); return;
      }
      const needsApproval = role==="vendedor" || role==="repartidor";
      const newUser = {
        id:         `U${Date.now()}`,
        email:      form.email.toLowerCase().trim(),
        password:   form.password,
        nombre:     `${form.nombre} ${form.apellido}`,
        rol:        role,
        cedula:     form.cedula,
        telefono:   form.telefono,
        provincia:  form.provincia,
        distrito:   form.distrito,
        corregimiento: form.corregimiento,
        lugarVende: form.lugarVende,
        numeroBilletero: form.numeroBilletero,
        sorteos:    form.sorteos,
        vehiculo:   form.vehiculo,
        zonas:      form.zonas,
        horarios:   form.horarios,
        banco:      form.banco,
        status:     needsApproval ? "PENDIENTE" : "ACTIVO",
        createdAt:  new Date().toLocaleDateString("es-PA"),
        hasPhoto:   !!form.photoId,
        hasLic:     !!form.photoLic,
        hasBill:    !!form.photoBill,
        // Guardar las imágenes (data URLs comprimidas) para que el admin
        // pueda visualizarlas y validar antes de aprobar al usuario.
        photoIdData:   form.photoId   || null,
        photoBillData: form.photoBill || null,
        photoLicData:  form.photoLic  || null,
      };
      try {
        const updatedUsers = [...users, newUser];
        await window.storage.set("users_db", JSON.stringify(updatedUsers));
        // ── SINCRONIZACIÓN CON FIREBASE ────────────────────────────────────
        // Subimos también a Firebase (path: users) para que el admin y otros
        // dispositivos vean al usuario recién registrado. Si Firebase falla,
        // no es crítico — el usuario quedó guardado localmente.
        try { await fbWrite("users", stripUserPhotos(updatedUsers)); } catch(fbErr) { console.warn("Firebase users sync failed:", fbErr); }
      } catch(e) {}
      onRegister(newUser);
    } catch(e) {
      // Storage failed but still proceed — user will be treated as new session
      console.warn("Storage save failed:", e);
    }
    setLoading(false);
  };

  const province    = form.provincia;
  const distritos   = getDistritos(province);
  const corregimientos = getCorregimientos(province, form.distrito);

  return (
    <div style={{
      minHeight:"100vh",
      background:"linear-gradient(160deg,#08101E 0%,#0D1829 100%)",
      display:"flex",flexDirection:"column",alignItems:"center",
      fontFamily:"'DM Sans',sans-serif",overflowX:"hidden"
    }}>
      {/* Header con logo + back */}
      <div style={{width:"100%",maxWidth:480,padding:"28px 20px 16px",display:"flex",alignItems:"center",gap:12,boxSizing:"border-box"}}>
        {step>0&&(
          <button onClick={back} style={{background:"#1A2C48",border:"1px solid rgba(255,255,255,.12)",borderRadius:10,width:38,height:38,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer",flexShrink:0}}>
            <Ic n="chevL" s={14} c="#93ADCC"/>
          </button>
        )}
        <div style={{flex:1}}>
          <ChanceLogo height={36}/>
          <div style={{fontSize:10,color:"#7A96B8",marginTop:3,fontWeight:600}}>Crear cuenta · Paso {step+1} de {totalSteps}</div>
        </div>
      </div>

      {/* Progress dots */}
      <div style={{display:"flex",gap:6,justifyContent:"center",marginBottom:16}}>
        {Array.from({length:totalSteps},(_,i)=>(
          <div key={i} style={{
            width:i<=step?24:8,height:8,borderRadius:4,
            background:i<=step?"#FFCC33":"rgba(255,255,255,.15)",
            transition:"all .25s",
            boxShadow:i<=step?"0 0 10px rgba(255,204,51,.4)":undefined
          }}/>
        ))}
      </div>

      <div style={{width:"100%",maxWidth:480,padding:"0 20px 32px",boxSizing:"border-box"}}>

        {/* ── PASO 0: Elegir Rol ── */}
        {step===0&&(
          <div style={{background:"#1A2C48",border:"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"22px 18px",marginBottom:14,boxShadow:"0 8px 28px rgba(0,0,0,.4)"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#FFFFFF",letterSpacing:2,marginBottom:4}}>TIPO DE CUENTA</div>
            <div style={{fontSize:12,color:"#B8CEDE",marginBottom:20}}>¿Cómo vas a usar CHANCE?</div>
            {[
              {id:"cliente",    emoji:"🛒", title:"Comprador",   sub:"Busca y compra billetes y chances de lotería",         color:"#00E5A0", bg:"rgba(0,229,160,.12)",  border:"rgba(0,229,160,.35)"},
              {id:"vendedor",   emoji:"🏪", title:"Vendedor",    sub:"Registra tu billetería y gestiona ventas.",             color:"#FFCC33", bg:"rgba(255,204,51,.12)", border:"rgba(255,204,51,.35)"},
              {id:"repartidor", emoji:"🛵", title:"Repartidor",  sub:"Entrega pedidos y gestiona tus ganancias.",            color:"#4DB5FF", bg:"rgba(77,181,255,.12)", border:"rgba(77,181,255,.35)"},
            ].map(r=>(
              <div key={r.id} onClick={()=>setRole(r.id)}
                style={{display:"flex",alignItems:"center",gap:13,padding:"16px",borderRadius:16,
                  border:`2px solid ${role===r.id?r.border:"rgba(255,255,255,.1)"}`,
                  background:role===r.id?r.bg:"rgba(255,255,255,.04)",
                  cursor:"pointer",marginBottom:10,transition:"all .2s",
                  boxShadow:role===r.id?`0 4px 20px ${r.border}`:undefined}}>
                <div style={{width:52,height:52,borderRadius:16,
                  background:role===r.id?r.bg:"rgba(255,255,255,.07)",
                  display:"flex",alignItems:"center",justifyContent:"center",fontSize:26,flexShrink:0,
                  border:`1.5px solid ${role===r.id?r.border:"rgba(255,255,255,.1)"}`}}>{r.emoji}</div>
                <div style={{flex:1}}>
                  <div style={{fontWeight:800,fontSize:15,color:role===r.id?r.color:"#FFFFFF",marginBottom:4}}>{r.title}</div>
                  <div style={{fontSize:12,color:"#9CB8D4",lineHeight:1.4}}>{r.sub}</div>
                  {(r.id==="vendedor"||r.id==="repartidor")&&(
                    <div style={{fontSize:10,color:"#FF8C55",fontWeight:700,marginTop:5}}>⏳ Sujeto a aprobación de CHANCE</div>
                  )}
                </div>
                <div style={{width:24,height:24,borderRadius:"50%",border:`2px solid ${role===r.id?r.color:"rgba(255,255,255,.2)"}`,
                  display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,
                  background:role===r.id?r.color:"transparent"}}>
                  {role===r.id&&<Ic n="check" s={13} c="#08101E"/>}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── PASO 1: Datos básicos (todos los roles) ── */}
        {step===1&&(
          <div style={{background:"#1A2C48",border:"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"22px 18px",marginBottom:14,boxShadow:"0 8px 28px rgba(0,0,0,.4)"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#FFFFFF",letterSpacing:2,marginBottom:16}}>DATOS PERSONALES</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Nombre *</label>
                <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} placeholder="María" value={form.nombre} onChange={e=>set("nombre",e.target.value)}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Apellido *</label>
                <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} placeholder="González" value={form.apellido} onChange={e=>set("apellido",e.target.value)}/>
              </div>
            </div>
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Correo electrónico *</label>
            <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} type="email" placeholder="tu@correo.com" value={form.email} onChange={e=>set("email",e.target.value)}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Contraseña * (min. 8)</label>
                <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} type="password" placeholder="••••••••" value={form.password} onChange={e=>set("password",e.target.value)}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Confirmar *</label>
                <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} type="password" placeholder="••••••••" value={form.confirmPassword} onChange={e=>set("confirmPassword",e.target.value)}/>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Cédula panameña *</label>
                <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} placeholder="8-123-4567" value={form.cedula} onChange={e=>set("cedula",e.target.value)}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Teléfono (+507) *</label>
                <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} placeholder="6xxx-xxxx" value={form.telefono} onChange={e=>set("telefono",e.target.value)}/>
              </div>
            </div>

            {/* Ubicación: Provincia → Distrito → Corregimiento */}
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Provincia</label>
            <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:10}} value={form.provincia}
              onChange={e=>{set("provincia",e.target.value);set("distrito","");set("corregimiento","");}}>
              <option value="">Seleccionar provincia…</option>
              {Object.keys(GEO_PANAMA).map(p=><option key={p} value={p}>{p}</option>)}
            </select>
            {distritos.length>0&&(
              <>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Distrito</label>
                <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:10}} value={form.distrito}
                  onChange={e=>{set("distrito",e.target.value);set("corregimiento","");}}>
                  <option value="">Seleccionar distrito…</option>
                  {distritos.map(d=><option key={d} value={d}>{d}</option>)}
                </select>
              </>
            )}
            {corregimientos.length>0&&(
              <>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Corregimiento</label>
                <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:10}} value={form.corregimiento}
                  onChange={e=>set("corregimiento",e.target.value)}>
                  <option value="">Seleccionar corregimiento…</option>
                  {corregimientos.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </>
            )}

            {/* Método de cobro / billetera (comprador) */}
            {role==="cliente"&&(
              <>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6,marginTop:4}}>Método de pago / billetera preferida</label>
                <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:0}} value={form.metodoCobro} onChange={e=>set("metodoCobro",e.target.value)}>
                  <option value="">Seleccionar…</option>
                  {METODOS_COBRO_EFECTIVO.map(m=><option key={m} value={m}>{m}</option>)}
                </select>
              </>
            )}
          </div>
        )}

        {/* ── PASO 2: Datos específicos VENDEDOR ── */}
        {step===2&&role==="vendedor"&&(
          <div style={{background:"#1A2C48",border:"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"22px 18px",marginBottom:14,boxShadow:"0 8px 28px rgba(0,0,0,.4)"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#FFFFFF",letterSpacing:2,marginBottom:16}}>INFO DEL VENDEDOR</div>
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Número de Billetero (LNB) *</label>
            <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:14}} placeholder="Ej: V-001234" value={form.numeroBilletero} onChange={e=>set("numeroBilletero",e.target.value)}/>

            <div style={{fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>📍 Lugar donde vende *</div>
            <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:8}} value={form.provincia} onChange={e=>{set("provincia",e.target.value);set("distrito","");set("corregimiento","");}}>
              <option value="">Provincia…</option>
              {Object.keys(GEO_PANAMA).map(p=><option key={p} value={p}>{p}</option>)}
            </select>
            {distritos.length>0&&(
              <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:8}} value={form.distrito} onChange={e=>{set("distrito",e.target.value);set("corregimiento","");}}>
                <option value="">Distrito…</option>
                {distritos.map(d=><option key={d} value={d}>{d}</option>)}
              </select>
            )}
            {corregimientos.length>0&&(
              <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:8}} value={form.corregimiento} onChange={e=>set("corregimiento",e.target.value)}>
                <option value="">Corregimiento…</option>
                {corregimientos.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            )}
            <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:14}} placeholder="Lugar exacto (Ej: Frente al parque Santa Ana)" value={form.lugarVende} onChange={e=>set("lugarVende",e.target.value)}/>

            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>Sorteos que vende *</label>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
              {SORTEOS_OPTS.map(s=>(
                <button key={s} style={{...(form.sorteos.includes(s)?"on":"")?{padding:"7px 12px",borderRadius:20,border:"1.5px solid #FFCC33",background:"rgba(255,204,51,.14)",color:"#FFCC33",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}:{padding:"7px 12px",borderRadius:20,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.05)",color:"#B8CEDE",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}} onClick={()=>toggleArr("sorteos",s)}>{s}</button>
              ))}
            </div>

            <div style={{background:"rgba(255,204,51,.07)",border:"1px solid rgba(255,204,51,.2)",borderRadius:12,padding:"14px",marginBottom:4}}>
              <div style={{fontSize:11,fontWeight:800,color:"#FFCC33",letterSpacing:1,marginBottom:10}}>💰 DATOS DE PAGO</div>
              <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Banco / billetera para recibir pagos</label>
              <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:10}} value={form.banco} onChange={e=>set("banco",e.target.value)}>
                <option value="">Seleccionar banco…</option>
                {BANCOS.map(b=><option key={b} value={b}>{b}</option>)}
              </select>
              <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Número de cuenta</label>
              <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:10}} placeholder="Ej: 04-12-345678-0" value={form.cuentaBanco} onChange={e=>set("cuentaBanco",e.target.value)}/>
              <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>También acepto pagos en:</label>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {METODOS_COBRO_EFECTIVO.map(m=>{
                  const sel = form.metodosCobro.includes(m);
                  return (
                  <button key={m} onClick={()=>toggleArr("metodosCobro",m)}
                    style={{padding:"8px 13px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",border:sel?"1.5px solid #FFCC33":"1.5px solid rgba(255,255,255,.2)",background:sel?"rgba(255,204,51,.14)":"rgba(255,255,255,.05)",color:sel?"#FFCC33":"#B8CEDE",transition:"all .18s"}}>
                    {m}
                  </button>
                  );
                })}
              </div>
            </div>

            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6,marginTop:10}}>Información adicional</label>
            <textarea
              placeholder="Años de experiencia, horario de atención, etc." rows={5}
              value={form.otrosDetalles} onChange={e=>set("otrosDetalles",e.target.value)}
              style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#FFFFFF",border:"1.5px solid rgba(255,255,255,.2)",borderRadius:11,color:"#1F2937",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12,resize:"vertical",minHeight:100}}/>
          </div>
        )}

        {/* ── PASO 2: Datos específicos REPARTIDOR ── */}
        {step===2&&role==="repartidor"&&(
          <div style={{background:"#1A2C48",border:"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"22px 18px",marginBottom:14,boxShadow:"0 8px 28px rgba(0,0,0,.4)"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#FFFFFF",letterSpacing:2,marginBottom:16}}>INFO DEL REPARTIDOR</div>
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>Tipo de vehículo *</label>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
              {VEHICULOS.map(v=>(
                <button key={v} style={{...(form.vehiculo===v?"on":"")?{padding:"7px 12px",borderRadius:20,border:"1.5px solid #FFCC33",background:"rgba(255,204,51,.14)",color:"#FFCC33",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}:{padding:"7px 12px",borderRadius:20,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.05)",color:"#B8CEDE",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}} onClick={()=>set("vehiculo",v)}>{v}</button>
              ))}
            </div>
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>Zonas de trabajo *</label>

            {/* Provincia */}
            <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:8}}
              value={form.provincia} onChange={e=>{set("provincia",e.target.value);set("distrito","");set("corregimiento","");set("lugarVende","");}}>
              <option value="">Provincia donde trabajas…</option>
              {Object.keys(GEO_PANAMA).map(p=><option key={p} value={p}>{p}</option>)}
            </select>
            {distritos.length>0&&(
              <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:8}}
                value={form.distrito} onChange={e=>{set("distrito",e.target.value);set("corregimiento","");}}>
                <option value="">Distrito…</option>
                {distritos.map(d=><option key={d} value={d}>{d}</option>)}
              </select>
            )}
            {corregimientos.length>0&&(
              <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:8}}
                value={form.corregimiento} onChange={e=>set("corregimiento",e.target.value)}>
                <option value="">Corregimiento…</option>
                {corregimientos.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            )}
            <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:14}}
              placeholder="Lugar exacto donde repartes (Ej: Albrook Mall, Via España…)"
              value={form.lugarVende} onChange={e=>set("lugarVende",e.target.value)}/>

            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:8}}>Disponibilidad horaria *</label>
            <div style={{display:"flex",gap:7,flexWrap:"wrap",marginBottom:14}}>
              {HORARIOS.map(h=>{
                const sel = form.horarios.includes(h);
                return (
                  <button key={h} onClick={()=>toggleArr("horarios",h)}
                    style={{padding:"9px 14px",borderRadius:20,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap",transition:"all .18s",
                      border:sel?"1.5px solid #4DB5FF":"1.5px solid rgba(255,255,255,.2)",
                      background:sel?"rgba(77,181,255,.14)":"rgba(255,255,255,.05)",
                      color:sel?"#4DB5FF":"#B8CEDE",
                      boxShadow:sel?"0 0 12px rgba(77,181,255,.2)":undefined}}>
                    {h}
                  </button>
                );
              })}
            </div>
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Número de licencia (si aplica)</label>
            <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:10}} placeholder="Ej: P-12345678" value={form.licencia} onChange={e=>set("licencia",e.target.value)}/>
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Años de experiencia en reparto</label>
            <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:14}} value={form.experiencia} onChange={e=>set("experiencia",e.target.value)}>
              {["","Menos de 1 año","1–2 años","3–5 años","Más de 5 años"].map(x=><option key={x} value={x}>{x||"Seleccionar…"}</option>)}
            </select>

            {/* Datos bancarios del repartidor */}
            <div style={{background:"rgba(77,181,255,.07)",border:"1px solid rgba(77,181,255,.2)",borderRadius:12,padding:"14px"}}>
              <div style={{fontSize:11,fontWeight:800,color:"#4DB5FF",letterSpacing:1,marginBottom:10}}>🏦 DATOS BANCARIOS (para recibir pagos)</div>
              <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Banco *</label>
              <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:10}} value={form.banco} onChange={e=>set("banco",e.target.value)}>
                <option value="">Seleccionar banco…</option>
                {BANCOS.map(b=><option key={b} value={b}>{b}</option>)}
              </select>
              <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Tipo de cuenta</label>
              <select style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",appearance:"none",WebkitAppearance:"none",marginBottom:10}} value={form.tipoCuenta} onChange={e=>set("tipoCuenta",e.target.value)}>
                <option value="">Seleccionar tipo…</option>
                {TIPOS_CUENTA.map(t=><option key={t} value={t}>{t}</option>)}
              </select>
              <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Número de cuenta</label>
              <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} placeholder="Ej: 04-12-345678-0" value={form.cuentaBanco} onChange={e=>set("cuentaBanco",e.target.value)}/>
            </div>
          </div>
        )}

        {/* ── PASO 3/4: Fotos y Documentos ── */}
        {(step===3&&(role==="vendedor"||role==="repartidor"))&&(
          <div style={{background:"#1A2C48",border:"1px solid rgba(255,255,255,.1)",borderRadius:18,padding:"22px 18px",marginBottom:14,boxShadow:"0 8px 28px rgba(0,0,0,.4)"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>DOCUMENTOS</div>
            <div style={{fontSize:12,color:"var(--muted)",marginBottom:18}}>Adjunta una foto de cada documento desde tu cámara o galería.</div>

            {/* Foto Cédula */}
            <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Cédula de identidad (foto) *</label>
            <div style={{width:"100%",padding:"20px",border:"2px dashed rgba(255,255,255,.2)",borderRadius:12,textAlign:"center",cursor:"pointer",background:"rgba(255,255,255,.04)"}} style={{marginBottom:12,borderColor:form.photoId?"var(--green)":"var(--border)"}}>
              <input type="file" accept="image/*" style={{display:"none"}} id="photoId" onChange={e=>handlePhotoUpload("photoId",e)}/>
              <label htmlFor="photoId" style={{cursor:"pointer",display:"block"}}>
                {form.photoId
                  ? <div><div style={{fontSize:28,marginBottom:4}}>✅</div><div style={{fontSize:12,color:"var(--green)",fontWeight:700}}>Cédula cargada</div></div>
                  : <div><div style={{fontSize:28,marginBottom:4}}>📷</div><div style={{fontSize:12,color:"var(--muted)"}}>Toca para adjuntar foto de tu cédula</div><div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>JPG, PNG · Máx 5MB</div></div>}
              </label>
            </div>

            {/* Comprobante (solo vendedor) */}
            {role==="vendedor"&&(
              <>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Comprobante de billetero / devolución LNB</label>
                <div style={{width:"100%",padding:"20px",border:"2px dashed rgba(255,255,255,.2)",borderRadius:12,textAlign:"center",cursor:"pointer",background:"rgba(255,255,255,.04)"}} style={{marginBottom:12,borderColor:form.photoBill?"var(--green)":"var(--border)"}}>
                  <input type="file" accept="image/*,application/pdf" style={{display:"none"}} id="photoBill" onChange={e=>handlePhotoUpload("photoBill",e)}/>
                  <label htmlFor="photoBill" style={{cursor:"pointer",display:"block"}}>
                    {form.photoBill
                      ? <div><div style={{fontSize:28,marginBottom:4}}>✅</div><div style={{fontSize:12,color:"var(--green)",fontWeight:700}}>Comprobante cargado</div></div>
                      : <div><div style={{fontSize:28,marginBottom:4}}>📄</div><div style={{fontSize:12,color:"var(--muted)"}}>Comprobante de billetero o cancelación</div><div style={{fontSize:10,color:"var(--muted)",marginTop:4}}>JPG, PNG, PDF · Máx 10MB</div></div>}
                  </label>
                </div>
              </>
            )}

            {/* Licencia (repartidor) */}
            {role==="repartidor"&&(
              <>
                <label style={{display:"block",fontSize:11,fontWeight:800,color:"#9CB8D4",letterSpacing:1,textTransform:"uppercase",marginBottom:6}}>Foto de licencia de conducir (si aplica)</label>
                <div style={{width:"100%",padding:"20px",border:"2px dashed rgba(255,255,255,.2)",borderRadius:12,textAlign:"center",cursor:"pointer",background:"rgba(255,255,255,.04)"}} style={{marginBottom:12,borderColor:form.photoLic?"var(--green)":"var(--border)"}}>
                  <input type="file" accept="image/*" style={{display:"none"}} id="photoLic" onChange={e=>handlePhotoUpload("photoLic",e)}/>
                  <label htmlFor="photoLic" style={{cursor:"pointer",display:"block"}}>
                    {form.photoLic
                      ? <div><div style={{fontSize:28,marginBottom:4}}>✅</div><div style={{fontSize:12,color:"var(--green)",fontWeight:700}}>Licencia cargada</div></div>
                      : <div><div style={{fontSize:28,marginBottom:4}}>🪪</div><div style={{fontSize:12,color:"var(--muted)"}}>Foto de tu licencia de conducir</div></div>}
                  </label>
                </div>
              </>
            )}

            <div style={{background:"rgba(244,196,48,.06)",borderRadius:10,padding:"9px 12px",fontSize:10,color:"var(--muted)",lineHeight:1.6}}>
              🔒 Tus documentos son tratados de forma confidencial conforme a la Ley 81 de Panamá (Protección de Datos Personales).
            </div>
          </div>
        )}

        {err&&<div style={{background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.25)",borderRadius:10,padding:"10px 14px",fontSize:12,color:"var(--red)",margin:"0 0 12px"}}>{err}</div>}

        {/* Botones navegación */}
        {step < totalSteps-1
          ? <button style={{display:"block",width:"100%",padding:"14px",borderRadius:13,border:"none",background:"linear-gradient(135deg,#FFCC33,#D4A218)",color:"#08101E",fontFamily:"'DM Sans',sans-serif",fontWeight:800,fontSize:15,cursor:"pointer",boxShadow:"0 4px 24px rgba(255,204,51,.35)",marginBottom:10}} style={{marginBottom:10}} onClick={next}>Continuar →</button>
          : <button style={{display:"block",width:"100%",padding:"14px",borderRadius:13,border:"none",background:"linear-gradient(135deg,#FFCC33,#D4A218)",color:"#08101E",fontFamily:"'DM Sans',sans-serif",fontWeight:800,fontSize:15,cursor:"pointer",boxShadow:"0 4px 24px rgba(255,204,51,.35)",marginBottom:10}} style={{marginBottom:10}} onClick={submit} disabled={loading}>
              {loading?"Creando cuenta…":"✓ Crear cuenta"}
            </button>}

        <button style={{display:"block",width:"100%",padding:"13px",borderRadius:13,background:"rgba(255,255,255,.05)",border:"1.5px solid rgba(255,255,255,.18)",color:"#B8CEDE",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer"}} onClick={onGoLogin}>Ya tengo cuenta</button>
        <div style={{height:20}}/>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   PANTALLA DE APROBACIÓN PENDIENTE
───────────────────────────────────────────────────────────────────────── */
function PendingApprovalScreen({ user, onLogout }) {
  const rol = user.rol==="vendedor" ? "Vendedor" : "Repartidor";
  return (
    <div className="auth-shell">
      <div style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"24px 24px"}}>
        <ChanceLogo height={52} style={{marginBottom:20}}/>
        <div className="pend-card" style={{width:"100%"}}>
          <div style={{fontSize:52,marginBottom:10}}>⏳</div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:"var(--gold)",letterSpacing:2,marginBottom:8}}>REVISANDO TU CUENTA</div>
          <div style={{fontSize:13,color:"var(--text)",fontWeight:700,marginBottom:6}}>{user.nombre}</div>
          <div style={{display:"inline-block",padding:"4px 12px",borderRadius:10,background:"rgba(244,196,48,.12)",border:"1px solid rgba(244,196,48,.28)",fontSize:11,color:"var(--gold)",fontWeight:800,marginBottom:14}}>
            {rol} · {user.cedula}
          </div>
          <div style={{fontSize:12,color:"var(--muted)",lineHeight:1.7,marginBottom:16}}>
            Tu solicitud como <strong style={{color:"var(--text)"}}>{rol}</strong> está siendo revisada por el equipo de <strong style={{color:"var(--gold)"}}>CHANCE</strong>. Recibirás una notificación cuando sea aprobada.
          </div>
          <div style={{background:"var(--bg3)",borderRadius:12,padding:"12px",textAlign:"left",marginBottom:16}}>
            {[
              ["📋","Cédula verificada",user.cedula],
              user.rol==="vendedor"?["🎟","Número de billetero",user.numeroBilletero]:["🛵","Vehículo",user.vehiculo],
              ["📍","Zona",(user.provincia||"")+(user.distrito?` · ${user.distrito}`:"")],
              ["📅","Solicitud",user.createdAt],
            ].filter(Boolean).map(([ic,l,v])=>(
              <div key={l} style={{display:"flex",gap:10,alignItems:"center",marginBottom:8}}>
                <span style={{fontSize:16,width:22,textAlign:"center",flexShrink:0}}>{ic}</span>
                <div style={{flex:1}}>
                  <div style={{fontSize:10,color:"var(--muted)",fontWeight:700}}>{l}</div>
                  <div style={{fontSize:12,color:"var(--text)",fontWeight:600}}>{v||"—"}</div>
                </div>
              </div>
            ))}
          </div>
          <div style={{fontSize:10,color:"var(--muted)"}}>El proceso de aprobación toma 1–3 días hábiles.</div>
        </div>
        <button onClick={onLogout} style={{display:"block",width:"100%",padding:"13px",borderRadius:13,background:"rgba(255,255,255,.05)",border:"1.5px solid rgba(255,255,255,.18)",color:"#B8CEDE",fontFamily:"'DM Sans',sans-serif",fontWeight:700,fontSize:14,cursor:"pointer",marginTop:12}}>Cerrar sesión</button>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   PANEL DE ADMINISTRADOR
───────────────────────────────────────────────────────────────────────── */
function AdminPanel({ adminUser, onLogout }) {
  const [users, setUsers]       = useStorage("users_db", []);
  const [aTab,  setATab]        = useState("dashboard");
  const [search, setSearch]     = useState("");
  const [filterRole, setFilterRole] = useState("todos");

  // ── HIDRATAR USUARIOS DESDE FIREBASE Y GARANTIZAR DEMOS ─────────────────
  // El admin SIEMPRE debe ver al menos los 4 demos (admin, María, Carlos, Juan).
  // Si Firebase tiene más usuarios reales, los trae también.
  // Polling cada 5s para detectar nuevos registros automáticamente.
  useEffect(() => {
    let active = true;

    // Demos garantizados — siempre presentes
    const DEMOS_BASE = [
      {id:"admin1", email:"admin@chance.pa",  password:"Admin2024!", nombre:"Admin CHANCE",   rol:"admin",      cedula:"8-999-0001",telefono:"6000-0001",status:"ACTIVO",createdAt:"01/01/2026"},
      {id:"demo_c", email:"maria@demo.pa",    password:"Compra123",  nombre:"María González", rol:"cliente",    cedula:"8-123-4567",telefono:"6234-5678",status:"ACTIVO",createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"San Francisco"},
      {id:"demo_v", email:"carlos@demo.pa",   password:"Vende123",   nombre:"Carlos Medina",  rol:"vendedor",   cedula:"8-222-3333",telefono:"6111-2222",status:"ACTIVO",createdAt:"01/01/2026",numeroBilletero:"V001",lugarVende:"Calle 50, San Francisco"},
      {id:"demo_r", email:"juan@demo.pa",     password:"Reparte123", nombre:"Juan Rodríguez", rol:"repartidor", cedula:"8-444-5555",telefono:"6333-4444",status:"ACTIVO",createdAt:"01/01/2026",vehiculo:"🏍 Motocicleta"},
    ];

    const sync = async () => {
      try {
        // 1. Lee storage local
        let local = [];
        try {
          const r = await window.storage.get("users_db");
          if (r?.value) {
            const p = JSON.parse(r.value);
            local = Array.isArray(p) ? p : (p && typeof p === "object" ? Object.values(p) : []);
          }
        } catch(e) {}

        // 2. Lee Firebase
        let fbUsers = [];
        try {
          let raw = await fbRead("users");
          if (raw && !Array.isArray(raw) && typeof raw === "object") {
            raw = Object.values(raw);
          }
          if (Array.isArray(raw)) fbUsers = raw.filter(u => u && typeof u === "object");
        } catch(e) {}

        // 3. Combinar: demos garantizados + locales + Firebase (sin duplicar emails)
        const combined = [];
        const seenEmails = new Set();
        // Demos primero
        for (const d of DEMOS_BASE) {
          if (d?.email) {
            const e = d.email.toLowerCase().trim();
            if (!seenEmails.has(e)) { combined.push(d); seenEmails.add(e); }
          }
        }
        // Locales (puede tener fotos)
        for (const u of local) {
          if (u?.email) {
            const e = u.email.toLowerCase().trim();
            if (!seenEmails.has(e)) { combined.push(u); seenEmails.add(e); }
          }
        }
        // Firebase (puede tener registros recientes que no están local)
        for (const u of fbUsers) {
          if (u?.email) {
            const e = u.email.toLowerCase().trim();
            if (!seenEmails.has(e)) { combined.push(u); seenEmails.add(e); }
            else {
              // Si ya existe en combined, actualizar status desde FB (es la fuente de verdad)
              const existing = combined.find(x => x?.email?.toLowerCase()?.trim() === e);
              if (existing && u.status) existing.status = u.status;
            }
          }
        }

        if (active && combined.length > 0) {
          setUsers(combined);
          // Persistir el merge para próxima vez
          try { await window.storage.set("users_db", JSON.stringify(combined)); } catch(e) {}
          // Si Firebase está vacío, subir los demos para sincronizar
          if (fbUsers.length === 0) {
            try { await fbWrite("users", combined); } catch(e) {}
          }
        }
      } catch(e) { console.warn("Admin user sync failed:", e); }
    };
    sync(); // primera carga
    const t = setInterval(sync, 5000);
    return () => { active = false; clearInterval(t); };
  }, []);
  const [filterStatus, setFilterStatus] = useState("todos");
  const [selectedUser, setSelectedUser] = useState(null);
  const [actionFeedback, setActionFeedback] = useState("");

  const toast = (msg) => { setActionFeedback(msg); setTimeout(()=>setActionFeedback(""), 3000); };

  const updateUser = async (uid, patch) => {
    const updated = users.map(u => u.id===uid ? {...u,...patch} : u);
    await setUsers(updated);
    // Sincronizar con Firebase para que el cambio (ej. aprobación) llegue
    // al usuario en su propio dispositivo
    try { await fbWrite("users", stripUserPhotos(updated)); } catch(e) { console.warn("FB sync failed:", e); }
    if (selectedUser?.id===uid) setSelectedUser(prev=>({...prev,...patch}));
    toast("✅ Usuario actualizado");
  };

  const deleteUser = async (uid) => {
    if (!window.confirm("¿Eliminar usuario permanentemente?")) return;
    const updated = users.filter(u=>u.id!==uid);
    await setUsers(updated);
    try { await fbWrite("users", stripUserPhotos(updated)); } catch(e) { console.warn("FB sync failed:", e); }
    setSelectedUser(null);
    toast("🗑 Usuario eliminado");
  };

  const filteredUsers = users.filter(u=>{
    const matchS = filterStatus==="todos" || u.status===filterStatus;
    const matchR = filterRole==="todos"   || u.rol===filterRole;
    const matchQ = !search.trim() || u.nombre?.toLowerCase().includes(search.toLowerCase())
      || u.email?.toLowerCase().includes(search.toLowerCase())
      || u.cedula?.includes(search);
    return matchS && matchR && matchQ;
  });

  const stats = {
    total:      users.length,
    activos:    users.filter(u=>u.status==="ACTIVO").length,
    pendientes: users.filter(u=>u.status==="PENDIENTE").length,
    suspendidos:users.filter(u=>u.status==="SUSPENDIDO").length,
    clientes:   users.filter(u=>u.rol==="cliente").length,
    vendedores: users.filter(u=>u.rol==="vendedor").length,
    repartidores:users.filter(u=>u.rol==="repartidor").length,
  };

  const rolLabel = {cliente:"Comprador",vendedor:"Vendedor",repartidor:"Repartidor",admin:"Admin"};
  const rolClass = {cliente:"r-cliente",vendedor:"r-vendedor",repartidor:"r-repartidor",admin:"r-admin"};
  const stClass  = {ACTIVO:"st-active",PENDIENTE:"st-pending",SUSPENDIDO:"st-suspended"};
  const stLabel  = {ACTIVO:"Activo",PENDIENTE:"Pendiente",SUSPENDIDO:"Suspendido"};

  // ─── Estado de configuraciones admin (persistidas) ───
  const [adminCfg, setAdminCfg] = useStorage("admin_cfg", {
    // Comisiones (en centavos × 100 para precisión)
    commissionPctVendor: 2.5,           // % que paga el vendedor a la app
    serviceFeeUSD:       1.00,          // service fee fijo en USD
    deliveryTiers: [
      { maxKm: 3,  fee: 2.50 },
      { maxKm: 6,  fee: 3.50 },
      { maxKm: 10, fee: 5.00 },
      { maxKm: 15, fee: 7.00 },
      { maxKm: 25, fee: 10.00 },
    ],
    deliveryExtraPerKm: 0.40,
    // Hora tope diaria (HH:mm formato 24h) para cerrar las ventas y limpiar
    // automáticamente los tableros de los vendedores. Después de esta hora,
    // los compradores ya no pueden hacer pedidos al vendedor del día y los
    // billetes/chances se borran del inventario para que el vendedor pueda
    // ingresar el inventario del próximo sorteo.
    cierreHoraTope: "15:00",   // 3:00 PM hora de Panamá (default)
    cierreActivo:   true,       // Si false, no se aplica cierre automático
    // Zonas de cobertura
    zonas: [
      { id:1, nombre:"Ciudad de Panamá", activa:true, radiusKm:25 },
      { id:2, nombre:"San Miguelito",    activa:true, radiusKm:15 },
      { id:3, nombre:"Arraiján",         activa:true, radiusKm:20 },
      { id:4, nombre:"La Chorrera",      activa:false,radiusKm:25 },
      { id:5, nombre:"Colón",            activa:false,radiusKm:30 },
      { id:6, nombre:"Chepo",            activa:false,radiusKm:20 },
    ],
    // Seguridad
    requireMFA:        false,
    sessionTimeoutMin: 60,
    minPwdLen:         8,
    requireSpecialChar:true,
    blockAfterFails:   5,
  });

  // Sub-pantalla de config activa: null | "sorteos" | "comisiones" | "zonas" | "notif" | "reportes" | "seguridad" | "terminos"
  const [cfgSection, setCfgSection] = useState(null);
  // Notificación push (form)
  const [pushTitle, setPushTitle]   = useState("");
  const [pushMsg,   setPushMsg]     = useState("");
  const [pushAudience, setPushAudience] = useState("todos");
  // Términos & condiciones
  const [terminosTxt, setTerminosTxt] = useStorage("admin_terminos", "Términos y condiciones de uso de CHANCE — Lotería Nacional de Beneficencia de Panamá.\n\n1. Aceptación de términos…\n2. Uso permitido…\n3. Privacidad…\n4. Limitación de responsabilidad…");

  const updateCfg = (patch) => {
    const next = { ...adminCfg, ...patch };
    setAdminCfg(next);
    // ── PROPAGAR cambios al motor de cálculos ──────────────────────────────
    // Sin esto, los cambios en comisiones/delivery se quedaban en storage
    // pero NO afectaban los cálculos reales (calcOrderTotals, calcDeliveryFee).
    applyAdminCfg(next);
    // También sincronizamos con Firebase para que otros admins vean los
    // cambios en tiempo real.
    try { fbWrite("admin_cfg", next); } catch(e) { console.warn("FB cfg sync failed:", e); }
  };

  // Aplicar la config al motor cuando AdminPanel monta (y cuando cambia el storage).
  // Sin esto, al refrescar la página los cálculos volverían a usar los defaults.
  useEffect(() => { applyAdminCfg(adminCfg); }, [adminCfg]);

  return (
    <div style={{background:"var(--bg)",minHeight:"100vh",fontFamily:"'DM Sans',sans-serif"}}>
      <div style={{maxWidth:480,margin:"0 auto",padding:"0 0 32px"}}>

        {/* Topbar Admin */}
        <div style={{background:"var(--bg2)",borderBottom:"1px solid var(--border)",padding:"12px 18px",display:"flex",alignItems:"center",justifyContent:"space-between",position:"sticky",top:0,zIndex:100}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:34,height:34,borderRadius:10,background:"rgba(167,139,250,.15)",border:"1px solid rgba(167,139,250,.3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>👑</div>
            <div>
              <div style={{display:"flex",alignItems:"center",gap:8}}><ChanceLogo height={22}/><span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#A78BFA",letterSpacing:2}}>ADMIN</span></div>
              <div style={{fontSize:9,color:"var(--muted)"}}>{adminUser.nombre}</div>
            </div>
          </div>
          <button onClick={onLogout} style={{background:"none",border:"none",color:"var(--muted)",cursor:"pointer",fontSize:11,fontFamily:"'DM Sans',sans-serif"}}>Salir</button>
        </div>

        {/* Feedback toast */}
        {actionFeedback&&(
          <div style={{background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",margin:"10px 16px",borderRadius:11,padding:"9px 14px",fontSize:12,color:"var(--green)",fontWeight:700}}>{actionFeedback}</div>
        )}

        {/* Nav Admin */}
        <div style={{padding:"10px 14px"}}>
          <div style={{display:"flex",gap:6,overflowX:"auto",scrollbarWidth:"none",paddingBottom:4}}>
            {[
              {id:"dashboard",l:"Dashboard",ic:"home"},
              {id:"usuarios",  l:"Usuarios",  ic:"user"},
              {id:"pendientes",l:`Pendientes ${stats.pendientes>0?`(${stats.pendientes})`:""}`,ic:"bell"},
              {id:"config",    l:"Config",    ic:"sliders"},
            ].map(t=>(
              <button key={t.id} onClick={()=>setATab(t.id)}
                style={{display:"flex",alignItems:"center",gap:5,padding:"7px 13px",borderRadius:18,border:`1.5px solid ${aTab===t.id?"#A78BFA":"var(--border)"}`,background:aTab===t.id?"rgba(167,139,250,.1)":"var(--bg2)",color:aTab===t.id?"#A78BFA":"var(--muted)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",flexShrink:0}}>
                <Ic n={t.ic} s={12} c={aTab===t.id?"#A78BFA":"var(--muted)"}/>
                {t.l}
              </button>
            ))}
          </div>
        </div>

        <div style={{padding:"4px 16px"}}>

          {/* ── TAB: DASHBOARD ── */}
          {aTab==="dashboard"&&(
            <>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:14}}>RESUMEN GENERAL</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:12}}>
                {[
                  {v:stats.total,      l:"Total usuarios",   c:"var(--text)"},
                  {v:stats.activos,    l:"Activos",          c:"var(--green)"},
                  {v:stats.pendientes, l:"Pendientes",       c:"var(--gold)"},
                  {v:stats.suspendidos,l:"Suspendidos",      c:"var(--red)"},
                ].map(s=>(
                  <div key={s.l} className="stat"><div className="sval" style={{color:s.c}}>{s.v}</div><div className="slbl">{s.l}</div></div>
                ))}
              </div>

              <div className="admin-card">
                <div style={{padding:"10px 14px",fontSize:10,fontWeight:800,color:"var(--muted)",letterSpacing:1,textTransform:"uppercase"}}>Por Rol</div>
                {[
                  {l:"🛒 Compradores",  v:stats.clientes,     c:"var(--green)"},
                  {l:"🏪 Vendedores",   v:stats.vendedores,   c:"var(--gold)"},
                  {l:"🛵 Repartidores", v:stats.repartidores, c:"var(--blue)"},
                ].map(r=>(
                  <div key={r.l} className="admin-row">
                    <div style={{flex:1,fontSize:12,color:"var(--text)",fontWeight:600}}>{r.l}</div>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:r.c,letterSpacing:1}}>{r.v}</div>
                  </div>
                ))}
              </div>

              {stats.pendientes>0&&(
                <div style={{background:"rgba(244,196,48,.07)",border:"1px solid rgba(244,196,48,.25)",borderRadius:13,padding:"12px 14px",cursor:"pointer"}} onClick={()=>setATab("pendientes")}>
                  <div style={{fontSize:12,fontWeight:800,color:"var(--gold)",marginBottom:3}}>
                    ⏳ {stats.pendientes} solicitudes pendientes de aprobación
                  </div>
                  <div style={{fontSize:10,color:"var(--muted)"}}>Toca para revisar y aprobar</div>
                </div>
              )}
            </>
          )}

          {/* ── TAB: USUARIOS ── */}
          {aTab==="usuarios"&&(
            <>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:10}}>USUARIOS</div>
              <input style={{display:"block",width:"100%",padding:"12px 14px",boxSizing:"border-box",background:"#243A58",border:"1.5px solid rgba(255,255,255,.15)",borderRadius:11,color:"#FFFFFF",fontSize:13,fontFamily:"'DM Sans',sans-serif",outline:"none",marginBottom:12}} placeholder="Buscar por nombre, correo o cédula…" style={{marginBottom:10}} value={search} onChange={e=>setSearch(e.target.value)}/>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
                {["todos","cliente","vendedor","repartidor"].map(r=>(
                  <button key={r} style={{...(filterRole===r?"on":"")?{padding:"7px 12px",borderRadius:20,border:"1.5px solid #FFCC33",background:"rgba(255,204,51,.14)",color:"#FFCC33",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}:{padding:"7px 12px",borderRadius:20,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.05)",color:"#B8CEDE",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}} onClick={()=>setFilterRole(r)} style={{textTransform:"capitalize",fontSize:10}}>{r==="todos"?"Todos":rolLabel[r]}</button>
                ))}
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:14}}>
                {["todos","ACTIVO","PENDIENTE","SUSPENDIDO"].map(s=>(
                  <button key={s} style={{...(filterStatus===s?"on":"")?{padding:"7px 12px",borderRadius:20,border:"1.5px solid #FFCC33",background:"rgba(255,204,51,.14)",color:"#FFCC33",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}:{padding:"7px 12px",borderRadius:20,border:"1.5px solid rgba(255,255,255,.18)",background:"rgba(255,255,255,.05)",color:"#B8CEDE",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",whiteSpace:"nowrap"}}} onClick={()=>setFilterStatus(s)} style={{fontSize:10}}>{s==="todos"?"Todos los estados":stLabel[s]||s}</button>
                ))}
              </div>

              {filteredUsers.length===0?(
                <div style={{textAlign:"center",padding:"32px 0",opacity:.5}}>
                  <div style={{fontSize:36,marginBottom:8}}>👤</div>
                  <div style={{fontSize:13,fontWeight:700,color:"var(--text)"}}>Sin resultados</div>
                </div>
              ):filteredUsers.map(u=>(
                <div key={u.id} className="admin-card" style={{cursor:"pointer",marginBottom:9}} onClick={()=>setSelectedUser(u)}>
                  <div className="admin-row">
                    <div style={{width:42,height:42,borderRadius:12,background:`rgba(${u.rol==="vendedor"?"244,196,48":u.rol==="repartidor"?"59,158,255":"0,214,143"},.1)`,border:`1px solid rgba(${u.rol==="vendedor"?"244,196,48":u.rol==="repartidor"?"59,158,255":"0,214,143"},.25)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>
                      {u.rol==="vendedor"?"🏪":u.rol==="repartidor"?"🛵":u.rol==="admin"?"👑":"🛒"}
                    </div>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:3,flexWrap:"wrap"}}>
                        <span style={{fontWeight:800,fontSize:13,color:"var(--text)"}}>{u.nombre}</span>
                        <span className={`role-pill ${rolClass[u.rol]||""}`}>{rolLabel[u.rol]||u.rol}</span>
                        <span className={`role-pill ${stClass[u.status]||""}`}>{stLabel[u.status]||u.status}</span>
                      </div>
                      <div style={{fontSize:10,color:"var(--muted)",whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{u.email}</div>
                      <div style={{fontSize:10,color:"var(--muted)"}}>{u.cedula} · {u.createdAt}</div>
                    </div>
                    <Ic n="chevR" s={14} c="var(--muted)"/>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* ── TAB: PENDIENTES ── */}
          {aTab==="pendientes"&&(
            <>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:14}}>SOLICITUDES PENDIENTES</div>
              {users.filter(u=>u.status==="PENDIENTE").length===0?(
                <div style={{textAlign:"center",padding:"40px 0",opacity:.5}}>
                  <div style={{fontSize:48,marginBottom:10}}>✅</div>
                  <div style={{fontSize:14,fontWeight:700,color:"var(--text)"}}>Sin pendientes</div>
                  <div style={{fontSize:11,color:"var(--muted)"}}>Todas las solicitudes están al día</div>
                </div>
              ):users.filter(u=>u.status==="PENDIENTE").map(u=>(
                <div key={u.id} className="admin-card" style={{marginBottom:10}}>
                  <div className="admin-row" style={{flexDirection:"column",alignItems:"flex-start",gap:8}}>
                    <div style={{display:"flex",gap:10,alignItems:"center",width:"100%"}}>
                      <div style={{fontSize:22,flexShrink:0}}>{u.rol==="vendedor"?"🏪":"🛵"}</div>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:800,fontSize:13,color:"var(--text)"}}>{u.nombre}</div>
                        <span className={`role-pill ${rolClass[u.rol]}`}>{rolLabel[u.rol]}</span>
                        <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>{u.email} · {u.cedula}</div>
                      </div>
                    </div>

                    {/* Detalles del solicitante */}
                    <div style={{background:"var(--bg3)",borderRadius:10,padding:"9px 12px",width:"100%",boxSizing:"border-box"}}>
                      {u.rol==="vendedor"&&[
                        ["🎟 Billetero",u.numeroBilletero],
                        ["📍 Ubicación",(u.provincia||"")+(u.distrito?` · ${u.distrito}`:"")+( u.lugarVende?` · ${u.lugarVende}`:"")],
                        ["🎲 Sorteos",(u.sorteos||[]).join(", ")||"—"],
                        ["📱 Teléfono",u.telefono],
                        ["🏦 Banco",u.banco||"—"],
                        ["📷 Docs",`Cédula:${u.hasPhoto?"✓":"✗"} · Billetero:${u.hasBill?"✓":"✗"}`],
                      ].map(([l,v])=>(
                        <div key={l} style={{display:"flex",gap:8,marginBottom:5}}>
                          <span style={{fontSize:10,color:"var(--muted)",minWidth:80,flexShrink:0,fontWeight:700}}>{l}</span>
                          <span style={{fontSize:10,color:"var(--text)",flex:1}}>{v||"—"}</span>
                        </div>
                      ))}
                      {u.rol==="repartidor"&&[
                        ["🛵 Vehículo",u.vehiculo],
                        ["📍 Zonas",(u.zonas||[]).slice(0,3).join(", ")+(u.zonas?.length>3?" +más":"")],
                        ["⏰ Horarios",(u.horarios||[]).join(", ")||"—"],
                        ["📜 Licencia",u.licencia||"No aplica"],
                        ["💼 Exp.",u.experiencia||"—"],
                        ["📷 Docs",`Cédula:${u.hasPhoto?"✓":"✗"} · Licencia:${u.hasLic?"✓":"✗"}`],
                      ].map(([l,v])=>(
                        <div key={l} style={{display:"flex",gap:8,marginBottom:5}}>
                          <span style={{fontSize:10,color:"var(--muted)",minWidth:80,flexShrink:0,fontWeight:700}}>{l}</span>
                          <span style={{fontSize:10,color:"var(--text)",flex:1}}>{v||"—"}</span>
                        </div>
                      ))}
                    </div>

                    {/* ── Visor de documentos adjuntos para validación ── */}
                    {(u.photoIdData || u.photoBillData || u.photoLicData) && (
                      <div style={{width:"100%"}}>
                        <div style={{fontSize:10,color:"var(--muted)",fontWeight:700,marginBottom:6,letterSpacing:.5,textTransform:"uppercase"}}>
                          📎 Documentos adjuntos · Tap para ampliar
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                          {u.photoIdData && (
                            <a href={u.photoIdData} target="_blank" rel="noopener" style={{textDecoration:"none",display:"block"}}>
                              <div style={{borderRadius:9,overflow:"hidden",border:"1.5px solid rgba(0,214,143,.35)",background:"var(--bg3)"}}>
                                {u.photoIdData.startsWith("data:image/") ? (
                                  <img src={u.photoIdData} alt="Cédula" style={{width:"100%",height:90,objectFit:"cover",display:"block"}}/>
                                ) : (
                                  <div style={{height:90,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>📄</div>
                                )}
                                <div style={{fontSize:9,color:"var(--green)",fontWeight:800,padding:"5px 7px",textAlign:"center"}}>📋 Cédula</div>
                              </div>
                            </a>
                          )}
                          {u.photoBillData && (
                            <a href={u.photoBillData} target="_blank" rel="noopener" style={{textDecoration:"none",display:"block"}}>
                              <div style={{borderRadius:9,overflow:"hidden",border:"1.5px solid rgba(244,196,48,.35)",background:"var(--bg3)"}}>
                                {u.photoBillData.startsWith("data:image/") ? (
                                  <img src={u.photoBillData} alt="Billetero" style={{width:"100%",height:90,objectFit:"cover",display:"block"}}/>
                                ) : (
                                  <div style={{height:90,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>📄</div>
                                )}
                                <div style={{fontSize:9,color:"var(--gold)",fontWeight:800,padding:"5px 7px",textAlign:"center"}}>🎟 Billetero LNB</div>
                              </div>
                            </a>
                          )}
                          {u.photoLicData && (
                            <a href={u.photoLicData} target="_blank" rel="noopener" style={{textDecoration:"none",display:"block"}}>
                              <div style={{borderRadius:9,overflow:"hidden",border:"1.5px solid rgba(59,158,255,.35)",background:"var(--bg3)"}}>
                                {u.photoLicData.startsWith("data:image/") ? (
                                  <img src={u.photoLicData} alt="Licencia" style={{width:"100%",height:90,objectFit:"cover",display:"block"}}/>
                                ) : (
                                  <div style={{height:90,display:"flex",alignItems:"center",justifyContent:"center",fontSize:32}}>📄</div>
                                )}
                                <div style={{fontSize:9,color:"var(--blue)",fontWeight:800,padding:"5px 7px",textAlign:"center"}}>🚗 Licencia</div>
                              </div>
                            </a>
                          )}
                        </div>
                      </div>
                    )}

                    <div style={{display:"flex",gap:7,width:"100%"}}>
                      <button onClick={()=>updateUser(u.id,{status:"SUSPENDIDO"})}
                        style={{flex:1,padding:"8px",background:"rgba(110,133,158,.1)",border:"1px solid var(--border)",borderRadius:9,color:"var(--muted)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                        ⏸ Rechazar
                      </button>
                      <button onClick={()=>updateUser(u.id,{status:"ACTIVO"})}
                        style={{flex:2,padding:"9px",background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",borderRadius:10,color:"var(--green)",fontSize:12,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                        ✓ Aprobar
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </>
          )}

          {/* ── TAB: CONFIG ── */}
          {aTab==="config"&&(
            <>
              {!cfgSection && (
                <>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:14}}>CONFIGURACIÓN</div>
                  <div className="admin-card">
                    {[
                      {key:"sorteos",   ic:"🎟",l:"Gestión de sorteos",      d:"Administra fechas y premios"},
                      {key:"comisiones",ic:"💰",l:"Comisiones de la App",   d:"Edita % de comisión y delivery"},
                      {key:"zonas",     ic:"📍",l:"Zonas de cobertura",     d:"Define áreas de entrega activas"},
                      {key:"notif",     ic:"📢",l:"Notificaciones push",    d:"Enviar mensajes masivos"},
                      {key:"reportes",  ic:"📊",l:"Reportes y métricas",    d:"Ventas, entregas, ingresos"},
                      {key:"seguridad", ic:"🔒",l:"Seguridad",              d:"Políticas de contraseña, 2FA"},
                      {key:"terminos",  ic:"📋",l:"Términos y condiciones", d:"Editar documentos legales"},
                    ].map((item)=>(
                      <div key={item.key} className="admin-row" style={{cursor:"pointer"}} onClick={()=>setCfgSection(item.key)}>
                        <div style={{width:36,height:36,borderRadius:10,background:"var(--bg3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:18,flexShrink:0}}>{item.ic}</div>
                        <div style={{flex:1}}>
                          <div style={{fontWeight:700,fontSize:13,color:"var(--text)"}}>{item.l}</div>
                          <div style={{fontSize:10,color:"var(--muted)"}}>{item.d}</div>
                        </div>
                        <Ic n="chevR" s={14} c="var(--muted)"/>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* Botón volver al menú config */}
              {cfgSection && (
                <button onClick={()=>setCfgSection(null)} style={{background:"none",border:"none",color:"#A78BFA",cursor:"pointer",fontSize:12,marginBottom:10,display:"flex",alignItems:"center",gap:4,fontFamily:"'DM Sans',sans-serif",fontWeight:700}}>
                  ← Volver a Configuración
                </button>
              )}

              {/* ─── 1. GESTIÓN DE SORTEOS ─── */}
              {cfgSection === "sorteos" && (
                <>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>🎟 GESTIÓN DE SORTEOS</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Sorteos de la Lotería Nacional sincronizados con suerteloteria.com</div>

                  <div className="admin-card" style={{marginBottom:12}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                      <div>
                        <div style={{fontSize:11,fontWeight:800,color:"var(--text)",letterSpacing:.5}}>Auto-sincronización</div>
                        <div style={{fontSize:9,color:"var(--muted)"}}>Cron diario · {UPDATER_URL.includes("AJUSTAR")?"❌ Worker no configurado":"✅ Activo"}</div>
                      </div>
                      <button onClick={async()=>{const ok=await cargarSorteosAutomaticos();toast(ok?"✅ Sorteos sincronizados":"⚠️ No se pudo sincronizar");}} style={{background:"rgba(167,139,250,.15)",border:"1px solid rgba(167,139,250,.4)",color:"#A78BFA",padding:"7px 12px",borderRadius:8,fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>🔄 Sincronizar ahora</button>
                    </div>
                  </div>

                  <div style={{fontSize:10,fontWeight:800,color:"var(--muted)",letterSpacing:1,marginBottom:8}}>SORTEOS ACTUALES</div>
                  {SORTEOS_RECIENTES.map(s=>(
                    <div key={s.tipo} className="admin-card" style={{marginBottom:8}}>
                      <div className="row" style={{justifyContent:"space-between",alignItems:"center"}}>
                        <div>
                          <div style={{fontSize:13,fontWeight:800,color:s.color}}>{s.icon} {s.tipo} · #{s.sorteoN}</div>
                          <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>{s.fecha} · Premio mayor {s.premioMayor}</div>
                        </div>
                        {s.pendienteVerificacion ? (
                          <span style={{fontSize:9,color:"var(--gold)",background:"rgba(244,196,48,.15)",padding:"3px 7px",borderRadius:6,fontWeight:800}}>⏳ Pendiente</span>
                        ) : (
                          <span style={{fontSize:9,color:"var(--green)",background:"rgba(0,229,160,.12)",padding:"3px 7px",borderRadius:6,fontWeight:800}}>✓ Verificado</span>
                        )}
                      </div>
                    </div>
                  ))}

                  <div className="admin-card" style={{marginTop:12,background:"rgba(59,158,255,.07)",border:"1px solid rgba(59,158,255,.25)"}}>
                    <div style={{fontSize:11,fontWeight:800,color:"#3B9EFF",marginBottom:5}}>ℹ️ Sobre la sincronización</div>
                    <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.5}}>El Cloudflare Worker corre cron job diario para extraer resultados desde suerteloteria.com. Si un sorteo aparece como "Pendiente", el Worker no ha podido obtener los números aún. Toca <strong style={{color:"var(--gold)"}}>Sincronizar ahora</strong> para forzar una actualización inmediata.</div>
                  </div>
                </>
              )}

              {/* ─── 2. COMISIONES DE LA APP ─── */}
              {cfgSection === "comisiones" && (
                <>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>💰 COMISIONES</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Tarifas globales del motor de pagos</div>

                  {/* Banner: explicación de cómo se aplican los cambios */}
                  <div style={{background:"rgba(0,214,143,.06)",border:"1px solid rgba(0,214,143,.25)",borderRadius:10,padding:"9px 12px",marginBottom:12,display:"flex",gap:9,alignItems:"flex-start"}}>
                    <span style={{fontSize:14}}>⚡</span>
                    <div style={{fontSize:10,color:"var(--text)",lineHeight:1.5}}>
                      <strong style={{color:"var(--green)"}}>Cambios en vivo:</strong> Las tarifas y comisiones que edites aquí se aplican inmediatamente a TODOS los pedidos NUEVOS en la app (compradores, vendedores y repartidores). Los pedidos ya creados conservan los valores con los que se calcularon.
                    </div>
                  </div>

                  <div className="admin-card" style={{marginBottom:10}}>
                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:10,letterSpacing:.5}}>Comisiones fijas</div>
                    {[
                      {l:"Comisión App (paga el Vendedor)",sub:"% sobre el valor de la lotería",val:adminCfg.commissionPctVendor,suf:"%",key:"commissionPctVendor",step:0.1,min:0,max:20},
                      {l:"Service fee fijo",sub:"Cobrado al cliente en cada pedido",val:adminCfg.serviceFeeUSD,suf:" USD",key:"serviceFeeUSD",step:0.10,min:0,max:5,pre:"$"},
                    ].map(f=>(
                      <div key={f.key} style={{padding:"9px 0",borderBottom:"1px solid var(--border)"}}>
                        <div className="row" style={{justifyContent:"space-between",marginBottom:4}}>
                          <div>
                            <div style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>{f.l}</div>
                            <div style={{fontSize:9,color:"var(--muted)"}}>{f.sub}</div>
                          </div>
                        </div>
                        <div className="row" style={{gap:6,alignItems:"center"}}>
                          <input type="number" value={f.val} step={f.step} min={f.min} max={f.max}
                            onChange={e=>updateCfg({[f.key]:parseFloat(e.target.value)||0})}
                            style={{flex:1,background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"7px 10px",color:"var(--text)",fontSize:13,fontFamily:"'DM Sans',sans-serif"}}/>
                          <span style={{fontSize:11,color:"var(--muted)",fontWeight:700,minWidth:36,textAlign:"right"}}>{f.pre||""}{f.suf}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="admin-card" style={{marginBottom:10}}>
                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:8,letterSpacing:.5}}>Tarifas de delivery por distancia</div>
                    {adminCfg.deliveryTiers.map((t,i)=>(
                      <div key={i} className="row" style={{gap:6,marginBottom:6,alignItems:"center"}}>
                        <span style={{fontSize:10,color:"var(--muted)",minWidth:60}}>{i===0?"0":adminCfg.deliveryTiers[i-1].maxKm}–{t.maxKm} km</span>
                        <input type="number" value={t.fee} step={0.10} min={0}
                          onChange={e=>{const tiers=[...adminCfg.deliveryTiers];tiers[i]={...t,fee:parseFloat(e.target.value)||0};updateCfg({deliveryTiers:tiers});}}
                          style={{flex:1,background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",color:"var(--text)",fontSize:12,fontFamily:"'DM Sans',sans-serif"}}/>
                        <span style={{fontSize:10,color:"var(--green)",fontWeight:800}}>USD</span>
                      </div>
                    ))}
                    <div className="row" style={{gap:6,marginTop:10,paddingTop:10,borderTop:"1px solid var(--border)"}}>
                      <span style={{fontSize:10,color:"var(--muted)",flex:1}}>Extra por km después de 25 km</span>
                      <input type="number" value={adminCfg.deliveryExtraPerKm} step={0.05} min={0}
                        onChange={e=>updateCfg({deliveryExtraPerKm:parseFloat(e.target.value)||0})}
                        style={{width:80,background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",color:"var(--text)",fontSize:12,fontFamily:"'DM Sans',sans-serif"}}/>
                      <span style={{fontSize:10,color:"var(--green)",fontWeight:800}}>USD/km</span>
                    </div>
                  </div>

                  <div className="admin-card" style={{marginBottom:10,background:"rgba(255,75,110,.05)",border:"1px solid rgba(255,75,110,.25)"}}>
                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:6,letterSpacing:.5}}>⏰ Hora tope diaria de ventas</div>
                    <div style={{fontSize:10,color:"var(--muted)",marginBottom:10,lineHeight:1.4}}>
                      Pasada esta hora, los tableros de los vendedores se borran automáticamente para que puedan ingresar el inventario del próximo sorteo. Los compradores no pueden hacer pedidos después de esta hora.
                    </div>
                    <div className="row" style={{gap:8,alignItems:"center",marginBottom:10}}>
                      <span style={{fontSize:11,color:"var(--text)",flex:1,fontWeight:700}}>Cerrar ventas a las:</span>
                      <input type="time" value={adminCfg.cierreHoraTope || "15:00"}
                        onChange={e=>updateCfg({cierreHoraTope:e.target.value})}
                        style={{background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"6px 10px",color:"var(--text)",fontSize:13,fontFamily:"'DM Sans',sans-serif"}}/>
                      <span style={{fontSize:9,color:"var(--muted)"}}>(hora Panamá)</span>
                    </div>
                    <label className="row" style={{gap:8,alignItems:"center",cursor:"pointer"}}>
                      <input type="checkbox" checked={adminCfg.cierreActivo!==false}
                        onChange={e=>updateCfg({cierreActivo:e.target.checked})}
                        style={{cursor:"pointer"}}/>
                      <span style={{fontSize:11,color:"var(--text)",fontWeight:700}}>Cierre automático activado</span>
                    </label>
                  </div>

                  <button onClick={()=>toast("✅ Comisiones guardadas")} style={{width:"100%",background:"linear-gradient(135deg,#A78BFA,#8B5CF6)",border:"none",color:"#fff",padding:"12px",borderRadius:10,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",letterSpacing:.5}}>💾 Guardar cambios</button>
                </>
              )}

              {/* ─── 3. ZONAS DE COBERTURA ─── */}
              {cfgSection === "zonas" && (
                <>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>📍 ZONAS DE COBERTURA</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Activa o desactiva las zonas donde la app entrega pedidos</div>
                  {adminCfg.zonas.map((z)=>(
                    <div key={z.id} className="admin-card" style={{marginBottom:8}}>
                      <div className="row" style={{justifyContent:"space-between",alignItems:"center"}}>
                        <div>
                          <div style={{fontSize:13,fontWeight:800,color:"var(--text)"}}>{z.nombre}</div>
                          <div style={{fontSize:10,color:"var(--muted)",marginTop:2}}>Radio de cobertura: {z.radiusKm} km</div>
                        </div>
                        <label style={{position:"relative",display:"inline-block",width:46,height:24,cursor:"pointer"}}>
                          <input type="checkbox" checked={z.activa} onChange={e=>{
                            const zonas=adminCfg.zonas.map(zz=>zz.id===z.id?{...zz,activa:e.target.checked}:zz);
                            updateCfg({zonas});
                          }} style={{opacity:0,width:0,height:0}}/>
                          <span style={{position:"absolute",inset:0,background:z.activa?"var(--green)":"var(--bg3)",borderRadius:24,transition:"0.2s"}}>
                            <span style={{position:"absolute",left:z.activa?24:2,top:2,width:20,height:20,background:"#fff",borderRadius:"50%",transition:"0.2s"}}/>
                          </span>
                        </label>
                      </div>
                    </div>
                  ))}
                  <div className="admin-card" style={{marginTop:10,background:"rgba(0,229,160,.05)",border:"1px solid rgba(0,229,160,.2)"}}>
                    <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.4}}>
                      <strong style={{color:"var(--green)"}}>{adminCfg.zonas.filter(z=>z.activa).length}</strong> de {adminCfg.zonas.length} zonas activas
                    </div>
                  </div>
                </>
              )}

              {/* ─── 4. NOTIFICACIONES PUSH ─── */}
              {cfgSection === "notif" && (
                <>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>📢 NOTIFICACIONES</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Envía mensajes push masivos a los usuarios de la app</div>

                  <div className="admin-card">
                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:8}}>Audiencia</div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:6,marginBottom:14}}>
                      {[{k:"todos",l:"📣 Todos"},{k:"clientes",l:"🛒 Compradores"},{k:"vendedores",l:"🏪 Vendedores"},{k:"repartidores",l:"🛵 Repartidores"}].map(a=>(
                        <button key={a.k} onClick={()=>setPushAudience(a.k)} style={{padding:"9px",borderRadius:8,border:`1px solid ${pushAudience===a.k?"#A78BFA":"var(--border)"}`,background:pushAudience===a.k?"rgba(167,139,250,.15)":"var(--bg3)",color:pushAudience===a.k?"#A78BFA":"var(--muted)",fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>{a.l}</button>
                      ))}
                    </div>

                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:6}}>Título</div>
                    <input value={pushTitle} onChange={e=>setPushTitle(e.target.value)} placeholder="Ej: ¡Sorteo Dominical hoy!"
                      style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"9px 10px",color:"var(--text)",fontSize:12,marginBottom:10,fontFamily:"'DM Sans',sans-serif"}}/>

                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:6}}>Mensaje</div>
                    <textarea value={pushMsg} onChange={e=>setPushMsg(e.target.value)} placeholder="Escribe tu mensaje aquí…" rows={4}
                      style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"9px 10px",color:"var(--text)",fontSize:12,marginBottom:10,fontFamily:"'DM Sans',sans-serif",resize:"vertical"}}/>

                    <button disabled={!pushTitle.trim()||!pushMsg.trim()} onClick={()=>{
                      const audienceLabel={todos:"todos los usuarios",clientes:"compradores",vendedores:"vendedores",repartidores:"repartidores"}[pushAudience];
                      toast(`📢 Notificación enviada a ${audienceLabel}`);
                      setPushTitle("");setPushMsg("");
                    }} style={{width:"100%",background:pushTitle&&pushMsg?"linear-gradient(135deg,#A78BFA,#8B5CF6)":"var(--bg3)",border:"none",color:pushTitle&&pushMsg?"#fff":"var(--muted)",padding:"12px",borderRadius:10,fontSize:13,fontWeight:800,cursor:pushTitle&&pushMsg?"pointer":"not-allowed",fontFamily:"'DM Sans',sans-serif",letterSpacing:.5}}>📤 Enviar notificación</button>
                  </div>

                  <div className="admin-card" style={{marginTop:10,background:"rgba(167,139,250,.05)",border:"1px solid rgba(167,139,250,.2)"}}>
                    <div style={{fontSize:10,color:"var(--muted)",lineHeight:1.4}}>
                      <strong style={{color:"#A78BFA"}}>📌 Pendiente:</strong> integrar Firebase Cloud Messaging (FCM) para envío real. Por ahora simula el envío y muestra confirmación.
                    </div>
                  </div>
                </>
              )}

              {/* ─── 5. REPORTES Y MÉTRICAS ─── */}
              {cfgSection === "reportes" && (() => {
                const allOrders = users.flatMap(u=>u.pedidos||[]); // demo: aggregate
                const totalUsers = users.length;
                const ventasMes = stats.activos * 47;
                const entregasMes = stats.activos * 12;
                const ingresosMes = (ventasMes * 1.5).toFixed(2);
                return (
                  <>
                    <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>📊 REPORTES</div>
                    <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Métricas operativas del último mes</div>

                    <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:8,marginBottom:14}}>
                      {[
                        {l:"Ventas mes",v:`${ventasMes}`,sub:"Pedidos completados",c:"#3B9EFF"},
                        {l:"Entregas mes",v:`${entregasMes}`,sub:"Por repartidores",c:"#00D68F"},
                        {l:"Ingresos App",v:`$${ingresosMes}`,sub:"Comisión + service fees",c:"#FFCC33"},
                        {l:"Usuarios totales",v:`${totalUsers}`,sub:`${stats.activos} activos`,c:"#A78BFA"},
                      ].map(m=>(
                        <div key={m.l} className="admin-card" style={{padding:"12px"}}>
                          <div style={{fontSize:9,color:"var(--muted)",fontWeight:700,letterSpacing:.5,textTransform:"uppercase"}}>{m.l}</div>
                          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:24,color:m.c,letterSpacing:1,marginTop:3}}>{m.v}</div>
                          <div style={{fontSize:9,color:"var(--muted)",marginTop:2}}>{m.sub}</div>
                        </div>
                      ))}
                    </div>

                    <div style={{fontSize:10,fontWeight:800,color:"var(--muted)",letterSpacing:1,marginBottom:8}}>DESGLOSE POR ROL</div>
                    {[
                      {l:"Compradores",v:stats.clientes,c:"#3B9EFF",ic:"🛒"},
                      {l:"Vendedores",v:stats.vendedores,c:"#FFCC33",ic:"🏪"},
                      {l:"Repartidores",v:stats.repartidores,c:"#00D68F",ic:"🛵"},
                    ].map(r=>(
                      <div key={r.l} className="admin-card" style={{marginBottom:6}}>
                        <div className="row" style={{justifyContent:"space-between",alignItems:"center"}}>
                          <div className="row" style={{gap:10,alignItems:"center"}}>
                            <div style={{width:34,height:34,borderRadius:9,background:`${r.c}25`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>{r.ic}</div>
                            <div style={{fontSize:12,fontWeight:700,color:"var(--text)"}}>{r.l}</div>
                          </div>
                          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:r.c}}>{r.v}</div>
                        </div>
                      </div>
                    ))}

                    <button onClick={()=>toast("📥 Reporte CSV exportado (demo)")} style={{width:"100%",marginTop:14,background:"rgba(167,139,250,.15)",border:"1px solid rgba(167,139,250,.4)",color:"#A78BFA",padding:"12px",borderRadius:10,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>📥 Exportar CSV</button>
                  </>
                );
              })()}

              {/* ─── 6. SEGURIDAD ─── */}
              {cfgSection === "seguridad" && (
                <>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>🔒 SEGURIDAD</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Políticas globales de autenticación y contraseñas</div>

                  <div className="admin-card" style={{marginBottom:10}}>
                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:10,letterSpacing:.5}}>Autenticación</div>
                    {[
                      {l:"Requerir 2FA para admin",sub:"Verificación en dos pasos para cuentas admin",val:adminCfg.requireMFA,key:"requireMFA"},
                      {l:"Caracter especial obligatorio",sub:"Las contraseñas deben incluir un símbolo (!@#$%)",val:adminCfg.requireSpecialChar,key:"requireSpecialChar"},
                    ].map(t=>(
                      <div key={t.key} className="row" style={{justifyContent:"space-between",alignItems:"center",padding:"9px 0",borderBottom:"1px solid var(--border)"}}>
                        <div style={{flex:1,marginRight:10}}>
                          <div style={{fontSize:11,fontWeight:700,color:"var(--text)"}}>{t.l}</div>
                          <div style={{fontSize:9,color:"var(--muted)",marginTop:1}}>{t.sub}</div>
                        </div>
                        <label style={{position:"relative",display:"inline-block",width:46,height:24,cursor:"pointer",flexShrink:0}}>
                          <input type="checkbox" checked={t.val} onChange={e=>updateCfg({[t.key]:e.target.checked})} style={{opacity:0,width:0,height:0}}/>
                          <span style={{position:"absolute",inset:0,background:t.val?"var(--green)":"var(--bg3)",borderRadius:24,transition:"0.2s"}}>
                            <span style={{position:"absolute",left:t.val?24:2,top:2,width:20,height:20,background:"#fff",borderRadius:"50%",transition:"0.2s"}}/>
                          </span>
                        </label>
                      </div>
                    ))}
                    {[
                      {l:"Longitud mínima de contraseña",val:adminCfg.minPwdLen,key:"minPwdLen",suf:"caracteres",min:6,max:32},
                      {l:"Tiempo de sesión",val:adminCfg.sessionTimeoutMin,key:"sessionTimeoutMin",suf:"minutos",min:5,max:1440},
                      {l:"Bloquear tras intentos fallidos",val:adminCfg.blockAfterFails,key:"blockAfterFails",suf:"intentos",min:3,max:20},
                    ].map(f=>(
                      <div key={f.key} style={{padding:"9px 0",borderBottom:"1px solid var(--border)"}}>
                        <div style={{fontSize:11,fontWeight:700,color:"var(--text)",marginBottom:5}}>{f.l}</div>
                        <div className="row" style={{gap:6,alignItems:"center"}}>
                          <input type="number" value={f.val} min={f.min} max={f.max}
                            onChange={e=>updateCfg({[f.key]:parseInt(e.target.value)||f.min})}
                            style={{flex:1,background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"7px 10px",color:"var(--text)",fontSize:13,fontFamily:"'DM Sans',sans-serif"}}/>
                          <span style={{fontSize:10,color:"var(--muted)",fontWeight:700}}>{f.suf}</span>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button onClick={()=>toast("✅ Políticas de seguridad guardadas")} style={{width:"100%",background:"linear-gradient(135deg,#A78BFA,#8B5CF6)",border:"none",color:"#fff",padding:"12px",borderRadius:10,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>💾 Guardar políticas</button>
                </>
              )}

              {/* ─── 7. TÉRMINOS Y CONDICIONES ─── */}
              {cfgSection === "terminos" && (
                <>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"var(--text)",letterSpacing:2,marginBottom:6}}>📋 TÉRMINOS Y CONDICIONES</div>
                  <div style={{fontSize:11,color:"var(--muted)",marginBottom:14}}>Edita los documentos legales que ven los usuarios al registrarse</div>

                  <div className="admin-card">
                    <div style={{fontSize:11,fontWeight:800,color:"var(--text)",marginBottom:8}}>Texto del documento</div>
                    <textarea value={terminosTxt} onChange={e=>setTerminosTxt(e.target.value)} rows={14}
                      style={{width:"100%",background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:7,padding:"10px",color:"var(--text)",fontSize:11,lineHeight:1.5,fontFamily:"'DM Sans',sans-serif",resize:"vertical"}}/>

                    <div className="row" style={{justifyContent:"space-between",alignItems:"center",marginTop:10,fontSize:10,color:"var(--muted)"}}>
                      <span>{terminosTxt.length} caracteres · {terminosTxt.split("\n").length} líneas</span>
                      <span>Última edición: hoy</span>
                    </div>
                  </div>

                  <button onClick={()=>toast("✅ Términos publicados")} style={{width:"100%",marginTop:12,background:"linear-gradient(135deg,#A78BFA,#8B5CF6)",border:"none",color:"#fff",padding:"12px",borderRadius:10,fontSize:13,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>📢 Publicar nueva versión</button>
                </>
              )}
            </>
          )}
        </div>

        {/* Modal detalle usuario */}
        {selectedUser&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.7)",zIndex:999,display:"flex",alignItems:"flex-end",justifyContent:"center"}} onClick={()=>setSelectedUser(null)}>
            <div style={{background:"var(--bg2)",borderRadius:"20px 20px 0 0",padding:"20px",width:"100%",maxWidth:480,maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div>
                  <div style={{fontWeight:800,fontSize:15,color:"var(--text)"}}>{selectedUser.nombre}</div>
                  <div style={{display:"flex",gap:5,marginTop:3}}>
                    <span className={`role-pill ${rolClass[selectedUser.rol]||""}`}>{rolLabel[selectedUser.rol]||selectedUser.rol}</span>
                    <span className={`role-pill ${stClass[selectedUser.status]||""}`}>{stLabel[selectedUser.status]||selectedUser.status}</span>
                  </div>
                </div>
                <button onClick={()=>setSelectedUser(null)} style={{background:"var(--bg3)",border:"1px solid var(--border)",borderRadius:9,width:32,height:32,display:"flex",alignItems:"center",justifyContent:"center",cursor:"pointer"}}>
                  <Ic n="close" s={13} c="var(--muted)"/>
                </button>
              </div>
              <div style={{background:"var(--bg3)",borderRadius:12,padding:"12px",marginBottom:14}}>
                {[
                  ["📧 Email",selectedUser.email],
                  ["🪪 Cédula",selectedUser.cedula],
                  ["📱 Teléfono",selectedUser.telefono],
                  ["📍 Provincia",selectedUser.provincia||"—"],
                  selectedUser.rol==="vendedor"?["🎟 Billetero",selectedUser.numeroBilletero]:null,
                  selectedUser.rol==="vendedor"?["🎲 Sorteos",(selectedUser.sorteos||[]).join(", ")||"—"]:null,
                  selectedUser.rol==="repartidor"?["🛵 Vehículo",selectedUser.vehiculo||"—"]:null,
                  ["🏦 Banco",selectedUser.banco||"—"],
                  ["📅 Registro",selectedUser.createdAt],
                ].filter(Boolean).map(([l,v])=>(
                  <div key={l} style={{display:"flex",gap:10,marginBottom:7}}>
                    <span style={{fontSize:11,color:"var(--muted)",minWidth:90,flexShrink:0,fontWeight:700}}>{l}</span>
                    <span style={{fontSize:11,color:"var(--text)",flex:1}}>{v||"—"}</span>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
                {selectedUser.status!=="ACTIVO"&&
                  <button onClick={()=>updateUser(selectedUser.id,{status:"ACTIVO"})}
                    style={{flex:1,padding:"9px",background:"rgba(0,214,143,.12)",border:"1px solid rgba(0,214,143,.3)",borderRadius:9,color:"var(--green)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                    ✓ Activar
                  </button>}
                {selectedUser.status!=="SUSPENDIDO"&&
                  <button onClick={()=>updateUser(selectedUser.id,{status:"SUSPENDIDO"})}
                    style={{flex:1,padding:"9px",background:"rgba(255,75,110,.1)",border:"1px solid rgba(255,75,110,.28)",borderRadius:9,color:"var(--red)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                    ⏸ Suspender
                  </button>}
                <button onClick={()=>deleteUser(selectedUser.id)}
                  style={{flex:1,padding:"9px",background:"rgba(110,133,158,.1)",border:"1px solid var(--border)",borderRadius:9,color:"var(--muted)",fontSize:11,fontWeight:800,cursor:"pointer",fontFamily:"'DM Sans',sans-serif"}}>
                  🗑 Eliminar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   APP RAÍZ CON AUTH GATE — envuelve el App original
───────────────────────────────────────────────────────────────────────── */
export default function ChanceRoot() {
  const [authScreen, setAuthScreen] = useState("login");
  const [authUser,   setAuthUser]   = useState(null);
  const [booting,    setBooting]    = useState(true);
  const [registerSuccess, setRegisterSuccess] = useState(null); // {nombre, email} after registration

  // ── ESTADO COMPARTIDO GLOBAL (persistido entre sesiones y roles) ──
  // Vive en ChanceRoot (top-level) para que TODOS los roles vean los mismos pedidos
  const [sharedBilletes, setSharedBilletes] = useState(VENDORS[0].billetes);
  const [sharedChances,  setSharedChances]  = useState(VENDORS[0].chances);
  const [sharedOrders,   setSharedOrders]   = useState([]);
  // Lista global de usuarios — necesaria para que el comprador vea TODOS los
  // vendedores activos (no solo Carlos y Rosa estáticos). Se hidrata desde
  // window.storage y se sincroniza con Firebase.
  const [allUsers,       setAllUsers]       = useState([]);
  // Sorteo activo del vendedor — compartido vía Firebase para que el comprador
  // vea siempre el mismo sorteo que tiene activo el vendedor en su tablero.
  const sorteoInicialRoot = getSorteoActivo("MIERCOLITO") || (SORTEOS_RECIENTES && SORTEOS_RECIENTES[0]) || SORTEOS_RECIENTES_SEED[0];
  const [vendorActiveSorteo, setVendorActiveSorteo] = useState(sorteoInicialRoot);
  const [stateLoaded,    setStateLoaded]    = useState(false);
  // Refs para evitar bucles infinitos al sincronizar con Firebase
  const ordersHashRef    = useRef("");
  const billetesHashRef  = useRef("");
  const chancesHashRef   = useRef("");
  const sorteoVendorRef  = useRef("");
  const usersHashRef     = useRef("");
  const skipNextSyncRef  = useRef({ orders: false, billetes: false, chances: false, sorteoVendor: false, users: false });

  // ── DERIVAR LISTA DE VENDEDORES ACTIVOS (estáticos + reales) ─────────────
  // Combina los demos hardcoded (VENDORS) con los vendedores reales
  // aprobados por el admin. Un vendedor aparece aquí solo si:
  //   - rol === "vendedor"
  //   - status === "ACTIVO"
  //   - Tiene numeroBilletero (código V001, V002...)
  // El vendedor demo "Carlos Medina" ya viene en VENDORS — no lo duplicamos.
  const activeVendors = (() => {
    const realVendors = (allUsers || [])
      .filter(u => u?.rol === "vendedor" && u?.status === "ACTIVO" && u?.numeroBilletero)
      .map(u => {
        // Traducir el formato users_db al formato VENDORS para que las
        // pantallas existentes funcionen sin tocarse.
        const codigo = u.numeroBilletero;
        const nombreCompleto = u.nombre || "Vendedor";
        // Filtrar inventario global del vendedor por su userId (los items
        // están etiquetados con vendorOwnerId al añadirlos en su tablero).
        const myBilletes = (sharedBilletes || []).filter(b => b.vendorOwnerId === u.id);
        const myChances  = (sharedChances  || []).filter(c => c.vendorOwnerId === u.id);
        return {
          id: codigo,                          // ej "V003" — único y estable
          name: nombreCompleto,
          rating: 5.0, reviews: 0,
          zone: u.lugarVende || u.corregimiento || "Panamá",
          distance: "—", time: "20–35 min",
          verified: true,
          sorteo: vendorActiveSorteo?.fecha || "",
          billetes: myBilletes,
          chances:  myChances,
          // Identidad para el motor de pedidos
          userId: u.id, telefono: u.telefono,
        };
      });
    // Demos VENDORS al frente, después los reales (filtrando duplicados por id)
    const realIds = new Set(realVendors.map(v => v.id));
    const demos = VENDORS.filter(v => {
      // El demo Carlos (V001) coincide con el demo_v de users_db. Si ambos
      // existen, preferimos el real (que tiene userId real para Firebase).
      if (v.id === 1 && realVendors.some(r => r.id === "V001")) return false;
      return true;
    });
    return [...demos, ...realVendors];
  })();

  // ════════════════════════════════════════════════════════════════════
  // SINCRONIZACIÓN CON FIREBASE (en lugar de window.storage local)
  // Todos los celulares reciben los cambios en tiempo real (polling 3s)
  // ════════════════════════════════════════════════════════════════════
  useEffect(() => {
    // Cargar sorteos automáticos al iniciar
    cargarSorteosAutomaticos();

    // 1. Cargar datos iniciales desde Firebase
    (async () => {
      try {
        const [pedidos, billetes, chances] = await Promise.all([
          fbRead("pedidos"),
          fbRead("billetes"),
          fbRead("chances"),
        ]);
        if (Array.isArray(pedidos)) {
          // ─── AUTO-CORRECCIÓN: pedidos con estado inconsistente ───
          // Si un pedido está EN_CAMINO/ENTREGADO pero NO tiene approvedAt,
          // significa que pasó por aprobación antes de las validaciones nuevas.
          // Lo regresamos a PENDIENTE para forzar el flujo correcto.
          const pedidosCorregidos = pedidos.map(p => {
            if ((p.status === "EN_CAMINO" || p.status === "ENTREGADO") && !p.approvedAt && !p.vendorApprovedAt) {
              return {
                ...p,
                status: "PENDIENTE",
                assignedAt: undefined,
                deliveredAt: undefined,
                history: [...(p.history||[]), { by: "sistema", action: "Auto-corregido: estado inválido sin aprobación", at: ts() }]
              };
            }
            return p;
          });
          setSharedOrders(pedidosCorregidos);
          ordersHashRef.current = JSON.stringify(pedidosCorregidos);
          // Si hubo correcciones, subir cambios a Firebase
          if (JSON.stringify(pedidosCorregidos) !== JSON.stringify(pedidos)) {
            console.log("⚠️ Pedidos auto-corregidos por estados inválidos");
            fbWrite("pedidos", pedidosCorregidos);
          }
        }
        if (Array.isArray(billetes)) {
          setSharedBilletes(billetes);
          billetesHashRef.current = JSON.stringify(billetes);
        }
        if (Array.isArray(chances)) {
          setSharedChances(chances);
          chancesHashRef.current = JSON.stringify(chances);
        }
        // Sorteo activo del vendedor — leemos en un segundo paso (no bloquea init)
        try {
          const sorteoVendor = await fbRead("vendedor_v001/sorteoActivo");
          if (sorteoVendor && typeof sorteoVendor === "object" && sorteoVendor.tipo) {
            const matched = SORTEOS_RECIENTES.find(s => s.tipo === sorteoVendor.tipo);
            if (matched) {
              skipNextSyncRef.current.sorteoVendor = true;
              setVendorActiveSorteo(matched);
              sorteoVendorRef.current = JSON.stringify({ tipo: matched.tipo });
            }
          }
        } catch(e2) { /* silent */ }

        // ── Cargar config global del admin desde Firebase ──────────────
        // Cualquier usuario (cliente/vendedor/repartidor) lee la config
        // para que sus cálculos usen las tarifas/comisiones actuales.
        try {
          const cfgFB = await fbRead("admin_cfg");
          if (cfgFB && typeof cfgFB === "object") {
            applyAdminCfg(cfgFB);
          } else {
            // Si no hay en Firebase, intentar leer del storage local
            const cfgLocal = await window.storage.get("admin_cfg");
            if (cfgLocal?.value) applyAdminCfg(JSON.parse(cfgLocal.value));
          }
        } catch(e3) { /* sin config remota, usa defaults hardcodeados */ }
      } catch(e) { console.warn("Error cargando datos:", e.message); }
      setStateLoaded(true);
    })();

    // 2. Listener en tiempo real para PEDIDOS (poll cada 3s)
    const stopPedidos = fbListen("pedidos", (data) => {
      const newHash = JSON.stringify(data || []);
      if (newHash !== ordersHashRef.current) {
        ordersHashRef.current = newHash;
        skipNextSyncRef.current.orders = true; // evita loop al recibir
        setSharedOrders(Array.isArray(data) ? data : []);
      }
    }, 3000);

    // 3. Listener para BILLETES (inventario)
    const stopBilletes = fbListen("billetes", (data) => {
      const newHash = JSON.stringify(data || []);
      if (newHash !== billetesHashRef.current) {
        billetesHashRef.current = newHash;
        skipNextSyncRef.current.billetes = true;
        if (Array.isArray(data)) setSharedBilletes(data);
      }
    }, 3000);

    // 4. Listener para CHANCES (inventario)
    const stopChances = fbListen("chances", (data) => {
      const newHash = JSON.stringify(data || []);
      if (newHash !== chancesHashRef.current) {
        chancesHashRef.current = newHash;
        skipNextSyncRef.current.chances = true;
        if (Array.isArray(data)) setSharedChances(data);
      }
    }, 3000);

    // 5. Listener para SORTEO ACTIVO DEL VENDEDOR
    // El comprador necesita saber qué sorteo está activo en el tablero del
    // vendedor para mostrar los billetes correctos. Polling 3s.
    const stopSorteoVendor = fbListen("vendedor_v001/sorteoActivo", (data) => {
      try {
        if (!data || typeof data !== "object" || !data.tipo) return;
        const newHash = JSON.stringify({ tipo: data.tipo });
        if (newHash !== sorteoVendorRef.current) {
          sorteoVendorRef.current = newHash;
          const matched = SORTEOS_RECIENTES.find(s => s.tipo === data.tipo);
          if (matched) {
            skipNextSyncRef.current.sorteoVendor = true;
            setVendorActiveSorteo(matched);
          }
        }
      } catch(e) { console.warn("Listener sorteoVendor:", e.message); }
    }, 3000);

    // 6. Listener para CONFIG GLOBAL del admin (comisiones, delivery, etc).
    // Cuando el admin cambia algo, los cálculos en TODOS los dispositivos
    // se actualizan inmediatamente sin necesidad de refresh.
    const stopAdminCfg = fbListen("admin_cfg", (data) => {
      try {
        if (data && typeof data === "object") applyAdminCfg(data);
      } catch(e) { console.warn("Listener admin_cfg:", e.message); }
    }, 5000);

    // 7. Listener para USUARIOS (so el comprador ve nuevos vendedores activos).
    // Cuando el admin aprueba/suspende un vendedor, los cambios llegan a
    // todos los dispositivos en ~5s y la lista de vendedores se actualiza.
    const stopUsers = fbListen("users", (data) => {
      try {
        if (Array.isArray(data)) {
          const newHash = JSON.stringify(data);
          if (newHash !== usersHashRef.current) {
            usersHashRef.current = newHash;
            setAllUsers(data);
            // También actualizamos el storage local para uso offline
            try { window.storage.set("users_db", JSON.stringify(data)); } catch(e) {}
          }
        }
      } catch(e) { console.warn("Listener users:", e.message); }
    }, 5000);

    // Cargar usuarios iniciales desde storage local mientras Firebase responde
    (async () => {
      try {
        const r = await window.storage.get("users_db");
        if (r?.value) {
          const local = JSON.parse(r.value);
          if (Array.isArray(local) && local.length > 0) setAllUsers(local);
        }
      } catch(e) {}
    })();

    return () => { stopPedidos(); stopBilletes(); stopChances(); stopSorteoVendor(); stopAdminCfg(); stopUsers(); };
  }, []);

  // Subir pedidos a Firebase cada vez que cambien (excepto cuando vinieron de Firebase)
  useEffect(() => {
    if (!stateLoaded) return;
    if (skipNextSyncRef.current.orders) {
      skipNextSyncRef.current.orders = false;
      return;
    }
    const newHash = JSON.stringify(sharedOrders);
    if (newHash === ordersHashRef.current) return;
    ordersHashRef.current = newHash;
    fbWrite("pedidos", sharedOrders);
  }, [sharedOrders, stateLoaded]);

  // Subir billetes a Firebase
  useEffect(() => {
    if (!stateLoaded) return;
    if (skipNextSyncRef.current.billetes) {
      skipNextSyncRef.current.billetes = false;
      return;
    }
    const newHash = JSON.stringify(sharedBilletes);
    if (newHash === billetesHashRef.current) return;
    billetesHashRef.current = newHash;
    fbWrite("billetes", sharedBilletes);
  }, [sharedBilletes, stateLoaded]);

  // Subir chances a Firebase
  useEffect(() => {
    if (!stateLoaded) return;
    if (skipNextSyncRef.current.chances) {
      skipNextSyncRef.current.chances = false;
      return;
    }
    const newHash = JSON.stringify(sharedChances);
    if (newHash === chancesHashRef.current) return;
    chancesHashRef.current = newHash;
    fbWrite("chances", sharedChances);
  }, [sharedChances, stateLoaded]);

  // Subir SORTEO ACTIVO del vendedor a Firebase
  // Cuando el vendedor cambia su sorteo en el tablero, se publica para que
  // los compradores vean los billetes correctos del sorteo seleccionado.
  useEffect(() => {
    if (!stateLoaded) return;
    if (!vendorActiveSorteo || !vendorActiveSorteo.tipo) return;
    if (skipNextSyncRef.current.sorteoVendor) {
      skipNextSyncRef.current.sorteoVendor = false;
      return;
    }
    const payload = { tipo: vendorActiveSorteo.tipo, sorteoN: vendorActiveSorteo.sorteoN || "", fecha: vendorActiveSorteo.fecha || "" };
    const newHash = JSON.stringify({ tipo: payload.tipo });
    if (newHash === sorteoVendorRef.current) return;
    sorteoVendorRef.current = newHash;
    fbWrite("vendedor_v001/sorteoActivo", payload);
  }, [vendorActiveSorteo, stateLoaded]);

  // Seed demo users and restore session on mount
  useEffect(() => {
    // SAFETY: si por alguna razón el bootstrap se cuelga (Firebase lento,
    // storage corrupto, etc.), forzamos setBooting(false) tras 6 segundos
    // para que el usuario al menos vea la pantalla de login.
    const safety = setTimeout(() => setBooting(false), 6000);
    (async () => {
      try {
        const r = await window.storage.get("users_db");
        const existing = r?.value ? JSON.parse(r.value) : [];
        const demos = [
          {id:"admin1",  email:"admin@chance.pa",  password:"Admin2024!", nombre:"Admin CHANCE",   rol:"admin",      cedula:"8-999-0001",telefono:"6000-0001",status:"ACTIVO", createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"San Francisco",sorteos:[],zonas:[],horarios:[],banco:"Banco General",cuentaBanco:"",tipoCuenta:"",metodoCobro:""},
          {id:"demo_c",  email:"maria@demo.pa",    password:"Compra123",  nombre:"María González", rol:"cliente",    cedula:"8-123-4567",telefono:"6234-5678",status:"ACTIVO", createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"San Francisco",sorteos:[],zonas:[],horarios:[],banco:"Yappy (BG)",cuentaBanco:"",tipoCuenta:"",metodoCobro:"💵 Efectivo en mano"},
          {id:"demo_v",  email:"carlos@demo.pa",   password:"Vende123",   nombre:"Carlos Medina",  rol:"vendedor",   cedula:"8-222-3333",telefono:"6111-2222",status:"ACTIVO", createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"San Francisco",numeroBilletero:"V001",sorteos:["⚡ Miercolito (Miércoles)","🌟 Dominical (Domingo)"],zonas:[],horarios:[],banco:"Banco General",cuentaBanco:"04-12-345678-0",tipoCuenta:"Cuenta Corriente",metodoCobro:"📱 Yappy (Banco General)",lugarVende:"Calle 50, San Francisco",hasPhoto:true,hasBill:true},
          {id:"demo_r",  email:"juan@demo.pa",     password:"Reparte123", nombre:"Juan Rodríguez", rol:"repartidor", cedula:"8-444-5555",telefono:"6333-4444",status:"ACTIVO", createdAt:"01/01/2026",provincia:"Panamá",distrito:"Panamá",corregimiento:"El Cangrejo",vehiculo:"🏍 Motocicleta",zonas:["Panamá Centro","San Francisco","El Cangrejo"],horarios:["Tarde (12pm–6pm)"],banco:"Nequi",cuentaBanco:"6333-4444",tipoCuenta:"Cuenta de Ahorros",metodoCobro:"",sorteos:[],hasPhoto:true,hasLic:true},
        ];
        // Hidratar desde Firebase (cross-device): si hay usuarios en Firebase
        // que no están localmente, los traemos. Si hay locales más recientes,
        // los conservamos. Estrategia simple: union por email, prioridad al
        // que tenga timestamp 'updatedAt' más reciente.
        let fbUsers = [];
        try {
          const fb = await fbRead("users");
          if (Array.isArray(fb)) fbUsers = fb;
        } catch(e) { /* sin Firebase, OK */ }
        // Merge: demos primero, después usuarios locales/Firebase (sin duplicar emails)
        const allUsersLocal = [...existing, ...fbUsers.filter(f => !existing.find(e => e.email === f.email))];
        const merged = [...demos.filter(d=>!allUsersLocal.find(e=>e.email===d.email)), ...allUsersLocal];
        await window.storage.set("users_db", JSON.stringify(merged));
        // Subir merge a Firebase, pero SIN fotos (las fotos pueden ser ~300KB
        // c/u en base64 y harían el payload demasiado grande para Firebase).
        // Las fotos solo viven en window.storage local de cada dispositivo.
        try {
          await fbWrite("users", stripUserPhotos(merged));
        } catch(e) {}
        const sr = await window.storage.get("active_session");
        if (sr?.value) {
          const sess = JSON.parse(sr.value);
          const u = merged.find(x=>x.id===sess.userId);
          if (u && u.status!=="SUSPENDIDO") setAuthUser(u);
        }
      } catch(e) { console.warn("Bootstrap error:", e); }
      clearTimeout(safety);
      setBooting(false);
    })();
  }, []);

  const handleLogin = async (user) => {
    setAuthUser(user);
    setRegisterSuccess(null);
    try { await window.storage.set("active_session", JSON.stringify({userId:user.id})); } catch(e) {}
  };

  const handleLogout = async () => {
    setAuthUser(null);
    try { await window.storage.delete("active_session"); } catch(e) {}
    setAuthScreen("login");
  };

  const handleRegister = async (user) => {
    // For pending users (vendedor/repartidor) — show pending approval screen
    if (user.status === "PENDIENTE") {
      setAuthUser(user);
      return;
    }
    // For active users (cliente) — show success then redirect to login
    // Don't try to auto-launch App (causes white screen due to async state init)
    setRegisterSuccess(user);
    setAuthScreen("login");
  };

  // ── RENDER ──────────────────────────────────────────────────────────────
  // Always inject both stylesheets at root — prevents FOUC and double-render issues
  const allCSS = (
    <>
      <style>{CSS}</style>
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0}to{opacity:1}}
        .chance-root{animation:fadeIn .3s ease}
      `}</style>
    </>
  );

  // Booting splash
  if (booting) return (
    <div className="chance-root" style={{background:"#08101E",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",flexDirection:"column",gap:20}}>
      {allCSS}
      <ChanceLogo height={64}/>
      <div style={{width:38,height:38,border:"3px solid rgba(255,204,51,.2)",borderTopColor:"#FFCC33",borderRadius:"50%",animation:"spin .8s linear infinite"}}/>
      <div style={{fontSize:12,color:"#B8CEDE",letterSpacing:2,textTransform:"uppercase",fontFamily:"'DM Sans',sans-serif"}}>Cargando…</div>
    </div>
  );

  // Not authenticated → Auth screens
  if (!authUser) {
    if (authScreen==="login")    return <>{allCSS}<LoginScreen onLogin={handleLogin} onGoRegister={()=>{setRegisterSuccess(null);setAuthScreen("register");}} registerSuccess={registerSuccess}/></>;
    if (authScreen==="register") return <>{allCSS}<RegisterScreen onRegister={handleRegister} onGoLogin={()=>setAuthScreen("login")}/></>;
  }

  // Admin → Exclusive admin panel
  if (authUser.rol==="admin") return <>{allCSS}<AdminPanel adminUser={authUser} onLogout={handleLogout}/></>;

  // Pending approval
  if (authUser.status==="PENDIENTE") return <>{allCSS}<PendingApprovalScreen user={authUser} onLogout={handleLogout}/></>;

  // Active user → Main app with correct role
  const roleMap = { cliente:"cliente", vendedor:"vendedor", repartidor:"repartidor" };
  return <>{allCSS}<App
    forceRole={roleMap[authUser.rol]||"cliente"}
    authUser={authUser}
    onLogout={handleLogout}
    sharedBilletes={sharedBilletes} setSharedBilletes={setSharedBilletes}
    sharedChances={sharedChances}   setSharedChances={setSharedChances}
    sharedOrders={sharedOrders}     setSharedOrders={setSharedOrders}
    vendorActiveSorteo={vendorActiveSorteo} setVendorActiveSorteo={setVendorActiveSorteo}
    activeVendors={activeVendors}
  /></>;
}
