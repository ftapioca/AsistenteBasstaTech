# Changelog

Este archivo resume los cambios relevantes del proyecto a partir del historial de commits reciente.

## Unreleased

- Se cierra la `Entrega 1` de mejoras de uso diario:
  - nuevo comando `/buscar texto` sobre tareas pendientes visibles
  - nuevo comando `/posponer N` con opciones `30m`, `2h`, `mañana` y `proxima semana`
  - nuevos filtros en `/pendientes`: `vencidas`, `sin fecha`, `mias`, `alta`
  - accesos rapidos desde `Ver tarea` para `Fecha`, `Alerta` y `Asignacion` en tareas familiares
- Se actualiza la documentacion para reflejar comandos, filtros y shortcuts de la Entrega 1.
- Se elimina `--forceExit` del script `test:e2e` tras estabilizar el cierre limpio del suite.
- Se agrega asignacion opcional para tareas familiares en creacion y edicion.
- Se aplica la matriz final de permisos:
  - tareas personales solo visibles y gestionables por su dueño
  - tareas familiares sin asignar editables por cualquier integrante
  - tareas familiares asignadas editables/completables por admin, asignador o asignado
  - eliminacion de tareas familiares restringida a admins
- Se documenta el comportamiento en `README.md` y se deja trazabilidad funcional de la feature.
- Se agrega una matriz operativa en `docs/task-assignment-matrix.md` para aterrizar permisos por accion y pantalla.
- Se agregan tests unitarios en `TasksService` para bloquear regresiones de visibilidad, edicion, borrado y reasignacion de ownership al convertir tareas a personales.
- Se ajustan los recordatorios familiares:
  - tareas familiares sin asignar notifican a todos los miembros activos con Telegram vinculado
  - tareas familiares asignadas notifican al creador y al asignado
- Se agrega persistencia por entrega en `TaskReminderDelivery`:
  - una sola notificacion por `task + user + dueDate`
  - retry simple para fallos transitorios
  - rescate dentro de `REMINDER_OVERDUE_GRACE_MINUTES`
  - sin reenvio si el envio ya fue exitoso y luego cambian preferencias
- Se mejora la gestion familiar del bot:
  - nueva vista `Ver miembros` con detalle por integrante
  - separacion explicita entre `Invitar miembro` y `Agregar miembro manualmente`
  - acciones directas desde el detalle para editar nombre, resetear vinculacion y quitar miembro

## 2026-07-07

### Voz y transcripcion

- `7edbb87` Clean up voice transcription debug logs
- `344c52d` Fix voice context handoff to NLP flow
- `483a409` Add deeper voice transcription diagnostics
- `78e2e62` Increase task note limit and document voice support
- `12643f6` Prefer allowed transcription models
- `2a5cb3f` Use direct HTTP for voice transcription
- `f342a1c` Simplify voice transcription request
- `ccb922e` Add diagnostics for voice note transcription
- `924e625` Add transcription fallback for voice notes
- `3176ed3` Add voice note task creation flow

### UX de tareas y recordatorios

- `b4892b5` Fix pending task list date grouping
- `2508adc` Improve task creation and reminder UX
- `1acdc81` Document task browsing and updated task menus
- `383e066` Refine task browsing and task type editing
- `c64fa39` Improve task edit flow and add optional wizard note
- `63c108a` Separate briefing preferences and document prioritized backlog
- `e0a7c1c` Improve daily briefing pending summary
- `d12af2a` Resync role-based Telegram menu
- `b0dd473` Fix family dialog close behavior

### Entornos y onboarding

- `2ab8a01` Harden bot env separation and family onboarding
- `0263405` Only use alternate env files when explicitly requested
- `e495cf9` Require confirmation before creating a new family
- `a857ee4` Ignore local bot env files and clarify local DB setup
- `dc9cab8` Add local Telegram bot environment for safe testing
- `f958c1b` Document current Telegram focus and paused WhatsApp trial
