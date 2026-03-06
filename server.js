const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => res.json({ ok: true, v: 13 }));

// ── SSE STREAMING ──
app.get('/stream-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.query;
  if (!destino) { res.status(400).end(); return; }

  const ciudad = destino.split(',')[0].trim();
  console.log(`🚀 STREAM: "${ciudad}"`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (tipo, data) => {
    try { res.write(`data: ${JSON.stringify({ tipo, ...data })}\n\n`); } catch(e) {}
  };

  emit('status', { msg: `Conectando al portal para ${ciudad}...` });

  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process','--no-zygote']
    });

    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    });
    const page = await ctx.newPage();

    // LOGIN
    emit('status', { msg: 'Iniciando sesión...' });
    await page.goto('https://login.orohorizonsclub.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { const m = document.getElementById('myModal'); if (m) m.style.display = 'flex'; });
    await page.waitForTimeout(1000);
    await page.fill('#myModal input[name="username"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'OroHC213&');
    await page.click('#myModal button:has-text("Log in")');
    await page.waitForTimeout(8000);
    emit('status', { msg: 'Sesión OK. Abriendo buscador...' });

    // BUSCADOR
    await page.goto('https://portal.membergetaways.com/rsi/search', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // DESTINO
    await page.waitForSelector('.ant-select-selection-search-input', { timeout: 10000 });
    await page.click('.ant-select-selection-search-input');
    await page.waitForTimeout(500);
    await page.type('.ant-select-selection-search-input', ciudad, { delay: 180 });
    await page.waitForTimeout(3500);

    try {
      await page.waitForSelector('.ant-select-item-option', { timeout: 5000 });
      const opts = await page.$$('.ant-select-item-option');
      if (opts.length > 0) { await opts[0].click(); console.log('✅ Sugerencia OK'); }
    } catch {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(1500);

    // FECHAS
    if (checkin && checkout) {
      try {
        await page.click('.date-picker__wrapper');
        await page.waitForTimeout(1500);
        const dayIn = parseInt(checkin.split('-')[2]);
        const dayOut = parseInt(checkout.split('-')[2]);
        const sel = `.rdrDay:not(.rdrDayDisabled):not(.rdrDayPassive) .rdrDayNumber span`;
        for (const d of await page.$$(sel)) {
          if (parseInt(await d.textContent()) === dayIn) { await d.click(); break; }
        }
        await page.waitForTimeout(500);
        for (const d of await page.$$(sel)) {
          if (parseInt(await d.textContent()) === dayOut) { await d.click(); break; }
        }
        try { await page.click('button:has-text("Done")'); } catch {}
        await page.waitForTimeout(500);
      } catch(e) { console.log('Fechas error:', e.message); }
    }

    // BUSCAR
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const b = document.querySelector('.search-button');
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    emit('status', { msg: 'Buscando resultados...' });
    await page.waitForTimeout(12000);
    emit('status', { msg: 'Extrayendo hoteles...' });

    // FUNCIÓN EXTRACCIÓN
    const extraer = async () => {
      return page.evaluate(() => {
        const results = [];
        // Buscar elementos que tengan precio US$ e imagen real
        const candidatos = new Map();
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || '';
          if (!src || src.includes('icon') || src.includes('logo') || src.includes('flag') || src.includes('chain') || src.includes('amenity')) return;
          if (!src.includes('travelapi') && !src.includes('expedia') && !src.match(/\.(jpg|jpeg|png|webp)/i)) return;
          // Subir hasta encontrar contenedor con precio y nombre
          let el = img.parentElement;
          for (let i = 0; i < 10; i++) {
            if (!el) break;
            const txt = el.innerText || '';
            const hasPrice = txt.match(/US\$\s*[\d]+/);
            const nameEl = el.querySelector('h2,h3,h4,strong');
            if (hasPrice && nameEl) {
              const nombre = nameEl.textContent.trim();
              if (nombre.length > 4 && nombre.length < 150 &&
                  !nombre.match(/^(refundable|non-refund|select|compare|view map|internet|priceline|public|star rating|vacation|filter|sort|back|budget|amenities)/i)) {
                if (!candidatos.has(nombre)) {
                  candidatos.set(nombre, { el, img: src, txt, nombre });
                }
              }
              break;
            }
            el = el.parentElement;
          }
        });

        candidatos.forEach(({ el, img: imagen, txt, nombre }) => {
          const precios = (txt.match(/US\$\s*[\d,]+\.?\d*/gi) || [])
            .map(p => parseFloat(p.replace(/US\$\s*/i,'').replace(/,/g,'')))
            .filter(n => n > 0);
          const precioMin = precios.length ? Math.min(...precios) : 0;
          const ratingM = txt.match(/(\d\.\d{1,2})\s*\(/);
          const reviewM = txt.match(/\(?([\d,]+)\s*reviews?\)?/i);
          const saveM = txt.match(/save\s*(\d+)%/i);
          const addrEl = el.querySelector('[class*="address"],[class*="location"]');
          const distM = txt.match(/([\d.]+\s*miles?\s*from[^,\n]+)/i);
          const link = el.querySelector('a[href*="hotel"],a[href*="property"],a[href*="search"],a')?.href || '';

          // Múltiples imágenes del contenedor
          const allImgs = Array.from(el.querySelectorAll('img'))
            .map(i => i.src || '')
            .filter(s => s && !s.includes('icon') && !s.includes('logo') && !s.includes('flag') &&
              !s.includes('chain') && !s.includes('amenity') &&
              (s.includes('travelapi') || s.includes('expedia') || s.match(/\.(jpg|jpeg|png|webp)/i)));

          results.push({
            nombre,
            precio: precioMin ? `US$ ${Math.round(precioMin)}` : '',
            imagen: allImgs[0] || imagen,
            imagenes: [...new Set(allImgs)].slice(0, 6),
            rating: ratingM ? ratingM[1] : '',
            reviews: reviewM ? reviewM[1] : '',
            ahorro: saveM ? `Save ${saveM[1]}%` : '',
            direccion: (addrEl?.textContent?.trim() || distM?.[0] || '').substring(0, 120),
            enlace: link,
            fuente: 'portal'
          });
        });
        return results;
      });
    };

    // STREAM: enviar conforme aparecen
    const enviados = new Set();
    let total = 0;

    const enviarNuevos = async () => {
      const hoteles = await extraer();
      let nuevos = 0;
      for (const h of hoteles) {
        const key = h.nombre.toLowerCase().trim();
        if (!enviados.has(key)) {
          enviados.add(key);
          emit('hotel', { hotel: h });
          total++;
          nuevos++;
        }
      }
      return nuevos;
    };

    // Primera tanda
    await enviarNuevos();
    emit('status', { msg: `${total} hoteles encontrados. Cargando más...` });

    // Scroll continuo
    let vacios = 0;
    for (let r = 0; r < 25; r++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2800);
      const nuevos = await enviarNuevos();
      if (nuevos === 0) { vacios++; if (vacios >= 3) break; }
      else { vacios = 0; emit('status', { msg: `${total} hoteles encontrados...` }); }
    }

    await browser.close();
    emit('fin', { total });
    console.log(`✅ Stream completo: ${total} hoteles`);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌', err.message);
    emit('error', { msg: err.message });
  }

  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🤖 v13 SSE puerto ${PORT}`));
