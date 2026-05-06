export class DataEngine {
  constructor() {
    this.rows = [];
    this.schema = {};
  }

  parseCSV(text) {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/);
    const headers = this._splitLine(lines[0]);
    this.rows = [];

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const values = this._splitLine(line);
      const row = {};
      headers.forEach((h, idx) => { row[h] = values[idx] ?? ''; });
      this.rows.push(row);
    }

    this.schema = this._inferSchema(this.rows);
    return this;
  }

  _splitLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  }

  _inferSchema(rows) {
    if (!rows.length) return {};
    const schema = {};
    const sample = rows.slice(0, Math.min(500, rows.length));

    Object.keys(rows[0]).forEach(field => {
      const values = sample.map(r => r[field]).filter(v => v !== '' && v != null);
      const total = values.length || 1;
      const numericCount = values.filter(v => !isNaN(v) && v.trim() !== '').length;
      const dateCount = values.filter(v => /\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}/.test(v)).length;

      let type = 'string';
      if (numericCount / total > 0.85) type = 'number';
      else if (dateCount / total > 0.85) type = 'date';

      const uniqueValues = [...new Set(values)];
      schema[field] = { type, cardinality: uniqueValues.length, sample: uniqueValues.slice(0, 10) };
    });

    return schema;
  }

  query(spec) {
    let rows = [...this.rows];

    // Inclusion filter (exact match or array of exact matches)
    if (spec.filter) {
      for (const [field, value] of Object.entries(spec.filter)) {
        if (!value) continue;
        rows = rows.filter(r => {
          const v = (r[field] || '').toLowerCase();
          return Array.isArray(value)
            ? value.some(val => v === val.toLowerCase())
            : v === String(value).toLowerCase();
        });
      }
    }

    // Exclusion filter (partial substring match — handles "ignoring parking" → removes "Illegal Parking")
    if (spec.exclude) {
      for (const [field, keywords] of Object.entries(spec.exclude)) {
        if (!keywords?.length) continue;
        rows = rows.filter(r => {
          const v = (r[field] || '').toLowerCase();
          return !keywords.some(kw => v.includes(kw.toLowerCase()));
        });
      }
    }

    const xField = spec.x?.field;
    const yAggregate = spec.y?.aggregate || 'count';
    const yField = spec.y?.field;
    const granularity = spec.x?.granularity;

    // Group
    const groups = new Map();
    rows.forEach(row => {
      let key = row[xField] ?? 'Unknown';
      if (!key) key = 'Unknown';

      if (granularity && this.schema[xField]?.type === 'date') {
        key = this._truncateDate(key, granularity);
      }

      if (!groups.has(key)) groups.set(key, { count: 0, values: [] });
      const g = groups.get(key);
      g.count++;
      if (yField && row[yField] !== '' && !isNaN(row[yField])) {
        g.values.push(parseFloat(row[yField]));
      }
    });

    // Aggregate
    let results = [...groups.entries()].map(([label, g]) => {
      let value;
      switch (yAggregate) {
        case 'count': value = g.count; break;
        case 'sum':   value = g.values.reduce((a, b) => a + b, 0); break;
        case 'avg':   value = g.values.length ? g.values.reduce((a, b) => a + b, 0) / g.values.length : 0; break;
        case 'min':   value = g.values.length ? Math.min(...g.values) : 0; break;
        case 'max':   value = g.values.length ? Math.max(...g.values) : 0; break;
        default:      value = g.count;
      }
      return { label, value: Math.round(value * 100) / 100 };
    });

    // Sort
    if (spec.sort === 'desc') results.sort((a, b) => b.value - a.value);
    else if (spec.sort === 'asc') results.sort((a, b) => a.value - b.value);
    else if (granularity) results.sort((a, b) => a.label.localeCompare(b.label));

    // Limit
    if (spec.limit && spec.limit > 0) results = results.slice(0, spec.limit);

    return { labels: results.map(r => r.label), values: results.map(r => r.value), rowCount: rows.length };
  }

  _truncateDate(dateStr, granularity) {
    const d = new Date(dateStr);
    if (isNaN(d)) return dateStr;
    if (granularity === 'day')   return d.toISOString().slice(0, 10);
    if (granularity === 'month') return d.toISOString().slice(0, 7);
    if (granularity === 'year')  return String(d.getFullYear());
    return dateStr;
  }

  getSampleRows(n = 5) { return this.rows.slice(0, n); }
  get rowCount() { return this.rows.length; }
}
