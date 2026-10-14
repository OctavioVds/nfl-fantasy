# Verificación — 2026-10-14

## Ingeniería

- Baseline main42b405b: 59 pruebas/5 archivos, typecheck, lint y build verdes antes de tocar código.
- Implementación final: `npm run typecheck`, `npm run lint`, `npm test`: PASS; 157 pruebas Vitest/12 archivos. `npm run build`: PASS, Next.js16.3.8, 12 rutas generadas. `git diff --check`: PASS tras corregir una línea vacía final.
- Python3.12: `python -m unittest discover -s scripts/core -p 'test_*.py' -v`: 21 pruebas PASS. Son fixtures ficticios, no validación deportiva.
- Runtime `npm audit --omit=dev`: 0 vulnerabilidades tras parche Next/sharp/source-map-js. El audit completo conserva8 de desarrollo (1moderada,5altas,2críticas); pendiente actualización mayor de herramientas con regresiones. No se exponen sus servidores.
- VerifierAgent revisó scoring, fechas, auth, escenarios, consumo y leakage. Correcciones: IDbase reservado; bloquear todas las condicionales si disponibilidad crítica falla; TTL/cutoff de forecasts futuros; conservar empates SQL contradictorios; rechazar IDs sociales duplicados; catálogo común TS/Python; vencimiento de APIs/UI sin nueva corrida.

## Neon y UI reales

Proyecto `fantasy-command-center-db`; producción conserva001/002. Rama aislada `preview-predictive-core` / `br-ancient-bird-awn1kkay`: migración003 aplicada, 19 statements sin errores. No borrar tablas/datos.

Botón local real `Recalcular núcleo` → HTTP200 → Neon: run82a00f6feb0d, BLOCKED, 0proyecciones, 2incidencias, gatefalse. Snapshot de liga23septiembre/semana3, no una consulta nueva ESPN. Las fichas/alertas vencidas desaparecen y se muestra razón/fecha/persistencia. Repetir con los mismos inputs/modelo/estado devuelve el mismo ID. Prueba visual guardada fuera del repo público.

## Precisión y activación

Main actuals0/accuracy_metrics0/projections_by_source0; sin scoring canónico completo ni historial pregame/ESPN archivado. MAE/RMSE/ventaja/cobertura/calibración reales: null, razón dataset ausente. No hay artefacto real aceptado. USE_PREDICTIVE_CORE no habilita filas nuevas sin esa aceptación; las pruebas de ingeniería no la sustituyen.

## Despliegue

Proyecto Vercelq confirmado mediante CLI oficial; MCP devuelve403 de scope. Credenciales sensibles de producción no exportables; se conservan. Secrets de verificación y DATABASE_URL configurados solo para rama feat/predictive-core.

PR[5](https://github.com/OctavioVds/nfl-fantasy/pull/5), draft, rama feat/predictive-core; commits de auditoría13f3550, inferencia483dd03 y trainer3610ebe. El conector GitHub403 para crearPR se resolvió con la sesión local de Git Credential Manager sin imprimir tokens.

Preview del commit3610ebe [Ready](https://q-ayxbjz2eo-octaviovds-projects.vercel.app): página con Basic200, sin Basic401; status200/BLOCKED/gatefalse/0proyecciones; backtest200/metricsnull; week19 y team ausente400; Bearerincorrecto401; cronsinsecret401 y consecret200. Dos POSTautorizados200 devolvieron el mismo ID82a00f6feb0d. No se exponen cuerpos privados de respuesta en este reporte.

Después del preview, migración003 aplicada transaccionalmente en Neonmain (19statements más registro de versión), sin errores ni modificaciones de tablas previas. Se corrigió `.vercelignore` para excluir todos los archivos `.env*` salvo ejemplo y verificó con deploy--dry que el paquete nuevo excluye configuraciones privadas. El primer intento CLI contenía envfiles locales dentro del paquete privado de Vercel; no se subieron al GitHub público ni hay evidencia de exposición a clientes. La publicación corregida se documenta al terminar.

El preview precede a cualquier publicación en producción. No se declara entrenamiento, conexión ESPN automática, minuto exacto de cron Hobby ni precisión que no se haya medido.

Producción corregidaa17561b: [q-ecru-nu](https://q-ecru-nu.vercel.app), deploymentdpl_7wQZXvWvTPubzmvqooQDDL4pbWXm Ready. Paquete93archivos, 0envfiles privados/0workfiles. El cron oficial `vercel crons run /api/cron/core` invocado14oct16:37:30UTC persistió en Neonmain a16:37:31 el mismo run82a00f6feb0d, BLOCKED, 0proyecciones, 2incidencias, gatefalse. GETstatus sinBasic401: protección conservada. La UI completa de producción requiere la contraseña del usuario y no se afirma que haya sido recorrida autenticada.

Plan real confirmado mediante APIteam: Hobby. Cron sync14:30UTC/core14:35UTC constan en `vercel crons list`. La hora de inicio en Hobby puede variar dentro de la hora; entrenamiento sigue offline. La revisión del chat08:30 y estos jobs son mecanismos diferentes. Última regresión adicional: un OUT/bye con media0 no supera un jugador activo con media negativa; consumidores también rechazan timestamps inválidos/futuros.
