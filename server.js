'use strict';

const express        = require('express');
const puppeteer      = require('puppeteer-core');
const { PDFDocument } = require('pdf-lib');
const path           = require('path');
const fs             = require('fs');

// ─── Constants ───────────────────────────────────────────────────────────────
const PORT     = 3000;
const LOGO_URL = 'https://heliosherrera.mx/wp-content/uploads/2023/05/logo_blanco_1.webp';
const HTML_PATH = path.join(__dirname, 'rider_helios_herrera.html');

// ─── Platform-aware Puppeteer launch options ─────────────────────────────────
async function getLaunchOptions() {
  if (process.platform === 'linux') {
    const chromium = require('@sparticuz/chromium');
    return {
      args:            chromium.args,
      defaultViewport: chromium.defaultViewport,
      executablePath:  await chromium.executablePath(),
      headless:        chromium.headless,
    };
  }
  // macOS local dev — use system Chrome
  return {
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  };
}

// ─── OPT 1: Browser singleton ────────────────────────────────────────────────
// Launch Chromium once at startup; reuse across all requests.
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch(await getLaunchOptions());
    // If the browser crashes, reset so the next request relaunches it
    browserInstance.on('disconnected', () => { browserInstance = null; });
  }
  return browserInstance;
}

// ─── OPT 2: Logo pre-cached as base64 ────────────────────────────────────────
// Download once at startup; inject into every HTML response so Puppeteer
// never makes an outbound network request during PDF generation.
let logoBase64 = null;

async function getLogo() {
  if (!logoBase64) {
    try {
      const res    = await fetch(LOGO_URL);
      const buffer = Buffer.from(await res.arrayBuffer());
      logoBase64   = 'data:image/webp;base64,' + buffer.toString('base64');
      console.log('  Logo cached ✓');
    } catch (err) {
      console.warn('  Logo fetch failed — will use URL fallback:', err.message);
      logoBase64 = LOGO_URL;   // graceful fallback
    }
  }
  return logoBase64;
}

// ─── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Serve HTML with logo URL replaced by cached base64
app.get('/', async (req, res) => {
  try {
    let html  = fs.readFileSync(HTML_PATH, 'utf8');
    const logo = await getLogo();
    html = html.replaceAll(LOGO_URL, logo);
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

    // OPT 3: deviceScaleFactor 2 → 1588×2244 px (≈190 DPI on A4) — fast & sharp
    await page.setViewport({ width: 794, height: 1122 * 3 + 100, deviceScaleFactor: 2 });

    // OPT 5: domcontentloaded — logo is already base64, nothing to wait for on the network
    await page.goto(`http://localhost:${PORT}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Apply slider value
    await page.evaluate((p) => {
      document.getElementById('paxSlider').value = p;
      updateRider(p);
    }, pax);

    // Hide UI chrome so pages sit flush
    await page.evaluate(() => {
      const panel = document.querySelector('.control-panel');
      if (panel) panel.style.display = 'none';
      const area  = document.querySelector('.preview-area');
      if (area) { area.style.padding = '0'; area.style.gap = '0'; }
    });

    // OPT 4: Screenshots in parallel (already was, kept explicit)
    const screenshotEl = async (selector) => {
      const el = await page.$(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      return el.screenshot({ type: 'png' });
    };

    const [png1, png2, png3] = await Promise.all([
      screenshotEl('#riderPage1'),
      screenshotEl('#riderPage2'),
      screenshotEl('#riderPage3'),
    ]);

    await page.close();

    // Build 3-page A4 PDF
    const pdfDoc = await PDFDocument.create();
    const A4_W   = 595.28;
    const A4_H   = 841.89;

    for (const pngBuf of [png1, png2, png3]) {
      const img = await pdfDoc.embedPng(pngBuf);
      const pg  = pdfDoc.addPage([A4_W, A4_H]);
      pg.drawImage(img, { x: 0, y: 0, width: A4_W, height: A4_H });
    }

    const pdfBytes = await pdfDoc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Rider_Helios_Herrera_${pax}pax.pdf"`);
    res.send(Buffer.from(pdfBytes));

  } catch (err) {
    if (page) await page.close().catch(() => {});
    console.error('PDF generation error:', err);
    res.status(500).send('Error generating PDF: ' + err.message);
  }
});

// ─── Startup ──────────────────────────────────────────────────────────────────
// Pre-warm browser and logo in parallel so the first request is instant
app.listen(PORT, async () => {
  console.log(`\n  Rider server  →  http://localhost:${PORT}`);
  console.log(`  PDF endpoint  →  POST http://localhost:${PORT}/generate-pdf  { pax: 400 }\n`);
  // Warm up in background — don't block startup
  Promise.all([getBrowser(), getLogo()]).then(() => {
    console.log('  Browser & logo pre-warmed ✓\n');
  }).catch(err => {
    console.warn('  Pre-warm failed (will retry on first request):', err.message);
  });
});
