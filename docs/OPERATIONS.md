# Primera corrida y operación

Desde este checkout, con sesión Vercel autenticada y proyectoq ya vinculado, ejecutar la misma primera corrida probada en producción sin descargar secretos:

```powershell
npx --yes vercel@latest crons run /api/cron/core --project q --scope octaviovds-projects
npx --yes vercel@latest crons list --scope octaviovds-projects
```

Abrir la pestaña Predicciones y pulsar Recalcular núcleo es la alternativa manual. Recalcula la ingesta existente; no consulta Flaim/ESPN desde Vercel. Sin snapshot actual y scoring completo, responde BLOCKED con razón. El bridge OAuth vivo de PR4 continúa pendiente; solo una ingesta realmente nueva cambia la fecha de consulta.

Con una entrada privada validada contra `lib/core/schema.ts`, POST `/api/core/run` acepta `{ "input": ... }` mediante `Authorization: Bearer <EXTERNAL_SYNC_SECRET>`; mismo contenido/artefacto/estado → mismo run_id. Guardar headers en archivo temporal privado o cliente seguro, nunca URL, repo o comando que imprima claves. POST `/api/external-sync` mantiene su contrato existente de liga para sincronizar roster/mercado.

Reentrenamiento exacto en [scripts/core/README.md](../scripts/core/README.md). Requiere historial pregame con licencia, scoring real, resultados y ESPN archivado, no los ejemplos ficticios de tests. GitHub Actions semanal queda sin entrenamiento privado activo hasta configurar esos datos y secretos. Verificar primero en la rama Neonpreview y revisar gate/MAE/RMSE/cobertura/calibración antes de activar consumidores.

El despliegue CLI solicitado puede actualizar producción sin merge del PRdraft. Antes de un push futuro amain, incorporar/revisar esta rama para evitar que Git redepliegue el main anterior. La migración003 es aditiva; no eliminar tablas al hacer rollback de código.
