// lib/telegram.mjs — minimal Telegram Bot API client (Node >= 22: global fetch/FormData/Blob).
import fs from 'node:fs';
import path from 'node:path';

export function tgConfig(root) {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  let chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  const stateFile = path.join(root, 'data', 'headhunter-telegram.json');
  if (!chatId) {
    try { chatId = String(JSON.parse(fs.readFileSync(stateFile, 'utf8')).chat_id || ''); } catch { /* not paired yet */ }
  }
  return { token, chatId, stateFile, enabled: Boolean(token && chatId) };
}

export async function tgCall(token, method, body, { multipart = false } = {}) {
  const url = `https://api.telegram.org/bot${token}/${method}`;
  const init = multipart
    ? { method: 'POST', body }
    : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) };
  const res = await fetch(url, init);
  const json = await res.json().catch(() => ({}));
  if (!json.ok) throw new Error(`telegram ${method}: ${json.description || res.status}`);
  return json.result;
}

export const tgSend = (token, chatId, text, extra = {}) =>
  tgCall(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

export async function tgSendFile(token, chatId, filePath, { caption = '', kind = 'document', extra = {} } = {}) {
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  if (caption) { fd.append('caption', caption.slice(0, 1024)); fd.append('parse_mode', 'HTML'); }
  for (const [k, v] of Object.entries(extra)) fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  fd.append(kind, new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  return tgCall(token, kind === 'photo' ? 'sendPhoto' : 'sendDocument', fd, { multipart: true });
}

export const esc = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
