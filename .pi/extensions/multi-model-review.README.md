# Parallel Code Review

Extensión para revisión de código con **múltiples modelos de IA en paralelo**. Todos los modelos configurados analizan el mismo diff de forma independiente y los hallazgos se consolidan por consenso.

## Comandos

| Comando | Descripción |
|---------|-------------|
| `/parallel-review` | Review completo con todos los modelos configurados |
| `/parallel-review-lite` | Review rápido con máximo 3 modelos |
| `/parallel-review-stop` | Cancela un review en curso |
| `/parallel-review-lite-stop` | Cancela un lite review en curso |

---

## Uso

```
/parallel-review                          → picker interactivo de repo y PR
/parallel-review my-repo                  → salta directo al picker de PR en ese repo
/parallel-review 42                       → pide repo primero, luego usa PR #42
/parallel-review https://github.com/…/42  → salta picker, usa esa URL directamente
/parallel-review PROJ-123                 → busca el PR por Jira ticket ID
```

El picker pregunta qué revisar:
- **Rama actual** vs base (`master`/`main`) — útil para revisar tu trabajo antes de abrir un PR
- **Un PR específico** — por número, URL, Jira ticket ID, o nombre de rama

---

## Cómo funciona

### 1. Selección dinámica de modelos

Los modelos se seleccionan automáticamente según qué API keys tenés configuradas. No hay modelos hardcodeados.

- Hasta 3 modelos de Anthropic (Claude) en orden de preferencia
- 1 modelo por cada otro provider configurado (OpenAI, Google, xAI, etc.)
- `/parallel-review-lite` usa máximo 3 modelos en total

### 2. Review en paralelo (single-shot)

Todos los agentes arrancan casi simultáneamente (300ms de stagger entre cada spawn para evitar colisiones). Cada agente:

1. Recibe el diff completo embebido directamente en el prompt (no navega el repo)
2. Responde con JSON estructurado inmediatamente
3. Timeout de 2 minutos por agente — ningún modelo lento bloquea el resultado

**Sin tool use** — el diff es autosuficiente para la mayoría de los issues. Esto reduce el tiempo de ~300s (loop agentico) a ~15-45s (llamada única a la API).

### 3. Consolidación por consenso

Los hallazgos de todos los agentes se agrupan por similitud (overlap de palabras significativas en `file + title + description`). Los grupos reciben un `consensusScore`:

```
consensusScore = cantidad_de_agentes × peso_severidad
  donde: critical=3, warning=2, suggestion=1
```

Un hallazgo reportado por 3 agentes como `warning` (score=6) aparece antes que uno reportado por 1 agente como `critical` (score=3).

### 4. Reporte final

El reporte agrupa hallazgos por severidad y muestra cuántos agentes lo detectaron:

```markdown
### 🔴 Critical — 2

**[3/4 agents]** `app/controllers/orders_controller.rb:45` — **Missing authorization**
  No authorization check before accessing sensitive data.
  > 💡 Add authorization check before the action body.

### Scores

| Agent              | Score | Findings |
|--------------------|-------|----------|
| claude-opus-4-6    | 7/10  | 8        |
| gemini-2.5-pro     | 8/10  | 5        |
| gpt-5              | 6/10  | 11       |
```

---

## Output en tiempo real

A medida que cada agente termina, se muestra una notificación:

```
🔍 claude-opus-4-6 — reviewing...
🔍 gemini-2.5-pro — reviewing...
🔍 gpt-5 — reviewing...
✅ gemini-2.5-pro — 18s · score 8/10 · 5 issue(s)
✅ gpt-5 — 24s · score 6/10 · 11 issue(s)
✅ claude-opus-4-6 — 31s · score 7/10 · 8 issue(s)
✅ Review complete! 9 findings consolidated from 3 agents.
```

El footer muestra el progreso: `Parallel review: 2/3 done`

---

## Requisitos

API keys configuradas para los providers que quieras usar. La extensión detecta automáticamente qué modelos están disponibles:

```bash
# En ~/.pi/agent/auth.json o variables de entorno
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...
# etc.
```

Si un modelo no está disponible, la extensión lo omite y continúa con los demás.

---

## Rendimiento

| Métrica | Valor típico |
|---------|-------------|
| Tiempo por agente | 15–45s |
| Tiempo total (paralelo) | ~30–60s |
| Diffs grandes (>40k chars) | Truncados automáticamente |
| Timeout por agente | 120s |

---

## Personalización

Editando `.pi/extensions/multi-model-review.ts`:

- **`CLAUDE_PREFERRED`** — orden de preferencia de modelos Anthropic
- **`EXTRA_PROVIDER_PREFERRED`** — modelo preferido por cada provider extra
- **`LITE_MAX_MODELS`** — máximo de modelos para la versión lite (default: 3)
- **`AGENT_TIMEOUT_MS`** — timeout por agente en ms (default: 120000)
- **`MAX_DIFF_CHARS`** — límite de caracteres del diff antes de truncar (default: 40000)
- **`REVIEWER_SYSTEM_PROMPT`** — prompt del sistema para los revisores
- **`SPAWN_STAGGER_MS`** — delay entre spawns para evitar colisiones (default: 300ms)

---

## Repos soportados

El picker detecta automáticamente qué repos están disponibles:

- Lee `project.yml` para obtener la lista de repos
- Si no hay repos en `project.yml`, escanea el `reposPath` configurado en `.pi/local.json`
- Verifica que cada repo tenga un directorio `.git` válido
