// Rules-based fallback parser — handles core query patterns without AI
export class NLPParser {
  constructor(schema) {
    this.schema = schema;
  }

  parse(query) {
    const q = query.toLowerCase().trim();
    const spec = this._base(q);

    this._applyTopK(q, spec);
    this._applyTimeGranularity(q, spec);
    this._applyAreaFilter(q, spec);
    spec.title = query.charAt(0).toUpperCase() + query.slice(1);

    return spec;
  }

  _base(q) {
    let type = 'bar';
    if (/trend|over time|timeline|daily|weekly|monthly|by day|by month|each day|per day/.test(q)) type = 'line';
    if (/pie|share|proportion|breakdown/.test(q)) type = 'pie';
    if (/area chart|stacked area/.test(q)) type = 'area';

    const xField = this._xField(q);

    return {
      type,
      x: { field: xField, label: this._label(xField) },
      y: { field: null, aggregate: 'count', label: 'Count' },
      filter: {},
      sort: 'desc',
      limit: null
    };
  }

  _xField(q) {
    if (/daily|by day|per day|each day|trend|over time|timeline/.test(q)) return this._dateField();
    if (/monthly|by month|per month/.test(q))                             return this._dateField();
    if (/yearly|by year|annual/.test(q))                                  return this._dateField();
    if (/by borough|by area|by district|area.wise|borough/.test(q))       return this._find(['borough', 'city', 'area', 'district']);
    if (/by agency|agency/.test(q))                                       return this._find(['agency_name', 'agency']);
    if (/by status|status/.test(q))                                       return this._find(['status']);
    return this._find(['complaint_type', 'type', 'category', 'issue_type']) || Object.keys(this.schema)[0];
  }

  _dateField() {
    return Object.entries(this.schema).find(([, v]) => v.type === 'date')?.[0]
      || Object.keys(this.schema).find(k => /date|time|created|updated/.test(k));
  }

  _find(candidates) {
    const keys = Object.keys(this.schema);
    for (const c of candidates) {
      const match = keys.find(k => k.toLowerCase().includes(c.toLowerCase()));
      if (match) return match;
    }
    return null;
  }

  _applyTopK(q, spec) {
    const m = q.match(/top\s+(\d+)/);
    if (m) { spec.limit = parseInt(m[1]); spec.sort = 'desc'; }
  }

  _applyTimeGranularity(q, spec) {
    if (this.schema[spec.x.field]?.type !== 'date') return;
    if (/daily|by day|per day|each day/.test(q))  { spec.x.granularity = 'day';   spec.type = 'line'; spec.sort = null; }
    else if (/monthly|by month|per month/.test(q)) { spec.x.granularity = 'month'; spec.type = 'line'; spec.sort = null; }
    else if (/yearly|by year|annual/.test(q))      { spec.x.granularity = 'year';  spec.type = 'line'; spec.sort = null; }
  }

  _applyAreaFilter(q, spec) {
    const boroughs = ['manhattan', 'brooklyn', 'queens', 'bronx', 'staten island'];
    const found = boroughs.filter(b => q.includes(b));
    if (!found.length) return;

    const field = this._find(['borough', 'city', 'area', 'district']);
    if (field) spec.filter[field] = found.map(b => b.toUpperCase());
  }

  _label(field) {
    if (!field) return '';
    return field.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }
}
