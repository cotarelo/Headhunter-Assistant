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

Además, timer `headhunter-digest@`: resumen diario a las 21:00 (señal de que el agente sigue vivo) y recordatorios de seguimiento.

## Alertas de Telegram
Cada oferta llega con puntos fuertes, gaps, una recomendación según el score y dos botones (**🚀 Aplicar** / **❌ Descartar**):

| Score | Recomendación |
|---|---|
| ≥ 4.5 | 🟢 Recomendado: aplica |
| 4.3–4.4 | 🟡 Vale la pena aplicar, revisa los gaps |
| 4.1–4.2 | 🟠 Dudoso |
| < 4.1 | 🔴 No recomendado |
| Con bloqueos (`hard_stops`) | ⛔ No recomendado |

## Aplicación asistida (bot de Telegram, `bot.mjs`)
Servicio `headhunter-bot@`. Solo obedece al chat emparejado con `/start`.

1. **Preparar** (`prepare.mjs`): al pulsar *Aplicar* (o `/preparar N`), genera CV y carta adaptados y extrae el formulario. Puedes pedir cambios respondiendo al mensaje de la carta o del CV.
2. **Enviar** (`submit.mjs`): rellena y envía el formulario con Playwright. Si hay CAPTCHA o un campo que no sabe rellenar, te avisa para que lo termines tú y lo marques con *Ya la he enviado* / `enviada`.
3. **Seguimiento** (`lib/followup.mjs`): recordatorios a los 7 y 14 días de enviar la candidatura.

**Nada se envía sin tu confirmación explícita en Telegram.**

| Comando | Qué hace |
|---|---|
| `/estado` | último ciclo y cola |
| `/top` | mejores ofertas (7 días) |
| `/cola` | próximas ofertas por evaluar |
| `/preparar N` | preparar CV, carta y formulario del informe N |
| `/enviar N` | enviar la candidatura (la prepara si hace falta) |
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
