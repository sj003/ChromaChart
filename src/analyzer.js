// Multi-step analysis orchestrator.
// With Gemini Nano: 3-turn session (plan → insights → summary).
// Without AI: statistical fallback for all steps.
export class Analyzer {
  constructor(engine) {
    this.engine = engine;
  }

  async analyze(topic, { onProgress = () => {} } = {}) {
    const resolved = this._resolve(topic);
    const aiAvailable = await this._checkAI();

    let analyses, summary;

    if (aiAvailable) {
      try {
        ({ analyses, summary } = await this._aiPipeline(topic, resolved, onProgress));
      } catch (err) {
        console.warn('AI pipeline failed, using statistical fallback:', err.message);
        analyses = this._buildFallbackPlan(resolved);
        this._runQueries(analyses);
        this._statisticalInsights(analyses);
        summary = this._statisticalSummary(topic, resolved, analyses);
      }
    } else {
      onProgress('Building analysis plan…');
      analyses = this._buildFallbackPlan(resolved);
      onProgress('Running queries…');
      this._runQueries(analyses);
      onProgress('Computing statistical insights…');
      this._statisticalInsights(analyses);
      summary = this._statisticalSummary(topic, resolved, analyses);
    }

    return { topic, resolved, analyses, summary, aiPowered: aiAvailable };
  }

  // ── AI pipeline (3-turn conversation) ──────────────────────────────────────

  async _aiPipeline(topic, resolved, onProgress) {
    const schema = this.engine.schema;
    const fieldNames = Object.keys(schema).join(', ');
    const schemaDesc = Object.entries(schema).map(([k, v]) => `"${k}": ${v.type}`).join(', ');
    const subjectValue = resolved?.value || topic;
    const subjectFilter = resolved ? `{ "${resolved.field}": "${resolved.value}" }` : '{}';

    // Count matching rows for context
    const matchingRows = resolved
      ? this.engine.query({ x: { field: resolved.field }, y: { aggregate: 'count' }, filter: { [resolved.field]: resolved.value } }).rowCount
      : this.engine.rowCount;

    const session = await window.ai.languageModel.create({
      systemPrompt: `You are a data analyst for NYC 311 service request data. Respond only with valid JSON when asked for JSON — no markdown, no explanation.`
    });

    try {
      // ── Turn 1: Plan ───────────────────────────────────────────────────────
      onProgress('Asking Gemini Nano to plan analysis dimensions…');

      const planPrompt = `I want to analyze "${subjectValue}" complaints from a NYC 311 dataset.

Dataset schema: { ${schemaDesc} }
Total rows in dataset: ${this.engine.rowCount.toLocaleString()}
Rows matching this complaint type: ${matchingRows.toLocaleString()}
Valid field names: ${fieldNames}

Generate exactly 4 analysis dimensions. Return a JSON array where each item is:
{
  "title": "short title (4-6 words)",
  "question": "what question this answers",
  "spec": {
    "type": "bar|line|pie",
    "title": "chart title",
    "x": { "field": "EXACT field name", "label": "axis label", "granularity": "month" },
    "y": { "field": null, "aggregate": "count", "label": "Count" },
    "filter": ${subjectFilter},
    "sort": "desc",
    "limit": null
  }
}

Requirements:
1. One time-series line chart (use x.granularity: "month")
2. One bar chart by borough/geographic area
3. One pie or bar for status/resolution breakdown
4. One bar chart by agency or another dimension
Apply the filter to all specs so they focus on "${subjectValue}" only.`;

      const planRaw = await session.prompt(planPrompt);
      const planMatch = planRaw.match(/\[[\s\S]*\]/);
      if (!planMatch) throw new Error('AI returned no JSON array for plan');

      let plan = JSON.parse(planMatch[0]);
      plan = plan.filter(p => this._validateSpec(p.spec));
      if (plan.length < 2) throw new Error('AI plan had too few valid specs');

      // ── Execute queries ────────────────────────────────────────────────────
      const analyses = plan.map(item => ({
        title: item.title,
        question: item.question,
        spec: item.spec,
        result: null,
        insight: ''
      }));

      analyses.forEach((a, i) => {
        onProgress(`Running query ${i + 1}/${analyses.length}: ${a.title}…`);
        a.result = this.engine.query(a.spec);
      });

      // ── Turn 2: Insights ───────────────────────────────────────────────────
      onProgress('Asking Gemini Nano to interpret results…');

      const resultsDesc = analyses.map((a, i) =>
        `${i + 1}. "${a.title}" — ${a.result.rowCount.toLocaleString()} rows, ` +
        `top values: ${a.result.labels.slice(0, 6).map((l, j) => `${l}=${a.result.values[j]}`).join(', ')}`
      ).join('\n');

      const insightPrompt = `The query results for "${subjectValue}" analysis are:

${resultsDesc}

For each of the ${analyses.length} dimensions above, write exactly 1–2 sentences describing the key finding. Be specific — include numbers and percentages.

Return a JSON array of strings (one insight per dimension, same order).`;

      const insightRaw = await session.prompt(insightPrompt);
      const insightMatch = insightRaw.match(/\[[\s\S]*\]/);
      if (insightMatch) {
        const insights = JSON.parse(insightMatch[0]);
        insights.forEach((ins, i) => { if (analyses[i]) analyses[i].insight = String(ins); });
      } else {
        this._statisticalInsights(analyses);
      }

      // ── Turn 3: Summary ────────────────────────────────────────────────────
      onProgress('Generating executive summary…');

      const summaryRaw = await session.prompt(
        `Based on everything above, write a 2–3 sentence executive summary about "${subjectValue}" ` +
        `complaints in NYC. Be specific about scale, geography, and resolution rate.`
      );

      return { analyses, summary: summaryRaw.trim() };
    } finally {
      session.destroy();
    }
  }

  // ── Fallback: rule-based plan ──────────────────────────────────────────────

  _buildFallbackPlan(resolved) {
    const s = this.engine.schema;
    const baseFilter = resolved ? { [resolved.field]: resolved.value } : {};
    const label = resolved?.value || 'All records';

    // Fields we've already used — avoid repeating the same axis
    const used = new Set([resolved?.field].filter(Boolean));

    // Skip fields that are IDs, free-text, or the subject field itself
    const skip = k => used.has(k) ||
      /^id$|_id$|^show_id|description|desc$|title|^cast$|^director/.test(k.toLowerCase());

    // 1. Date/time field: prefer schema-typed date, fall back by name
    const dateField = Object.entries(s).find(([k, v]) => !skip(k) && v.type === 'date')?.[0]
                   || Object.keys(s).find(k => !skip(k) && /date|added|created|updated/.test(k));

    // 2. Numeric year field (e.g. release_year) as fallback time axis
    const yearField = !dateField
      ? Object.entries(s).find(([k, v]) => !skip(k) && v.type === 'number' && /year/.test(k))?.[0]
      : null;

    // 3. Low-cardinality strings (2–15 unique) → pie charts
    const lowCard = Object.entries(s)
      .filter(([k, v]) => !skip(k) && v.type === 'string' && v.cardinality >= 2 && v.cardinality <= 15)
      .sort((a, b) => a[1].cardinality - b[1].cardinality)
      .map(([k]) => k);

    // 4. Medium-cardinality strings (6–200 unique) → bar charts
    const midCard = Object.entries(s)
      .filter(([k, v]) => !skip(k) && v.type === 'string' && v.cardinality > 5 && v.cardinality <= 200)
      .sort((a, b) => a[1].cardinality - b[1].cardinality)
      .map(([k]) => k);

    const plans = [];
    const label_ = k => k.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

    // Time trend
    if (dateField) {
      used.add(dateField);
      plans.push({ title: 'Trend Over Time', question: 'How has volume changed over time?',
        spec: { type: 'line', title: `${label} — trend over time`,
          x: { field: dateField, label: 'Month', granularity: 'month' },
          y: { field: null, aggregate: 'count', label: 'Count' },
          filter: baseFilter, sort: null, limit: null }, result: null, insight: '' });
    } else if (yearField) {
      used.add(yearField);
      plans.push({ title: 'By Year', question: 'How is volume distributed across years?',
        spec: { type: 'line', title: `${label} — by year`,
          x: { field: yearField, label: 'Year' },
          y: { field: null, aggregate: 'count', label: 'Count' },
          filter: baseFilter, sort: 'asc', limit: null }, result: null, insight: '' });
    }

    // Pie from lowest-cardinality field
    const pieField = lowCard.find(k => !used.has(k));
    if (pieField) {
      used.add(pieField);
      plans.push({ title: `By ${label_(pieField)}`, question: 'What is the distribution?',
        spec: { type: 'pie', title: `${label} — by ${label_(pieField)}`,
          x: { field: pieField, label: label_(pieField) },
          y: { field: null, aggregate: 'count', label: 'Count' },
          filter: baseFilter, sort: 'desc', limit: null }, result: null, insight: '' });
    }

    // Fill remaining slots with bar charts from mid-cardinality fields
    for (const field of [...lowCard, ...midCard]) {
      if (plans.length >= 4) break;
      if (used.has(field)) continue;
      used.add(field);
      plans.push({ title: `Top ${label_(field)}`, question: `Which ${label_(field)} values dominate?`,
        spec: { type: 'bar', title: `${label} — top ${label_(field)}`,
          x: { field, label: label_(field) },
          y: { field: null, aggregate: 'count', label: 'Count' },
          filter: baseFilter, sort: 'desc', limit: 10 }, result: null, insight: '' });
    }

    return plans;
  }

  _runQueries(analyses) {
    analyses.forEach(a => { a.result = this.engine.query(a.spec); });
  }

  // ── Statistical insight generation ─────────────────────────────────────────

  _statisticalInsights(analyses) {
    analyses.forEach(a => {
      const { labels, values, rowCount } = a.result;
      if (!values.length) { a.insight = 'No data available for this dimension.'; return; }

      const total = values.reduce((s, v) => s + v, 0);
      const max   = Math.max(...values);
      const maxIdx = values.indexOf(max);
      const maxLabel = labels[maxIdx];

      if (a.spec.type === 'pie') {
        const pct = total > 0 ? Math.round((max / total) * 100) : 0;
        a.insight = `"${maxLabel}" is the dominant status at ${pct}% of ${rowCount.toLocaleString()} complaints.`;
      } else if (a.spec.type === 'line') {
        const first = values[0], last = values[values.length - 1];
        const dir = last > first * 1.1 ? 'trending up' : last < first * 0.9 ? 'trending down' : 'roughly stable';
        a.insight = `Peak volume of ${max.toLocaleString()} in ${maxLabel}. Overall ${dir} across the time window.`;
      } else {
        const pct = total > 0 ? Math.round((max / total) * 100) : 0;
        const second = values.length > 1 ? values.sort((x, y) => y - x)[1] : 0;
        const ratio = second > 0 ? (max / second).toFixed(1) : '—';
        a.insight = `${maxLabel} leads with ${max.toLocaleString()} (${pct}% of total) — ${ratio}× more than the next highest.`;
      }
    });
  }

  _statisticalSummary(topic, resolved, analyses) {
    const label = resolved?.value || topic;
    const total = analyses[0]?.result?.rowCount ?? 0;

    const statusAnalysis = analyses.find(a => a.spec.type === 'pie');
    let resolutionNote = '';
    if (statusAnalysis) {
      const { labels, values } = statusAnalysis.result;
      const closedIdx = labels.findIndex(l => /closed|resolved|completed/i.test(l));
      if (closedIdx >= 0) {
        const sum = values.reduce((s, v) => s + v, 0);
        const pct = sum > 0 ? Math.round((values[closedIdx] / sum) * 100) : 0;
        resolutionNote = ` ${pct}% are closed.`;
      }
    }

    const geoAnalysis = analyses.find(a => a.title.toLowerCase().includes('borough'));
    let geoNote = '';
    if (geoAnalysis?.result?.labels?.length) {
      geoNote = ` ${geoAnalysis.result.labels[0]} reports the highest volume.`;
    }

    return `Analysis of <strong>${label}</strong> — ${total.toLocaleString()} matching records.${geoNote}${resolutionNote}`;
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

    // Strip generic words from topic before matching
    const cleaned = topic.toLowerCase()
      .replace(/\banalyze?\b|\banalysis\b|\bcomplaint[s]?\b|\bissue[s]?\b/g, '')
      .trim();

    const allValues = [...new Set(this.engine.rows.map(r => r[complaintField]).filter(Boolean))];

    const exact = allValues.find(v => v.toLowerCase() === cleaned);
    if (exact) return { field: complaintField, value: exact };

    const contains = allValues.filter(v => v.toLowerCase().includes(cleaned) || cleaned.includes(v.toLowerCase()));
    if (contains.length > 0) {
      contains.sort((a, b) => a.length - b.length);
      return { field: complaintField, value: contains[0] };
    }

    const words = cleaned.split(/\s+/).filter(w => w.length > 2);
    const scored = allValues
      .map(v => ({ v, score: words.filter(w => v.toLowerCase().includes(w)).length }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.length > 0 ? { field: complaintField, value: scored[0].v } : null;
  }

  _validateSpec(spec) {
    if (!spec || !spec.type || !spec.x?.field) return false;
    if (!['bar', 'line', 'pie', 'area'].includes(spec.type)) return false;
    if (!Object.keys(this.engine.schema).includes(spec.x.field)) return false;
    return true;
  }
}
