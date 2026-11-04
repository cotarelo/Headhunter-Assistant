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
import { tgConfig, tgCall, tgSend, esc } from './lib/telegram.mjs';
import { parseReport } from './notify.mjs';
import { spawnSync } from 'node:child_process';

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
      return tgSend(cfg.token, chatId, r.status === 0 ? `✅ Informe #${n} marcado como Applied.` : `No pude actualizar el tracker: ${esc((r.stderr || r.stdout).slice(0, 300))}`);
    }
    case '/ayuda':
    default:
      return tgSend(cfg.token, chatId, [
        '<b>HeadHunter Assistant</b>',
        '/estado — último ciclo y cola',
        '/top — mejores ofertas (7 días)',
        '/cola — próximas ofertas por evaluar',
        '/enviada N — marcar como Applied la candidatura del informe N',
        '',
        'Las ofertas con nota ≥ 4.0 te llegan aquí y por email. Nunca aplico sin tu ✅.',
      ].join('\n'));
  }
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
  if (action === 'manual') {
    setAppState(report, 'manual_pending');
    return tgSend(cfg.token, chatId, `👍 Informe #${report}: la envías tú. Cuando la hayas enviado escribe <code>/enviada ${report}</code> y la marco como Applied.`);
  }
  if (action === 'discard') {
    setAppState(report, 'discarded');
    const r = spawnSync('node', ['set-status.mjs', '--report', report, 'Discarded', '--note', 'Descartada desde Telegram'], { cwd: ROOT, encoding: 'utf8' });
    return tgSend(cfg.token, chatId, `❌ Informe #${report} descartado.${r.status === 0 ? '' : ' (no pude actualizar el tracker: ' + esc((r.stderr || r.stdout).slice(0, 200)) + ')'}`);
  }
}

async function main() {
  log(`starting; paired chat: ${cfg.chatId || '(none — send /start)'}`);
  let offset = 0;
  for (;;) {
    try {
      const updates = await tgCall(cfg.token, 'getUpdates', { offset, timeout: 50, allowed_updates: ['message', 'callback_query'] });
      for (const u of updates) {
        offset = u.update_id + 1;
        if (u.message) await handle(u.message).catch((e) => log('handle error', e.message));
        if (u.callback_query) await handleCallback(u.callback_query).catch((e) => log('callback error', e.message));
      }
    } catch (e) {
      log('poll error', e.message);
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}
main();
