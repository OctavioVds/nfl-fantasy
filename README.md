# NFL Fantasy Command Center

Aplicación Next.js para consolidar snapshots de liga, ejecutar análisis determinísticos en paralelo y producir decisiones Fantasy explicables. Sin una consulta de liga fresca entra en modo **DEGRADED/STALE**, oculta el roster y bloquea recomendaciones accionables.

Producción: https://q-ecru-nu.vercel.app

## Desarrollo

```bash
npm install
npm run dev
```

Verificaciones:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Ingesta de liga

`POST /api/external-sync` es el adaptador autenticado para enviar el snapshot actual obtenido desde Flaim u otra integración autorizada. Requiere `Authorization: Bearer <EXTERNAL_SYNC_SECRET>`. El payload incluye `league`, `roster`, `freeAgents`, `source` y `sourceTimestamp`; los timestamps deben ser ISO-8601. Un snapshot válido reemplaza por completo el estado de liga del mismo proveedor, liga y temporada. El hash del contenido permite identificar cambios.

`/api/flaim/connect` inicia la autorización OAuth de Flaim con PKCE. Después de autorizar una vez, `POST /api/flaim/sync` consulta por MCP tu liga ESPN, roster, disponibles y matchup; el botón Sincronizar usa esa ruta. `/api/cron/sync` repite la consulta diariamente cuando hay una conexión activa. Si Flaim deja de autorizar o no hay conexión, la app conserva el último snapshot y lo marca como viejo.

### Conectar la liga

1. Abre la app e inicia sesión con la contraseña de acceso que ya configuraste.
2. Pulsa **Conectar Flaim**.
3. Inicia sesión en Flaim con la cuenta que ya tiene conectada ESPN y acepta el acceso de solo lectura.
4. Regresarás a la app; importará el roster y hasta 100 jugadores disponibles, y calculará las decisiones automáticamente. La pestaña **Disponibles** separa agentes libres de jugadores en waivers. Para una actualización posterior, pulsa **Sincronizar**.

`POST /api/sync` recalcula el último snapshot y consulta los proveedores NFL configurados. `Promise.allSettled` conserva resultados de proveedores sanos cuando otro falla.

## Persistencia

Con `DATABASE_URL`, usa Neon Postgres. `npm run db:migrate` aplica las migraciones numeradas e idempotentes en `db/migrations/`; 001 conserva las tablas originales, 002 agrega estado actual versionado y 003 agrega almacenamiento de conexión Flaim. Sin Neon usa memoria durante desarrollo; esa memoria no sobrevive a un reinicio o a otra instancia serverless.

## Variables

Consulta `.env.example`. `APP_ACCESS_PASSWORD` protege páginas y `/api/sync` con Basic Auth en Preview/Production. Si falta, la app falla cerrada con 503. `DATABASE_URL`, `EXTERNAL_SYNC_SECRET` y `CRON_SECRET` son variables server-side. SportsDataIO, StatsHawk, Sportradar y PostHog son opcionales.

## Seguridad

Las páginas y el sync manual exigen `APP_ACCESS_PASSWORD` fuera de desarrollo. La ingesta externa y el cron usan sus propios Bearer secrets server-side. El token OAuth de Flaim se guarda cifrado en Neon; la llave se deriva de `EXTERNAL_SYNC_SECRET` (o `CRON_SECRET`). Nunca se exponen tokens ni secretos al cliente. Flaim solo ofrece lectura: la app no pide cookies ESPN ni puede cambiar alineaciones, waivers o settings. El repo es público: no almacenes aquí datos privados de liga ni cookies ESPN.

## Alcance actual

Funcionan el orquestador determinístico, fallos parciales aislados, protección contra snapshots viejos, locks conservadores cuando falta kickoff, estado por proveedor, diff de roster por ID del proveedor, conexión OAuth/MCP de Flaim, ingesta externa protegida y persistencia Neon. Los joins entre IDs de proveedores distintos requieren filas explícitas en `player_id_map`; sin ellas se excluyen del cruce en vez de empatar por nombre. Las estadísticas y las recomendaciones dependen de las fuentes configuradas en Vercel.
