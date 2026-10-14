# Decisiones y excepciones

## Resoluciones posteriores a la auditoría

- Neon/Vercel se conectaron; Neon verificado y Vercel opera mediante CLI porque el token MCP carece del scope correcto. Migración003 se probó en rama aislada; producción permanece sin cambios de credenciales.
- Publicar la infraestructura verificada con gate estadístico cerrado permite revisar UI/API sin afirmar un modelo entrenado. Migración003 pasó primero en preview y después en Neonmain. La PR permanece draft hasta revisión; publicación CLI no equivale a merge de main.
- Se corrigieron los defectos de módulos anteriores con regresiones; siguen parciales respecto a sus especificaciones completas (slots universales, simulación trade completa y OAuth vivo pendiente). El core no acredita automáticamente esos módulos completos.
- WAR se compara con el mejor FA válido, no con el N-ésimo FA, que produciría un reemplazo artificialmente bajo. ROS/playoffs quedan en unidades semanales medias compatibles con el legado; sdnullsin correlaciones.
- Next.js se fija al parche16.3.8 y se actualizan sharp/source-map-js compatibles después de revisar npm audit. No se hace downgrade aNext14 ni fix--force para herramientas de desarrollo; vulnerabilidades restantes dev se registran en verificación. Sin exponer servidores de tests a terceros.
- SportsDataIO trial devuelve datos alterados según [su explicación oficial](https://sportsdata.io/help/scrambled-data). Trial/test no se usa para acreditar precisión. Tavily [publica1,000créditos gratuitos/mes](https://www.tavily.com/pricing), útil como opción de noticias; no proporciona rutas/snaps ni proyecciones archivadas de esta liga.

## Fase 0 — 2026-10-14

1. Los tres motores son parciales. Los prompts originales no están en repo; no se inventa certificación completa. Se pospone su reconstrucción total, se corrigen defectos negativos encontrados y se mantienen APIs existentes. Impacto: las heurísticas heredadas siguen provisionales y no deben presentarse como percentiles calibrados.
2. La PR #4 de OAuth Flaim sigue separada. Impacto: refrescar Vercel no obtiene automáticamente roster nuevo. Ingesta existente de snapshots y el chat conectado pueden aportar datos; no confundir recalcular con consultar ESPN.
3. Neon/Vercel plugins encontrados disponibles, no conectados al comenzar. El usuario eligió conectarlos. No hay credenciales locales. Migraciones remotas, scoring real, runtime privado y preview quedan pendientes de acceso efectivo; no copiar secretos por chat ni publicar snapshots privados en este repo público.
4. No existe dataset histórico pregame con scoring de esta liga ni baseline ESPN archivado disponible en el checkout. Se entrega entrenamiento reproducible y puerta de aceptación cerrada. MAE/RMSE reales, ventaja ESPN y calibración quedan null con razón hasta corrida real. Fixtures prueban ingeniería; jamás acreditan precisión deportiva.
5. Feature store acepta métricas disponibles con fuente/as_of/version y faltantes null+reason. Separación, shadow coverage, trincheras, YCO, clima, odds y rumores no se rellenan con números plausibles. Importadores externos se habilitan solo tras verificar contratos y derechos para cada dataset.
6. X se limita a API oficial o señales manuales curadas, sin scraping. La API oficial publica USD0.005/post leído el día de revisión; 1,000 posts≈USD5 antes de otras consultas. No se compra acceso automáticamente. Señales no confirmadas solo amplían incertidumbre. Efectos confirmados requieren parámetros calibrados del modelo para cambiar media.
7. nflverse distingue licencia de código de derechos de datasets. No se descarga masivamente hasta validar dataset/licencia/atribución y timestamps pregame. Impacto: pipeline preparado, datos no simulados.
8. Vercel plan real no comprobado. Cron diario conserva compatibilidad Hobby; Hobby no garantiza minuto preciso. Entrenamiento pesado offline en GitHub Actions; ningún ajuste presupone Pro. 08:30 Monterrey corresponde14:30UTC; cron Vercel Hobby puede llegar durante esa hora, distinto al heartbeat del chat ya configurado.
9. Modelos agrupados por scoring_hash/posición, IDs canónicos y temporada. No sumar puntos PPR genéricos a scoring custom. Bonos y TE premium deben constar explícitos, SUPERFLEX es regla de slots. Datos faltantes bloquean el consumo nuevo afectado.
10. USE_PREDICTIVE_CORE habilita consumidores por defecto únicamente si artifact verificado supera baseline en validación temporal real y cuenta con scoring/provenance/frescura. Una flag no basta para aprobarlo. Activación manual no evita el VerifierAgent.

Referencias vigentes: [cron Vercel](https://vercel.com/docs/cron-jobs/usage-and-pricing), [funciones](https://vercel.com/docs/functions/limitations), [X costos](https://docs.x.com/x-api/getting-started/pricing), [X policy](https://developer.x.com/en/developer-terms/agreement-and-policy), [nflverse terms](https://nflverse.nflverse.com/).
