#!/usr/bin/env node
/**
 * bot.mjs — HeadHunter Assistant Telegram bot (long polling daemon).
 *
 * Phase 3a: read-only commands + pairing. Only the paired chat is obeyed.
 *   /start   pair this chat (first chat to send /start becomes the owner; later ones are refused)
 *   /estado  last cycle summary + pending queue
 *   /top     best evaluated offers of the last 7 days
 *   /cola    pending offers in Spain/Barcelona at the head of the queue
 *   /ayuda   help
 *
 * Never applies or submits anything. Untrusted input: chat text is never executed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { tgConfig, tgCall, tgSend, tgSendFile, esc } from './lib/telegram.mjs';
import { parseReport } from './notify.mjs';
import { spawnSync } from 'node:child_process';
import { submitApplication } from './submit.mjs';
import { getFollowupData, checkAndSendFollowupAlerts, recordFollowupDone } from './lib/followup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '.env') });
const ROOT = path.resolve(HERE, process.env.CAREER_OPS_DIR || '../career-ops');
const LOG_DIR = path.join(HERE, 'logs');
const log = (...a) => console.log(`[bot ${new Date().toISOString()}]`, ...a);

let cfg = tgConfig(ROOT);
if (!cfg.token) { console.error('TELEGRAM_BOT_TOKEN missing in agent/.env'); process.exit(1); }

function pair(chatId, from) {
  fs.writeFileSync(cfg.stateFile, JSON.stringify({ chat_id: chatId, paired_at: new Date().toISOString(), username: from?.username || null }, null, 2));
  cfg = tgConfig(ROOT);
}

function pendingLines() {
  try {
    return fs.readFileSync(path.join(ROOT, 'data', 'pipeline.md'), 'utf8').split('\n').filter((l) => /^- \[ \]/.test(l));
  } catch { return []; }
}

function lastCycleSummary() {
  const files = fs.existsSync(LOG_DIR) ? fs.readdirSync(LOG_DIR).filter((f) => /^cycle-.*\.log$/.test(f)).sort() : [];
  if (!files.length) return 'Sin ciclos todavía.';
  const lines = fs.readFileSync(path.join(LOG_DIR, files.at(-1)), 'utf8').split('\n').filter((l) => /^\[\d{4}-/.test(l));
  const start = lines.map((l, i) => (l.includes('=== cycle start') ? i : -1)).filter((i) => i >= 0).at(-1) ?? 0;
  return lines.slice(start).join('\n');
}

function recentReports(days = 7) {
  const dir = path.join(ROOT, 'reports');
  const since = Date.now() - days * 864e5;
  return fs.readdirSync(dir)
    .filter((f) => /^\d+-.+\.md$/.test(f) && !/RESERVED/i.test(f))
    .filter((f) => fs.statSync(path.join(dir, f)).mtimeMs >= since)
    .map((f) => parseReport(path.join(dir, f)))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function extractReportNumber(msg) {
  const text = (msg.text || '').trim();
  const explicitMatch = text.match(/^(?:apply|enviar|preparar|submit|mandar)\s+(\d+)\b/i);
  if (explicitMatch) return explicitMatch[1].replace(/^0+/, '');

  if (!msg.reply_to_message) return null;

  const kb = msg.reply_to_message?.reply_markup?.inline_keyboard || [];
  for (const row of kb) {
    for (const btn of row) {
      const m = (btn.callback_data || '').match(/(?:submit|apply|discard|prep):(\d+)/);
      if (m) return m[1].replace(/^0+/, '');
    }
  }

  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';
  if (!replyText) return null;

  const mReports = replyText.match(/reports\/(\d+)-/);
  if (mReports) return mReports[1].replace(/^0+/, '');

  const mHeader = replyText.match(/🎯\s*#(\d+)/);
  if (mHeader) return mHeader[1].replace(/^0+/, '');

  const mInfo = replyText.match(/(?:informe|candidatura)\s*#?(\d+)/i);
  if (mInfo) return mInfo[1].replace(/^0+/, '');

  // Strip Archetype labels like "(Primary #1)" or "(Secondary #2)" before matching #<num>
  const cleanText = replyText.replace(/\b(?:Primary|Secondary)\s+#\d+\b/gi, '');
  const mHash = cleanText.match(/#(\d+)/);
  if (mHash) return mHash[1].replace(/^0+/, '');

  // Fallback by company name from header
  const titleMatch = replyText.match(/🎯\s*(?:#\d+\s+)?([A-Za-z0-9_-]+)/);
  if (titleMatch) {
    const company = titleMatch[1].toLowerCase();
    try {
      const matchingFiles = fs.readdirSync(path.join(ROOT, 'reports'))
        .filter((f) => f.toLowerCase().includes(company) && f.endsWith('.md'))
        .sort()
        .reverse();
      if (matchingFiles.length > 0) {
        const m = matchingFiles[0].match(/^(\d+)-/);
        if (m) return m[1].replace(/^0+/, '');
      }
    } catch {}
  }

  return null;
}

async function handle(msg) {
  const chatId = String(msg.chat.id);
  const text = (msg.text || '').trim();
  const cmd = text.split(/\s+/)[0].replace(/@.*$/, '').toLowerCase();

  if (cmd === '/start') {
    if (!cfg.chatId) {
      pair(chatId, msg.from);
      log('paired with chat', chatId);
      return tgSend(cfg.token, chatId, '✅ Emparejado. Soy <b>HeadHunter Assistant</b>; solo responderé a este chat.\nEscribe /ayuda para ver los comandos.');
    }
    if (cfg.chatId !== chatId) { log('refused /start from foreign chat', chatId); return; }
    return tgSend(cfg.token, chatId, 'Ya estamos emparejados 👍 /ayuda');
  }
  if (cfg.chatId !== chatId) { log('ignored message from foreign chat', chatId); return; }

  const replyText = msg.reply_to_message?.text || msg.reply_to_message?.caption || '';
  const n = extractReportNumber(msg);

  if (text && !text.startsWith('/') && n) {
    const isApplyIntent = /^(?:apply|enviar|enviala|envíala|mándala|mandala|dale|adelante|si|sí|ok|procede|hazlo|confirmo|send|submit)\b/i.test(text.trim());
    if (isApplyIntent) {
      return handleSubmit(n, chatId);
    }

    const isAppliedIntent = /^(?:enviada|mandada|hecho|hecha|ya|lista|listo|done|aplicada|applied)\b/i.test(text.trim());
    if (isAppliedIntent) {
      setAppState(n, 'applied_manual');
      const r = spawnSync('node', ['set-status.mjs', '--report', n, 'Applied', '--note', 'Enviada manualmente (confirmado en Telegram por respuesta)'], { cwd: ROOT, encoding: 'utf8' });
      spawnSync('node', ['followup-seed.mjs', n], { cwd: ROOT, encoding: 'utf8' });
      return tgSend(cfg.token, chatId, r.status === 0
        ? `✅ <b>¡Genial! Candidatura #${n} marcada como Applied.</b>\nSeguimiento programado a los 7 y 14 días.`
        : `No pude actualizar el tracker: ${esc((r.stderr || r.stdout).slice(0, 300))}`);
    }

    const matchCv = replyText.match(/CV (?:adaptado|actualizado)/i) || replyText.match(/\bcv\b/i);
    const matchCover = replyText.match(/Carta de presentación/i);

    if (matchCv) {
      if (/\b(carta|cover)\b/i.test(text) && !/\b(cv|curriculum|currículum)\b/i.test(text)) {
        return rewriteCover(n, text, chatId);
      }
      return rewriteCv(n, text, chatId);
    }
    if (matchCover) {
      if (/\b(cv|curriculum|currículum)\b/i.test(text) && !/\b(carta|cover)\b/i.test(text)) {
        return rewriteCv(n, text, chatId);
      }
      return rewriteCover(n, text, chatId);
    }
    if (/\b(cv|curriculum|currículum|resumen|experiencia|educacion|educación)\b/i.test(text)) {
      return rewriteCv(n, text, chatId);
    }
    return rewriteCover(n, text, chatId);
  }

  const standaloneAppliedMatch = text.match(/^(?:enviada|mandada|aplicada|applied)\s+(\d+)/i) || text.match(/^(?:ya\s+(?:la\s+)?envi[eé])\s+(\d+)/i);
  if (standaloneAppliedMatch) {
    const n = standaloneAppliedMatch[1];
    setAppState(n, 'applied_manual');
    const r = spawnSync('node', ['set-status.mjs', '--report', n, 'Applied', '--note', 'Enviada por Jorge (confirmado en Telegram)'], { cwd: ROOT, encoding: 'utf8' });
    spawnSync('node', ['followup-seed.mjs', n], { cwd: ROOT, encoding: 'utf8' });
    return tgSend(cfg.token, chatId, r.status === 0
      ? `✅ <b>Candidatura #${n} marcada como Applied.</b>\nSeguimiento programado automáticamente para dentro de 7 y 14 días.`
      : `No pude actualizar el tracker: ${esc((r.stderr || r.stdout).slice(0, 300))}`);
  }

  switch (cmd) {
    case '/estado': {
      const pend = pendingLines().length;
      return tgSend(cfg.token, chatId, `<b>Último ciclo</b>\n<pre>${esc(lastCycleSummary()).slice(0, 3500)}</pre>\nPendientes en cola: <b>${pend}</b>`);
    }
    case '/top': {
      const top = recentReports(7).slice(0, 8);
      if (!top.length) return tgSend(cfg.token, chatId, 'Sin evaluaciones en los últimos 7 días.');
      const body = top.map((r) => `<b>${isNaN(r.score) ? '?' : r.score.toFixed(1)}</b> · ${esc(r.company)} — ${r.url ? `<a href="${esc(r.url)}">${esc(r.role)}</a>` : esc(r.role)} <i>(${esc(r.decision)})</i>`).join('\n');
      return tgSend(cfg.token, chatId, `<b>Top 7 días</b>\n${body}`);
    }
    case '/cola': {
      const all = pendingLines();
      const es = all.filter((l) => /spain|españa|barcelona|madrid|remote/i.test(l)).slice(0, 10)
        .map((l) => l.replace(/^- \[ \]\s*/, '').split('|').slice(1).map((s) => s.trim()).join(' — '));
      return tgSend(cfg.token, chatId, `<b>Cola:</b> ${all.length} pendientes.\nPróximas (España/remoto):\n${esc(es.join('\n')) || '—'}`);
    }
    case '/enviada': {
      const n = text.split(/\s+/)[1];
      if (!/^\d+$/.test(n || '')) return tgSend(cfg.token, chatId, 'Uso: /enviada <nº informe>');
      setAppState(n, 'applied_manual');
      const r = spawnSync('node', ['set-status.mjs', '--report', n, 'Applied', '--note', 'Enviada por Jorge (confirmado en Telegram)'], { cwd: ROOT, encoding: 'utf8' });
      spawnSync('node', ['followup-seed.mjs', n], { cwd: ROOT, encoding: 'utf8' });
      return tgSend(cfg.token, chatId, r.status === 0 ? `✅ Informe #${n} marcado como Applied. Seguimiento programado a los 7 y 14 días.` : `No pude actualizar el tracker: ${esc((r.stderr || r.stdout).slice(0, 300))}`);
    }
    case '/enviar': {
      const n = text.split(/\s+/)[1];
      if (!/^\d+$/.test(n || '')) return tgSend(cfg.token, chatId, 'Uso: <code>/enviar &lt;nº informe&gt;</code>\nEjemplo: <code>/enviar 104</code>');
      return handleSubmit(n, chatId);
    }
    case '/preparar': {
      const parts = text.split(/\s+/);
      const n = parts[1];
      if (!/^\d+$/.test(n || '')) return tgSend(cfg.token, chatId, 'Uso: <code>/preparar &lt;nº informe&gt;</code>\nEjemplo: <code>/preparar 146</code>');
      let meta = {};
      try { meta = parseReport(reportFile(n)); } catch { meta = { company: `Empresa #${n}`, role: '' }; }
      await tgSend(cfg.token, chatId, `⏳ <b>Preparando candidatura #${n} (${esc(meta.company)})...</b>\nExtrayendo formulario, adaptando CV y carta con agy (1-2 minutos en DietPi)...`);
      const prep = spawnSync('node', ['prepare.mjs', '--report', String(n)], { cwd: HERE, encoding: 'utf8', timeout: 3600000 });
      if (prep.status !== 0) {
        return tgSend(cfg.token, chatId, `⚠️ Error al preparar #${n}: ${esc((prep.stderr || prep.stdout || '').slice(0, 300))}`);
      }
      return;
    }
    case '/seguimiento': {
      let data = null;
      try {
        data = getFollowupData(ROOT);
      } catch (e) {
        return tgSend(cfg.token, chatId, `Error al consultar seguimiento: ${esc(e.message)}`);
      }
      const entries = data.entries || [];
      if (!entries.length) {
        return tgSend(cfg.token, chatId, 'No hay candidaturas activas que requieran seguimiento.');
      }
      const lines = [
        `📋 <b>Seguimiento de candidaturas (${entries.length} activa${entries.length > 1 ? 's' : ''})</b>`,
        ''
      ];
      for (const e of entries) {
        const days = e.daysSinceApplication ?? '?';
        let badge = '⏳ En espera';
        if (e.urgency === 'urgent') badge = '🚨 URGENTE';
        else if (e.urgency === 'overdue') badge = '⚠️ Vencido';
        else if (e.urgency === 'due') badge = '🔔 Toca seguimiento';

        lines.push(`• <b>#${e.num} ${esc(e.company)}</b> — ${esc(e.role)}`);
        lines.push(`   Estado: <b>${esc(e.status)}</b> · Enviada: hace <b>${days} días</b>`);
        lines.push(`   Seguimiento: ${badge} (F/U realizados: ${e.followupCount || 0})`);
        if (e.nextFollowupDate) lines.push(`   Próxima fecha: <code>${e.nextFollowupDate}</code>`);
        lines.push('');
      }
      lines.push('<i>Usa /contactado &lt;nº&gt; cuando hagas un seguimiento o /enviada &lt;nº&gt; si la enviaste tú.</i>');
      return tgSend(cfg.token, chatId, lines.join('\n'));
    }
    case '/contactado': {
      const parts = text.split(/\s+/);
      const n = parts[1];
      const note = parts.slice(2).join(' ').trim();
      if (!/^\d+$/.test(n || '')) return tgSend(cfg.token, chatId, 'Uso: <code>/contactado &lt;nº informe&gt; [nota]</code>\nEjemplo: <code>/contactado 104 Mensaje a recruiter por LinkedIn</code>');
      const ok = recordFollowupDone(ROOT, n, note);
      return tgSend(cfg.token, chatId, ok ? `✅ Registrado seguimiento para el informe #${n}.` : `No pude actualizar el seguimiento para el informe #${n}.`);
    }
    case '/carta': {
      const parts = text.split(/\s+/);
      const n = parts[1];
      const instructions = parts.slice(2).join(' ').trim();
      if (!/^\d+$/.test(n || '') || !instructions) {
        return tgSend(cfg.token, chatId, 'Uso: <code>/carta &lt;informe&gt; &lt;cambios&gt;</code>\nEjemplo: <code>/carta 104 hazla más corta y resalta Kafka</code>');
      }
      return rewriteCover(n, instructions, chatId);
    }
    case '/cv': {
      const parts = text.split(/\s+/);
      const n = parts[1];
      const instructions = parts.slice(2).join(' ').trim();
      if (!/^\d+$/.test(n || '') || !instructions) {
        return tgSend(cfg.token, chatId, 'Uso: <code>/cv &lt;informe&gt; &lt;cambios&gt;</code>\nEjemplo: <code>/cv 104 enfoca más a SRE y destaca Kubernetes</code>');
      }
      return rewriteCv(n, instructions, chatId);
    }
    case '/ayuda':
    default:
      return tgSend(cfg.token, chatId, [
        '<b>HeadHunter Assistant</b>',
        '/estado — último ciclo y cola',
        '/top — mejores ofertas (7 días)',
        '/cola — próximas ofertas por evaluar',
        '/enviar N — enviar candidatura automáticamente (1 clic)',
        '/carta N &lt;cambios&gt; — pedir a agy que modifique la carta',
        '/cv N &lt;cambios&gt; — pedir a agy que modifique el CV',
        '/enviada N — marcar como Applied la candidatura del informe N',
        '/seguimiento — ver estado y recordatorios a los 7 y 14 días',
        '/contactado N [nota] — registrar seguimiento en LinkedIn/email',
        '',
        '💡 También puedes responder directamente a cualquier mensaje de carta o archivo de CV con los cambios que quieras.',
        'Las ofertas con nota ≥ 3.8 te llegan aquí con su carta y formulario.',
      ].join('\n'));
  }
}

function reportFile(num) {
  const f = fs.readdirSync(path.join(ROOT, 'reports')).find((x) => x.startsWith(String(num).padStart(3, '0') + '-') && !/RESERVED/.test(x));
  if (!f) throw new Error(`report ${num} not found`);
  return path.join(ROOT, 'reports', f);
}

async function rewriteCover(report, instructions, chatId) {
  const appDirectory = appDir(report);
  const coverFile = path.join(appDirectory, 'cover.txt');
  let currentCover = '';
  try { currentCover = fs.readFileSync(coverFile, 'utf8'); } catch {}
  let meta = {};
  try { meta = parseReport(reportFile(report)); } catch { meta = { company: `Empresa #${report}`, role: '' }; }

  await tgSend(cfg.token, chatId, `✍️ Reescribiendo carta de presentación para #${report} (${esc(meta.company)})...\nInstrucción: <i>${esc(instructions)}</i>`);

  const prompt = `You are updating the cover letter for job application report ${report} (${meta.company} - ${meta.role}).
Inputs:
- Current cover letter in output/applications/${String(report).padStart(3, '0')}/cover.txt:
"""${currentCover}"""
- User revision request:
"""${instructions}"""
- Profile / facts: cv.md, config/profile.yml, modes/_profile.md.

Task:
Rewrite output/applications/${String(report).padStart(3, '0')}/cover.txt applying the user's revision request.
Rules:
1. 120-180 words, professional English, high impact.
2. Facts strictly from cv.md only. Never invent facts.
3. Write ONLY the text of the new cover letter to output/applications/${String(report).padStart(3, '0')}/cover.txt using your write tool.
End with: cover_ready=true`;

  const agyArgs = ['-p', prompt];
  if (process.env.AGY_MODEL) agyArgs.push('--model', process.env.AGY_MODEL);
  const r = spawnSync(process.env.AGY_BIN || 'agy', agyArgs, {
    cwd: ROOT, encoding: 'utf8', timeout: 300000,
  });

  if (r.status !== 0 || !fs.existsSync(coverFile)) {
    return tgSend(cfg.token, chatId, `⚠️ Error al reescribir con agy: ${esc((r.stderr || r.stdout || '').slice(0, 300))}`);
  }

  const newCover = fs.readFileSync(coverFile, 'utf8').trim();

  // Re-run form fill in background to update form-filled.png if needed
  spawnSync('node', ['prepare.mjs', '--report', String(report), '--skip-agy', '--no-telegram'], { cwd: HERE, encoding: 'utf8' });

  return tgSend(cfg.token, chatId, [
    `✉️ <b>Carta de presentación actualizada — #${report} (${esc(meta.company)})</b>`,
    '',
    `<blockquote>${esc(newCover)}</blockquote>`,
    '',
    `<i>💡 Si quieres más cambios, vuelve a responder. Si te parece bien:</i>`
  ].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '✏️ Más cambios carta', callback_data: `edit_cover:${report}` },
          { text: '📄 Cambiar CV', callback_data: `edit_cv:${report}` },
        ],
        [
          { text: '📝 La envío yo', callback_data: `manual:${report}` },
          { text: '❌ Descartar', callback_data: `discard:${report}` }
        ]
      ]
    }
  });
}

async function rewriteCv(report, instructions, chatId) {
  const repNum = String(report).padStart(3, '0');
  const appDirectory = appDir(report);
  const answersFile = path.join(appDirectory, 'answers.json');
  let currentCv = '';
  let answersData = null;
  if (fs.existsSync(answersFile)) {
    try {
      answersData = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
      if (answersData.cv_pdf) currentCv = answersData.cv_pdf;
    } catch {}
  }
  let meta = {};
  let repPath = '';
  try {
    repPath = reportFile(report);
    meta = parseReport(repPath);
  } catch {
    meta = { company: `Empresa #${report}`, role: '' };
  }

  await tgSend(cfg.token, chatId, `✍️ Adaptando CV para #${report} (${esc(meta.company)})...\nInstrucción: <i>${esc(instructions)}</i>`);

  const today = new Date().toISOString().slice(0, 10);
  const prompt = `You are adapting/updating the tailored CV for job application report ${report} (${meta.company} - ${meta.role}).
Inputs:
- Job report: ${repPath ? path.relative(ROOT, repPath) : `reports/${repNum}-*.md`}
- Current CV PDF: ${currentCv || 'none'}
- User revision request:
"""${instructions}"""
- Profile / facts: cv.md, config/profile.yml, modes/_profile.md, modes/_custom.md.

Task:
Re-tailor the CV for this application, applying the user's revision request.
Rules:
1. Strictly max 2 pages A4.
2. Facts strictly from cv.md only. Never invent facts or metrics.
3. Candidate contact email must be jorge.penacotarelo@gmail.com.
4. Follow modes/_custom.md: omit the Core Competencies section entirely (leave competencies empty/absent in the payload; do not render blue competency blocks),
   keep exactly 3 bullet points for each main experience entry, include Technical Product Owner in Earlier Roles as "Activision Blizzard (King)",
   keep certifications strictly formal (leadership/soft skills belong under Skills),
   and under Earlier Roles do not output a role title, location, or dates in the header.
5. Generate the tailored HTML using build-cv-html.mjs and render the PDF using generate-pdf.mjs with --report=${report} --format=a4.
   Write the output PDF to output/cv-jorge-pena-cotarelo-${report}-${meta.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${today}.pdf (or similar path under output/).
6. Update ${path.relative(ROOT, answersFile)}: set "cv_pdf" to the path of the new PDF relative to career-ops root.
End with: cv_ready=true`;

  const agyArgs = ['-p', prompt];
  if (process.env.AGY_MODEL) agyArgs.push('--model', process.env.AGY_MODEL);
  const r = spawnSync(process.env.AGY_BIN || 'agy', agyArgs, {
    cwd: ROOT, encoding: 'utf8', timeout: Number(process.env.AGY_TIMEOUT_SECONDS || 3600) * 1000,
  });

  // Re-read answers.json to find the updated cv_pdf
  let newPdfRel = '';
  if (fs.existsSync(answersFile)) {
    try {
      const updatedAnswers = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
      if (updatedAnswers.cv_pdf && fs.existsSync(path.join(ROOT, updatedAnswers.cv_pdf))) {
        newPdfRel = updatedAnswers.cv_pdf;
      }
    } catch {}
  }

  // Fallback: check pdf-index.tsv or output/ directory
  if (!newPdfRel) {
    try {
      const idx = fs.readFileSync(path.join(ROOT, 'data', 'pdf-index.tsv'), 'utf8');
      const lines = idx.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const parts = lines[i].split('\t');
        if (parts[0] === repNum || parts[0] === String(report)) {
          if (parts[1] && fs.existsSync(path.join(ROOT, parts[1]))) {
            newPdfRel = parts[1];
            break;
          }
        }
      }
    } catch {}
  }

  // If still not found, check output/ for any cv matching this report
  if (!newPdfRel) {
    try {
      const outFiles = fs.readdirSync(path.join(ROOT, 'output'));
      const matching = outFiles.filter((f) => f.includes(`-${report}-`) && f.endsWith('.pdf'))
        .map((f) => ({ name: f, mtime: fs.statSync(path.join(ROOT, 'output', f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (matching.length > 0) {
        newPdfRel = path.join('output', matching[0].name);
      }
    } catch {}
  }

  if (r.status !== 0 || !newPdfRel) {
    return tgSend(cfg.token, chatId, `⚠️ Error al adaptar el CV con agy: ${esc((r.stderr || r.stdout || '').slice(0, 300))}`);
  }

  // Make sure answers.json has the updated cv_pdf
  if (fs.existsSync(answersFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(answersFile, 'utf8'));
      if (data.cv_pdf !== newPdfRel) {
        data.cv_pdf = newPdfRel;
        fs.writeFileSync(answersFile, JSON.stringify(data, null, 2));
      }
    } catch {}
  }

  const absPdf = path.join(ROOT, newPdfRel);

  // Send the new PDF to Telegram
  await tgSendFile(cfg.token, chatId, absPdf, {
    caption: `📄 <b>CV actualizado — #${report} (${esc(meta.company)})</b>\n\n<i>💡 Para más cambios, responde directamente a este archivo o escribe /cv ${report} &lt;cambios&gt;.</i>`,
  });

  // Re-run form fill in background to update form-filled.png with the new CV file attached
  spawnSync('node', ['prepare.mjs', '--report', String(report), '--skip-agy', '--no-telegram'], { cwd: HERE, encoding: 'utf8' });

  return tgSend(cfg.token, chatId, `✅ CV para #${report} (${esc(meta.company)}) actualizado y adjuntado al formulario.`, {
    reply_markup: {
      inline_keyboard: [
        [
          { text: '📄 Más cambios CV', callback_data: `edit_cv:${report}` },
          { text: '✏️ Cambiar carta', callback_data: `edit_cover:${report}` },
        ],
        [
          { text: '📝 La envío yo', callback_data: `manual:${report}` },
          { text: '❌ Descartar', callback_data: `discard:${report}` },
        ]
      ]
    }
  });
}

function appDir(report) { return path.join(ROOT, 'output', 'applications', String(report).padStart(3, '0')); }
function setAppState(report, state, extra = {}) {
  const f = path.join(appDir(report), 'status.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
  Object.assign(st, { state, [`${state}_at`]: new Date().toISOString() }, extra);
  fs.writeFileSync(f, JSON.stringify(st, null, 2));
  return st;
}

async function handleCallback(cb) {
  const chatId = String(cb.message?.chat?.id || '');
  await tgCall(cfg.token, 'answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  if (!cfg.chatId || chatId !== cfg.chatId) { log('ignored callback from foreign chat', chatId); return; }
  const [action, report] = String(cb.data || '').split(':');
  if (!/^\d+$/.test(report || '')) return;
  if (action === 'submit') {
    return handleSubmit(report, chatId);
  }
  if (action === 'edit_cover') {
    return tgSend(cfg.token, chatId, `✍️ Para modificar la carta del informe #${report}, responde directamente al mensaje de la carta con tus cambios, o escribe:\n<code>/carta ${report} &lt;lo que quieras cambiar&gt;</code>`);
  }
  if (action === 'edit_cv') {
    return tgSend(cfg.token, chatId, `📄 Para modificar el CV del informe #${report}, responde directamente al archivo del CV con tus cambios, o escribe:\n<code>/cv ${report} &lt;lo que quieras cambiar&gt;</code>`);
  }
  if (action === 'manual') {
    setAppState(report, 'manual_pending');
    return tgSend(cfg.token, chatId, `👍 Informe #${report}: la envías tú. Cuando la hayas enviado escribe <code>/enviada ${report}</code> y la marco como Applied.`);
  }
  if (action === 'followup_done') {
    const ok = recordFollowupDone(ROOT, report);
    return tgSend(cfg.token, chatId, ok ? `✅ Registrado seguimiento para el informe #${report}. ¡Buen trabajo!` : `No pude registrar el seguimiento para #${report}.`);
  }
  if (action === 'responded') {
    const r = spawnSync('node', ['set-status.mjs', '--report', report, 'Responded', '--note', 'Respuesta de la empresa confirmada en Telegram'], { cwd: ROOT, encoding: 'utf8' });
    return tgSend(cfg.token, chatId, r.status === 0 ? `🎉 ¡Excelente! Informe #${report} marcado como <b>Responded</b>.` : `No pude actualizar el tracker: ${esc((r.stderr || r.stdout).slice(0, 200))}`);
  }
  if (action === 'mark_applied') {
    setAppState(report, 'applied_manual');
    const r = spawnSync('node', ['set-status.mjs', '--report', report, 'Applied', '--note', 'Enviada manualmente tras CAPTCHA (confirmado en Telegram)'], { cwd: ROOT, encoding: 'utf8' });
    spawnSync('node', ['followup-seed.mjs', report], { cwd: ROOT, encoding: 'utf8' });
    return tgSend(cfg.token, chatId, r.status === 0
      ? `✅ <b>¡Genial! Candidatura #${report} marcada como Applied.</b>\nSeguimiento programado a los 7 y 14 días.`
      : `No pude actualizar el tracker: ${esc((r.stderr || r.stdout).slice(0, 300))}`);
  }
  if (action === 'discard') {
    setAppState(report, 'discarded');
    const r = spawnSync('node', ['set-status.mjs', '--report', report, 'Discarded', '--note', 'Descartada desde Telegram'], { cwd: ROOT, encoding: 'utf8' });
    return tgSend(cfg.token, chatId, `❌ Informe #${report} descartado.${r.status === 0 ? '' : ' (no pude actualizar el tracker: ' + esc((r.stderr || r.stdout).slice(0, 200)) + ')'}`);
  }
}

async function handleSubmit(report, chatId) {
  let meta = {};
  try { meta = parseReport(reportFile(report)); } catch { meta = { company: `Empresa #${report}`, role: '' }; }

  // Check if prepared
  const appDirectory = appDir(report);
  const answersFile = path.join(appDirectory, 'answers.json');
  const formFile = path.join(appDirectory, 'form.json');

  if (!fs.existsSync(answersFile) || !fs.existsSync(formFile)) {
    await tgSend(cfg.token, chatId, `⏳ <b>La candidatura #${report} (${esc(meta.company)}) no estaba preparada todavía.</b>\n\nPreparando ahora con agy (extrayendo formulario, adaptando CV y carta)... Te enviaré el formulario relleno en breve (1-2 minutos en DietPi).`);
    const prep = spawnSync('node', ['prepare.mjs', '--report', String(report)], { cwd: HERE, encoding: 'utf8', timeout: 3600000 });
    if (prep.status !== 0 || !fs.existsSync(answersFile)) {
      return tgSend(cfg.token, chatId, `⚠️ Error al preparar #${report}: ${esc((prep.stderr || prep.stdout || '').slice(0, 300))}`);
    }
    // prepare.mjs sends the whole package (filled form screenshot, CV PDF, cover letter, and buttons)
    return;
  }

  await tgSend(cfg.token, chatId, `🚀 <b>Enviando candidatura #${report} (${esc(meta.company)})...</b>\nAbriendo el portal, rellenando datos y adjuntando archivos...`);

  let res = null;
  try {
    res = await submitApplication(report);
  } catch (e) {
    return tgSend(cfg.token, chatId, `⚠️ Error al intentar enviar #${report}: ${esc(e.message)}`);
  }

  if (res.ok) {
    await tgSend(cfg.token, chatId, [
      `🎉 <b>¡Candidatura enviada con éxito! — #${report} (${esc(res.meta.company)})</b>`,
      `• Rol: <b>${esc(res.meta.role)}</b>`,
      `• Estado: Marcada como <b>Applied</b> en el tracker.`,
      `• Seguimiento: Programado automáticamente para dentro de <b>7 y 14 días</b>.`,
      '',
      `<i>Captura de confirmación recibida del portal:</i>`
    ].join('\n'));

    if (res.screenshot && fs.existsSync(res.screenshot)) {
      await tgSendFile(cfg.token, chatId, res.screenshot, { caption: `Confirmación de envío — #${report} (${esc(res.meta.company)})` });
    }
    return;
  }

  if (res.reason === 'captcha') {
    await tgSend(cfg.token, chatId, [
      `⚠️ <b>CAPTCHA detectado en #${report} (${esc(res.meta.company)})</b>`,
      '',
      `El portal requiere verificación humana (Turnstile/reCAPTCHA). No te preocupes: todos tus datos y CV están listos.`,
      '',
      `👉 <a href="${esc(res.meta.url)}">Abre el formulario aquí</a> y pulsa enviar.`,
      `Cuando la envíes, pulsa el botón abajo o responde <b>enviada</b>.`
    ].join('\n'), {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Ya la he enviado', callback_data: `mark_applied:${report}` },
            { text: '❌ Descartar', callback_data: `discard:${report}` }
          ]
        ]
      }
    });
  } else {
    await tgSend(cfg.token, chatId, [
      `⚠️ <b>No se pudo enviar automáticamente #${report} (${esc(res.meta.company)})</b>: ${esc(res.error || 'revisa los campos')}.`,
      '',
      `👉 <a href="${esc(res.meta.url)}">Completar manualmente aquí</a>.`,
      `Una vez enviada escribe <code>/enviada ${report}</code>.`
    ].join('\n'));
  }

  if (res.screenshot && fs.existsSync(res.screenshot)) {
    await tgSendFile(cfg.token, chatId, res.screenshot, { caption: `Estado del formulario — #${report}` });
  }
}

async function main() {
  log(`starting; paired chat: ${cfg.chatId || '(none — send /start)'}`);
  let offset = 0;
  let lastFollowupCheck = 0;

  for (;;) {
    try {
      // Periodic follow-up check (every 6 hours)
      if (cfg.chatId && (Date.now() - lastFollowupCheck > 6 * 3600 * 1000)) {
        lastFollowupCheck = Date.now();
        checkAndSendFollowupAlerts(ROOT, cfg).catch((e) => log('followup check error', e.message));
      }

      const updates = await tgCall(cfg.token, 'getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) {
          log('msg from', u.message.chat?.id, 'text:', JSON.stringify(u.message.text || ''), 'reply_to:', JSON.stringify(u.message.reply_to_message?.text || ''));
          await handle(u.message).catch((e) => log('handle error', e.message));
        }
        if (u.callback_query) {
          log('callback from', u.callback_query.message?.chat?.id, 'data:', u.callback_query.data);
          await handleCallback(u.callback_query).catch((e) => log('callback error', e.message));
        }
      }
    } catch (e) {
      log('poll error', e.message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}
main();
