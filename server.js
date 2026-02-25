require("dotenv").config();
const express = require("express");
const cors = require("cors");

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
    neto = 6000;
  } else if (distancia_km <= 10) {
    const km_adicionales = distancia_km - 6;
    neto = 6000 + (km_adicionales * 1000);
  } else {
  const km_6_a_10 = 4;
  const km_adicionales = distancia_km - 10;
  neto = 6000 + (km_6_a_10 * 1000) + (km_adicionales * 800);
}

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

  if (dia === 0) {
    return "Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, podemos gestionar tu servicio para el día lunes durante la mañana (sujeto a disponibilidad).";
  }

  if (dia >= 1 && dia <= 4 && minutosActuales < apertura) {
    return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, pero podemos gestionar tu servicio hoy ${diasSemana[dia]} durante la mañana (sujeto a disponibilidad).`;
  }

  if (dia >= 1 && dia <= 5 && minutosActuales >= apertura && minutosActuales <= limiteRespuesta) {
    const respuesta = new Date(ahora.getTime() + tiempoRespuesta * 60000);
    const horasStr = respuesta.getHours().toString().padStart(2, "0");
    const minutosStr = respuesta.getMinutes().toString().padStart(2, "0");
    return `Gracias por cotizar en TuMotoExpress.cl. Podemos gestionar tu servicio a partir de las ${horasStr}:${minutosStr} horas aproximadamente (sujeto a disponibilidad).`;
  }

  if (dia >= 1 && dia <= 4 && minutosActuales > limiteRespuesta) {
    const manana = new Date(ahora);
    manana.setDate(ahora.getDate() + 1);
    return `Gracias por cotizar en TuMotoExpress.cl. En este momento nos encontramos fuera de horario comercial, podemos gestionar tu servicio para mañana ${diasSemana[manana.getDay()]} durante la mañana (sujeto a disponibilidad).`;
  }

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
// SERVER
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Servidor corriendo en puerto ${PORT}`);
});