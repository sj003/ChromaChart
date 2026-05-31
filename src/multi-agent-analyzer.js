// Multi-agent analysis pipeline — ChromaChart specific.
//
// Defines three specialized agents and runs them through AgentPipeline:
//
//   Pass 1 — Data Modeler   infers which fields are relevant + topic match
//   Pass 2 — Viz Expert     picks 4 chart specs + insight questions
//   Pass 3 — Orchestrator   writes headline, summary, per-chart insights
//
// All low-level concerns (session lifecycle, API detection, JSON extraction)
// are handled by AgentPipeline.  This file contains only ChromaChart logic.

import { Analyzer }      from './analyzer.js';
import { AgentPipeline, Agent, extractObj, extractArr } from './agent-pipeline.js';

export class MultiAgentAnalyzer {
  constructor(engine) {
    this.engine    = engine;
    this._fallback = new Analyzer(engine);
  }

  async analyze(topic, { onProgress = () => {} } = {}) {

    // ── Check availability ────────────────────────────────────────────────────
    const { available, reason } = await AgentPipeline.checkAvailability();

    if (!available) {
      onProgress({ agent: null, message: `⚠️ ${reason}`, step: 0, total: 1 });
      onProgress({ agent: null, message: 'Running statistical analysis instead…', step: 0, total: 1 });
      const result = await this._fallback.analyze(topic, {
        onProgress: msg => onProgress({ agent: null, message: msg, step: 0, total: 1 })
      });
      return { ...result, agentLog: [] };
    }

    // ── Wrap onProgress to collect an agentLog ────────────────────────────────
    const agentLog = [];
    const progress = (evt) => {
      agentLog.push({ agent: evt.agent, message: evt.message });
      onProgress(evt);
    };

    // ── Pre-compute shared values used across agent prompts ───────────────────
    const schema      = this.engine.schema;
    const resolved    = this._resolve(topic);
    const matchCount  = resolved
      ? this.engine.query({ x: { field: resolved.field }, y: { aggregate: 'count' },
                            filter: { [resolved.field]: resolved.value } }).rowCount
      : this.engine.rowCount;

    const schemaLines = Object.entries(schema).map(([k, v]) => {
      const samples = v.cardinality <= 30
        ? ` [${v.sample.slice(0, 4).map(s => String(s).slice(0, 25)).join(', ')}]`
        : ` (${v.cardinality} unique values)`;
      return `  ${k}: ${v.type}${samples}`;
    }).join('\n');

    // ── Define agents ─────────────────────────────────────────────────────────

    const dataModeler = new Agent('data-modeler', {
      system: 'You are a data profiler. Respond with valid JSON only.',

      build: () =>
`Fields:
${schemaLines}

Total rows: ${this.engine.rowCount.toLocaleString()}
Topic: "${topic}"

Return JSON:
{
  "topicMatch": "exact value from data or null",
  "topicField": "field name",
  "matchCount": ${matchCount},
  "temporalField": "date/year field or null",
  "geoField": "location/country/region field or null",
  "lowCardFields": ["field with <15 unique values"],
  "midCardFields": ["field with 15-150 unique values"],
  "_summary": "one sentence"
}`,

      parse: (raw) => {
        const json = extractObj(raw);
        if (!json) throw new Error('Data Modeler returned no JSON');
        return { profile: JSON.parse(json) };
      },

      onStart: 'Profiling dataset fields and identifying topic match…',
      onDone:  (ctx) => ctx.profile?._summary
                     ?? `Found "${ctx.profile?.topicMatch}" in field "${ctx.profile?.topicField}"`,
    });

    // ─────────────────────────────────────────────────────────────────────────

    const vizExpert = new Agent('viz-expert', {
      system: 'You are a chart designer. Respond with valid JSON only.',

      build: (ctx) => {
        const profile = ctx.profile ?? {};
        const subjectFilter = profile.topicField && profile.topicMatch
          ? `{"${profile.topicField}":"${profile.topicMatch}"}`
          : '{}';

        const fieldMenu = [
          profile.temporalField && `${profile.temporalField} (date — use for line chart with granularity:month)`,
          profile.geoField      && `${profile.geoField} (geography — use for bar chart)`,
          ...(profile.lowCardFields || []).map(f => `${f} (${schema[f]?.cardinality} values — good for pie)`),
          ...(profile.midCardFields || []).map(f => `${f} (${schema[f]?.cardinality} values — good for bar, limit:10)`),
        ].filter(Boolean).join('\n');

        return (
`Topic: "${topic}" (${(profile.matchCount ?? matchCount).toLocaleString()} matching rows)
Filter to apply to all charts: ${subjectFilter}

Available fields (use ONLY these exact names):
${fieldMenu}

Design 4 charts. Return JSON array:
[{"dimension":"title","reason":"why","insightQuestions":["specific question","another angle"],"spec":{"type":"bar|line|pie","title":"...","x":{"field":"EXACT field name","label":"...","granularity":"month"},"y":{"field":null,"aggregate":"count","label":"Count"},"filter":${subjectFilter},"sort":"desc","limit":10}}]

Rules:
- 1 line chart (temporal), 1 bar chart (geo or mid-card), 1 pie (low-card), 1 bar (another field)
- Only use field names from the list above — never invent others
- Remove "granularity" key unless the field is explicitly marked "(date)"
- insightQuestions: 1-2 short specific questions per chart`
        );
      },

      // Parse Viz Expert output AND execute the data queries.
      // Queries run here (no LLM involved) so the results can be passed
      // directly to the Orchestrator as real numbers to ground its insights.
      parse: (raw) => {
        const json = extractArr(raw);
        if (!json) throw new Error('Viz Expert returned no JSON array');

        const vizPlan = JSON.parse(json)
          .filter(p => this._validateSpec(p.spec))
          .slice(0, 4);

        // Always use _resolve() as ground-truth filter — the AI's topicMatch can
        // hallucinate values that don't exist (e.g. "Movie content" vs "Movie").
        const safeFilter = resolved ? { [resolved.field]: resolved.value } : {};

        const analyses = vizPlan.map(item => {
          const xField = item.spec?.x?.field;
          const spec = {
            ...item.spec,
            filter: safeFilter,
            // Strip granularity from non-date fields (DataEngine ignores it, but
            // removing it avoids confusion and accidental date-parsing on numbers).
            x: {
              ...item.spec.x,
              ...(item.spec.x?.granularity && schema[xField]?.type !== 'date'
                ? { granularity: undefined } : {}),
            },
          };
          return {
            title:            item.dimension,
            question:         item.reason,
            insightQuestions: item.insightQuestions || [],
            spec,
            result:           this.engine.query(spec),
            insight:          '',
          };
        });

        return { vizPlan, analyses };
      },

      onStart: 'Selecting optimal chart types for each dimension…',
      onDone:  (ctx) =>
        `Planned: ${(ctx.vizPlan ?? []).map(v => `${v.dimension} (${v.spec.type})`).join(' · ')}`,
    });

    // ─────────────────────────────────────────────────────────────────────────

    const orchestrator = new Agent('orchestrator', {
      system: 'You are a data analyst. Write clear, specific insights backed by numbers. Respond with valid JSON only.',

      build: (ctx) => {
        const analyses = ctx.analyses ?? [];

        const resultLines = analyses.map((a, i) =>
          `${i + 1}. ${a.title}: ${a.result.rowCount.toLocaleString()} rows — ` +
          a.result.labels.slice(0, 5)
            .map((l, j) => `${l}=${a.result.values[j]?.toLocaleString()}`).join(', ')
        ).join('\n');

        const guidedLines = analyses
          .map((a, i) => a.insightQuestions?.length
            ? `${i + 1}. ${a.title}: ${a.insightQuestions.join(' | ')}`
            : null)
          .filter(Boolean)
          .join('\n');

        return (
`Topic: "${topic}" | Total matching: ${(ctx.profile?.matchCount ?? matchCount).toLocaleString()}

Results:
${resultLines}
${guidedLines ? `\nQuestions to answer:\n${guidedLines}\n` : ''}
Return JSON:
{
  "headline": "single most important finding with a specific number",
  "summary": "2-3 sentences covering scale, dominant pattern, and one surprising finding",
  "insights": ["1-2 sentences per chart answering the guided questions with specific numbers"],
  "chartOrder": [0,1,2,3]
}`
        );
      },

      parse: (raw, ctx) => {
        const json = extractObj(raw);
        if (!json) throw new Error('Orchestrator returned no JSON');
        const synthesis = JSON.parse(json);

        // Attach per-chart insights and apply suggested order
        const analyses = [...(ctx.analyses ?? [])];
        synthesis.insights?.forEach((ins, i) => { if (analyses[i]) analyses[i].insight = ins; });

        let ordered = analyses;
        if (Array.isArray(synthesis.chartOrder) && synthesis.chartOrder.length === analyses.length) {
          ordered = synthesis.chartOrder.map(i => analyses[i]).filter(Boolean);
        }

        return { synthesis, analyses: ordered };
      },

      onStart: 'Synthesizing results and writing insights…',
      onDone:  (ctx) => ctx.synthesis?.headline ?? 'Analysis complete',
    });

    // ── Run the pipeline ──────────────────────────────────────────────────────
    try {
      const pipeline = new AgentPipeline({ onProgress: progress });
      pipeline.pipe(dataModeler).pipe(vizExpert).pipe(orchestrator);

      const ctx = await pipeline.run({ topic });

      return {
        topic,
        resolved,
        analyses:   ctx.analyses ?? [],
        summary:    ctx.synthesis?.summary,
        headline:   ctx.synthesis?.headline,
        aiPowered:  true,
        agentLog,
      };

    } catch (err) {
      const msg = err?.message || String(err);
      console.warn('[ChromaChart] Multi-agent pipeline error:', msg);
      progress({ agent: 'orchestrator',
        message: `Pipeline error: ${msg} — switching to statistical analysis`,
        step: 0, total: 1 });

      const result = await this._fallback.analyze(topic, {
        onProgress: m => onProgress({ agent: null, message: m, step: 0, total: 1 }),
      });
      return { ...result, agentLog, aiPowered: false };
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Fuzzy-match the topic string to an actual value in the data. */
  _resolve(topic) {
    const field = Object.keys(this.engine.schema).find(k =>
      ['complaint_type', 'type', 'category', 'issue_type'].some(c => k.toLowerCase().includes(c))
    );
    if (!field) return null;

    const cleaned = topic.toLowerCase()
      .replace(/\banalyze?\b|\banalysis\b|\bcomplaint[s]?\b|\bissue[s]?\b/g, '').trim();

    const allValues = [...new Set(this.engine.rows.map(r => r[field]).filter(Boolean))];

    const exact = allValues.find(v => v.toLowerCase() === cleaned);
    if (exact) return { field, value: exact };

    const contains = allValues.filter(v =>
      v.toLowerCase().includes(cleaned) || cleaned.includes(v.toLowerCase())
    );
    if (contains.length > 0) {
      contains.sort((a, b) => a.length - b.length);
      return { field, value: contains[0] };
    }

    const words  = cleaned.split(/\s+/).filter(w => w.length > 2);
    const scored = allValues
      .map(v => ({ v, score: words.filter(w => v.toLowerCase().includes(w)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.length > 0 ? { field, value: scored[0].v } : null;
  }

  /** Validate a Viz Expert spec before querying. */
  _validateSpec(spec) {
    if (!spec?.type || !spec?.x?.field) return false;
    if (!['bar', 'line', 'pie', 'area'].includes(spec.type)) return false;
    return Object.keys(this.engine.schema).includes(spec.x.field);
  }
}
