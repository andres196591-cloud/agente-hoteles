const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => res.json({ ok: true, v: 18 }));

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
  console.log(`🚀 v18 STREAM: "${ciudad}"`);

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
// Estrategia: navegar al URL del hotel, esperar slick
// carousel, scroll agresivo, extraer hasta 15 fotos
// ══════════════════════════════════════════════════════
app.get('/hotel-detail', async (req, res) => {
  const { enlace, checkin, checkout } = req.query;
  if (!enlace) { res.status(400).json({ error: 'no enlace' }); return; }

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

    emit('status', { msg: 'Iniciando sesión en el portal...' });
    await doLogin(ctx);
    emit('status', { msg: 'Abriendo ficha del hotel...' });

    const det = await ctx.newPage();

    // Interceptar requests de imágenes para no bloquearlas
    await det.route('**/*.{woff,woff2,ttf,otf}', route => route.abort());

    // Navegar al URL exacto del hotel
    await det.goto(enlace, { waitUntil: 'domcontentloaded', timeout: 40000 });
    emit('status', { msg: 'Página cargada, esperando galería...' });

    // ── PASO 1: Esperar que la página SPA termine de renderizar ──
    await det.waitForTimeout(4000);

    // ── PASO 2: Esperar el carrusel slick ──
    try {
      await det.waitForSelector('.slick-slider, .hotel-images__image, .hotel-images__main-image-wrapper', {
        timeout: 12000
      });
      console.log('✅ Galería detectada');
    } catch(e) {
      console.log('⚠️ Galería no detectada, continuando igual...');
    }

    emit('status', { msg: 'Activando carrusel de fotos...' });

    // ── PASO 3: Scroll agresivo para activar lazy loading ──
    // Primero hacia abajo para cargar todo
    for (const pos of [200, 600, 1200, 1800, 2600, 3400, 1000, 0]) {
      await det.evaluate(y => window.scrollTo(0, y), pos);
      await det.waitForTimeout(500);
    }
    await det.waitForTimeout(1500);

    // ── PASO 4: Activar el carrusel de imágenes ──
    // Hacer clic en la imagen principal para abrir el carrusel completo
    try {
      const clicked = await det.evaluate(() => {
        // Intentar clic en imagen principal del hotel
        const targets = [
          '.hotel-images__main-image-wrapper',
          '.hotel-images__image',
          '.slick-slide:not(.slick-cloned) img',
          '[class*="hotel-images"] img'
        ];
        for (const sel of targets) {
          const el = document.querySelector(sel);
          if (el) {
            el.click();
            return sel;
          }
        }
        return null;
      });
      if (clicked) {
        console.log('✅ Click en galería:', clicked);
        await det.waitForTimeout(2000);
      }
    } catch(e) { console.log('Gallery click err:', e.message.substring(0,60)); }

    // ── PASO 5: Navegar el carrusel con teclas para forzar carga ──
    // Esto activa el lazy loading de cada slide
    try {
      // Esperar que aparezca el slick track
      await det.waitForSelector('.slick-track, .slick-list', { timeout: 5000 });

      // Presionar flechas para avanzar slides y forzar carga de imágenes
      for (let i = 0; i < 8; i++) {
        await det.keyboard.press('ArrowRight');
        await det.waitForTimeout(400);
      }
      // Regresar al inicio
      for (let i = 0; i < 8; i++) {
        await det.keyboard.press('ArrowLeft');
        await det.waitForTimeout(200);
      }
      await det.waitForTimeout(1000);
      console.log('✅ Carrusel navegado con teclas');
    } catch(e) { console.log('Carousel nav:', e.message.substring(0,60)); }

    // ── PASO 6: Scroll dentro del contenedor del carrusel ──
    try {
      await det.evaluate(() => {
        const track = document.querySelector('.slick-track');
        if (track) {
          // Forzar que todas las imágenes lazy sean visibles
          document.querySelectorAll('.slick-slide img[data-lazy], .slick-slide img[data-src]').forEach(img => {
            const src = img.getAttribute('data-lazy') || img.getAttribute('data-src');
            if (src) img.src = src;
          });
        }
        // También forzar IntersectionObserver en todas las imágenes
        document.querySelectorAll('img[data-src], img[data-lazy]').forEach(img => {
          const src = img.getAttribute('data-src') || img.getAttribute('data-lazy');
          if (src && src.startsWith('http')) img.src = src;
        });
      });
      await det.waitForTimeout(2000);
      console.log('✅ Lazy loading forzado');
    } catch(e) {}

    emit('status', { msg: 'Extrayendo información del hotel...' });

    // ── PASO 7: EXTRACCIÓN COMPLETA ──
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

      const fotos = [];
      const visto = new Set();
      const addSrc = (src) => {
        if (!src || src.length < 12) return;
        // Normalizar URL (quitar params de tamaño para versión limpia)
        const clean = src.replace(/[?&](width|height|w|h|size|resize|crop)=[^&]*/gi,'').replace(/\?$/,'');
        const key = clean.split('?')[0]; // deduplicar por path base
        if (esUrlBuena(src) && !visto.has(key)) {
          visto.add(key);
          fotos.push(src); // guardar URL original con calidad
        }
      };

      // ── CAPA 1A: Imagen principal del portal ──
      document.querySelectorAll('.hotel-images__main-image-wrapper img')
        .forEach(img => {
          addSrc(img.src);
          addSrc(img.getAttribute('data-src') || '');
          addSrc(img.getAttribute('data-lazy') || '');
        });

      // ── CAPA 1B: Thumbnails estáticos ──
      document.querySelectorAll('.hotel-images__other-image-wrapper img')
        .forEach(img => {
          addSrc(img.src);
          addSrc(img.getAttribute('data-src') || '');
        });

      // ── CAPA 1C: Carrusel slick — slides reales (excluir clones) ──
      document.querySelectorAll('.slick-slide:not(.slick-cloned) img')
        .forEach(img => {
          // Prioridad: src actual, luego data-lazy, data-src, data-original
          const srcs = [
            img.src,
            img.getAttribute('data-lazy'),
            img.getAttribute('data-src'),
            img.getAttribute('data-original'),
            img.getAttribute('data-image'),
          ].filter(Boolean);
          srcs.forEach(s => addSrc(s));
        });

      // ── CAPA 1D: Clase específica custom-carousel-image__item ──
      document.querySelectorAll('img.custom-carousel-image__item')
        .forEach(img => {
          addSrc(img.src);
          addSrc(img.getAttribute('data-lazy') || '');
          addSrc(img.getAttribute('data-src') || '');
        });

      // ── CAPA 2: Cualquier img.hotel-images__image ──
      document.querySelectorAll('img.hotel-images__image')
        .forEach(img => { addSrc(img.src); addSrc(img.getAttribute('data-src')||''); });

      // ── CAPA 3: Todos los imgs si aún tenemos pocas fotos ──
      if (fotos.length < 4) {
        document.querySelectorAll('img').forEach(img => {
          const attrs = ['src','data-src','data-lazy','data-original','data-image','data-full'];
          attrs.forEach(a => { const s = img.getAttribute(a)||''; if (s.startsWith('http')) addSrc(s); });
          if (img.currentSrc) addSrc(img.currentSrc);
        });
      }

      // ── CAPA 4: srcset como último recurso ──
      if (fotos.length < 4) {
        document.querySelectorAll('img[srcset]').forEach(img => {
          const parts = (img.srcset||'').split(',').map(s => {
            const t = s.trim().split(' ');
            return { url: t[0], w: parseInt(t[1])||0 };
          }).filter(p => p.url?.startsWith('http'));
          parts.sort((a,b) => b.w - a.w);
          parts.forEach(p => addSrc(p.url));
        });
      }

      // ── NOMBRE ──
      const nombre = (
        document.querySelector('.hotel-info__title')?.textContent ||
        document.querySelector('h1')?.textContent ||
        document.querySelector('h2')?.textContent || ''
      ).trim();

      // ── DIRECCIÓN ──
      const direccion = (
        document.querySelector('.hotel-info__address')?.textContent ||
        document.querySelector('[class*="address"]')?.textContent || ''
      ).trim().replace(/view map/gi,'').trim();

      // ── DESCRIPCIÓN ──
      let descripcion = '';
      const descEl = document.querySelector('.hotel-images__hotel-text');
      if (descEl) {
        const inner = descEl.querySelector('p,div') || descEl;
        descripcion = (inner.innerText || inner.textContent || '').trim().substring(0, 1500);
      }
      if (!descripcion || descripcion.length < 50) {
        for (const s of ['[class*="description"]','[class*="about"]','[class*="overview"]']) {
          for (const el of document.querySelectorAll(s)) {
            const t = (el.innerText||el.textContent||'').trim();
            if (t.length > 80 && t.length < 3000 && !t.includes('$')) {
              descripcion = t.substring(0, 1500); break;
            }
          }
          if (descripcion.length > 50) break;
        }
      }

      // ── AMENIDADES ──
      const amenities = [];
      const amenVisto = new Set();
      const SKIP = /^(show more|show less|view map|reserve|book|check|select|filter|sort|price|per night|\$|US\$|refund|cancel|\d+ night|\d+ room)/i;

      document.querySelectorAll('.amenities__amenities-list .ant-list-item span')
        .forEach(el => {
          const t = (el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
          if (t.length < 3 || t.length > 120 || SKIP.test(t) || amenVisto.has(t.toLowerCase())) return;
          amenVisto.add(t.toLowerCase()); amenities.push(t);
        });

      if (amenities.length < 3) {
        for (const s of ['[class*="amenit"] li','[class*="amenit"] span','[class*="facilit"] li']) {
          for (const el of document.querySelectorAll(s)) {
            const t = (el.innerText||el.textContent||'').trim().replace(/\s+/g,' ');
            if (t.length < 3 || t.length > 120 || SKIP.test(t) || amenVisto.has(t.toLowerCase())) continue;
            amenVisto.add(t.toLowerCase()); amenities.push(t);
            if (amenities.length >= 20) break;
          }
          if (amenities.length >= 8) break;
        }
      }

      // ── PRECIO ──
      const txt = document.body.innerText || '';
      let precioNoche = 0;

      // 1. Selector exacto
      const allPriceEls = document.querySelectorAll('.hotel-card-wrapper__price-total-text');
      for (const pEl of allPriceEls) {
        const pM = (pEl.textContent||'').match(/([\d,]+\.?\d+)/);
        if (pM) { const v=parseFloat(pM[1].replace(/,/g,'')); if(v>5){precioNoche=v;break;} }
      }

      // 2. Alternativas
      if (!precioNoche) {
        for (const ps of ['[class*="price-total-text"]','[class*="price-total"] p','[class*="price-per-night"]']) {
          const el = document.querySelector(ps);
          if (el) {
            const m=(el.textContent||'').match(/([\d,]+\.?\d+)/);
            if (m){const v=parseFloat(m[1].replace(/,/g,''));if(v>5){precioNoche=v;break;}}
          }
        }
      }

      // 3. Patrón "From US$XX per night"
      if (!precioNoche) {
        const fromM = txt.match(/[Ff]rom[\s\n]*US\$\s*([\d,]+\.?\d*)/);
        if (fromM) { const v=parseFloat(fromM[1].replace(/,/g,'')); if(v>5) precioNoche=v; }
      }

      // 4. Fallback filtrado
      if (!precioNoche) {
        const limpio = txt.split('\n')
          .filter(l => !/savings|public rate|save \d+%|client cash|you save/i.test(l))
          .join(' ');
        const todos = (limpio.match(/US\$\s*[\d,]+\.?\d*/gi)||[])
          .map(p=>parseFloat(p.replace(/US\$\s*/i,'').replace(/,/g,'')))
          .filter(n=>n>5&&n<99999);
        if (todos.length) precioNoche = Math.min(...todos);
      }

      // ── PARA INFO NOCHES DEL PORTAL ──
      // Buscar el texto "for X nights" que el portal mismo muestra
      const forNightsM = txt.match(/for\s+(\d+)\s+nights?/i);
      const portalNoches = forNightsM ? parseInt(forNightsM[1]) : nochesParm;

      // ── RATING ──
      const ratingEl = document.querySelector('.guest-ratings__reviews-rating');
      const ratingTxt = ratingEl?.textContent || '';
      const ratingM = ratingTxt.match(/(\d\.\d)/) || txt.match(/(\d\.\d{1,2})\s*\//);
      const reviewM = txt.match(/\(?[Bb]ased on\s+([\d,]+)|([\d,]+)\s+reviews?/i);
      const nStars = document.querySelectorAll('.hotel-info__star').length;
      const starM = nStars > 0 ? nStars.toString() : (txt.match(/(\d)\s*star/i)?.[1] || '');

      return {
        nombre, direccion, descripcion,
        amenities: amenities.slice(0, 20),
        fotos: fotos.slice(0, 15),  // hasta 15 fotos
        precioNoche: precioNoche ? `US$ ${precioNoche.toFixed(2)}` : '',
        precioTotal: precioNoche ? `US$ ${(precioNoche * portalNoches).toFixed(2)}` : '',
        noches: portalNoches,
        estrellas: starM,
        rating: ratingM?.[1] || '',
        reviews: (reviewM?.[1] || reviewM?.[2] || '').replace(/,/g,''),
        debugFotos: fotos.length  // para debug en logs
      };
    }, noches);

    await det.close();
    await browser.close();

    const fotosLimpias = data.fotos.filter(s => isGoodImg(s));
    console.log(`✅ Detail v18: "${data.nombre}" | fotos DOM: ${data.debugFotos} | limpias: ${fotosLimpias.length} | amenities: ${data.amenities.length} | precio: ${data.precioNoche} | noches: ${data.noches}`);

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
    console.error('❌ detail v18:', err.message);
    emit('error', { msg: err.message });
  }
  res.end();
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🤖 v18 puerto ${PORT}`));
