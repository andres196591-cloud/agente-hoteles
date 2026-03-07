const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => res.json({ ok: true, v: 15 }));

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

// ── SSE STREAMING ──
app.get('/stream-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.query;
  if (!destino) { res.status(400).end(); return; }

  const ciudad = destino.split(',')[0].trim();
  console.log(`🚀 v15 STREAM: "${ciudad}"`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const emit = (tipo, data) => {
    try { res.write(`data: ${JSON.stringify({ tipo, ...data })}\n\n`); } catch(e) {}
  };

  emit('status', { msg: `Conectando al portal de Son Terra Club...` });

  let browser;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-gpu','--single-process','--no-zygote']
    });

    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    });
    const page = await ctx.newPage();

    // ── LOGIN ──
    emit('status', { msg: 'Iniciando sesión...' });
    await page.goto('https://login.orohorizonsclub.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { const m = document.getElementById('myModal'); if (m) m.style.display = 'flex'; });
    await page.waitForTimeout(1000);
    await page.fill('#myModal input[name="username"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'OroHC213&');
    await page.click('#myModal button:has-text("Log in")');
    await page.waitForTimeout(8000);
    console.log('✅ Login OK:', page.url());
    emit('status', { msg: 'Sesión activa. Buscando hoteles en ' + ciudad + '...' });

    // ── BUSCADOR ──
    await page.goto('https://portal.membergetaways.com/rsi/search', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // ── DESTINO ──
    await page.waitForSelector('.ant-select-selection-search-input', { timeout: 10000 });
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

    // ── SCROLL + EXTRACCIÓN ──
    const enviados = new Set();
    let total = 0;
    let scrollsVacios = 0;

    // Función: extraer lista de hoteles de la página de resultados
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
            const reviewM = txt.match(/\(?([\d,]+)\s*reviews?\)?/i);
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

    // ── FUNCIÓN: entrar al hotel y extraer fotos reales + descripción + amenities ──
    const enrichHotel = async (hotel) => {
      if (!hotel.enlace || !hotel.enlace.startsWith('http')) return hotel;
      const detailPage = await ctx.newPage();
      try {
        await detailPage.goto(hotel.enlace, { waitUntil: 'domcontentloaded', timeout: 18000 });
        await detailPage.waitForTimeout(4000);

        // Intentar hacer scroll para cargar imágenes lazy
        await detailPage.evaluate(() => window.scrollTo(0, 600));
        await detailPage.waitForTimeout(1500);
        await detailPage.evaluate(() => window.scrollTo(0, 1200));
        await detailPage.waitForTimeout(1000);
        await detailPage.evaluate(() => window.scrollTo(0, 0));
        await detailPage.waitForTimeout(500);

        const data = await detailPage.evaluate(() => {
          const fotos = [];
          const vistasImg = new Set();
          const BAD = ['logo','icon-','amenity','chain','flag','placeholder','noimage','package-D','no-image','blank.','default.jpg'];

          const esUrlBuena = (src) => {
            if (!src || src.length < 10) return false;
            const lower = src.toLowerCase();
            if (BAD.some(p => lower.includes(p))) return false;
            return (lower.includes('travelapi') || lower.includes('expedia') || lower.includes('media') || lower.includes('hotelbeds') || lower.includes('iceportal')) && lower.match(/\.(jpg|jpeg|png|webp)/i);
          };

          // 1. Buscar en galería/slider primero (prioridad)
          const galSelectors = [
            '[class*="gallery"] img', '[class*="slider"] img', '[class*="carousel"] img',
            '[class*="photo"] img', '[class*="image-gallery"] img', '[class*="hero"] img',
            '[class*="media"] img', '[data-testid*="image"] img'
          ];
          for (const sel of galSelectors) {
            document.querySelectorAll(sel).forEach(img => {
              const src = img.src || img.dataset.src || img.getAttribute('data-lazy') || img.getAttribute('data-original') || '';
              if (esUrlBuena(src) && !vistasImg.has(src)) {
                const w = img.naturalWidth || img.width || 0;
                if (w > 0 && w < 80) return;
                vistasImg.add(src); fotos.push(src);
              }
            });
          }

          // 2. Buscar en srcset (versiones de alta resolución)
          document.querySelectorAll('img[srcset],source[srcset]').forEach(el => {
            const srcset = el.srcset || '';
            const srcs = srcset.split(',').map(s => s.trim().split(' ')[0]).filter(s => s && s.startsWith('http'));
            for (const src of srcs) {
              if (esUrlBuena(src) && !vistasImg.has(src)) { vistasImg.add(src); fotos.push(src); }
            }
          });

          // 3. Todas las imágenes del DOM (fallback)
          document.querySelectorAll('img').forEach(img => {
            const src = img.src || img.dataset.src || img.getAttribute('data-lazy') || img.getAttribute('data-original') || '';
            if (!esUrlBuena(src) || vistasImg.has(src)) return;
            const w = img.naturalWidth || img.width || 0;
            if (w > 0 && w < 80) return;
            vistasImg.add(src); fotos.push(src);
          });

          // Limitar a 10 fotos únicas de calidad
          const fotosFinales = fotos.slice(0, 10);

          // ── DESCRIPCIÓN completa ──
          let descripcion = '';
          const posibleDesc = [
            '[class*="description"]', '[class*="about"]', '[class*="overview"]',
            '[class*="detail"]>p', '[class*="content"]>p', 'article p',
            '.property-description', '[data-testid*="description"]', 'main p'
          ];
          for (const sel of posibleDesc) {
            const els = Array.from(document.querySelectorAll(sel));
            for (const el of els) {
              const txt = (el.innerText || el.textContent || '').trim();
              if (txt.length > 80 && txt.length < 3000 && !txt.match(/^\d/) && !txt.includes('$')) {
                descripcion = txt.substring(0, 1200);
                break;
              }
            }
            if (descripcion) break;
          }

          // ── AMENITIES ──
          const amenities = [];
          const amenSels = [
            '[class*="amenit"] li', '[class*="amenit"] span', '[class*="amenit"] div',
            '[class*="facilit"] li', '[class*="facilit"] span',
            '[class*="feature"] li', '[class*="feature"] span',
            '[data-testid*="amenity"]', '[class*="perk"]',
            'ul li' // fallback general
          ];
          const amenVisto = new Set();
          const SKIP_AMENITY = /^(show more|show less|view map|reserve|book|check|select|filter|sort|price|per night|\$|US\$|refund|cancel|free cancel|\d+ night|\d+ room)/i;
          for (const sel of amenSels) {
            const els = Array.from(document.querySelectorAll(sel));
            for (const el of els) {
              const txt = (el.innerText || el.textContent || '').trim().replace(/\s+/g,' ');
              if (txt.length < 3 || txt.length > 120) continue;
              if (SKIP_AMENITY.test(txt)) continue;
              if (amenVisto.has(txt.toLowerCase())) continue;
              amenVisto.add(txt.toLowerCase());
              amenities.push(txt);
              if (amenities.length >= 20) break;
            }
            if (amenities.length >= 12) break;
          }

          // Nombre del hotel en la página de detalle
          const nombreEl = document.querySelector('h1,h2');
          const nombreDetalle = nombreEl ? nombreEl.textContent.trim() : '';

          // Dirección más completa
          const addrEl = document.querySelector('[class*="address"],[class*="location"],[itemprop="address"]');
          const direccionDetalle = addrEl ? addrEl.textContent.trim().replace(/view map/gi,'').trim() : '';

          return { fotos: fotosFinales, descripcion, nombreDetalle, direccionDetalle, amenities };
        });

        const fotosReales = data.fotos.filter(s => isGoodImg(s));
        if (fotosReales.length > 0) {
          hotel.imagen = fotosReales[0];
          hotel.imagenes = fotosReales;
        }
        if (data.descripcion) hotel.descripcion = data.descripcion;
        if (data.amenities && data.amenities.length > 0) hotel.amenities = data.amenities;
        if (data.direccionDetalle && data.direccionDetalle.length > hotel.direccion.length) {
          hotel.direccion = data.direccionDetalle.substring(0, 150);
        }
        console.log(`  📸 ${hotel.nombre}: ${fotosReales.length} fotos, ${(data.amenities||[]).length} amenities, desc: ${data.descripcion.length} chars`);
      } catch(e) {
        console.log(`  ⚠️ Detail error ${hotel.nombre}: ${e.message.substring(0,60)}`);
      } finally {
        await detailPage.close().catch(() => {});
      }
      return hotel;
    };

    // ── SCROLL Y PROCESO ──
    for (let round = 0; round < 25; round++) {
      const lista = await extraerLista();
      const nuevos = lista.filter(h => !enviados.has(h.nombre.toLowerCase()));

      if (nuevos.length === 0) {
        scrollsVacios++;
        if (scrollsVacios >= 3) break;
      } else {
        scrollsVacios = 0;
        // Enriquecer con fotos/descripción en paralelo (máx 3 a la vez)
        const chunks = [];
        for (let i = 0; i < nuevos.length; i += 3) chunks.push(nuevos.slice(i, i + 3));

        for (const chunk of chunks) {
          const enriquecidos = await Promise.all(chunk.map(h => enrichHotel(h)));
          for (const h of enriquecidos) {
            const key = h.nombre.toLowerCase();
            if (!enviados.has(key)) {
              enviados.add(key);
              emit('hotel', { hotel: h });
              total++;
            }
          }
          emit('status', { msg: `${total} hoteles encontrados en ${ciudad}...` });
        }
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2800);
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

// ══════════════════════════════════════════════════════
// ENDPOINT: /hotel-detail  — SSE en tiempo real
// Entra al hotel y transmite fotos + info completa
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
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-gpu','--single-process','--no-zygote']
    });
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
    });

    emit('status', { msg: 'Iniciando sesión...' });

    // ── LOGIN ──
    const page = await ctx.newPage();
    await page.goto('https://login.orohorizonsclub.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    await page.evaluate(() => { const m = document.getElementById('myModal'); if (m) m.style.display = 'flex'; });
    await page.waitForTimeout(1000);
    await page.fill('#myModal input[name="username"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'OroHC213&');
    await page.click('#myModal button:has-text("Log in")');
    await page.waitForTimeout(8000);
    await page.close();

    emit('status', { msg: 'Cargando información del hotel...' });

    // ── PÁGINA DE DETALLE ──
    const det = await ctx.newPage();
    await det.goto(enlace, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await det.waitForTimeout(3500);

    // Scroll para cargar imágenes lazy
    emit('status', { msg: 'Cargando galería de fotos...' });
    await det.evaluate(() => window.scrollTo(0, 500));
    await det.waitForTimeout(1200);
    await det.evaluate(() => window.scrollTo(0, 1200));
    await det.waitForTimeout(1000);
    await det.evaluate(() => window.scrollTo(0, 2000));
    await det.waitForTimeout(800);
    await det.evaluate(() => window.scrollTo(0, 0));
    await det.waitForTimeout(600);

    // ── EXTRACCIÓN COMPLETA ──
    const data = await det.evaluate((nochesParm) => {
      const BAD = ['logo','icon-','amenity','chain','flag','placeholder','noimage','package-D','no-image','blank.','default.jpg','rsi/assets'];
      const esUrlBuena = (src) => {
        if (!src || src.length < 10) return false;
        const lower = src.toLowerCase();
        if (BAD.some(p => lower.includes(p))) return false;
        return (lower.includes('travelapi') || lower.includes('expedia') || lower.includes('media') ||
                lower.includes('hotelbeds') || lower.includes('iceportal')) && lower.match(/\.(jpg|jpeg|png|webp)/i);
      };

      // ── FOTOS: buscar primero en galerías ──
      const fotos = [];
      const visto = new Set();
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
      // srcset
      document.querySelectorAll('img[srcset],source[srcset]').forEach(el => {
        (el.srcset||'').split(',').map(s=>s.trim().split(' ')[0]).filter(s=>s.startsWith('http')).forEach(src => {
          if (esUrlBuena(src) && !visto.has(src)) { visto.add(src); fotos.push(src); }
        });
      });
      // fallback todas
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
      const addrSels = ['[class*="address"]','[class*="location"]','[itemprop="address"]','[class*="addr"]'];
      let direccion = '';
      for (const s of addrSels) {
        const el = document.querySelector(s);
        if (el) { direccion = el.textContent.trim().replace(/view map/gi,'').trim(); break; }
      }

      // ── DESCRIPCIÓN ──
      let descripcion = '';
      const descSels = ['[class*="description"]','[class*="about"]','[class*="overview"]','[class*="detail"]>p','article p','main p','[class*="content"]>p'];
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
      const SKIP = /^(show more|show less|view map|reserve|book|check|select|filter|sort|price|per night|\$|US\$|refund|cancel|\d+ night|\d+ room|free cancel)/i;
      const amenSels = ['[class*="amenit"] li','[class*="amenit"] span','[class*="facilit"] li','[class*="facilit"] span','[class*="feature"] li','[class*="perk"]','[data-testid*="amenity"]'];
      for (const s of amenSels) {
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
      const precioTotal = precioNoche * nochesParm;

      // ── ESTRELLAS ──
      let estrellas = '';
      const starM = txt.match(/(\d)\s*star/i) || (document.querySelector('[class*="star"],[class*="rating"]')?.textContent||'').match(/(\d)/);
      if (starM) estrellas = starM[1];

      // ── RATING ──
      const ratingM = txt.match(/(\d\.\d{1,2})\s*\(/);
      const reviewM = txt.match(/\(?(\d[\d,]+)\s*reviews?\)?/i);

      return {
        nombre, direccion, descripcion, amenities,
        fotos: fotos.slice(0, 10),
        precioNoche: precioNoche ? `US$ ${Math.round(precioNoche)}` : '',
        precioTotal: precioTotal ? `US$ ${Math.round(precioTotal)}` : '',
        noches: nochesParm,
        estrellas, rating: ratingM?.[1]||'', reviews: reviewM?.[1]||''
      };
    }, noches);

    await det.close();
    await browser.close();

    const fotosLimpias = data.fotos.filter(s => isGoodImg(s));
    console.log(`✅ Detail: ${data.nombre} | ${fotosLimpias.length} fotos | ${data.amenities.length} amenities`);

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
