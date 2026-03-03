const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/ping', (req, res) => {
  res.json({ ok: true, mensaje: '🤖 Agente Sonterra v11 - Todos los hoteles' });
});

app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.body;
  if (!destino) return res.status(400).json({ error: 'Falta el destino' });

  let browser;
  try {
    const { chromium } = require('playwright');

    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage',
             '--disable-gpu','--single-process','--no-zygote']
    });

    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
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

    // ── BUSCADOR ──
    console.log('🏨 Abriendo buscador...');
    await page.goto('https://portal.membergetaways.com/rsi/search', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // ── DESTINO: escribir y esperar sugerencias del portal ──
    console.log('📍 Escribiendo destino:', destino);
    await page.waitForSelector('.ant-select-selection-search-input', { timeout: 10000 });
    await page.click('.ant-select-selection-search-input');
    await page.waitForTimeout(500);
    
    // Escribir carácter a carácter para activar el autocomplete del portal
    await page.type('.ant-select-selection-search-input', destino, { delay: 200 });
    await page.waitForTimeout(3500);

    // Intentar seleccionar la primera sugerencia del portal (tiene sus propias sugerencias)
    try {
      await page.waitForSelector('.ant-select-item-option', { timeout: 5000 });
      const sugerencias = await page.$$('.ant-select-item-option');
      console.log(`📋 Sugerencias encontradas: ${sugerencias.length}`);
      if (sugerencias.length > 0) {
        await sugerencias[0].click(); // Primer resultado = más exacto
        console.log('✅ Primera sugerencia seleccionada');
      }
    } catch {
      console.log('⚠️ Sin sugerencias, continuando con texto directo');
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
        console.log('✅ Fechas OK');
      } catch(e) { console.log('⚠️ Fechas:', e.message); }
    }

    // ── BUSCAR ──
    console.log('🔍 Ejecutando búsqueda...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const b = document.querySelector('.search-button');
      if (b) b.click();
    });

    // Esperar resultados
    await page.waitForTimeout(12000);
    console.log('📊 URL resultados:', page.url());

    // ── SCROLL PARA CARGAR TODOS LOS HOTELES ──
    console.log('📜 Haciendo scroll para cargar todos los resultados...');
    let prevCount = 0;
    let scrollRounds = 0;
    
    while (scrollRounds < 15) { // máx 15 scrolls
      // Scroll al fondo
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
      
      // Contar hoteles actuales
      const currentCount = await page.evaluate(() => {
        // Buscar cards de hoteles - el portal usa clases específicas
        const selectors = [
          '.result-wrapper__hotel-card',
          '[class*="hotel-card"]',
          '[class*="HotelCard"]', 
          '[class*="property-card"]',
          '[class*="PropertyCard"]',
          '.ant-card',
          '[class*="result-card"]'
        ];
        for (const sel of selectors) {
          const found = document.querySelectorAll(sel);
          if (found.length > 2) return found.length;
        }
        // Fallback: buscar elementos que tengan precio y nombre
        return document.querySelectorAll('[class*="card"],[class*="result"],[class*="hotel"]')
          .length;
      });
      
      console.log(`📦 Hoteles visibles: ${currentCount}`);
      
      if (currentCount === prevCount) {
        scrollRounds++;
        if (scrollRounds >= 3) break; // 3 intentos sin cambio = terminó
      } else {
        scrollRounds = 0;
      }
      prevCount = currentCount;
    }

    // Scroll al inicio para que las imágenes se carguen
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(2000);
    
    // Hacer scroll lento para cargar imágenes lazy
    const pageHeight = await page.evaluate(() => document.body.scrollHeight);
    for (let pos = 0; pos < pageHeight; pos += 600) {
      await page.evaluate(y => window.scrollTo(0, y), pos);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(2000);

    // ── EXTRAER TODOS LOS HOTELES ──
    console.log('🔄 Extrayendo datos de todos los hoteles...');
    
    const hoteles = await page.evaluate(() => {
      const results = [];
      const nombresVistos = new Set();

      // Estrategia 1: selectores específicos del portal
      const selectorsPrioridad = [
        '.result-wrapper__hotel-card',
        '[class*="hotel-card"]',
        '[class*="HotelCard"]',
        '[class*="PropertyCard"]',
        '[class*="property-card"]',
        '[class*="SearchResult"]',
        '[class*="search-result-item"]',
        '[class*="result-item"]',
        '.ant-card-bordered',
      ];

      let cards = [];
      for (const sel of selectorsPrioridad) {
        const found = document.querySelectorAll(sel);
        if (found.length >= 3) {
          cards = Array.from(found);
          console.log(`Usando selector: ${sel}, encontrados: ${found.length}`);
          break;
        }
      }

      // Estrategia 2: buscar por estructura (tiene imagen + precio)
      if (cards.length < 3) {
        const todos = document.querySelectorAll('div, article, li');
        for (const el of todos) {
          const tieneImg = el.querySelector('img[src*="travelapi"], img[src*="membergetaways"], img[src*="hotel"], img[src*="expedia"]');
          const tieneNombre = el.querySelector('h1,h2,h3,h4');
          const tienePrecio = el.innerText?.match(/US\$\s*[\d,]+/);
          if (tieneImg && tieneNombre && tienePrecio) {
            // Evitar duplicados por contenedor padre/hijo
            const yaEsHijo = cards.some(c => c.contains(el) || el.contains(c));
            if (!yaEsHijo) cards.push(el);
          }
        }
        console.log(`Estrategia 2: ${cards.length} cards`);
      }

      // Procesar cada card
      for (const card of cards) {
        try {
          // Nombre - evitar "Refundable" y textos de filtros
          let nombre = '';
          const posiblesNombres = card.querySelectorAll('h1,h2,h3,h4,strong,[class*="name"],[class*="title"],[class*="hotel-name"]');
          for (const el of posiblesNombres) {
            const txt = el.textContent.trim();
            if (txt.length > 4 && txt.length < 120 && 
                !txt.match(/^(refundable|non-refundable|save|from|per night|star rating|\d+ star|vacation rental|hotels|all|select|compare|view map|miles)/i)) {
              nombre = txt;
              break;
            }
          }
          
          if (!nombre || nombre.length < 4) continue;
          if (nombresVistos.has(nombre)) continue; // Skip duplicados
          nombresVistos.add(nombre);

          // Imagen - buscar la mejor imagen disponible
          let imagen = '';
          const imgs = card.querySelectorAll('img');
          for (const img of imgs) {
            const src = img.src || img.dataset.src || img.dataset.lazySrc || '';
            if (src && src.startsWith('http') && 
                !src.includes('icon') && !src.includes('logo') && 
                !src.includes('flag') && !src.includes('arrow') &&
                !src.includes('svg') && (src.includes('travelapi') || src.includes('hotel') || 
                src.includes('membergetaways') || src.includes('expedia') || 
                src.includes('i.travelapi') || src.match(/\.(jpg|jpeg|png|webp)/i))) {
              imagen = src;
              break;
            }
          }
          
          // Si no tiene imagen propia, buscar srcset
          if (!imagen) {
            const imgs2 = card.querySelectorAll('img[srcset], img[data-src]');
            for (const img of imgs2) {
              const src = img.dataset.src || img.srcset?.split(' ')[0] || '';
              if (src && src.startsWith('http')) { imagen = src; break; }
            }
          }

          // Precio
          const textoCard = card.innerText || '';
          const precioMatch = textoCard.match(/US\$\s*[\d,]+\.?\d*|From\s+US\$\s*[\d,]+/i);
          const precio = precioMatch ? precioMatch[0] : '';

          // Rating / estrellas
          const ratingEl = card.querySelector('[class*="rating"],[class*="review"],[class*="score"]');
          const ratingTxt = ratingEl?.textContent?.trim() || '';
          const ratingNum = ratingTxt.match(/[\d.]+/)?.[0] || '';

          // Número de reviews
          const reviewsMatch = textoCard.match(/\(?([\d,]+)\s*reviews?\)?/i);
          const reviews = reviewsMatch ? reviewsMatch[1] : '';

          // Estrellas
          const starEl = card.querySelector('[class*="star"],[class*="Star"]');
          const starTxt = starEl?.textContent?.trim() || '';
          const estrellas = starTxt.match(/\d/)?.[0] || '';

          // Ahorro
          const saveMatch = textoCard.match(/save\s*\d+%/i);
          const ahorro = saveMatch ? saveMatch[0] : '';

          // Dirección
          const addrEl = card.querySelector('[class*="address"],[class*="location"],[class*="distance"],[class*="miles"]');
          const direccion = (addrEl?.textContent?.trim() || '').substring(0, 100);

          // Enlace
          const linkEl = card.querySelector('a[href*="hotel"], a[href*="property"], a[href*="membergetaways"], button[class*="select"]');
          const enlace = linkEl?.href || '';

          // Precio público (tachado)
          const precioPublicoMatch = textoCard.match(/US\$\s*([\d,]+\.?\d*)\s*\n.*?per night/i);
          const precioPublico = precioPublicoMatch ? `US$ ${precioPublicoMatch[1]}` : '';

          results.push({
            nombre, imagen, precio, estrellas, ratingNum,
            reviews, ahorro, direccion, enlace, precioPublico
          });
        } catch(e) { /* skip */ }
      }

      return results;
    });

    console.log(`📦 Hoteles extraídos: ${hoteles.length}`);

    // URL de resultados para el enlace
    const urlResultados = page.url();
    
    await browser.close();

    // Si hay muy pocos hoteles, Claude intenta interpretar la página
    let hotelesTotales = hoteles.length;
    
    // Limpiar: remover hoteles sin nombre o con nombres genéricos
    const hotelsFiltrados = hoteles.filter(h => 
      h.nombre && 
      h.nombre.length > 4 && 
      !h.nombre.match(/^(refundable|hotel|property|vacation|rental|all|more|select|view|compare|star|rating|save|from|budget|amenities)/i)
    );

    console.log(`✅ Hoteles después de filtrar: ${hotelsFiltrados.length}`);

    res.json({ 
      ok: true, 
      destino, 
      total: hotelsFiltrados.length,
      hoteles: hotelsFiltrados,
      urlResultados
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🤖 Agente v11 en puerto ${PORT}`));
