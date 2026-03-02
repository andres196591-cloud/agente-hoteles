const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Health check
app.get('/ping', (req, res) => {
  res.json({ ok: true, mensaje: '🤖 Agente Sonterra activo' });
});

// Buscar hoteles - por ahora devuelve datos de prueba
// mientras conectamos con la plataforma real
app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.body;

  if (!destino) {
    return res.status(400).json({ error: 'Falta el destino' });
  }

  console.log(`Buscando: ${destino} del ${checkin} al ${checkout}`);

  // Respuesta de prueba para verificar que el servidor funciona
  res.json({
    ok: true,
    destino,
    total: 3,
    hoteles: [
      {
        nombre: `Hotel Grand ${destino}`,
        precio: '$120 USD',
        estrellas: '5',
        descripcion: 'Hotel de lujo con vista al mar, alberca infinita y spa de clase mundial.',
        imagen: null,
        enlace: null
      },
      {
        nombre: `Boutique ${destino} Suites`,
        precio: '$85 USD',
        estrellas: '4',
        descripcion: 'Elegante hotel boutique en el corazón de la ciudad, desayuno incluido.',
        imagen: null,
        enlace: null
      },
      {
        nombre: `Resort ${destino} Beach Club`,
        precio: '$200 USD',
        estrellas: '5',
        descripcion: 'Todo incluido frente al mar con actividades acuáticas y entretenimiento.',
        imagen: null,
        enlace: null
      }
    ]
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Agente corriendo en puerto ${PORT}`);
});
