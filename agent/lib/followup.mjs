// lib/followup.mjs — Follow-up cadence tracking and alert dispatch (7 & 14 days)
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tgSend, esc } from './telegram.mjs';

export function getFollowupData(careerOpsDir) {
  const r = spawnSync('node', ['followup-cadence.mjs'], {
    cwd: careerOpsDir, encoding: 'utf8', timeout: 30000,
  });
  if (r.status !== 0) {
    throw new Error(`followup-cadence failed: ${r.stderr || r.stdout}`);
  }
  return JSON.parse(r.stdout);
}

export function loadFollowupState(careerOpsDir) {
  const file = path.join(careerOpsDir, 'data', 'headhunter-followup-state.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { notified: {} };
  }
}

export function saveFollowupState(careerOpsDir, state) {
  const file = path.join(careerOpsDir, 'data', 'headhunter-followup-state.json');
  fs.writeFileSync(file, JSON.stringify(state, null, 2));
}

function localToday(now = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

export function readTrackerRows(careerOpsDir) {
  const rows = [];
  try {
    const lines = fs.readFileSync(path.join(careerOpsDir, 'data', 'applications.md'), 'utf8').split('\n');
    const header = lines.find((l) => /^\|\s*#\s*\|/.test(l));
    if (!header) return rows;
    const cols = header.split('|').map((s) => s.trim().toLowerCase());
    const iNum = cols.indexOf('#');
    const iCompany = cols.indexOf('company');
    const iRole = cols.indexOf('role');
    const iStatus = cols.indexOf('status');
    const iReport = cols.indexOf('report');
    for (const l of lines) {
      if (!l.startsWith('|')) continue;
      const cells = l.split('|').map((s) => s.trim());
      const num = parseInt(cells[iNum] || '', 10);
      if (isNaN(num)) continue;
      const reportCell = iReport >= 0 ? (cells[iReport] || '') : '';
      const m = reportCell.match(/reports\/0*(\d+)-/) || reportCell.match(/\[0*(\d+)\]/);
      rows.push({
        num,
        company: iCompany >= 0 ? (cells[iCompany] || '') : '',
        role: iRole >= 0 ? (cells[iRole] || '') : '',
        status: iStatus >= 0 ? (cells[iStatus] || '') : '',
        reportNum: m ? m[1] : null,
      });
    }
  } catch {}
  return rows;
}

export function findTrackerRow(careerOpsDir, rowNum) {
  const target = Number(rowNum);
  if (!Number.isInteger(target) || target <= 0) return null;
  return readTrackerRows(careerOpsDir).find((r) => r.num === target) || null;
}

export function findTrackerRowByReport(careerOpsDir, reportNum) {
  const target = String(reportNum || '').replace(/^0+/, '');
  if (!target) return null;
  return readTrackerRows(careerOpsDir).find((r) => r.reportNum === target) || null;
}

const ACTIONABLE_STATUS_RE = /^(applied|responded|assessment|interview)\b/i;

export function resolveFollowupRow(careerOpsDir, id) {
  const byRow = findTrackerRow(careerOpsDir, id);
  const byReport = findTrackerRowByReport(careerOpsDir, id);
  if (byRow && ACTIONABLE_STATUS_RE.test(byRow.status)) return byRow;
  if (byReport && ACTIONABLE_STATUS_RE.test(byReport.status)) return byReport;
  return byRow || byReport || null;
}

function parseSetStatusOutput(r) {
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  let json = null;
  if (stdout) {
    try { json = JSON.parse(stdout); } catch {}
  }
  const error = json?.error || stderr || stdout || `exit ${r.status}`;
  return { ok: r.status === 0, json, error };
}

export function setTrackerStatus(careerOpsDir, { row, report }, status, { note, onDate } = {}) {
  const args = ['set-status.mjs'];
  if (row != null) args.push('--row', String(row));
  else args.push('--report', String(report));
  args.push(status);
  if (note) args.push('--note', note);
  if (onDate) args.push('--on', onDate);
  args.push('--json');
  const r = spawnSync('node', args, { cwd: careerOpsDir, encoding: 'utf8' });
  return parseSetStatusOutput(r);
}

/**
 * Mark a report as Applied in applications.md (--report) and seed data/follow-ups.md
 * using the resolved tracker row # (appNum), which may differ from the report #.
 */
export function setStatusAndSeed(careerOpsDir, reportNum, note, { forceToday = false } = {}) {
  const today = localToday();
  const res = setTrackerStatus(
    careerOpsDir,
    { report: reportNum },
    'Applied',
    { note, onDate: forceToday ? today : undefined },
  );
  if (!res.ok) return res;
  const rowNum = res.json?.num ?? findTrackerRowByReport(careerOpsDir, reportNum)?.num;
  if (rowNum && !res.json?.followupSeeded?.seeded) {
    const seedArgs = ['followup-seed.mjs', String(rowNum)];
    if (forceToday) seedArgs.push('--date', today, '--force');
    spawnSync('node', seedArgs, { cwd: careerOpsDir, encoding: 'utf8' });
  }
  return { ...res, rowNum };
}

const FOLLOWUPS_TABLE_HEADER = '| num | appNum | date | company | role | channel | contact | notes |\n|---|---|---|---|---|---|---|---|\n';

function sanitizeCell(v, max) {
  const s = String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '/').trim();
  return max ? s.slice(0, max) : s;
}

export function appendFollowupLog(careerOpsDir, { appNum, date, company, role, channel = 'LinkedIn', contact = '', notes = '' }) {
  const file = path.join(careerOpsDir, 'data', 'follow-ups.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Follow-ups\n\n' + FOLLOWUPS_TABLE_HEADER;
  const lines = existing.split('\n');
  let maxNum = 0;
  let lastTableIdx = -1;
  let hasHeader = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('|')) continue;
    lastTableIdx = i;
    const first = (line.split('|')[1] || '').trim();
    if (/^(num|#)$/i.test(first)) hasHeader = true;
    const n = parseInt(first, 10);
    if (Number.isInteger(n) && n > maxNum) maxNum = n;
  }
  const nextNum = maxNum + 1;
  const rowLine = `| ${nextNum} | ${appNum} | ${date} | ${sanitizeCell(company, 80)} | ${sanitizeCell(role, 80)} | ${sanitizeCell(channel, 40)} | ${sanitizeCell(contact, 120)} | ${sanitizeCell(notes)} |`;
  let nextContent;
  if (hasHeader && lastTableIdx >= 0) {
    lines.splice(lastTableIdx + 1, 0, rowLine);
    nextContent = lines.join('\n');
    if (!nextContent.endsWith('\n')) nextContent += '\n';
  } else {
    const base = existing.endsWith('\n') ? existing : `${existing}\n`;
    nextContent = `${base}${hasHeader ? '' : FOLLOWUPS_TABLE_HEADER}${rowLine}\n`;
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, nextContent, 'utf8');
  fs.renameSync(tmp, file);
  return nextNum;
}

export async function checkAndSendFollowupAlerts(careerOpsDir, tg) {
  if (!tg.enabled) return { sent: 0 };
  const data = getFollowupData(careerOpsDir);
  const state = loadFollowupState(careerOpsDir);
  let sent = 0;

  for (const entry of data.entries) {
    // Only check active applied or interview candidates
    const days = entry.daysSinceApplication;
    if (days == null) continue;

    // Follow-up 1: Day 7 threshold (days >= 7, followupCount === 0)
    if (days >= 7 && days < 14 && (entry.followupCount || 0) === 0) {
      const key = `${entry.num}:7`;
      if (!state.notified[key]) {
        await tgSend(tg.token, tg.chatId, [
          `🔔 <b>Recordatorio de seguimiento (7 días) — #${entry.num} (${esc(entry.company)})</b>`,
          '',
          `Han pasado <b>${days} días</b> desde que enviaste la candidatura para <b>${esc(entry.role)}</b>.`,
          '',
          `💡 <b>Siguiente paso recomendado:</b>`,
          `Busca al hiring manager o recruiter en LinkedIn para confirmar tu interés y consultar el estado del proceso.`,
          '',
          `<i>Ejemplo de mensaje:</i>`,
          `<blockquote>Hola [Nombre], te escribo en relación a mi candidatura para ${esc(entry.role)} enviada hace una semana. Sigo muy interesado en el proyecto y me encantaría saber si tenéis alguna novedad. ¡Muchas gracias!</blockquote>`
        ].join('\n'), {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Seguimiento hecho', callback_data: `followup_done:${entry.num}` },
                { text: '💬 Han respondido', callback_data: `responded:${entry.num}` },
              ],
              [
                { text: '❌ Descartar / Rechazada', callback_data: `discard_row:${entry.num}` },
              ]
            ]
          }
        });
        state.notified[key] = new Date().toISOString();
        sent++;
      }
    }

    // Follow-up 2: Day 14 threshold (days >= 14, followupCount <= 1)
    if (days >= 14 && (entry.followupCount || 0) <= 1) {
      const key = `${entry.num}:14`;
      if (!state.notified[key]) {
        await tgSend(tg.token, tg.chatId, [
          `🔔 <b>Seguimiento final (14 días) — #${entry.num} (${esc(entry.company)})</b>`,
          '',
          `Han pasado <b>${days} días</b> desde que aplicaste para <b>${esc(entry.role)}</b>.`,
          '',
          `💡 <b>Recomendación:</b>`,
          `Segundo y último recordatorio. Si tras este contacto no hay respuesta en unos días, lo habitual es darla por cerrada.`,
        ].join('\n'), {
          reply_markup: {
            inline_keyboard: [
              [
                { text: '✅ Seguimiento hecho', callback_data: `followup_done:${entry.num}` },
                { text: '💬 Han respondido', callback_data: `responded:${entry.num}` },
              ],
              [
                { text: '❌ Dar por cerrada', callback_data: `discard_row:${entry.num}` },
              ]
            ]
          }
        });
        state.notified[key] = new Date().toISOString();
        sent++;
      }
    }
  }

  if (sent > 0) {
    saveFollowupState(careerOpsDir, state);
  }
  return { sent };
}

export function recordFollowupDone(careerOpsDir, id, note = '', { byRowOnly = false } = {}) {
  const row = byRowOnly ? findTrackerRow(careerOpsDir, id) : resolveFollowupRow(careerOpsDir, id);
  if (!row) {
    return { ok: false, error: `No se encontró la candidatura #${id} en el tracker.` };
  }
  const today = localToday();
  const msg = note ? `Follow-up enviado (${note}, ${today})` : `Follow-up enviado por Jorge (${today})`;
  const currentStatus = row.status.replace(/\s+\d{4}-\d{2}-\d{2}.*$/, '').trim() || 'Applied';
  const res = setTrackerStatus(careerOpsDir, { row: row.num }, currentStatus, { note: msg });
  if (!res.ok) return { ok: false, error: res.error, row };
  try {
    appendFollowupLog(careerOpsDir, {
      appNum: row.num,
      date: today,
      company: row.company,
      role: row.role,
      channel: 'LinkedIn',
      notes: msg,
    });
  } catch (e) {
    return { ok: false, error: `Tracker actualizado, pero falló follow-ups.md: ${e.message}`, row };
  }
  return { ok: true, row };
}
