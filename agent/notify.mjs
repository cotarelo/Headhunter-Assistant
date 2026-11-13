#!/usr/bin/env node
/**
 * notify.mjs — email alerts for new career-ops evaluation reports.
 *
 * Reads {CAREER_OPS_DIR}/reports/*.md, finds reports not yet notified, and
 * emails the ones scoring >= ALERT_THRESHOLD in a single message per run.
 * State lives in {CAREER_OPS_DIR}/data/headhunter-notify-state.json (user layer,
 * gitignored). The first run only records a baseline (no email for history).
 *
 * Usage:
 *   node notify.mjs              # alert on new high-score reports
 *   node notify.mjs --dry-run    # print what would be sent, change no state
 *   node notify.mjs --digest     # daily summary of the last 24h (always sends)
 *   node notify.mjs --test       # send a test email to verify SMTP
 *
 * Read-only on career-ops files; never submits or applies to anything.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { tgConfig, tgSend, esc as tgEsc } from './lib/telegram.mjs';
import { checkAndSendFollowupAlerts } from './lib/followup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(HERE, '.env') });

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const DIGEST = args.has('--digest');
const TEST = args.has('--test');

const ROOT = path.resolve(HERE, process.env.CAREER_OPS_DIR || '../career-ops');
const REPORTS = path.join(ROOT, 'reports');
const STATE_FILE = path.join(ROOT, 'data', 'headhunter-notify-state.json');
const THRESHOLD = Number(process.env.ALERT_THRESHOLD || 4.0);

function log(...a) { console.log(`[notify ${new Date().toISOString()}]`, ...a); }

// ---------- report parsing ----------
export function parseReport(file) {
  const text = fs.readFileSync(file, 'utf8');
  const field = (name) => {
    const m = text.match(new RegExp(`^\\*\\*${name}:\\*\\*\\s*(.+)$`, 'mi'));
    return m ? m[1].trim() : '';
  };
  const title = (text.match(/^#\s+(?:Evaluation|Evaluación):\s*(.+)$/mi) || [])[1] || '';
  let summary = {};
  const ms = text.match(/##\s*Machine Summary[\s\S]*?```ya?ml\s*\n([\s\S]*?)```/i);
  if (ms) { try { summary = yaml.load(ms[1]) || {}; } catch { summary = {}; } }
  const scoreRaw = summary.score ?? (field('Score').match(/([\d.]+)/) || [])[1];
  const score = scoreRaw !== undefined && scoreRaw !== '' ? Number(scoreRaw) : NaN;
  const [tCompany, ...tRole] = title.split(/\s+[—-]\s+/);
  return {
    file: path.basename(file),
    company: summary.company || tCompany || '?',
    role: summary.role || tRole.join(' — ') || '?',
    score,
    url: field('URL'),
    date: field('Date'),
    archetype: summary.archetype || field('Archetype'),
    legitimacy: summary.legitimacy_tier || field('Legitimacy'),
    decision: summary.final_decision || field('Decision'),
    hardStops: [].concat(summary.hard_stops || []),
    strengths: [].concat(summary.top_strengths || []).slice(0, 3),
    gaps: [].concat(summary.soft_gaps || []).slice(0, 3),
    pdf: field('PDF'),
  };
}

function listReports() {
  if (!fs.existsSync(REPORTS)) return [];
  return fs.readdirSync(REPORTS)
    .filter((f) => /^\d+-.+\.md$/.test(f) && !/RESERVED/i.test(f))
    .sort();
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(state) {
  if (DRY) return;
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- email ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function offerHtml(r) {
  const li = (arr) => arr.length ? `<ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>—</p>';
  return `
  <div style="border:1px solid #ddd;border-radius:8px;padding:12px 16px;margin:12px 0;font-family:sans-serif">
    <h3 style="margin:0 0 4px">${esc(r.company)} — ${esc(r.role)}</h3>
    <p style="margin:0 0 8px"><b>Score: ${isNaN(r.score) ? '?' : r.score.toFixed(1)}/5</b> · ${esc(r.decision)} · ${esc(r.archetype)} · Legitimidad: ${esc(r.legitimacy)}</p>
    ${r.url ? `<p><a href="${esc(r.url)}">Ver oferta</a></p>` : ''}
    <b>Puntos fuertes</b>${li(r.strengths)}
    <b>Gaps</b>${li(r.gaps)}
    ${r.hardStops.length ? `<b style="color:#b00">Bloqueos</b>${li(r.hardStops)}` : ''}
    <p style="color:#888;font-size:12px">Informe: reports/${esc(r.file)}${r.pdf && r.pdf !== '—' ? ` · CV: ${esc(r.pdf)}` : ''}</p>
  </div>`;
}
function offerText(r) {
  return [
    `${r.company} — ${r.role}`,
    `Score ${isNaN(r.score) ? '?' : r.score.toFixed(1)}/5 · ${r.decision} · ${r.archetype} · ${r.legitimacy}`,
    r.url && `Oferta: ${r.url}`,
    r.strengths.length && `+ ${r.strengths.join('\n+ ')}`,
    r.gaps.length && `- ${r.gaps.join('\n- ')}`,
    `Informe: reports/${r.file}`,
  ].filter(Boolean).join('\n');
}

async function send(subject, html, text, { to, attachments = [], headers } = {}) {
  if (DRY) {
    log('DRY-RUN — would send:', subject, attachments.length ? `(+${attachments.length} attachments: ${attachments.map((a) => a.filename).join(', ')})` : '');
    console.log(text);
    return;
  }
  const required = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`Missing env: ${missing.join(', ')} (see agent/.env.example)`);
  const { default: nodemailer } = await import('nodemailer');
  const port = Number(process.env.SMTP_PORT || 465);
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: String(process.env.SMTP_SECURE ?? (port === 465)) === 'true',
    auth: { user: process.env.SMTP_USER, pass: String(process.env.SMTP_PASS).replace(/\s+/g, '') }, // Google shows app passwords as 4x4 blocks
  });
  await transport.sendMail({
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to: to || process.env.MAIL_TO,
    subject,
    text,
    html: `<div style="font-family:sans-serif">${html}</div>`,
    attachments,
    headers,
  });
  log('sent:', subject);
}

function pendingCount() {
  try {
    const t = fs.readFileSync(path.join(ROOT, 'data', 'pipeline.md'), 'utf8');
    return (t.match(/^- \[ \]/gm) || []).length;
  } catch { return 0; }
}

// Score-based apply recommendation shown above the action buttons.
export function recommendation(r) {
  if (r.hardStops.length) return `⛔ <b>No recomendado:</b> tiene bloqueos (${tgEsc(r.hardStops[0])}).`;
  if (r.score >= 4.5) return '🟢 <b>Recomendado: aplica.</b> Encaje muy alto.';
  if (r.score >= 4.3) return '🟡 <b>Vale la pena aplicar</b>, revisa antes los gaps.';
  if (r.score >= 4.1) return '🟠 <b>Dudoso:</b> aplica solo si te interesa especialmente.';
  return '🔴 <b>No recomendado</b> aplicar.';
}

async function sendTelegramAlerts(hits) {
  const tg = tgConfig(ROOT);
  if (!tg.enabled) return;
  if (DRY) { log(`DRY-RUN — would send ${hits.length} Telegram alert(s)`); return; }
  for (const r of hits) {
    const numMatch = r.file.match(/^(\d+)-/);
    const reportNum = numMatch ? numMatch[1].replace(/^0+/, '') : '';
    const lines = [
      `🎯 <b>#${reportNum} ${tgEsc(r.company)}</b> — ${tgEsc(r.role)}`,
      `<b>${r.score.toFixed(1)}/5</b> · ${tgEsc(r.decision)} · ${tgEsc(r.archetype)}`,
      r.url ? `<a href="${tgEsc(r.url)}">Ver oferta</a>` : '',
      r.strengths.length ? '\n✅ ' + r.strengths.map(tgEsc).join(' · ') : '',
      r.gaps.length ? '\n⚠️ ' + r.gaps.map(tgEsc).join('\n⚠️ ') : '',
      `\n${recommendation(r)}`,
      `<i>reports/${tgEsc(r.file)}</i>`,
    ].filter(Boolean);
    await tgSend(tg.token, tg.chatId, lines.join('\n').slice(0, 4000), {
      reply_markup: reportNum ? {
        inline_keyboard: [
          [
            { text: '🚀 Aplicar a esta oferta', callback_data: `submit:${reportNum}` },
            { text: '❌ Descartar', callback_data: `discard:${reportNum}` }
          ],
          [
            { text: '✅ Ya he aplicado (seguimiento)', callback_data: `mark_applied:${reportNum}` }
          ]
        ]
      } : undefined
    });
  }
  log(`telegram: ${hits.length} alert(s) sent`);
}

// ---------- application pack (CV + cover letter) for n8n auto-apply ----------
// Offers scoring >= PACK_THRESHOLD (and with no hard stops) get a separate email with the tailored CV,
// the cover letter (PDF + txt) and application.json, so an n8n workflow can apply automatically.
const PACK_THRESHOLD = Number(process.env.AUTO_PACK_THRESHOLD || 4.7);
const PACK_SUBJECT_TAG = process.env.PACK_SUBJECT_TAG || '[HH-APPLY]';
const PACK_MAX_ATTEMPTS = 3;
const reportNum = (file) => ((file.match(/^(\d+)-/) || [])[1] || '').replace(/^0+/, '');
const packEligible = (r) => r.score >= PACK_THRESHOLD && !r.hardStops.length && !/suspicious|sospechos/i.test(r.legitimacy);
const safeName = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);

function readPrepared(num) {
  const dir = path.join(ROOT, 'output', 'applications', String(num).padStart(3, '0'));
  const json = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const answers = json('answers.json');
  const cover = (() => { try { return fs.readFileSync(path.join(dir, 'cover.txt'), 'utf8').trim(); } catch { return ''; } })();
  const cvPath = answers?.cv_pdf ? path.join(ROOT, answers.cv_pdf) : '';
  const ok = !!(cvPath && fs.existsSync(cvPath) && cover);
  return { dir, ok, answers, cover, cvPath, form: json('form.json') };
}

/** Reuses an existing preparation, otherwise runs prepare.mjs (agy) without the Telegram pack. */
function ensurePrepared(num) {
  let p = readPrepared(num);
  if (p.ok) return p;
  log(`pack #${num}: preparing CV + cover letter (agy)…`);
  const r = spawnSync('node', [path.join(HERE, 'prepare.mjs'), '--report', String(num), '--no-telegram'], {
    cwd: HERE, encoding: 'utf8', timeout: Number(process.env.AGY_TIMEOUT_SECONDS || 3600) * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  p = readPrepared(num);
  if (!p.ok) throw new Error(`prepare failed (exit ${r.status}): ${String(r.stderr || r.stdout || '').trim().slice(-300)}`);
  return p;
}

function candidate() {
  try { return yaml.load(fs.readFileSync(path.join(ROOT, 'config', 'profile.yml'), 'utf8'))?.candidate || {}; } catch { return {}; }
}

async function sendPack(r) {
  const num = reportNum(r.file);
  if (!num) throw new Error(`no report number in ${r.file}`);
  if (DRY) { log(`DRY-RUN — would prepare and email application pack for #${num} ${r.company} (${r.score})`); return; }
  const p = ensurePrepared(num);
  const c = candidate();
  const who = safeName(c.full_name || 'Jorge Pena');
  const co = safeName(r.company);

  const attachments = [{ filename: `CV_${who}_${co}.pdf`, path: p.cvPath, contentType: 'application/pdf' }];
  const coverPdf = path.join(p.dir, 'cover-letter.pdf');
  let coverPdfName = null;
  try {
    const { coverToPdf } = await import('./lib/cover-pdf.mjs');
    await coverToPdf(ROOT, p.cover, coverPdf, { name: c.full_name || '' });
    coverPdfName = `Cover_Letter_${who}_${co}.pdf`;
    attachments.push({ filename: coverPdfName, path: coverPdf, contentType: 'application/pdf' });
  } catch (e) { log(`pack #${num}: cover PDF failed (txt only): ${e.message}`); }
  const coverTxtName = `Cover_Letter_${who}_${co}.txt`;
  attachments.push({ filename: coverTxtName, content: p.cover, contentType: 'text/plain; charset=utf-8' });

  const app = {
    report: Number(num), company: r.company, role: r.role, score: r.score,
    job_url: r.url, form_url: p.form?.form_url || r.url, ats: p.form?.ats || 'unknown',
    candidate: { full_name: c.full_name || '', email: 'jorge.penacotarelo@gmail.com', phone: c.phone || '', linkedin: c.linkedin || '', location: c.location || '' },
    files: { cv: attachments[0].filename, cover_letter_pdf: coverPdfName, cover_letter_txt: coverTxtName },
    cover_letter: p.cover,
    answers: (p.answers?.answers || []).filter((a) => a.type !== 'file').map(({ label, value, type, needs_review, note }) => ({ label, value, type, needs_review: !!needs_review, note: note || '' })),
    warnings: p.answers?.warnings || [],
    generated_at: new Date().toISOString(),
  };
  attachments.push({ filename: 'application.json', content: JSON.stringify(app, null, 2), contentType: 'application/json' });

  const review = app.answers.filter((a) => a.needs_review).length;
  const subject = `${PACK_SUBJECT_TAG} #${num} ${r.company} — ${r.role} (${r.score.toFixed(1)})`;
  const html = `<p><b>Paquete de candidatura listo</b> (score ≥ ${PACK_THRESHOLD}): CV adaptado, carta de presentación y <code>application.json</code> adjuntos.</p>
    ${offerHtml(r)}
    <h4>Carta de presentación</h4><pre style="white-space:pre-wrap;font-family:inherit">${esc(p.cover)}</pre>
    ${review ? `<p style="color:#b60">⚠️ ${review} respuesta(s) marcadas para revisar en application.json.</p>` : ''}`;
  const text = [`${subject}`, `Job URL: ${r.url}`, `Form URL: ${app.form_url}`, '', 'COVER LETTER:', p.cover].join('\n');
  await send(subject, html, text, {
    to: process.env.PACK_MAIL_TO || process.env.MAIL_TO,
    attachments,
    headers: { 'X-Headhunter-Report': num, 'X-Headhunter-Score': String(r.score), 'X-Headhunter-Job-Url': r.url || '' },
  });
}

/** Sends packs for new eligible hits and retries failed ones from previous cycles. Mutates state.packs. */
async function runPacks(state, hits) {
  state.packs ||= {};
  const todo = new Map();
  for (const r of hits.filter(packEligible)) if (!state.packs[r.file]) todo.set(r.file, r);
  for (const [file, s] of Object.entries(state.packs)) {
    if (s.status === 'failed' && s.attempts < PACK_MAX_ATTEMPTS && !todo.has(file) && fs.existsSync(path.join(REPORTS, file))) {
      try { const r = parseReport(path.join(REPORTS, file)); if (packEligible(r)) todo.set(file, r); } catch {}
    }
  }
  for (const [file, r] of todo) {
    const prev = state.packs[file] || { attempts: 0 };
    try {
      await sendPack(r);
      if (!DRY) state.packs[file] = { status: 'sent', attempts: prev.attempts + 1, at: new Date().toISOString() };
    } catch (e) {
      log(`pack ${file} failed:`, e.message);
      if (!DRY) state.packs[file] = { status: 'failed', attempts: prev.attempts + 1, at: new Date().toISOString(), error: e.message.slice(0, 300) };
    }
    saveState(state);
  }
}

// ---------- modes ----------
async function runAlerts() {
  const files = listReports();
  let state = loadState();
  if (!state) {
    state = { notified: files, baselineAt: new Date().toISOString() };
    saveState(state);
    log(`baseline recorded: ${files.length} existing reports marked as seen (no email).`);
    return;
  }
  const seen = new Set(state.notified);
  const fresh = files.filter((f) => !seen.has(f));
  if (!fresh.length) { log('no new reports.'); await runPacks(state, []); return; }

  const parsed = fresh.map((f) => { try { return parseReport(path.join(REPORTS, f)); } catch (e) { log('parse error', f, e.message); return null; } }).filter(Boolean);
  const hits = parsed
    .filter((r) => r.score >= THRESHOLD && !/suspicious|sospechos/i.test(r.legitimacy))
    .sort((a, b) => b.score - a.score);
  log(`${fresh.length} new reports, ${hits.length} >= ${THRESHOLD}.`);

  if (hits.length) {
    const subject = `🎯 ${hits.length} oferta${hits.length > 1 ? 's' : ''} ≥ ${THRESHOLD}: ` +
      hits.slice(0, 3).map((r) => `${r.company} (${r.score.toFixed(1)})`).join(', ');
    const html = `<p>Nuevas ofertas con alto encaje:</p>${hits.map(offerHtml).join('')}
      <p style="color:#888;font-size:12px">Headhunter agent · nada se ha enviado ni aplicado en tu nombre.</p>`;
    const text = hits.map(offerText).join('\n\n---\n\n');
    const errors = [];
    try { await send(subject, html, text); } catch (e) { errors.push(`email: ${e.message}`); }
    try { await sendTelegramAlerts(hits); } catch (e) { errors.push(`telegram: ${e.message}`); }
    const tgOn = tgConfig(ROOT).enabled;
    // retry next cycle only if every configured channel failed
    if (errors.length && (errors.length >= (tgOn ? 2 : 1))) throw new Error(errors.join(' | '));
    if (errors.length) log('partial delivery:', errors.join(' | '));
  }
  state.notified = [...seen, ...fresh];
  state.lastAlertRun = new Date().toISOString();
  saveState(state);
  // after alerts are recorded: packs may take minutes (agy) and must not delay or duplicate alerts
  await runPacks(state, hits);
}

async function runDigest() {
  const since = Date.now() - 24 * 3600 * 1000;
  const recent = listReports()
    .map((f) => ({ f, mtime: fs.statSync(path.join(REPORTS, f)).mtimeMs }))
    .filter((x) => x.mtime >= since)
    .map((x) => parseReport(path.join(REPORTS, x.f)))
    .sort((a, b) => (b.score || 0) - (a.score || 0));
  const pend = pendingCount();
  const rows = recent.map((r) => `<tr><td>${isNaN(r.score) ? '?' : r.score.toFixed(1)}</td><td>${esc(r.company)}</td><td>${r.url ? `<a href="${esc(r.url)}">${esc(r.role)}</a>` : esc(r.role)}</td><td>${esc(r.decision)}</td></tr>`).join('');
  const html = `<p>Resumen de las últimas 24h — el agente sigue vivo ✅</p>
    <p>Evaluadas: <b>${recent.length}</b> · ≥ ${THRESHOLD}: <b>${recent.filter((r) => r.score >= THRESHOLD).length}</b> · Pendientes en cola: <b>${pend}</b></p>
    ${recent.length ? `<table border="1" cellpadding="4" style="border-collapse:collapse"><tr><th>Score</th><th>Empresa</th><th>Rol</th><th>Decisión</th></tr>${rows}</table>` : '<p>Sin evaluaciones nuevas hoy.</p>'}`;
  const text = `Evaluadas 24h: ${recent.length} | pendientes: ${pend}\n` + recent.map((r) => `${isNaN(r.score) ? '?' : r.score.toFixed(1)}  ${r.company} — ${r.role}`).join('\n');
  await send(`📋 Headhunter: ${recent.length} evaluadas, ${pend} pendientes (${new Date().toLocaleDateString('es-ES')})`, html, text);
  const tg = tgConfig(ROOT);
  await checkAndSendFollowupAlerts(ROOT, tg).catch((e) => log('followup check error', e.message));
}

async function main() {
  if (TEST) {
    if (!args.has('--telegram-only')) await send('✅ Headhunter agent — prueba SMTP', '<p>Si lees esto, las alertas por email funcionan.</p>', 'Si lees esto, las alertas por email funcionan.');
    const tg = tgConfig(ROOT);
    if (tg.enabled && !DRY) { await tgSend(tg.token, tg.chatId, '✅ Prueba de alertas por Telegram'); log('telegram test sent'); }
    else log('telegram not configured/paired — skipped');
    return;
  }
  if (DIGEST) return runDigest();
  const packIdx = process.argv.indexOf('--pack');
  if (packIdx > 0) { // manual: node notify.mjs --pack 123  (send the CV + cover letter pack for one report now)
    const n = process.argv[packIdx + 1];
    const file = listReports().find((f) => reportNum(f) === String(Number(n)));
    if (!file) throw new Error(`report ${n} not found`);
    return sendPack(parseReport(path.join(REPORTS, file)));
  }
  return runAlerts();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error('[notify] ERROR', e.message); process.exit(1); });
}
