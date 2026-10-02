# Coordination board

Updated: 2026-10-02 (America/Monterrey)

| Carril | Rama | Chat / dueño | Archivos nuevos / tocados | Migraciones reservadas | Flags | Estado | Última actualización |
|---|---|---|---|---|---|---|---|
| A — Waiver Intelligence | — | Sin asignar en GitHub remoto | `lib/waivers/*` (propuesto) | Ninguna | `WAIVER_INTEL_V2` | Sin reclamar; no se inicia para evitar duplicar la otra tarea amplia | 2026-09-30 |
| B — Matchup-aware Lineup | `feat/matchup-lineup-v2` (remota; draft PR #1) | Codex: Inspecciona carriles de nfl-fantasy | `lib/lineup/schemas.ts`, `lib/lineup/matchup.ts`, `tests/lineup.test.ts`; integración de UI/orquestador pendiente | Ninguna | `MATCHUP_LINEUP_V2` | Motor determinístico y 11 pruebas agregados; usa `optimizeLineup`; edge normalizado, muestra, frescura, rol y fuente; modo apagado preserva optimizer; preview Vercel Ready verificada; falta cableado cuando C libere puntos compartidos | 2026-09-30 |
| C — Base compartida | `feat/decision-engine` (remota, 2 commits sobre `main`; sin PR abierto) | Codex: Convertir app en decision engine | Archivos del compare remoto: `.env.example`, `README.md`, rutas sync, `app/globals.css`, `app/page.tsx`, `components/command-center.tsx`, migración 002, `lib/data-version.ts`, `lib/db.ts`, `lib/engine.ts`, `lib/fallback-data.ts`, `lib/orchestrator.ts`, providers, identity/snapshot, `proxy.ts`, migrator y pruebas | `002_decision_state.sql` aplicada por la tarea paralela; `schema_migrations` confirma `001_init.sql` y `002_decision_state.sql` en la base configurada. No se verificó si es la DB de producción | `APP_ACCESS_PASSWORD` | C publicado como rama; no PR abierto. El roster estático se retiró de fallback y conserva señal STALE; `proxy.ts` exige password y falla cerrado si falta; env de producción no verificado | 2026-09-30 |

## Carril D — Flaim live sync

| Rama | Chat / dueño | Archivos nuevos / tocados | Migración reservada | Flag | Estado | Última actualización |
|---|---|---|---|---|---|---|
| `feat/flaim-live-sync` | Codex: conexión OAuth/MCP Flaim | `lib/flaim/*`, `app/api/flaim/*`, `app/.well-known/oauth-client/route.ts`, UI, proxy, cron, README, `docs/COORDINATION.md` | `003_flaim_oauth.sql`; solo en la rama, no aplicada | `FLAIM_MCP_SYNC_V1` (solo Preview) | PR borrador #4; Preview Ready; DCR devuelve `invalid_redirect_uri` para el callback del Preview. Sin conexión Flaim, Sincronizar usa `/api/sync` y los datos guardados se muestran como históricos. Falta autorización del callback para conexión directa Flaim | 2026-10-02 |

## Auditoría de coordinación — 2026-10-01

- `origin/main` actualizado a `42b405b`. No hay PRs abiertos en GitHub.
- Ramas remotas: `feat/decision-engine` está en `ee4098d`; sus cambios compartidos están integrados en main por PR #2. `feat/matchup-lineup-v2` está en `12d1022`; los primitives de matchup están integrados en main por PR #1. `fix/lineup-test-identity-import` se integró por PR #3.
- Lane A Waiver Intelligence sigue sin asignar. Lane B tiene el motor determinístico en main; el cableado completo de UI/orquestador sigue pendiente. Lane C está integrada en main.
- El último estado de producción verificado en Vercel fue Ready en `q-ecru-nu.vercel.app`, commit `42b405b`. El conector Vercel de esta sesión no devuelve teams (scope vacío), así que no se pueden consultar deployments desde MCP ahora.
- No se expuso ninguna credencial local; falta verificar si Neon aplica `003_flaim_oauth.sql` en producción. El almacenamiento también crea la tabla con SQL idempotente al conectar.

## Verificación externa

- GitHub muestra `main`, `feat/decision-engine` (2 commits sobre main; sin PR) y `feat/matchup-lineup-v2` (draft PR #1 abierto).
- El conector de Vercel rechaza leer el deployment por scope de equipo (403); desde el navegador se confirmó que la preview más reciente de B está `Ready` en `https://q-git-feat-matchup-lineup-v2-octaviovds-projects.vercel.app/`. La UI sigue sin cablear el nuevo motor y muestra la advertencia de datos vencidos con estado global `HEALTHY`. No se hizo deploy de producción.
- No hay conector Neon. Una consulta de solo lectura sobre la `DATABASE_URL` local confirmó las tablas y las versiones `001_init.sql` y `002_decision_state.sql`; la segunda aparece aplicada por la otra tarea. No se confirmó si la URL es producción ni se aplicaron migraciones desde este carril.
- `.env.local` contiene `DATABASE_URL`, pero no `SPORTSDATAIO_API_KEY`; SportsDataIO no pudo probarse con credenciales. No se copiaron secretos al clon. La inspección de la rama paralela ya no encuentra el roster estático identificable en `fallback-data.ts`.
- La rama paralela añade `APP_ACCESS_PASSWORD` server-side con Basic Auth para la app y respuesta 503 fail-closed si falta. El valor configurado en producción no se pudo verificar por el 403 de Vercel.
- `MATCHUP_LINEUP_V2` está preparado como flag explícito para el caller; falta exponerlo desde el servidor y conectar la UI cuando el trabajo paralelo libere esos archivos.

## Verificación del carril D — Flaim live sync (2026-10-01)

- `fantasyphenomz` devuelve una liga activa ESPN Football 2026; Flaim marca el matchup actual como semana 4 con `currentMatchupPeriod` y `scoringPeriodId` (no envía `currentWeek` en `get_league_info`).
- `get_league_info` entrega nombre/tamaño/estado, periodos, equipos, settings de puntuación/roster y settings de liga. `scoringSettings.type` es `H2H_POINTS`; el valor por recepción no viene en los campos observados, así que la normalización lo omite en vez de asumir Standard o PPR.
- `get_roster` respondió 15 entradas identificables con posición, elegibilidad, slot, equipo NFL, estatus de lesión, stats, adquisición y porcentajes ESPN; la respuesta no incluyó un timestamp de proveedor conocido.
- `get_free_agents` respondió 25 jugadores e indicó capacidades para `percentOwned`, `percentStarted` y `acquisitionState`; los porcentajes son de mercado ESPN global, no solo de esta liga.
- `get_matchups` con `detail: players`, `team_id` y semana 4 respondió un matchup con 32 registros de jugadores. La llamada anterior fallaba porque enviaba `currentWeek`, ausente en esa respuesta; el adaptador ahora deriva semana del periodo actual y conserva fallback a resumen.
- `get_transactions` respondió hasta 25 transacciones con tipo, estado, fecha/semana, equipos, altas/bajas y `faab_bid`; el orden actual de prioridad de waivers no está en la respuesta consultada.
- Flaim documenta que conectores MCP personalizados usan OAuth y Streamable HTTP. Aún no se verifican el registro automático de este cliente ni el callback desde una Preview pública.
- Validación local del carril D: lint, typecheck, 64 pruebas y build pasaron. No se aplicó migración a Neon ni se activó el flag en producción.
- GitHub branch `feat/flaim-live-sync` quedó publicada en `4521a01`; existe PR borrador #4. Vercel muestra la Preview `https://q-385gn8gif-octaviovds-projects.vercel.app/` como Ready.
- La conexión Vercel de Codex no autoriza el scope del proyecto `q` (403). La bandera está apagada hasta habilitar `FLAIM_MCP_SYNC_V1=1` solo en Preview; no se habilitó producción ni se probó el callback OAuth web.

## Diagnóstico del carril D — OAuth del Preview (2026-10-02)

- El metadato público de Flaim publica `/auth/register` y PKCE S256. Una solicitud de registro para el Preview respondió HTTP 400 `invalid_redirect_uri` con callback `https://q-git-feat-flaim-live-sync-octaviovds-projects.vercel.app/api/flaim/callback`; no se creó un cliente ni se concedió acceso a la liga.
- Los logs de Vercel muestran `GET /api/flaim/connect` con redirección 307 y `flaim_oauth_start_failed`; no hay petición al callback. El código previo ocultaba el error del proveedor y mostraba el mismo mensaje para todas las fallas.
- El arreglo conserva el código de error seguro para la UI y los logs; sin conexión Flaim, Sincronizar recalcula el último snapshot disponible mediante la ruta anterior.
- Se añadió soporte server-side para un client ID/secret autorizado manualmente y el flujo solicita únicamente `mcp:read`; no se añadieron credenciales ni se modificaron datos de producción.
- Verificación local: lint, typecheck, build y 67 pruebas pasan. El bloqueo externo restante es que Flaim autorice el callback del Preview o emita un client ID para ese callback, seguido del consentimiento OAuth del usuario y una sincronización real.

## Recuperación de snapshots de liga guardados — 2026-10-02

- `/api/sync` recalcula el último snapshot que recibió `/api/external-sync`; no obtiene roster de ESPN por sí solo. No se encontró en este repositorio un proceso externo que envíe snapshots nuevos.
- Si el snapshot está vencido, el recálculo conserva roster y disponibles del último ingest, etiqueta la semana de origen y bloquea recomendaciones actuales. Así también se recupera un ingest que antes se había guardado con el roster oculto.
- El snapshot disponible en la Preview pertenece a semana 3; para mostrar datos nuevos de semana 4 se necesita que vuelva a funcionar la fuente que enviaba snapshots o completar OAuth Flaim.
