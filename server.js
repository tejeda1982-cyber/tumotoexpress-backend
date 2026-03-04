require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const fetch = require("node-fetch");
const { Resend } = require("resend");

// ===== WEBPAY TRANSBANK =====
const { WebpayPlus, Options, Environment } = require('transbank-sdk');

// Configuración de Webpay (usar variables de entorno)
const webpayOptions = new Options(
  process.env.WEBPAY_CODIGO_COMERCIO || '597055555532',  
  process.env.WEBPAY_API_KEY || '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C',  
  Environment.Integration  
);
const webpay = new WebpayPlus.Transaction(webpayOptions);

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

// ============================================
// ALMACENAMIENTO TEMPORAL DE COTIZACIONES (MEMORIA RAM)
// ============================================
const cotizacionesTemp = {};
setInterval(() => {
  const ahora = Date.now();
  for (const [codigo, data] of Object.entries(cotizacionesTemp)) {
    if (ahora - data.timestamp > 30 * 60 * 1000) delete cotizacionesTemp[codigo];
  }
}, 5 * 60 * 1000);

// FUNCIONES AUXILIARES
async function calcularDistanciaYTiempo(origen, destino) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY) return { km: 8.5, minutos: 30 };
  
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origen)}&destination=${encodeURIComponent(destino)}&region=CL&mode=driving&alternatives=true&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
  
  try {
    const resp = await fetch(url);
    const data = await resp.json();
    if (data.status !== "OK") return { km: 8.5, minutos: 30 };

    // Buscar la ruta más corta
    let rutaMasCorta = data.routes[0];
    let distanciaMinima = rutaMasCorta.legs?.[0]?.distance?.value || Infinity;
    let tiempoMinimo = rutaMasCorta.legs?.[0]?.duration?.value || 0;
    if (data.routes.length > 1) {
      for (let i = 1; i < data.routes.length; i++) {
        const dist = data.routes[i].legs?.[0]?.distance?.value || Infinity;
        if (dist < distanciaMinima) {
          distanciaMinima = dist;
          tiempoMinimo = data.routes[i].legs?.[0]?.duration?.value || 0;
        }
      }
    }
    return { km: distanciaMinima/1000, minutos: Math.round(tiempoMinimo/60) };
  } catch (err) {
    console.error("Error en Google Directions API:", err.message);
    return { km: 8.5, minutos: 30 };
  }
}

async function calcularTramosSecuenciales(origen, destinos) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY || destinos.length === 0) return [];
  const resultados = [];
  let puntoAnterior = origen, distanciaTotal = 0, tiempoTotal = 0;
  
  for (let i = 0; i < destinos.length; i++) {
    const { km, minutos } = await calcularDistanciaYTiempo(puntoAnterior, destinos[i]);
    const precioTramo = calcularPrecioTramo(km);
    resultados.push({ numero: i+1, desde: puntoAnterior, direccion: destinos[i], distancia_km: km, tiempo_minutos: minutos, precio: precioTramo });
    distanciaTotal += km; tiempoTotal += minutos; puntoAnterior = destinos[i];
  }
  return { tramos: resultados, distancia_total_km: distanciaTotal, tiempo_total_minutos: tiempoTotal };
}

function calcularPrecioTramo(distancia_km) {
  if (distancia_km <= 6) return tarifa_base;
  if (distancia_km <= 10) return Math.round(distancia_km * km_adicional_6_10);
  return Math.round(distancia_km * km_adicional_10_mas);
}

function calcularPrecioTotal(tramos, codigo_cupon = "") {
  const neto = tramos.reduce((sum, t) => sum + t.precio, 0);
  let descuentoValor = 0, descuentoTexto = "";
  const cuponUpper = codigo_cupon.toUpperCase();
  if (cuponUpper && cupones && cupones[cuponUpper]) {
    const porcentaje = cupones[cuponUpper];
    descuentoValor = Math.round(neto * (porcentaje/100));
    descuentoTexto = `Descuento ${cuponUpper} ${porcentaje}%`;
  }
  const netoConDescuento = neto - descuentoValor;
  const iva = Math.round(netoConDescuento * 0.19);
  const total = netoConDescuento + iva;
  return { neto, descuentoValor, descuentoTexto, iva, total, netoConDescuento };
}

function generarCodigoCotizacion() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let codigo = '';
  for (let i = 0; i < 8; i++) codigo += chars.charAt(Math.floor(Math.random() * chars.length));
  return codigo;
}

// ============================================
// FUNCIÓN ENVIAR CORREOS (RECIBE CÓDIGO)
// ============================================
async function enviarCorreos(cliente, cotizacion, codigoCotizacion) {
  if (!cliente?.correo) return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cliente.correo)) return false;

  try {
    const templatePath = path.join(__dirname, "correotemplate.html");
    if (!fs.existsSync(templatePath)) return false;
    let htmlTemplate = fs.readFileSync(templatePath, "utf8");

    const formatearNumero = (num) => num ? num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".") : "0";

    // Tramos HTML
    let tramosHtml = '';
    cotizacion.tramos.forEach(t => {
      tramosHtml += `<table style="margin:10px 0;"><tr><td>Tramo ${t.numero}: ${t.desde} → ${t.direccion} - ${t.distancia_km.toFixed(2)} km - $${formatearNumero(t.precio)}</td></tr></table>`;
    });

    // WhatsApp
    let mensajeTramos = '';
    cotizacion.tramos.forEach((t,i) => {
      mensajeTramos += `\nTramo ${i+1}: ${t.desde} → ${t.direccion} (${t.distancia_km.toFixed(2)} km - $${formatearNumero(t.precio)})`;
    });
    const mensajeWhatsApp = `Hola, confirmo el servicio de TuMotoExpress.cl\nCódigo: ${codigoCotizacion}\nOrigen: ${cotizacion.origen}${mensajeTramos}\n\nTotal: $${formatearNumero(cotizacion.total)}`;
    const whatsappLink = `https://wa.me/56942325524?text=${encodeURIComponent(mensajeWhatsApp)}`;

    // Reemplazo template
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
      .replace(/{{mensajeHorario}}/g, "Podemos gestionar tu servicio pronto") // Simplificado
      .replace(/{{whatsappLink}}/g, whatsappLink);

    if (cotizacion.descuentoValor && cotizacion.descuentoValor > 0) {
      htmlCliente = htmlCliente.replace(/{{#if descuento}}/g,'').replace(/{{\/if}}/g,'').replace(/{{descuento}}/g, formatearNumero(cotizacion.descuentoValor));
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
    await new Promise(r => setTimeout(r,1000));
    await resend.emails.send({
      from: fromEmail,
      to: ["contacto@tumotoexpress.cl"],
      subject: `📊 COPIA #${codigoCotizacion}: ${cliente.nombre || "cliente"} - $${formatearNumero(cotizacion.total)}`,
      html: htmlCliente
    });

    return true;
  } catch (err) {
    console.error("Error enviando correos:", err.message);
    return false;
  }
}

// ============================================
// ENDPOINT /COTIZAR
// ============================================
app.post("/cotizar", async (req,res) => {
  try {
    const { inicio, destinos, cupon, nombre, correo, telefono } = req.body;
    if (!inicio) return res.status(400).json({ error:"Falta origen" });
    if (!destinos || !Array.isArray(destinos) || destinos.length === 0) return res.status(400).json({ error:"Se requiere al menos un destino" });

    const { tramos, distancia_total_km, tiempo_total_minutos } = await calcularTramosSecuenciales(inicio,destinos);
    const precios = calcularPrecioTotal(tramos, cupon||"");

    // Generar único código
    const codigoCotizacion = generarCodigoCotizacion();

    const respuesta = {
      codigoCotizacion,
      origen: inicio,
      tramos,
      distancia_total_km,
      tiempo_total_minutos,
      ...precios
    };

    // Guardar en memoria temporal
    cotizacionesTemp[codigoCotizacion] = { monto: precios.total, timestamp: Date.now() };

    res.json(respuesta);

    // Enviar correos
    if (nombre && correo) {
      enviarCorreos({ nombre, correo, telefono }, respuesta, codigoCotizacion)
        .then(success => console.log(success ? "Correos enviados" : "Fallo al enviar correos"))
        .catch(err => console.error(err));
    }

  } catch (err) {
    console.error(err);
    res.status(500).json({ error:"Error interno" });
  }
});

// ============================================
// ENDPOINTS WEBPAY
// ============================================
app.post("/iniciar-pago-webpay", async (req,res)=>{
  try {
    const { buyOrder, amount, sessionId } = req.body;
    const cotizacionGuardada = cotizacionesTemp[buyOrder];
    if (!cotizacionGuardada) return res.status(400).json({ success:false, error:"Cotización no válida" });

    const montoReal = cotizacionGuardada.monto;
    const baseUrl = process.env.NODE_ENV === 'production' ? 'https://tumotoexpress.cl' : `http://localhost:${PORT}`;
    const returnUrl = `${baseUrl}/confirmar-pago-webpay`;

    const response = await webpay.create(buyOrder, sessionId, montoReal, returnUrl);
    res.json({ success:true, token:response.token, url:response.url });

  } catch (err) { console.error(err); res.status(500).json({ success:false, error:err.message }); }
});

app.get('/confirmar-pago-webpay', async (req,res)=>{
  try {
    const { token_ws, TBK_TOKEN } = req.query;
    if (TBK_TOKEN) return res.redirect('/pago-cancelado.html');
    if (!token_ws) return res.status(400).send('No se recibió token de pago');

    const response = await webpay.commit(token_ws);
    if (response.status === 'AUTHORIZED') {
      delete cotizacionesTemp[response.buy_order];
      res.redirect(`/pago-exitoso.html?orden=${response.buy_order}`);
    } else {
      res.redirect('/pago-fallido.html');
    }
  } catch(err){ console.error(err); res.status(500).send('Error procesando el pago'); }
});

// ============================================
// ENDPOINT ENVIAR CORREO (OPCIONAL)
// ============================================
app.post("/enviar-correo", async (req,res)=>{
  try {
    const { nombre, correo, telefono, cotizacion } = req.body;
    if (!nombre || !correo || !telefono) return res.status(400).json({ error:"Faltan datos" });
    const result = await enviarCorreos({ nombre, correo, telefono }, cotizacion, cotizacion.codigoCotizacion);
    res.json(result ? { success:true } : { success:false, error:"Error al enviar correo" });
  } catch(err){ console.error(err); res.status(500).json({ error:err.message }); }
});

// ============================================
// SERVER
// ============================================
const PORT = process.env.PORT || 10000;
app.listen(PORT, ()=>{
  console.log("=".repeat(50));
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
  console.log(`📍 Google Maps Key: ${process.env.GOOGLE_MAPS_BACKEND_KEY ? "✅" : "❌"}`);
  console.log(`📧 Resend API Key: ${process.env.RESEND_API_KEY ? "✅" : "❌"}`);
  console.log(`💳 WebPay: ${process.env.WEBPAY_CODIGO_COMERCIO ? "✅" : "⚠️ Pruebas"}`);
  console.log("=".repeat(50));
});