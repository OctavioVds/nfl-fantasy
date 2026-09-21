# Auditoría técnica y reglas ESPN — 18 de septiembre de 2026

Los dos adjuntos se revisaron como referencias. No se implementó ni publicó una aplicación, no se accedió a cuentas y no se realizaron movimientos de fantasy.

## Hallazgos prioritarios del HTML

1. **No actualiza datos ni calcula proyecciones.** `SNAPSHOT` (líneas 238–314) es un objeto estático del 15 de septiembre. `runGlobalSync` (523–569) pide texto a `claude.use('sample')`, imprime la hora actual y deja el indicador verde, sin consultar fuentes nuevas. Fuera del visor de Claude el análisis ni siquiera dispone de esa función. Mostrar la hora de generación no acredita frescura del dato.
2. **Existe un error que puede atribuir un comentario al jugador equivocado.** `playerRow` (340–354) forma el identificador con posición e índice visible; `renderPositionTable` (360–381) vuelve a numerar al filtrar; `aiCache` (457–459, 485) usa ese identificador. Tras consultar a Gibbs, buscar a Bijan convierte a Bijan en `RB-0` y puede recuperar el comentario de Gibbs. Lo mismo ocurre con `wv-0`. La clave debe incluir ID estable, semana, scoring y versión del snapshot/modelo.
3. **No hay trazabilidad de las cifras.** No almacena URLs por afirmación, hora de la fuente, definición de estadísticas, fuente del porcentaje de roster, modelo, validación histórica ni intervalo de predicción. No puede verificarse la etiqueta del pie «resultados reales verificados» con el archivo solo. «Prioridad industria /7» es un valor manual sin metodología visible.
4. **No conoce liga, plantilla ni disponibles reales.** La interfaz promete recomendar «según tu roster», pero el prompt de waiver solo recibe su propia lista genérica. PPR, 10 equipos, 1 QB, prioridad 10, reglas de adquisición y lock por partido deben afectar la decisión; un QB de reserva no tiene el mismo valor que un RB utilizable. Porcentaje nacional de roster no prueba disponibilidad en la liga.
5. **Rankings no explicados y a veces inconsistentes con sus cifras.** Ejemplos: Cook 18.0 precede a Taylor 18.5; JSN 18.5 a Amon-Ra 19.0; Caleb Douglas prioridad 3.0 precede a Kaelon Black 4.0. Es posible ordenar por valor distinto de puntos, pero debe explicarse y calcularse. Buscar también altera el número de ranking.
6. **Afirmaciones absolutas y fechas rígidas.** Hay «puntos altos garantizado», «volumen alto garantizado» y «pase lo que pase». Año 2026, «S1», semana y fecha están incrustados. No controla si el juego ya comenzó, terminó, se aplazó o el jugador está fuera.
7. **Texto externo se inserta como HTML.** Respuestas de IA y futura información remota entrarían en `innerHTML` sin sanitizar (483–486, 513–515, 554–560). Usar texto seguro o sanitización rigurosa, validación del esquema y separación de datos/instrucciones.

## Correcciones del brief comprobadas con documentación primaria

| Tema | Corrección y efecto | Fuente |
|---|---|---|
| Vercel | El dato «Hobby 10 segundos» no describe Fluid Compute actual: Hobby tiene 300 segundos por defecto y máximo. El antiguo modo tiene 10 s por defecto y máximo 60 s. Esto no convierte un cron lento en datos en vivo. | https://vercel.com/docs/functions/limitations |
| GitHub Actions | Los cron pueden retrasarse e incluso perder ejecuciones bajo carga; el minuto cero es especialmente problemático. No garantizar duración de 30–90 s ni frescura de 3 h. | https://docs.github.com/en/actions/how-tos/troubleshoot-workflows |
| Reddit | La política vigente exige solicitar y recibir aprobación explícita antes de acceder a sus datos por API. No basta crear client ID/secret y asumir acceso gratuito. | https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy |
| YouTube cuotas | Documentación actualizada el 15/09/2026: 100 llamadas diarias a `search.list` en un bucket propio, 1 unidad por llamada, y 10 000 unidades/día para el conjunto de otros endpoints. Cada página adicional consume otra llamada. La fórmula antigua del brief es obsoleta aunque el orden de magnitud de búsquedas coincida. | https://developers.google.com/youtube/v3/determine_quota_cost ; https://developers.google.com/youtube/v3/docs/search/list |
| YouTube subtítulos | La descarga oficial de captions necesita autorización y permiso para editar el video. `youtube-transcript` no debe presentarse como acceso oficial garantizado al contenido de cualquier video. Metadatos y títulos no equivalen a haber leído la transcripción. | https://developers.google.com/youtube/v3/docs/captions/download |
| Sleeper | API de solo lectura, sin token, gratuita para uso no comercial; comercial requiere hablar de licencia. Catálogo completo máximo una vez al día y caché propia; guía general inferior a 1 000 llamadas/min. Tendencias cuentan altas/bajas: no son proyecciones ni disponibilidad de nuestra liga. | https://docs.sleeper.com/ |
| nflverse | Estadísticas/pbp se actualizan de noche tras juegos, con cortes adicionales; snaps a 0/6/12/18 UTC según PFR; calendario cada 5 min. Participación desde 2023 se publica tras terminar postemporada, no durante la temporada. No todos los datasets son en vivo ni tienen igual demora. | https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html |
| FantasyPros API | Ya anuncia claves gratis de prototipo con datos de muestra; producción personal incluida en HOF, y licencia comercial para redistribución/uso comercial. La clave gratuita de muestra no debe alimentar predicciones actuales. | https://www.fantasypros.com/api-data/ |
| FantasyPros MCP | Documentación de septiembre 2026 anuncia rankings, proyecciones, estadísticas y lesiones para cuentas gratuitas; consejos avanzados requieren Premium y sincronización de liga. Es una alternativa oficial a evaluar, sin asumir que está instalada ni autorizada aquí. | https://support.fantasypros.com/hc/en-us/articles/55238312588571-What-tools-are-available-in-the-FantasyPros-MCP-Server |
| ESPN | `cwendt94/espn-api` es un wrapper comunitario que documenta lectura de ligas públicas/privadas, no un contrato de estabilidad o servicio oficial de ESPN. Las cookies son credenciales: servidor/secret store, nunca frontend, JSON público o repositorio. | https://github.com/cwendt94/espn-api ; https://github.com/cwendt94/espn-api/wiki/League-Class |
| Navegador | La frase «ningún sitio desde navegador puede obtener datos actuales» es incorrecta. CORS permite lecturas entre orígenes autorizados; el backend propio puede servir datos válidos. | https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS |

El ejemplo `/api/sync` tampoco autentica al solicitante, limita frecuencia ni comprueba la respuesta de GitHub: puede decir «disparado» ante un fallo y permitir consumo abusivo de ejecuciones. Faltan estado de trabajo, idempotencia, exclusión de ejecuciones simultáneas, control de permisos, reintentos, validación de snapshot y último dato correcto. Publicar JSON de una liga privada en repo público también expondría información innecesariamente.

## Reglas ESPN que afectan los consejos de waiver

**Alternativas con la misma baja.** ESPN permite ordenar solicitudes en Pending Moves y documenta como causa de fallo que el jugador designado para soltar ya no pertenezca a la plantilla. De ambas reglas se infiere la estrategia A→soltar X; B→soltar X; C→soltar X, ordenadas: si entra A, B/C dejan de ser válidas porque X ya salió; si A se pierde y X sigue, B conserva su posibilidad. Presentar esto como inferencia operativa, no como una función denominada «condicional» confirmada literalmente. Para conseguir dos incorporaciones, reservar dos espacios/bajas y revisar dependencias.

Fuentes: https://support.espn.com/hc/en-us/articles/360000093791-Claim-a-Player-Off-Waivers y https://support.espn.com/hc/en-us/articles/360029528571-Reasons-Why-a-Waiver-Pickup-May-Not-Process

**Prioridad 10.** No significa una probabilidad de adquisición del 10 %. Depende de quién reclame y del orden de reclamaciones. ESPN establece que una reclamación ganada manda al final; el reset inverso de posiciones depende del ajuste de la liga. Ser agente libre y añadirlo directamente no consume prioridad. El procesamiento diario y la duración de un día no implican por sí mismos reset diario de prioridad; son ajustes distintos. En una liga con reset semanal, el valor de «guardar prioridad» difiere del sistema continuo sin reset.

Fuente: https://support.espn.com/hc/en-us/articles/360000093771-Waiver-Order-Overview-and-Salary-Cap-Tiebreakers

**Hora.** ESPN documenta ventana habitual 3–5 a. m. ET para proceso estándar; usar la fecha y hora de elegibilidad que muestra cada jugador y no prometer una ejecución exacta a las 3:00. Hay incluso explicaciones distintas en ayuda sobre «mismo día» frente a «menos de 24 h» para altas y bajas rápidas; no basar estrategia en explotar esta diferencia.

Fuente: https://support.espn.com/hc/en-us/articles/360012531592-Waiver-Period

**Bloqueos y bajas.** La página de locks distingue alineación y composición del roster, pero mezcla explicaciones generales y fue actualizada en 2021. Con lock individual, titulares y banca ya empezados quedan fijados para la alineación. No prometer que un suplente pueda cortarse después de jugar; verificar el estado de la transacción y que Drop esté habilitado. ESPN confirma que botón gris impide la baja y que la lista Undroppables también la bloquea. Un jugador no queda «disponible» por estar en banca.

Fuentes: https://support.espn.com/hc/en-us/articles/360054748151-Lineup-and-Roster-Lock-Times y https://support.espn.com/hc/en-us/articles/360000093791-Claim-a-Player-Off-Waivers

**IR NFL.** La ayuda específica de football admite ingreso O/IR; SSPD no. Un jugador ya en IR que pasa de O/IR a Q/D puede quedarse y la plantilla continúa válida según esa página. Cuando pierde toda designación de lesión, la plantilla se invalida. Debe existir plaza IR en la liga. No confundir estas reglas con la política NFL de la vida real.

Fuente: https://support.espn.com/hc/en-us/articles/115003849911-Players-on-Injured-Reserve-IR

**Conflicto entre páginas oficiales.** La página de impacto IR dice que un claim presentado antes de que el jugador se vuelva sano se procesa normalmente. La de causas de fallo, actualizada después, afirma de forma general que sano en IR impide procesar. No hay suficiente precisión para garantizar la excepción. Recomendación robusta: regularizar IR antes del proceso y no prometer una incorporación que dependa de ese caso límite. Trades pendientes desbalanceados, límites de posición o haber llenado una plaza abierta también pueden invalidar el claim.

Fuentes: https://support.espn.com/hc/en-us/articles/360035123032-How-does-the-Injured-Reserve-Injury-List-impact-Waivers y https://support.espn.com/hc/en-us/articles/360029528571-Reasons-Why-a-Waiver-Pickup-May-Not-Process

## Diseño recomendado, todavía sin implementar

- **Ingesta:** fuentes oficiales para hechos/lesiones; proveedores autorizados para proyecciones; nflverse para histórico; Sleeper para tendencia como señal contextual. Reddit/YouTube sirven para descubrir argumentos verificables, no como votos independientes de certeza.
- **Identidad:** ID canónico por jugador con cruces ESPN/Sleeper/GSIS/FantasyPros; validar temporada, equipo, semana, kickoff y estatus. Desduplicar artículos que repiten el mismo reporte original.
- **Trazabilidad:** conservar `published_at`, `fetched_at`, `valid_for_week`, URL y proveedor por dato; distinguir hechos, opinión, proyección y observación real. Un análisis nuevo no cambia la fecha del dato viejo.
- **Cálculo:** scoring exacto de la liga, modelo reproducible, consenso validado históricamente y distribución de puntos; no inventar porcentajes de acierto. La IA explica el resultado y cita los hechos suministrados.
- **Actualización propuesta:** catálogo diario; estadísticas según publicación del proveedor; noticias/estado cada 5–15 min cerca de kickoff si licencia y cuotas lo permiten, más lento entre semana; no llamarlo «en vivo» sin latencia verificable. Fallos conservan último snapshot bueno con aviso de antigüedad.
- **Interfaz:** ranking de esta semana, valor resto de temporada, proyección central, rango, confianza de los datos, condicionantes de lesiones y fuente visible. Separar «mayor piso», «mayor techo» y «mejor mejora de plantilla». Mostrar jugado/bloqueado/no elegible y diferencia frente al jugador que saldría.
- **Operación:** usar almacenamiento de datos y snapshots versionados en lugar de requerir un commit por consulta; GitHub Actions puede servir para lotes y evaluación histórica. Sincronizar devuelve ID de trabajo y progreso real. Validar identidad, permisos, cuotas y frescura antes de emitir recomendaciones.
