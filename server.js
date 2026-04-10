'use strict';

const express   = require('express');
const puppeteer = require('puppeteer');
const { PDFDocument } = require('pdf-lib');
const path = require('path');

const app  = express();
const PORT = 3000;

app.use(express.json());

// Serve the HTML file
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'rider_helios_herrera.html'));
});

/**
 * POST /generate-pdf
 * Body: { pax: number }
 *
 * 1. Opens the HTML in headless Chromium via Puppeteer.
 * 2. Calls updateRider(pax) to apply slider value.
 * 3. Screenshots each .rider-page (794×1122 px) individually.
 * 4. Builds a 2-page A4 PDF with pdf-lib and streams it back.
 */
app.post('/generate-pdf', async (req, res) => {
  const pax = Math.max(50, Math.min(2000, parseInt(req.body?.pax, 10) || 400));

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();

    // CSS pixels match the .rider-page size (794×1122).
    // deviceScaleFactor:3 renders at 2382×3366 physical px ≈ 286 DPI on A4,
    // visually equivalent to a 300 DPI print.
    const CSS_W = 794;
    const CSS_H = 1122;
    const SCALE = 3;
    await page.setViewport({ width: CSS_W, height: CSS_H * 2 + 100, deviceScaleFactor: SCALE });

    await page.goto(`http://localhost:${PORT}/`, {
      waitUntil: 'networkidle0',
      timeout: 30000,
    });

    // Apply pax value exactly as the interactive slider does
    await page.evaluate((p) => {
      document.getElementById('paxSlider').value = p;
      updateRider(p);
    }, pax);

    // Hide sticky control panel and remove preview-area padding so pages
    // sit at known top offsets (0 and CSS_H px respectively).
    await page.evaluate(() => {
      const panel = document.querySelector('.control-panel');
      if (panel) panel.style.display = 'none';
      const area = document.querySelector('.preview-area');
      if (area) { area.style.padding = '0'; area.style.gap = '0'; }
    });

    // Capture each page at exact element bounds — Puppeteer scales
    // coordinates by deviceScaleFactor automatically, so the output PNG
    // is CSS_W*SCALE × CSS_H*SCALE pixels.
    async function screenshotEl(selector) {
      const el = await page.$(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      return el.screenshot({ type: 'png' });
    }

    const [png1, png2] = await Promise.all([
      screenshotEl('#riderPage1'),
      screenshotEl('#riderPage2'),
    ]);

    await browser.close();
    browser = null;

    // Build a 2-page A4 PDF (595.28 × 841.89 pt)
    const pdfDoc = await PDFDocument.create();
    const A4_W  = 595.28;
    const A4_H  = 841.89;

    for (const pngBuf of [png1, png2]) {
      const img = await pdfDoc.embedPng(pngBuf);
      const pg  = pdfDoc.addPage([A4_W, A4_H]);
      pg.drawImage(img, { x: 0, y: 0, width: A4_W, height: A4_H });
    }

    const pdfBytes = await pdfDoc.save();
    const filename = `Rider_Helios_Herrera_${pax}pax.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(pdfBytes));

  } catch (err) {
    if (browser) await browser.close();
    console.error('PDF generation error:', err);
    res.status(500).send('Error generating PDF: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`\n  Rider server  →  http://localhost:${PORT}`);
  console.log(`  PDF endpoint  →  POST http://localhost:${PORT}/generate-pdf  { pax: 400 }\n`);
});
