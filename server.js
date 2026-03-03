const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/ping', (req, res) => {
  res.json({ ok: true, mensaje: '🤖 Agente Sonterra con Claude AI + Imágenes' });
});

app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.body;
  if (!destino) return res.status(400).json({ error: 'Falta el destino' });

  let browser;
  try {
    const { chromium } = require('playwright');

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process','--no-zygote']
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      geolocation: { latitude: 19.4326, longitude: -99.1332 },
      permissions: ['geolocation']
    });

    const page = await context.newPage();

    // ── LOGIN ──
    console.log('🔐 Login...');
    await page.goto('https://login.orohorizonsclub.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { const m = document.getElementById('myModal'); if (m) m.style.display = 'flex'; });
    await page.waitForTimeout(1000);
    await page.fill('#myModal input[name="username"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'orovazquez');
    await page.waitForTimeout(500);
    await page.click('#myModal button:has-text("Log in")');
    await page.waitForTimeout(8000);
    console.log('✅ Login OK:', page.url());

    // ── IR AL BUSCADOR ──
    console.log('🏨 Buscador...');
    await page.goto('https://portal.membergetaways.com/rsi/search', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // ── LLENAR DESTINO ──
    console.log('📍 Destino:', destino);
    await page.waitForSelector('.ant-select-selection-search-input', { timeout: 10000 });
    await page.click('.ant-select-selection-search-input');
    await page.waitForTimeout(500);
    await page.type('.ant-select-selection-search-input', destino, { delay: 150 });
    await page.waitForTimeout(3000);

    try {
      await page.waitForSelector('.ant-select-item-option', { timeout: 5000 });
      await page.click('.ant-select-item-option');
      console.log('✅ Sugerencia OK');
    } catch {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(1000);

    // ── FECHAS ──
    if (checkin && checkout) {
      try {
        await page.click('.date-picker__wrapper');
        await page.waitForTimeout(1500);
        const [,,dayIn] = checkin.split('-').map(Number);
        const sel = `.rdrDay:not(.rdrDayDisabled):not(.rdrDayPassive) .rdrDayNumber span`;
        for (const d of await page.$$(sel)) {
          if (parseInt(await d.textContent()) === dayIn) { await d.click(); break; }
        }
        await page.waitForTimeout(500);
        const [,,dayOut] = checkout.split('-').map(Number);
        for (const d of await page.$$(sel)) {
          if (parseInt(await d.textContent()) === dayOut) { await d.click(); break; }
        }
        await page.click('button:has-text("Done")');
        await page.waitForTimeout(500);
      } catch(e) { console.log('⚠️ Fechas:', e.message); }
    }

    // ── BUSCAR ──
    console.log('🔍 Buscando...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.evaluate(() => { const b = document.querySelector('.search-button'); if (b) b.click(); });
    await page.waitForTimeout(12000);
    console.log('📊 URL:', page.url());

    // ── EXTRAER DATOS COMPLETOS con imágenes ──
    const datosExtraidos = await page.evaluate(() => {
      const hoteles = [];

      // Buscar todas las cards de resultados
      const posiblesSelectores = [
        '[class*="result"]', '[class*="hotel"]', '[class*="property"]',
        '[class*="card"]', 'article'
      ];

      let cards = [];
      for (const sel of posiblesSelectores) {
        const found = [...document.querySelectorAll(sel)].filter(el => {
          const txt = el.innerText || '';
          return txt.length > 30 && el.querySelector('img, h2, h3, h4');
        });
        if (found.length >= 2) { cards = found.slice(0, 20); break; }
      }

      cards.forEach(card => {
        // Imágenes
        const imgs = [...card.querySelectorAll('img')]
          .map(i => i.src || i.dataset.src || '')
          .filter(src => src && src.startsWith('http') && !src.includes('icon') && !src.includes('logo'));

        // Nombre
        const nombre = (
          card.querySelector('h1,h2,h3,h4,[class*="name"],[class*="title"]')?.textContent || ''
        ).trim();

        // Precio - buscar el número más prominente
        const todosTextos = card.innerText || '';
        const precioMatch = todosTextos.match(/US\$\s*[\d,]+\.?\d*|From\s*US\$\s*[\d,]+|\$\s*[\d,]+/i);

        // Rating/estrellas
        const rating = (card.querySelector('[class*="rating"],[class*="star"],[class*="review"]')?.textContent || '').trim();

        // Dirección/ubicación
        const addr = (card.querySelector('[class*="address"],[class*="location"],[class*="distance"]')?.textContent || '').trim();

        // Enlace
        const enlace = card.querySelector('a[href*="membergetaways"], a[href*="hotel"], a[href*="property"]')?.href || '';

        // Ahorro
        const ahorro = (card.querySelector('[class*="save"],[class*="saving"],[class*="discount"]')?.textContent || '').trim();

        if (nombre && nombre.length > 3) {
          hoteles.push({
            nombre,
            precio: precioMatch ? precioMatch[0] : '',
            imagenes: imgs.slice(0, 4),
            imagen: imgs[0] || '',
            estrellas: rating,
            descripcion: addr.substring(0, 120),
            enlace,
            ahorro
          });
        }
      });

      // Texto completo para Claude
      const textoCompleto = document.body.innerText.substring(0, 8000);
      const url = window.location.href;

      return { hoteles, textoCompleto, url, total: hoteles.length };
    });

    console.log(`📦 Datos extraídos: ${datosExtraidos.total} hoteles`);

    // ── CLAUDE AI analiza y enriquece ──
    console.log('🤖 Claude analizando...');

    const prompt = `Eres un extractor de datos de hoteles. Analiza el siguiente texto de resultados de búsqueda de hoteles del portal membergetaways.com y devuelve información estructurada.

URL: ${datosExtraidos.url}
Destino buscado: ${destino}

TEXTO DE LA PÁGINA:
${datosExtraidos.textoCompleto}

HOTELES YA EXTRAÍDOS (con imágenes y links):
${JSON.stringify(datosExtraidos.hoteles, null, 2)}

Tu tarea:
1. Enriquece los datos ya extraídos con información del texto
2. Para cada hotel incluye: nombre, precio (en USD por noche), estrellas (número), descripcion (dirección/ubicación corta), descripcion_larga (descripción del hotel), enlace, imagen (URL), imagenes (array de URLs), ahorro (ej: "Save 52%"), reviews (número de reviews si aparece), rating_numero (número como 4.4)

Devuelve SOLO este JSON sin texto adicional ni backticks:
{"hoteles":[{"nombre":"...","precio":"US$ XXX","estrellas":"5","rating_numero":"4.4","reviews":"1153 reviews","descripcion":"Boulevard Kukulkan...","descripcion_larga":"...","imagen":"https://...","imagenes":["https://..."],"enlace":"https://...","ahorro":"Save 52%"}]}

Si no hay hoteles devuelve: {"hoteles":[]}`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }]
    });

    let hoteles = datosExtraidos.hoteles; // fallback
    try {
      const txt = response.content[0].text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(txt);
      if (parsed.hoteles?.length > 0) hoteles = parsed.hoteles;
    } catch(e) {
      console.log('⚠️ Parse Claude error, usando datos directos');
    }

    await browser.close();
    console.log(`✅ Total hoteles: ${hoteles.length}`);
    res.json({ ok: true, destino, total: hoteles.length, hoteles });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🤖 Puerto ${PORT}`));
