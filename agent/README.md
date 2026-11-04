# Headhunter agent

Agente 24x7 que usa [career-ops](https://github.com/career-ops-hq/career-ops) para buscar ofertas, evaluarlas con Antigravity CLI (`agy`) y avisar por email.

```
career-ops/   ← clon de career-ops (código de career-ops + TUS datos, ignorados por git)
agent/        ← código de este proyecto (no lleva datos personales)
```

## Ciclo (`agent/run-cycle.sh`, cada 4 h)
1. `node scan.mjs`: escaneo sin coste de tokens (empresas, Manfred, WTTJ, Landing.jobs) → `data/pipeline.md`
2. `agy -p "Run career-ops pipeline mode…"`: triaje + evaluación A–G de como máximo `MAX_EVALS_PER_CYCLE` ofertas → `reports/`
3. `node merge-tracker.mjs` → `data/applications.md`
4. `node agent/notify.mjs`: email con las ofertas nuevas de score ≥ `ALERT_THRESHOLD` (4.0)

Además: `notify.mjs --digest` cada día a las 21:00 (resumen + señal de que el agente sigue vivo).

**Nunca aplica ni envía nada.** La aplicación asistida con aprobación por Telegram es la Fase 3.

## Comandos
| Acción | Comando |
|---|---|
| Probar email | `cd agent && node notify.mjs --test` |
| Ver qué se enviaría | `node notify.mjs --dry-run` |
| Ciclo manual solo escaneo | `SKIP_EVAL=1 ./run-cycle.sh` |
| Ciclo manual completo | `./run-cycle.sh` (logs en `agent/logs/`) |
| Subir datos al servidor | `./agent/sync-to-server.sh user@host` (simulación) → `--apply` |
| Instalar en el servidor | `ssh user@host 'cd ~/Headhunter-Assistant/agent && ./install-server.sh'` |
| Activar 24x7 | `sudo systemctl enable --now headhunter-cycle@$USER.timer headhunter-digest@$USER.timer` |
| Ver logs | `journalctl -u headhunter-cycle@$USER -f` |

## Permisos de `agy` en modo headless
`agy -p` no puede pedir permisos de forma interactiva. [`agy-settings.json`](agy-settings.json) contiene la lista de permitidos/denegados para el usuario del servidor (fusionar en `~/.gemini/antigravity-cli/settings.json`). Permite `node` y escribir en `reports/`, `data/`… Deniega `sudo`, `curl`, `git push` y escribir en `cv.md`, `config/`, `modes/` y `portals.yml`.
