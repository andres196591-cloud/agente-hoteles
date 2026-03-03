const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/ping', (req, res) => {
  res.json({ ok: true, mensaje: '🤖 Agente Sonterra v12' });
});

app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.body;
  if (!destino) return res.status(400).json({ error: 'Falta el destino' });

  // Extraer solo la ciudad (antes de la primera coma)
  // "Tulum, Quintana Roo, México" → "Tulum"
  const ciudadCorta = destino.split(',')[0].trim();
  console.log(`🏙️ Destino original: "${destino}" → Ciudad: "${ciudadCorta}"`);

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
    await page.goto('https://portal.membergetaways.com/rsi/search', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    // ── DESTINO: usar solo ciudad corta ──
    console.log(`📍 Escribiendo "${ciudadCorta}" en el buscador del portal`);
    await page.waitForSelector('.ant-select-selection-search-input', { timeout: 10000 });
    await page.click('.ant-select-selection-search-input');
    await page.waitForTimeout(500);
    await page.type('.ant-select-selection-search-input', ciudadCorta, { delay: 180 });
    await page.waitForTimeout(3500);

    // Seleccionar primera sugerencia
    try {
      await page.waitForSelector('.ant-select-item-option', { timeout: 5000 });
      const opts = await page.$$('.ant-select-item-option');
      console.log(`📋 ${opts.length} sugerencias. Seleccionando primera...`);
      if (opts.length > 0) {
        const txt = await opts[0].textContent();
        console.log(`   → "${txt}"`);
        await opts[0].click();
      }
    } catch {
      console.log('⚠️ Sin sugerencias, usando Enter');
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
        const [,,dayIn] = checkin.split('-').map(Number);
        const [,,dayOut] = checkout.split('-').map(Number);
        const sel = `.rdrDay:not(.rdrDayDisabled):not(.rdrDayPassive) .rdrDayNumber span`;
        for (const d of await page.$$(sel)) {
          if (parseInt(await d.textContent()) === dayIn) { await d.click(); break; }
        }
        await page.waitForTimeout(500);
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
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const b = document.querySelector('.search-button');
      if (b) { b.dispatchEvent(new MouseEvent('click', {bubbles:true})); }
    });
    await page.waitForTimeout(15000);
    console.log('📊 URL:', page.url());

    // ── CONTAR RESULTADOS REALES ──
    const totalEnPagina = await page.evaluate(() => {
      const txt = document.body.innerText;
      const m = txt.match(/We found ([\d,]+) properties/i);
      return m ? parseInt(m[1].replace(',','')) : 0;
    });
    console.log(`📈 Total según el portal: ${totalEnPagina}`);

    // ── SCROLL COMPLETO para cargar todos ──
    if (totalEnPagina > 0) {
      console.log('📜 Haciendo scroll para cargar todos...');
      let intentosSinCambio = 0;
      let countAnterior = 0;
      
      while (intentosSinCambio < 4) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(3000);
        
        const countActual = await page.evaluate(() => {
          // Contar por precio visible en pantalla
          const precios = document.querySelectorAll('[class*="price"], [class*="Price"]');
          return precios.length;
        });
        
        console.log(`  📦 Elementos precio: ${countActual}`);
        if (countActual === countAnterior) intentosSinCambio++;
        else intentosSinCambio = 0;
        countAnterior = countActual;
      }
    }

    // Scroll lento para activar lazy loading de imágenes
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(1000);
    const alturaTotal = await page.evaluate(() => document.body.scrollHeight);
    for (let y = 0; y < alturaTotal; y += 500) {
      await page.evaluate(pos => window.scrollTo(0, pos), y);
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(2000);

    // ── EXTRACCIÓN ROBUSTA ──
    console.log('🔄 Extrayendo hoteles...');

    const hoteles = await page.evaluate(() => {
      const results = [];
      const seenNames = new Set();

      // El portal lista los hoteles uno tras otro
      // Buscar TODOS los elementos que tengan:
      // 1. Una imagen real de hotel
      // 2. Un nombre (h2/h3/h4 o strong)
      // 3. Un precio US$

      // Obtener todos los contenedores candidatos
      const allEls = Array.from(document.querySelectorAll('*'));
      
      // Encontrar elementos con precio que también tengan imagen
      const candidates = [];
      
      for (const el of allEls) {
        const txt = el.innerText || '';
        const hasPrice = txt.match(/US\$\s*[\d]+/);
        if (!hasPrice) continue;
        
        // Verificar que tenga imagen de hotel
        const img = el.querySelector('img');
        if (!img) continue;
        
        const imgSrc = img.src || '';
        if (!imgSrc.includes('travelapi') && !imgSrc.includes('expedia') && 
            !imgSrc.includes('hotel') && !imgSrc.match(/\.(jpg|jpeg|png|webp)/i)) continue;
        
        // Verificar que tenga nombre
        const nameEl = el.querySelector('h1,h2,h3,h4,strong');
        if (!nameEl) continue;
        
        const nombre = nameEl.textContent.trim();
        if (nombre.length < 4 || nombre.length > 150) continue;
        
        // Evitar contenedores padre/hijo duplicados
        const isChild = candidates.some(c => c.el.contains(el) || el.contains(c.el));
        if (!isChild) candidates.push({ el, nombre });
      }

      console.log(`Candidatos encontrados: ${candidates.length}`);

      for (const { el, nombre } of candidates) {
        try {
          // Evitar nombres genéricos
          if (nombre.match(/^(refundable|hotel|all|vacation|rental|save|from|budget|star|select|compare|view|more|show|filter|sort|back)/i)) continue;
          if (seenNames.has(nombre.toLowerCase())) continue;
          seenNames.add(nombre.toLowerCase());

          const txt = el.innerText || '';

          // Precio: buscar el más bajo (From US$ XX)
          const precios = txt.match(/US\$\s*[\d,]+\.?\d*/gi) || [];
          const precioNums = precios.map(p => parseFloat(p.replace(/US\$\s*/i,'').replace(',','')));
          const precioMin = precioNums.length ? Math.min(...precioNums) : 0;
          const precio = precioMin ? `US$ ${precioMin}` : '';

          // Imagen
          let imagen = '';
          const imgs = el.querySelectorAll('img');
          for (const img of imgs) {
            const src = img.src || img.dataset.src || '';
            if (src && src.length > 10 && 
                !src.includes('icon') && !src.includes('logo') && 
                !src.includes('flag') && !src.includes('chain') &&
                !src.includes('amenity') &&
                (src.includes('travelapi') || src.includes('expedia') || src.match(/\.(jpg|jpeg|png|webp)/i))) {
              imagen = src;
              break;
            }
          }

          // Rating
          const ratingM = txt.match(/(\d\.\d{1,2})\s*\(/);
          const rating = ratingM ? ratingM[1] : '';

          // Reviews
          const reviewM = txt.match(/\(?([\d,]+)\s*reviews?\)?/i);
          const reviews = reviewM ? reviewM[1] : '';

          // Ahorro
          const saveM = txt.match(/save\s*(\d+)%/i);
          const ahorro = saveM ? `Save ${saveM[1]}%` : '';

          // Estrellas
          const starM = txt.match(/(\d)\s*star/i);
          const estrellas = starM ? starM[1] : '';

          // Dirección/distancia
          const distM = txt.match(/([\d.]+\s*miles?\s*from\s*\w+)/i);
          const addrEl = el.querySelector('[class*="address"],[class*="location"]');
          const direccion = addrEl?.textContent?.trim() || distM?.[0] || '';

          // Enlace
          const link = el.querySelector('a')?.href || '';

          results.push({ nombre, precio, imagen, rating, reviews, ahorro, estrellas, direccion, enlace: link });
        } catch(e) {}
      }

      return results;
    });

    console.log(`✅ Hoteles extraídos: ${hoteles.length}`);

    // Filtrar los que realmente tengan nombre válido
    const final = hoteles.filter(h => 
      h.nombre && h.nombre.length > 3 &&
      !h.nombre.match(/^(refundable|non-refundable|\d+ miles|view map|select room|compare|internet rate|priceline|public savings)/i)
    );

    console.log(`✅ Después de filtrar: ${final.length}`);
    
    await browser.close();

    res.json({
      ok: true,
      destino: ciudadCorta,
      destinoCompleto: destino,
      total: final.length,
      totalPortal: totalEnPagina,
      hoteles: final
    });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => console.log(`🤖 Agente v12 puerto ${PORT}`));
