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

            // Precio: selector exacto del portal membergetaways
            let precioFinal = 0;
            // 1. Selector EXACTO del portal (clase hotel-card-wrapper__price-total-text)
            const pExact = el.querySelector('.hotel-card-wrapper__price-total-text');
            if (pExact) {
              const pM = (pExact.textContent||'').match(/([\d,]+\.?\d+)/);
              if (pM) { const v=parseFloat(pM[1].replace(/,/g,'')); if(v>5) precioFinal=v; }
            }
            // 2. Selectores alternativos por si cambia la clase
            if (!precioFinal) {
              const altSels = [
                '[class*="price-total-text"]',
                '[class*="price-total"] p',
                '[class*="price-total"] span',
                '[class*="total-price"]',
                '[class*="price-per-night"]',
                '[class*="nightly-rate"]'
              ];
              for (const ps of altSels) {
                const pEl = el.querySelector(ps);
                if (pEl) {
                  const pM = (pEl.textContent||'').match(/([\d,]+\.?\d+)/);
                  if (pM) { const v=parseFloat(pM[1].replace(/,/g,'')); if(v>5){precioFinal=v;break;} }
                }
              }
            }
            // 3. Fallback: texto completo filtrando < $5 y "Savings" context
            if (!precioFinal) {
              // Excluir líneas que contengan "savings" o "public" o "save"
              const txtLines = txt.split('\n').filter(l => 
                !/savings|public rate|save \d+|client cash/i.test(l)
              ).join(' ');
              const allP = (txtLines.match(/US\$\s*[\d,]+\.?\d*/gi)||[])
                .map(p=>parseFloat(p.replace(/US\$\s*/i,'').replace(/,/g,'')))
                .filter(n=>n>5&&n<99999);
              if (allP.length) precioFinal = Math.min(...allP);
            }


            const ratingM = txt.match(/(\d\.\d{1,2})\s*\(/);
            const reviewM = txt.match(/\(?(\d[\d,]+)\s*reviews?\)?/i);
            const saveM = txt.match(/save\s*(\d+)%/i);
            const addrEl = el.querySelector('[class*="address"],[class*="location"]');
            const distM = txt.match(/([\d.]+\s*miles?\s*from[^,\n]+)/i);

            results.push({
              nombre,
              precio: precioFinal ? `US$ ${Math.round(precioFinal)}` : '',
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
    emit('status', { msg: 'Abriendo página del hotel...' });

    // ── PÁGINA DE DETALLE ──
    const det = await ctx.newPage();
    await det.goto(enlace, { waitUntil: 'networkidle', timeout: 35000 });
    await det.waitForTimeout(5000);

    emit('status', { msg: 'Cargando fotos del hotel...' });

    // Intentar abrir la galería haciendo clic en la imagen principal
    try {
      // Clic en la imagen hero/principal para abrir galería
      const heroSelectors = [
        '[class*="gallery"] img', '[class*="hero"] img', '[class*="slider"] img',
        '[class*="main-image"] img', '[class*="property-image"] img',
        '.image-gallery img', '[class*="photo"] img:first-child'
      ];
      for (const sel of heroSelectors) {
        const el = await det.$(sel);
        if (el) { await el.click(); await det.waitForTimeout(2000); break; }
      }
    } catch(e) { console.log('Gallery click:', e.message.substring(0,50)); }

    // Scroll agresivo para activar lazy loading
    for (const pos of [300, 700, 1200, 1800, 2500, 3200, 0]) {
      await det.evaluate(y => window.scrollTo(0, y), pos);
      await det.waitForTimeout(600);
    }
    // Volver arriba y esperar que carguen
    await det.waitForTimeout(2000);

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

      // ── FOTOS — extracción agresiva para portal membergetaways ──
      const fotos = [];
      const visto = new Set();

      const addSrc = (src) => {
        if (!src || src.length < 12) return;
        // Limpiar query strings de tamaño para obtener mayor resolución
        const cleanSrc = src.split('?')[0].includes('.') ? src : src;
        if (esUrlBuena(cleanSrc) && !visto.has(cleanSrc)) {
          visto.add(cleanSrc); fotos.push(cleanSrc);
        }
      };

      // 1. Todas las imágenes del DOM con todos los atributos posibles
      document.querySelectorAll('img').forEach(img => {
        const attrs = ['src','data-src','data-lazy','data-original','data-image',
                       'data-full','data-large','data-zoom-image','data-highres'];
        for (const a of attrs) {
          const s = img.getAttribute(a) || '';
          if (s.startsWith('http')) addSrc(s);
        }
        // naturalSrc si está disponible
        if (img.currentSrc) addSrc(img.currentSrc);
      });

      // 2. srcset — preferir la versión más grande
      document.querySelectorAll('img[srcset],source[srcset]').forEach(el => {
        const parts = (el.srcset||'').split(',').map(s => {
          const [url, w] = s.trim().split(' ');
          return { url, w: parseInt(w)||0 };
        }).filter(p => p.url && p.url.startsWith('http'));
        // Ordenar por ancho descendente para tener mayor resolución
        parts.sort((a,b) => b.w - a.w);
        parts.forEach(p => addSrc(p.url));
      });

      // 3. Background images en CSS (algunos portales las usan)
      document.querySelectorAll('[style*="background"]').forEach(el => {
        const m = (el.getAttribute('style')||'').match(/url\(['"]?(https?[^'")\s]+)['"]?\)/i);
        if (m) addSrc(m[1]);
      });

      // 4. Buscar URLs de imágenes en atributos data-* de contenedores
      document.querySelectorAll('[data-images],[data-photos],[data-gallery]').forEach(el => {
        try {
          const val = el.getAttribute('data-images') || el.getAttribute('data-photos') || el.getAttribute('data-gallery') || '';
          const urls = val.match(/https?:\/\/[^\s"',\]]+\.(jpg|jpeg|png|webp)/gi) || [];
          urls.forEach(u => addSrc(u));
        } catch(e) {}
      });

      // 5. Buscar en scripts inline (algunos SPA guardan las imágenes en JSON)
      document.querySelectorAll('script:not([src])').forEach(sc => {
        const txt = sc.textContent || '';
        if (!txt.includes('travelapi') && !txt.includes('expedia') && !txt.includes('media')) return;
        const urls = (txt.match(/https?:\/\/\S+\.(?:jpg|jpeg|png|webp)/gi) || []);
        urls.slice(0, 20).forEach(u => addSrc(u));
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

      // ── PRECIOS — selector exacto del portal membergetaways ──
      const txt = document.body.innerText || '';
      let precioNoche = 0;

      // 1. Selector EXACTO de la página de detalle del portal
      //    En la página de detalle el precio total está en hotel-card-wrapper__price-total-text
      //    o en selectores similares de la página de detalle
      const detailPriceSels = [
        '.hotel-card-wrapper__price-total-text',
        '[class*="price-total-text"]',
        '[class*="price-total"] p',
        '[class*="room-price"] [class*="amount"]',
        '[class*="room-rate"] [class*="price"]',
        '[class*="total-price-value"]',
        '[class*="price-per-night"]',
        '[class*="nightly-rate"]',
        '[class*="from-price"]'
      ];
      for (const ps of detailPriceSels) {
        const pEl = document.querySelector(ps);
        if (pEl) {
          const pM = (pEl.textContent||'').match(/([\d,]+\.?\d+)/);
          if (pM) { const v=parseFloat(pM[1].replace(/,/g,'')); if(v>5){precioNoche=v;break;} }
        }
      }

      // 2. Patrón textual "From US$XX per night" o "US$XX per night"
      if (!precioNoche) {
        const fromM = txt.match(/[Ff]rom[\s\n]*US\$\s*([\d,]+\.?\d*)\s*[\n]*per night/);
        if (fromM) { const v=parseFloat(fromM[1].replace(/,/g,'')); if(v>5) precioNoche=v; }
      }

      // 3. Fallback: texto filtrando contextos de "savings/public/save"
      if (!precioNoche) {
        const txtClean = txt.split('\n')
          .filter(l => !/savings|public rate|save \d+%|client cash|you save/i.test(l))
          .join(' ');
        const allP = (txtClean.match(/US\$\s*[\d,]+\.?\d*/gi)||[])
          .map(p=>parseFloat(p.replace(/US\$\s*/i,'').replace(/,/g,'')))
          .filter(n=>n>5&&n<99999);
        if (allP.length) precioNoche = Math.min(...allP);
      }


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
