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
      console.warn('Multi-agent pipeline failed, falling back to statistical analysis:', err.message);
      const result = await this._fallback.analyze(topic, {
        onProgress: msg => onProgress({ agent: null, message: msg, step: 0, total: 1 })
      });
      return { ...result, agentLog };
    }
  }

  // ── Agent sessions ─────────────────────────────────────────────────────────

  async _runDataModeler(topic) {
    const schema    = this.engine.schema;
    const schemaStr = Object.entries(schema).map(([k, v]) => `"${k}": ${v.type}`).join(', ');
    const samples   = JSON.stringify(this.engine.getSampleRows(4), null, 2);

    // Pre-compute a few stats to give the model real numbers to work with
    const resolved  = this._resolve(topic);
    const matchRows = resolved
      ? this.engine.query({ x: { field: resolved.field }, y: { aggregate: 'count' }, filter: { [resolved.field]: resolved.value } }).rowCount
      : this.engine.rowCount;

    const fieldSamples = Object.entries(schema)
      .map(([k, v]) => `${k}: [${v.sample.slice(0, 4).join(', ')}]`)
      .join('\n');

    const session = await window.ai.languageModel.create({
      systemPrompt: `You are a data modeling expert. Your sole job is to profile datasets and identify patterns, data quality, and relevant fields for a given analysis topic. Always respond with valid JSON only — no markdown, no explanation.`
    });

    try {
      const prompt = `Dataset schema: { ${schemaStr} }
Total rows: ${this.engine.rowCount.toLocaleString()}
Rows matching topic "${topic}": ${matchRows.toLocaleString()}
Sample field values:
${fieldSamples}
Sample rows: ${samples}

Profile this dataset for the topic "${topic}". Return JSON:
{
  "topicMatch": "exact matched value in data or null",
  "topicField": "the field name that contains the topic",
  "relevantFields": ["field1", "field2"],
  "temporalField": "date field name or null",
  "geoField": "borough/area field or null",
  "statusField": "status field or null",
  "agencyField": "agency field or null",
  "matchCount": ${matchRows},
  "dataQuality": "good | fair | sparse",
  "keyPatterns": ["1-sentence pattern", "another pattern"],
  "_summary": "1 sentence summary of what the modeler found"
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
    const schema = this.engine.schema;
    const fieldNames = Object.keys(schema).join(', ');
    const profileStr = JSON.stringify(profile, null, 2);

    const session = await window.ai.languageModel.create({
      systemPrompt: `You are a data visualization expert. You know when to use line vs bar charts, when pie charts are appropriate, and how to design effective multi-chart dashboards. You only recommend charts that can be built from available fields. Always respond with valid JSON only.`
    });

    try {
      const filter = profile.topicField && profile.topicMatch
        ? `{ "${profile.topicField}": "${profile.topicMatch}" }`
        : '{}';

      const prompt = `Data profile for topic "${topic}":
${profileStr}

Available fields: ${fieldNames}

Design exactly 4 chart specifications for a dashboard about "${topic}".
Prioritize the most insightful charts. Each chart must filter to the topic.
Return a JSON array:
[{
  "dimension": "short title",
  "chartType": "bar | line | pie",
  "reason": "1 sentence: why this chart type for this data",
  "priority": 1,
  "spec": {
    "type": "bar | line | pie",
    "title": "chart title",
    "x": { "field": "EXACT field name from: ${fieldNames}", "label": "label", "granularity": "month (only if date field)" },
    "y": { "field": null, "aggregate": "count", "label": "Count" },
    "filter": ${filter},
    "sort": "desc",
    "limit": null
  }
}]

Rules:
- Use the temporal field for a line chart with granularity "month"
- Use the geo field for a bar chart showing geographic distribution
- Use the status field for a pie chart
- The 4th chart should reveal something non-obvious (agency, time-of-week pattern, etc.)
- Only use field names that exist: ${fieldNames}`;

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
