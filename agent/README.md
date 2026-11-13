# Headhunter agent

Agente 24x7 que usa [career-ops](https://github.com/career-ops-hq/career-ops) para buscar ofertas, evaluarlas con Antigravity CLI (`agy`), avisar por email y Telegram, y preparar/enviar candidaturas **solo cuando tú lo apruebas** desde Telegram.

```
career-ops/   ← clon de career-ops (código de career-ops + TUS datos, ignorados por git)
agent/        ← código de este proyecto (no lleva datos personales)
```

## Ciclo (`agent/run-cycle.sh`)
Timer `headhunter-cycle@`: a las 08:15, 12:15, 16:15, 20:15 y 00:15 (±10 min). No corre de 00:00 a 08:00.

1. `node scan.mjs`: escaneo sin coste de tokens (empresas, Manfred, WTTJ, Landing.jobs) → `data/pipeline.md`
2. `agy -p "Run career-ops pipeline mode…"`: triaje + evaluación A–G de como máximo `MAX_EVALS_PER_CYCLE` ofertas → `reports/`
3. `node merge-tracker.mjs` → `data/applications.md`
4. `node agent/notify.mjs`: alerta por email y Telegram de las ofertas nuevas con score ≥ `ALERT_THRESHOLD` (4.0)
5. **Paquete para n8n**: para cada oferta nueva con score ≥ `AUTO_PACK_THRESHOLD` (4.7) y sin bloqueos, prepara (o reutiliza) CV y carta con `prepare.mjs --no-telegram` y envía un **email aparte** con asunto `[HH-APPLY] #N Empresa — Rol (score)` y adjuntos:
   - `CV_<Nombre>_<Empresa>.pdf`, `Cover_Letter_<Nombre>_<Empresa>.pdf` y `.txt`
   - `application.json`: `job_url`, `form_url`, `ats`, datos del candidato, carta y respuestas del formulario (`needs_review` marca las dudosas)
   - Cabeceras `X-Headhunter-Report`, `X-Headhunter-Score`, `X-Headhunter-Job-Url`

   Si falla, se reintenta en los 2 ciclos siguientes. Manual: `node notify.mjs --pack N`. Estado en `data/headhunter-notify-state.json` → `packs`.

Además, timer `headhunter-digest@`: resumen diario a las 21:00 (señal de que el agente sigue vivo) y recordatorios de seguimiento.

## Alertas de Telegram
Cada oferta llega con puntos fuertes, gaps, una recomendación según el score y tres botones (**🚀 Aplicar** / **❌ Descartar** / **✅ Ya he aplicado**). *Ya he aplicado* sirve cuando aplicas por otra vía (p. ej. Nod/n8n): marca la oferta como Applied y programa los recordatorios de seguimiento por LinkedIn a 7 y 14 días desde hoy. También aparece como **✅ Ya** en `/pendientes`.

| Score | Recomendación |
|---|---|
| ≥ 4.5 | 🟢 Recomendado: aplica |
| 4.3–4.4 | 🟡 Vale la pena aplicar, revisa los gaps |
| 4.1–4.2 | 🟠 Dudoso |
| < 4.1 | 🔴 No recomendado |
| Con bloqueos (`hard_stops`) | ⛔ No recomendado |

## Aplicación asistida (bot de Telegram, `bot.mjs`)
Servicio `headhunter-bot@`. Solo obedece al chat emparejado con `/start`.

1. **Aplicar → paquete para copiar y pegar** (`prepare.mjs`): al pulsar *🚀 Aplicar* (o `/preparar N`) te llegan el CV adaptado (2 páginas: experiencia en la 1ª, educación en la 2ª), la carta y cada respuesta del formulario como bloque que se copia al tocarlo. Si el portal bloquea la lectura del formulario (p. ej. Welcome to the Jungle), recibes las preguntas habituales (datos, salario, incorporación, autorización de trabajo, motivación, encaje). Si ya estaba preparada, pulsar *Aplicar* reenvía el paquete sin gastar agy.
2. **Envío automático (experimental, opcional)** (`submit.mjs`): botón *🤖 Probar envío automático* o `/enviar N`, solo si se pudo leer el formulario. Si hay CAPTCHA, te avisa para que lo termines tú.
3. **Seguimiento** (`lib/followup.mjs`): recordatorios a los 7 y 14 días de enviar la candidatura.

**Nada se envía sin tu confirmación explícita en Telegram** (salvo que conectes un flujo de n8n a los emails `[HH-APPLY]`: este repo solo envía el paquete, no aplica).

| Comando | Qué hace |
|---|---|
| `/estado` | último ciclo y cola |
| `/top` | mejores ofertas (7 días) |
| `/cola` | próximas ofertas por evaluar |
| `/pendientes [nota]` | ofertas ≥ 4.3 (o la nota indicada) sin decidir, con botones 🚀/❌; sin duplicados de re-evaluaciones |
| `/preparar N` | preparar CV, carta y formulario del informe N |
| `/enviar N` | intentar envío automático (experimental) |
| `/carta N <cambios>` / `/cv N <cambios>` | pedir a agy que modifique la carta o el CV |
| `/enviada N` | marcar como Applied |
| `/seguimiento` | estado y recordatorios a 7/14 días |
| `/contactado N [nota]` | registrar seguimiento por LinkedIn/email |

## Comandos
| Acción | Comando |
|---|---|
| Probar email/Telegram | `cd agent && node notify.mjs --test` |
| Ver qué se enviaría | `node notify.mjs --dry-run` |
| Ciclo manual solo escaneo | `SKIP_EVAL=1 ./run-cycle.sh` |
| Ciclo manual completo | `./run-cycle.sh` (logs en `agent/logs/`) |
| Subir datos al servidor | `./agent/sync-to-server.sh dietpi@dietpi` (simulación) → `--apply` |
| Instalar en el servidor | `ssh dietpi@dietpi 'cd ~/Headhunter-Assistant/agent && ./install-server.sh'` |
| Activar 24x7 | `sudo systemctl enable --now headhunter-cycle@$USER.timer headhunter-digest@$USER.timer headhunter-bot@$USER` |
| Ver timers | `sudo systemctl list-timers \| grep headhunter` |
| Ver logs | `journalctl -u headhunter-cycle@$USER -f` |

> `sync-to-server.sh --apply` copia también `data/` y `reports/` desde el Mac: puede pisar informes más recientes generados en el servidor. Para desplegar solo código, usa git (ver abajo).

## Despliegue de código
El servidor (`dietpi@dietpi:~/Headhunter-Assistant`) es un clon git y es quien hace `git push` a GitHub (la clave SSH del portátil no tiene acceso al repo):

```bash
git push dietpi@dietpi:Headhunter-Assistant main:refs/heads/from-laptop
ssh dietpi@dietpi 'cd ~/Headhunter-Assistant && git merge --ff-only from-laptop && git branch -d from-laptop && git push origin main'
```

`notify.mjs` y `run-cycle.sh` se cargan en cada ciclo; si cambias `bot.mjs` o `lib/`, reinicia el bot: `sudo systemctl restart headhunter-bot@dietpi`.

## Permisos de `agy` en modo headless
`agy -p` no puede pedir permisos de forma interactiva. [`agy-settings.json`](agy-settings.json) contiene la lista de permitidos/denegados para el usuario del servidor (fusionar en `~/.gemini/antigravity-cli/settings.json`). Permite `node` y escribir en `reports/`, `data/`… Deniega `sudo`, `curl`, `git push` y escribir en `cv.md`, `config/`, `modes/` y `portals.yml`.
