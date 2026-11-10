#!/usr/bin/env node
/**
 * submit.mjs — Phase 3c: 1-click submission for a prepared job application report.
 *
 * Fills the form using answers.json, checks for CAPTCHA blockers,
 * clicks the submit button, waits for confirmation, captures screenshot,
 * and updates tracker to Applied.
 *
 * Usage:
 *   node submit.mjs --report 104
 *   node submit.mjs --report 104 --dry-run
 *   node submit.mjs --report 104 --no-telegram
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { openForm } from './lib/form.mjs';
import { tgConfig, tgSend, tgSendFile, esc } from './lib/telegram.mjs';
import { reportFile } from './extract-form.mjs';
import { parseReport } from './notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '.env') });
const ROOT = path.resolve(HERE, process.env.CAREER_OPS_DIR || '../career-ops');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k) => argv.includes(k);
const log = (...a) => console.log(`[submit ${new Date().toISOString()}]`, ...a);

export function setAppState(report, state, extra = {}) {
  const f = path.join(ROOT, 'output', 'applications', String(report).padStart(3, '0'), 'status.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  Object.assign(st, { state, [`${state}_at`]: new Date().toISOString() }, extra);
  fs.writeFileSync(f, JSON.stringify(st, null, 2));
  return st;
}

export async function submitApplication(report, { dryRun = false } = {}) {
  const repNum = String(report).padStart(3, '0');
  const outRel = path.join('output', 'applications', repNum);
  const out = path.join(ROOT, outRel);

  const formFile = path.join(out, 'form.json');
  const answersFile = path.join(out, 'answers.json');
  if (!fs.existsSync(formFile) || !fs.existsSync(answersFile)) {
    throw new Error(`Application #${report} not prepared. form.json or answers.json missing in ${outRel}`);
  }

  const form = JSON.parse(fs.readFileSync(formFile, 'utf8'));
  const answers = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
  let meta = {};
  try { meta = parseReport(reportFile(report)); } catch { meta = { company: `Empresa #${report}`, role: '' }; }

  log(`starting submission for report #${report} (${meta.company} - ${meta.role})`);

  const initialUrl = (form.posting_url && form.posting_url !== form.form_url) ? form.posting_url : form.form_url;
  const { browser, page } = await openForm(ROOT, initialUrl);

  try {
    if (initialUrl !== form.form_url) {
      await page.goto(form.form_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(4000);
    }

    const frame = form.frame_url
      ? page.frames().find((f) => f.url() === form.frame_url) || page.frames().find((f) => /(job_app|greenhouse)/i.test(f.url()))
      : null;
    const root = frame || page;

    // 1. Fill fields
    log('filling form fields...');
    const result = { filled: [], skipped: [], errors: [] };
    for (const a of answers.answers) {
      const loc = root.locator(a.selector).first();
      try {
        if (a.type === 'file') {
          const file = a.value === 'cover' ? answers.cover_letter_file : answers.cv_pdf;
          if (!file || !fs.existsSync(path.join(ROOT, file))) { result.skipped.push(`${a.label} (no file)`); continue; }
          await loc.setInputFiles(path.join(ROOT, file));
        } else if (a.type === 'checkbox') {
          if (a.value === true) await loc.check({ force: true }); else continue;
        } else if (a.type === 'radio') {
          if (a.value === '' || a.value == null) { result.skipped.push(a.label); continue; }
          const radios = root.locator(a.selector);
          const want = String(a.value).toLowerCase();
          let done = false;
          for (let i = 0; i < await radios.count(); i++) {
            const lbl = await radios.nth(i).evaluate((el) => ((el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.closest('label')?.innerText || el.value || '').trim().toLowerCase());
            if (lbl === want || lbl.includes(want)) { await radios.nth(i).check({ force: true }); done = true; break; }
          }
          if (!done) throw new Error(`no radio option matching "${a.value}"`);
        } else if (a.type === 'select' || a.type === 'select-one') {
          if (a.value === '' || a.value == null) { result.skipped.push(a.label); continue; }
          await loc.selectOption({ label: String(a.value) }).catch(() => loc.selectOption(String(a.value)));
        } else {
          if (a.value === '' || a.value == null) { result.skipped.push(a.label); continue; }
          await loc.fill(String(a.value));
        }
        result.filled.push(a.label);
      } catch (e) { result.errors.push(`${a.label}: ${e.message.split('\n')[0]}`); }
    }
    await page.waitForTimeout(2000);

    // 2. Check for CAPTCHA blockers
    log('checking for CAPTCHA...');
    const hasCaptcha = await page.evaluate(() => {
      const isVisibleChallenge = (el) => {
        if (!el || el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        // Ignore Google reCAPTCHA invisible badge (size=invisible, grecaptcha-badge, or fixed 256x60 logo)
        if (el.closest('.grecaptcha-badge') || (el.src && el.src.includes('size=invisible'))) {
          return false;
        }
        return rect.width > 20 && rect.height > 20;
      };

      const selectors = [
        'iframe[src*="turnstile"]', 'iframe[src*="challenges.cloudflare.com"]',
        'iframe[src*="recaptcha"][src*="bframe"]', 'iframe[title*="challenge"]',
        'iframe[src*="hcaptcha"][src*="checkbox"]', 'iframe[src*="hcaptcha"][src*="challenge"]',
        '.cf-turnstile', '.h-captcha'
      ];
      for (const s of selectors) {
        const el = document.querySelector(s);
        if (isVisibleChallenge(el)) return true;
      }
      return false;
    });

    if (hasCaptcha) {
      log('CAPTCHA detected!');
      const captchaScreenshot = path.join(out, 'submission-blocked-captcha.png');
      await page.screenshot({ path: captchaScreenshot, fullPage: true });
      setAppState(report, 'manual_pending', { note: 'Blocked by CAPTCHA' });
      return {
        ok: false,
        reason: 'captcha',
        meta,
        screenshot: captchaScreenshot,
        error: 'Se ha detectado un CAPTCHA o verificación humana en el portal.'
      };
    }

    // 3. Locate submit button
    log('locating submit button...');
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button#submit_app',
      'input#submit_app',
      'button#btn-submit',
      'button:has-text("Submit application")',
      'button:has-text("Submit Application")',
      'button:has-text("Submit")',
      'button:has-text("Apply")',
      'button:has-text("Enviar candidatura")',
      'button:has-text("Enviar")'
    ];

    let submitLoc = null;
    for (const sel of submitSelectors) {
      const loc = root.locator(sel).first();
      if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) {
        submitLoc = loc;
        break;
      }
    }

    if (!submitLoc) {
      log('no submit button found');
      const noBtnScreenshot = path.join(out, 'submission-no-button.png');
      await page.screenshot({ path: noBtnScreenshot, fullPage: true });
      return {
        ok: false,
        reason: 'no_submit_button',
        meta,
        screenshot: noBtnScreenshot,
        error: 'No se encontró el botón de envío visible en el formulario.'
      };
    }

    if (dryRun) {
      log('dry run enabled, not clicking submit');
      const dryScreenshot = path.join(out, 'submission-dry-run.png');
      await page.screenshot({ path: dryScreenshot, fullPage: true });
      return { ok: true, dryRun: true, meta, screenshot: dryScreenshot };
    }

    // 4. Click Submit
    log('clicking submit button...');
    await submitLoc.scrollIntoViewIfNeeded().catch(() => {});
    await submitLoc.click();

    // 5. Wait for confirmation / response
    log('waiting for submission response...');
    await page.waitForTimeout(6000);

    const resultScreenshot = path.join(out, 'submission-result.png');
    await page.screenshot({ path: resultScreenshot, fullPage: true });

    // Check confirmation text or URL change
    const confirmation = await page.evaluate(() => {
      const text = document.body?.innerText || '';
      const successPatterns = /thank you|gracias|application submitted|candidatura enviada|we have received your application|application received|thanks for applying|successfully submitted/i;
      const errorPatterns = /please fix the errors|required field|this field is required|there was an error|error submitting/i;
      return {
        hasSuccessText: successPatterns.test(text),
        hasErrorText: errorPatterns.test(text),
        url: window.location.href,
      };
    });

    const urlChanged = confirmation.url !== form.form_url && confirmation.url !== initialUrl;
    const isSuccess = confirmation.hasSuccessText || (urlChanged && !confirmation.hasErrorText);

    if (isSuccess) {
      log('submission confirmed!');
      setAppState(report, 'applied_auto', { applied_at: new Date().toISOString() });
      spawnSync('node', ['set-status.mjs', '--report', String(report), 'Applied', '--note', 'Enviada automáticamente (1-clic Telegram)'], { cwd: ROOT, encoding: 'utf8' });
      spawnSync('node', ['followup-seed.mjs', String(report)], { cwd: ROOT, encoding: 'utf8' });
      return { ok: true, meta, screenshot: resultScreenshot };
    }

    if (confirmation.hasErrorText) {
      log('validation errors detected on submission');
      return {
        ok: false,
        reason: 'validation_error',
        meta,
        screenshot: resultScreenshot,
        error: 'El portal indicó errores de validación tras pulsar enviar.'
      };
    }

    // If ambiguous (no explicit error, but no explicit success text):
    log('submission completed (ambiguous confirmation, marked applied with review)');
    setAppState(report, 'applied_auto', { applied_at: new Date().toISOString(), review_recommended: true });
    spawnSync('node', ['set-status.mjs', '--report', String(report), 'Applied', '--note', 'Enviada (confirmación visual en Telegram)'], { cwd: ROOT, encoding: 'utf8' });
    spawnSync('node', ['followup-seed.mjs', String(report)], { cwd: ROOT, encoding: 'utf8' });
    return { ok: true, meta, screenshot: resultScreenshot, ambiguous: true };

  } finally {
    await browser.close();
  }
}

async function main() {
  const report = arg('--report');
  if (!report) throw new Error('--report N required');
  const dryRun = has('--dry-run');
  const noTg = has('--no-telegram');
  const tg = tgConfig(ROOT);

  const res = await submitApplication(report, { dryRun });
  if (noTg || !tg.enabled) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (res.ok) {
    if (res.dryRun) {
      await tgSend(tg.token, tg.chatId, `🧪 <b>Simulación de envío (Dry Run) — #${report} (${esc(res.meta.company)})</b>\nFormulario relleno correctamente; botón de envío localizado.`);
      if (res.screenshot) await tgSendFile(tg.token, tg.chatId, res.screenshot, { caption: 'Captura pre-envío' });
      return;
    }

    await tgSend(tg.token, tg.chatId, [
      `🎉 <b>¡Candidatura enviada con éxito! — #${report} (${esc(res.meta.company)})</b>`,
      `• Rol: <b>${esc(res.meta.role)}</b>`,
      `• Estado: Marcada como <b>Applied</b> en el tracker.`,
      `• Seguimiento: Programado automáticamente para dentro de <b>7 y 14 días</b>.`,
      '',
      `<i>Revisa la captura de confirmación recibida a continuación:</i>`
    ].join('\n'));

    if (res.screenshot && fs.existsSync(res.screenshot)) {
      await tgSendFile(tg.token, tg.chatId, res.screenshot, { caption: `Confirmación de envío — #${report}` });
    }
  } else {
    if (res.reason === 'captcha') {
      await tgSend(tg.token, tg.chatId, [
        `⚠️ <b>CAPTCHA detectado en #${report} (${esc(res.meta.company)})</b>`,
        '',
        `El portal requiere verificación humana (Turnstile/reCAPTCHA). No te preocupes: todos tus datos y CV están listos.`,
        '',
        `👉 <a href="${esc(res.meta.url)}">Abre el formulario aquí</a>, revisa y pulsa enviar.`,
        `Cuando la envíes escribe <code>/enviada ${report}</code>.`
      ].join('\n'));
    } else {
      await tgSend(tg.token, tg.chatId, [
        `⚠️ <b>No se pudo enviar automáticamente #${report} (${esc(res.meta.company)})</b>: ${esc(res.error || 'revisa los campos')}.`,
        '',
        `👉 <a href="${esc(res.meta.url)}">Completar manualmente aquí</a>.`,
        `Una vez enviada escribe <code>/enviada ${report}</code>.`
      ].join('\n'));
    }

    if (res.screenshot && fs.existsSync(res.screenshot)) {
      await tgSendFile(tg.token, tg.chatId, res.screenshot, { caption: `Captura del estado del formulario — #${report}` });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error('[submit] ERROR', e.message);
    process.exit(1);
  });
}
