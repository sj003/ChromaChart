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

    // Always try the local LLM first — it understands natural language intent
    // (including exclusions, synonyms, complex phrasing) better than regex.
    // Race against a 5-second timeout so simple queries stay fast.
    try {
      const aiResult = this._compiler.queryAI(text);
      const timeout  = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('AI timeout')), 5000)
      );
      spec = await Promise.race([aiResult, timeout]);
    } catch {
      spec = this._parser.parse(text);
    }

    // Safety net: if the query has exclusion keywords but the AI didn't produce
    // an `exclude` field (small model limitation), apply NLP exclusion on top.
    // We only do this when `exclude` is absent — never overwrite a valid AI exclusion.
    const hasExclusion = /\b(ignoring|excluding|except|without|not\s+including)\b/i.test(text);
    if (hasExclusion && !spec.exclude) {
      this._parser._applyExclusions(text.toLowerCase().trim(), spec);
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

  // Detect which Chrome AI API shape is exposed.
  // - Newest (Chrome 138+):    window.LanguageModel             — has .availability() + .create()
  // - Older (Chrome ~127–137): window.ai.languageModel          — has .capabilities() + .create()
  // - Even older Origin Trial: window.ai.assistant              — same shape as languageModel
  // Returns the API object or null.
  static _resolveAPI() {
    if (typeof window === 'undefined') return null;
    if (window.LanguageModel?.create)        return { api: window.LanguageModel,    shape: 'new' };
    if (window.ai?.languageModel?.create)    return { api: window.ai.languageModel, shape: 'legacy' };
    if (window.ai?.assistant?.create)        return { api: window.ai.assistant,     shape: 'legacy' };
    return null;
  }

  // Returns { ready, status, detail, shape } — tries every known API shape.
  static async aiStatus() {
    const found = ChromaChart._resolveAPI();
    if (!found) {
      return {
        ready: false, status: 'unavailable',
        detail: 'No Chrome AI API found. Need Chrome 138+ Canary/Dev with chrome://flags/#prompt-api-for-gemini-nano enabled, or window.LanguageModel exposed.',
        shape: null
      };
    }

    const { api, shape } = found;
    console.log(`[ChromaChart] AI API found, shape="${shape}"`);

    try {
      // Newer API: availability() returns 'available' | 'downloadable' | 'downloading' | 'unavailable'
      // Older API: capabilities() returns { available: 'readily' | 'after-download' | 'no' }
      let availability;
      if (typeof api.availability === 'function') {
        availability = await api.availability();
        console.log('[ChromaChart] availability():', availability);
      } else if (typeof api.capabilities === 'function') {
        const cap = await api.capabilities();
        console.log('[ChromaChart] capabilities():', cap);
        availability = cap?.available === 'readily'        ? 'available'
                     : cap?.available === 'after-download' ? 'downloadable'
                     : 'unavailable';
      } else {
        return { ready: false, status: 'error', detail: 'API object has no availability() or capabilities()', shape };
      }

      if (availability === 'unavailable') {
        return { ready: false, status: 'unavailable', detail: 'Model not supported on this device', shape };
      }
      if (availability === 'downloading' || availability === 'downloadable' || availability === 'after-download') {
        return { ready: false, status: 'downloading', detail: 'Model downloading — chrome://components → "Optimization Guide On Device Model" → Check for update', shape };
      }
      if (availability !== 'available' && availability !== 'readily') {
        return { ready: false, status: 'unavailable', detail: `Unexpected availability="${availability}"`, shape };
      }

      // Confirm a session can actually be created
      const probe = await api.create({ systemPrompt: '' });
      probe.destroy();
      return { ready: true, status: 'ready', detail: `Gemini Nano ready (API shape: ${shape})`, shape };

    } catch (e) {
      console.error('[ChromaChart] aiStatus error:', e);
      return { ready: false, status: 'error', detail: e.message, shape };
    }
  }

  static async aiAvailable() {
    const { ready } = await ChromaChart.aiStatus();
    return ready;
  }
}
