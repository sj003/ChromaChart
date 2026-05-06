import { DataEngine }      from './data-engine.js';
import { PromptCompiler }  from './prompt-compiler.js';
import { NLPParser }       from './nlp-parser.js';
import { Renderer }        from './renderer.js';
import { MultiAgentAnalyzer } from './multi-agent-analyzer.js';

export class ChromaChart {
  constructor({ container, onLoad, onError } = {}) {
    this._engine   = new DataEngine();
    this._renderer = null;
    this._compiler = null;
    this._parser   = null;
    this._onLoad   = onLoad  || (() => {});
    this._onError  = onError || console.error;

    if (container) this._setupCanvas(container);
  }

  // ── Setup ──────────────────────────────────────────────────────────────────

  _setupCanvas(container) {
    const el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!el) throw new Error(`Container not found: ${container}`);
    el.innerHTML = '';
    const canvas = document.createElement('canvas');
    el.appendChild(canvas);
    this._renderer = new Renderer(canvas);
  }

  // ── Data loading ───────────────────────────────────────────────────────────

  async loadURL(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return this._load(await res.text());
  }

  async loadFile(file) {
    return this._load(await file.text());
  }

  loadData(rows) {
    this._engine.rows   = rows;
    this._engine.schema = this._engine._inferSchema(rows);
    this._afterLoad();
    return this;
  }

  _load(csvText) {
    this._engine.parseCSV(csvText);
    this._afterLoad();
    return this;
  }

  _afterLoad() {
    this._compiler = new PromptCompiler(this._engine.schema, this._engine.getSampleRows(5));
    this._parser   = new NLPParser(this._engine.schema);
    this._onLoad({ rowCount: this._engine.rowCount, schema: this._engine.schema });
  }

  // ── Query ──────────────────────────────────────────────────────────────────

  async query(text) {
    if (!this._engine.rowCount) throw new Error('No data loaded. Call loadURL(), loadFile(), or loadData() first.');

    let spec;
    // Try on-device Chrome AI first; fall back to rules-based NLP
    try {
      spec = await this._compiler.queryAI(text);
    } catch {
      spec = this._parser.parse(text);
    }

    return this._execute(spec);
  }

  // Render a hand-crafted spec directly (no AI / NLP step)
  render(spec) {
    return this._execute(spec);
  }

  _execute(spec) {
    const result = this._engine.query(spec);
    if (this._renderer) this._renderer.render(result, spec);
    return { spec, result };
  }

  // ── Deep analysis (multi-chart, multi-turn AI) ────────────────────────────

  async analyze(topic, options = {}) {
    if (!this._engine.rowCount) throw new Error('No data loaded.');
    const analyzer = new MultiAgentAnalyzer(this._engine);
    return analyzer.analyze(topic, options);
  }

  // ── Introspection ──────────────────────────────────────────────────────────

  get schema()   { return this._engine.schema; }
  get rowCount() { return this._engine.rowCount; }

  // Returns { ready: bool, status: 'ready'|'downloading'|'unavailable'|'error', detail: string }
  static async aiStatus() {
    try {
      if (!window?.ai?.languageModel) return { ready: false, status: 'unavailable', detail: 'window.ai.languageModel not found' };
      const cap = await window.ai.languageModel.capabilities?.();
      console.log('[ChromaChart] AI capabilities:', cap);
      if (!cap) return { ready: false, status: 'unavailable', detail: 'capabilities() returned nothing' };
      if (cap.available === 'no')             return { ready: false, status: 'unavailable', detail: 'Model not supported on this device' };
      if (cap.available === 'after-download') return { ready: false, status: 'downloading', detail: 'Model downloading — check chrome://components' };
      if (cap.available !== 'readily')        return { ready: false, status: 'unavailable', detail: `Unexpected status: ${cap.available}` };
      // 'readily' — confirm session creation actually works
      try {
        const probe = await window.ai.languageModel.create({ systemPrompt: '' });
        probe.destroy();
        return { ready: true, status: 'ready', detail: 'Gemini Nano ready' };
      } catch (e) {
        return { ready: false, status: 'error', detail: `Session creation failed: ${e.message}` };
      }
    } catch (e) {
      return { ready: false, status: 'error', detail: e.message };
    }
  }

  static async aiAvailable() {
    const { ready } = await ChromaChart.aiStatus();
    return ready;
  }
}
