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

    // Activar modal
    await page.evaluate(() => {
      const modal = document.getElementById('myModal');
      if (modal) modal.style.display = 'flex';
    });
    await page.waitForTimeout(1000);

    // Credenciales
    await page.fill('#myModal input[name="username"], #myModal input[type="text"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'orovazquez');
    await page.waitForTimeout(500);
    await page.click('#myModal button:has-text("Log in"), .modal__wrapper button');
    
    await page.waitForTimeout(8000);
    console.log('✅ Login. URL:', page.url());

    // ── PASO 2: Ir a búsqueda y llenar formulario ──
    console.log('🏨 Abriendo buscador de hoteles...');
    await page.goto('https://portal.membergetaways.com/rsi/search', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    await page.waitForTimeout(3000);

    // Llenar destino
    console.log('📍 Llenando destino:', destino);
    await page.click('input[placeholder*="going"], input[placeholder*="Where"], input[placeholder*="Location"]');
    await page.waitForTimeout(500);
    await page.type('input[placeholder*="going"], input[placeholder*="Where"], input[placeholder*="Location"]', destino, { delay: 100 });
    await page.waitForTimeout(3000);

    // Seleccionar primera sugerencia
    try {
      await page.waitForSelector('.pac-item, [class*="suggestion"], [class*="autocomplete"] li, [role="option"]', { timeout: 5000 });
      await page.click('.pac-item:first-child, [class*="suggestion"]:first-child, [class*="autocomplete"] li:first-child, [role="option"]:first-child');
      await page.waitForTimeout(1000);
      console.log('✅ Sugerencia seleccionada');
    } catch {
      console.log('⚠️ No apareció sugerencia, presionando Enter');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(1000);
    }

    // Llenar fechas
    if (checkin && checkout) {
      try {
        await page.click('input[placeholder*="dates"], [placeholder*="Check"]');
        await page.waitForTimeout(500);
        // Intentar llenar fecha de entrada
        const checkinFormatted = checkin; // formato YYYY-MM-DD
        await page.fill('input[name*="checkin"], input[placeholder*="Check-in"]', checkinFormatted);
        await page.fill('input[name*="checkout"], input[placeholder*="Check-out"]', checkout);
      } catch {
        console.log('⚠️ No se pudieron llenar fechas');
      }
    }

    // Clic en buscar
    console.log('🔍 Buscando...');
    await page.click('button:has-text("Find your hotel"), button:has-text("Search")');
    await page.waitForTimeout(8000);

    const urlResultados = page.url();
    console.log('📊 URL resultados:', urlResultados);

    // ── PASO 3: Extraer hoteles ──
    const hoteles = await page.evaluate(() => {
      const results = [];
      
      // Buscar cards de hoteles - selectores específicos de membergetaways
      const selectores = [
        '[class*="HotelCard"]', '[class*="hotelCard"]', 
        '[class*="PropertyCard"]', '[class*="property-card"]',
        '[class*="hotel-card"]', '[class*="SearchResult"]',
        '[class*="ResultCard"]', '[class*="resultCard"]',
        '.hotel-item', '.property-item',
        '[data-testid*="hotel"]', '[data-testid*="property"]'
      ];

      let cards = [];
      for (const sel of selectores) {
        const found = document.querySelectorAll(sel);
        if (found.length >= 1) { 
          cards = Array.from(found); 
          console.log('Selector encontrado:', sel, 'cantidad:', found.length);
          break; 
        }
      }

      // Si no encontró con selectores específicos, buscar por estructura
      if (cards.length === 0) {
        // Buscar elementos con precio y nombre juntos
        document.querySelectorAll('article, [class*="card"], [class*="result"], [class*="item"]').forEach(el => {
          const tieneNombre = el.querySelector('h2, h3, h4, [class*="name"], [class*="title"]');
          const tienePrecio = el.querySelector('[class*="price"], [class*="rate"], [class*="cost"]');
          if (tieneNombre && tienePrecio) cards.push(el);
        });
      }

      cards.slice(0, 15).forEach(card => {
        const nombre = card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"],[class*="Name"],[class*="Title"]')?.textContent?.trim();
        const precioEl = card.querySelector('[class*="price"],[class*="Price"],[class*="rate"],[class*="Rate"],[class*="cost"],[class*="amount"]');
        const precio = precioEl?.textContent?.trim();
        const imagen = card.querySelector('img[src*="http"]')?.src;
        const estrellasEl = card.querySelector('[class*="star"],[class*="Star"],[class*="rating"],[class*="Rating"]');
        const estrellas = estrellasEl?.textContent?.trim() || estrellasEl?.getAttribute('aria-label');
        const descripcion = card.querySelector('p,[class*="desc"],[class*="Desc"],[class*="address"],[class*="location"]')?.textContent?.trim()?.substring(0, 150);
        const enlaceEl = card.querySelector('a[href*="hotel"], a[href*="property"], a');
        const enlace = enlaceEl?.href;
        
        if (nombre && nombre.length > 3) {
          results.push({ nombre, precio, imagen, estrellas, descripcion, enlace });
        }
      });

      return results;
    });

    // Debug si no encontró
    let debug = null;
    if (hoteles.length === 0) {
      debug = await page.evaluate(() => ({
        url: window.location.href,
        titulo: document.title,
        clases: Array.from(document.querySelectorAll('[class]')).slice(0, 30).map(el => el.className).join(', '),
        texto: document.body.innerText.substring(0, 500)
      }));
      console.log('Debug clases:', debug.clases?.substring(0, 300));
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
