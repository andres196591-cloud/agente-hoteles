/**
 * AGENTE ORO HORIZONS CLUB - Backend
 * Uso: node server.js
 * Requiere: npm install express playwright cors
 * Luego: npx playwright install chromium
 */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();
app.use(cors()); // Permite que tu web Sonterra se conecte
app.use(express.json());

const CREDENTIALS = {
  username: 'orothomas',
  password: 'orovazquez'
};

const LOGIN_URL = 'https://login.orohorizonsclub.com/';

// ─────────────────────────────────────────────
// ENDPOINT PRINCIPAL: buscar hoteles
// POST /buscar-hoteles
// Body: { destino: "Cancun", checkin: "2025-04-01", checkout: "2025-04-07", huespedes: 2 }
// ─────────────────────────────────────────────
app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout, huespedes } = req.body;

  if (!destino) {
    return res.status(400).json({ error: 'Falta el destino' });
  }

  let browser;
  try {
    console.log(`🔍 Buscando hoteles en: ${destino}`);

    browser = await chromium.launch({
      headless: true, // false para ver el navegador (debug)
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });

    const page = await context.newPage();

    // ── PASO 1: Ir a la página y hacer login ──
    console.log('🔐 Iniciando sesión...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

    // Clic en botón de login para abrir el modal
    await page.click('a[href="#"]:has-text("Log in"), a:has-text("Log in to account")');
    await page.waitForTimeout(1000);

    // Llenar credenciales
    await page.fill('input[name="username"], input[placeholder*="sername"], input[id*="user"]', CREDENTIALS.username);
    await page.fill('input[name="password"], input[type="password"]', CREDENTIALS.password);

    // Enviar login
    await page.click('button:has-text("Log in"), input[type="submit"], .login-btn');
    
    // Esperar a que cargue el dashboard
    await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    console.log('✅ Sesión iniciada. URL actual:', page.url());

    // ── PASO 2: Navegar a búsqueda de hoteles ──
    console.log('🏨 Buscando sección de hoteles...');

    // Tomar screenshot para debug (opcional)
    await page.screenshot({ path: '/tmp/dashboard.png' });

    // Buscar menú de hoteles/viajes
    const hotelLinks = await page.$$eval('a', links =>
      links
        .filter(a => /hotel|alojamiento|accommod|stay|viaje|travel/i.test(a.textContent + a.href))
        .map(a => ({ text: a.textContent.trim(), href: a.href }))
    );

    console.log('Links de hoteles encontrados:', hotelLinks.slice(0, 5));

    // Intentar ir a sección de hoteles
    if (hotelLinks.length > 0) {
      await page.goto(hotelLinks[0].href, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
    }

    // ── PASO 3: Llenar búsqueda ──
    // Intentar llenar campo de destino
    const destinoInput = await page.$('input[placeholder*="estino"], input[placeholder*="city"], input[placeholder*="Ciudad"], input[name*="dest"], input[id*="dest"]');
    
    if (destinoInput) {
      await destinoInput.fill(destino);
      await page.waitForTimeout(1000);

      // Autocompletar si aparece
      const suggestion = await page.$('.autocomplete-item, .suggestion, [role="option"]');
      if (suggestion) await suggestion.click();
    }

    // Fechas si existen los campos
    if (checkin) {
      const checkinInput = await page.$('input[name*="checkin"], input[placeholder*="llegada"], input[type="date"]:first-of-type');
      if (checkinInput) await checkinInput.fill(checkin);
    }

    if (checkout) {
      const checkoutInput = await page.$('input[name*="checkout"], input[placeholder*="salida"]');
      if (checkoutInput) await checkoutInput.fill(checkout);
    }

    // Botón buscar
    const searchBtn = await page.$('button[type="submit"], button:has-text("Buscar"), button:has-text("Search"), input[type="submit"]');
    if (searchBtn) {
      await searchBtn.click();
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(3000);
    }

    // ── PASO 4: Extraer resultados ──
    console.log('📊 Extrayendo resultados...');
    await page.screenshot({ path: '/tmp/resultados.png' });

    // Extraer tarjetas de hoteles (ajusta los selectores según la web real)
    const hoteles = await page.evaluate(() => {
      const resultados = [];
      
      // Selectores comunes de resultados de hotel
      const cards = document.querySelectorAll(
        '.hotel-card, .property-card, .result-card, .hotel-item, .listing-card, [class*="hotel"], [class*="property"], [class*="result"]'
      );

      cards.forEach((card, i) => {
        if (i >= 20) return; // máximo 20 resultados

        const nombre = card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"]')?.textContent?.trim();
        const precio = card.querySelector('[class*="price"],[class*="rate"],[class*="cost"],.precio,.price')?.textContent?.trim();
        const imagen = card.querySelector('img')?.src;
        const estrellas = card.querySelector('[class*="star"],[class*="rating"]')?.textContent?.trim();
        const descripcion = card.querySelector('p,[class*="desc"]')?.textContent?.trim()?.substring(0, 150);
        const enlace = card.querySelector('a')?.href;

        if (nombre) {
          resultados.push({ nombre, precio, imagen, estrellas, descripcion, enlace });
        }
      });

      // Si no encontró cards específicas, buscar más genérico
      if (resultados.length === 0) {
        document.querySelectorAll('article, .card, .item').forEach((el, i) => {
          if (i >= 10) return;
          const nombre = el.querySelector('h2,h3,h4')?.textContent?.trim();
          const precio = el.querySelector('[class*="price"]')?.textContent?.trim();
          if (nombre) resultados.push({ nombre, precio });
        });
      }

      return resultados;
    });

    console.log(`✅ Encontrados ${hoteles.length} hoteles`);

    // Si no encontró nada estructurado, devolver el texto de la página
    let textoPagina = '';
    if (hoteles.length === 0) {
      textoPagina = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    }

    await browser.close();

    res.json({
      ok: true,
      destino,
      total: hoteles.length,
      hoteles,
      nota: hoteles.length === 0 ? 'No se encontraron resultados estructurados. Texto de página: ' + textoPagina : null
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Health check
app.get('/ping', (req, res) => res.json({ ok: true, mensaje: 'Agente activo 🤖' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🤖 Agente corriendo en http://localhost:${PORT}`);
  console.log(`📡 Endpoint: POST http://localhost:${PORT}/buscar-hoteles`);
});
