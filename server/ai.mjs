// AI operations behind one adapter: Claude or Gemini when configured (see loadProvider); otherwise a
// deterministic, evidence-only provider keeps the app usable.
// Research text is untrusted: it is passed as data and model output is validated before use.
import { id, now } from './db.mjs';
import { AppError } from './lib.mjs';

import {PROMPT_VERSION,SYSTEM,briefPrompt,draftPrompt,rewritePrompt} from './ai-prompts.mjs';
export {PROMPT_VERSION};
export const CATALOG = {
  roles: ['Founder', 'CEO', 'CTO', 'Head of Growth', 'Head of Sales', 'VP Sales', 'Marketing Director', 'HR Director'],
  industries: ['B2B SaaS', 'Fintech', 'E-commerce', 'Healthcare', 'IT services', 'Manufacturing'],
  locations: ['India', 'United States', 'United Kingdom', 'UAE', 'Singapore', 'Europe'],
  sizes: ['1–10', '11–50', '51–200', '201–500', '501–1,000', '1,000+'],
  seniority: ['Founder / Owner', 'C-level', 'VP / Head', 'Director', 'Manager'],
  exclude: ['Existing customers', 'Competitors', 'Active opportunities', 'Agencies'],
  signals: ['Hiring', 'Funding', 'New leadership', 'Expansion'],
};
const SIGNAL_WORDS = { Hiring: /\bhir(e|es|ing)\b|open roles?|job openings?|recruit/i, Funding: /\bfund(ing|ed)\b|\braised?\b|series [a-e]\b|seed round|investment/i, 'New leadership': /\bappoint(ed|s)?\b|new (head|vp|cto|ceo|chief|leader)|joined as|promoted/i, Expansion: /\bexpan(d|ds|ding|sion)\b|new market|new office|launch(ed|es)? in/i };

// ---------- Offline provider ----------
const has = (text, re) => re.test(text);
const offline = {
  name: 'offline', model: null,
  async interpretBrief({ prompt }) {
    const t = ' ' + prompt.toLowerCase() + ' ';
    const pick = (pairs) => [...new Set(pairs.filter(([re]) => re.test(t)).map(([, v]) => v))];
    const filters = {
      roles: pick([[/founder/, 'Founder'], [/\bceo|chief executive/, 'CEO'], [/\bcto\b|chief technology/, 'CTO'], [/head(s)? of growth|growth lead/, 'Head of Growth'], [/head(s)? of sales|sales lead/, 'Head of Sales'], [/vp (of )?sales/, 'VP Sales'], [/marketing director|head(s)? of marketing|cmo/, 'Marketing Director'], [/\bhr\b|people (team|lead)|talent/, 'HR Director']]),
      industries: pick([[/saas|software/, 'B2B SaaS'], [/fintech/, 'Fintech'], [/e-?commerce|d2c|retail/, 'E-commerce'], [/health/, 'Healthcare'], [/it services|consult/, 'IT services'], [/manufactur/, 'Manufacturing']]),
      locations: pick([[/india|bangalore|bengaluru|mumbai|delhi/, 'India'], [/\b(us|usa|united states|america)\b/, 'United States'], [/\b(uk|united kingdom|london|britain)\b/, 'United Kingdom'], [/\buae\b|dubai|abu dhabi/, 'UAE'], [/singapore/, 'Singapore'], [/europe|\beu\b/, 'Europe']]),
      sizes: [], seniority: [], exclude: [],
    };
    const range = t.match(/(\d[\d,]*)\s*(?:-|–|to)\s*(\d[\d,]*)\s*(?:employees|people|staff)/);
    if (range) { const lo = +range[1].replace(/,/g, ''), hi = +range[2].replace(/,/g, ''); filters.sizes = sizeBuckets(lo, hi); }
    else if (/startup|early[- ]stage|seed/.test(t)) filters.sizes = ['1–10', '11–50'];
    const signals = CATALOG.signals.filter(s => SIGNAL_WORDS[s].test(prompt) || (s === 'Funding' && /recently funded/i.test(prompt)));
    const clarifications = [];
    if (!filters.roles.length) clarifications.push('No job role was recognized. Choose the roles you want to reach.');
    if (!filters.industries.length) clarifications.push('No industry was recognized; any industry will match unless you choose one.');
    if (!filters.locations.length) clarifications.push('No location was recognized; any location will match unless you choose one.');
    if (!signals.length) clarifications.push('No buying signal was recognized. Discovery can use audience fit, or you can add an optional event trigger.');
    const who = filters.roles.slice(0, 2).join(' & ') || 'Prospects', where = filters.locations[0] ? ' · ' + filters.locations[0] : '';
    return { name: `${who}${filters.industries[0] ? ' at ' + filters.industries[0] : ''}${where}`.slice(0, 80), filters, signals, notes: '', clarifications, summary: 'Keyword interpretation (no AI provider configured). Confirm every filter before discovery.' };
  },
  async draftEmail({ context, config, lead, evidence }) {
    const w = config.writing, first = lead.first_name, greeting = w.tone === 'Professional' ? 'Hello' : 'Hi';
    const fact = w.angle === 'Signal-led' ? evidence[0] : null;
    const opener = fact ? `I noticed that ${fact.fact.replace(/\.$/, '')}.` : `I came across ${lead.company} while looking at teams in ${lead.industry || 'your space'}.`;
    const ask = w.cta === 'Book a meeting' ? 'Would you be open to a 15-minute conversation next week?' : w.cta === 'Ask permission' ? 'Would it be useful if I sent a short overview?' : 'Is this something your team is thinking about?';
    const body = w.length === 'Concise'
      ? `${greeting} ${first},\n\n${config.offer}\n\nWorth a quick conversation for ${lead.company}?\n\n${context.signature}`
      : `${greeting} ${first},\n\n${opener}\n\n${config.offer}\n\n${ask}\n\n${context.signature}`;
    return { subject: `A thought for ${lead.company}`, body, evidence_ids: fact ? [fact.id] : [], review_note: fact || w.angle !== 'Signal-led' ? null : 'No usable signal evidence; a factual company-led opening was used.' };
  },
  async rewriteEmail({ context, config, lead, draft, style }) {
    const first = lead.first_name;
    const body = style === 'short' ? `Hi ${first},\n\n${config.offer}\n\nWorth a quick chat for ${lead.company}?\n\n${context.signature}`
      : style === 'human' ? `Hi ${first},\n\nI came across ${lead.company} and thought there might be a useful conversation here.\n\n${config.offer}\n\nDoes that sound relevant to what you’re working on? No worries if the timing’s off.\n\n${context.signature}`
      : `Hello ${first},\n\n${config.offer}\n\nWould you have 15 minutes next week to explore whether we could help ${lead.company}?\n\n${context.signature}`;
    return { subject: draft.subject, body, evidence_ids: [] };
  },
};
export function sizeBuckets(lo, hi) {
  const b = [[1, 10, '1–10'], [11, 50, '11–50'], [51, 200, '51–200'], [201, 500, '201–500'], [501, 1000, '501–1,000'], [1001, Infinity, '1,000+']];
  return b.filter(([a, z]) => a <= hi && z >= lo).map(x => x[2]);
}

// ---------- AI providers (Claude or Gemini) ----------
// Both use the same prompts, JSON schemas, and post-generation guards; only the API call differs.
const str = { type: 'string' }, strArr = { type: 'array', items: str };
const obj = (props) => ({ type: 'object', properties: props, required: Object.keys(props), additionalProperties: false });
const SCHEMAS = {
  interpret: obj({ name: str, filters: obj({ roles: strArr, industries: strArr, locations: strArr, sizes: strArr, seniority: strArr, exclude: strArr }), signals: strArr, notes: str, clarifications: strArr, summary: str }),
  draft: obj({ subject: str, body: str, evidence_ids: strArr, review_note: str }),
};
// Retries a call while the provider reports a temporary condition (overload, rate limit, network).
const RETRY_DELAYS_MS = () => (process.env.AI_RETRY_DELAYS_MS ?? '800,2000').split(',').filter(Boolean).map(Number);
async function withRetry(fn, isTransient) {
  const delays = RETRY_DELAYS_MS();
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= delays.length || !isTransient(e)) throw e;
      await new Promise(r => setTimeout(r, delays[i] * (0.8 + Math.random() * 0.4)));
    }
  }
}
const parseJson = (op, text) => { try { return JSON.parse(text); } catch { throw new AppError(502, 'ai_invalid_output', `The AI ${op} response was not valid JSON.`); } };
// The same operation prompts and schemas are used by both providers.
function llmProvider({ name, model, call, classifyError }) {
  return { name, model, call, classifyError,
    async interpretBrief(input) {const {out,...meta}=await call('interpret',SCHEMAS.interpret,briefPrompt(input,CATALOG),'medium');return {...out,_meta:meta};},
    async draftEmail(input) {const {out,...meta}=await call('draft',SCHEMAS.draft,draftPrompt(input),'medium');return {...out,_meta:meta};},
    async rewriteEmail(input) {const {out,...meta}=await call('draft',SCHEMAS.draft,rewritePrompt(input),'low');return {...out,_meta:meta};},
  };
}

async function loadClaude(required) {
  let Anthropic;
  try { ({ default: Anthropic } = await import('@anthropic-ai/sdk')); }
  catch { if (required) throw new Error('AI_PROVIDER=claude but @anthropic-ai/sdk is not installed. Run npm install.'); return null; }
  const client = new Anthropic({ timeout: 45000, maxRetries: 0 });
  const model = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';
  return llmProvider({
    name: 'claude', model,
    async call(op, schema, user, effort) {
      const response = await client.beta.messages.create({
        model, max_tokens: 16000, system: SYSTEM,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort, format: { type: 'json_schema', schema } },
        messages: [{ role: 'user', content: user }],
      });
      if (response.stop_reason === 'refusal') throw new AppError(502, 'ai_refused', `The AI provider declined the ${op} request.`);
      if (response.stop_reason === 'max_tokens') throw new AppError(502, 'ai_truncated', `The AI ${op} response was cut off.`);
      const out = parseJson(op, response.content.filter(b => b.type === 'text').map(b => b.text).join(''));
      return { out, usage: { input_tokens: response.usage?.input_tokens, output_tokens: response.usage?.output_tokens }, model: response.model };
    },
    classifyError(e) {
      if (e instanceof Anthropic.RateLimitError) return new AppError(503, 'ai_rate_limited', 'The AI provider is rate limiting requests. The job will retry.');
      if (e instanceof Anthropic.AuthenticationError) return new AppError(503, 'ai_auth_failed', 'The AI provider rejected the configured credentials.');
      if (e instanceof Anthropic.APIConnectionError || (e instanceof Anthropic.APIError && (e.status >= 500 || e.status === 529))) return new AppError(503, 'ai_unavailable', 'The AI provider is temporarily unavailable.');
      if (e instanceof Anthropic.APIError) return new AppError(502, 'ai_error', `AI provider error (${e.status ?? 'network'}).`);
    },
  });
}

async function loadGemini(required) {
  let sdk;
  try { sdk = await import('@google/genai'); }
  catch { if (required) throw new Error('AI_PROVIDER=gemini but @google/genai is not installed. Run npm install.'); return null; }
  const ai = new sdk.GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY, ...(process.env.GEMINI_BASE_URL ? { httpOptions: { baseUrl: process.env.GEMINI_BASE_URL } } : {}) });
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  // When the main model stays overloaded, try a lighter one. Set GEMINI_FALLBACK_MODEL=none to disable.
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL === 'none' ? null : (process.env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest');
  const transient = e => (e instanceof sdk.ApiError && [429, 500, 502, 503, 504].includes(e.status)) || (!(e instanceof sdk.ApiError) && !(e instanceof AppError) && /fetch failed|ECONNRESET|ETIMEDOUT|network/i.test(String(e?.message || e)));
  const BLOCKED = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'RECITATION']);
  return llmProvider({
    name: 'gemini', model,
    async call(op, schema, user) {
      const generate = m => withRetry(() => ai.models.generateContent({
        model: m, contents: user,
        config: { systemInstruction: SYSTEM, responseMimeType: 'application/json', responseJsonSchema: schema, maxOutputTokens: 16000 },
      }), transient);
      let response;
      try { response = await generate(model); }
      catch (e) { if (!fallbackModel || fallbackModel === model || !transient(e)) throw e; response = await generate(fallbackModel); }
      const finish = response.candidates?.[0]?.finishReason;
      if (response.promptFeedback?.blockReason || BLOCKED.has(finish)) throw new AppError(502, 'ai_refused', `The AI provider declined the ${op} request.`);
      if (finish === 'MAX_TOKENS') throw new AppError(502, 'ai_truncated', `The AI ${op} response was cut off.`);
      const out = parseJson(op, response.text ?? '');
      const u = response.usageMetadata || {};
      return { out, usage: { input_tokens: u.promptTokenCount, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) }, model: response.modelVersion || model };
    },
    classifyError(e) {
      if (!(e instanceof sdk.ApiError)) return transient(e) ? new AppError(503, 'ai_unavailable', 'The AI provider could not be reached.') : undefined;
      if (e.status === 429) return new AppError(503, 'ai_rate_limited', 'The AI provider is rate limiting requests.');
      if (e.status === 401 || e.status === 403 || (e.status === 400 && /api key/i.test(e.message))) return new AppError(503, 'ai_auth_failed', 'The AI provider rejected the configured API key.');
      if (e.status >= 500) return new AppError(503, 'ai_unavailable', 'The AI provider is temporarily overloaded.');
      return new AppError(502, 'ai_error', `AI provider error (${e.status ?? 'network'}).`);
    },
  });
}

// AI_PROVIDER: auto (Claude if ANTHROPIC_API_KEY is set, else Gemini if GEMINI_API_KEY is set, else
// offline templates), or claude / gemini / offline to force one.
async function loadProvider() {
  const mode = (process.env.AI_PROVIDER || 'auto').toLowerCase();
  if (mode === 'offline') return null;
  if (mode === 'claude') return loadClaude(true);
  if (mode === 'gemini') return loadGemini(true);
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) return loadClaude(false);
  if (process.env.GEMINI_API_KEY) return loadGemini(false);
  return null;
}

let providerPromise;
export const getProvider = () => (providerPromise ??= loadProvider().then(p => p || offline));
export const offlineProvider = offline;
export const resetProvider = () => { providerPromise = undefined; };

// Wraps a provider call with logging; never logs prompts or personal data. When the provider is only
// temporarily unavailable (overloaded, rate limited, unreachable), the step falls back to the offline
// provider and the result carries `degraded` so the UI can say so. Configuration errors (bad key) and
// refusals still surface. Set AI_FALLBACK=off to fail instead.
const TEMPORARY = new Set(['ai_unavailable', 'ai_rate_limited']);
export async function runAi(db, workspaceId, operation, fn) {
  const p = await getProvider(), started = Date.now();
  const log = (status, extra) => db.insert('ai_calls', { id: id(), workspace_id: workspaceId, operation, provider: p.name, prompt_version: PROMPT_VERSION, status, latency_ms: Date.now() - started, created_at: now(), model: p.model, input_tokens: null, output_tokens: null, error: null, ...extra });
  try {
    const out = await fn(p);
    await log('ok', { model: out?._meta?.model || p.model, input_tokens: out?._meta?.usage?.input_tokens, output_tokens: out?._meta?.usage?.output_tokens });
    return { out, provider: p.name, model: out?._meta?.model || p.model };
  } catch (e) {
    await log('error', { error: String(e.message).slice(0, 300) });
    const err = p.classifyError?.(e) || e;
    if (p === offline || !(err instanceof AppError) || !TEMPORARY.has(err.code) || process.env.AI_FALLBACK === 'off') throw err;
    return { out: await fn(offline), provider: 'offline', model: null, degraded: `${err.message} A template was used instead.` };
  }
}

// Post-generation guard: drafts may not assert signal facts that their evidence does not support.
// FTP's training and tournament access are opportunities, not guaranteed inclusions.
export function checkFtpDraft(draft, context, config) {
  if (config?.compliance_profile !== 'ftp_sports_tours' && String(context?.company || '').trim().toLowerCase() !== 'ftp') return [];
  const text = `${draft?.subject || ''} ${draft?.body || ''}`;
  const errors = [];
  if (/\b(guaranteed|guarantee|lowest price|cheapest|best price)\b/i.test(text)) errors.push('Unverified guarantee or price claim.');
  if (/\b(every|each|all)\b[^.!?\n]{0,90}\b(training|tournament access|tournaments)\b/i.test(text)) errors.push('Training or tournament access must not be promised for every package.');
  return errors;
}
export function checkDraft(draft, evidence, signature, allowedText = []) {
  const problems = [];
  if (!draft || typeof draft.subject !== 'string' || typeof draft.body !== 'string' || !Array.isArray(draft.evidence_ids)) return ['Invalid draft structure.'];
  let claims = draft.body || '';
  for (const t of allowedText) if (t) claims = claims.split(t).join(' '); // the customer's own offering/proof may use these words
  if (!draft.subject?.trim() || draft.subject.length > 140) problems.push('Subject must be 1–140 characters.');
  if (!draft.body?.trim() || draft.body.length > 3000) problems.push('Body must be 1–3,000 characters.');
  if (/\{\{|\}\}|\[(first ?name|company|name)\]/i.test(draft.subject + draft.body)) problems.push('Unresolved placeholder in draft.');
  const cited = evidence.filter(e => (draft.evidence_ids || []).includes(e.id));
  for (const [signal, re] of Object.entries(SIGNAL_WORDS)) {
    if (has(claims, re) && !cited.some(e => e.signal === signal)) problems.push(`Mentions ${signal.toLowerCase()} without cited evidence.`);
  }
  if (signature && !draft.body.trimEnd().endsWith(signature.trimEnd())) problems.push('Complete signature must appear unchanged at the end.');
  const prose = signature && draft.body.trimEnd().endsWith(signature.trimEnd()) ? draft.body.trimEnd().slice(0,-signature.trimEnd().length) : draft.body;
  if (prose.trim().split(/\s+/).filter(Boolean).length >= 140) problems.push('Body must be under 140 words before the signature.');
  return problems;
}
