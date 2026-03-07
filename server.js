const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => res.json({ ok: true, v: 16 }));

// ── Imágenes genéricas a bloquear ──
const BAD_IMG_PATTERNS = [
  'package-DSIKBsRR', 'rsi/assets', 'placeholder', 'no-image',
  'noimage', 'default.jpg', 'blank.', 'logo', 'icon-', 'amenity',
  'chain-logo', 'flag'
];
function isGoodImg(src) {
  if (!src || src.length < 10) return false;
  const lower = src.toLowerCase();
  if (BAD_IMG_PATTERNS.some(p => lower.includes(p))) return false;
  if (!lower.match(/\.(jpg|jpeg|png|webp)/i) && !lower.includes('travelapi') && !lower.includes('expedia') && !lower.includes('media')) return false;
  return true;
}

// ── Helper: lanzar browser ──
async function launchBrowser() {
  const { chromium } = require('playwright');
  return chromium.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
           '--disable-gpu','--single-process','--no-zygote']
  });
}

// ── Helper: login en el portal ──
async function doLogin(ctx) {
  const page = await ctx.newPage();
  await page.goto('https://login.orohorizonsclub.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => { const m = document.getElementById('myModal'); if (m) m.style.display = 'flex'; });
  await page.waitForTimeout(1000);
  await page.fill('#myModal input[name="username"]', 'orothomas');
  await page.fill('#myModal input[type="password"]', 'OroHC213&');
  await page.click('#myModal button:has-text("Log in")');
  await page.waitForTimeout(8000);
  console.log('✅ Login OK:', page.url());
  await page.close();
}

// ══════════════════════════════════════════════════════
// ENDPOINT: /stream-hoteles — carga rápida de tarjetas
// SIN enriquecer — solo extrae lo básico de cada card
// ══════════════════════════════════════════════════════
app.get('/stream-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.query;
  if (!destino) { res.status(400).end(); return; }

  const ciudad = destino.split(',')[0].trim();
  console.log(`🚀 v16 STREAM: "${ciudad}"`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (tipo, data) => {
    try { res.write(`data: ${JSON.stringify({ tipo, ...data })}\n\n`); } catch(e) {}
  };

  let browser;
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    });

    emit('status', { msg: 'Iniciando sesión en Son Terra Club...' });
    await doLogin(ctx);
    emit('status', { msg: `Sesión activa. Buscando hoteles en ${ciudad}...` });

    // ── BUSCADOR ──
    const page = await ctx.newPage();
    await page.goto('https://portal.membergetaways.com/rsi/search', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);

    // ── DESTINO — con retry si falla el selector ──
    let inputFound = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await page.waitForSelector('.ant-select-selection-search-input', { timeout: 12000 });
        inputFound = true;
        break;
      } catch {
        console.log(`⚠️ Intento ${attempt+1}: selector no encontrado, recargando...`);
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(5000);
      }
    }
    if (!inputFound) {
      emit('error', { msg: 'No se pudo cargar el buscador. Intenta de nuevo.' });
      await browser.close();
      res.end(); return;
    }

    await page.click('.ant-select-selection-search-input');
    await page.waitForTimeout(500);
    await page.type('.ant-select-selection-search-input', ciudad, { delay: 180 });
    await page.waitForTimeout(3500);

    try {
      await page.waitForSelector('.ant-select-item-option', { timeout: 5000 });
      const opts = await page.$$('.ant-select-item-option');
      if (opts.length > 0) { await opts[0].click(); }
    } catch {
      await page.keyboard.press('ArrowDown');
      await page.waitForTimeout(200);
      await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(1500);

    // ── FECHAS ──
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
      } catch(e) { console.log('Fechas:', e.message); }
    }

    // ── CLICK BUSCAR ──
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const b = document.querySelector('.search-button');
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    emit('status', { msg: `Cargando resultados para ${ciudad}...` });
    await page.waitForTimeout(12000);

    // ── EXTRACCIÓN RÁPIDA (solo lo básico de cada tarjeta) ──
    const extraerLista = async () => {
      return page.evaluate(() => {
        const results = [];
        const visto = new Set();
        document.querySelectorAll('img').forEach(img => {
          const src = img.src || '';
          if (!src || src.length < 10) return;
          const lower = src.toLowerCase();
          const esReal = (lower.includes('travelapi') || lower.includes('expedia') || lower.includes('media')) && lower.match(/\.(jpg|jpeg|png|webp)/i);
          if (!esReal) return;

          let el = img.parentElement;
          for (let i = 0; i < 12; i++) {
            if (!el) break;
            const txt = el.innerText || '';
            if (!txt.match(/US\$\s*[\d]+/)) { el = el.parentElement; continue; }
            const nameEl = el.querySelector('h2,h3,h4,strong');
            if (!nameEl) { el = el.parentElement; continue; }
            const nombre = nameEl.textContent.trim();
            if (nombre.length < 4 || nombre.length > 150) { el = el.parentElement; continue; }
            if (/^(refundable|non-refund|select|compare|view map|internet|priceline|filter|sort|star rating|amenities|save)/i.test(nombre)) { el = el.parentElement; continue; }
            if (visto.has(nombre)) break;
            visto.add(nombre);

            const link = el.querySelector('a[href*="detail"],a[href*="hotel"],a[href*="property"],a')?.href || '';
            const precios = (txt.match(/US\$\s*[\d,]+\.?\d*/gi) || []).map(p => parseFloat(p.replace(/US\$\s*/i, '').replace(/,/g, ''))).filter(n => n > 0);
            const precioMin = precios.length ? Math.min(...precios) : 0;
            const ratingM = txt.match(/(\d\.\d{1,2})\s*\(/);
            const reviewM = txt.match(/\(?(\d[\d,]+)\s*reviews?\)?/i);
            const saveM = txt.match(/save\s*(\d+)%/i);
            const addrEl = el.querySelector('[class*="address"],[class*="location"]');
            const distM = txt.match(/([\d.]+\s*miles?\s*from[^,\n]+)/i);

            results.push({
              nombre,
              precio: precioMin ? `US$ ${Math.round(precioMin)}` : '',
              imagen: src,
              imagenes: [src],
              rating: ratingM ? ratingM[1] : '',
              reviews: reviewM ? reviewM[1] : '',
              ahorro: saveM ? `Save ${saveM[1]}%` : '',
              direccion: (addrEl?.textContent?.trim() || distM?.[0] || '').replace(/view map/gi,'').trim().substring(0, 150),
              enlace: link,
              descripcion: '',
              fuente: 'portal'
            });
            break;
          }
        });
        return results;
      });
    };

    // ── SCROLL Y ENVÍO ──
    const enviados = new Set();
    let total = 0;
    let scrollsVacios = 0;

    for (let round = 0; round < 25; round++) {
      const lista = await extraerLista();
      const nuevos = lista.filter(h => !enviados.has(h.nombre.toLowerCase()));

      if (nuevos.length === 0) {
        scrollsVacios++;
        if (scrollsVacios >= 3) break;
      } else {
        scrollsVacios = 0;
        for (const h of nuevos) {
          const key = h.nombre.toLowerCase();
          if (!enviados.has(key)) {
            enviados.add(key);
            emit('hotel', { hotel: h });
            total++;
          }
        }
        emit('status', { msg: `${total} hoteles encontrados en ${ciudad}...` });
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2800);
    }

    await browser.close();
    emit('fin', { total });
    console.log(`✅ Stream completo: ${total} hoteles`);

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ stream:', err.message);
    emit('error', { msg: 'Error al buscar hoteles. Por favor intenta de nuevo.' });
  }

  res.end();
});

// ══════════════════════════════════════════════════════
// ENDPOINT: /hotel-detail — SSE detalle completo
// Se llama cuando el usuario hace clic en un hotel
// ══════════════════════════════════════════════════════
app.get('/hotel-detail', async (req, res) => {
  const { enlace, checkin, checkout } = req.query;
  if (!enlace) { res.status(400).json({ error: 'no enlace' }); return; }

  // Calcular noches
  let noches = 1;
  if (checkin && checkout) {
    const d1 = new Date(checkin), d2 = new Date(checkout);
    const diff = Math.round((d2 - d1) / 86400000);
    if (diff > 0) noches = diff;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (tipo, data) => {
    try { res.write(`data: ${JSON.stringify({ tipo, ...data })}\n\n`); } catch(e) {}
  };

  let browser;
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    });

    emit('status', { msg: 'Iniciando sesión...' });
    await doLogin(ctx);
    emit('status', { msg: 'Cargando galería y detalles del hotel...' });

    // ── PÁGINA DE DETALLE ──
    const det = await ctx.newPage();
    await det.goto(enlace, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await det.waitForTimeout(4000);

    // Scroll para activar lazy loading de imágenes
    emit('status', { msg: 'Cargando fotos...' });
    for (const pos of [400, 900, 1600, 2400, 0]) {
      await det.evaluate(y => window.scrollTo(0, y), pos);
      await det.waitForTimeout(800);
    }

    // ── EXTRACCIÓN COMPLETA ──
    const data = await det.evaluate((nochesParm) => {
      const BAD = ['logo','icon-','amenity','chain','flag','placeholder','noimage',
                   'package-D','no-image','blank.','default.jpg','rsi/assets'];
      const esUrlBuena = (src) => {
        if (!src || src.length < 10) return false;
        const lower = src.toLowerCase();
        if (BAD.some(p => lower.includes(p))) return false;
        return (lower.includes('travelapi') || lower.includes('expedia') ||
                lower.includes('media') || lower.includes('hotelbeds') ||
                lower.includes('iceportal') || lower.includes('images.trvl')) &&
               lower.match(/\.(jpg|jpeg|png|webp)/i);
      };

      // ── FOTOS ──
      const fotos = [];
      const visto = new Set();

      // 1. Galerías específicas
      const galSels = [
        '[class*="gallery"] img','[class*="slider"] img','[class*="carousel"] img',
        '[class*="photo"] img','[class*="hero"] img','[class*="image-gallery"] img',
        '[class*="media"] img','[data-testid*="image"] img','[class*="room"] img'
      ];
      for (const sel of galSels) {
        document.querySelectorAll(sel).forEach(img => {
          const src = img.src || img.dataset.src || img.getAttribute('data-lazy') || img.getAttribute('data-original') || '';
          if (!esUrlBuena(src) || visto.has(src)) return;
          const w = img.naturalWidth || img.width || 0;
          if (w > 0 && w < 80) return;
          visto.add(src); fotos.push(src);
        });
      }
      // 2. srcset
      document.querySelectorAll('img[srcset],source[srcset]').forEach(el => {
        (el.srcset||'').split(',').map(s=>s.trim().split(' ')[0])
          .filter(s=>s.startsWith('http')).forEach(src => {
            if (esUrlBuena(src) && !visto.has(src)) { visto.add(src); fotos.push(src); }
          });
      });
      // 3. Todas las imágenes (fallback)
      document.querySelectorAll('img').forEach(img => {
        const src = img.src || img.dataset.src || img.getAttribute('data-lazy') || '';
        if (!esUrlBuena(src) || visto.has(src)) return;
        const w = img.naturalWidth || img.width || 0;
        if (w > 0 && w < 80) return;
        visto.add(src); fotos.push(src);
      });

      // ── NOMBRE ──
      const nombre = (document.querySelector('h1,h2')?.textContent||'').trim();

      // ── DIRECCIÓN ──
      let direccion = '';
      for (const s of ['[class*="address"]','[class*="location"]','[itemprop="address"]']) {
        const el = document.querySelector(s);
        if (el) { direccion = el.textContent.trim().replace(/view map/gi,'').trim(); break; }
      }

      // ── DESCRIPCIÓN ──
      let descripcion = '';
      const descSels = ['[class*="description"]','[class*="about"]','[class*="overview"]',
                        '[class*="detail"]>p','article p','main p'];
      for (const s of descSels) {
        for (const el of document.querySelectorAll(s)) {
          const t = (el.innerText||el.textContent||'').trim();
          if (t.length > 80 && t.length < 3000 && !t.match(/^\d/) && !t.includes('$')) {
            descripcion = t.substring(0, 1500); break;
          }
        }
        if (descripcion) break;
      }

      // ── AMENITIES ──
      const amenities = [];
      const amenVisto = new Set();
      const SKIP = /^(show more|show less|view map|reserve|book|check|select|filter|sort|price|per night|\$|US\$|refund|cancel|\d+ night|\d+ room)/i;
      for (const s of ['[class*="amenit"] li','[class*="amenit"] span','[class*="facilit"] li',
                       '[class*="feature"] li','[class*="perk"]','[data-testid*="amenity"]']) {
        for (const el of document.querySelectorAll(s)) {
          const t = (el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
          if (t.length < 3 || t.length > 120 || SKIP.test(t) || amenVisto.has(t.toLowerCase())) continue;
          amenVisto.add(t.toLowerCase()); amenities.push(t);
          if (amenities.length >= 20) break;
        }
        if (amenities.length >= 12) break;
      }

      // ── PRECIOS ──
      const txt = document.body.innerText || '';
      const precioMatches = (txt.match(/US\$\s*[\d,]+\.?\d*/gi)||[])
        .map(p => parseFloat(p.replace(/US\$\s*/i,'').replace(/,/g,'')))
        .filter(n => n > 10 && n < 99999);
      const precioNoche = precioMatches.length ? Math.min(...precioMatches) : 0;

      // ── RATING ──
      const ratingM = txt.match(/(\d\.\d{1,2})\s*\(/);
      const reviewM = txt.match(/\(?(\d[\d,]+)\s*reviews?\)?/i);
      const starM = txt.match(/(\d)\s*star/i);

      return {
        nombre, direccion, descripcion, amenities,
        fotos: fotos.slice(0, 10),
        precioNoche: precioNoche ? `US$ ${Math.round(precioNoche)}` : '',
        precioTotal: precioNoche ? `US$ ${Math.round(precioNoche * nochesParm)}` : '',
        noches: nochesParm,
        estrellas: starM?.[1]||'',
        rating: ratingM?.[1]||'',
        reviews: reviewM?.[1]||''
      };
    }, noches);

    await det.close();
    await browser.close();

    const fotosLimpias = data.fotos.filter(s => isGoodImg(s));
    console.log(`✅ Detail: "${data.nombre}" | ${fotosLimpias.length} fotos | ${data.amenities.length} amenities | ${noches} noches`);

    emit('detalle', {
      nombre: data.nombre,
      direccion: data.direccion,
      descripcion: data.descripcion,
      amenities: data.amenities,
      imagenes: fotosLimpias,
      precioNoche: data.precioNoche,
      precioTotal: data.precioTotal,
      noches: data.noches,
      estrellas: data.estrellas,
      rating: data.rating,
      reviews: data.reviews
    });
    emit('fin', {});

  } catch(err) {
    if (browser) await browser.close().catch(()=>{});
    console.error('❌ detail:', err.message);
    emit('error', { msg: err.message });
  }
  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🤖 v16 puerto ${PORT}`));
