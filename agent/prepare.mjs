#!/usr/bin/env node
/**
 * prepare.mjs — Phase 3b: prepare an application package and send it to Telegram.
 * NEVER submits. The candidate submits manually from the link.
 *
 *   node prepare.mjs --report 105            # full: extract -> agy answers+CV -> fill+screenshot -> Telegram
 *   node prepare.mjs --report 105 --skip-agy # reuse existing answers.json (e.g. after manual edit)
 *   node prepare.mjs --report 105 --no-telegram
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
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

function agyAnswers(report, outRel, today) {
  const prompt = `You are preparing (NOT submitting) a job application for career-ops report ${report}.
This is an UNATTENDED headless run. Never submit, apply, click Apply, send emails or messages.
Inputs (read them): ${outRel}/form.json (the form fields, exact selectors), the report file reports/${String(report).padStart(3, '0')}-*.md,
cv.md, config/profile.yml, modes/_profile.md (section "Standard Application Form Answers" is binding), modes/_custom.md.
Tasks:
1. Tailored CV PDF: if no output/cv-*.pdf exists for this report/company dated within 7 days, run the career-ops pdf mode for this report
   (EM headline variant for EM/Head roles, PM variant for PM/TPM/Program roles; strictly max 2 pages, A4). Facts only from cv.md.
   Follow modes/_custom.md: omit the Core Competencies section entirely (leave competencies empty/absent in the payload; do not render blue competency tags),
   keep exactly 3 bullet points for each main experience entry, include Technical Product Owner in Earlier Roles as "Activision Blizzard (King)",
   do not list leadership skills as certifications (keep them under Skills), and under Earlier Roles do not output a role title, location or dates in the header.
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
          await loc.fill(String(a.value));
        }
        result.filled.push(a.label);
      } catch (e) { result.errors.push(`${a.label}: ${e.message.split('\n')[0]}`); }
    }
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(out, 'form-filled.png'), fullPage: true });
  } finally { await browser.close(); } // closing discards everything: nothing is submitted
  return result;
}

function summaryText(meta, answers, fill, report) {
  const lines = [`📝 <b>Candidatura preparada</b> (no enviada)`, `<b>${esc(meta.company)}</b> — ${esc(meta.role)}`, `Score <b>${meta.score?.toFixed?.(1)}</b>/5 · informe #${report}`, ''];
  for (const a of answers.answers) {
    if (a.type === 'checkbox' && a.value !== true) continue;
    const v = a.type === 'file' ? (a.value === 'cover' ? '📎 carta' : '📎 CV') : a.type === 'checkbox' ? '☑️' : String(a.value).slice(0, 300);
    lines.push(`${a.needs_review ? '⚠️' : '•'} <b>${esc(a.label.slice(0, 90))}</b>\n   ${esc(v) || '<i>(vacío)</i>'}${a.needs_review && a.note ? `\n   <i>${esc(a.note.slice(0, 200))}</i>` : ''}`);
  }
  if (answers.warnings?.length) lines.push('', '⚠️ ' + answers.warnings.map(esc).join('\n⚠️ '));
  if (fill.errors.length || fill.skipped.length) lines.push('', `No rellenados: ${esc([...fill.skipped, ...fill.errors].join('; ').slice(0, 600))}`);
  lines.push('', `👉 <a href="${esc(meta.url)}">Abrir oferta</a> — revisa y envía tú (fase 3b).`);
  return lines.join('\n').slice(0, 4000);
}

async function main() {
  const report = arg('--report');
  if (!report) throw new Error('--report N required');
  const meta = parseReport(reportFile(report));
  const outRel = path.join('output', 'applications', String(report).padStart(3, '0'));
  const out = ensureDir(path.join(ROOT, outRel));

  log('1/4 extract form');
  const { form } = await extractForm({ report, out });
  log(`   ${form.ats} ${form.fields.length} fields`);

  if (!has('--skip-agy')) {
    log('2/4 agy: CV + cover + answers');
    agyAnswers(report, outRel, new Date().toISOString().slice(0, 10));
  }
  const answers = JSON.parse(fs.readFileSync(path.join(out, 'answers.json'), 'utf8'));

  log('3/4 fill + screenshot (no submit)');
  const fill = await fillForm(form, answers, out);
  fs.writeFileSync(path.join(out, 'fill-result.json'), JSON.stringify(fill, null, 2));
  log(`   filled=${fill.filled.length} skipped=${fill.skipped.length} errors=${fill.errors.length}`);

  const status = { report: Number(report), state: 'prepared', prepared_at: new Date().toISOString(), form_url: form.form_url };
  fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(status, null, 2));

  const tg = tgConfig(ROOT);
  if (has('--no-telegram') || !tg.enabled) { log('4/4 telegram skipped'); return; }
  log('4/4 telegram');
  await tgSendFile(tg.token, tg.chatId, path.join(out, 'form-filled.png'), { caption: `${meta.company} — ${meta.role}: formulario rellenado (sin enviar)`, kind: 'document' });
  if (answers.cv_pdf && fs.existsSync(path.join(ROOT, answers.cv_pdf))) {
    await tgSendFile(tg.token, tg.chatId, path.join(ROOT, answers.cv_pdf), {
      caption: `📄 <b>CV adaptado — #${report} (${esc(meta.company)})</b>\n\n<i>💡 Para modificar el CV, responde directamente a este archivo con tus cambios (ej: "enfoca más a SRE" o "resalta el proyecto de cloud en King").</i>`,
    });
  }
  
  if (fs.existsSync(path.join(out, 'cover.txt'))) {
    const coverText = fs.readFileSync(path.join(out, 'cover.txt'), 'utf8').trim();
    if (coverText) {
      await tgSend(tg.token, tg.chatId, [
        `✉️ <b>Carta de presentación — #${report} (${esc(meta.company)})</b>`,
        '',
        `<blockquote>${esc(coverText)}</blockquote>`,
        '',
        `<i>💡 Para modificarla, responde directamente a este mensaje con tus cambios (ej: "hazla más corta" o "enfatiza X").</i>`
      ].join('\n'));
    }
  }

  await tgSend(tg.token, tg.chatId, summaryText(meta, answers, fill, report), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '🚀 Enviar candidatura', callback_data: `submit:${report}` },
        ],
        [
          { text: '✏️ Cambiar carta', callback_data: `edit_cover:${report}` },
          { text: '📄 Cambiar CV', callback_data: `edit_cv:${report}` },
        ],
        [
          { text: '📝 La envío yo', callback_data: `manual:${report}` },
          { text: '❌ Descartar', callback_data: `discard:${report}` },
        ]
      ]
    },
  });
}

main().catch((e) => { console.error('[prepare] ERROR', e.message); process.exit(1); });
