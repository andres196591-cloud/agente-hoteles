const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/ping', (req, res) => {
  res.json({ ok: true, mensaje: '🤖 Agente Sonterra activo con Claude AI' });
});

app.post('/buscar-hoteles', async (req, res) => {
  const { destino, checkin, checkout } = req.body;
  if (!destino) return res.status(400).json({ error: 'Falta el destino' });

  let browser;
  try {
    const { chromium } = require('playwright');

    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process',
        '--no-zygote'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      geolocation: { latitude: 19.4326, longitude: -99.1332 },
      permissions: ['geolocation']
    });

    const page = await context.newPage();

    // ── PASO 1: Login ──
    console.log('🔐 Abriendo login...');
    await page.goto('https://login.orohorizonsclub.com/', {
      waitUntil: 'domcontentloaded', timeout: 30000
    });
    await page.waitForTimeout(2000);

    await page.evaluate(() => {
      const modal = document.getElementById('myModal');
      if (modal) modal.style.display = 'flex';
    });
    await page.waitForTimeout(1000);

    await page.fill('#myModal input[name="username"]', 'orothomas');
    await page.fill('#myModal input[type="password"]', 'orovazquez');
    await page.waitForTimeout(500);
    await page.click('#myModal button:has-text("Log in")');
    await page.waitForTimeout(8000);
    console.log('✅ Login OK. URL:', page.url());

    // ── PASO 2: Ir al buscador ──
    console.log('🏨 Abriendo buscador...');
    await page.goto('https://portal.membergetaways.com/rsi/search', {
      waitUntil: 'networkidle', timeout: 30000
    });
    await page.waitForTimeout(3000);

    // ── PASO 3: Llenar destino ──
    console.log('📍 Escribiendo destino:', destino);
    const inputSelector = '.ant-select-selection-search-input';
    await page.waitForSelector(inputSelector, { timeout: 10000 });
    await page.click(inputSelector);
    await page.waitForTimeout(500);
    await page.type(inputSelector, destino, { delay: 150 });
    await page.waitForTimeout(3000);

    // Seleccionar sugerencia
    try {
      const sugerenciaSelector = '.ant-select-item-option';
      await page.waitForSelector(sugerenciaSelector, { timeout: 5000 });
      await page.click(sugerenciaSelector);
      console.log('✅ Sugerencia seleccionada');
    } catch {
      await page.keyboard.press('Escape');
      console.log('⚠️ Sin sugerencia');
    }
    await page.waitForTimeout(1000);

    // ── PASO 4: Fechas ──
    if (checkin && checkout) {
      try {
        await page.click('.date-picker__wrapper');
        await page.waitForTimeout(1500);

        const [, , dayIn] = checkin.split('-').map(Number);
        const daySelector = `.rdrDay:not(.rdrDayDisabled):not(.rdrDayPassive) .rdrDayNumber span`;
        for (const d of await page.$$(daySelector)) {
          if (parseInt(await d.textContent()) === dayIn) { await d.click(); break; }
        }
        await page.waitForTimeout(500);

        const [, , dayOut] = checkout.split('-').map(Number);
        for (const d of await page.$$(daySelector)) {
          if (parseInt(await d.textContent()) === dayOut) { await d.click(); break; }
        }

        await page.click('button:has-text("Done")');
        await page.waitForTimeout(500);
        console.log('✅ Fechas OK');
      } catch (e) {
        console.log('⚠️ Fechas fallaron:', e.message);
      }
    }

    // ── PASO 5: Buscar ──
    console.log('🔍 Buscando...');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      const btn = document.querySelector('.search-button');
      if (btn) btn.click();
    });
    await page.waitForTimeout(10000);
    console.log('📊 URL resultados:', page.url());

    // ── PASO 6: Obtener HTML de resultados ──
    const htmlResultados = await page.evaluate(() => {
      // Extraer solo la sección de resultados para no mandar todo el HTML
      const seccion = document.querySelector('.search-page, .results, main, #root') || document.body;
      return seccion.innerHTML.substring(0, 30000);
    });

    const textoResultados = await page.evaluate(() => document.body.innerText.substring(0, 5000));
    const urlActual = page.url();

    await browser.close();

    // ── PASO 7: Claude AI analiza los resultados ──
    console.log('🤖 Enviando a Claude para analizar...');

    const prompt = `Eres un extractor de datos de hoteles. Analiza el siguiente texto de una página web de búsqueda de hoteles y extrae la información de los hoteles encontrados.

URL actual: ${urlActual}
Destino buscado: ${destino}

TEXTO DE LA PÁGINA:
${textoResultados}

Extrae TODOS los hoteles que encuentres. Para cada hotel devuelve un JSON con este formato exacto:
{
  "hoteles": [
    {
      "nombre": "nombre del hotel",
      "precio": "precio por noche",
      "estrellas": "número de estrellas o rating",
      "descripcion": "descripción corta",
      "enlace": "URL si está disponible"
    }
  ]
}

Si no hay hoteles en los resultados, devuelve {"hoteles": []}.
Responde SOLO con el JSON, sin texto adicional.`;

    const response = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    let hoteles = [];
    try {
      const jsonText = response.content[0].text.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(jsonText);
      hoteles = parsed.hoteles || [];
    } catch (e) {
      console.log('⚠️ Error parseando respuesta de Claude:', e.message);
      console.log('Respuesta Claude:', response.content[0].text.substring(0, 500));
    }

    console.log(`✅ Hoteles encontrados por Claude: ${hoteles.length}`);
    res.json({ ok: true, destino, total: hoteles.length, hoteles });

  } catch (error) {
    if (browser) await browser.close().catch(() => {});
    console.error('❌ Error:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🤖 Agente corriendo en puerto ${PORT}`);
});
