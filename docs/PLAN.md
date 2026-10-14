# Predictive Core — plan

1. Auditoría obligatoria: main, motores, migraciones, endpoints, UI, tests, ramas/PR y HTTP producción; documentar excepciones antes de construir.
2. Cerrar defectos heredados comprobados: locks/OUT/diferencias legales, duplicados y ownership por ID, rangos y baseline raw; repetir checks.
3. Contratos Zod, scoring real, feature store/versiones, WOWY/escenarios y DvP ajustado; fallar con null+reason donde falten datos.
4. Proyección única, señales curadas y anomalías disponibles, Verifier bloqueante; persistencia Neon e idempotencia por scope/datos/modelo.
5. Ridge offline, walk-forward con disponibilidad temporal estricta, ensamble aprendido en calibración anterior al test, intervalos y ablation; GitHub Actions semanal. No fabricar métricas ni aprobar fixtures.
6. Integrar los tres consumidores con flag y gate; API/UI de distribuciones, escenarios, oportunidades, fuentes y precisión.
7. Vitest/typecheck/eslint/build/Python; PR feat/predictive-core, preview real verificado; solo entonces producción. Entregar faltantes de acceso/datos con pasos concretos.
