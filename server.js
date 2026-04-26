'use strict';

const express         = require('express');
const puppeteer       = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');
const path            = require('path');
const fs              = require('fs');

// ─── Constants ───────────────────────────────────────────────────────────────
const PORT      = 3000;
const LOGO_URL  = 'https://heliosherrera.mx/wp-content/uploads/2023/05/logo_blanco_1.webp';
const HTML_PATH = path.join(__dirname, 'rider_helios_herrera.html');

// ─── Platform-aware Puppeteer launch options ─────────────────────────────────
// On Linux/Render: pre-extract the Chromium binary BEFORE launching to avoid
// the ETXTBSY race condition (binary still being written when spawn is called).
async function getLaunchOptions() {
  if (process.platform === 'linux') {
    const chromium = require('@sparticuz/chromium');
    // executablePath() triggers extraction; await ensures it's fully done
    const execPath = await chromium.executablePath();
    return {
      executablePath:  execPath,
      args:            chromium.args,
      defaultViewport: chromium.defaultViewport,
      headless:        chromium.headless,
    };
  }
  return {
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
}

// ─── Browser singleton ───────────────────────────────────────────────────────
// Launched once; reused across requests.
// launchOptions cached so Linux only extracts the binary once.
let browserInstance  = null;
let launchOptionsCache = null;
let browserLaunching  = null;   // in-flight promise guard (prevents double-launch)

async function getBrowser() {
  if (browserInstance) return browserInstance;

  // Coalesce concurrent callers onto a single launch promise
  if (!browserLaunching) {
    browserLaunching = (async () => {
      if (!launchOptionsCache) {
        launchOptionsCache = await getLaunchOptions();
      }
      const b = await puppeteer.launch(launchOptionsCache);
      b.on('disconnected', () => {
        browserInstance  = null;
        browserLaunching = null;   // allow relaunch
        console.warn('  Browser disconnected — will relaunch on next request');
      });
      return b;
    })().then(b => {
      browserInstance  = b;
      browserLaunching = null;
      return b;
    }).catch(err => {
      browserLaunching = null;
      throw err;
    });
  }

  return browserLaunching;
}

// ─── Logo pre-cached as base64 ───────────────────────────────────────────────
// Fetched once at startup; injected into HTML so Puppeteer needs zero network.
let logoBase64 = null;

async function getLogo() {
  if (!logoBase64) {
    try {
      const res  = await fetch(LOGO_URL, { signal: AbortSignal.timeout(8000) });
      const buf  = Buffer.from(await res.arrayBuffer());
      logoBase64 = 'data:image/webp;base64,' + buf.toString('base64');
      console.log('  Logo cached ✓');
    } catch (err) {
      console.warn('  Logo fetch failed — using URL fallback:', err.message);
      logoBase64 = LOGO_URL;
    }
  }
  return logoBase64;
}

// ─── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve HTML with logo URL swapped for cached base64
app.get('/', async (req, res) => {
  try {
    let html = fs.readFileSync(HTML_PATH, 'utf8');
    html = html.replaceAll(LOGO_URL, await getLogo());
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('Error serving HTML: ' + err.message);
  }
});

// ─── POST /generate-pdf ───────────────────────────────────────────────────────
app.post('/generate-pdf', async (req, res) => {
  const pax = Math.max(50, Math.min(2000, parseInt(req.body?.pax, 10) || 400));

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setViewport({ width: 794, height: 1122 * 3 + 100, deviceScaleFactor: 2 });

    // domcontentloaded is enough — logo is base64, no outbound network needed
    await page.goto(`http://localhost:${PORT}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Apply slider value
    await page.evaluate((p) => {
      document.getElementById('paxSlider').value = p;
      updateRider(p);
    }, pax);

    // Hide control panel / preview padding
    await page.evaluate(() => {
      const panel = document.querySelector('.control-panel');
      if (panel) panel.style.display = 'none';
      const area  = document.querySelector('.preview-area');
      if (area) { area.style.padding = '0'; area.style.gap = '0'; }
    });

    // Capture all 3 pages in parallel
    const shot = async (sel) => {
      const el = await page.$(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      return el.screenshot({ type: 'png' });
    };

    const [png1, png2, png3] = await Promise.all([
      shot('#riderPage1'),
      shot('#riderPage2'),
      shot('#riderPage3'),
    ]);

    await page.close();

    // Assemble 3-page A4 PDF
    const pdfDoc = await PDFDocument.create();
    for (const buf of [png1, png2, png3]) {
      const img = await pdfDoc.embedPng(buf);
      const pg  = pdfDoc.addPage([595.28, 841.89]);
      pg.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
    }

    const bytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename="Rider_Helios_Herrera_${pax}pax.pdf"`);
    res.send(Buffer.from(bytes));

  } catch (err) {
    if (page) await page.close().catch(() => {});
    // If browser died mid-request, reset singleton so next request relaunches
    if (/disconnected|ETXTBSY|Target closed/i.test(err.message)) {
      browserInstance  = null;
      browserLaunching = null;
    }
    console.error('PDF generation error:', err.message);
    res.status(500).send('Error generating PDF: ' + err.message);
  }
});

// ─── Startup — sequential pre-warm ───────────────────────────────────────────
// Extract Chromium binary + cache logo BEFORE accepting connections.
// This avoids ETXTBSY: binary is fully written before the first spawn.
(async () => {
  try {
    console.log('\n  Pre-warming…');
    // Sequential: extract binary first, then launch, then fetch logo
    await getLaunchOptions().then(opts => { launchOptionsCache = opts; });
    console.log('  Chromium path resolved ✓');
    await getBrowser();
    console.log('  Browser launched ✓');
    await getLogo();
  } catch (err) {
    console.warn('  Pre-warm error (will retry on first request):', err.message);
  }

  app.listen(PORT, () => {
    console.log(`\n  Rider server  →  http://localhost:${PORT}`);
    console.log(`  PDF endpoint  →  POST http://localhost:${PORT}/generate-pdf\n`);
  });
})();
