## Bot Asistente Familiar

Backend MVP para un asistente familiar de productividad basado en Telegram.

### Stack

- NestJS
- TypeScript
- Prisma ORM
- SQLite
- Telegraf
- OpenAI API
- Docker

### Funcionalidades del MVP

- Registro multi-familia por Telegram
- Primer `/start` con contacto crea familia y admin cuando no existe pre-registro
- Alta manual de usuarios por admin con `/crearusuario Nombre +56912345678`
- Vinculacion de usuarios precreados compartiendo su contacto
- Tareas personales y familiares
- Listados `/hoy`, `/pendientes`, `/familiares`
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
- `OPENAI_MODEL`
- `DATABASE_URL`
- `DEFAULT_TIMEZONE`
- `DEFAULT_DAILY_BRIEFING_TIME`
- `REMINDER_MINUTES_BEFORE`

Si `OPENAI_API_KEY` no existe, el bot usa un parser heuristico minimo para crear tareas.

### Arranque local

```bash
npm install
cp .env.example .env
npm run db:init
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
- `/hecho 2`
- `/eliminar 2`

### Ejemplos de lenguaje natural

- `Comprar pan manana`
- `Tarea familiar: pagar cuentas`
- `Preparar presentacion Porsche el viernes`

### Flujo de onboarding

1. Un usuario escribe `/start`
2. El bot pide compartir contacto
3. Si el telefono coincide con un usuario precreado, se vincula a esa familia
4. Si no coincide, se crea una nueva familia y ese usuario queda como `FAMILY_ADMIN`

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
- plan minimo: `starter`
- instancias: `1`
- health check: `/health`
- disco persistente montado en `/app/data`

Importante:

- si usas `SQLite`, necesitas disco persistente
- los discos persistentes solo estan disponibles en servicios pagos
- con disco persistente no debes escalar a mas de una instancia
- con un bot de Telegram por polling tampoco debes correr mas de una instancia, o tendras error `409 Conflict`

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

- `DATABASE_URL=file:/app/data/dev.db`
- `PORT=3000`
- `NODE_ENV=production`

Verificacion despues del deploy:

- abre `https://tu-servicio.onrender.com/health`
- debe responder `{"status":"ok"}`
- luego prueba el bot en Telegram con `/start`

Recomendacion:

- rota tu `OPENAI_API_KEY` y tu `TELEGRAM_BOT_TOKEN`
- esos secretos ya fueron expuestos durante esta sesion y no deberian seguir vigentes

### Notas de implementacion

- GPT solo interpreta texto y devuelve estructura
- La logica de negocio queda en NestJS
- Este MVP solo soporta chat privado con el bot
- Una cuenta de Telegram pertenece a una sola familia
