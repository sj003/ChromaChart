/**
 * AgentPipeline — a lightweight multi-agent library for Chrome's on-device Gemini Nano.
 *
 * Abstracts: Chrome AI API shape detection, session lifecycle management,
 * sequential agent orchestration, and JSON extraction from LLM responses.
 *
 * Core concepts:
 *   Agent       — one LLM session with a narrow system prompt, a prompt-builder,
 *                 and a response parser.  Each agent receives the shared context
 *                 accumulated so far and returns new data to merge into it.
 *
 *   AgentPipeline — runs a sequence of Agents, threading context between them.
 *                   Every agent is created fresh and destroyed immediately after
 *                   its turn so sessions never share state.
 *
 * Usage:
 *   import { AgentPipeline, Agent, extractObj, extractArr } from './agent-pipeline.js';
 *
 *   const result = await new AgentPipeline({ onProgress })
 *     .pipe(new Agent('analyst', {
 *       system:  'You are a data analyst. Return valid JSON only.',
 *       build:   (ctx) => `Summarise: ${ctx.input}`,
 *       parse:   (raw) => ({ summary: JSON.parse(extractObj(raw)) }),
 *       onStart: 'Analysing data…',
 *       onDone:  (ctx) => ctx.summary?.headline ?? 'Done',
 *     }))
 *     .run({ input: 'some data' });
 */

// ── JSON extraction ────────────────────────────────────────────────────────
// Brace-balanced extraction so nested objects and any } inside string values
// are handled correctly.  Safe replacement for the fragile lazy-regex approach.

export function extractObj(text) { return _balanced(text, '{', '}'); }
export function extractArr(text) { return _balanced(text, '[', ']'); }

function _balanced(text, opener, closer) {
  const start = text.indexOf(opener);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc)                 { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true;  continue; }
    if (c === '"')           { inStr = !inStr; continue; }
    if (inStr)               continue;
    if (c === opener)        depth++;
    else if (c === closer && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

// ── Chrome AI API resolution ───────────────────────────────────────────────
// Chrome has changed the Prompt API path twice.  We probe all known locations
// and use whichever is present.

function _resolveAPI() {
  if (typeof window === 'undefined') return null;
  if (window.LanguageModel?.create)     return { api: window.LanguageModel,    shape: 'new' };
  if (window.ai?.languageModel?.create) return { api: window.ai.languageModel, shape: 'legacy' };
  if (window.ai?.assistant?.create)     return { api: window.ai.assistant,     shape: 'legacy' };
  return null;
}

// ── Agent ──────────────────────────────────────────────────────────────────

export class Agent {
  /**
   * @param {string} name       Identifier shown in progress events.
   * @param {object} opts
   *   system   {string}                     System prompt for this agent's session.
   *   build    {(context) => string}        Builds the user-turn prompt from context.
   *   parse    {(raw, context) => object}   Parses raw LLM output; returned object is
   *                                          merged into context for subsequent agents.
   *   onStart  {string | (context) => string}  Progress message before LLM call.
   *   onDone   {(context) => string}           Progress message after parse, receives
   *                                             updated context.
   */
  constructor(name, { system, build, parse, onStart, onDone } = {}) {
    this.name    = name;
    this.system  = system  ?? '';
    this.build   = build   ?? (() => '');
    this.parse   = parse   ?? (() => ({}));
    this.onStart = onStart ?? `${name} running…`;
    this.onDone  = onDone  ?? (() => `${name} complete`);
  }
}

// ── AgentPipeline ──────────────────────────────────────────────────────────

export class AgentPipeline {
  /**
   * @param {object} opts
   *   onProgress  {({ agent, message, step, total }) => void}
   *               Called before each agent starts and after each agent finishes.
   */
  constructor({ onProgress } = {}) {
    this._agents     = [];
    this._onProgress = onProgress ?? (() => {});
  }

  /** Append an agent to the pipeline. Returns `this` for chaining. */
  pipe(agent) {
    this._agents.push(agent);
    return this;
  }

  /**
   * Check whether the on-device model is ready without running any agents.
   * Returns { available: bool, shape: string | null, reason: string | null }.
   */
  static async checkAvailability() {
    const found = _resolveAPI();
    if (!found) {
      return {
        available: false, shape: null,
        reason: 'Chrome AI API not found. Enable chrome://flags/#prompt-api-for-gemini-nano in Chrome 138+ Canary/Dev.'
      };
    }

    const { api, shape } = found;
    try {
      let avail;
      if (typeof api.availability === 'function') {
        avail = await api.availability();
      } else if (typeof api.capabilities === 'function') {
        const cap = await api.capabilities();
        avail = cap?.available === 'readily'        ? 'available'
              : cap?.available === 'after-download' ? 'downloadable'
              : 'unavailable';
      } else {
        return { available: false, shape, reason: 'API exposes no availability() or capabilities()' };
      }

      if (avail === 'unavailable')
        return { available: false, shape, reason: 'Model not supported on this device' };
      if (avail === 'downloading' || avail === 'downloadable')
        return { available: false, shape, reason: 'Model still downloading — check chrome://components' };
      if (avail !== 'available' && avail !== 'readily')
        return { available: false, shape, reason: `Unexpected availability value: "${avail}"` };

      // Confirm a real session can be created
      const probe = await api.create({ systemPrompt: '' });
      probe.destroy();
      return { available: true, shape, reason: null };

    } catch (e) {
      return { available: false, shape, reason: e.message };
    }
  }

  /**
   * Run all piped agents sequentially, threading a shared context object through each.
   *
   * Each agent:
   *   1. Receives `onStart` progress event
   *   2. Gets a fresh LLM session (created → prompted → destroyed)
   *   3. Its parse() return value is spread into context
   *   4. Receives `onDone` progress event with the updated context
   *
   * @param  {object} initialContext  Starting data passed to the first agent.
   * @returns {object}               Final accumulated context after all agents.
   */
  async run(initialContext = {}) {
    const found = _resolveAPI();
    if (!found) throw new Error('Chrome AI (Gemini Nano) not available');
    const { api } = found;

    let context = { ...initialContext };
    const total = this._agents.length * 2;  // onStart + onDone per agent
    let step = 0;

    for (const agent of this._agents) {
      // ── onStart ────────────────────────────────────────────────────────────
      const startMsg = typeof agent.onStart === 'function'
        ? agent.onStart(context)
        : agent.onStart;
      this._onProgress({ agent: agent.name, message: startMsg, step: ++step, total });

      // ── LLM call ───────────────────────────────────────────────────────────
      const session = await api.create({ systemPrompt: agent.system });
      let parsed;
      try {
        const prompt = agent.build(context);
        const raw    = await session.prompt(prompt);
        parsed = agent.parse(raw, context);
      } finally {
        session.destroy();
      }

      // Merge agent output into context
      context = { ...context, ...parsed };

      // ── onDone ─────────────────────────────────────────────────────────────
      const doneMsg = typeof agent.onDone === 'function'
        ? agent.onDone(context)
        : agent.onDone;
      this._onProgress({ agent: agent.name, message: doneMsg, step: ++step, total });
    }

    return context;
  }
}
