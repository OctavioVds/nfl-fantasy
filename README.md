# NFL Fantasy Command Center

Aplicación Next.js para consolidar datos de liga, ejecutar análisis determinísticos en paralelo y producir decisiones Fantasy explicables. Si no recibe una fuente actual de la liga, entra en modo **DEGRADED/STALE** y bloquea recomendaciones accionables.

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

`POST /api/external-sync` acepta snapshots validados con Zod desde Flaim, ChatGPT u otra integración. Requiere `Authorization: Bearer <EXTERNAL_SYNC_SECRET>`. El payload incluye `league`, `roster`, `freeAgents`, `source` y `sourceTimestamp`; los timestamps deben ser ISO-8601.

`POST /api/sync` ejecuta el orquestador. Sin una ingesta actual conserva el contexto histórico en modo degradado. Las fuentes independientes usan `Promise.all` y los fallos parciales no detienen el resto.

## Persistencia

Con `DATABASE_URL`, usa Neon Postgres. Aplica [db/migrations/001_init.sql](db/migrations/001_init.sql) antes del primer deploy. Sin Neon usa memoria durante desarrollo.

## Variables

Consulta `.env.example`. `DATABASE_URL`, `EXTERNAL_SYNC_SECRET` y `CRON_SECRET` son las variables principales. SportsDataIO, Sportradar y PostHog son opcionales.

## Seguridad

La ingesta externa y el cron exigen secretos sólo del servidor. Nunca se exponen al cliente. Los payloads externos se validan antes de ejecutar el análisis.

## Alcance actual

Funcionan el orquestador, protección de actualidad, locks por kickoff, scoring PPR, optimización de lineup, consenso de proyecciones, simulación, salud de providers, ingesta externa, persistencia Neon opcional y UI responsive. Flaim, SportsDataIO, Sportradar y PostHog requieren conexiones o credenciales disponibles en el entorno de producción.
