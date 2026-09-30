# Coordination board

Updated: 2026-09-30 (America/Monterrey)

| Carril | Rama | Chat / dueño | Archivos nuevos / tocados | Migraciones reservadas | Flags | Estado | Última actualización |
|---|---|---|---|---|---|---|---|
| A — Waiver Intelligence | — | Sin asignar en GitHub remoto | `lib/waivers/*` (propuesto) | Ninguna | `WAIVER_INTEL_V2` | Sin reclamar; no se inicia para evitar duplicar la otra tarea amplia | 2026-09-30 |
| B — Matchup-aware Lineup | `feat/matchup-lineup-v2` (remota; draft PR #1) | Codex: Inspecciona carriles de nfl-fantasy | `lib/lineup/schemas.ts`, `lib/lineup/matchup.ts`, `tests/lineup.test.ts`; integración de UI/orquestador pendiente | Ninguna | `MATCHUP_LINEUP_V2` | Motor determinístico y 11 pruebas agregados; usa `optimizeLineup`; edge normalizado, muestra, frescura, rol y fuente; modo apagado preserva optimizer; preview Vercel Ready verificada; falta cableado cuando C libere puntos compartidos | 2026-09-30 |
| C — Base compartida | `feat/decision-engine` (remota, 2 commits sobre `main`; sin PR abierto) | Codex: Convertir app en decision engine | Archivos del compare remoto: `.env.example`, `README.md`, rutas sync, `app/globals.css`, `app/page.tsx`, `components/command-center.tsx`, migración 002, `lib/data-version.ts`, `lib/db.ts`, `lib/engine.ts`, `lib/fallback-data.ts`, `lib/orchestrator.ts`, providers, identity/snapshot, `proxy.ts`, migrator y pruebas | `002_decision_state.sql` aplicada por la tarea paralela; `schema_migrations` confirma `001_init.sql` y `002_decision_state.sql` en la base configurada. No se verificó si es la DB de producción | `APP_ACCESS_PASSWORD` | C publicado como rama; no PR abierto. El roster estático se retiró de fallback y conserva señal STALE; `proxy.ts` exige password y falla cerrado si falta; env de producción no verificado | 2026-09-30 |

## Verificación externa

- GitHub muestra `main`, `feat/decision-engine` (2 commits sobre main; sin PR) y `feat/matchup-lineup-v2` (draft PR #1 abierto).
- El conector de Vercel rechaza leer el deployment por scope de equipo (403); desde el navegador se confirmó que la preview de B está `Ready` para `e6bc074` en `https://q-git-feat-matchup-lineup-v2-octaviovds-projects.vercel.app/`. La UI sigue sin cablear el nuevo motor y muestra la advertencia de datos vencidos con estado global `HEALTHY`. No se hizo deploy de producción.
- No hay conector Neon. Una consulta de solo lectura sobre la `DATABASE_URL` local confirmó las tablas y las versiones `001_init.sql` y `002_decision_state.sql`; la segunda aparece aplicada por la otra tarea. No se confirmó si la URL es producción ni se aplicaron migraciones desde este carril.
- `.env.local` contiene `DATABASE_URL`, pero no `SPORTSDATAIO_API_KEY`; SportsDataIO no pudo probarse con credenciales. No se copiaron secretos al clon. La inspección de la rama paralela ya no encuentra el roster estático identificable en `fallback-data.ts`.
- La rama paralela añade `APP_ACCESS_PASSWORD` server-side con Basic Auth para la app y respuesta 503 fail-closed si falta. El valor configurado en producción no se pudo verificar por el 403 de Vercel.
- `MATCHUP_LINEUP_V2` está preparado como flag explícito para el caller; falta exponerlo desde el servidor y conectar la UI cuando el trabajo paralelo libere esos archivos.
