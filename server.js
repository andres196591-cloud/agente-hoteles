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

    // ── PASO 1: Abrir página y activar modal via JS ──
    console.log('🔐 Abriendo login...');
    await page.goto('https://login.orohorizonsclub.com/', { 
      waitUntil: 'domcontentloaded', 
      timeout: 30000 
    });
    await page.waitForTimeout(2000);

    // Activar el modal cambiando display:none a display:flex (como muestra el código)
    await page.evaluate(() => {
      const modal = document.getElementById('myModal');
      if (modal) modal.style.display = 'flex';
    });
    await page.waitForTimeout(1000);

    // Llenar username y password dentro del modal
    console.log('📝 Llenando credenciales...');
    await page.fill('#myModal input[name="username"], #myModal input[type="text"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'orovazquez');
    await page.waitForTimeout(500);

    // Clic en "Log in to account" dentro del modal
    await page.click('#myModal button:has-text("Log in"), #myModal input[type="submit"], .modal__wrapper button');
    
    console.log('⏳ Esperando redirección...');
    await page.waitForTimeout(8000);
    console.log('✅ URL después del login:', page.url());

    // Aceptar permisos de ubicación si aparecen
    try {
      await page.click('button:has-text("Allow"), button:has-text("Accept"), button:has-text("OK")', { timeout: 3000 });
    } catch { }

    // ── PASO 2: Navegar a búsqueda de hoteles ──
    console.log('🏨 Yendo a hoteles...');
    
    // Esperar que cargue el portal
    await page.waitForTimeout(2000);
    const currentUrl = page.url();
    console.log('URL actual:', currentUrl);

    // Si ya estamos en el portal, ir directo a hoteles
    if (currentUrl.includes('membergetaways') || currentUrl.includes('portal')) {
      await page.goto('https://portal.membergetaways.com/rsi/search', { 
        waitUntil: 'domcontentloaded', 
        timeout: 30000 
      });
    } else {
      // Buscar link de Hotels en la página actual
      try {
        await page.click('a:has-text("Hotels"), a[href*="hotel"]', { timeout: 5000 });
      } catch {
        await page.goto('https://portal.membergetaways.com/rsi/search', { 
          waitUntil: 'domcontentloaded', 
          timeout: 30000 
        });
      }
    }

    await page.waitForTimeout(3000);
    console.log('URL hoteles:', page.url());

    // ── PASO 3: Buscar destino ──
    // Llenar campo de búsqueda
    const inputLocation = await page.$('input[placeholder*="going"], input[placeholder*="Where"], input[placeholder*="Location"], input[placeholder*="location"]');
    if (inputLocation) {
      await inputLocation.click();
      await inputLocation.fill(destino);
      await page.waitForTimeout(2000);
      
      // Seleccionar primera sugerencia del autocomplete
      try {
        const sugerencia = await page.$('.pac-item, .autocomplete-item, [class*="suggestion"], [role="option"]');
        if (sugerencia) await sugerencia.click();
        else await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
      } catch { }
      await page.waitForTimeout(1000);
    }

    // Clic en buscar
    try {
      await page.click('button:has-text("Find your hotel"), button:has-text("Search"), button[type="submit"]', { timeout: 5000 });
      await page.waitForTimeout(8000);
    } catch { }

    console.log('📊 URL resultados:', page.url());

    // ── PASO 4: Extraer hoteles ──
    const hoteles = await page.evaluate(() => {
      const results = [];
      
      // Selectores para membergetaways
      const selectores = [
        '[class*="HotelCard"]', '[class*="hotelCard"]', '[class*="hotel-card"]',
        '[class*="PropertyCard"]', '[class*="property-card"]',
        '[class*="SearchResult"]', '[class*="search-result"]',
        '[class*="ResultCard"]', '[class*="result-card"]',
        '.hotel-item', '.property-item', 'article'
      ];

      let cards = [];
      for (const sel of selectores) {
        const found = document.querySelectorAll(sel);
        if (found.length >= 2) { cards = Array.from(found); break; }
      }

      cards.slice(0, 15).forEach(card => {
        const nombre = card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"],[class*="Name"],[class*="Title"]')?.textContent?.trim();
        const precio = card.querySelector('[class*="price"],[class*="Price"],[class*="rate"],[class*="Rate"],[class*="cost"]')?.textContent?.trim();
        const imagen = card.querySelector('img')?.src;
        const estrellas = card.querySelector('[class*="star"],[class*="Star"],[class*="rating"],[class*="Rating"]')?.textContent?.trim();
        const descripcion = card.querySelector('p,[class*="desc"],[class*="Desc"]')?.textContent?.trim()?.substring(0, 150);
        const enlace = card.querySelector('a')?.href;
        if (nombre && nombre.length > 3) {
          results.push({ nombre, precio, imagen, estrellas, descripcion, enlace });
        }
      });

      return results;
    });

    let debug = null;
    if (hoteles.length === 0) {
      debug = await page.evaluate(() => ({
        url: window.location.href,
        titulo: document.title,
        texto: document.body.innerText.substring(0, 1500)
      }));
      console.log('Debug:', JSON.stringify(debug).substring(0, 500));
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
