const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => res.json({ ok: true, v: 21 }));

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
  console.log(`🚀 v21 STREAM: "${ciudad}"`);

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

    // ── INTERCEPTAR RESPUESTAS DE LA API para capturar hotel IDs ──
    // El portal carga los hoteles via API REST — capturamos los IDs del JSON
    const hotelIdMap = new Map(); // nombre -> id

    page.on('response', async (response) => {
      try {
        const url = response.url();
        // La API del portal devuelve listas de hoteles en JSON
        if (!url.includes('membergetaways') && !url.includes('rsi')) return;
        if (!url.includes('hotel') && !url.includes('propert') && !url.includes('search')) return;
        const ct = response.headers()['content-type'] || '';
        if (!ct.includes('json')) return;

        const json = await response.json().catch(() => null);
        if (!json) return;

        // Buscar hoteles en la respuesta — pueden estar en distintas rutas
        const buscarHoteles = (obj, depth=0) => {
          if (!obj || depth > 6) return;
          if (Array.isArray(obj)) {
            obj.forEach(item => buscarHoteles(item, depth+1));
            return;
          }
          if (typeof obj !== 'object') return;

          // Si tiene id + name (o similar), es un hotel
          const id = obj.id || obj.hotelId || obj.propertyId || obj.hotel_id;
          const name = obj.name || obj.hotelName || obj.title || obj.propertyName;
          if (id && name && String(id).match(/^\d{4,8}$/)) {
            const key = String(name).toLowerCase().trim().substring(0, 40);
            hotelIdMap.set(key, String(id));
            console.log(`📡 API hotel: "${name}" → ID: ${id}`);
          }
          Object.values(obj).forEach(v => buscarHoteles(v, depth+1));
        };
        buscarHoteles(json);
      } catch(e) {}
    });

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

            // Extraer enlace del hotel — el botón "Select room" no tiene href,
            // buscar el ID en data-attrs o en atributos del contenedor
            let link = '';
            // 1. Buscar href directo con /rsi/hotel/
            const aHotel = el.querySelector('a[href*="/rsi/hotel/"], a[href*="hotel/"]');
            if (aHotel) link = aHotel.href;
            // 2. Buscar data-hotel-id, data-id, data-property-id en el contenedor
            if (!link) {
              const hotelId = el.getAttribute('data-hotel-id') ||
                              el.getAttribute('data-id') ||
                              el.getAttribute('data-property-id') ||
                              el.querySelector('[data-hotel-id]')?.getAttribute('data-hotel-id') ||
                              el.querySelector('[data-id]')?.getAttribute('data-id') ||
                              el.querySelector('[data-property-id]')?.getAttribute('data-property-id') ||
                              el.querySelector('.hotel-card-wrapper__price-btn')?.getAttribute('data-hotel-id') ||
                              el.querySelector('[class*="price-btn"]')?.getAttribute('data-id');
              if (hotelId && /^\d+$/.test(hotelId)) {
                link = `https://portal.membergetaways.com/rsi/hotel/${hotelId}`;
              }
            }
            // 3. Buscar en onclick o en atributos del botón Select room
            if (!link) {
              const btn = el.querySelector('.hotel-card-wrapper__price-btn, [class*="price-btn"], [class*="select-room"]');
              if (btn) {
                const onclick = btn.getAttribute('onclick') || '';
                const idM = onclick.match(/(\d{4,8})/);
                if (idM) link = `https://portal.membergetaways.com/rsi/hotel/${idM[1]}`;
                // También revisar data attrs del botón
                for (const attr of btn.getAttributeNames()) {
                  const val = btn.getAttribute(attr);
                  if (/^\d{5,8}$/.test(val)) {
                    link = `https://portal.membergetaways.com/rsi/hotel/${val}`; break;
                  }
                }
              }
            }
            // 4. Buscar ID en el HTML completo del elemento (patron /rsi/hotel/ID)
            if (!link) {
              const htmlStr = el.innerHTML || '';
              const m = htmlStr.match(/\/rsi\/hotel\/(\d+)/);
              if (m) link = `https://portal.membergetaways.com/rsi/hotel/${m[1]}`;
            }
            // 5. Buscar cualquier número que parezca un hotel ID en atributos de todos los hijos
            if (!link) {
              for (const child of el.querySelectorAll('*')) {
                for (const attr of child.getAttributeNames()) {
                  const val = child.getAttribute(attr) || '';
                  if (/^https?:\/\/.*\/hotel\//.test(val)) { link = val; break; }
                }
                if (link) break;
              }
            }

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
              enlace: link || window.location.href,
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

      // ── Enriquecer enlaces con IDs capturados de la API ──
      nuevos.forEach(h => {
        if (!h.enlace) {
          const key = h.nombre.toLowerCase().trim().substring(0, 40);
          // Buscar coincidencia exacta o parcial en el mapa
          let id = hotelIdMap.get(key);
          if (!id) {
            for (const [k, v] of hotelIdMap.entries()) {
              if (key.includes(k.substring(0,15)) || k.includes(key.substring(0,15))) {
                id = v; break;
              }
            }
          }
          if (id) {
            h.enlace = `https://portal.membergetaways.com/rsi/hotel/${id}`;
            console.log(`🔗 Enlace asignado: "${h.nombre}" → ${h.enlace}`);
          }
        }
      });

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

    // Log de IDs capturados via API
    console.log(`📡 Hotel IDs capturados via API: ${hotelIdMap.size}`, [...hotelIdMap.entries()].slice(0,5));
    console.log(`📡 Hoteles sin enlace: ${[...enviados].filter(n => {
      // just count
      return true;
    }).length}`);

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
// ENDPOINT: /hotel-detail v19
// Navega a la búsqueda, hace clic en Select room del
// hotel por nombre, espera 8s y extrae todo
// ══════════════════════════════════════════════════════
app.get('/hotel-detail', async (req, res) => {
  const { enlace, checkin, checkout, nombre: nombreParam, destino } = req.query;

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

    const page = await ctx.newPage();

    // ── Navegar siempre a búsqueda con destino ──
    // Ya no usamos enlace (contiene URL del portal que bloquea Mod_Security)
    const searchUrl = 'https://portal.membergetaways.com/rsi/search';

    emit('status', { msg: 'Buscando el hotel...' });
    console.log('🔍 Navegando a:', searchUrl.substring(0, 80));
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 35000 });
    await page.waitForTimeout(5000);

    // Hacer la búsqueda con el destino recibido
    if (destino) {
      try {
        await page.waitForSelector('.ant-select-selection-search-input', { timeout: 10000 });
        await page.click('.ant-select-selection-search-input');
        await page.waitForTimeout(400);
        await page.type('.ant-select-selection-search-input', destino.split(',')[0].trim(), { delay: 150 });
        await page.waitForTimeout(3000);
        const opts = await page.$$('.ant-select-item-option');
        if (opts.length > 0) await opts[0].click();
        else await page.keyboard.press('Enter');
        await page.waitForTimeout(1000);
        await page.evaluate(() => {
          const b = document.querySelector('.search-button');
          if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        await page.waitForTimeout(10000);
        console.log('✅ Búsqueda ejecutada para:', destino);
      } catch(e) {
        console.log('⚠️ Búsqueda fallida:', e.message.substring(0,60));
      }
    }

    emit('status', { msg: 'Esperando tarjetas de hotel...' });

    // Esperar que aparezcan botones Select room
    try {
      await page.waitForSelector('.hotel-card-wrapper__price-btn', { timeout: 20000 });
      console.log('✅ Botones Select room visibles');
    } catch(e) {
      console.log('⚠️ Botones no encontrados, continuando...');
    }

    // Scroll para cargar todas las tarjetas
    for (const pos of [400, 900, 1600, 0]) {
      await page.evaluate(y => window.scrollTo(0, y), pos);
      await page.waitForTimeout(800);
    }

    emit('status', { msg: `Localizando: ${nombreParam || ''}...` });

    // ── Hacer clic en Select room del hotel correcto ──
    const nombre = (nombreParam || '').toLowerCase().trim();
    console.log('🎯 Buscando hotel:', nombre);

    // Contar botones disponibles
    const nBotones = await page.$$eval('.hotel-card-wrapper__price-btn', btns => btns.length);
    console.log(`🔘 Botones Select room: ${nBotones}`);

    // Buscar el botón del hotel correcto por nombre
    let clickResult = await page.evaluate((buscarNombre) => {
      const btns = document.querySelectorAll('.hotel-card-wrapper__price-btn');
      for (const btn of btns) {
        // Subir hasta encontrar el contenedor de la tarjeta
        let card = btn.parentElement;
        for (let i = 0; i < 8; i++) {
          const txt = (card?.innerText || card?.textContent || '').toLowerCase();
          if (txt.length > 20) {
            if (!buscarNombre || txt.includes(buscarNombre.substring(0, 12))) {
              btn.scrollIntoView({ behavior: 'smooth', block: 'center' });
              btn.click();
              return { ok: true, found: true, cardText: txt.substring(0, 80) };
            }
            break;
          }
          card = card?.parentElement;
        }
      }
      // Fallback: clic en el primer botón
      if (btns.length > 0) {
        btns[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        btns[0].click();
        return { ok: true, found: false, fallback: true };
      }
      return { ok: false };
    }, nombre);

    console.log('🖱️ Click result:', JSON.stringify(clickResult));

    if (!clickResult.ok) {
      emit('error', { msg: 'No se encontró el botón Select room en la página.' });
      await browser.close(); res.end(); return;
    }

    emit('status', { msg: 'Abriendo ficha del hotel, espera un momento...' });

    // ── Esperar la navegación — puede ser nueva pestaña o SPA routing ──
    let detPage = null;

    // Caso 1: abre nueva pestaña
    const newPagePromise = ctx.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    // Caso 2: navegación en la misma pestaña
    const navPromise = page.waitForNavigation({ url: '**/rsi/hotel/**', timeout: 10000 }).catch(() => null);

    const [newTab, nav] = await Promise.all([newPagePromise, navPromise]);

    if (newTab) {
      console.log('✅ Nueva pestaña abierta');
      detPage = newTab;
      await detPage.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
    } else if (nav || page.url().includes('/rsi/hotel/')) {
      console.log('✅ SPA routing, misma pestaña:', page.url().substring(0, 80));
      detPage = page;
    } else {
      // Esperar un poco más — a veces tarda
      await page.waitForTimeout(5000);
      const curUrl = page.url();
      console.log('⏳ URL actual después de 5s:', curUrl.substring(0, 80));
      if (curUrl.includes('/rsi/hotel/')) {
        detPage = page;
      } else {
        // Verificar si hay nueva pestaña tardía
        const pages = ctx.pages();
        for (const p of pages) {
          if (p.url().includes('/rsi/hotel/')) { detPage = p; break; }
        }
      }
    }

    if (!detPage) {
      emit('error', { msg: 'El portal no cargó la página del hotel. Intenta de nuevo.' });
      await browser.close(); res.end(); return;
    }

    console.log('✅ Página de detalle URL:', detPage.url().substring(0, 80));
    emit('status', { msg: 'Cargando fotos y amenidades del hotel...' });

    // ── ESPERAR QUE CARGUE BIEN ── (el portal tarda ~5s)
    await detPage.waitForTimeout(6000);

    // Esperar imágenes
    try {
      await detPage.waitForSelector('.hotel-images__image, .slick-slider', { timeout: 10000 });
      console.log('✅ Galería visible');
    } catch(e) { console.log('⚠️ Galería no detectada'); }

    // Scroll para activar lazy loading
    for (const pos of [300, 800, 1500, 2500, 0]) {
      await detPage.evaluate(y => window.scrollTo(0, y), pos);
      await detPage.waitForTimeout(600);
    }
    await detPage.waitForTimeout(1500);

    // Navegar carrusel con teclas
    try {
      await detPage.waitForSelector('.slick-track', { timeout: 5000 });
      for (let i = 0; i < 10; i++) {
        await detPage.keyboard.press('ArrowRight');
        await detPage.waitForTimeout(300);
      }
      for (let i = 0; i < 10; i++) {
        await detPage.keyboard.press('ArrowLeft');
        await detPage.waitForTimeout(200);
      }
    } catch(e) {}

    // Forzar lazy loading
    await detPage.evaluate(() => {
      document.querySelectorAll('img[data-lazy],img[data-src]').forEach(img => {
        const src = img.getAttribute('data-lazy') || img.getAttribute('data-src');
        if (src && src.startsWith('http')) img.src = src;
      });
    });
    await detPage.waitForTimeout(2000);

    // ── EXTRAER TODO ──
    await scrapeAndEmit(detPage, noches, emit, isGoodImg);
    await browser.close();
    emit('fin', {});

  } catch(err) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ detail:', err.message);
    emit('error', { msg: 'Error cargando el hotel: ' + err.message.substring(0, 100) });
  }
  res.end();
});


// ── Función compartida de scraping ──────────────────────────────
async function scrapeAndEmit(page, noches, emit, isGoodImg) {
  // Scroll agresivo para activar lazy loading
  for (const pos of [300, 800, 1500, 2400, 3200, 0]) {
    await page.evaluate(y => window.scrollTo(0, y), pos);
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(1500);

  // Esperar carrusel slick
  try {
    await page.waitForSelector('.slick-slider, .hotel-images__image', { timeout: 8000 });
  } catch(e) {}

  // Navegar carrusel con teclas para forzar lazy load
  try {
    await page.waitForSelector('.slick-track', { timeout: 5000 });
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(350);
    }
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowLeft');
      await page.waitForTimeout(200);
    }
  } catch(e) {}

  // Forzar lazy loading manual
  await page.evaluate(() => {
    document.querySelectorAll('img[data-lazy], img[data-src]').forEach(img => {
      const src = img.getAttribute('data-lazy') || img.getAttribute('data-src');
      if (src && src.startsWith('http')) img.src = src;
    });
  });
  await page.waitForTimeout(1500);

  const data = await page.evaluate((nochesParm) => {
    const BAD = ['logo','icon-','amenity','chain','flag','placeholder','noimage',
                 'package-D','no-image','blank.','default.jpg','rsi/assets'];
    const esUrlBuena = (src) => {
      if (!src || src.length < 10) return false;
      const l = src.toLowerCase();
      if (BAD.some(p => l.includes(p))) return false;
      return (l.includes('travelapi') || l.includes('expedia') || l.includes('media') ||
              l.includes('hotelbeds') || l.includes('iceportal')) && l.match(/\.(jpg|jpeg|png|webp)/i);
    };
    const fotos = []; const visto = new Set();
    const addSrc = (src) => {
      if (!src || src.length < 12) return;
      const key = src.split('?')[0];
      if (esUrlBuena(src) && !visto.has(key)) { visto.add(key); fotos.push(src); }
    };

    // Selectores específicos del portal membergetaways
    document.querySelectorAll('.hotel-images__main-image-wrapper img, .hotel-images__other-image-wrapper img, img.hotel-images__image').forEach(img => {
      addSrc(img.src); addSrc(img.getAttribute('data-src')||''); addSrc(img.getAttribute('data-lazy')||'');
    });
    document.querySelectorAll('.slick-slide:not(.slick-cloned) img').forEach(img => {
      ['src','data-lazy','data-src','data-original'].forEach(a => { const s=img.getAttribute(a)||''; if(s.startsWith('http')) addSrc(s); });
    });
    document.querySelectorAll('img.custom-carousel-image__item').forEach(img => {
      addSrc(img.src); addSrc(img.getAttribute('data-lazy')||'');
    });
    if (fotos.length < 4) {
      document.querySelectorAll('img').forEach(img => {
        ['src','data-src','data-lazy','data-original'].forEach(a => { const s=img.getAttribute(a)||''; if(s.startsWith('http')) addSrc(s); });
      });
    }

    const nombre = (document.querySelector('.hotel-info__title, h1')?.textContent||'').trim();
    const direccion = (document.querySelector('.hotel-info__address, [class*="address"]')?.textContent||'').trim().replace(/view map/gi,'').trim();

    let descripcion = '';
    const descEl = document.querySelector('.hotel-images__hotel-text');
    if (descEl) descripcion = ((descEl.querySelector('p,div')||descEl).innerText||'').trim().substring(0,1500);
    if (!descripcion) {
      for (const s of ['[class*="description"]','[class*="about"]']) {
        for (const el of document.querySelectorAll(s)) {
          const t = (el.innerText||'').trim();
          if (t.length > 80 && !t.includes('$')) { descripcion = t.substring(0,1500); break; }
        }
        if (descripcion) break;
      }
    }

    const amenities = [];
    const amenVisto = new Set();
    const SKIP = /^(show more|show less|view map|reserve|book|select|filter|\$|US\$|refund|\d+ night)/i;
    document.querySelectorAll('.amenities__amenities-list .ant-list-item span').forEach(el => {
      const t = (el.innerText||'').trim().replace(/\s+/g,' ');
      if (t.length>3 && t.length<120 && !SKIP.test(t) && !amenVisto.has(t.toLowerCase())) { amenVisto.add(t.toLowerCase()); amenities.push(t); }
    });
    if (amenities.length < 3) {
      for (const s of ['[class*="amenit"] li','[class*="amenit"] span']) {
        document.querySelectorAll(s).forEach(el => {
          const t = (el.innerText||'').trim().replace(/\s+/g,' ');
          if (t.length>3 && t.length<120 && !SKIP.test(t) && !amenVisto.has(t.toLowerCase())) { amenVisto.add(t.toLowerCase()); amenities.push(t); }
        });
        if (amenities.length >= 8) break;
      }
    }

    const txt = document.body.innerText || '';
    let precioNoche = 0;
    const priceEls = document.querySelectorAll('.hotel-card-wrapper__price-total-text');
    for (const el of priceEls) {
      const m = (el.textContent||'').match(/([\d,]+\.?\d+)/);
      if (m) { const v=parseFloat(m[1].replace(/,/g,'')); if(v>5){precioNoche=v;break;} }
    }
    if (!precioNoche) {
      const fromM = txt.match(/[Ff]rom[\s\n]*US\$\s*([\d,]+\.?\d*)/);
      if (fromM) { const v=parseFloat(fromM[1].replace(/,/g,'')); if(v>5) precioNoche=v; }
    }
    if (!precioNoche) {
      const limpio = txt.split('\n').filter(l=>!/savings|public rate|save|client cash/i.test(l)).join(' ');
      const todos = (limpio.match(/US\$\s*[\d,]+\.?\d*/gi)||[]).map(p=>parseFloat(p.replace(/US\$\s*/i,'').replace(/,/g,''))).filter(n=>n>5&&n<99999);
      if (todos.length) precioNoche = Math.min(...todos);
    }

    const forN = txt.match(/for\s+(\d+)\s+nights?/i);
    const portalNoches = forN ? parseInt(forN[1]) : nochesParm;
    const ratingEl = document.querySelector('.guest-ratings__reviews-rating');
    const ratingM = (ratingEl?.textContent||txt).match(/(\d\.\d)/);
    const reviewM = txt.match(/([\d,]+)\s+reviews?/i);
    const nStars = document.querySelectorAll('.hotel-info__star').length;

    return {
      nombre, direccion, descripcion,
      amenities: amenities.slice(0,20),
      fotos: fotos.slice(0,15),
      precioNoche: precioNoche ? `US$ ${precioNoche.toFixed(2)}` : '',
      precioTotal: precioNoche ? `US$ ${(precioNoche*portalNoches).toFixed(2)}` : '',
      noches: portalNoches,
      estrellas: nStars > 0 ? nStars.toString() : '',
      rating: ratingM?.[1]||'',
      reviews: (reviewM?.[1]||'').replace(/,/g,'')
    };
  }, noches);

  const fotosLimpias = data.fotos.filter(s => isGoodImg(s));
  console.log(`✅ Scraped: "${data.nombre}" | fotos: ${fotosLimpias.length} | amenities: ${data.amenities.length} | precio: ${data.precioNoche}`);

  emit('detalle', {
    nombre: data.nombre, direccion: data.direccion, descripcion: data.descripcion,
    amenities: data.amenities, imagenes: fotosLimpias,
    precioNoche: data.precioNoche, precioTotal: data.precioTotal, noches: data.noches,
    estrellas: data.estrellas, rating: data.rating, reviews: data.reviews
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🤖 v21 puerto ${PORT}`));
