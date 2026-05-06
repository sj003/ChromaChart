export class PromptCompiler {
  constructor(schema, sampleRows) {
    this.schema = schema;
    this.sampleRows = sampleRows;
  }

  build(userQuery) {
    const schemaStr = Object.entries(this.schema)
      .map(([k, v]) => `  "${k}": ${v.type}  (e.g. ${v.sample.slice(0, 3).join(', ')})`)
      .join('\n');

    const sampleStr = JSON.stringify(this.sampleRows.slice(0, 3), null, 2);

    return `You are a chart configuration engine. Given a dataset schema and a user query,
return ONLY a valid JSON ChartSpec object. No explanation, no markdown, no text outside the JSON.

Dataset Schema:
${schemaStr}

Sample rows:
${sampleStr}

Supported chart types: bar, line, pie, area

ChartSpec JSON format:
{
  "type": "bar|line|pie|area",
  "title": "descriptive chart title",
  "x": {
    "field": "column name from schema",
    "label": "axis label",
    "granularity": "day|month|year  (only for date fields, omit otherwise)"
  },
  "y": {
    "field": null,
    "aggregate": "count|sum|avg|min|max",
    "label": "axis label"
  },
  "filter": {},
  "sort": "desc",
  "limit": null
}

Rules:
- "top N" queries: set sort "desc" and limit N
- time-series queries: set x.granularity to "day", "month", or "year"; use line or area type
- area/borough/region filter: set filter field to matching column
- default aggregate is "count" when no numeric measure is requested

User query: "${userQuery}"

ChartSpec:`;
  }

  async queryAI(userQuery) {
    // Resolve whichever Chrome AI API shape is exposed
    const api = window.LanguageModel?.create     ? window.LanguageModel
              : window.ai?.languageModel?.create ? window.ai.languageModel
              : window.ai?.assistant?.create     ? window.ai.assistant
              : null;
    if (!api) throw new Error('Chrome AI API not available — falling back to NLP parser');

    const session = await api.create({
      systemPrompt: 'You are a chart configuration engine. Always return only valid JSON, nothing else.'
    });

    try {
      const response = await session.prompt(this.build(userQuery));
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON in AI response');
      return JSON.parse(jsonMatch[0]);
    } finally {
      session.destroy();
    }
  }
}
