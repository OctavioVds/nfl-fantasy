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

`POST /api/sync` ejecuta el orquestador de análisis y consulta los proveedores NFL configurados. **No existe todavía un adaptador de ejecución que consulte Flaim o ESPN Fantasy directamente**: sin un POST nuevo a `/api/external-sync`, el snapshot previo se identifica como `STALE` y no se presenta como roster actual. `Promise.allSettled` conserva resultados de proveedores sanos cuando otro falla.

## Persistencia

Con `DATABASE_URL`, usa Neon Postgres. `npm run db:migrate` aplica las migraciones numeradas e idempotentes en `db/migrations/`; 001 conserva las tablas originales y 002 agrega estado actual versionado, sync runs, snapshots de roster/proyecciones/decisiones, mapeo de IDs y tablas de accuracy. Sin Neon usa memoria durante desarrollo; esa memoria no sobrevive a un reinicio o a otra instancia serverless.

## Variables

Consulta `.env.example`. `APP_ACCESS_PASSWORD` protege páginas y `/api/sync` con Basic Auth en Preview/Production. Si falta, la app falla cerrada con 503. `DATABASE_URL`, `EXTERNAL_SYNC_SECRET` y `CRON_SECRET` son variables server-side. SportsDataIO, StatsHawk, Sportradar y PostHog son opcionales.

## Seguridad

Las páginas y el sync manual exigen `APP_ACCESS_PASSWORD` fuera de desarrollo. La ingesta externa y el cron usan sus propios Bearer secrets server-side. Nunca se exponen los secretos al cliente. Los payloads externos se validan antes de ejecutar el análisis. El repo es público: no almacenes aquí datos privados de liga ni cookies ESPN.

## Alcance actual

Funcionan el orquestador determinístico, fallos parciales aislados, protección contra snapshots viejos, locks conservadores cuando falta kickoff, estado por proveedor, diff de roster por ID del proveedor, ingesta externa protegida, persistencia Neon opcional y UI responsive. Los joins entre IDs de proveedores distintos requieren filas explícitas en `player_id_map`; sin ellas se excluyen del cruce en vez de empatar por nombre. No se afirma consulta en vivo de la liga: el bridge de ingesta necesita un proveedor conectado fuera del botón Sync.
