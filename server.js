require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// ================================
// CALCULAR DISTANCIA REAL CON GOOGLE MAPS
// ================================
async function calcularDistancia(inicio, destino) {
  if (!inicio?.trim() || !destino?.trim()) {
    console.error("Direcciones inválidas");
    return null;
  }

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(inicio)}&destinations=${encodeURIComponent(destino)}&region=CL&key=${process.env.GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await fetch(url);

    if (!resp.ok) {
      console.error(`Google Maps error: ${resp.status} ${resp.statusText}`);
      return null;
    }

    const data = await resp.json();

    if (data.rows?.[0]?.elements?.[0]?.status === "OK") {
      return data.rows[0].elements[0].distance.value / 1000; // km
    }

    console.error("Google Maps error:", data.status);
    return null;
  } catch (e) {
    console.error("Error al calcular distancia:", e.message);
    return null;
  }
}

// ================================
// CALCULAR PRECIO SEGÚN DISTANCIA
// ================================
function calcularPrecio(distancia_km) {
  let neto = 0;

  if (distancia_km <= 6) {
    // 0 a 6 km: $6000 base
    neto = 6000;
  } else if (distancia_km <= 10) {
    // 6 a 10 km: $6000 + $1000 por km adicional
    const km_adicionales = distancia_km - 6;
    neto = 6000 + (km_adicionales * 1000);
  } else {
    // Desde 10.1 km: $6000 + (4 * $1000) + $900 por km adicional
    const km_6_a_10 = 4; // 6 a 10 km son 4 km
    const km_adicionales = distancia_km - 10;
    neto = 6000 + (km_6_a_10 * 1000) + (km_adicionales * 900);
  }

  // Calcular IVA (19%)
  const iva = Math.round(neto * 0.19);
  const total = neto + iva;

  return { neto, iva, total };
}

// ================================
// FUNCIÓN HORARIO ESTIMADO
// ================================
function calcularMensajeHorario() {
  const ahora = new Date();
  const dia = ahora.getDay();
  const hora = ahora.getHours();
  const minuto = ahora.getMinutes();
  const minutosActuales = hora * 60 + minuto;
  
  const diasSemana = ["domingo","lunes","martes","miércoles","jueves","viernes","sábado"];
  
  const apertura = 9 * 60;
  const cierre = 17 * 60;
  const limiteRespuesta = 15 * 60 + 40;
  const tiempoRespuesta = 80;

  // Domingo
  if (dia === 0) {
    return "Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, podemos gestionar tu servicio para el día lunes durante la mañana (sujeto a disponibilidad).";
  }

  // Lunes a jueves antes de las 9
  if (dia >= 1 && dia <= 4 && minutosActuales < apertura) {
    return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, pero podemos gestionar tu servicio hoy ${diasSemana[dia]} durante la mañana (sujeto a disponibilidad).`;
  }

  // Lunes a viernes entre 9:00 y 15:40
  if (dia >= 1 && dia <= 5 && minutosActuales >= apertura && minutosActuales <= limiteRespuesta) {
    const respuesta = new Date(ahora.getTime() + tiempoRespuesta * 60000);
    const horasStr = respuesta.getHours().toString().padStart(2, "0");
    const minutosStr = respuesta.getMinutes().toString().padStart(2, "0");
    return `Gracias por cotizar en TuMotoExpress.cl. Podemos gestionar tu servicio a partir de las ${horasStr}:${minutosStr} horas aproximadamente (sujeto a disponibilidad).`;
  }

  // Lunes a jueves después de 15:40
  if (dia >= 1 && dia <= 4 && minutosActuales > limiteRespuesta) {
    const manana = new Date(ahora);
    manana.setDate(ahora.getDate() + 1);
    return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, podemos gestionar tu servicio para mañana ${diasSemana[manana.getDay()]} durante la mañana (sujeto a disponibilidad).`;
  }

  // Viernes después de 15:40, sábado o domingo
  const lunes = new Date(ahora);
  while (lunes.getDay() !== 1) {
    lunes.setDate(lunes.getDate() + 1);
  }
  return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, podemos gestionar tu servicio para el día lunes durante la mañana (sujeto a disponibilidad).`;
}

// ================================
// ENDPOINT COTIZAR
// ================================
app.post("/cotizar", async (req, res) => {
  const { inicio, destino } = req.body;

  if (!inicio?.trim() || !destino?.trim()) {
    return res.status(400).json({ error: "Faltan direcciones válidas" });
  }

  const distancia_km = await calcularDistancia(inicio, destino);

  if (distancia_km === null) {
    return res.status(400).json({ error: "No se pudo calcular distancia" });
  }

  // Calcular precio según distancia
  const { neto, iva, total } = calcularPrecio(distancia_km);

  res.json({
    inicio,
    destino,
    distancia_km,
    neto,
    iva,
    total,
    mensajeHorario: calcularMensajeHorario()
  });
});

// ================================
// ENVIAR COTIZACIÓN POR CORREO
// ================================
app.post("/enviar-cotizacion", async (req, res) => {
  const { nombre, telefono, email, distancia_km, neto, iva, total, mensajeHorario } = req.body;

  if (!nombre?.trim() || !telefono?.trim() || !email?.trim()) {
    return res.status(400).json({ error: "Faltan datos del cliente" });
  }

  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: "Servicio de email no configurado" });
  }

  const resend = new Resend(process.env.RESEND_API_KEY);

  try {
    await resend.emails.send({
      from: "TuMotoExpress <onboarding@resend.dev>",
      to: email,
      subject: "Cotización TuMotoExpress.cl - Consulta disponibilidad de servicio",
      html: `
        <h2>Cotización TuMotoExpress.cl</h2>
        <p><strong>Nombre:</strong> ${nombre}</p>
        <p><strong>Teléfono:</strong> ${telefono}</p>
        <hr>
        <p><strong>Distancia:</strong> ${distancia_km.toFixed(2)} km</p>
        <p><strong>Neto:</strong> $${neto.toLocaleString()}</p>
        <p><strong>IVA (19%):</strong> $${iva.toLocaleString()}</p>
        <p><strong>Total:</strong> $${total.toLocaleString()}</p>
        <hr>
        <p><strong>Disponibilidad:</strong> ${mensajeHorario}</p>
        <p>Gracias por confiar en TuMotoExpress.cl</p>
      `
    });
    res.json({ ok: true });
  } catch (e) {
    console.error("Error enviando correo:", e.message);
    res.status(500).json({ error: "No se pudo enviar correo" });
  }
});

// ================================
// SERVER
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});