# Entrenamiento privado del Predictive Core

Este pipeline no descarga datos ni acredita precisión con fixtures. En este checkout no se entregó un historial real de features pregame, resultados y baseline ESPN con el scoring de la liga. Sin ese historial devuelve `metrics.status=unavailable`, ningún modelo y `gate.accepted=false`. Los tests contienen ejemplos ficticios marcados `test_only`; sus errores son comprobaciones de ingeniería.

## Contrato de datos

El CSV privado debe estar en `work/core/` (ignorado por Git). Una fila por `player_id + season + week + scoring_hash`. También se pueden guardar las mismas filas como objetos JSON en `core_training_examples.payload`, con un `id` estable, dentro de Neon.

| Campo | Requisito |
|---|---|
| `player_id`, `team_id`, `position` | IDs canónicos, posición QB/RB/WR/TE/DST/K. Ningún join por nombre. |
| `season`, `week`, `game_at` | Temporada y semana NFL regular (1–18); kickoff con timezone. |
| `feature_as_of` | Momento de la predicción archivada; estrictamente anterior al kickoff. |
| `features_json` | Objeto por nombre: `{value, source, as_of, fetched_at, version, estimated, method?, reason?}`. `version=core-features-v1`. Cada fetched_at debe ser anterior o igual a feature_as_of; as_of ≤ fetched_at. Null requiere reason; estimated requiere method. |
| `stats_json` | Estadísticas finales crudas, con todos los stats que utiliza el scoring. Cero debe existir explícitamente; una ausencia no equivale a cero. |
| `source`, `fetched_at`, `label_available_at` | Fuente y publicación/disponibilidad de los resultados. Label disponible después del kickoff y no después del fetched_at. |
| `scoring_hash` | Hash de las reglas exactas de esta liga, igual al hash del Core TS. |
| `baseline_points`, `baseline_source`, `baseline_fetched_at` | Proyección ESPN archivada con el mismo scoring; fuente `espn` o `flaim:espn`; fetched_at antes del kickoff y no posterior a feature_as_of. Si falta, puntos null/CSV vacío; no rellenar con promedio de otras fuentes. |
| `test_only` | Booleano explícito. Cualquier fila true impide aceptar el artefacto. |

Los puntos reales se calculan a partir de `stats_json` usando las reglas exactas (incluidos bonos y TE premium). Las reglas no se infieren del nombre de la liga. SUPERFLEX y cantidad de titulares pertenecen al contrato de alineación; no cambian la fórmula de puntos. Los puntos negativos de DST se conservan.

El config privado `work/core/training-config.json` requiere:

- `scoring`: el objeto real del Core/Flaim/ESPN `{rules:[{stat,points,position?,threshold?,mode:'linear'|'bonus'}],source,as_of,fetched_at}`. Copiar reglas confirmadas; no hay scoring PPR predeterminado. Stats canónicos ASCII; hash ordenado lexicográficamente por stat/position/mode/threshold y números compatibles con JSON.stringify.
- `features`: lista explícita `{name,block}`, con nombres presentes en el historial y bloques `volume`, `efficiency`, `matchup`, `context`, `availability`. No registrar bloques sin datos.
- `feature_version: 'core-features-v1'`, `seed` uint32 (default 20261014), `ridge_alpha` positivo (default 1).
- `real_data`: booleano explícito. Para aceptar, además `data_documentation: {contains_real_historical:true,sources:[{id,url,terms_url,allowed_training:true,verified_at}]}` debe documentar todas las fuentes de resultados/features/ESPN con URLs HTTPS, derechos de entrenamiento comprobados y fecha de revisión. Es una declaración del productor; el script no determina por sí solo derechos contractuales. No sirve para aceptar filas `test_only`.
- `gate` opcional: mínimos y tolerancias documentados abajo. Los valores predeterminados son hipótesis de control, no una garantía de precisión deportiva.

No se permite una feature creada después del kickoff aunque su productor la etiquete retroactivamente como pregame. No se transforma `actuals` incompleto en ejemplos inventados: además de los puntos hacen falta stats, features archivadas y baseline ESPN previo al partido.

Si se seleccionan `wind_mph`, `rain_mm`, `snow_mm` o `temperature_f`, se exige evidencia pregame fresca de `dome` aunque no sea un coeficiente del modelo. `dome=1` desactiva sus inputs numéricos a 0, como codificación del efecto desactivado; el valor medido/null y su fuente permanecen intactos en el digest. `dome=0` conserva el clima observado. Techo desconocido, ausente, futuro o viejo rechaza la fila; no se imputa el techo. `weather_max_age_hours` default 24 debe concordar con la frescura configurada en inferencia TS.

## Validación temporal y distribución

Se agrupa por scoring hash/posición y se ordenan las filas por kickoff/ID. Cada fold semanal tiene cuatro ventanas cronológicas:

1. **Train:** stats publicados y fetched antes del primer partido de la calibración. Imputación con la media observada y StandardScaler se ajustan exclusivamente con estas filas. Ridge usa alpha fijo/configurado; ningún tuning se hace en el test.
2. **Ensemble:** primera mitad de las semanas de calibración. Aprende un peso entre 0 y 1 para Ridge vs ESPN minimizando error cuadrático. Labels y fetched deben existir antes del primer partido de la ventana siguiente.
3. **Intervalos y bias:** segunda mitad de calibración. Calcula residuos del ensamble ya fijo y su media (corrección de bias). Estas filas jamás entrenan Ridge ni los pesos del ensamble.
4. **Test:** siguiente semana, sin que sus labels influyan en parámetros, bandas, bias ni ablation. Las métricas usan la media corregida, exactamente como TS.

Por defecto se requieren al menos 50 ejemplos de train, 20 para el peso, 20 para los intervalos, 30 test y 3 folds semanales. Se reservan 4 semanas de calibración por defecto. Los mínimos configurables nunca pueden bajar de 50 train, 20 por subventana de calibración, 20 test y 3 folds. Etiquetas publicadas tarde quedan excluidas hasta que fueran realmente disponibles. Resultados posteriores al `--as-of` no entran en ninguna ventana.

Se exportan coeficientes/intercept en unidades originales, `means` para imputación reproducible, peso aprendido, residuos de calibración **crudos**, bias medio y sd muestral. TS usa `mean = rawBlend + bias`, y centra cada residuo como `residual-bias` al construir soporte: la esperanza de ese soporte coincide con la media publicada. Nunca reutilizar residuos del ensamble para una predicción Ridge sin su baseline ESPN. Si el peso ESPN es positivo y falta ese baseline, la proyección queda indisponible.

P10/P90 utilizan los rangos de orden finitos de split-conformal con colas de 10%; P50 la mediana empírica. Para n residuos ordenados: índices inferior `max(0,floor((n+1)*.1)-1)` y superior `min(n-1,ceil((n+1)*.9)-1)`. Equivalen a rawBlend + residuo, o media corregida + residuo centrado. La sd viene de residuos de calibración, no de errores de entrenamiento. `conformal_radius` almacena también el rango de |residuo| para cobertura 80% (auditoría). La validez conformal teórica presupone intercambio de errores; en una temporada cambiante se verifica cobertura empírica y no se promete cobertura futura garantizada.

El primer modelo es Ridge interpretable sobre features observadas; no se presenta como una jerarquía completa de modelos de volumen/eficiencia. No se añadió gradient boosting sin evidencia de mejora. `prob_play` es null con razón porque el historial necesario para un clasificador de disponibilidad no se entregó. OUT/IR/bye y probabilidad confirmada deben verificarse en el servicio de disponibilidad.

## Gate y métricas

Se reportan MAE/RMSE/bias por posición y semana, comparación de modelo y ESPN sobre **las mismas filas**, cobertura P10–P90, anchura, fracción real bajo P10/P50/P90 y ablation por bloque. Cada ablation reentrena y recalibra dentro de las mismas ventanas, sin su bloque. `delta_mae = MAE_sin_bloque − MAE_modelo` positivo señala mejora aportada por el bloque; negativo indica que el bloque no ayudó. No implica causalidad.

Aceptar requiere datos históricos/licencia/provenance reales; mínimos anteriores; baseline ESPN archivado en ≥90% de test (configurable con piso 80%); MAE **y** RMSE corregidos iguales o mejores que ESPN en el subconjunto comparable; cobertura empírica entre 70% y 95%; desviación de calibración de cada cuantil ≤15 puntos porcentuales. Estos umbrales son configurables dentro de límites conservadores y quedan grabados en el artefacto. Si una posición representada carece de validación suficiente, el artefacto global no se acepta. Ninguna flag evita este gate. Posiciones ausentes del dataset no reciben modelos extrapolados.

La versión incluye hash de datos, config y código/dependencias del trainer. La semilla, cutoffs, tamaños y pesos por fold quedan registrados. Una corrida con los mismos datos/config conserva el checkpoint; `--as-of` crea una identidad reproducible para replay. Los upserts de registry/backtest no reemplazan versiones históricas.

## Primera corrida y reentrenamiento

Python 3.12. Instalar deps del archivo fijado, preparar **historial real y config privado**, ejecutar migración 003 y proporcionar DATABASE_URL por entorno seguro. La siguiente alternativa usa el runtime disponible en este equipo sin modificar paquetes del sistema:

```powershell
$taskPython = 'C:\Users\calid\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
& $taskPython -m pip install --target work/core/python-packages -r scripts/core/requirements.txt
$env:PYTHONPATH = (Join-Path (Get-Location) 'work/core/python-packages')
& $taskPython -m unittest discover -s scripts/core -p 'test_*.py' -v
& $taskPython scripts/core/train.py --input work/core/history.csv --config work/core/training-config.json --output work/core/artifact.json --write-neon
```

Para reentrenar con filas privadas materializadas en Neon y config desde la variable `CORE_TRAINING_CONFIG_JSON`:

```powershell
& $taskPython scripts/core/train.py --from-neon --config-env --output work/core/artifact.json --write-neon
```

Para un replay reproducible añadir `--as-of <ISO-UTC-del-corte>`. Nunca pegar credenciales en el código ni subir CSV/config/artefactos a este repo público. El script emite solo versión, estado del gate y posiciones, sin IDs de jugadores ni secretos. Una falla de validación no imprime registros ni connection strings.

## GitHub Actions semanal

`core-train.yml`: martes 20:00 UTC (14:00 Monterrey), verificación de trainer seguida de entrenamiento offline; timeout 15 minutos; concurrencia serial. Acciones oficiales fijadas por SHA. No se ejecuta con secretos de PRs ni publica artefactos/datasets en GitHub.

Configurar **repository variable** `CORE_TRAINING_ENABLED=true` solo tras disponer de ejemplos auditados, y **repository secrets** `NEON_TRAINING_DATABASE_URL` y `CORE_TRAINING_CONFIG_JSON`. Dar al rol de esa conexión solo SELECT en staging y permisos necesarios en `model_registry`/`backtest_results`; probar primero en rama Neon. Sin config, entrenamiento queda omitido explícitamente. Con staging vacío escribe una versión rechazada y precisión indisponible; nunca rellena datos. No se activaron secrets ni permisos desde este script.

La cadencia evita entrenamiento pesado en Vercel. Consultar el costo real de GitHub Actions/Neon en el plan configurado; este workflow no presupone cuotas o facturación gratuita.

Referencias: [Ridge 1.7](https://scikit-learn.org/1.7/modules/generated/sklearn.linear_model.Ridge.html), [validación temporal](https://scikit-learn.org/1.7/modules/generated/sklearn.model_selection.TimeSeriesSplit.html), [checkout oficial](https://github.com/actions/checkout), [setup-python oficial](https://github.com/actions/setup-python).
