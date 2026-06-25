## Bot Asistente Familiar

Backend MVP para un asistente familiar de productividad basado en Telegram.

### Stack

- NestJS
- TypeScript
- Prisma ORM
- PostgreSQL
- Telegraf
- OpenAI API
- Docker

### Funcionalidades del MVP

- Registro multi-familia por Telegram
- Primer `/start` con contacto crea familia y admin cuando no existe pre-registro
- Alta manual de usuarios por admin con `/crearusuario Nombre +56912345678`
- Vinculacion de usuarios precreados compartiendo su contacto
- Tareas personales y familiares
- Listados `/hoy`, `/pendientes`, `/familiares`, `/completadas`
- Visualizacion de tareas vencidas en una seccion separada
- Indicador visual `📝` para tareas con nota
- Vista de detalle con `/ver N`
- Notas por tarea con `/nota N`
- Edicion contextual de tareas con `/editar`
- Alertas configurables por usuario con `/alertas`
- Override de alertas por tarea desde el editor contextual
- Renombrado de familia para administradores
- Resolucion de `/hecho N` y `/eliminar N` contra la ultima lista mostrada
- Recordatorios automaticos
- Briefing diario sin duplicados

### Variables de entorno

Copia `.env.example` a `.env` y completa:

```bash
cp .env.example .env
```

Variables clave:

- `TELEGRAM_BOT_TOKEN`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` default: `gpt-5.4-mini`
- `DATABASE_URL`
- `DEFAULT_TIMEZONE`
- `DEFAULT_DAILY_BRIEFING_TIME`
- `DAILY_BRIEFING_GRACE_MINUTES`
- `REMINDER_MINUTES_BEFORE`
- `REMINDER_OVERDUE_GRACE_MINUTES`

Si `OPENAI_API_KEY` no existe, el bot usa un parser heuristico minimo para crear tareas.

### Arranque local

```bash
npm install
cp .env.example .env
docker compose up -d db
npm run prisma:deploy
npm run prisma:seed
npm run start:dev
```

La API HTTP queda en `http://localhost:3000`:

- `GET /`
- `GET /health`

### Comandos de Telegram

- `/start`
- `/ayuda`
- `/crearusuario Nombre +56912345678`
- `/hoy`
- `/pendientes`
- `/familiares`
- `/completadas`
- `/ver 2`
- `/nota 2`
- `/alertas`
- `/editar`
- `/hecho 2`
- `/eliminar 2`

### UX actual del bot

- Las tareas vencidas aparecen agrupadas bajo `🚨 Tareas vencidas`
- Las tareas del dia aparecen bajo `🗓️ Hoy`
- El resto aparece bajo `Otras tareas`
- Las tareas con nota muestran el indicador `📝`
- `/ver N` muestra el detalle de una tarea y su nota actual
- `/nota N` permite crear, editar o borrar la nota asociada a una tarea
- La lista de pendientes muestra acciones contextuales para `Completar varias`, `Editar` y `Eliminar varias`
- Si envias solo `/editar`, el bot abre una seleccion guiada de tareas pendientes
- La edicion de tareas permite cambiar `Titulo`, `Fecha/Hora`, `Nota` y `Alerta` desde menus contextuales
- La edicion de `Fecha/Hora` ofrece atajos `+30 min`, `+2 horas`, `Mañana`, `Sin fecha` y `Otro...`
- `/alertas` permite definir la anticipacion predeterminada de recordatorios por usuario
- Cada tarea puede usar una alerta propia o heredar la predeterminada del usuario
- `/ayuda` ahora muestra un resumen corto con botones contextuales por categoria: `Tareas`, `Listas`, `Edicion`, `Recordatorios`, `Familia` y `Comandos`
- `Editar familia` ahora muestra una pantalla inicial de acciones: `Renombrar familia`, `Agregar miembro`, `Quitar miembro` y `Cerrar`
- `Quitar miembro` abre un segundo paso con seleccion multiple de integrantes y boton `Eliminar`
- en esos flujos, `Volver` regresa al paso anterior y `Cerrar` quita los botones inline del mensaje para no dejar la interfaz abierta
- el menu principal del bot ahora depende del rol; `Editar familia` solo aparece para administradores
- Al cerrar el editor, el bot muestra el estado final real de la tarea en vez de responder que la edicion fue cancelada
- El bot usa jerarquia visual con `bold` en encabezados, preguntas, etiquetas y numeracion; el contenido de la tarea queda en texto regular
- Si envias solo `/hecho`, `/eliminar` o `/ver` sin indice, el bot responde con una guia corta del formato esperado

### Resolucion de alertas

El sistema resuelve la anticipacion de recordatorios en este orden:

1. `Task.reminderMinutesBefore` como override por tarea
2. `User.reminderMinutesBefore` como preferencia predeterminada del usuario
3. `Settings.reminderMinutesBefore` como fallback familiar
4. `REMINDER_MINUTES_BEFORE` como fallback global

Comportamiento actual:

- si una tarea define su propia alerta, esa configuracion gana
- si la tarea no define alerta, hereda la del usuario
- si el usuario tampoco define alerta, se usa la familiar
- si no existe configuracion familiar, se usa la variable global
- el valor `0` significa `Sin recordatorio`

### Siguiente paso propuesto

Configuracion avanzada de alertas y modelado de subtareas:

- presets y texto mas explicito para alertas por tarea segun contexto de vencimiento
- futura preferencia separada para briefing diario y recordatorios de tareas
- subtareas como entidad independiente, no embebida en `description`

### Ejemplos de lenguaje natural

- `Comprar pan mañana`
- `Tarea familiar: pagar cuentas`
- `Preparar presentacion Porsche el viernes`

### Flujo de onboarding

1. Un usuario escribe `/start`
2. El bot pide compartir contacto
3. Si el telefono coincide con un usuario precreado, se vincula a esa familia
4. Si no coincide, se crea una nueva familia y ese usuario queda como `FAMILY_ADMIN`

Notas operativas del onboarding:

- la vinculacion ahora normaliza mejor telefonos chilenos para evitar falsos negativos entre formatos como `+569...`, `569...`, `09...` o `9...`
- si un telefono fue vinculado por error en produccion antes de este fix, puede requerir limpieza manual del `User` o de la familia creada por error

### Produccion con Docker

```bash
cp .env.example .env
docker compose up --build
```

### Despliegue en Render

Este proyecto ya incluye [render.yaml](/Users/ftapioca/Projects/Asistente Bot Telegram/render.yaml).

Configuracion recomendada en Render:

- tipo de servicio: `Web Service`
- runtime: `Docker`
- plan web: `free`
- base de datos: `Render Postgres free`
- instancias: `1`
- health check: `/health`

Importante:

- el proyecto ya no usa SQLite en produccion
- `DATABASE_URL` se inyecta desde Render Postgres mediante `fromDatabase`
- con un bot de Telegram por polling tampoco debes correr mas de una instancia, o tendras error `409 Conflict`
- la base Postgres free de Render expira si queda 30 dias sin uso

Pasos:

1. Sube este repo a GitHub.
2. En Render, crea `New > Blueprint`.
3. Conecta el repo y selecciona la rama principal.
4. Render detectara `render.yaml`.
5. Completa los secretos en el dashboard:
   - `OPENAI_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
6. Despliega el Blueprint.

Valores relevantes ya definidos en `render.yaml`:

- `DATABASE_URL` desde `fromDatabase`
- `PORT=3000`
- `NODE_ENV=production`

Verificacion despues del deploy:

- abre `https://tu-servicio.onrender.com/health`
- debe responder `{"status":"ok"}`
- luego prueba el bot en Telegram con `/start`

### Keepalive externo para Render Free

Si mantienes el `Web Service` en `plan: free`, Render puede suspenderlo tras 15 minutos sin trafico entrante. Para evitar el cold start y reducir la perdida de jobs en memoria, configura un monitor externo que haga `GET` a:

- `https://bot-asistente-familiar.onrender.com/health`

Configuracion recomendada:

- metodo: `GET`
- intervalo: cada `10` a `14` minutos
- timeout: `30` a `60` segundos
- criterio de exito: HTTP `200`

Notas:

- un cron interno dentro de NestJS no sirve para despertar el servicio si Render ya lo durmio
- este keepalive mantiene vivo el `web service`, pero sigue siendo una mitigacion operativa, no una garantia fuerte
- el proyecto ya incluye una ventana de recuperacion para briefings y recordatorios si el servicio despierta tarde

Servicios tipicos para esto:

- UptimeRobot
- Better Stack
- cron-job.org

Recomendacion:

- rota tu `OPENAI_API_KEY` y tu `TELEGRAM_BOT_TOKEN`
- esos secretos ya fueron expuestos durante esta sesion y no deberian seguir vigentes

### Local con Docker Compose

`docker-compose.yml` ya incluye un contenedor `postgres` para desarrollo local:

```bash
docker compose up -d db
npm run prisma:deploy
npm run prisma:seed
npm run start:dev
```

### Notas de implementacion

- GPT solo interpreta texto y devuelve estructura
- La logica de negocio queda en NestJS
- Este MVP solo soporta chat privado con el bot
- Una cuenta de Telegram pertenece a una sola familia
- Las notas de tareas usan el campo `description` del modelo `Task`
- La edicion contextual actual de tareas usa menus inline y texto libre solo cuando el usuario debe ingresar un nuevo valor
- La presentacion del bot en Telegram usa `parse_mode=HTML` para aplicar negritas sin alterar el contenido real de tareas y notas
