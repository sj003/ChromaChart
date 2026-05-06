# ChromaChart

**AI-powered browser-native charting library that runs entirely on-device.**

ChromaChart turns natural-language questions into interactive charts using Chrome's built-in Gemini Nano model. There is no server, no API key, and no data ever leaves the browser. Drop in a CSV, type "analyze blocked driveway complaints", and a multi-agent pipeline plans the dashboard, picks the chart types, and writes the insights — all locally.

> ChromaChart is an experiment in what happens when LLMs become a browser primitive instead of a cloud service. It is an MVP, not a finished product.

---

## Why this exists

Existing AI-charting tools (Tableau Ask Data, ChartGPT, Julius, Power BI Copilot) all rely on cloud LLMs — your data leaves your machine, and you pay per query.

The Chrome [Prompt API](https://developer.chrome.com/docs/ai/prompt-api) puts a small language model directly inside the browser. That changes the cost structure (free), the privacy model (data stays local), and the deployment model (a single HTML file is the entire app).

ChromaChart explores what a charting library looks like when those constraints flip.

---

## Demo

The repository ships with two real datasets and a self-contained demo page.

```bash
git clone <your-fork-url>
cd chromachart

# any static server works
python3 -m http.server 3000

# then open
http://localhost:3000/demo/index.html
```

Click **Load 20K rows** (NYC 311) or **Load 8K titles** (Netflix), then try a preset query or type your own.

The demo works in any modern Chrome — without Gemini Nano enabled it falls back to a rules-based NLP parser plus statistical insight generation. With Gemini Nano enabled, the multi-agent pipeline activates.

---

## Features

- **Natural-language queries** — "Top 10 complaint types in Brooklyn", "Daily trend of issues", "Movies vs TV Shows"
- **Exclusion filters** — "Top 10 complaints ignoring parking-related issues"
- **Deep analysis mode** — type `analyze <topic>` to trigger a 4-chart dashboard with auto-generated insights
- **Multi-agent AI orchestration** — three specialized Gemini Nano sessions cooperate to plan, design, and synthesize
- **Graceful degradation** — every feature works without AI; the LLM is a progressive enhancement
- **Zero dependencies at runtime** — Chart.js loaded from CDN, everything else is plain ES modules
- **Two real datasets bundled** — NYC 311 service requests (live from data.gov) and Netflix titles (Kaggle 2021 snapshot)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         ChromaChart                             │
│                                                                 │
│   CSV/JSON ─► DataEngine ─► Schema inference + Query execution  │
│                   │                                             │
│                   ▼                                             │
│   Query  ─► PromptCompiler ─► Chrome Prompt API ─► ChartSpec    │
│             (or NLPParser)         (Gemini Nano)                │
│                   │                                             │
│                   ▼                                             │
│              Renderer  ─► Chart.js  ─► <canvas>                 │
└─────────────────────────────────────────────────────────────────┘
```

### Multi-agent analysis pipeline

When the user types `analyze <topic>`, three specialized Gemini Nano sessions run in sequence:

```
Pass 1 — Data Modeler
  System: "You are a data profiler"
  Input:  compact schema + cardinality + samples
  Output: { topicMatch, temporalField, geoField, lowCardFields, midCardFields }

       │  (only the relevant fields, not the whole schema)
       ▼

Pass 2 — Visualization Expert
  System: "You are a chart designer"
  Input:  field menu from Pass 1 only
  Output: 4 ChartSpecs with type justification

       │  (queries execute against DataEngine — no AI)
       ▼

Pass 3 — Orchestrator
  System: "You are a data analyst"
  Input:  top-5 labels/values per chart from real query results
  Output: { headline, summary, per-chart insights, chartOrder }
```

Each session is created with a narrow system prompt and destroyed immediately after its turn. The pipeline finishes in 3 LLM passes, not an open-ended conversation, so latency stays bounded.

Why three sessions instead of one? The Data Modeler never sees visualization concerns. The Viz Expert receives structured profile metadata, not raw CSV. The Orchestrator only sees actual query results, so its insights are grounded in real numbers — not hallucinated from samples.

---

## Library API

```js
import { ChromaChart } from './src/chromachart.js';

const chart = new ChromaChart({ container: '#chart-wrap' });

// Load CSV from URL or File
await chart.loadURL('./my-data.csv');
// or: await chart.loadFile(fileInput.files[0]);
// or: chart.loadData([{ ... }, { ... }]);

// Single-chart query
const { spec, result } = await chart.query('Top 10 categories by revenue');

// Deep analysis (returns 4 charts + insights)
const analysis = await chart.analyze('blocked driveway', {
  onProgress: ({ agent, message }) => console.log(`[${agent}] ${message}`)
});
// → { topic, analyses: [{title, spec, result, insight}, ...], summary, headline, aiPowered }

// Check what's available
const status = await ChromaChart.aiStatus();
// → { ready: true, status: 'ready', detail: '...', shape: 'new' | 'legacy' }
```

### ChartSpec format

The format the AI produces and the renderer consumes:

```js
{
  type: 'bar' | 'line' | 'pie' | 'area',
  title: 'descriptive title',
  x: { field: 'column_name', label: 'X axis', granularity: 'day' | 'month' | 'year' },
  y: { field: null, aggregate: 'count' | 'sum' | 'avg' | 'min' | 'max', label: 'Y axis' },
  filter: { fieldName: 'value' | ['v1', 'v2'] },
  exclude: { fieldName: ['keyword1', 'keyword2'] },  // partial substring exclusion
  sort: 'asc' | 'desc' | null,
  limit: 10
}
```

---

## Enabling Gemini Nano in Chrome

The Chrome Prompt API is experimental and gated behind flags. Without it, ChromaChart still works — it falls back to a rules-based NLP parser. With it, the multi-agent pipeline runs.

### Required setup

1. Install **Chrome Canary** or **Chrome Dev** (version 138 or later) from [google.com/chrome/canary](https://www.google.com/chrome/canary/)
2. Enable two flags by pasting these into the address bar:
   ```
   chrome://flags/#prompt-api-for-gemini-nano                 →  Enabled
   chrome://flags/#optimization-guide-on-device-model         →  Enabled BypassPerfRequirement
   ```
3. Restart Chrome
4. Go to `chrome://components`, find **Optimization Guide On Device Model**, click **Check for update**. Wait for the ~1.7 GB model to download.
5. Restart Chrome again, open the demo. The badge should show **Gemini Nano — on-device AI** in green.

### Hardware requirements

Per [Chrome's docs](https://developer.chrome.com/docs/ai/prompt-api#hardware), the model needs roughly:
- 22 GB free disk space
- 4 GB+ VRAM (integrated GPUs may not work)
- A non-metered network connection for the initial download

If your hardware doesn't qualify, the API will report `unavailable` and ChromaChart will use its statistical fallback. Every feature still works.

### API shape detection

Chrome migrated the Prompt API path between versions. ChromaChart checks all known locations:

```js
window.LanguageModel.create()        // Chrome 138+ (current)
window.ai.languageModel.create()     // Chrome 127–137
window.ai.assistant.create()         // earlier origin trial
```

Whichever exists is used automatically.

---

## Project structure

```
chromachart/
├── src/
│   ├── data-engine.js            CSV parsing + schema inference + query execution
│   ├── prompt-compiler.js        Single-chart prompt builder for the Chrome AI API
│   ├── nlp-parser.js             Rules-based fallback NLP (no AI required)
│   ├── analyzer.js               Statistical analysis fallback
│   ├── multi-agent-analyzer.js   Three-pass Gemini Nano orchestration
│   ├── renderer.js               Chart.js adapter
│   └── chromachart.js            Public API
├── demo/
│   └── index.html                Self-contained demo (no build step)
├── data/
│   ├── nyc311.csv                NYC 311 service requests, 20k rows
│   └── netflix.csv               Netflix titles catalog, 8k rows
└── package.json
```

No build pipeline. No bundler. The demo is a single HTML file using native ES modules.

---

## Datasets

Both bundled datasets are publicly available open data, included for demo purposes only.

- **NYC 311 Service Requests** — sampled live from [data.cityofnewyork.us](https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9) via the Socrata API. Public domain.
- **Netflix Movies and TV Shows** — 2021 catalog snapshot, mirrored from [TidyTuesday](https://github.com/rfordatascience/tidytuesday/blob/master/data/2021/2021-04-20/netflix_titles.csv). Public dataset.

Neither contains personal data. The repository contains no API keys, secrets, or credentials — the entire point of the architecture is that none are needed.

---

## Status and limitations

This is an MVP exploring an idea, not a production library.

**Currently supported:**
- Aggregations: count, sum, avg, min, max
- Single-field grouping with optional time granularity (day/month/year)
- Filtering (exact value or array) and exclusion (partial substring)
- Sorting and limit (top-N)
- Bar, line, pie, area charts via Chart.js

**Not supported (yet):**
- Multi-dataset joins
- Calculated columns at query time
- Forecasting / trend projection
- Geographic / choropleth charts
- Multi-axis charts
- Pivot tables

**Known constraints:**
- Gemini Nano has a tight context window (~1024 input tokens). Datasets with very long free-text fields are summarized before being sent.
- The Chrome Prompt API is unstable and the API shape has changed twice already. ChromaChart probes for whichever shape is exposed.
- Large CSVs (>1M rows) parse fine but querying becomes noticeably slower; this is unoptimized.

---

## License

MIT — see `package.json`.

---

## Acknowledgements

Built as an exploration of [Chrome's Prompt API](https://developer.chrome.com/docs/ai/prompt-api). Chart rendering by [Chart.js](https://www.chartjs.org/).
