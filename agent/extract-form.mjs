#!/usr/bin/env node
/**
 * extract-form.mjs — read an application form's fields (no filling, no submit).
 *   node extract-form.mjs --report 105            # uses the report's **URL:**
 *   node extract-form.mjs --url <posting-url> --out <dir>
 * Writes <out>/form.json and <out>/form-empty.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { applicationUrl, extractFields, openForm, ensureDir } from './lib/form.mjs';
import { parseReport } from './notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '.env') });
const ROOT = path.resolve(HERE, process.env.CAREER_OPS_DIR || '../career-ops');
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

export function reportFile(num) {
  const f = fs.readdirSync(path.join(ROOT, 'reports')).find((x) => x.startsWith(String(num).padStart(3, '0') + '-') && !/RESERVED/.test(x));
  if (!f) throw new Error(`report ${num} not found`);
  return path.join(ROOT, 'reports', f);
}

export async function extractForm({ report, url, out }) {
  let meta = {};
  if (report) { meta = parseReport(reportFile(report)); url = meta.url; }
  if (!url) throw new Error('no URL');
  out = out || path.join(ROOT, 'output', 'applications', String(report || 'adhoc'));
  ensureDir(out);
  const target = applicationUrl(url);
  let formUrl = target.url || url;
  const { browser, page } = await openForm(ROOT, formUrl);
  try {
    let targetFrame = page.mainFrame();
    const hasFileInput = await page.evaluate(() => document.querySelectorAll('input[type="file"]').length > 0);
    if (!hasFileInput) {
      const applyHref = await page.evaluate((jid) => {
        const links = [...document.querySelectorAll('a')];
        let match = links.find((a) => jid && a.href && a.href.includes(jid) && /(apply|form)/i.test(a.href));
        if (!match) match = links.find((a) => a.href && /(apply|form)\b/i.test(a.href) && !a.href.includes('#'));
        if (!match) match = links.find((a) => a.href && !a.href.endsWith('#') && !a.href.endsWith('#/') && /(apply for this position|apply now)/i.test(a.innerText));
        return match ? match.href : null;
      }, target.ghJid);
      if (applyHref && applyHref !== page.url()) {
        await page.goto(applyHref, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);
      }
      const sub = page.frames().find((f) => f !== page.mainFrame() && /(job_app|greenhouse|ashby|lever)/i.test(f.url()));
      if (sub) targetFrame = sub;
    }
    const fields = await extractFields(targetFrame);
    await page.screenshot({ path: path.join(out, 'form-empty.png'), fullPage: true });
    const form = {
      report: report ? Number(report) : null,
      company: meta.company,
      role: meta.role,
      posting_url: url,
      form_url: page.url(),
      frame_url: targetFrame !== page.mainFrame() ? targetFrame.url() : null,
      ats: target.ats,
      extracted_at: new Date().toISOString(),
      fields,
    };
    fs.writeFileSync(path.join(out, 'form.json'), JSON.stringify(form, null, 2));
    return { out, form };
  } finally { await browser.close(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  extractForm({ report: arg('--report'), url: arg('--url'), out: arg('--out') })
    .then(({ out, form }) => {
      console.log(`${form.ats} ${form.form_url}\n${form.fields.length} fields -> ${out}/form.json`);
      for (const f of form.fields) console.log(`${f.required ? '*' : ' '} [${f.type}] ${f.label.slice(0, 90)}${f.options ? `  {${f.options.length} opts}` : ''}`);
    })
    .catch((e) => { console.error('ERROR', e.message); process.exit(1); });
}
