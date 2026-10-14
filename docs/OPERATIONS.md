# Primera corrida y operación

Desde este checkout, con sesión Vercel autenticada y proyectoq ya vinculado, ejecutar la misma primera corrida probada en producción sin descargar secretos:

```powershell
npx --yes vercel@latest crons run /api/cron/core --project q --scope octaviovds-projects
npx --yes vercel@latest crons list --project q --scope octaviovds-projects
```

Abrir la pestaña Predicciones y pulsar Recalcular núcleo es la alternativa manual. Recalcula la ingesta existente; no consulta Flaim/ESPN desde Vercel. Sin snapshot actual y scoring completo, responde BLOCKED con razón. El bridge OAuth vivo de PR4 continúa pendiente; solo una ingesta realmente nueva cambia la fecha de consulta.

## Pasos para el propietario

1. Para el asesor de la liga conectado al chat, abrir [NFL Fantasy Asesor](https://nfl-fantasy-asesor.syrupyaspen8.chatgpt.site/) con la cuenta propietaria. Revisar fecha de consulta, Resumen, Mi alineación y Disponibles. Actualizar Fantasy prepara una solicitud para este chat; después de completar aquí la actualización, Recargar consulta trae lo guardado.
2. Para revisar el nuevo Predictive Core, abrir [Command Center](https://q-ecru-nu.vercel.app). Si Vercel pide acceso, entrar con la cuenta del equipo propietario. Si el navegador pide Basic Auth, usuario `fantasy` y la contraseña ya configurada como APP_ACCESS_PASSWORD. No compartir contraseñas por chat. Predicciones muestra estado y motivos de bloqueo; ALINEACIÓN y ACCIONES necesitan datos actuales.
3. PowerShell solo se necesita para operación técnica. Los dos comandos de arriba incluyen proyectoq y equipo explícitos: pueden ejecutarse aunque la consola esté en System32. No hace falta ejecutar vercel link en System32. Para trabajar con los archivos, entrar primero a la carpeta del repo:

```powershell
Set-Location -LiteralPath 'C:\Users\calid\OneDrive\Documents\ChatGPT\NFL FANTASY 2\repos\nfl-fantasy'
```

4. `Cron job ... triggered` confirma el disparo; no confirma consulta nueva ESPN ni aceptación del modelo. `crons list` debe mostrar /api/cron/sync14:30UTC y /api/cron/core14:35UTC:08:30/08:35 en Ciudad de México. Hobby no garantiza minuto exacto. La revisión08:30 del chat es separada y requiere app/equipo disponibles.

Con una entrada privada validada contra `lib/core/schema.ts`, POST `/api/core/run` acepta `{ "input": ... }` mediante `Authorization: Bearer <EXTERNAL_SYNC_SECRET>`; mismo contenido/artefacto/estado → mismo run_id. Guardar headers en archivo temporal privado o cliente seguro, nunca URL, repo o comando que imprima claves. POST `/api/external-sync` mantiene su contrato existente de liga para sincronizar roster/mercado.

Reentrenamiento exacto en [scripts/core/README.md](../scripts/core/README.md). Requiere historial pregame con licencia, scoring real, resultados y ESPN archivado, no los ejemplos ficticios de tests. GitHub Actions semanal queda sin entrenamiento privado activo hasta configurar esos datos y secretos. Verificar primero en la rama Neonpreview y revisar gate/MAE/RMSE/cobertura/calibración antes de activar consumidores.

El despliegue CLI solicitado puede actualizar producción sin merge del PRdraft. Antes de un push futuro amain, incorporar/revisar esta rama para evitar que Git redepliegue el main anterior. La migración003 es aditiva; no eliminar tablas al hacer rollback de código.
