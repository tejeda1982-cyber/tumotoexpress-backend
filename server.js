const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Sirve index.html y logo

// Node 18+ ya incluye fetch
const fetch = global.fetch;

// Calcular tarifa
function calcularTarifa(distancia_km) {
  let neto = 0;
  if (distancia_km <= 6) neto = 6000;
  else if (distancia_km <= 10) neto = Math.round(distancia_km * 1000);
  else neto = Math.round(distancia_km * 900);

  const iva = Math.round(neto * 0.19);
  const total = neto + iva;

  return { neto, iva, total };
}

// Endpoint de cotización
app.post('/cotizar', async (req, res) => {
  const { inicio, destino } = req.body;
  const googleApiKey = process.env.GOOGLE_MAPS_API_KEY;

  if (!googleApiKey) return res.status(500).json({ error: "API Key no configurada" });

  try {
    // Usamos Directions API con alternatives=true
    const url = `https://maps.googleapis.com/maps/api/directions/json?origin=${encodeURIComponent(inicio)}&destination=${encodeURIComponent(destino)}&key=${googleApiKey}&mode=driving&alternatives=true`;

    const response = await fetch(url);
    const data = await response.json();

    if (data.routes && data.routes.length > 0) {
      // Elegir la ruta con menor distancia
      let rutaMasCorta = data.routes[0];
      for (const ruta of data.routes) {
        if (ruta.legs[0].distance.value < rutaMasCorta.legs[0].distance.value) {
          rutaMasCorta = ruta;
        }
      }

      const distancia_metros = rutaMasCorta.legs[0].distance.value;
      const distancia_km = distancia_metros / 1000;

      const { neto, iva, total } = calcularTarifa(distancia_km);

      res.json({
        inicio,
        destino,
        distancia_km,
        neto,
        iva,
        total,
        ruta: rutaMasCorta // útil si quieres mostrar el mapa
      });
    } else {
      res.status(400).json({ error: "No se pudo calcular distancia" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Error Google Maps" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Servidor corriendo en puerto ${PORT}`));