# Verificación — 2026-10-14

## Ingeniería

- Baseline main42b405b: 59 pruebas/5 archivos, typecheck, lint y build verdes antes de tocar código.
- Implementación final: `npm run typecheck`, `npm run lint`, `npm test`: PASS; 156 pruebas Vitest/12 archivos. `npm run build`: PASS, Next.js16.3.8, 12 rutas generadas. `git diff --check`: PASS tras corregir una línea vacía final.
- Python3.12: `python -m unittest discover -s scripts/core -p 'test_*.py' -v`: 21 pruebas PASS. Son fixtures ficticios, no validación deportiva.
- Runtime `npm audit --omit=dev`: 0 vulnerabilidades tras parche Next/sharp/source-map-js. El audit completo conserva8 de desarrollo (1moderada,5altas,2críticas); pendiente actualización mayor de herramientas con regresiones. No se exponen sus servidores.
- VerifierAgent revisó scoring, fechas, auth, escenarios, consumo y leakage. Correcciones: IDbase reservado; bloquear todas las condicionales si disponibilidad crítica falla; TTL/cutoff de forecasts futuros; conservar empates SQL contradictorios; rechazar IDs sociales duplicados; catálogo común TS/Python; vencimiento de APIs/UI sin nueva corrida.

## Neon y UI reales

Proyecto `fantasy-command-center-db`; producción conserva001/002. Rama aislada `preview-predictive-core` / `br-ancient-bird-awn1kkay`: migración003 aplicada, 19 statements sin errores. No borrar tablas/datos.

Botón local real `Recalcular núcleo` → HTTP200 → Neon: run82a00f6feb0d, BLOCKED, 0proyecciones, 2incidencias, gatefalse. Snapshot de liga23septiembre/semana3, no una consulta nueva ESPN. Las fichas/alertas vencidas desaparecen y se muestra razón/fecha/persistencia. Repetir con los mismos inputs/modelo/estado devuelve el mismo ID. Prueba visual guardada fuera del repo público.

## Precisión y activación

Main actuals0/accuracy_metrics0/projections_by_source0; sin scoring canónico completo ni historial pregame/ESPN archivado. MAE/RMSE/ventaja/cobertura/calibración reales: null, razón dataset ausente. No hay artefacto real aceptado. USE_PREDICTIVE_CORE no habilita filas nuevas sin esa aceptación; las pruebas de ingeniería no la sustituyen.

## Despliegue

Proyecto Vercelq confirmado mediante CLI oficial; MCP devuelve403 de scope. Main original tiene despliegue Ready pero runtime privado401 sin password. Credenciales sensibles de producción no exportables; se conservan. Secrets de verificación y DATABASE_URL configurados solo para rama feat/predictive-core. Preview remoto y resultado final se añadirán al comprobarlos.

El preview precede a cualquier publicación en producción. No se declara entrenamiento, conexión ESPN automática, minuto exacto de cron Hobby ni precisión que no se haya medido.
