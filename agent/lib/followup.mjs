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
                { text: '❌ Descartar / Rechazada', callback_data: `discard:${entry.num}` },
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
                { text: '❌ Dar por cerrada', callback_data: `discard:${entry.num}` },
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

export function recordFollowupDone(careerOpsDir, reportNum, note = '') {
  const today = new Date().toISOString().slice(0, 10);
  const msg = note ? `Follow-up enviado (${note}, ${today})` : `Follow-up enviado por Jorge (${today})`;
  const r = spawnSync('node', ['set-status.mjs', '--report', String(reportNum), 'Applied', '--note', msg], {
    cwd: careerOpsDir, encoding: 'utf8',
  });
  return r.status === 0;
}
