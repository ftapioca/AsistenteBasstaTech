# Matriz operativa de tareas familiares asignadas

Este documento aterriza la politica funcional en acciones concretas del bot para evitar ambiguedades en futuras mejoras.

## Modelo

- `PERSONAL`: tarea privada del usuario.
- `FAMILY` sin asignar: tarea familiar compartida, visible para toda la familia.
- `FAMILY` asignada: tarea familiar visible para toda la familia, con una persona responsable.
- `createdByUserId`: usuario que creo o asigno la tarea.
- `assignedToUserId`: integrante responsable actual. En tareas personales siempre debe coincidir con el dueño.

## Reglas base

- Un admin familiar no puede ver tareas personales ajenas.
- Cualquier integrante puede crear una tarea familiar.
- Una tarea familiar puede quedar sin asignar.
- Si una tarea familiar esta asignada, solo `admin + creador/asignador + asignado` pueden editarla o completarla.
- Solo un admin puede eliminar tareas familiares.

## Matriz por accion

| Accion | Tarea personal | Familiar sin asignar | Familiar asignada |
| --- | --- | --- | --- |
| Ver en listas | Solo dueño | Toda la familia | Toda la familia |
| Ver detalle | Solo dueño | Toda la familia | Toda la familia |
| Crear | Dueño | Cualquier integrante | Cualquier integrante puede crearla y asignarla |
| Editar contenido | Solo dueño | Cualquier integrante | Admin, creador/asignador o asignado |
| Editar fecha/hora | Solo dueño | Cualquier integrante | Admin, creador/asignador o asignado |
| Cambiar asignacion | No aplica | Cualquier integrante | Admin, creador/asignador o asignado |
| Completar | Solo dueño | Cualquier integrante | Admin, creador/asignador o asignado |
| Eliminar | Solo dueño | Solo admin | Solo admin |

## Matriz por pantalla

### Creacion NLP

- Si el mensaje indica `para Ana`, `asignada a Juan` o equivalente, el parser intenta resolver `assigneeName`.
- Si la tarea es `PERSONAL`, la asignacion se fuerza al usuario que la crea.
- Si la tarea es `FAMILY` y no hay persona identificable, queda `sin asignar`.
- Si el nombre no coincide con un integrante de la familia, el bot debe rechazar la creacion con error explicito.

### Wizard `/nueva`

- Paso `Tipo`: define `PERSONAL` o `FAMILY`.
- Si el usuario elige `PERSONAL`, el flujo salta directo a fecha/hora.
- Si elige `FAMILY`, aparece un paso intermedio `Asignacion`.
- En `Asignacion`, se debe poder elegir cualquier integrante activo o `Sin asignar`.

### Listas `/hoy`, `/pendientes`, `/completadas`

- Nunca deben incluir tareas personales de otros integrantes, incluso si quien lista es admin.
- Las tareas familiares asignadas deben mostrar a quien quedaron asignadas.
- Las tareas familiares sin asignar deben seguir viendose como compartidas.

### Detalle `/ver`

- Para tareas familiares se debe mostrar:
  - quien la creo
  - a quien esta asignada o `Sin asignar`
- Para tareas personales no se debe exponer informacion de otros integrantes.

### Edicion `/editar`

- En tareas familiares debe existir accion especifica `Asignacion`.
- En tareas personales no debe aparecer `Asignacion`.
- Si el usuario no tiene permiso, el flujo debe fallar antes de abrir el editor final o al confirmar el cambio.

### Recordatorios

- En tareas `PERSONAL`, el recordatorio se envia al dueño de la tarea.
- En tareas `FAMILY` sin asignar, el recordatorio se envia a todos los integrantes activos con Telegram vinculado.
- En tareas `FAMILY` asignadas, el recordatorio se envia al creador/asignador y a la persona asignada.
- Si el creador y el asignado son la misma persona, el recordatorio se envia una sola vez.
- Cada entrega se persiste por `task + user + dueDateSnapshot`, por lo que un cambio posterior de preferencia no vuelve a disparar el mismo recordatorio ya enviado.
- Si el envio falla, el sistema deja la entrega como pendiente y reintenta en ticks posteriores dentro de `REMINDER_OVERDUE_GRACE_MINUTES`.

## Pendientes de la siguiente iteracion

- Definir si una reasignacion debe conservar a `createdByUserId` como creador historico o si se necesita un campo nuevo tipo `assignedByUserId`.
- Agregar tests funcionales del flujo Telegram para `wizard`, `editar asignacion` y `ver detalle`.

## Gestion familiar relacionada

- El administrador familiar dispone de una vista de miembros con rol y estado de vinculacion.
- Desde el detalle de un integrante puede:
  - editar el nombre visible
  - resetear su vinculacion Telegram si quedo mal enlazado
  - quitarlo de la familia si no es admin
