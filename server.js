require("dotenv").config();
process.env.TZ = "America/Santiago";
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const { Resend } = require("resend");

// Verificar API key al inicio
if (!process.env.RESEND_API_KEY) {
  console.error("❌ ERROR: RESEND_API_KEY no está configurada en .env");
  process.exit(1);
}

const resend = new Resend(process.env.RESEND_API_KEY);
const app = express();

app.use(cors());
app.use(express.json());

// Servir archivos estáticos
app.use(express.static(__dirname));
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/health",(req,res)=>res.json({status:"OK"}));

// TARIFAS
const TARIFAS_FILE = path.join(__dirname, "tarifas.json");
function leerTarifas() {
  try {
    if (fs.existsSync(TARIFAS_FILE)) {
      return JSON.parse(fs.readFileSync(TARIFAS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("Error leyendo tarifas.json:", err.message);
  }
  return { 
    tarifa_base: 6000, 
    km_adicional_6_10: 1000, 
    km_adicional_10_mas: 850, 
    cupones: {
      "BIENVENIDA10": 10,
      "DESCUENTO20": 20
    } 
  };
}

let { tarifa_base, km_adicional_6_10, km_adicional_10_mas, cupones } = leerTarifas();
let porcentajeAjuste = 0;

// 🔥 NUEVOS ENDPOINTS PARA EL PANEL DE ADMINISTRACIÓN 🔥
// Obtener configuración actual (GET)
app.get("/config", (req, res) => {
  res.json({
    porcentajeAjuste,
    cupones
  });
});

// Actualizar configuración desde el panel (POST)
app.post("/config", (req, res) => {
  try {
    const { nuevoPorcentaje, nuevosCupones } = req.body;
    
    if (nuevoPorcentaje !== undefined) {
      porcentajeAjuste = nuevoPorcentaje;
      console.log(`📊 Porcentaje de ajuste actualizado a: ${porcentajeAjuste}%`);
    }
    
    if (nuevosCupones) {
      cupones = nuevosCupones;
      console.log("🎟️ Cupones actualizados:", cupones);
    }
    
    res.json({ ok: true, message: "Configuración actualizada correctamente" });
  } catch (error) {
    console.error("❌ Error actualizando configuración:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 🔴 NUEVA FUNCIÓN: GEOCODING MEJORADO CON CONTEXTO DE COMUNA
async function geocodificarDireccion(direccion, comunaSugerida = null) {
  try {
    // Si tenemos una comuna sugerida, intentar primero con esa
    if (comunaSugerida) {
      const direccionCompleta = `${direccion}, ${comunaSugerida}, Chile`;
      console.log(`   Intentando geocoding con comuna: "${direccionCompleta}"`);
      
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(direccionCompleta)}&region=cl&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
      const resp = await fetch(url);
      const data = await resp.json();
      
      if (data.status === "OK" && data.results.length > 0) {
        // Verificar que realmente esté en la comuna esperada
        const result = data.results[0];
        const addressComponents = result.address_components;
        let estaEnComunaCorrecta = false;
        
        // Buscar si la comuna aparece en los componentes
        for (const component of addressComponents) {
          if (component.types.includes("administrative_area_level_3") || 
              component.types.includes("locality")) {
            if (component.long_name.toLowerCase().includes(comunaSugerida.toLowerCase())) {
              estaEnComunaCorrecta = true;
              break;
            }
          }
        }
        
        if (estaEnComunaCorrecta) {
          console.log(`   ✅ Geocoding exitoso en ${comunaSugerida}`);
          return {
            lat: result.geometry.location.lat,
            lng: result.geometry.location.lng,
            direccionFormateada: result.formatted_address
          };
        } else {
          console.log(`   ⚠️ La dirección no está en ${comunaSugerida}, intentando sin filtro...`);
        }
      }
    }
    
    // Fallback: geocoding normal sin filtro de comuna
    console.log(`   Intentando geocoding normal: "${direccion}, Chile"`);
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(direccion + ", Chile")}&region=cl&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status === "OK" && data.results.length > 0) {
      const result = data.results[0];
      console.log(`   ✅ Geocoding exitoso: ${result.formatted_address}`);
      return {
        lat: result.geometry.location.lat,
        lng: result.geometry.location.lng,
        direccionFormateada: result.formatted_address
      };
    }
    
    console.error(`   ❌ No se pudo geocodificar: ${direccion}`);
    return null;
    
  } catch (err) {
    console.error(`   ❌ Error en geocoding:`, err.message);
    return null;
  }
}

// 🚀 FUNCIÓN CORREGIDA: CALCULAR DISTANCIA Y TIEMPO USANDO ROUTES API CON GEOCODING PREVIO
async function calcularDistanciaYTiempo(origen, destino, comunaDestino = null) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY) {
    console.error("❌ ERROR: GOOGLE_MAPS_BACKEND_KEY no está configurada");
    return { km: 8.5, minutos: 30 };
  }
  
  // URL de Routes API (v2)
  const url = "https://routes.googleapis.com/directions/v2:computeRoutes";
  
  try {
    console.log(`🔍 Calculando ruta de: "${origen}" a "${destino}"`);
    
    // PASO 1: Geocodificar origen (siempre sin filtro)
    console.log(`📍 Geocodificando origen...`);
    const origenCoords = await geocodificarDireccion(origen);
    if (!origenCoords) {
      console.error(`❌ No se pudo geocodificar el origen`);
      return { km: 8.5, minutos: 30 };
    }
    
    // PASO 2: Geocodificar destino, extrayendo la comuna si es posible
    console.log(`📍 Geocodificando destino...`);
    
    // Extraer posible comuna del destino (ej: "Manuel Rodríguez 73, Colina, Chile")
    let comunaDetectada = comunaDestino;
    if (!comunaDetectada && destino.includes(',')) {
      const partes = destino.split(',').map(p => p.trim());
      if (partes.length >= 2) {
        // La penúltima parte suele ser la comuna en direcciones chilenas
        comunaDetectada = partes[partes.length - 2];
      }
    }
    
    const destinoCoords = await geocodificarDireccion(destino, comunaDetectada);
    if (!destinoCoords) {
      console.error(`❌ No se pudo geocodificar el destino`);
      return { km: 8.5, minutos: 30 };
    }
    
    console.log(`   📍 Origen coordenadas: ${origenCoords.lat}, ${origenCoords.lng}`);
    console.log(`   📍 Destino coordenadas: ${destinoCoords.lat}, ${destinoCoords.lng}`);
    console.log(`   📍 Origen formateado: ${origenCoords.direccionFormateada}`);
    console.log(`   📍 Destino formateado: ${destinoCoords.direccionFormateada}`);
    
    // PASO 3: Calcular ruta usando coordenadas (más preciso que direcciones)
    const requestBody = {
      origin: {
        location: {
          latLng: {
            latitude: origenCoords.lat,
            longitude: origenCoords.lng
          }
        }
      },
      destination: {
        location: {
          latLng: {
            latitude: destinoCoords.lat,
            longitude: destinoCoords.lng
          }
        }
      },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE", // Para obtener la ruta más corta
      computeAlternativeRoutes: true,
      routeModifiers: {
        avoidTolls: false,
        avoidHighways: false,
        avoidFerries: false
      },
      languageCode: "es-ES",
      units: "METRIC"
    };
    
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_BACKEND_KEY,
        "X-Goog-FieldMask": "routes.duration,routes.distanceMeters,routes.routeLabels"
      },
      body: JSON.stringify(requestBody)
    });
    
    const data = await resp.json();
    
    // Verificar si hay errores
    if (data.error) {
      console.error("❌ Routes API error:", data.error.message || data.error.status);
      return { km: 8.5, minutos: 30 };
    }
    
    // Buscar la ruta con la distancia MÁS CORTA
    if (data.routes && data.routes.length > 0) {
      console.log(`📊 Routes API devolvió ${data.routes.length} rutas:`);
      
      // Mostrar todas las rutas
      data.routes.forEach((route, index) => {
        const distancia = parseInt(route.distanceMeters) / 1000;
        const tiempo = route.duration ? parseInt(route.duration.replace("s", "")) / 60 : 0;
        console.log(`   Ruta ${index + 1}: ${distancia.toFixed(2)} km, ${tiempo.toFixed(0)} min`);
      });
      
      // Encontrar la ruta con la distancia MÍNIMA
      let distanciaMinima = Infinity;
      let tiempoMinimo = 0;
      
      for (const route of data.routes) {
        const distanciaActual = parseInt(route.distanceMeters || Infinity);
        if (distanciaActual < distanciaMinima) {
          distanciaMinima = distanciaActual;
          tiempoMinimo = route.duration ? parseInt(route.duration.replace("s", "")) : 0;
        }
      }
      
      const km = distanciaMinima / 1000;
      const minutos = Math.round(tiempoMinimo / 60);
      
      console.log(`✅ Ruta MÁS CORTA seleccionada: ${km.toFixed(2)} km, ${minutos} min`);
      
      return { km, minutos };
    }
    
    console.warn("⚠️ Routes API no devolvió rutas, usando valor por defecto");
    return { km: 8.5, minutos: 30 };
    
  } catch (err) {
    console.error("❌ Error en cálculo de distancia:", err.message);
    return { km: 8.5, minutos: 30 };
  }
}

// 🔴 CALCULA TRAMOS SECUENCIALES (inicio → destino1 → destino2 → destino3)
async function calcularTramosSecuenciales(origen, destinos) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY || destinos.length === 0) {
    return [];
  }
  
  try {
    console.log("🔄 Calculando tramos secuenciales");
    console.log(`📍 Origen: ${origen}`);
    console.log(`📍 Destinos: ${destinos.map((d, i) => `Destino ${i+1}: ${d}`).join(" → ")}`);
    
    const resultados = [];
    let puntoAnterior = origen;
    let distanciaTotal = 0;
    let tiempoTotal = 0;
    
    // Calcular cada tramo desde el punto anterior
    for (let i = 0; i < destinos.length; i++) {
      console.log(`📍 Tramo ${i + 1}: ${puntoAnterior} → ${destinos[i]} (Destino ${i+1})`);
      
      // Extraer posible comuna del destino actual
      let comunaDestino = null;
      if (destinos[i].includes(',')) {
        const partes = destinos[i].split(',').map(p => p.trim());
        if (partes.length >= 2) {
          comunaDestino = partes[partes.length - 2];
        }
      }
      
      const { km, minutos } = await calcularDistanciaYTiempo(puntoAnterior, destinos[i], comunaDestino);
      
      // Calcular precio de ESTE TRAMO (AHORA USA PORCENTAJEAJUSTE)
      const precioTramo = calcularPrecioTramo(km);
      
      resultados.push({
        numero: i + 1,
        desde: puntoAnterior,
        direccion: destinos[i],
        distancia_km: km,
        tiempo_minutos: minutos,
        precio: precioTramo
      });
      
      distanciaTotal += km;
      tiempoTotal += minutos;
      
      // Actualizar puntoAnterior para el siguiente tramo
      puntoAnterior = destinos[i];
    }
    
    return {
      tramos: resultados,
      distancia_total_km: distanciaTotal,
      tiempo_total_minutos: tiempoTotal
    };
  } catch (err) {
    console.error("❌ Error calculando tramos secuenciales:", err);
    return {
      tramos: destinos.map((destino, index) => ({
        numero: index + 1,
        desde: index === 0 ? origen : destinos[index - 1],
        direccion: destino,
        distancia_km: 8.5,
        tiempo_minutos: 30,
        precio: calcularPrecioTramo(8.5)
      })),
      distancia_total_km: 8.5 * destinos.length,
      tiempo_total_minutos: 30 * destinos.length
    };
  }
}

// CALCULA PRECIO DE UN TRAMO INDIVIDUAL (AHORA INCORPORA PORCENTAJEAJUSTE)
function calcularPrecioTramo(distancia_km) {
  let precioBase;
  
  if (distancia_km <= 6) {
    precioBase = tarifa_base;
  } else if (distancia_km <= 10) {
    precioBase = Math.round(distancia_km * km_adicional_6_10);
  } else {
    precioBase = Math.round(distancia_km * km_adicional_10_mas);
  }
  
  // APLICAR EL PORCENTAJE DE AJUSTE GLOBAL
  if (porcentajeAjuste !== 0) {
    precioBase = Math.round(precioBase * (1 + porcentajeAjuste / 100));
  }
  
  return precioBase;
}

// CALCULAR PRECIO TOTAL (suma de todos los tramos)
function calcularPrecioTotal(tramos, codigo_cupon = "") {
  // Sumar precio de todos los tramos
  const neto = tramos.reduce((sum, tramo) => sum + tramo.precio, 0);
  
  let descuentoValor = 0, descuentoTexto = "";
  const cuponUpper = codigo_cupon.toUpperCase();
  
  if (cuponUpper && cupones && cupones[cuponUpper]) {
    const porcentaje = cupones[cuponUpper];
    descuentoValor = Math.round(neto * (porcentaje / 100));
    descuentoTexto = `Descuento ${cuponUpper} ${porcentaje}%`;
    console.log(`🎟️ Cupón aplicado: ${cuponUpper}, descuento: $${descuentoValor}`);
  }
  
  const netoConDescuento = neto - descuentoValor;
  const iva = Math.round(netoConDescuento * 0.19);
  const total = netoConDescuento + iva;
  
  return { neto, descuentoValor, descuentoTexto, iva, total, netoConDescuento };
}

function obtenerMensajeHoraEstimado() {

  const ahora = new Date();
  const dia = ahora.getDay(); // 0 = domingo, 6 = sábado
  const hora = ahora.getHours();
  const minutos = ahora.getMinutes();

  const diasSemana = [
    "domingo",
    "lunes",
    "martes",
    "miércoles",
    "jueves",
    "viernes",
    "sábado"
  ];

  function sumar80Minutos(fecha) {
    return new Date(fecha.getTime() + 80 * 60000);
  }

  function obtenerMananaNombre() {
    const manana = new Date(ahora);
    manana.setDate(ahora.getDate() + 1);
    return diasSemana[manana.getDay()];
  }

  // Lunes a Viernes antes de las 09:00
  if (dia >= 1 && dia <= 5 && hora < 9) {
    return `Gracias por cotizar en TuMotoExpress.cl, en este momento nos encontramos fuera de horario de atención, pero podemos gestionar tu envío para hoy ${diasSemana[dia]} durante la mañana.`;
  }

  // Lunes a Viernes entre 09:00 y 15:40
  if (
    dia >= 1 &&
    dia <= 5 &&
    hora >= 9 &&
    (
      hora < 15 ||
      (hora === 15 && minutos <= 40)
    )
  ) {
    const fechaEstimado = sumar80Minutos(ahora);
    const horaEst = fechaEstimado.getHours().toString().padStart(2, "0");
    const minEst = fechaEstimado.getMinutes().toString().padStart(2, "0");

    return `Gracias por cotizar en TuMotoExpress.cl, podemos realizar tu envío a partir de las ${horaEst}:${minEst} hrs.`;
  }

  // Lunes a Jueves desde 15:41 en adelante
  if (
    dia >= 1 &&
    dia <= 4 &&
    (
      hora > 15 ||
      (hora === 15 && minutos > 40)
    )
  ) {
    const nombreManana = obtenerMananaNombre();
    return `Gracias por cotizar en TuMotoExpress.cl, en este momento nos encontramos fuera de horario de atención, pero podemos agendar tu envío para el día de mañana, ${nombreManana} durante la mañana.`;
  }

  // Viernes después de 15:40, sábado y domingo
  return `Gracias por cotizar en TuMotoExpress.cl, en este momento nos encontramos fuera de horario de atención, pero podemos agendar tu envío para el día lunes durante la mañana.`;
}
// FUNCIÓN PARA GENERAR CÓDIGO ALFANUMÉRICO
function generarCodigoCotizacion() {
  const caracteres = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let codigo = '';
  for (let i = 0; i < 8; i++) {
    codigo += caracteres.charAt(Math.floor(Math.random() * caracteres.length));
  }
  return codigo;
}

// ===== FUNCIONES AGREGADAS PARA MAPA ESTÁTICO EN CORREOS =====
async function obtenerCoordenadasParaMapa(direccion) {
  try {
    console.log(`📍 Obteniendo coordenadas para mapa: "${direccion}"`);
    
    const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(direccion + ", Chile")}&region=cl&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status === "OK" && data.results.length > 0) {
      const result = data.results[0];
      const coords = `${result.geometry.location.lat},${result.geometry.location.lng}`;
      console.log(`   ✅ Coordenadas obtenidas: ${coords}`);
      return coords;
    }
    
    console.warn(`   ⚠️ No se pudieron obtener coordenadas para: ${direccion}`);
    return "-33.4489,-70.6693"; // Default Santiago
    
  } catch (err) {
    console.error(`   ❌ Error obteniendo coordenadas:`, err.message);
    return "-33.4489,-70.6693"; // Default Santiago
  }
}

async function generarUrlMapaEstatico(origen, destinos) {
  try {
    console.log("🗺️ Generando URL de mapa estático para correo");
    
    // Obtener coordenadas de origen
    const origenCoords = await obtenerCoordenadasParaMapa(origen);
    
    // Obtener coordenadas de cada destino
    const destinosCoords = [];
    for (let i = 0; i < destinos.length; i++) {
      const coords = await obtenerCoordenadasParaMapa(destinos[i]);
      destinosCoords.push(coords);
    }
    
    // Construir la URL del mapa estático
    let url = "https://maps.googleapis.com/maps/api/staticmap?maptype=roadmap&size=600x300&path=color:0xff4500|weight:5|";
    
    // Agregar todos los puntos al path (origen + destinos en orden)
    url += origenCoords;
    destinosCoords.forEach(coords => {
      url += `|${coords}`;
    });
    
    // Agregar marcador de origen (ROJO con letra A)
    url += `&markers=color:red|label:A|${origenCoords}`;
    
    // Agregar marcadores de destino (AZUL con números 1,2,3...)
    destinosCoords.forEach((coords, index) => {
      url += `&markers=color:blue|label:${index + 1}|${coords}`;
    });
    
    // Agregar API key
    url += `&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
    
    console.log("   ✅ URL de mapa estático generada");
    return url;
    
  } catch (err) {
    console.error("❌ Error generando mapa estático:", err.message);
    return null;
  }
}
// ============================================================

// 🔴 FUNCIÓN PARA ENVIAR CORREOS (ACTUALIZADA CON MAPA ESTÁTICO)
async function enviarCorreos(cliente, cotizacion) {
  console.log("📧 Iniciando envío de correos...");
  
  if (!cliente?.correo) {
    console.error("❌ No hay correo del cliente");
    return false;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cliente.correo)) {
    console.error("❌ Email del cliente no válido:", cliente.correo);
    return false;
  }

  try {
    const templatePath = path.join(__dirname, "correotemplate.html");
    let htmlTemplate = "";
    
    if (fs.existsSync(templatePath)) {
      htmlTemplate = fs.readFileSync(templatePath, "utf8");
      console.log("✅ Template de correo cargado");
    } else {
      console.error("❌ No se encuentra correotemplate.html");
      return false;
    }

    // ===== GENERAR URL DEL MAPA ESTÁTICO =====
    console.log("🗺️ Generando mapa estático para el correo...");
    const mapaUrl = await generarUrlMapaEstatico(cotizacion.origen, cotizacion.tramos.map(t => t.direccion));
    console.log(`   URL del mapa: ${mapaUrl ? "✅ Generada" : "❌ Falló"}`);
    // ==========================================

    const codigoCotizacion = cotizacion.codigoCotizacion;
    console.log("🔑 Usando código de cotización:", codigoCotizacion);

    const formatearNumero = (num) => {
      if (!num && num !== 0) return "0";
      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    };

    // Generar HTML para los tramos
    let tramosHtml = '';
    cotizacion.tramos.forEach((tramo) => {
      tramosHtml += `
        <table width="100%" border="0" cellpadding="0" cellspacing="0" style="margin:10px 0;">
          <tr>
            <td style="background:#f9f9f9; border-radius:8px; padding:12px; border-left:4px solid #ff4500;">
              <table width="100%" border="0" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="font-size:15px; font-weight:bold; color:#333; padding-bottom:8px;">
                    🚚 Tramo ${tramo.numero}: ${tramo.desde} → ${tramo.direccion}
                  </td>
                </tr>
                <tr>
                  <td>
                    <table border="0" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="background:#f0f0f0; padding:4px 12px; border-radius:20px; font-size:13px; margin-right:10px; white-space:nowrap;">
                          📏 ${tramo.distancia_km.toFixed(2)} km
                        </td>
                        <td style="background:#f0f0f0; padding:4px 12px; border-radius:20px; font-size:13px; margin-right:10px; white-space:nowrap;">
                          ⏱️ ${tramo.tiempo_minutos} min
                        </td>
                        <td style="background:#f0f0f0; padding:4px 12px; border-radius:20px; font-size:13px; white-space:nowrap;">
                          💰 $${formatearNumero(tramo.precio)}
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      `;
    });

    // Generar link de WhatsApp
    let mensajeTramos = '';
    cotizacion.tramos.forEach((tramo, index) => {
      mensajeTramos += `\nTramo ${index + 1}: ${tramo.desde} → ${tramo.direccion} (${tramo.distancia_km.toFixed(2)} km - $${formatearNumero(tramo.precio)})`;
    });
    
    const mensajeWhatsApp = `Hola, confirmo el servicio de TuMotoExpress.cl\nCódigo: ${codigoCotizacion}\nOrigen: ${cotizacion.origen}${mensajeTramos}\n\nTotal: $${formatearNumero(cotizacion.total)}`;
    const whatsappLink = `https://wa.me/56942325524?text=${encodeURIComponent(mensajeWhatsApp)}`;

    // Procesar template
    let htmlCliente = htmlTemplate
      .replace(/{{codigoCotizacion}}/g, codigoCotizacion)
      .replace(/{{nombre}}/g, cliente.nombre || "Cliente")
      .replace(/{{origen}}/g, cotizacion.origen)
      .replace(/{{tramosHtml}}/g, tramosHtml)
      .replace(/{{distancia}}/g, cotizacion.distancia_total_km.toFixed(2))
      .replace(/{{tiempoTotal}}/g, cotizacion.tiempo_total_minutos)
      .replace(/{{neto}}/g, formatearNumero(cotizacion.neto))
      .replace(/{{iva}}/g, formatearNumero(cotizacion.iva))
      .replace(/{{total}}/g, formatearNumero(cotizacion.total))
      .replace(/{{mensajeHorario}}/g, obtenerMensajeHoraEstimado())
      .replace(/{{whatsappLink}}/g, whatsappLink)
      .replace(/{{mapaEstaticoUrl}}/g, mapaUrl || ""); // ← AGREGADO: URL del mapa estático

    // Procesar descuento condicional
    if (cotizacion.descuentoValor && cotizacion.descuentoValor > 0) {
      htmlCliente = htmlCliente
        .replace(/{{#if descuento}}/g, '')
        .replace(/{{\/if}}/g, '')
        .replace(/{{descuento}}/g, formatearNumero(cotizacion.descuentoValor));
    } else {
      htmlCliente = htmlCliente.replace(/\{\{#if descuento\}\}[\s\S]*?\{\{\/if\}\}/g, '');
    }

    const fromEmail = "contacto@tumotoexpress.cl";
    
    // Enviar al cliente
    await resend.emails.send({
      from: fromEmail,
      to: cliente.correo,
      subject: `🚀 Cotización #${codigoCotizacion} - TuMotoExpress.cl - $${formatearNumero(cotizacion.total)}`,
      html: htmlCliente
    });

    // Enviar copia
    await new Promise(resolve => setTimeout(resolve, 1000));
    await resend.emails.send({
      from: fromEmail,
      to: ["contacto@tumotoexpress.cl"],
      subject: `📊 COPIA #${codigoCotizacion}: ${cliente.nombre || "cliente"} - $${formatearNumero(cotizacion.total)}`,
      html: htmlCliente
    });

    return true;
  } catch (err) {
    console.error("❌ Error enviando correos:", err.message);
    return false;
  }
}

// ENDPOINT COTIZAR
app.post("/cotizar", async (req, res) => {
  console.log("📩 POST /cotizar recibido");
  console.log("📩 Body:", req.body);
  
  try {
    const { inicio, destinos, cupon, nombre, correo, telefono } = req.body;

    if (!inicio) {
      return res.status(400).json({ error: "Falta la dirección de origen" });
    }

    if (!destinos || !Array.isArray(destinos) || destinos.length === 0) {
      return res.status(400).json({ error: "Se requiere al menos un destino" });
    }

    console.log(`📍 Procesando: ${inicio} → ${destinos.map((d,i)=> `Destino ${i+1}: ${d}`).join(" → ")}`);

    // CALCULAR TRAMOS SECUENCIALES
    const { tramos, distancia_total_km, tiempo_total_minutos } = await calcularTramosSecuenciales(inicio, destinos);
    
    // CALCULAR PRECIO TOTAL
    const precios = calcularPrecioTotal(tramos, cupon || "");
    
    // GENERAR CÓDIGO
    const codigoCotizacion = generarCodigoCotizacion();
    console.log("🔑 Código de cotización generado:", codigoCotizacion);
    
    const respuesta = {
      codigoCotizacion: codigoCotizacion,
      origen: inicio,
      tramos: tramos,
      distancia_total_km,
      tiempo_total_minutos,
      ...precios
    };

    console.log("✅ Cotización calculada:");
    console.log(`📍 Origen: ${inicio}`);
    tramos.forEach(t => {
      console.log(`   Tramo ${t.numero}: ${t.desde} → ${t.direccion} = $${t.precio} (${t.distancia_km.toFixed(2)} km)`);
    });
    console.log(`💰 Total: $${precios.total}`);

    res.json(respuesta);

    // Enviar correos si hay datos de cliente
    if (nombre && correo) {
      console.log("📧 Datos de cliente completos, enviando correos...");
      enviarCorreos({ nombre, correo, telefono }, respuesta)
        .then(success => {
          if (success) console.log("✅ Correos enviados");
          else console.log("❌ Fallo al enviar correos");
        })
        .catch(err => console.error("❌ Error:", err));
    }

  } catch (error) {
    console.error("❌ Error en /cotizar:", error);
    res.status(500).json({ error: "Error interno del servidor" });
  }
});

// ENDPOINT PARA ENVIAR CORREO
app.post("/enviar-correo", async (req, res) => {
  try {
    const { nombre, correo, telefono, cotizacion } = req.body;
    
    if (!nombre || !correo || !telefono) {
      return res.status(400).json({ error: "Faltan datos del cliente" });
    }
    
    const result = await enviarCorreos({ nombre, correo, telefono }, cotizacion);
    
    if (result) {
      res.json({ success: true, message: "Correo enviado correctamente" });
    } else {
      res.status(500).json({ error: "Error al enviar el correo" });
    }
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// SERVER
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log("=".repeat(50));
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`📍 Google Maps Key: ${process.env.GOOGLE_MAPS_BACKEND_KEY ? "✅" : "❌"}`);
  console.log(`📧 Resend API Key: ${process.env.RESEND_API_KEY ? "✅" : "❌"}`);
  console.log("=".repeat(50));
});