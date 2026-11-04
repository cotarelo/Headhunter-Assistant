// lib/form.mjs — shared Playwright helpers for reading/filling ATS application forms.
// Never clicks submit. Uses the Playwright copy installed in career-ops/.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function loadPlaywright(careerOpsDir) {
  const req = createRequire(path.join(careerOpsDir, 'package.json'));
  return req('playwright');
}

/** Map a posting URL to the URL of its application form. */
export function applicationUrl(url) {
  const u = new URL(url);
  // Ashby: jobs.ashbyhq.com/<org>/<id>[/application]
  if (/ashbyhq\.com$/.test(u.hostname)) {
    const parts = u.pathname.split('/').filter(Boolean);
    return { ats: 'ashby', url: `https://jobs.ashbyhq.com/${parts[0]}/${parts[1]}/application` };
  }
  // Greenhouse (branded pages carry ?gh_jid=)
  const ghJid = u.searchParams.get('gh_jid');
  if (/greenhouse\.io$/.test(u.hostname)) {
    return { ats: 'greenhouse', url: u.origin + u.pathname };
  }
  if (ghJid) return { ats: 'greenhouse', url: null, ghJid };
  if (/lever\.co$/.test(u.hostname)) {
    const p = u.pathname.replace(/\/apply\/?$/, '');
    return { ats: 'lever', url: `${u.origin}${p}/apply` };
  }
  return { ats: 'unknown', url };
}

/** In-page extraction of visible form controls with their human labels. */
export async function extractFields(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (r.width > 0 || r.height > 0 || el.type === 'file') && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const clean = (t) => (t || '').replace(/\s+/g, ' ').replace(/\*\s*$/, '').trim();
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return clean(l.innerText);
      }
      const wrap = el.closest('label');
      if (wrap) return clean(wrap.innerText);
      const aria = el.getAttribute('aria-label') || (el.getAttribute('aria-labelledby') || '').split(' ').map((id) => document.getElementById(id)?.innerText || '').join(' ');
      if (clean(aria)) return clean(aria);
      // nearest preceding label-ish text inside the field container
      let c = el.parentElement;
      for (let i = 0; i < 5 && c; i++, c = c.parentElement) {
        const l = c.querySelector('label, legend, [class*="label"], [class*="question"]');
        if (l && clean(l.innerText)) return clean(l.innerText);
      }
      return clean(el.placeholder || el.name || '');
    };
    const out = [];
    const seenRadio = new Set();
    for (const el of document.querySelectorAll('input, textarea, select')) {
      const type = (el.tagName === 'INPUT' ? el.type : el.tagName.toLowerCase()) || 'text';
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) continue;
      if (!vis(el) && type !== 'file') continue;
      const required = el.required || el.getAttribute('aria-required') === 'true' ||
        /\*/.test(el.closest('div,fieldset')?.querySelector('label,legend')?.innerText || '');
      if (type === 'radio' || type === 'checkbox') {
        const group = el.name || el.id;
        if (type === 'radio' && seenRadio.has(group)) continue;
        seenRadio.add(group);
        const fs = el.closest('fieldset, [role="radiogroup"], [role="group"]') || el.parentElement?.parentElement;
        const legend = fs?.querySelector('legend, label, [class*="label"]');
        const opts = type === 'radio'
          ? [...document.querySelectorAll(`input[type="radio"][name="${CSS.escape(el.name)}"]`)].map((r) => ({ value: r.value, label: labelFor(r) }))
          : [{ value: el.value, label: labelFor(el) }];
        out.push({ key: group, selector: el.name ? `[name="${el.name}"]` : `#${CSS.escape(el.id)}`, type, label: clean(legend?.innerText) || labelFor(el), required, options: opts });
        continue;
      }
      const options = el.tagName === 'SELECT' ? [...el.options].map((o) => ({ value: o.value, label: clean(o.text) })).filter((o) => o.value !== '') : undefined;
      out.push({
        key: el.name || el.id || `${type}-${out.length}`,
        selector: el.id ? `#${CSS.escape(el.id)}` : el.name ? `[name="${el.name}"]` : null,
        type, label: labelFor(el), required: Boolean(required),
        maxlength: el.maxLength > 0 ? el.maxLength : undefined,
        accept: type === 'file' ? el.accept : undefined,
        options,
      });
    }
    return out.filter((f) => f.selector);
  });
}

export async function openForm(careerOpsDir, url, { headless = true } = {}) {
  const { chromium } = loadPlaywright(careerOpsDir);
  const browser = await chromium.launch({ headless, args: ['--no-sandbox'] });
  const context = await browser.newContext({
    locale: 'en-US', viewport: { width: 1280, height: 1800 },
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  // dismiss cookie banners if present
  for (const t of ['Accept all', 'Accept', 'Aceptar', 'I agree', 'Allow all']) {
    const b = page.getByRole('button', { name: t, exact: true });
    if (await b.count().catch(() => 0)) { await b.first().click({ timeout: 2000 }).catch(() => {}); break; }
  }
  return { browser, page };
}

export function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); return d; }
