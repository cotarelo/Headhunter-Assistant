# Headhunter Assistant

Agente 24x7 para búsqueda, evaluación y aplicación asistida a ofertas de empleo usando [career-ops](https://github.com/career-ops-hq/career-ops) y Antigravity CLI (`agy`). Avisa por email y Telegram, y solo prepara/envía candidaturas cuando las apruebas desde Telegram.

## Arquitectura

- **`agent/`**: código del asistente 24x7 (escaneo, notificaciones por email, bot de Telegram, preparación de formularios Playwright y timers de systemd). No contiene datos personales ni credenciales.
- **`career-ops/`**: checkout local de `career-ops` con los datos de búsqueda y perfil (ignorado por Git).

Consulta la documentación detallada en [agent/README.md](agent/README.md).
