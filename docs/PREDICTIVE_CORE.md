# Predictive Core

Estado: implementación verificable con puerta de aceptación cerrada. No existe aún backtest deportivo real de esta liga. La auditoría previa está en AUDIT_PRE_CORE.md y las excepciones en DECISIONS.md.

## Servicio y reglas

`lib/core/service.ts` ofrece getProjection(playerId, week, scenario). Respuesta incluye mean/sd/P10/P50/P90/prob_play/confidence/drivers, scoring_hash, versión, razón, fuentes y tiempos. Una ausencia de dato se devuelve null; el baseline aislado puede mostrar su punto original pero no inventa percentiles. Las DST pueden ser negativas. Confidence describe cobertura de evidencia, no tasa de acierto garantizada.

`schema.ts` valida inputs y artefactos. Cada variable lleva source, as_of, fetched_at, version, estimated/method; null necesita reason. Evidencia y observaciones pregame no pueden haber llegado después del kickoff. Los modelos exigen scoring exacto, versión de features, residuos y ventanas temporales válidas. Scoring permite reglas lineales, bonos y posición (TE premium); SUPERFLEX depende de slots, no de sumar puntos. Un label PPR o reception=1 no equivale a las reglas completas. El adapter de snapshots antiguos no acepta reglas incompletas o desconocidas.

getProjection usa Ridge exportado en unidades originales + ensamble ESPN cuyo peso se aprende antes de la calibración de intervalos. Mean incorpora bias aprendido en la ventana anterior, las bandas usan residuos empíricos de calibración y sd su dispersión. El soporte residual se centra para que su esperanza coincida con la media publicada. Mezclas con/sin usan CDF ponderada y varianza total; las probabilidades suman1. No se aplica prob_play dos veces a una media ya incondicional. No se inventa un baseline ESPN para un escenario que ESPN no proyectó.

WOWY usa la precisión armónica de las muestras con/sin y un prior explícito. Roles redistribuyen targets/rutas/carries/tercer down/goal line de forma separada y por shares observados. Se muestran vacantes no asignadas. Cambios de QB quedan sin efecto fijo universal hasta contar con parámetros calibrados. DvP normaliza por calidad y volumen de rivales, shrinkage, fase/alineación y tendencia; no convierte ratios en puntos mediante una heurística sin validar. El feature defense_adjusted_ratio puede entrar a un modelo entrenado con la misma versión/cálculo y evidencia. Clima requiere techo/estadio confirmado; un estadio cubierto desactiva ese predictor.

Anomalías trabajan exclusivamente sobre disponibilidad y evidencia fresca de la liga: snaps, rutas sin targets, oportunidad de TD no convertida, suplente eficiente, vacancia, cambio de rol. Scores0–100 son umbrales configurables de detección, no probabilidades de breakout. Waivers los usan como evidencia y desempate; no suman puntos ficticios por una alerta.

Señales exigen política curada versionada y permiso. Fuentes oficiales o dos independientes fiables pueden confirmar una señal. Fiabilidad desconocida queda null, no se inventa historial de aciertos. Rumores preservan la media y solo amplían incertidumbre/activan revisión; ese ajuste no calibrado bloquea consumo. No hay scraping de X. La whitelist inicial tiene permiso=false hasta revisar una fuente específica.

ROS y playoffs son promedios semanales de forecasts futuros verificados, nunca extrapolación de esta semana. WAR operativo es la diferencia frente al mejor FA confirmado de la misma posición bajo slots reales. Un pool o calendario incompleto produce null. ROS sd permanece null sin correlaciones históricas. El trade heredado bloquea operaciones nuevas del core si faltan ROS/playoffs/WAR.

## Persistencia y ejecución

Migración `003_predictive_core.sql`: core_inputs/core_runs, features, player_roles, teammate_splits, availability_scenarios, player_projections, defense_adjusted, waiver_anomalies, social_signals/source_policies, model_registry/backtest_results, data_quality_log/core_training_examples. Claves incluyen scope/temporada/semana/ID/fuente/as_of/version; UTC. Natural upserts e índices de lecturas por scope. Una transacción publica datos y resultado verificado; JSON recordsets evitan una petición SQL por jugador. Los baselines raw de los módulos previos se guardan por separado, sin etiquetar ajustes como ESPN.

POST /api/core/run acepta body `{input: CoreInput}` para ingesta privada o sin body para recalcular lo ya importado. Bearer EXTERNAL_SYNC_SECRET permite productores autorizados; la UI requiere autenticación de la app y mismo origen. Devuelve run_id determinista según datos/estado de calidad/modelo/horizonte. Mismos inputs reutilizan la corrida. Fuentes consultadas=[] cuando se trabaja sobre caché: recalcular no se presenta como consultar ESPN.

GET /api/core/projection?player=&week=&scenario=; GET /api/core/anomalies; GET /api/core/availability?team=; GET /api/core/backtest; GET /api/core/status. Todos privados y no-store. GET /api/cron/core exige CRON_SECRET. Límites de body/tipos/IDs se validan antes de SQL. API devuelve estado parcial o bloqueado si faltan datos, esquema o scoring; no rellena cifras.

La pestaña Predicciones incluye ficha/distribución, escenarios, vacancias, alertas, matchup, noticias, métricas/ablation y calidad. Fecha America/Monterrey; datos UTC. Los datos históricos bloqueados no se muestran como roster vigente. El botón distingue corrida completada, datos faltantes y fuente no consultada.

## Entrenamiento y aceptación

Python/scripts y comandos completos en [scripts/core/README.md](../scripts/core/README.md). Train → ajuste de ensamble → intervalos/bias → test, ventanas independientes cronológicas, scaler/imputer solo train, labels disponibles antes del partido objetivo. Semilla42 y cutoffs/hash/version registrados. Ablation reentrena y recalibra en las mismas ventanas. ESPN se compara sobre las mismas filas pregame, no sobre estimaciones propias guardadas bajo su nombre.

No se añadió boosting sin demostrar mejora. El primer Ridge es interpretable; no se afirma una jerarquía completa de modelos por volumen/eficiencia sin datasets suficientes. Prob_play entrenada y modelos especiales de QB, coberturas y trincheras siguen null hasta contar con historial fiable. Los fixtures nunca abren el gate.

USE_PREDICTIVE_CORE=false fuerza legado. Undefined/true considera artefactos únicamente después del gate temporal real, la verificación de cada jugador y reglas/scoring/fechas compatibles. No se activa precisión nueva por tener tests de código verdes. Ausencias, mezcla incompleta, divergencia fuerte o más del porcentaje configurado de features faltantes bloquean solo las filas afectadas. El legado conserva las excepciones de fase0; los slots universales y simulaciones trade completas quedan pendientes, no certificados como completos.

## Cadencia y costos

vercel.json mantiene un cron diario por ruta: sync14:30UTC y core14:35UTC (08:30/08:35 Monterrey). El plan real debe comprobarse en la cuenta; Hobby permite frecuencia diaria y no garantiza minuto exacto. Por ese motivo no se garantiza orden entre dos jobs: core también comprueba la versión de los inputs y sigue bloqueado hasta que llega la ingesta. La revisión del chat a08:30 ya existente es distinta a estos jobs y requiere el equipo/app disponibles. Jobs de Vercel no ejecutan el plugin Flaim del chat.

GitHub Actions semanal martes20:00UTC entrena offline. Necesita ejemplos privados auditados, repository variable CORE_TRAINING_ENABLED=true y secrets NEON_TRAINING_DATABASE_URL/CORE_TRAINING_CONFIG_JSON. No publica datasets/artefactos privados. No se habilitó entrenamiento facturable con datos vacíos. Inferencia ligera solamente en Vercel. [Límites de cron](https://vercel.com/docs/cron-jobs/usage-and-pricing), [funciones](https://vercel.com/docs/functions/limitations).

## APIs/plugins auditados y faltantes

| Fuente | Evidencia real/capacidad | Gap y uso |
|---|---|---|
| Flaim/ESPN | MCP conectado en chat: contexto de liga, scoring/roster, FA, matchups, transacciones; PR4 OAuth/sync aún draft | No asumir que Vercel ejecuta MCP. Completar/validar PR4 o publicar snapshots privados con productor autorizado. Alias baseline admitido espn/flaim:espn, no Flaim genérico sin plataforma verificada |
| SportsDataIO | Adapter de proyecciones/uso/lesiones en repo; [documentación NFL](https://sportsdata.io/developers/api-documentation/nfl) | No key configurada en preview. Sus puntos PPR no se mezclan con custom scoring. Falta mapping explícito de IDs y licencia de métricas avanzadas |
| Tavily | Plugin encontrado disponible, no conectado | Búsqueda/noticias con fuentes; no reemplaza roles/targets/proyecciones ni concede derechos de extracción |
| TinyFish | Plugin encontrado disponible, no conectado | Flujos web específicos permitidos; no crawling indiscriminado de X ni métricas supuestas |
| StatsHawk | [Contrato oficial contests](https://www.statshawk.ai/docs/api/competitions/get_v1_competitions_comp_editions_year_contests), corregido decoder data.items/meta.fetched_at/v1 con tests | Key ausente; runtime no verificado. No usar número de contests como evidencia predictiva |
| PostHog | Adapter capture, key ausente | Telemetría de app; no proveedor de estadísticas NFL ni prueba de precisión |
| Neon | Proyecto fantasy-command-center-db confirmado; 001/002 aplicadas | Rama preview-predictive-core usada para probar003; staging histórico/actuals/accuracy/archivos ESPN vacíos |
| Vercel | Plugin403en team, CLI oficial sí accede q y lo vincula al repo | Secretos prod no se pueden descargar; se generaron secretos SOLO para esta rama preview para verificación. No se modificó el password prod |
| X | [API oficial y costo](https://docs.x.com/x-api/getting-started/pricing), [policy](https://developer.x.com/en/developer-terms/agreement-and-policy) | No token/acceso de lectura. USD0.005/post leído en revisión14oct; 1,000≈USD5, sin otras consultas. No comprar/scrapear automáticamente |
| nflverse | [terms](https://nflverse.nflverse.com/), [diccionarios](https://nflreadr.nflverse.com/reference/load_player_stats.html) | Licencia de código no equivale a todos los datos. Verificar licencia específica/atribución, scoring y fecha de disponibilidad antes de importar |

Para avances materiales se necesita un feed/histórico autorizado con snaps/routes/targets/carries y timestamps pregame, además del scoring completo de la liga. No se necesita PostHog para pronosticar. Tavily es opcional para noticias; la prioridad de datos es ESPN/Flaim real y proveedor autorizado, no comprar todos los plugins.
