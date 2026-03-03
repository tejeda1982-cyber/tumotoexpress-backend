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
  process.env.WEBPAY_CODIGO_COMERCIO || '597055555532',  // Código de comercio (pruebas por defecto)
  process.env.WEBPAY_API_KEY || '579B532A7440BB0C9079DED94D31EA1615BACEB56610332264630D42D0A36B1C',  // Api Key de pruebas
  Environment.Integration  // Cambiar a Environment.Production cuando estés en vivo
);

const webpay = new WebpayPlus.Transaction(webpayOptions);
// =============================

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

// Limpieza automática cada 5 minutos
setInterval(() => {
  const ahora = Date.now();
  let eliminadas = 0;
  
  for (const [codigo, data] of Object.entries(cotizacionesTemp)) {
    if (ahora - data.timestamp > 30 * 60 * 1000) { // 30 minutos
      delete cotizacionesTemp[codigo];
      eliminadas++;
    }
  }
  
  if (eliminadas > 0) {
    console.log(`🧹 Limpieza: ${eliminadas} cotizaciones expiradas`);
  }
}, 5 * 60 * 1000);

// FUNCIÓN PARA CALCULAR DISTANCIA Y TIEMPO (siempre la ruta más corta)
async function calcularDistanciaYTiempo(origen, destino) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY) {
    console.error("❌ ERROR: GOOGLE_MAPS_BACKEND_KEY no está configurada");
    return { km: 8.5, minutos: 30 };
  }
  
  const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(origen)}&destination=${encodeURIComponent(destino)}&region=CL&mode=driving&alternatives=true&key=${process.env.GOOGLE_MAPS_BACKEND_KEY}`;
  
  try {
    console.log(`🔍 Calculando ruta de: "${origen}" a "${destino}"`);
    const resp = await fetch(url);
    const data = await resp.json();
    
    if (data.status !== "OK") {
      console.error("❌ Google Directions API error:", data.error_message || data.status);
      return { km: 8.5, minutos: 30 };
    }
    
    // Buscar la ruta con la distancia MÁS CORTA
    if (data.routes && data.routes.length > 0) {
      let rutaMasCorta = data.routes[0];
      let distanciaMinima = rutaMasCorta.legs?.[0]?.distance?.value || Infinity;
      let tiempoMinimo = rutaMasCorta.legs?.[0]?.duration?.value || 0;
      
      // Si hay múltiples rutas, encontrar la de menor distancia
      if (data.routes.length > 1) {
        for (let i = 1; i < data.routes.length; i++) {
          const distanciaActual = data.routes[i].legs?.[0]?.distance?.value || Infinity;
          if (distanciaActual < distanciaMinima) {
            distanciaMinima = distanciaActual;
            tiempoMinimo = data.routes[i].legs?.[0]?.duration?.value || 0;
          }
        }
      }
      
      const km = distanciaMinima / 1000;
      const minutos = Math.round(tiempoMinimo / 60);
      
      console.log(`✅ Ruta encontrada: ${km.toFixed(2)} km, ${minutos} min`);
      return { km, minutos };
    }
    
    return { km: 8.5, minutos: 30 };
  } catch (err) {
    console.error("❌ Error en Google Directions API:", err.message);
    return { km: 8.5, minutos: 30 };
  }
}

// 🔴 CALCULA TRAMOS SECUENCIALES (cada tramo desde el último destino)
async function calcularTramosSecuenciales(origen, destinos) {
  if (!process.env.GOOGLE_MAPS_BACKEND_KEY || !Array.isArray(destinos) || destinos.length === 0) {
    return [];
  }

  const resultados = [];
  let puntoAnterior = origen; // el primer tramo inicia desde el punto inicial
  let distanciaTotal = 0;
  let tiempoTotal = 0;

  for (let i = 0; i < destinos.length; i++) {
    const destinoActual = destinos[i];

    console.log(`📍 Tramo ${i + 1}: ${puntoAnterior} → ${destinoActual}`);

    const { km, minutos } = await calcularDistanciaYTiempo(puntoAnterior, destinoActual);
    const precioTramo = calcularPrecioTramo(km);

    resultados.push({
      numero: i + 1,
      desde: puntoAnterior,
      direccion: destinoActual,
      distancia_km: km,
      tiempo_minutos: minutos,
      precio: precioTramo
    });

    distanciaTotal += km;
    tiempoTotal += minutos;

    // **Clave:** actualizar puntoAnterior para que el próximo tramo inicie desde aquí
    puntoAnterior = destinoActual;
  }

  return {
    tramos: resultados,
    distancia_total_km: distanciaTotal,
    tiempo_total_minutos: tiempoTotal
  };
} catch (err) {
    console.error("❌ Error calculando tramos secuenciales:", err);
    
    // Fallback: aún así calcular tramos desde el punto anterior
    const resultados = [];
    let puntoAnterior = origen;
    let distanciaTotal = 0;
    let tiempoTotal = 0;
    
    for (let i = 0; i < destinos.length; i++) {
      const km = 8.5; // valor por defecto
      const minutos = 30;
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
      puntoAnterior = destinos[i]; // ¡ACTUALIZAR también en el fallback!
    }
    
    return {
      tramos: resultados,
      distancia_total_km: distanciaTotal,
      tiempo_total_minutos: tiempoTotal
    };
  }
}

// CALCULA PRECIO DE UN TRAMO INDIVIDUAL
function calcularPrecioTramo(distancia_km) {
  // Para tramos de hasta 6 km: tarifa fija
  if (distancia_km <= 6) {
    return tarifa_base;
  } 
  // Para tramos entre 6.01 y 10 km: tarifa base + km adicionales
  else if (distancia_km <= 10) {
    // Ejemplo: 8 km = $6000 + (2 km × $1000) = $8000
    const kmAdicionales = distancia_km - 6;
    return Math.round(tarifa_base + (kmAdicionales * km_adicional_6_10));
  } 
  // Para tramos mayores a 10 km: precio por km
  else {
    // Ejemplo: 12 km = 12 × $850 = $10200
    return Math.round(distancia_km * km_adicional_10_mas);
  }
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

// ============================================
// FUNCIÓN DE HORARIO UNIFICADA (CON HORA DE CHILE)
// ============================================
function obtenerMensajeHoraEstimado() {
    // Crear fecha con hora de Chile
    const ahora = new Date();
    
    // Opciones para obtener hora en Chile
    const options = {
        timeZone: 'America/Santiago',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    };
    
    // Obtener componentes de fecha/hora en Chile
    const formatter = new Intl.DateTimeFormat('es-CL', options);
    const parts = formatter.formatToParts(ahora);
    
    // Extraer valores
    let dia = 0, hora = 0, minutos = 0, mes = 0, anio = 0;
    parts.forEach(part => {
        if (part.type === 'day') dia = parseInt(part.value);
        if (part.type === 'month') mes = parseInt(part.value);
        if (part.type === 'year') anio = parseInt(part.value);
        if (part.type === 'hour') hora = parseInt(part.value);
        if (part.type === 'minute') minutos = parseInt(part.value);
    });
    
    // Crear objeto Date con la fecha/hora chilena para cálculos
    const fechaChile = new Date(anio, mes - 1, dia, hora, minutos);
    const diaSemana = fechaChile.getDay(); // 0 domingo, 1 lunes... 6 sábado
    
    const diasSemana = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
    
    console.log(`🇨🇱 Hora Chile: ${diasSemana[diaSemana]} ${hora}:${minutos.toString().padStart(2, '0')}`);
    
    function sumar80Minutos() {
        return new Date(fechaChile.getTime() + 80 * 60000);
    }

    // REGLA 1: Lunes a Viernes de 9:00 a 15:40
    if (diaSemana >= 1 && diaSemana <= 5) {
        if (hora >= 9 && (hora < 15 || (hora === 15 && minutos <= 40))) {
            const fechaEstimado = sumar80Minutos();
            const horaEst = fechaEstimado.getHours().toString().padStart(2, '0');
            const minEst = fechaEstimado.getMinutes().toString().padStart(2, '0');
            return `Podemos gestionar tu servicio a partir de las ${horaEst}:${minEst} hrs. (hora Chile)`;
        }
    }

    // REGLA 2: Lunes a Viernes de 00:00 a 8:59
    if (diaSemana >= 1 && diaSemana <= 5 && hora < 9) {
        return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario de atención, pero podemos gestionar tu envío para el día de hoy ${diasSemana[diaSemana]} durante la mañana.`;
    }

    // REGLA 3: Lunes a Jueves de 15:41 a 23:59
    if (diaSemana >= 1 && diaSemana <= 4) {
        if (hora > 15 || (hora === 15 && minutos > 40)) {
            return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario de atención, pero podríamos agendar tu envío para el día de mañana ${diasSemana[diaSemana + 1]} durante la mañana.`;
        }
    }

    // REGLA 4: Viernes después de 15:40
    if (diaSemana === 5 && (hora > 15 || (hora === 15 && minutos > 40))) {
        return `Gracias por cotizar en TuMotoExpress.cl. Nos encontramos fuera de horario comercial, pero podemos agendar tu envío el día lunes durante la mañana.`;
    }

    // REGLA 5: Sábado todo el día
    if (diaSemana === 6) {
        return `Gracias por cotizar en TuMotoExpress.cl. Nos encontramos fuera de horario comercial, pero podemos agendar tu envío el día lunes durante la mañana.`;
    }

    // REGLA 6: Domingo todo el día
    if (diaSemana === 0) {
        return `Gracias por cotizar en TuMotoExpress.cl. Nos encontramos fuera de horario comercial, pero podemos agendar tu envío el día lunes durante la mañana.`;
    }

    return `Gracias por cotizar en TuMotoExpress.cl. Te contactaremos a la brevedad.`;
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

// 🔴 FUNCIÓN PARA ENVIAR CORREOS
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

    const codigoCotizacion = cotizacion.codigoCotizacion;
    console.log("🔑 Código de cotización generado:", codigoCotizacion);

    const formatearNumero = (num) => {
      if (!num && num !== 0) return "0";
      return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    };

    // GENERAR HTML PARA LOS TRAMOS
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
      .replace(/{{whatsappLink}}/g, whatsappLink);

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

// ============================================
// ENDPOINT COTIZAR
// ============================================
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
    
    // Generar código de cotización
    const codigoCotizacion = generarCodigoCotizacion();
    
    // Preparar respuesta
    const respuesta = {
      codigoCotizacion,
      origen: inicio,
      tramos: tramos,
      distancia_total_km,
      tiempo_total_minutos,
      ...precios
    };

    // GUARDAR EN MEMORIA TEMPORAL
    cotizacionesTemp[codigoCotizacion] = {
      monto: precios.total,
      timestamp: Date.now()
    };

    console.log("✅ Cotización calculada:");
    console.log(`🔑 Código: ${codigoCotizacion}`);
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

// ============================================
// ENDPOINT PARA INICIAR PAGO WEBPAY
// ============================================
app.post("/iniciar-pago-webpay", async (req, res) => {
  try {
    const { buyOrder, amount, sessionId } = req.body;
    
    console.log("💳 Iniciando pago WebPay:", { buyOrder, amount, sessionId });
    
    // 🔒 SEGURIDAD: Verificar que la cotización existe
    const cotizacionGuardada = cotizacionesTemp[buyOrder];
    
    if (!cotizacionGuardada) {
      return res.status(400).json({ 
        success: false, 
        error: "Cotización no válida o expirada" 
      });
    }
    
    // USAR EL MONTO REAL GUARDADO
    const montoReal = cotizacionGuardada.monto;
    
    console.log(`🔒 Seguridad: Cliente envió $${amount}, pero real es $${montoReal}`);
    
    // Determinar la URL base
    const baseUrl = process.env.NODE_ENV === 'production' 
      ? 'https://tumotoexpress.cl'  // CAMBIA POR TU DOMINIO REAL
      : `http://localhost:${PORT}`;
    
    const returnUrl = `${baseUrl}/confirmar-pago-webpay`;
    
    // Crear la transacción en Transbank
    const response = await webpay.create(
      buyOrder,
      sessionId,
      montoReal,
      returnUrl
    );
    
    console.log("✅ Transacción WebPay creada:", response);
    
    res.json({
      success: true,
      token: response.token,
      url: response.url
    });
    
  } catch (error) {
    console.error('❌ Error en WebPay:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// ============================================
// ENDPOINT PARA CONFIRMAR PAGO WEBPAY
// ============================================
app.get('/confirmar-pago-webpay', async (req, res) => {
  try {
    const { token_ws, TBK_TOKEN } = req.query;
    
    console.log("📩 Confirmación de pago WebPay recibida:", { token_ws, TBK_TOKEN });
    
    if (TBK_TOKEN) {
      return res.redirect('/pago-cancelado.html');
    }
    
    if (!token_ws) {
      return res.status(400).send('No se recibió token de pago');
    }
    
    const response = await webpay.commit(token_ws);
    
    console.log('📊 Respuesta de confirmación WebPay:', response);
    
    if (response.status === 'AUTHORIZED') {
      console.log(`✅ Pago exitoso para orden: ${response.buy_order}, monto: $${response.amount}`);
      delete cotizacionesTemp[response.buy_order];
      res.redirect(`/pago-exitoso.html?orden=${response.buy_order}`);
    } else {
      console.log(`❌ Pago fallido: ${response.status}`);
      res.redirect('/pago-fallido.html');
    }
    
  } catch (error) {
    console.error('❌ Error confirmando pago:', error);
    res.status(500).send('Error procesando el pago');
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
  console.log(`💳 WebPay: ${process.env.WEBPAY_CODIGO_COMERCIO ? "✅ Usando tus datos" : "⚠️ Usando pruebas"}`);
  console.log("=".repeat(50));
});