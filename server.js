const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => {
  res.json({ ok: true, mensaje: '🤖 Agente Sonterra activo' });
});

app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.body;
  if (!destino) return res.status(400).json({ error: 'Falta el destino' });

  let browser;
  try {
    const { chromium } = require('playwright');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      geolocation: { latitude: 19.4326, longitude: -99.1332 },
      permissions: ['geolocation']
    });

    const page = await context.newPage();

    // ── PASO 1: Login ──
    console.log('🔐 Abriendo login...');
    await page.goto('https://login.orohorizonsclub.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(2000);

    // Activar modal de login
    await page.evaluate(() => {
      const modal = document.getElementById('myModal');
      if (modal) modal.style.display = 'flex';
    });
    await page.waitForTimeout(1000);

    // Llenar credenciales
    await page.fill('#myModal input[name="username"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'orovazquez');
    await page.waitForTimeout(500);
    await page.click('#myModal button:has-text("Log in")');

    await page.waitForTimeout(8000);
    console.log('✅ Login OK. URL:', page.url());

    // ── PASO 2: Ir a buscador de hoteles ──
    console.log('🏨 Abriendo buscador...');
    await page.goto('https://portal.membergetaways.com/rsi/search', {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });
    await page.waitForTimeout(3000);

    // ── PASO 3: Llenar destino ──
    console.log('📍 Escribiendo destino:', destino);
    const inputSelector = 'input[placeholder="Where are you going?"]';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.click(inputSelector);
    await page.waitForTimeout(300);
    await page.type(inputSelector, destino, { delay: 120 });
    await page.waitForTimeout(3000);

    // Seleccionar primera sugerencia del autocomplete
    try {
      const sugerencia = 'li[class*="suggestion"], li[class*="autocomplete"], [role="option"], .pac-item';
      await page.waitForSelector(sugerencia, { timeout: 4000 });
      await page.click(sugerencia);
      console.log('✅ Sugerencia seleccionada');
    } catch {
      console.log('⚠️ Sin sugerencia, usando Enter');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(1000);

    // ── PASO 4: Buscar ──
    console.log('🔍 Presionando buscar...');
    await page.click('button:has-text("Find your hotel")');
    await page.waitForTimeout(8000);
    console.log('📊 URL resultados:', page.url());

    // ── PASO 5: Extraer hoteles ──
    const hoteles = await page.evaluate(() => {
      const results = [];

      // Buscar contenedores de hoteles
      const selectores = [
        '[class*="HotelCard"]', '[class*="hotelCard"]',
        '[class*="PropertyCard"]', '[class*="property-card"]',
        '[class*="hotel-card"]', '[class*="SearchResult"]',
        '[class*="ResultCard"]', '[class*="resultCard"]',
        '.hotel-item', '[data-testid*="hotel"]'
      ];

      let cards = [];
      for (const sel of selectores) {
        const found = document.querySelectorAll(sel);
        if (found.length >= 1) {
          cards = Array.from(found);
          break;
        }
      }

      // Si no encontró con selectores específicos, buscar por estructura
      if (cards.length === 0) {
        document.querySelectorAll('article, [class*="card"], [class*="result"]').forEach(el => {
          const tieneNombre = el.querySelector('h2, h3, h4, [class*="name"], [class*="title"]');
          const tienePrecio = el.querySelector('[class*="price"], [class*="rate"]');
          if (tieneNombre && tienePrecio) cards.push(el);
        });
      }

      cards.slice(0, 15).forEach(card => {
        const nombre = card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"]')?.textContent?.trim();
        const precio = card.querySelector('[class*="price"],[class*="rate"],[class*="cost"],[class*="amount"]')?.textContent?.trim();
        const imagen = card.querySelector('img[src*="http"]')?.src;
        const estrellas = card.querySelector('[class*="star"],[class*="rating"]')?.textContent?.trim();
        const descripcion = card.querySelector('p,[class*="desc"],[class*="address"],[class*="location"]')?.textContent?.trim()?.substring(0, 150);
        const enlace = card.querySelector('a')?.href;

        if (nombre && nombre.length > 3) {
          results.push({ nombre, precio, imagen, estrellas, descripcion, enlace });
        }
      });

      return results;
    });

    // Debug si no encontró hoteles
    let debug = null;
    if (hoteles.length === 0) {
      debug = await page.evaluate(() => ({
        url: window.location.href,
        titulo: document.title,
        texto: document.body.innerText.substring(0, 800)
      }));
      console.log('Debug:', JSON.stringify(debug).substring(0, 400));
    }

    await browser.close();
    console.log(`✅ Hoteles encontrados: ${hoteles.length}`);

    res.json({ ok: true, destino, total: hoteles.length, hoteles, debug });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Agente corriendo en puerto ${PORT}`);
});
