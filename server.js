require("dotenv").config();
const fetch = require('node-fetch');
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

// ✅ CORS CORREGIDO (único cambio realizado)
app.use(cors({
  origin: "https://cotizador.tumotoexpress.cl",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type"]
}));
app.options("*", cors());

app.use(express.json());
app.use(express.static(__dirname));

const TARIFAS_FILE = path.join(__dirname, "tarifas.json");

// ================================
// FUNCIONES PARA LEER Y GUARDAR TARIFAS
// ================================
function leerTarifas() {
  try {
    const data = fs.readFileSync(TARIFAS_FILE, "utf8");
    const json = JSON.parse(data);
    return {
      tarifa_base: json.tarifa_base || 6000,
      km_adicional_6_10: json.km_adicional_6_10 || 1000,
      km_adicional_10_mas: json.km_adicional_10_mas || 850,
      cupones: json.cupones || {}
    };
  } catch (e) {
    console.error("Error leyendo tarifas.json:", e.message);
    return { tarifa_base: 6000, km_adicional_6_10: 1000, km_adicional_10_mas: 850, cupones: {} };
  }
}

function guardarTarifas(tarifas) {
  try {
    fs.writeFileSync(TARIFAS_FILE, JSON.stringify(tarifas, null, 2), "utf8");
  } catch (e) {
    console.error("Error guardando tarifas.json:", e.message);
  }
}

// ================================
// VARIABLES DINÁMICAS
// ================================
let porcentajeAjuste = 0;
let { tarifa_base, km_adicional_6_10, km_adicional_10_mas, cupones } = leerTarifas();

// ================================
// CALCULAR DISTANCIA REAL CON GOOGLE MAPS
// ================================
async function calcularDistancia(inicio, destino) {
  if (!inicio?.trim() || !destino?.trim()) return null;

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(inicio)}&destinations=${encodeURIComponent(destino)}&region=CL&key=${process.env.GOOGLE_MAPS_API_KEY}`;

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error(`Google Maps error: ${resp.status} ${resp.statusText}`);
      return null;
    }
    const data = await resp.json();
    if (data.rows?.[0]?.elements?.[0]?.status === "OK") {
      return data.rows[0].elements[0].distance.value / 1000;
    }
    console.error("Google Maps error:", data.status);
    return null;
  } catch (e) {
    console.error("Error al calcular distancia:", e.message);
    return null;
  }
}

// ================================
// CALCULAR PRECIO SEGÚN TARIFAS DINÁMICAS
// ================================
function calcularPrecio(distancia_km, codigo_cupon = "") {
  let neto = 0;

  if (distancia_km <= 6) neto = tarifa_base;
  else if (distancia_km <= 10) neto = Math.round(distancia_km * km_adicional_6_10);
  else neto = Math.round(distancia_km * km_adicional_10_mas);

  let ajuste = porcentajeAjuste;
  if (ajuste > 1) ajuste = ajuste / 100;
  neto = Math.round(neto * (1 + ajuste));

  let descuentoValor = 0;
  let descuentoTexto = "";
  if (codigo_cupon && cupones[codigo_cupon.toUpperCase()] != null) {
    let porcentaje = cupones[codigo_cupon.toUpperCase()];
    if (porcentaje > 1) porcentaje = porcentaje / 100;
    descuentoValor = Math.round(neto * porcentaje);
    descuentoTexto = `Descuento ${codigo_cupon.toUpperCase()} ${Math.round(porcentaje*100)}%`;
  }

  const netoConDescuento = neto - descuentoValor;
  const iva = Math.round(netoConDescuento * 0.19);
  const total = netoConDescuento + iva;

  return {
    neto,
    descuentoValor,
    descuentoTexto,
    netoConDescuento,
    iva,
    total
  };
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
  const limiteRespuesta = 15 * 60 + 40;
  const tiempoRespuesta = 80;

  if (dia === 0) return `Gracias por cotizar en TuMotoExpress.cl. Fuera de horario, gestionaremos tu servicio el lunes en la mañana.`;
  if (dia >= 1 && dia <= 4 && minutosActuales < apertura)
    return `Fuera de horario comercial, podemos gestionar tu servicio hoy ${diasSemana[dia]} durante la mañana.`;
  if (dia >= 1 && dia <= 5 && minutosActuales >= apertura && minutosActuales <= limiteRespuesta) {
    const respuesta = new Date(ahora.getTime() + tiempoRespuesta * 60000);
    const h = respuesta.getHours().toString().padStart(2,'0');
    const m = respuesta.getMinutes().toString().padStart(2,'0');
    return `Podemos gestionar tu servicio a partir de las ${h}:${m} horas aproximadamente.`;
  }
  if (dia >=1 && dia <=4 && minutosActuales > limiteRespuesta) {
    const manana = new Date(ahora); manana.setDate(ahora.getDate() + 1);
    return `Fuera de horario, gestionaremos tu servicio para mañana ${diasSemana[manana.getDay()]} en la mañana.`;
  }
  const lunes = new Date(ahora); while(lunes.getDay()!==1) lunes.setDate(lunes.getDate()+1);
  return `Fuera de horario, gestionaremos tu servicio el lunes en la mañana.`;
}

// ================================
// ENDPOINT COTIZAR
// ================================
app.post("/cotizar", async (req,res) => {
  const { inicio, destino, cupon } = req.body;
  if (!inicio?.trim() || !destino?.trim()) return res.status(400).json({ error: "Faltan direcciones válidas" });

  const distancia_km = await calcularDistancia(inicio,destino);
  if (distancia_km === null) return res.status(400).json({ error: "No se pudo calcular distancia" });

  const { neto, descuentoValor, descuentoTexto, netoConDescuento, iva, total } = calcularPrecio(distancia_km, cupon);

  res.json({
    inicio,
    destino,
    distancia_km,
    neto,
    descuentoValor,
    descuentoTexto,
    netoConDescuento,
    iva,
    total,
    mensajeHorario: calcularMensajeHorario()
  });
});

// ================================
// ENDPOINT CONFIG PARA MINIPANEL
// ================================
app.get("/config", (req,res) => {
  res.json({ porcentajeAjuste, cupones, tarifa_base, km_adicional_6_10, km_adicional_10_mas });
});

app.post("/config", (req,res) => {
  const { nuevoPorcentaje, nuevosCupones } = req.body;
  if (typeof nuevoPorcentaje === "number") porcentajeAjuste = nuevoPorcentaje;
  if (typeof nuevosCupones === "object") {
    for (let c in nuevosCupones) {
      const v = nuevosCupones[c];
      if (!isNaN(v)) cupones[c.toUpperCase()] = v;
    }
  }
  guardarTarifas({ tarifa_base, km_adicional_6_10, km_adicional_10_mas, cupones });
  res.json({ ok:true, porcentajeAjuste, cupones });
});

// ================================
// SERVER
// ================================
const PORT = process.env.PORT || 3000;
app.listen(PORT,()=>console.log(`✅ Servidor corriendo en puerto ${PORT}`));