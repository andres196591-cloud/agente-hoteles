/**
 * AGENTE ORO HORIZONS CLUB - Backend
 * Para sonterraclub.com
 */

const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');

const app = express();

// CORS: permite peticiones desde sonterraclub.com
app.use(cors({
  origin: '*', // Abierto para que funcione desde WordPress
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

const CREDENTIALS = {
  username: 'orothomas',
  password: 'orovazquez'
};

const LOGIN_URL = 'https://login.orohorizonsclub.com/';

// ─────────────────────────────────────────────
// ENDPOINT PRINCIPAL: buscar hoteles
// POST /buscar-hoteles
// ─────────────────────────────────────────────
app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.body;

  if (!destino) {
    return res.status(400).json({ error: 'Falta el destino' });
  }

  let browser;
  try {
    console.log(`🔍 Buscando hoteles en: ${destino}`);

    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36'
    });

    const page = await context.newPage();

    // ── PASO 1: Login ──
    console.log('🔐 Abriendo página de login...');
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Clic en botón de login para abrir el modal
    console.log('🖱️ Abriendo modal de login...');
    try {
      await page.click('text=Log in to account', { timeout: 5000 });
    } catch {
      try {
        await page.click('text=Log in', { timeout: 5000 });
      } catch {
        await page.click('a[href="#"]', { timeout: 5000 });
      }
    }
    await page.waitForTimeout(2000);

    // Llenar usuario
    console.log('📝 Llenando credenciales...');
    const userInput = await page.$('input[name="username"], input[placeholder*="sername"], input[placeholder*="Usuario"]');
    if (userInput) await userInput.fill(CREDENTIALS.username);

    const passInput = await page.$('input[type="password"]');
    if (passInput) await passInput.fill(CREDENTIALS.password);

    await page.waitForTimeout(1000);

    // Enviar login
    console.log('🚀 Enviando login...');
    try {
      await page.click('text=Log in to account', { timeout: 5000 });
    } catch {
      await page.click('button[type="submit"], input[type="submit"]', { timeout: 5000 });
    }

    await page.waitForTimeout(5000);
    console.log('✅ Login enviado. URL:', page.url());

    // Screenshot para debug
    await page.screenshot({ path: '/tmp/post-login.png' });

    // ── PASO 2: Buscar hoteles ──
    console.log('🏨 Buscando sección de hoteles...');

    // Buscar links de hoteles en la página actual
    const todosLosLinks = await page.$$eval('a', links =>
      links.map(a => ({ texto: a.textContent.trim(), href: a.href }))
        .filter(l => l.href && l.texto)
    );

    console.log('Links disponibles:', todosLosLinks.slice(0, 15));

    // Encontrar link de hoteles
    const linkHotel = todosLosLinks.find(l =>
      /hotel|alojam|accommod|stay|hosped/i.test(l.texto + l.href)
    );

    if (linkHotel) {
      console.log('🔗 Yendo a:', linkHotel.href);
      await page.goto(linkHotel.href, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(2000);
    }

    // Intentar buscar destino
    const inputDestino = await page.$('input[placeholder*="estino"], input[placeholder*="ity"], input[placeholder*="here"], input[name*="dest"], input[name*="location"]');
    if (inputDestino) {
      await inputDestino.fill(destino);
      await page.waitForTimeout(1500);
      // Seleccionar sugerencia si aparece
      const sugerencia = await page.$('[class*="autocomplete"] li, [class*="suggest"] li, [role="option"]');
      if (sugerencia) await sugerencia.click();
    }

    if (checkin) {
      const inputCheckin = await page.$('input[name*="checkin"], input[name*="check_in"], input[placeholder*="llegada"], input[placeholder*="heck-in"]');
      if (inputCheckin) await inputCheckin.fill(checkin);
    }

    if (checkout) {
      const inputCheckout = await page.$('input[name*="checkout"], input[name*="check_out"], input[placeholder*="salida"]');
      if (inputCheckout) await inputCheckout.fill(checkout);
    }

    // Buscar
    const btnBuscar = await page.$('button[type="submit"], input[type="submit"], button:has-text("Search"), button:has-text("Buscar")');
    if (btnBuscar) {
      await btnBuscar.click();
      await page.waitForTimeout(5000);
    }

    await page.screenshot({ path: '/tmp/resultados.png' });

    // ── PASO 3: Extraer resultados ──
    console.log('📊 Extrayendo resultados...');

    const hoteles = await page.evaluate(() => {
      const resultados = [];
      const selectores = [
        '.hotel-card', '.property-card', '.result-card', '.hotel-item',
        '.listing-card', '.accommodation-card', '[class*="hotel"]',
        '[class*="property"]', '[class*="result-item"]', 'article', '.card'
      ];

      let cards = [];
      for (const sel of selectores) {
        const found = document.querySelectorAll(sel);
        if (found.length > 0) { cards = found; break; }
      }

      cards.forEach((card, i) => {
        if (i >= 20) return;
        const nombre = card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"]')?.textContent?.trim();
        const precio = card.querySelector('[class*="price"],[class*="rate"],[class*="cost"],[class*="tarifa"]')?.textContent?.trim();
        const imagen = card.querySelector('img')?.src;
        const estrellas = card.querySelector('[class*="star"],[class*="rating"]')?.textContent?.trim();
        const descripcion = card.querySelector('p,[class*="desc"]')?.textContent?.trim()?.substring(0, 150);
        const enlace = card.querySelector('a')?.href;
        if (nombre && nombre.length > 2) {
          resultados.push({ nombre, precio, imagen, estrellas, descripcion, enlace });
        }
      });

      return resultados;
    });

    // Si no encontró resultados estructurados, devolver el texto visible
    let paginaTexto = '';
    if (hoteles.length === 0) {
      paginaTexto = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    }

    console.log(`✅ Encontrados: ${hoteles.length} hoteles`);
    await browser.close();

    res.json({
      ok: true,
      destino,
      total: hoteles.length,
      hoteles,
      debug: hoteles.length === 0 ? paginaTexto : null
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Health check
app.get('/ping', (req, res) => res.json({ ok: true, mensaje: '🤖 Agente Sonterra activo' }));

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`🤖 Agente corriendo en puerto ${PORT}`);
});
