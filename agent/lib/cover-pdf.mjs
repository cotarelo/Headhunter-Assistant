// lib/cover-pdf.mjs — render a plain-text cover letter as an A4 PDF (Playwright from career-ops).
import fs from 'node:fs';
import { loadPlaywright } from './form.mjs';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Writes outPdf from coverText. Returns outPdf, or throws if Chromium is unavailable. */
export async function coverToPdf(careerOpsDir, coverText, outPdf, { name = '', date = new Date().toISOString().slice(0, 10) } = {}) {
  const { chromium } = loadPlaywright(careerOpsDir);
  const paras = String(coverText).trim().split(/\n\s*\n/).map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:'Helvetica Neue',Arial,sans-serif;font-size:11pt;line-height:1.5;color:#222;margin:0}
    .h{margin-bottom:28px}.h b{font-size:14pt}.d{color:#666;font-size:10pt}p{margin:0 0 12px}
  </style></head><body><div class="h">${name ? `<b>${esc(name)}</b><br>` : ''}<span class="d">${esc(date)}</span></div>${paras}</body></html>`;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({ path: outPdf, format: 'A4', margin: { top: '25mm', bottom: '25mm', left: '22mm', right: '22mm' } });
  } finally { await browser.close(); }
  if (!fs.existsSync(outPdf)) throw new Error('cover PDF not written');
  return outPdf;
}
