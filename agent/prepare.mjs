#!/usr/bin/env node
/**
 * prepare.mjs — Phase 3b: prepare an application package and send it to Telegram.
 * NEVER submits. The candidate submits manually from the link.
 *
 *   node prepare.mjs --report 105            # full: extract -> agy answers+CV -> fill+screenshot -> Telegram
 *   node prepare.mjs --report 105 --skip-agy # reuse existing answers.json (e.g. after manual edit)
 *   node prepare.mjs --report 105 --no-telegram
 *   node prepare.mjs --report 105 --resend   # only re-send the copy-paste pack (CV, cover, answers) to Telegram
 *
 * The Telegram pack is built for manual copy-paste: CV PDF, cover letter and every form answer as tap-to-copy blocks.
 * If the portal blocks the form (e.g. WTTJ/CloudFront 403), agy answers the usual portal questions instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import yaml from 'js-yaml';
import { openForm, ensureDir } from './lib/form.mjs';
import { tgConfig, tgSend, tgSendFile, esc } from './lib/telegram.mjs';
import { extractForm, reportFile } from './extract-form.mjs';
import { parseReport } from './notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '.env') });
const ROOT = path.resolve(HERE, process.env.CAREER_OPS_DIR || '../career-ops');
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const has = (k) => argv.includes(k);
const log = (...a) => console.log(`[prepare ${new Date().toISOString()}]`, ...a);

function agyAnswers(report, outRel, today, noForm = false) {
  const prompt = noForm ? noFormPrompt(report, outRel, today) : `You are preparing (NOT submitting) a job application for career-ops report ${report}.
This is an UNATTENDED headless run. Never submit, apply, click Apply, send emails or messages.
Inputs (read them): ${outRel}/form.json (the form fields, exact selectors), the report file reports/${String(report).padStart(3, '0')}-*.md,
cv.md, config/profile.yml, modes/_profile.md (section "Standard Application Form Answers" is binding), modes/_custom.md.
Tasks:
${cvTask()}
2. Write ${outRel}/cover.txt: short, simple cover letter in English, 120-180 words, only cv.md facts, no invented metrics.
3. Write ${outRel}/answers.json with EXACTLY this shape:
   {"cv_pdf":"<path relative to career-ops root>","cover_letter_file":"${outRel}/cover.txt",
    "answers":[{"selector":"<copy from form.json>","type":"<copy>","label":"<copy>","value":<string|number|boolean>,
                "source":"standard|profile|cv|generated","needs_review":<bool>,"note":"<why, if needs_review>"}],
    "warnings":["..."]}
   - One entry per form.json field. For checkbox use true/false. For file fields use "cv" (resume) or "cover" (cover letter).
   - Candidate email: always use jorge.penacotarelo@gmail.com (never hotmail).
   - Start date: application date is ${today}; answer = ${today} + 1 day + 15 days, written as a concrete date plus "(15 days notice)".
   - Salary: 75000 (number fields) or "€75,000 gross/year" (text). Never below 65000.
   - Diversity/EEO/disability/gender/ethnicity: "Prefer not to say" (or the closest option) and needs_review=false.
   - Referral/connection questions: answer that Jorge knows nobody at the company, needs_review=true (he may know someone).
   - Privacy/consent checkboxes required to apply: true, needs_review=true.
   - Anything not supported by cv.md/profile/_profile.md: leave value "" and needs_review=true with a note. Never invent facts.
Use your native file-writing tool for files (no shell redirection). Do not edit cv.md, config/, modes/ or portals.yml.
End with one line: answers_ready=<true|false>.`;
  const agyArgs = ['-p', prompt, '--output-format', 'stream-json'];
  if (process.env.AGY_MODEL) agyArgs.push('--model', process.env.AGY_MODEL);
  const r = spawnSync(process.env.AGY_BIN || 'agy', agyArgs, {
    cwd: ROOT, encoding: 'utf8', timeout: Number(process.env.AGY_TIMEOUT_SECONDS || 3600) * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(ROOT, outRel, 'agy.log'), (r.stdout || '') + '\n' + (r.stderr || ''));
  if (r.status !== 0) throw new Error(`agy exit ${r.status}`);
}

// Prompt used when the portal form could not be read (blocked/undetected): only job-specific, free-text answers.
function noFormPrompt(report, outRel, today) {
  const rep = String(report).padStart(3, '0');
  return `You are preparing (NOT submitting) a job application for career-ops report ${report}. Jorge will paste the answers into the portal by hand.
This is an UNATTENDED headless run. Never submit, apply, send emails or messages. Do not browse the portal (it is blocked).
Application date: ${today}.
Inputs (read them): reports/${rep}-*.md, cv.md, config/profile.yml, modes/_profile.md ("Standard Application Form Answers" is binding), modes/_custom.md.
Do NOT read or copy any other answers.json; write everything fresh for THIS job.
Tasks:
${cvTask()}
2. Write ${outRel}/cover.txt: short, simple cover letter in English, 120-180 words, only cv.md facts, no invented metrics.
3. Write ${outRel}/answers.json with EXACTLY this shape (selector always ""):
   {"cv_pdf":"<path relative to career-ops root>","cover_letter_file":"${outRel}/cover.txt",
    "answers":[{"selector":"","type":"text","label":"<question>","value":"<answer, plain text ready to paste>","source":"profile|cv|generated","needs_review":<bool>,"note":""}],
    "warnings":[]}
   "answers" MUST contain at least these questions (name, email, phone, LinkedIn, location, salary, start date, travel and EEO are added automatically, skip them):
   - "Current company" and "Current job title" (from cv.md)
   - "Years of relevant experience"
   - "Work authorization for <job country>" (per modes/_profile.md; EU vs UK/US/non-EU rules)
   - "Willing to relocate / work model" (hybrid Barcelona, remote Spain, or freelance/contractor; say if the job's location fits)
   - "Why do you want to work at <company>?" (60-90 words, specific to the company and product, needs_review=true)
   - "Why are you a good fit for this role?" (60-90 words, cv.md proof points only, needs_review=true)
   - every explicit application question you find in the report or job description.
   Plain text only, no markdown. Never invent facts; if unsure leave value "" and needs_review=true with a note.
Use your native file-writing tool for files (no shell redirection). Do not edit cv.md, config/, modes/ or portals.yml.
End with one line: answers_ready=<true|false>.`;
}

// CV instructions shared by both prompts; layout mirrors modes/_custom.md "CV formatting rules".
function cvTask() {
  return `1. Tailored CV PDF: if no output/cv-*.pdf exists for this report/company dated within 7 days, run the career-ops pdf mode for this report
   (EM headline variant for EM/Head roles, PM variant for PM/TPM/Program roles; A4, EXACTLY 2 pages, never 3). Facts only from cv.md.
   Layout is binding (modes/_custom.md "CV formatting rules"):
   - Page 1: header, professional summary and work experience. The longest-tenure role is the most developed one
     (up to 5 bullets); the other main roles exactly 3 bullets; then "Earlier Roles" (no title, location or dates in its header;
     Technical Product Owner listed as "Activision Blizzard (King)"). Everything on page 1 must fit page 1.
   - Page break strictly before Education. Page 2: Education, Certifications (formal only), Skills (leadership/soft skills here), About Me.
   - Omit the Core Competencies section entirely (no competencies in the payload, no blue blocks).`;
}

// Deterministic answers to the questions every portal asks (config/profile.yml + modes/_profile.md rules).
function standardAnswers(today) {
  let c = {};
  try { c = yaml.load(fs.readFileSync(path.join(ROOT, 'config', 'profile.yml'), 'utf8'))?.candidate || {}; } catch {}
  const [first, ...rest] = String(c.full_name || '').split(/\s+/);
  const start = new Date(Date.parse(today) + 16 * 864e5).toISOString().slice(0, 10);
  const li = c.linkedin ? (/^https?:/.test(c.linkedin) ? c.linkedin : `https://${c.linkedin}`) : '';
  const q = (label, value, source = 'profile') => ({ selector: '', type: 'text', label, value, source, needs_review: false, note: '' });
  return [
    q('First name', first || ''),
    q('Last name', rest.join(' ')),
    q('Email', 'jorge.penacotarelo@gmail.com'),
    q('Phone', c.phone || ''),
    q('LinkedIn', li),
    q('Location', c.location || ''),
    q('Salary expectation', '€75,000 gross/year', 'standard'),
    q('Start date / notice period', `${start} (15 days notice)`, 'standard'),
    q('Willing to travel', 'Yes', 'standard'),
    q('Gender / ethnicity / disability (EEO)', 'Prefer not to say', 'standard'),
  ].filter((a) => a.value);
}

async function fillForm(form, answers, out) {
  const initialUrl = (form.posting_url && form.posting_url !== form.form_url) ? form.posting_url : form.form_url;
  const { browser, page } = await openForm(ROOT, initialUrl);
  if (initialUrl !== form.form_url) {
    await page.goto(form.form_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(4000);
  }
  const result = { filled: [], skipped: [], errors: [] };
  try {
    const frame = form.frame_url
      ? page.frames().find((f) => f.url() === form.frame_url) || page.frames().find((f) => /(job_app|greenhouse)/i.test(f.url()))
      : null;
    const root = frame || page;
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
          const isCombobox = await loc.evaluate((el) => el.getAttribute('role') === 'combobox' || el.classList.contains('select__input')).catch(() => false);
          if (isCombobox) {
            await loc.focus();
            await loc.pressSequentially(String(a.value).trim(), { delay: 40 });
            await page.waitForTimeout(300);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(200);
          } else {
            await loc.fill(String(a.value));
          }
        }
        result.filled.push(a.label);
      } catch (e) { result.errors.push(`${a.label}: ${e.message.split('\n')[0]}`); }
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, 'form-filled.png'), fullPage: true });
  } finally { await browser.close(); } // closing discards everything: nothing is submitted
  return result;
}

async function main() {
  const report = arg('--report');
  if (!report) throw new Error('--report N required');
  const meta = parseReport(reportFile(report));
  const outRel = path.join('output', 'applications', String(report).padStart(3, '0'));
  const out = ensureDir(path.join(ROOT, outRel));

  if (has('--resend')) return sendPack(report, meta, outRel, out);
  const today = new Date().toISOString().slice(0, 10);

  log('1/4 extract form');
  let form;
  try {
    ({ form } = await extractForm({ report, out }));
  } catch (e) {
    log('   extract failed (continuing without form):', e.message);
    form = { report: Number(report), company: meta.company, role: meta.role, posting_url: meta.url, form_url: meta.url, ats: 'unknown', fields: [], error: e.message };
    fs.writeFileSync(path.join(out, 'form.json'), JSON.stringify(form, null, 2));
  }
  log(`   ${form.ats} ${form.fields.length} fields`);

  if (!has('--skip-agy')) {
    log('2/4 agy: CV + cover + answers');
    fs.rmSync(path.join(out, 'answers.json'), { force: true }); // never let agy copy a stale answer file
    agyAnswers(report, outRel, today, form.fields.length === 0);
  }
  const answers = JSON.parse(fs.readFileSync(path.join(out, 'answers.json'), 'utf8'));
  if (!form.fields.length) {
    // Portal not readable: prepend deterministic standard answers to agy's job-specific ones.
    const seen = new Set((answers.answers || []).map((a) => String(a.label).toLowerCase()));
    answers.answers = [...standardAnswers(today).filter((a) => !seen.has(a.label.toLowerCase())), ...(answers.answers || [])];
    fs.writeFileSync(path.join(out, 'answers.json'), JSON.stringify(answers, null, 2));
  }

  let fill = { filled: [], skipped: [], errors: [] };
  if (form.fields.length && (answers.answers || []).some((a) => a.selector)) {
    log('3/4 fill + screenshot (no submit)');
    try { fill = await fillForm(form, answers, out); } catch (e) { log('   fill failed:', e.message); fill.errors.push(e.message.split('\n')[0]); }
  } else log('3/4 fill skipped (no form fields)');
  fs.writeFileSync(path.join(out, 'fill-result.json'), JSON.stringify(fill, null, 2));
  log(`   filled=${fill.filled.length} skipped=${fill.skipped.length} errors=${fill.errors.length}`);

  const status = { report: Number(report), state: 'prepared', prepared_at: new Date().toISOString(), form_url: form.form_url };
  fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(status, null, 2));

  if (has('--no-telegram')) { log('4/4 telegram skipped'); return; }
  await sendPack(report, meta, outRel, out);
}

// ---------- copy-paste pack for Telegram ----------
const COPY_INLINE_MAX = 120;

function answerBlock(a) {
  const label = esc(String(a.label || '').trim().slice(0, 120));
  const warn = a.needs_review ? '⚠️ ' : '';
  const note = a.needs_review && a.note ? `\n<i>${esc(String(a.note).slice(0, 160))}</i>` : '';
  if (a.type === 'checkbox') return a.value === true ? `☑️ Marcar: <b>${label}</b>${note}` : null;
  const v = a.value === undefined || a.value === null ? '' : String(a.value).trim();
  if (!v) return `${warn}<b>${label}</b>\n<i>(en blanco — contéstala tú)</i>${note}`;
  const body = v.length <= COPY_INLINE_MAX && !v.includes('\n') ? `<code>${esc(v)}</code>` : `<pre>${esc(v)}</pre>`;
  return `${warn}<b>${label}</b>\n${body}${note}`;
}

function chunk(blocks, header, max = 3500) {
  const msgs = [];
  let cur = header;
  for (const b of blocks) {
    if ((cur + '\n\n' + b).length > max && cur !== header) { msgs.push(cur); cur = header.replace(/\)?<\/b>$/, ' (cont.)</b>'); }
    cur += '\n\n' + b;
  }
  msgs.push(cur);
  return msgs;
}

async function sendPack(report, meta, outRel, out) {
  const tg = tgConfig(ROOT);
  if (!tg.enabled) { log('4/4 telegram not configured'); return; }
  log('4/4 telegram pack');
  const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(out, f), 'utf8')); } catch { return null; } };
  const answers = read('answers.json') || { answers: [] };
  const form = read('form.json') || { fields: [] };
  const canAuto = form.fields?.length > 0;
  const send = (text, extra) => tgSend(tg.token, tg.chatId, text, extra);

  await send([
    `📦 <b>Candidatura lista para copiar — #${report} ${esc(meta.company)}</b>`,
    esc(meta.role),
    meta.url ? `👉 <a href="${esc(meta.url)}">Abrir oferta y aplicar</a>` : '',
    canAuto ? '' : '<i>No he podido leer el formulario del portal: te paso las preguntas habituales. Si el portal pregunta algo más, respóndeme con la pregunta.</i>',
  ].filter(Boolean).join('\n'));

  if (answers.cv_pdf && fs.existsSync(path.join(ROOT, answers.cv_pdf))) {
    await tgSendFile(tg.token, tg.chatId, path.join(ROOT, answers.cv_pdf), {
      caption: `📄 <b>CV adaptado — #${report} (${esc(meta.company)})</b>\n<i>Para cambiarlo, responde a este archivo con lo que quieras (ej: "enfoca más a SRE").</i>`,
    });
  }

  const coverText = (() => { try { return fs.readFileSync(path.join(out, 'cover.txt'), 'utf8').trim(); } catch { return ''; } })();
  if (coverText) {
    await send([
      `✉️ <b>Carta de presentación — #${report} (${esc(meta.company)})</b>`,
      '<i>Toca el bloque para copiarla.</i>',
      `<pre>${esc(coverText)}</pre>`,
      '<i>Para modificarla, responde a este mensaje con tus cambios.</i>',
    ].join('\n'));
  }

  const blocks = (answers.answers || []).filter((a) => a.type !== 'file').map(answerBlock).filter(Boolean);
  if (blocks.length) {
    const review = (answers.answers || []).filter((a) => a.needs_review && a.type !== 'file').length;
    const header = `📝 <b>Respuestas del formulario — #${report}</b>\n<i>Toca cada valor para copiarlo.${review ? ` ⚠️ = revísala (${review}).` : ''}</i>`;
    for (const m of chunk(blocks, header)) await send(m);
  }

  const row1 = [{ text: '✅ Ya la he enviado', callback_data: `mark_applied:${report}` }];
  if (canAuto) row1.push({ text: '🤖 Probar envío automático', callback_data: `autosubmit:${report}` });
  await send(`👆 Cuando la envíes, pulsa <b>Ya la he enviado</b> y programo el seguimiento a 7 y 14 días.`, {
    reply_markup: {
      inline_keyboard: [
        row1,
        [
          { text: '✏️ Cambiar carta', callback_data: `edit_cover:${report}` },
          { text: '📄 Cambiar CV', callback_data: `edit_cv:${report}` },
          { text: '❌ Descartar', callback_data: `discard:${report}` },
        ],
      ],
    },
  });
}

main().catch((e) => { console.error('[prepare] ERROR', e.message); process.exit(1); });
