// Multi-agent analysis pipeline.
//
// Pass 1 — Data Modeler:   infers topic match + which fields are useful
// Pass 2 — Viz Expert:     receives ONLY the relevant fields, picks 4 chart specs
// Pass 3 — Orchestrator:   receives ONLY actual result summaries, writes insights
//
// Each session gets the minimum context it needs — Gemini Nano has ~1 024 token input limit.
// Sessions are created fresh and destroyed immediately after their turn.

import { Analyzer } from './analyzer.js';

// Resolve the Chrome AI API regardless of which version is exposed.
// Mirrors ChromaChart._resolveAPI(). Kept local to avoid circular imports.
function resolveAIAPI() {
  if (typeof window === 'undefined') return null;
  if (window.LanguageModel?.create)     return { api: window.LanguageModel,    shape: 'new' };
  if (window.ai?.languageModel?.create) return { api: window.ai.languageModel, shape: 'legacy' };
  if (window.ai?.assistant?.create)     return { api: window.ai.assistant,     shape: 'legacy' };
  return null;
}

export class MultiAgentAnalyzer {
  constructor(engine) {
    this.engine    = engine;
    this._fallback = new Analyzer(engine);
    this._aiAPI    = null;  // resolved once in _checkAI
  }

  async analyze(topic, { onProgress = () => {} } = {}) {
    const aiAvailable = await this._checkAI();

    if (!aiAvailable) {
      const reason = this._aiError || 'Gemini Nano session unavailable';
      onProgress({ agent: null, message: `⚠️ ${reason}`, step: 0, total: 1 });
      onProgress({ agent: null, message: 'Running statistical analysis instead…', step: 0, total: 1 });
      const result = await this._fallback.analyze(topic, {
        onProgress: msg => onProgress({ agent: null, message: msg, step: 0, total: 1 })
      });
      return { ...result, agentLog: [] };
    }

    const agentLog = [];
    const log = (agent, message) => {
      agentLog.push({ agent, message });
      onProgress({ agent, message, step: agentLog.length, total: 6 });
    };

    try {
      // ── Pass 1: Data Modeler ──────────────────────────────────────────────
      log('data-modeler', 'Profiling dataset fields and identifying topic match…');
      const profile = await this._pass1_dataModeler(topic);
      log('data-modeler', profile._summary || `Found "${profile.topicMatch}" in field "${profile.topicField}"`);

      // ── Pass 2: Viz Expert ────────────────────────────────────────────────
      log('viz-expert', 'Selecting optimal chart types for each dimension…');
      const vizPlan = await this._pass2_vizExpert(topic, profile);
      log('viz-expert', `Planned: ${vizPlan.map(v => `${v.dimension} (${v.spec.type})`).join(' · ')}`);

      // ── Execute queries ───────────────────────────────────────────────────
      log('orchestrator', 'Running data queries…');
      const analyses = vizPlan.map(item => ({
        title:    item.dimension,
        question: item.reason,
        spec:     item.spec,
        result:   this.engine.query(item.spec),
        insight:  ''
      }));

      // ── Pass 3: Orchestrator ──────────────────────────────────────────────
      log('orchestrator', 'Synthesizing results and writing insights…');
      const synthesis = await this._pass3_orchestrator(topic, profile, analyses);
      log('orchestrator', synthesis.headline || 'Analysis complete');

      synthesis.insights?.forEach((ins, i) => { if (analyses[i]) analyses[i].insight = ins; });

      // Honour suggested chart order
      let ordered = analyses;
      if (Array.isArray(synthesis.chartOrder) && synthesis.chartOrder.length === analyses.length) {
        ordered = synthesis.chartOrder.map(i => analyses[i]).filter(Boolean);
      }

      return { topic, resolved: profile.topicMatch ? { field: profile.topicField, value: profile.topicMatch } : null,
        analyses: ordered, summary: synthesis.summary, headline: synthesis.headline,
        aiPowered: true, agentLog };

    } catch (err) {
      const msg = err?.message || String(err);
      console.warn('[ChromaChart] Multi-agent pipeline error:', msg);
      log('orchestrator', `Pipeline error: ${msg} — switching to statistical analysis`);

      const result = await this._fallback.analyze(topic, {
        onProgress: m => onProgress({ agent: null, message: m, step: 0, total: 1 })
      });
      return { ...result, agentLog, aiPowered: false };
    }
  }

  // ── Pass 1: Data Modeler ───────────────────────────────────────────────────
  // Only sends: field names + types + cardinality + a few sample values per field.
  // High-cardinality / free-text fields are excluded from samples to stay within token budget.

  async _pass1_dataModeler(topic) {
    const schema = this.engine.schema;

    // Build a compact schema string: "field: type(cardinality) [v1, v2, v3]"
    const schemaLines = Object.entries(schema).map(([k, v]) => {
      const samples = v.cardinality <= 30
        ? ` [${v.sample.slice(0, 4).map(s => String(s).slice(0, 25)).join(', ')}]`
        : ` (${v.cardinality} unique values)`;
      return `  ${k}: ${v.type}${samples}`;
    }).join('\n');

    const resolved = this._resolve(topic);
    const matchCount = resolved
      ? this.engine.query({ x: { field: resolved.field }, y: { aggregate: 'count' }, filter: { [resolved.field]: resolved.value } }).rowCount
      : this.engine.rowCount;

    const session = await this._aiAPI.create({
      systemPrompt: 'You are a data profiler. Respond with valid JSON only.'
    });

    try {
      const prompt =
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
  "lowCardFields": ["field with <15 unique values", "..."],
  "midCardFields": ["field with 15-150 unique values", "..."],
  "_summary": "one sentence"
}`;

      const raw  = await session.prompt(prompt);
      const json = raw.match(/\{[\s\S]*?\}/)?.[0];
      if (!json) throw new Error('Data Modeler returned no JSON');
      return JSON.parse(json);
    } finally {
      session.destroy();
    }
  }

  // ── Pass 2: Visualization Expert ───────────────────────────────────────────
  // Receives ONLY the profile (no schema dump).
  // Returns 4 chart specs using only the fields the Data Modeler identified.

  async _pass2_vizExpert(topic, profile) {
    const subjectFilter = profile.topicField && profile.topicMatch
      ? `{"${profile.topicField}":"${profile.topicMatch}"}`
      : '{}';

    // Build a concise field menu for the viz expert
    const fieldMenu = [
      profile.temporalField && `${profile.temporalField} (date — use for line chart with granularity:month)`,
      profile.geoField      && `${profile.geoField} (geography — use for bar chart)`,
      ...(profile.lowCardFields  || []).map(f => `${f} (${this.engine.schema[f]?.cardinality} values — good for pie)`),
      ...(profile.midCardFields  || []).map(f => `${f} (${this.engine.schema[f]?.cardinality} values — good for bar, limit:10)`)
    ].filter(Boolean).join('\n');

    const session = await this._aiAPI.create({
      systemPrompt: 'You are a chart designer. Respond with valid JSON only.'
    });

    try {
      const prompt =
`Topic: "${topic}" (${profile.matchCount?.toLocaleString() ?? '?'} matching rows)
Filter to apply to all charts: ${subjectFilter}

Available fields:
${fieldMenu}

Design 4 charts. Return JSON array:
[{"dimension":"title","reason":"why this type","spec":{"type":"bar|line|pie","title":"...","x":{"field":"EXACT name","label":"...","granularity":"month"},"y":{"field":null,"aggregate":"count","label":"Count"},"filter":${subjectFilter},"sort":"desc","limit":10}}]

Rules: 1 line chart (temporal), 1 bar chart (geo or mid-card), 1 pie (low-card), 1 bar (another field).
Remove "granularity" key if field is not temporal.`;

      const raw  = await session.prompt(prompt);
      const json = raw.match(/\[[\s\S]*?\]/)?.[0];
      if (!json) throw new Error('Viz Expert returned no JSON array');

      const plan = JSON.parse(json);
      return plan
        .filter(p => this._validateSpec(p.spec))
        .slice(0, 4);
    } finally {
      session.destroy();
    }
  }

  // ── Pass 3: Orchestrator ───────────────────────────────────────────────────
  // Receives ONLY a compact result summary (labels + values, no specs).
  // Writes per-chart insights + headline + summary.

  async _pass3_orchestrator(topic, profile, analyses) {
    // Compact result summary — top 5 labels/values per chart only
    const resultLines = analyses.map((a, i) =>
      `${i + 1}. ${a.title}: ${a.result.rowCount.toLocaleString()} rows — ` +
      a.result.labels.slice(0, 5).map((l, j) => `${l}=${a.result.values[j]?.toLocaleString()}`).join(', ')
    ).join('\n');

    const session = await this._aiAPI.create({
      systemPrompt: 'You are a data analyst. Write clear, specific insights backed by numbers. Respond with valid JSON only.'
    });

    try {
      const prompt =
`Topic: "${topic}" | Total matching: ${profile.matchCount?.toLocaleString() ?? '?'}

Results:
${resultLines}

Return JSON:
{
  "headline": "single most important finding with a specific number",
  "summary": "2-3 sentences: scale, geography, resolution rate",
  "insights": ["1-2 sentences per chart, specific numbers", "..."],
  "chartOrder": [0,1,2,3]
}`;

      const raw  = await session.prompt(prompt);
      const json = raw.match(/\{[\s\S]*?\}/)?.[0];
      if (!json) throw new Error('Orchestrator returned no JSON');
      return JSON.parse(json);
    } finally {
      session.destroy();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  async _checkAI() {
    this._aiError = null;
    this._aiAPI   = null;

    const found = resolveAIAPI();
    if (!found) {
      this._aiError = 'No Chrome AI API. Need Chrome 138+ Canary/Dev with chrome://flags/#prompt-api-for-gemini-nano enabled.';
      console.warn('[ChromaChart]', this._aiError);
      return false;
    }
    const { api, shape } = found;
    console.log(`[ChromaChart] AI API resolved, shape="${shape}"`);

    try {
      let availability;
      if (typeof api.availability === 'function') {
        availability = await api.availability();
        console.log('[ChromaChart] availability():', availability);
      } else if (typeof api.capabilities === 'function') {
        const cap = await api.capabilities();
        console.log('[ChromaChart] capabilities():', JSON.stringify(cap));
        availability = cap?.available === 'readily'        ? 'available'
                     : cap?.available === 'after-download' ? 'downloadable'
                     : 'unavailable';
      } else {
        this._aiError = 'API has no availability() or capabilities() method';
        return false;
      }

      if (availability === 'unavailable') {
        this._aiError = 'Model not supported on this device';
        return false;
      }
      if (availability === 'downloading' || availability === 'downloadable') {
        this._aiError = 'Model is downloading — go to chrome://components, update "Optimization Guide On Device Model", then reload';
        return false;
      }
      if (availability !== 'available' && availability !== 'readily') {
        this._aiError = `Unexpected availability="${availability}"`;
        return false;
      }

      console.log('[ChromaChart] availability OK, probing session creation…');
      const probe = await api.create({ systemPrompt: '' });
      probe.destroy();
      console.log('[ChromaChart] probe session OK — AI ready ✓');

      this._aiAPI = api;
      return true;

    } catch (err) {
      this._aiError = `AI check failed: ${err.message}`;
      console.error('[ChromaChart]', this._aiError, err);
      return false;
    }
  }

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

    const contains = allValues.filter(v => v.toLowerCase().includes(cleaned) || cleaned.includes(v.toLowerCase()));
    if (contains.length > 0) { contains.sort((a, b) => a.length - b.length); return { field, value: contains[0] }; }

    const words  = cleaned.split(/\s+/).filter(w => w.length > 2);
    const scored = allValues.map(v => ({ v, score: words.filter(w => v.toLowerCase().includes(w)).length }))
                            .filter(x => x.score > 0).sort((a, b) => b.score - a.score);
    return scored.length > 0 ? { field, value: scored[0].v } : null;
  }

  _validateSpec(spec) {
    if (!spec?.type || !spec?.x?.field) return false;
    if (!['bar', 'line', 'pie', 'area'].includes(spec.type)) return false;
    return Object.keys(this.engine.schema).includes(spec.x.field);
  }
}
