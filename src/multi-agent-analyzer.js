// Multi-agent analysis pipeline.
//
// Three specialized Gemini Nano sessions run sequentially, each with a narrow role:
//   Pass 1 — Data Modeler:       profiles data, identifies patterns & relevant fields
//   Pass 2 — Viz Expert:         receives profile, returns optimal chart specs
//   Pass 3 — Orchestrator:       receives profile + viz plan + results → insights + summary
//
// Each session is created fresh and destroyed immediately after its turn.
// Outputs are structured JSON passed as plain text between sessions.

import { Analyzer } from './analyzer.js';

export class MultiAgentAnalyzer {
  constructor(engine) {
    this.engine  = engine;
    this._fallback = new Analyzer(engine);
  }

  async analyze(topic, { onProgress = () => {} } = {}) {
    const aiAvailable = await this._checkAI();

    if (!aiAvailable) {
      onProgress({ agent: null, message: 'Running statistical analysis (Gemini Nano not available)…', step: 0, total: 1 });
      const result = await this._fallback.analyze(topic, {
        onProgress: msg => onProgress({ agent: null, message: msg, step: 0, total: 1 })
      });
      return { ...result, agentLog: [] };
    }

    const agentLog = [];
    const log = (agent, role, message) => {
      agentLog.push({ agent, role, message });
      onProgress({ agent, role, message, step: agentLog.length, total: 3 });
    };

    try {
      // Warm-up: verify we can actually create a session (not just check capabilities)
      const testSession = await window.ai.languageModel.create({ systemPrompt: 'test' });
      testSession.destroy();

      // ── Pass 1: Data Modeler ──────────────────────────────────────────────
      log('data-modeler', 'Data Modeler', 'Profiling dataset and identifying relevant patterns…');
      const dataProfile = await this._runDataModeler(topic);
      log('data-modeler', 'Data Modeler', dataProfile._summary);

      // ── Pass 2: Visualization Expert ──────────────────────────────────────
      log('viz-expert', 'Visualization Expert', 'Reviewing data profile and selecting optimal chart types…');
      const vizPlan = await this._runVizExpert(topic, dataProfile);
      log('viz-expert', 'Visualization Expert', `Planned ${vizPlan.length} charts: ${vizPlan.map(v => v.chartType + ' (' + v.dimension + ')').join(', ')}`);

      // ── Execute queries against the data engine ───────────────────────────
      log('orchestrator', 'Orchestrator', 'Running queries against dataset…');
      const analyses = vizPlan.map(item => ({
        title:    item.dimension,
        question: item.reason,
        spec:     item.spec,
        result:   this.engine.query(item.spec),
        insight:  ''
      }));

      // ── Pass 3: Orchestrator ──────────────────────────────────────────────
      log('orchestrator', 'Orchestrator', 'Synthesizing results and writing insights…');
      const synthesis = await this._runOrchestrator(topic, dataProfile, vizPlan, analyses);
      log('orchestrator', 'Orchestrator', synthesis.headline);

      // Merge orchestrator insights into analyses
      synthesis.insights?.forEach((ins, i) => {
        if (analyses[i]) analyses[i].insight = ins;
      });

      // Honour orchestrator's preferred ordering
      let ordered = analyses;
      if (Array.isArray(synthesis.chartOrder)) {
        ordered = synthesis.chartOrder
          .map(i => analyses[i])
          .filter(Boolean);
        // Append any extras not in the order list
        analyses.forEach((a, i) => {
          if (!synthesis.chartOrder.includes(i)) ordered.push(a);
        });
      }

      return {
        topic,
        resolved:   dataProfile.topicMatch ? { field: dataProfile.topicField, value: dataProfile.topicMatch } : null,
        analyses:   ordered,
        summary:    synthesis.summary,
        headline:   synthesis.headline,
        aiPowered:  true,
        agentLog
      };

    } catch (err) {
      const reason = err?.message || String(err);
      console.warn('[ChromaChart] Multi-agent pipeline failed:', reason);
      // Show the actual error in the agent log so the user can see what happened
      onProgress({ agent: null, message: `AI pipeline error: ${reason} — switching to statistical analysis`, step: 0, total: 1 });

      const fallbackResult = await this._fallback.analyze(topic, {
        onProgress: msg => onProgress({ agent: null, message: msg, step: 0, total: 1 })
      });
      return { ...fallbackResult, agentLog, aiPowered: false };
    }
  }

  // ── Agent sessions ─────────────────────────────────────────────────────────

  async _runDataModeler(topic) {
    const schema    = this.engine.schema;

    // Keep prompt small for Gemini Nano's limited context window.
    // Exclude high-cardinality / free-text fields from samples.
    const skipInSamples = new Set(
      Object.entries(schema)
        .filter(([, v]) => v.cardinality > 200 || v.type === 'string' && v.sample.some(s => s.length > 80))
        .map(([k]) => k)
    );

    const schemaStr = Object.entries(schema)
      .map(([k, v]) => `"${k}": ${v.type}(${v.cardinality} unique)`)
      .join(', ');

    // Compact field samples — only low-cardinality fields, values truncated
    const fieldSamples = Object.entries(schema)
      .filter(([k, v]) => !skipInSamples.has(k) && v.cardinality <= 50)
      .map(([k, v]) => `${k}: [${v.sample.slice(0, 3).map(s => String(s).slice(0, 30)).join(', ')}]`)
      .join('\n');

    const resolved  = this._resolve(topic);
    const matchRows = resolved
      ? this.engine.query({ x: { field: resolved.field }, y: { aggregate: 'count' }, filter: { [resolved.field]: resolved.value } }).rowCount
      : this.engine.rowCount;

    const session = await window.ai.languageModel.create({
      systemPrompt: `You are a data modeling expert. Profile datasets to identify patterns and relevant fields. Respond with valid JSON only — no markdown, no explanation.`
    });

    try {
      const prompt = `Schema: { ${schemaStr} }
Total rows: ${this.engine.rowCount.toLocaleString()}
Rows matching "${topic}": ${matchRows.toLocaleString()}
Field samples:
${fieldSamples}

Profile for topic "${topic}". Return JSON:
{
  "topicMatch": "exact matched value or null",
  "topicField": "field name containing the topic",
  "temporalField": "date/year field or null",
  "geoField": "location/country/region field or null",
  "statusField": "status/state field or null",
  "agencyField": "agency/department field or null",
  "matchCount": ${matchRows},
  "dataQuality": "good|fair|sparse",
  "_summary": "1 sentence summary"
}`;

      const raw = await session.prompt(prompt);
      const json = raw.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('Data Modeler returned no JSON');
      return JSON.parse(json);
    } finally {
      session.destroy();
    }
  }

  async _runVizExpert(topic, profile) {
    const schema    = this.engine.schema;
    const fieldNames = Object.keys(schema).join(', ');

    // Send only the compact profile fields the viz expert actually needs
    const compactProfile = {
      topicMatch:    profile.topicMatch,
      topicField:    profile.topicField,
      temporalField: profile.temporalField,
      geoField:      profile.geoField,
      statusField:   profile.statusField,
      agencyField:   profile.agencyField,
      matchCount:    profile.matchCount,
    };

    const session = await window.ai.languageModel.create({
      systemPrompt: `You are a data visualization expert. Recommend optimal chart types for datasets. Always respond with valid JSON only.`
    });

    try {
      const filter = profile.topicField && profile.topicMatch
        ? `{ "${profile.topicField}": "${profile.topicMatch}" }`
        : '{}';

      const prompt = `Topic: "${topic}"
Profile: ${JSON.stringify(compactProfile)}
Available fields (use EXACT names): ${fieldNames}

Return a JSON array of exactly 4 chart specs:
[{
  "dimension": "short title",
  "chartType": "bar|line|pie",
  "reason": "why this chart type",
  "priority": 1,
  "spec": {
    "type": "bar|line|pie",
    "title": "chart title",
    "x": { "field": "EXACT field name", "label": "label", "granularity": "month" },
    "y": { "field": null, "aggregate": "count", "label": "Count" },
    "filter": ${filter},
    "sort": "desc",
    "limit": 10
  }
}]

Rules: temporal→line(granularity:month), geo→bar, status/type→pie, 4th→most insightful remaining field.
Only use field names from: ${fieldNames}`;

      const raw  = await session.prompt(prompt);
      const json = raw.match(/\[[\s\S]*\]/)?.[0];
      if (!json) throw new Error('Viz Expert returned no JSON array');

      const plan = JSON.parse(json);
      return plan
        .filter(p => this._validateSpec(p.spec))
        .sort((a, b) => (a.priority || 99) - (b.priority || 99))
        .slice(0, 4);
    } finally {
      session.destroy();
    }
  }

  async _runOrchestrator(topic, profile, vizPlan, analyses) {
    const resultsStr = analyses.map((a, i) =>
      `Chart ${i + 1} — "${a.title}" (${a.spec.type}):\n` +
      `  rows matched: ${a.result.rowCount.toLocaleString()}\n` +
      `  top entries: ${a.result.labels.slice(0, 5).map((l, j) => `${l}=${a.result.values[j]?.toLocaleString()}`).join(', ')}`
    ).join('\n\n');

    const session = await window.ai.languageModel.create({
      systemPrompt: `You are a senior data analyst and storyteller. You synthesize multi-chart analysis results into clear, data-driven narratives. You highlight the most surprising findings and always back claims with specific numbers. Always respond with valid JSON only.`
    });

    try {
      const prompt = `You are finalizing a data analysis for "${topic}".

Data profile summary: ${profile._summary}
Matching records: ${profile.matchCount?.toLocaleString() ?? 'unknown'} out of ${this.engine.rowCount.toLocaleString()} total

Query results:
${resultsStr}

Synthesize these results. Return JSON:
{
  "headline": "The single most important finding (1 sentence, include a specific number)",
  "summary": "Executive summary: 2-3 sentences, include geography, trend, and resolution rate where available",
  "insights": [
    "1-2 sentence insight for chart 1 — be specific with numbers",
    "1-2 sentence insight for chart 2",
    "1-2 sentence insight for chart 3",
    "1-2 sentence insight for chart 4"
  ],
  "chartOrder": [0, 1, 2, 3],
  "highlightChart": 0
}

chartOrder should put the most compelling chart first.`;

      const raw  = await session.prompt(prompt);
      const json = raw.match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('Orchestrator returned no JSON');
      return JSON.parse(json);
    } finally {
      session.destroy();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async _checkAI() {
    try {
      if (!window?.ai?.languageModel) return false;
      const cap = await window.ai.languageModel.capabilities();
      return cap.available !== 'no';
    } catch { return false; }
  }

  _resolve(topic) {
    const complaintField = Object.keys(this.engine.schema).find(k =>
      ['complaint_type', 'type', 'category', 'issue_type'].some(c => k.toLowerCase().includes(c))
    );
    if (!complaintField) return null;

    const cleaned = topic.toLowerCase()
      .replace(/\banalyze?\b|\banalysis\b|\bcomplaint[s]?\b|\bissue[s]?\b/g, '')
      .trim();

    const allValues = [...new Set(this.engine.rows.map(r => r[complaintField]).filter(Boolean))];

    const exact = allValues.find(v => v.toLowerCase() === cleaned);
    if (exact) return { field: complaintField, value: exact };

    const contains = allValues.filter(v => v.toLowerCase().includes(cleaned) || cleaned.includes(v.toLowerCase()));
    if (contains.length > 0) { contains.sort((a, b) => a.length - b.length); return { field: complaintField, value: contains[0] }; }

    const words  = cleaned.split(/\s+/).filter(w => w.length > 2);
    const scored = allValues
      .map(v => ({ v, score: words.filter(w => v.toLowerCase().includes(w)).length }))
      .filter(x => x.score > 0).sort((a, b) => b.score - a.score);

    return scored.length > 0 ? { field: complaintField, value: scored[0].v } : null;
  }

  _validateSpec(spec) {
    if (!spec?.type || !spec?.x?.field) return false;
    if (!['bar', 'line', 'pie', 'area'].includes(spec.type)) return false;
    return Object.keys(this.engine.schema).includes(spec.x.field);
  }
}
