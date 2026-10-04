/**
 * BijliSathi AI Triage Service
 * Handles:
 *  - duplicate detection (geo + text similarity)
 *  - fake / genuineness scoring + PHOTO vision analysis
 *  - ETA prediction (rough resolve time)
 *  - nearest-technician auto-dispatch (KESCO Commander)
 *  - notifications via Socket.IO + complaint fields
 *
 * Design goal: works WITHOUT external AI keys (heuristic fallback, 0 cost).
 * If GEMINI_API_KEY or OPENAI_API_KEY is set, photo vision genuinely calls
 * the LLM to validate that the uploaded image shows the claimed electrical fault.
 *
 * @module services/aiTriage
 */
const fs = require('fs');
const path = require('path');
const stringSimilarity = require('string-similarity');

const Complaint = require('../models/Complaint');
const ComplaintCluster = require('../models/ComplaintCluster');
const Technician = require('../models/Technician');
const highLevelAI = require('./highLevelAI'); // Top-tier AI like Gemini 2.0 Flash / GPT-4o

// ── Gemini Semantic Helpers ─────────────────────────────────────

/** Cosine similarity for embeddings */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

/** Get Gemini text embedding (text-embedding-004). Returns float[] or null */
async function getGeminiEmbedding(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !text || !text.trim()) return null;
  const trimmed = text.slice(0, 900); // embedding limit safe
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'models/text-embedding-004',
        content: { parts: [{ text: trimmed }] },
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      console.warn(`[Gemini Embedding] ${res.status} ${txt.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    const values = data?.embedding?.values;
    if (Array.isArray(values) && values.length > 0) return values;
    return null;
  } catch (e) {
    console.warn('[Gemini Embedding] error', e.message);
    return null;
  }
}

/** Get OpenAI embedding fallback (text-embedding-3-small) */
async function getOpenAIEmbedding(text) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || !text || !text.trim()) return null;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 6000);
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text.slice(0, 900) }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const emb = data?.data?.[0]?.embedding;
    return Array.isArray(emb) ? emb : null;
  } catch (e) {
    console.warn('[OpenAI Embedding] error', e.message);
    return null;
  }
}

/** Unified semantic embedding — Gemini first, then OpenAI */
async function getSemanticEmbedding(text) {
  let emb = null;
  if (process.env.GEMINI_API_KEY) emb = await getGeminiEmbedding(text);
  if (!emb && process.env.OPENAI_API_KEY) emb = await getOpenAIEmbedding(text);
  return emb;
}

/**
 * Gemini LLM one-shot duplicate judge (when embeddings ambiguous or as cross-check)
 * Asks Gemini if two descriptions refer to same electrical fault.
 * Returns { isDuplicate: bool, confidence: 0-1 } or null on failure
 */
async function geminiDuplicateJudge(textA, textB, variant) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const prompt = `You are BijliSathi duplicate detector for KESCO Kanpur.
Question: Do these two citizen complaints describe the SAME electrical fault?
Complaint A (${variant}): "${textA.slice(0, 300)}"
Complaint B (${variant}): "${textB.slice(0, 300)}"
Consider: "no power" == "light not coming" == "bijli nahi aa rahi" are SAME. "voltage fluctuation" vs "transformer sparking" are DIFFERENT even nearby.
Return ONLY JSON: {"isDuplicate": true|false, "confidence": 0.0-1.0, "reason": "short"}`;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 7000);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.15, maxOutputTokens: 200 },
      }),
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return { isDuplicate: !!p.isDuplicate, confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.6)), reason: String(p.reason || '').slice(0, 120) };
  } catch (e) {
    console.warn('[Gemini Judge] error', e.message);
    return null;
  }
}

// ── Helpers ─────────────────────────────────────────────────────

/** Default safety precaution per fault type — used when AI doesn't provide one */
function defaultSafetyNote(variant, severity) {
  const base = {
    'transformer-fault': 'Stay at least 10 meters away from the transformer — do not touch wires or the transformer body. If sparking or burning smell continues, call 1912 immediately.',
    'broken-wire': 'Stay at least 3 meters away from any hanging or fallen wire — keep children and animals away. Never attempt to move it with hands or sticks.',
    'voltage-fluctuation': 'Switch off sensitive appliances (AC, fridge) and use a stabilizer. Do not touch switches with wet hands.',
    'no-power': 'Switch off heavy appliances at the mains to avoid surge damage when power returns. Keep children away from the meter box.',
    'streetlight': 'Avoid the dark stretch at night — report the exact pole number if visible. Not an immediate danger to your home.',
    'meter-fault': 'Do not open or bypass the meter — it is dangerous and illegal. Keep the meter area dry.',
  };
  return base[variant] || 'Stay away from damaged electrical equipment, keep the area dry, keep children away, and call 1912 for any emergency.';
}

/** Haversine distance in meters */
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function haversineKm(lat1, lng1, lat2, lng2) {
  return haversineMeters(lat1, lng1, lat2, lng2) / 1000;
}

// ── Photo Vision ────────────────────────────────────────────────

/**
 * Analyze a complaint photo to decide if it shows a genuine electrical fault.
 *
 * Priority chain:
 *  1. If GEMINI_API_KEY is set → call Gemini 1.5 Flash vision
 *  2. Else if OPENAI_API_KEY is set → call GPT-4o-mini vision
 *  3. Else → heuristic fallback (free, no API cost)
 *
 * Returns: { isRelevant: bool|null, confidence: 0-1, tags:[], reasoning:string, provider:string }
 */
async function analyzePhoto({ photoUrl, problemVariant, description }) {
  const fallback = () => heuristicPhotoAnalysis({ photoUrl, problemVariant, description });

  // No photo at all → heuristic immediately
  if (!photoUrl || photoUrl.trim() === '') {
    return {
      isRelevant: null, // unknown, no image
      confidence: 0.3,
      tags: ['no-photo'],
      reasoning: 'No photo was uploaded — genuineness reduced. Photo helps AI verify the fault is real.',
      provider: 'heuristic',
      analyzedAt: new Date(),
    };
  }

  // Resolve photoUrl to absolute for fetch (local /uploads needs handling)
  const isLocalUpload = photoUrl.startsWith('/uploads/');
  const isHttp = photoUrl.startsWith('http://') || photoUrl.startsWith('https://');

  // Try external AI providers if configured
  if (process.env.GEMINI_API_KEY) {
    try {
      const r = await analyzeWithGemini({ photoUrl, problemVariant, description, isLocalUpload });
      if (r) return r;
    } catch (e) {
      console.warn('[AI Photo] Gemini failed, fallback to heuristic:', e.message);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const r = await analyzeWithOpenAI({ photoUrl, problemVariant, description, isLocalUpload });
      if (r) return r;
    } catch (e) {
      console.warn('[AI Photo] OpenAI failed, fallback to heuristic:', e.message);
    }
  }
  // OpenRouter free tier — rotates :free vision models (e.g. Gemini/Qwen/Llama vision). Free key from openrouter.ai
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const r = await analyzeWithOpenRouter({ photoUrl, problemVariant, description });
      if (r) return r;
    } catch (e) {
      console.warn('[AI Photo] OpenRouter failed, fallback to heuristic:', e.message);
    }
  }
  // Cloudflare Workers AI — lifetime-free vision (@cf/meta/llama-3.2-11b-vision-instruct), 10k neurons/day
  if (process.env.CLOUDFLARE_AI_TOKEN && process.env.CLOUDFLARE_ACCOUNT_ID) {
    try {
      const r = await analyzeWithCloudflareVision({ photoUrl, problemVariant, description });
      if (r) return r;
    } catch (e) {
      console.warn('[AI Photo] Cloudflare failed, fallback to heuristic:', e.message);
    }
  }
  // User's own Groq key: virtual senior KESCO technician reasons over the report +
  // photo evidence metadata (pixel-level vision activates automatically once a
  // GEMINI_API_KEY / OPENAI_API_KEY is added above).
  if (process.env.GROQ_API_KEY) {
    try {
      const r = await analyzeWithGroqTechnician({ photoUrl, problemVariant, description });
      if (r) return r;
    } catch (e) {
      console.warn('[AI Photo] Groq technician failed, fallback to heuristic:', e.message);
    }
  }

  return fallback();
}

/**
 * OpenRouter vision — free tier `:free` multimodal models (OpenAI-compatible API).
 * Free key: https://openrouter.ai → Keys. Model IDs rotate; we try a candidate list.
 */
async function analyzeWithOpenRouter({ photoUrl, problemVariant, description }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

  // Build data-URL image (local file or remote fetch)
  let dataUrl = null;
  try {
    const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
    const filePath = path.join(uploadsDir, path.basename(photoUrl));
    if (fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
    } else if (/^https?:/i.test(photoUrl)) {
      const res = await fetch(photoUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const mime = res.headers.get('content-type') || 'image/jpeg';
        dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
      }
    }
  } catch {}
  if (!dataUrl) return null;

  const prompt = `You are BijliSathi's senior KESCO line engineer (25 years) for KESCO Kanpur — analyze this citizen's photo + written complaint TOGETHER, deeply and accurately.

Claimed fault: "${problemVariant}" — citizen wrote: "${(description || '').slice(0, 400)}"

Tasks — look at the IMAGE carefully:
1. Is the photo relevant to the claimed electrical fault? (transformer/wire/meter/pole/outage/sparking/streetlight vs tiger/animal/jeans/clothes/selfie/meme/blank/random indoor — tiger in jeans for voltage is NOT relevant, 100% false)
2. What is the TRUE fault you SEE? How SEVERE (low/medium/high/critical)?
3. What is the ONE safety precaution the citizen must take RIGHT NOW?
4. How many MINUTES will a skilled KESCO crew need (travel + repair) for THIS exact fault? Be realistic per class: streetlight 1440–2880, meter 180–480, voltage 120–360, no-power 60–240, broken-wire 90–240, transformer 240–720.

Return ONLY valid JSON, no other text:
{"isRelevant": true|false, "confidence": 0.0-1.0, "detectedFault": "max 8 words", "severity": "low|medium|high|critical", "reasoning": "exactly 3 sentences a senior technician would write", "safetyAdvice": "one action-verb sentence max 20 words", "estimatedMinutes": 95, "tags": ["max 3 technical tags"]}`;

  for (const model of ['dots-studio/dots-3-note-preview:free', 'google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free', 'minimax/minimax-m3:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free']) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'HTTP-Referer': 'https://bijlisathi.in', 'X-Title': 'BijliSathi Photo Triage' },
        body: JSON.stringify({
          model,
          max_tokens: 800,
          temperature: 0.2,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          }],
        }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      const msg = data?.choices?.[0]?.message || {};
      // Reasoning models (dots, etc.) put answer in reasoning; normal models in content
      let raw = msg.content || msg.reasoning || '';
      if (!raw && Array.isArray(msg.reasoning_details)) raw = msg.reasoning_details.map((r) => r.text || r.content || '').join('\n');
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const p = JSON.parse(m[0]);
      return {
        isRelevant: !!p.isRelevant,
        confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.6)),
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 4).map(String) : [],
        reasoning: String(p.reasoning || '').slice(0, 400),
        provider: `openrouter:${model.split('/').pop()}`,
        detectedFault: String(p.detectedFault || '').slice(0, 80),
        severity: ['low', 'medium', 'high', 'critical'].includes(p.severity) ? p.severity : undefined,
        safetyAdvice: String(p.safetyAdvice || '').slice(0, 200),
        estimatedMinutes: Number(p.estimatedMinutes) > 15 ? Math.round(Number(p.estimatedMinutes)) : undefined,
        analyzedAt: new Date(),
      };
    } catch {}
  }
  return null;
}

/**
 * Cloudflare Workers AI vision — genuinely free for life (10k neurons/day, no card).
 * Needs: CLOUDFLARE_AI_TOKEN (API token with Workers AI edit) + CLOUDFLARE_ACCOUNT_ID.
 * Model: @cf/meta/llama-3.2-11b-vision-instruct — real pixel-level photo inspection.
 */
async function analyzeWithCloudflareVision({ photoUrl, problemVariant, description }) {
  const token = process.env.CLOUDFLARE_AI_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  if (!token || !accountId) return null;

  let buf = null;
  let mime = 'image/jpeg';
  try {
    const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
    const filePath = path.join(uploadsDir, path.basename(photoUrl));
    if (fs.existsSync(filePath)) {
      buf = fs.readFileSync(filePath);
      const ext = path.extname(filePath).toLowerCase();
      mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    } else if (/^https?:/i.test(photoUrl)) {
      const res = await fetch(photoUrl);
      if (!res.ok) return null;
      buf = Buffer.from(await res.arrayBuffer());
      mime = res.headers.get('content-type') || 'image/jpeg';
    }
  } catch { return null; }
  if (!buf || !buf.length) return null;

  const dataUrl = `data:${mime};base64,${buf.toString('base64')}`;
  const prompt = `You are BijliSathi's photo inspector for KESCO Kanpur electricity faults.
Claimed fault type: "${problemVariant}" — citizen says: "${(description || '').slice(0, 400)}".
Does this image plausibly show the claimed electrical infrastructure issue (transformer, wire/cable, meter, power lines, dark outage scene, sparking, streetlight)? Unrelated photo (tiger/animal/jeans/clothes/selfie/meme/blank/random indoor) is NOT relevant — tiger in jeans for voltage is 100% false.
Reply ONLY with compact JSON and nothing else:
{"isRelevant": true|false, "confidence": 0.0-1.0, "tags": ["max3"], "reasoning": "one sentence"}`;

  // llama-3.2-11b-vision first; llava fallback
  const models = ['@cf/meta/llama-3.2-11b-vision-instruct', '@cf/llava-hf/llava-1.5-7b-hf'];
  for (const model of models) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 20000);
      const body = model.includes('llava')
        ? JSON.stringify({ prompt, image: [...buf] })
        : JSON.stringify({
            max_tokens: 300,
            temperature: 0.2,
            messages: [{
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: dataUrl } },
              ],
            }],
          });
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json().catch(() => ({}));
      const raw = String(data?.result?.response ?? data?.result?.description ?? '');
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) continue;
      const p = JSON.parse(m[0]);
      return {
        isRelevant: !!p.isRelevant,
        confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.6)),
        tags: Array.isArray(p.tags) ? p.tags.slice(0, 4).map(String) : [],
        reasoning: String(p.reasoning || '').slice(0, 320),
        provider: 'cloudflare-vision',
        analyzedAt: new Date(),
      };
    } catch {}
  }
  return null;
}

/**
 * Virtual KESCO line engineer — deep triage reasoning over the reported problem,
 * citizen description and photo evidence metadata. Produces the full technician
 * verdict: likely fault, severity, safety instruction, realistic repair time.
 */
async function analyzeWithGroqTechnician({ photoUrl, problemVariant, description }) {
  const { callLLM } = require('./chatAssistant');

  let photoMeta = 'no photo uploaded';
  try {
    const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
    const filePath = path.join(uploadsDir, path.basename(photoUrl));
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      photoMeta = `attached (${Math.round(stat.size / 1024)}KB ${path.extname(filePath) || 'image'} file, readable)`;
    } else if (/^https?:/i.test(photoUrl)) {
      photoMeta = 'attached (hosted image, e.g. Cloudinary)';
    } else {
      photoMeta = 'claimed attached but file missing';
    }
  } catch { photoMeta = 'attached'; }

  const llm = await callLLM({
    system: `You are a senior KESCO Kanpur line engineer with 25 years of field experience, acting as BijliSathi's triage brain. From the citizen's report you judge: how genuine the report is, the most likely exact fault, how severe it is, how long a skilled crew realistically needs (travel + repair), and the ONE most important safety step for the citizen RIGHT NOW. You reason deeply and thoroughly like a true field technician inspecting the site — note visual clues, cause, risk, and next action. Answer ONLY with compact JSON, no other text.`,
    user: `Analyze this reported electricity fault DEEPLY and ACCURATELY:
- Claimed problem: ${problemVariant}
- Citizen description: "${(description || '').slice(0, 400)}"
- Photo evidence: ${photoMeta}
- Context: Kanpur urban/residential distribution grid — monsoon, heat, and load matter.

Return ONLY JSON:
{"isRelevant": true|false|null,
 "confidence": 0.0-1.0,
 "detectedFault": "most likely specific fault in max 8 words (e.g. 'Broken LT wire near pole')",
 "severity": "low"|"medium"|"high"|"critical",
 "reasoning": "3 sentences a senior technician would write: 1) what is visible/likely, 2) why it matches/mismatches the claim, 3) risk and what crew will need to fix it",
 "safetyAdvice": "single most important safety instruction for the citizen now (max 20 words, start with action verb)",
 "estimatedMinutes": <realistic travel+repair minutes for THIS fault>,
 "tags": ["3 short lowercase technical tags like 'wire-sag', 'pole-damage', 'sparking'"]}

Rules: joke/unrelated/nonsense reports → isRelevant=false, confidence ≥0.75. Vague but plausible → isRelevant=null, confidence ~0.55. Genuine typical report → isRelevant=true, confidence 0.7–0.9. Realistic estimatedMinutes by class: streetlight 1440–2880, meter-fault 180–480, voltage-fluctuation 120–360, no-power 60–240, broken-wire 90–240, transformer-fault 240–720. For broken-wire specifically analyze: wire sag, pole lean, insulation burn, joint failure, clearance risk.`,
    maxTokens: 700,
  });

  if (!llm?.text) return null;
  try {
    const m = llm.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const p = JSON.parse(m[0]);
    return {
      isRelevant: typeof p.isRelevant === 'boolean' ? p.isRelevant : null,
      confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.6)),
      tags: Array.isArray(p.tags) ? p.tags.slice(0, 3).map(String) : [],
      reasoning: String(p.reasoning || '').slice(0, 300),
      provider: 'groq-technician',
      detectedFault: String(p.detectedFault || '').slice(0, 80),
      severity: ['low', 'medium', 'high', 'critical'].includes(p.severity) ? p.severity : undefined,
      safetyAdvice: String(p.safetyAdvice || '').slice(0, 200),
      estimatedMinutes: Number(p.estimatedMinutes) > 0 ? Math.round(Number(p.estimatedMinutes)) : undefined,
      analyzedAt: new Date(),
    };
  } catch { return null; }
}

function heuristicPhotoAnalysis({ photoUrl, problemVariant, description }) {
  // Heuristic: we can't see pixels without AI vision, so we score based on
  // metadata, file existence, and claimed variant. This still catches many fake cases:
  // - no photo → penalize
  // - photo present → reward, but tag as "heuristic-check"
  // - description + variant alignment → slight boost

  const tags = [];
  let isRelevant = true;
  let confidence = 0.65;
  let reasoning = '';

  // Immediate filename check: tiger/animal/jeans for voltage is definitely not a fault — flag as false without needing AI (covers tiger in jeans)
  if (photoUrl && /tiger|lion|cat|dog|animal|jeans|clothes|selfie|meme|person|face/i.test(String(photoUrl))) {
    isRelevant = false;
    confidence = 0.94;
    reasoning = 'Filename suggests non-electrical content (e.g., tiger/animal/jeans) — flagged as not relevant for electrical fault. Will go to false section.';
    tags.push('filename-tiger-flag');
  } else if (!photoUrl) {
    isRelevant = null;
    confidence = 0.3;
    reasoning = 'No photo provided.';
    tags.push('no-photo');
  } else if (photoUrl.startsWith('/uploads/')) {
  // Check local file exists and has reasonable size — heuristic is now conservative: without AI vision, we cannot verify a tiger vs transformer, so mark as unknown (null) not true
      try {
        const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
        const filePath = path.join(uploadsDir, path.basename(photoUrl));
        if (fs.existsSync(filePath)) {
          const stat = fs.statSync(filePath);
          const sizeKB = stat.size / 1024;
          tags.push(`size:${Math.round(sizeKB)}KB`);
          if (sizeKB < 5) {
            confidence = 0.45;
            reasoning = 'Photo file is extremely small (<5KB) — may be corrupted or placeholder. Flagged for KESCO review.';
            tags.push('tiny-file');
            isRelevant = null;
          } else if (sizeKB > 4000) {
            confidence = 0.55;
            tags.push('large-file');
            reasoning = 'Photo received (large file). Basic check completed — AI vision needed to verify it shows the claimed electrical fault.';
            isRelevant = null;
          } else {
            confidence = 0.58;
            reasoning = 'Photo received — heuristic cannot verify it shows the claimed electrical fault without AI vision; held as unverified.';
            tags.push('heuristic-unverified');
            isRelevant = null;
          }
          // Check extension
          const ext = path.extname(filePath).toLowerCase();
          if (!['.jpg', '.jpeg', '.png', '.webp', '.heic'].includes(ext)) {
            confidence -= 0.15;
            tags.push('uncommon-ext');
          }
        } else {
          confidence = 0.5;
          reasoning = 'Photo URL claims local file but file not found on server — may have been lost on redeploy (ephemeral). Recommend Cloudinary.';
          tags.push('missing-local');
          isRelevant = null;
        }
    } catch (e) {
      confidence = 0.55;
      tags.push('heuristic-error');
    }
  } else if (photoUrl.startsWith('http')) {
    tags.push('remote-photo');
    confidence = 0.68;
    reasoning = 'Remote photo URL present (Cloudinary/external). Heuristic check — external AI vision can verify content if API key is set.';
  }

  // Variant/description alignment boost (basic keyword check)
  if (description && problemVariant) {
    const d = description.toLowerCase();
    const variantKeywords = {
      'transformer-fault': ['transformer', 'spark', 'blast', 'burn', 'smoke'],
      'broken-wire': ['wire', 'cable', 'hanging', 'fallen', 'pole'],
      'voltage-fluctuation': ['voltage', 'fluctuat', 'low', 'high', 'flicker'],
      'no-power': ['power', 'outage', 'cut', 'no light', 'dark'],
      'streetlight': ['street', 'light', 'lamp'],
      'meter-fault': ['meter', 'reading', 'display'],
    };
    const kws = variantKeywords[problemVariant] || [];
    const hasKeyword = kws.some((kw) => d.includes(kw));
    if (hasKeyword) {
      confidence = Math.min(0.82, confidence + 0.08);
      tags.push('variant-aligned');
    } else if (d.length > 20) {
      tags.push('variant-neutral');
    }
  }

  confidence = Math.max(0, Math.min(1, Number(confidence.toFixed(2))));

  // isRelevant stays true for heuristic (we can't prove irrelevant without seeing image)
  // But if confidence <0.45 and we previously had a photo, mark as not relevant for scoring purposes
  // Keep null for no-photo / missing-local cases (unknown, not false)
  if (confidence < 0.45 && isRelevant !== null) isRelevant = false;

  return {
    isRelevant,
    confidence,
    tags,
    reasoning: reasoning || 'Basic photo check completed.',
    provider: 'heuristic',
    analyzedAt: new Date(),
  };
}

async function analyzeWithGemini({ photoUrl, problemVariant, description, isLocalUpload }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  // For local uploads we need to send base64 inline; for remote https we can send URL as inline
  let imagePart = null;
  const API_BASE = process.env.FRONTEND_URL?.split(',')[0] || process.env.BACKEND_URL || '';
  let fetchUrl = photoUrl;
  if (isLocalUpload && API_BASE) {
    // Try to construct absolute URL for local fetch
    fetchUrl = API_BASE.replace(/\/$/, '') + photoUrl;
  }

  // Try to fetch image bytes (for Gemini we need base64)
  let base64 = null;
  let mimeType = 'image/jpeg';
  if (photoUrl.startsWith('http') || (isLocalUpload && fetchUrl.startsWith('http'))) {
    try {
      const res = await fetch(fetchUrl);
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        base64 = buf.toString('base64');
        mimeType = res.headers.get('content-type') || 'image/jpeg';
      }
    } catch {}
  } else if (isLocalUpload) {
    try {
      const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
      const filePath = path.join(uploadsDir, path.basename(photoUrl));
      if (fs.existsSync(filePath)) {
        const buf = fs.readFileSync(filePath);
        base64 = buf.toString('base64');
        const ext = path.extname(filePath).toLowerCase();
        mimeType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      }
    } catch {}
  }

  if (!base64) {
    // Can't fetch bytes — fallback
    console.warn('[AI Photo] Gemini: could not fetch image bytes for', photoUrl);
    return null;
  }

  const prompt = `You are BijliSathi AI — validate if this citizen-uploaded photo shows a real electrical fault for KESCO Kanpur.
Claimed fault type: "${problemVariant}" — citizen says: "${(description || '').slice(0, 400)}".
  Question: Does this image plausibly show an electrical infrastructure issue (transformer, wire, meter, power lines, outage scene, sparking, streetlight, etc.) or is it unrelated (tiger/animal/jeans/clothes/selfie/meme/blank/indoor random/duplicate — tiger in jeans for voltage is 100% false)?
Return ONLY JSON: {"isRelevant": true|false, "confidence": 0.0-1.0, "tags": ["tag1"], "reasoning": "one sentence"}.
Be strict: unrelated/selfie/blank = isRelevant false, confidence 0.9. Genuine fault photo = true, confidence 0.8+. Unclear but possibly relevant = true, 0.55.`;

  // Try current Gemini model IDs in order (older ones get retired over time)
  for (const model of ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-flash-latest', 'gemini-1.5-flash']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const body = {
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { mimeType, data: base64 } },
            ],
          },
        ],
        generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
      };

      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      // extract JSON object from markdown fences if needed
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) continue;
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        isRelevant: !!parsed.isRelevant,
        confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0.6)),
        tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 6) : [],
        reasoning: String(parsed.reasoning || '').slice(0, 320),
        provider: `gemini:${model}`,
        analyzedAt: new Date(),
      };
    } catch {}
  }
  return null;
}

async function analyzeWithOpenAI({ photoUrl, problemVariant, description, isLocalUpload }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  // OpenAI vision needs a public https URL — local /uploads can't be fetched by OpenAI unless we host it
  // Fallback: if local, convert to base64 data URL
  let imageUrl = photoUrl;
  if (isLocalUpload) {
    const uploadsDir = process.env.VERCEL ? path.join('/tmp', 'uploads') : path.join(__dirname, '..', 'uploads');
    const filePath = path.join(uploadsDir, path.basename(photoUrl));
    if (fs.existsSync(filePath)) {
      const buf = fs.readFileSync(filePath);
      const b64 = buf.toString('base64');
      const ext = path.extname(filePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      imageUrl = `data:${mime};base64,${b64}`;
    } else {
      return null;
    }
  } else if (!imageUrl.startsWith('http') && !imageUrl.startsWith('data:')) {
    // need absolute URL
    const base = (process.env.FRONTEND_URL || process.env.BACKEND_URL || '').split(',')[0];
    if (base) imageUrl = base.replace(/\/$/, '') + photoUrl;
    else return null;
  }

  const prompt = `Validate this citizen complaint photo for KESCO Kanpur. Claimed fault: "${problemVariant}". Description: "${(description || '').slice(0, 400)}". Is this a genuine electrical fault photo? Return JSON only: {"isRelevant": bool, "confidence": 0-1, "tags": [], "reasoning": ""}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 300,
      temperature: 0.2,
      messages: [
        { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl, detail: 'low' } }] },
      ],
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`OpenAI ${res.status}: ${txt.slice(0, 300)}`);
  }
  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('OpenAI no JSON');
  const p = JSON.parse(m[0]);
  return {
    isRelevant: !!p.isRelevant,
    confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0.6)),
    tags: Array.isArray(p.tags) ? p.tags.slice(0, 6) : [],
    reasoning: String(p.reasoning || '').slice(0, 320),
    provider: 'openai',
    analyzedAt: new Date(),
  };
}

// ── Genuineness (fake detection) ─────────────────────────────────

const VARIANT_TEXT_KEYWORDS = {
  'transformer-fault': ['transformer', 'transformar', 'spark', 'blast', 'dhamaka', 'aag', 'fire', 'smoke', 'dhua', 'jal raha', 'burning', 'sound', 'awaz'],
  'broken-wire': ['wire', 'taar', 'tar', 'cable', 'hanging', 'latak', 'toota', 'tuta', 'gira', 'fallen', 'break', 'joint', 'pole se'],
  'meter-fault': ['meter', 'reading', 'bill', 'fast', 'slow', 'tez', 'jal gaya', 'burnt', 'display'],
  'no-power': ['power', 'bijli', 'light', 'current', 'outage', 'cut', 'gul', 'nahi aa', 'nahin aa', 'chali gayi', 'supply'],
  'voltage-fluctuation': ['voltage', 'fluctuation', 'low', 'high', 'kam', 'zyada', 'jyada', 'dim', 'flicker', 'jal-bujh', 'up-down', 'stabiliser'],
  'streetlight': ['streetlight', 'street light', 'street', 'khamba', 'pole light', 'road light', 'andhera', 'dark'],
};
const GENERIC_ELECTRIC_KEYWORDS = ['bijli', 'current', 'light', 'wire', 'transformer', 'meter', 'voltage', 'power', 'kesco', 'lineman', 'khamba', 'pole', 'shock', 'short', 'circuit', 'supply', 'phase', 'neutral', 'spark', 'outage'];

function calculateGenuinenessEnhanced({ description, photoUrl, location, photoAnalysis, problemVariant }) {
  let score = 0.7; // base
  const tags = [];
  let textBad = false;

  if (!photoUrl || photoUrl === '') {
    score -= 0.15;
    tags.push('no-photo');
  } else {
    // Only give +0.1 if AI verified the photo actually shows the fault — heuristic unverified gets no boost
    const isHeuristicUnverified = photoAnalysis && photoAnalysis.provider === 'heuristic' && photoAnalysis.isRelevant === null;
    if (!isHeuristicUnverified) score += 0.1;
    else tags.push('heuristic-no-boost');
  }

  // Photo vision boost/penalty (strong signal)
  if (photoAnalysis) {
    if (photoAnalysis.isRelevant === true) {
      score += 0.12 * (photoAnalysis.confidence || 0.7);
      if (photoAnalysis.confidence > 0.75) tags.push('photo-verified');
    } else if (photoAnalysis.isRelevant === false) {
      // Fake/spam photo → strong penalty (tiger for voltage should hit this)
      const pen = 0.45 * (photoAnalysis.confidence || 0.8);
      score -= pen;
      tags.push('photo-irrelevant');
    } else if (photoAnalysis.isRelevant === null) {
      // heuristic unverified or no-photo — be lenient so genuine complaints without photo still get ETA and correct genuineness
      const isHeuristic = photoAnalysis.provider === 'heuristic';
      if (!photoUrl || photoUrl === '') {
        // No photo: small penalty, still genuine if description good
        score -= 0.06;
        tags.push('no-photo-unverified');
      } else {
        score -= isHeuristic ? 0.15 : 0.05;
        tags.push(isHeuristic ? 'heuristic-unverified' : 'unknown-photo');
      }
    }
  }

  // Extra check: if photo filename suggests non-electrical content (tiger, animal, selfie), flag
  if (photoUrl && /tiger|lion|cat|dog|animal|selfie|meme|person|face/i.test(String(photoUrl))) {
    score -= 0.3;
    tags.push('filename-irrelevant');
  }

  if (!location || !location.coordinates || location.coordinates.length !== 2) score -= 0.2;
  else score += 0.1;

  if (!description || description.trim().length < 10) { score -= 0.15; textBad = true; tags.push('text-too-short'); }
  if (description && description.trim().length > 30) score += 0.1;

  if (description) {
    const alphanum = (description.match(/[a-zA-Z0-9]/g) || []).length;
    const ratio = alphanum / description.length;
    if (ratio < 0.5) { score -= 0.3; textBad = true; tags.push('text-gibberish'); }
    if (/(.)\1{5,}/.test(description)) { score -= 0.2; textBad = true; }
    // AI-like spam phrases
    if (/test|asdf|qwerty|hello world|fake complaint/i.test(description)) {
      score -= 0.25;
      textBad = true;
      tags.push('spam-phrase');
    }
    // Deep text check: description must relate to the chosen problem (or electricity at all)
    const dl = description.toLowerCase();
    if (dl.trim().length >= 10) {
      const variantKws = VARIANT_TEXT_KEYWORDS[problemVariant] || [];
      const related = variantKws.some((k) => dl.includes(k)) || GENERIC_ELECTRIC_KEYWORDS.some((k) => dl.includes(k));
      if (!related) {
        score -= 0.3;
        textBad = true;
        tags.push('text-unrelated-to-variant');
      }
      // Deep detail check: genuine reports usually carry specifics — numbers
      // (pole/house no.), landmarks, and time context. Reward detail richness.
      let detailHits = 0;
      if (/\d/.test(dl)) detailHits++;
      if (/(near|opposite|behind|front|beside|paas|saamne|peeche|mandir|masjid|school|college|hospital|shop|dukaan|market|bazaar|chowk|chauraha|gali|mohalla|colony|park|station|bridge|pul)/.test(dl)) detailHits++;
      if (/(morning|evening|night|afternoon|since|yesterday|today|kal|aaj|subah|shaam|raat|hour|ghante|minute|days|din se)/.test(dl)) detailHits++;
      if (dl.trim().length > 60) detailHits++;
      if (detailHits >= 2) { score += 0.06; tags.push('text-detailed'); }
    }
  } else {
    textBad = true;
  }

  // Combined text + image verdict: fake text AND fake image together = false complaint.
  // (Photo-false alone at high confidence also caps below the 0.4 false line.)
  const photoFalse = photoAnalysis && photoAnalysis.isRelevant === false;
  const photoConf = (photoAnalysis && photoAnalysis.confidence) || 0.8;
  if (photoFalse && photoConf >= 0.7) {
    score = Math.min(score, 0.38);
    tags.push('photo-false-confident');
  }
  if (photoFalse && textBad) {
    score = Math.min(score, 0.3);
    tags.push('text-image-mismatch-false');
  }

  // No evidence rule: NO photo + NO description → neutral 0.50, NOT false.
  // Missing evidence is not proof of a fake report — only actually-wrong
  // content (irrelevant photo, gibberish/unrelated text) pulls below the
  // 0.4 false line via the penalties above.
  const hasPhotoEvidence = !!(photoUrl && String(photoUrl).trim() !== '');
  const hasTextEvidence = !!(description && String(description).trim() !== '');
  if (!hasPhotoEvidence && !hasTextEvidence) {
    score = Math.max(score, 0.5);
    tags.push('no-evidence-neutral');
  }

  return { score: Math.max(0, Math.min(1, Number(score.toFixed(2)))), tags };
}

// ── Urgency ──────────────────────────────────────────────────────

function calculateUrgency(problemVariant, clusterSize = 1, genuinenessScore = 0.7) {
  const weights = {
    'transformer-fault': 5,
    'broken-wire': 4,
    'no-power': 3,
    'voltage-fluctuation': 2,
    'streetlight': 1,
    'meter-fault': 2,
    'billing': 0,
    'other': 1,
  };
  let score = weights[problemVariant] ?? 1;
  if (clusterSize > 3) score += 3;
  else if (clusterSize > 1) score += 2;
  if (genuinenessScore < 0.3) score = Math.max(0, score - 2);
  if (genuinenessScore > 0.8) score += 1;
  return Math.min(10, Math.max(0, score));
}

// ── ETA Prediction ───────────────────────────────────────────────

/**
 * Most-Accurate Repair Estimate — deeply photo-aware.
 * Photo's severity, detected fault, and the technician's own minute-estimate are
 * blended with distance/load so a sparking transformer seen in the photo is
 * not timed like a streetlight.
 * Returns { etaMinutes, estimatedAt, label, reasoning }
 */
function estimateResolution({ problemVariant, urgencyScore, clusterSize = 1, distanceKm = null, techLoad = 0, genuinenessScore = 0.7, severity = 'medium', photoEstimatedMins = null, detectedFault = null, createdAt = new Date() }) {
  const base = {
    'transformer-fault': 150, // minutes
    'broken-wire': 110,
    'no-power': 85,
    'voltage-fluctuation': 70,
    'meter-fault': 60,
    'streetlight': 45,
    'billing': 30,
    'other': 60,
  };
  // If the photo-deep analysis already estimated repair time, blend it 60/40 with the fault-class base — photo wins.
  let mins = base[problemVariant] ?? 65;
  if (photoEstimatedMins && photoEstimatedMins > 15 && photoEstimatedMins < 3000) {
    mins = Math.round(photoEstimatedMins * 0.6 + mins * 0.4);
  }
  if (detectedFault && detectedFault !== problemVariant) {
    // Photo found a different specific fault — nudge toward that fault's base
    const altBase = base[detectedFault];
    if (altBase) mins = Math.round(mins * 0.7 + altBase * 0.3);
  }

  // Photo-verified severity adjusts base time (critical transformer/broken wire takes longer)
  if (severity === 'critical') mins = Math.round(mins * 1.25);
  else if (severity === 'high') mins = Math.round(mins * 1.1);
  else if (severity === 'low') mins = Math.round(mins * 0.85);

  // Cluster size: more reports = higher priority but also may mean larger outage → + time
  if (clusterSize > 5) mins += 30;
  else if (clusterSize > 2) mins += 15;

  // Travel time: ~3 min per km at ~20km/h urban average
  if (typeof distanceKm === 'number' && !isNaN(distanceKm)) {
    mins += Math.round(distanceKm * 3.2);
  } else {
    mins += 12; // default travel buffer
  }

  // Technician workload
  mins += techLoad * 8;

  // Urgency inverse: highly urgent gets faster (dispatch priority)
  if (urgencyScore >= 6) mins = Math.round(mins * 0.88);
  else if (urgencyScore <= 2) mins = Math.round(mins * 1.12);

  // Fake → deprioritized, but still estimate (KESCO review queue)
  if (genuinenessScore < 0.3) mins = Math.round(mins * 1.35);

  mins = Math.max(20, Math.min(480, mins)); // clamp 20m – 8h

  const estimatedAt = new Date(createdAt.getTime() + mins * 60000);

  // Human label
  let label;
  if (mins < 60) label = `~${mins} mins`;
  else if (mins < 120) label = `~${Math.round(mins / 60)} hour${Math.round(mins / 60) > 1 ? 's' : ''}`;
  else label = `~${Math.floor(mins / 60)}–${Math.ceil(mins / 60)} hours`;

  const reasoning = `Deep photo analysis: ${severity} severity${detectedFault ? ` (${detectedFault})` : ''}${photoEstimatedMins ? ` • technician estimated ${photoEstimatedMins}m` : ''} → base ${base[problemVariant] ?? 65}m + ${distanceKm != null ? `${Math.round(distanceKm * 3.2)}m travel (${distanceKm.toFixed(1)}km)` : '12m travel'} + ${clusterSize} reports + urgency ${urgencyScore}/10`;

  return { etaMinutes: mins, estimatedAt, label, reasoning };
}

// ── Nearest Technician ───────────────────────────────────────────

async function findNearestTechnician(complaintCoordinates) {
  // Delegates to the live active-count rule: only zero-active-job technicians
  // are candidates, nearest first. Never trusts the status flag.
  if (!complaintCoordinates || complaintCoordinates.length !== 2) return { technician: null, distanceKm: null };
  try {
    const recs = await recommendTechnicians(complaintCoordinates, { limit: 1 });
    if (!recs.length) return { technician: null, distanceKm: null };
    const r = recs[0];
    let technician = null;
    try { technician = await Technician.findById(r._id); } catch {}
    return { technician: technician || r, distanceKm: r.distanceKm };
  } catch (e) {
    console.warn('[AI] findNearestTechnician error', e.message);
    return { technician: null, distanceKm: null };
  }
}

/**
 * Ranked AI shortlist for the KESCO Commander — who can take this job.
 * Availability first, then closeness to the fault, with a workload penalty.
 * Returns the top N candidates with distance, live status and active jobs.
 */
async function recommendTechnicians(complaintCoordinates, { limit = 4 } = {}) {
  if (!complaintCoordinates || complaintCoordinates.length !== 2) return [];
  const [lng, lat] = complaintCoordinates;
  try {
    // KESCO rule: only a WORKING job (accepted by the technician himself) makes
    // him busy. KESCO-assigned but not-yet-accepted jobs do NOT count — until
    // he taps Accept himself he is still free and suggestible. After Resolve he
    // is free again. Counts are computed live so stale flags self-heal.
    const techs = await Technician.find({ status: { $ne: 'offline' } }).limit(60);
    if (!techs.length) return [];

    const scored = [];
    for (const t of techs) {
      const ids = Array.isArray(t.assignedComplaints) ? t.assignedComplaints : [];
      let active = 0;
      if (ids.length) {
        try { active = await Complaint.countDocuments({ _id: { $in: ids }, status: 'working' }); } catch {}
      }
      // Heal stale status flag against reality
      const shouldBe = active > 0 ? 'on-task' : 'available';
      if (t.status !== shouldBe) {
        try { await Technician.findByIdAndUpdate(t._id, { status: shouldBe }); } catch {}
        t.status = shouldBe;
      }
      if (active > 0) continue; // busy — never suggested, however near
      const coords = t.currentLocation?.coordinates;
      const load = Array.isArray(t.assignedComplaints) ? t.assignedComplaints.length : 0;
      let d = null;
      let score = 0;
      if (coords && coords.length === 2 && typeof coords[1] === 'number' && typeof coords[0] === 'number') {
        d = haversineKm(lat, lng, coords[1], coords[0]);
        score = Math.round((100 - d * 8 - load * 6) * 10) / 10;
      } else {
        // No GPS — rank by lightest load only
        d = null;
        score = Math.round((40 - load * 6) * 10) / 10;
      }
      scored.push({
        _id: t._id,
        name: t.name || t.technicianId,
        technicianId: t.technicianId,
        phone: t.phone || '',
        status: t.status || 'available',
        distanceKm: d != null ? Number(d.toFixed(2)) : null,
        activeJobs: 0,
        score,
        reason: d != null
          ? `Free • ${d.toFixed(1)} km from fault • 0 active jobs`
          : `Free • no live GPS • 0 active jobs`,
      });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  } catch (e) {
    console.warn('[AI] recommendTechnicians error', e.message);
    return [];
  }
}

// ── AI recommendation to KESCO Commander ─────────────────────────
// Citizen reports NEVER go directly to technicians. The AI finds the
// nearest technician to the fault and recommends them to the Commander;
// the task is only dispatched after the Commander assigns it.

async function autoAssignIfGenuine(complaint, { distanceKm, photoAnalysis, genuinenessScore }) {
  // No recommendation for duplicates or fakes
  if (complaint.isDuplicateOf) {
    return { assigned: false, recommended: false, reason: 'duplicate — merged into cluster' };
  }
  if (genuinenessScore < 0.4) {
    return { assigned: false, recommended: false, reason: `low genuineness (${genuinenessScore}) — held for KESCO review (possible fake)` };
  }
  if (photoAnalysis && photoAnalysis.isRelevant === false && photoAnalysis.confidence > 0.7) {
    return { assigned: false, recommended: false, reason: 'photo irrelevant — flagged as likely fake, held for review' };
  }

  // Genuine + unique → AI recommends the NEAREST technician to the Commander
  const { technician, distanceKm: dist } = await findNearestTechnician(complaint.location.coordinates);
  if (!technician) {
    return { assigned: false, recommended: false, reason: 'no technicians available — queued for KESCO dispatcher' };
  }

  const finalDistance = dist ?? distanceKm;

  // Store the recommendation — status stays 'registered' until the Commander assigns
  complaint.recommendedTechnicianId = technician._id;
  complaint.recommendedDistanceKm = finalDistance ?? null;
  complaint.recommendedAt = new Date();
  await complaint.save();

  return {
    assigned: false,
    recommended: true,
    technician: { _id: technician._id, name: technician.name, technicianId: technician.technicianId },
    distanceKm: finalDistance,
    reason: `AI recommended nearest technician to KESCO Commander (${finalDistance != null ? finalDistance.toFixed(1) + 'km away' : 'nearest available'}) — awaiting Commander approval`,
  };
}

// ── Main Triage Orchestrator ─────────────────────────────────────

async function performEnhancedTriage(complaint, initialGenuinenessScore = null, io = null) {
  const start = Date.now();
  const coords = complaint.location?.coordinates;
  const [lng, lat] = coords || [null, null];

  // 1) High-Level Photo Vision with Top AI (Gemini 2.0 Flash / GPT-4o / High-Level Heuristic)
  let photoAnalysis = null;
  let highLevelResult = null;
  try {
    // Try top-tier AI first
    highLevelResult = await highLevelAI.deepAnalyzeIncident({
      photoUrl: complaint.photoUrl,
      problemVariant: complaint.problemVariant,
      description: complaint.description,
    });
    // Convert high-level result to photoAnalysis format for backward compat
    photoAnalysis = {
      isRelevant: highLevelResult.isRelevant,
      confidence: highLevelResult.confidence,
      tags: highLevelResult.tags,
      reasoning: highLevelResult.reasoning,
      provider: highLevelResult.provider,
      analyzedAt: new Date(),
      // High-level extras
      severity: highLevelResult.severity,
      detectedFault: highLevelResult.detectedFault,
      safetyAdvice: highLevelResult.safetyAdvice,
      estimatedMinutes: highLevelResult.estimatedMinutes,
      urgency: highLevelResult.urgency,
      model: highLevelResult.model,
      level: highLevelResult.level,
    };
    console.log(`[HighAI] ${highLevelResult.model} ${highLevelResult.severity} ${highLevelResult.confidence}`);
  } catch (e) {
    console.warn('[HighAI] deep analysis error, fallback to heuristic:', e.message);
    try {
      photoAnalysis = await analyzePhoto({
        photoUrl: complaint.photoUrl,
        problemVariant: complaint.problemVariant,
        description: complaint.description,
      });
    } catch (e2) {
      photoAnalysis = {
        isRelevant: null,
        confidence: 0.5,
        tags: ['error'],
        reasoning: 'Photo analysis failed — fallback.',
        provider: 'heuristic',
        analyzedAt: new Date(),
      };
    }
  }

  // CRITICAL: Deep analysis of BOTH photo and citizen's written problem is now complete.
  // Ensure the AI verdict is never missing its core fields — this drives proper ETA and precaution.
  if (photoAnalysis) {
    if (!photoAnalysis.severity) photoAnalysis.severity = highLevelResult?.severity || 'medium';
    if (!photoAnalysis.safetyAdvice) photoAnalysis.safetyAdvice = defaultSafetyNote(complaint.problemVariant, photoAnalysis.severity);
    if (!photoAnalysis.detectedFault) photoAnalysis.detectedFault = complaint.problemVariant;
  }

  // 2) Enhanced genuineness (re-score with vision + deep text-vs-variant check)
  const { score: genuinenessScore, tags: genuinenessTags } = calculateGenuinenessEnhanced({
    description: complaint.description,
    photoUrl: complaint.photoUrl,
    location: complaint.location,
    photoAnalysis,
    problemVariant: complaint.problemVariant,
  });
  if (complaint.aiPhotoAnalysis && genuinenessTags) complaint.aiPhotoAnalysis.genuinenessTags = genuinenessTags;

  // 3) Duplicate detection (geo + string + Gemini semantic) — reuse improved clustering
  const { cluster, duplicateConfidence, nearbyCount, maxSimilarity, maxSemantic, semanticProvider, geminiJudgeResult } = await detectDuplicateCluster(complaint);

  if (cluster) {
    complaint.isDuplicateOf = cluster._id;
    complaint.duplicateConfidence = duplicateConfidence;
  } else {
    complaint.isDuplicateOf = null;
    complaint.duplicateConfidence = duplicateConfidence ?? 0;
  }

  // 4) Urgency
  const clusterSize = cluster ? cluster.reportCount : nearbyCount + 1;
  const urgencyScore = calculateUrgency(complaint.problemVariant, clusterSize, genuinenessScore);

  // 5) ETA — REMOVED: AI does NOT estimate or suggest any fix time.
  // The KESCO controller assigns the technician; the technician reads the
  // complaint description + photo, then sets the ETA for the citizen on accept.
  let etaResult = null;
  // False complaints get NO fix-time estimate anywhere — held for KESCO verification only.
  const isFakeComplaint = genuinenessScore < 0.4;

  // 6) Persist AI results (high-level)
  complaint.genuinenessScore = genuinenessScore;
  complaint.urgencyScore = highLevelResult?.urgency ?? urgencyScore;
  // ETA deliberately NOT set here — the technician sets it on accept. Keep any
  // previously-stored tech ETA intact.
  complaint.aiPhotoAnalysis = {
    isRelevant: photoAnalysis.isRelevant,
    confidence: photoAnalysis.confidence,
    tags: photoAnalysis.tags,
    reasoning: photoAnalysis.reasoning,
    provider: photoAnalysis.provider,
    analyzedAt: photoAnalysis.analyzedAt,
    // High-level extras from Gemini 2.0 / GPT-4o
    severity: photoAnalysis.severity || highLevelResult?.severity || 'medium',
    detectedFault: photoAnalysis.detectedFault || highLevelResult?.detectedFault || complaint.problemVariant,
    safetyAdvice: photoAnalysis.safetyAdvice || highLevelResult?.safetyAdvice || 'Stay safe',
    estimatedMinutes: photoAnalysis.estimatedMinutes || highLevelResult?.estimatedMinutes || etaResult?.etaMinutes,
    model: photoAnalysis.model || highLevelResult?.model || 'heuristic',
    level: photoAnalysis.level || highLevelResult?.level || 'heuristic',
  };
  complaint.aiProcessed = true;
  complaint.duplicateConfidence = duplicateConfidence ?? null;
  complaint.duplicateSemantic = {
    maxSimilarity: maxSimilarity ?? null,
    maxSemantic: maxSemantic ?? null,
    semanticProvider: semanticProvider || null,
    geminiJudgeResult: geminiJudgeResult || null,
  };
  await complaint.save();

  // 7) Assignment — REMOVED: AI does NOT recommend or auto-assign a technician.
  // The KESCO controller reviews genuineness/photo/duplicate info and manually
  // assigns the complaint (manual-override / assign-nearest). Assignment result
  // reported to the dashboard reflects that manual sourcing only.
  let assignment = { assigned: false, source: 'kesco-manual', reason: 'KESCO controller manually assigns technicians' };

  // 8) Notifications via Socket.IO — Gemini semantic included for Commander
  if (io) {
    try {
      const payload = {
        complaintId: complaint._id,
        genuinenessScore,
        urgencyScore,
        etaMinutes: complaint.techEtaMinutes ?? null,
        estimatedResolutionAt: complaint.estimatedResolutionAt ?? null,
        photoAnalysis: { isRelevant: photoAnalysis.isRelevant, confidence: photoAnalysis.confidence, provider: photoAnalysis.provider },
        isDuplicate: !!complaint.isDuplicateOf,
        duplicateConfidence,
        duplicateSemantic: { maxSimilarity, maxSemantic, semanticProvider, geminiJudgeResult },
        assignment,
        aiReasoning: photoAnalysis.reasoning,
      };
      // Citizen: targeted + global
      io.to(complaint._id.toString()).emit('ai-triage-complete', payload);
      io.emit('ai-triage-complete', payload); // for dashboards that aren't in room yet

      if (complaint.isDuplicateOf) {
        io.emit('duplicate-detected', { complaintId: complaint._id, clusterId: complaint.isDuplicateOf, confidence: duplicateConfidence, semantic: { maxSemantic, maxSimilarity, provider: semanticProvider } });
      }
      if (genuinenessScore < 0.4 || (photoAnalysis.isRelevant === false && photoAnalysis.confidence > 0.6)) {
        io.emit('false-complaint-flagged', { complaintId: complaint._id, genuinenessScore, photoAnalysis });
      }
      // ETA is set by the technician on accept (/api/technician/accept-task) — the
      // AI never emits an eta-estimated event at triage time.
    } catch (e) {
      console.warn('[AI] socket emit error', e.message);
    }
  }

// ── 9) Citizen notification: registration-confirmation email (no ETA — the
  // technician sets the ETA on accept; no OTP — complaint OTPs removed).
  try {
    const notificationService = require('./notificationService');
    notificationService.notifyCitizenETA({ complaint, aiResult: { eta: { etaMinutes: complaint.techEtaMinutes, label: complaint.techEtaLabel, estimatedAt: complaint.estimatedResolutionAt }, photoAnalysis, assignment, duplicateConfidence }, io })
      .then((r) => console.log(`[AI Notify] ${complaint._id} email=${r.delivered ? 'sent via ' + r.via : 'logged'} provider=${r.provider}`))
      .catch((e) => console.warn('[AI Notify] failed', e.message));
  } catch (e) {
    console.warn('[AI Notify] require error', e.message);
  }

  const durationMs = Date.now() - start;
  console.log(`[AI Triage] ${complaint._id} → genuine=${genuinenessScore} urgency=${urgencyScore} dup=${!!complaint.isDuplicateOf}(${duplicateConfidence} via ${semanticProvider} str:${maxSimilarity?.toFixed(2)} sem:${maxSemantic?.toFixed(2)}) photo=${photoAnalysis.provider}:${photoAnalysis.confidence} ${durationMs}ms — ETA set by technician on accept`);

  return {
    complaint,
    cluster,
    photoAnalysis,
    genuinenessScore,
    urgencyScore,
    eta: etaResult,
    assignment,
    duplicateConfidence,
    duplicateSemantic: { maxSimilarity, maxSemantic, semanticProvider, geminiJudgeResult },
    durationMs,
  };
}

// Extracted duplicate logic (improved from routes/complaint.js)
async function detectDuplicateCluster(complaint) {
  const radiusMeters = 500; // same issue + same location within 500m = one cluster job
  const timeWindowHours = 2.5;

  let cluster = null;
  let nearbyComplaints = [];
  let duplicateConfidence = 0;

  try {
    nearbyComplaints = await Complaint.find({
      _id: { $ne: complaint._id },
      problemVariant: complaint.problemVariant,
      status: { $in: ['registered', 'working'] },
      location: {
        $near: {
          $geometry: { type: 'Point', coordinates: complaint.location.coordinates },
          $maxDistance: radiusMeters,
        },
      },
      createdAt: { $gte: new Date(Date.now() - timeWindowHours * 60 * 60 * 1000) },
    }).limit(50);
  } catch (geoErr) {
    console.warn('Geo query failed (index may be missing):', geoErr.message);
    nearbyComplaints = [];
  }

  // ── Text similarity: string + Gemini semantic embedding ──
  let textMatchCount = 0;
  let maxSimilarity = 0;
  let maxSemantic = 0;
  let semanticMatchCount = 0;
  let semanticProvider = 'string-similarity';
  let geminiJudgeResult = null;

  if (nearbyComplaints.length > 0) {
    const text = (complaint.description || '').toLowerCase().trim();
    if (text.length > 5) {
      nearbyComplaints.forEach((c) => {
        if (c.description && c.description.trim().length > 5) {
          const sim = stringSimilarity.compareTwoStrings(text, c.description.toLowerCase());
          if (sim > maxSimilarity) maxSimilarity = sim;
          if (sim > 0.58) textMatchCount++;
        }
      });
    }

    // Gemini semantic embedding (when key set) — understands "no power" == "bijli nahi aa rahi"
    const hasSemanticKey = !!(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
    if (hasSemanticKey && text.length > 5) {
      try {
        // Build semantic text as "variant + description" so "transformer sparking" context is encoded
        const newText = `${complaint.problemVariant} ${complaint.description || ''}`.trim();
        const newEmb = await getSemanticEmbedding(newText);
        if (newEmb) {
          // Embed nearby in parallel (limit 8 most recent to control cost/latency)
          const toEmbed = nearbyComplaints.slice(0, 8);
          const embs = await Promise.all(
            toEmbed.map(async (c) => {
              const t = `${c.problemVariant} ${c.description || ''}`.trim();
              const e = await getSemanticEmbedding(t);
              return { id: c._id, emb: e };
            })
          );
          for (const { emb } of embs) {
            if (!emb) continue;
            const cos = cosineSimilarity(newEmb, emb);
            if (cos > maxSemantic) maxSemantic = cos;
            if (cos > 0.78) semanticMatchCount++;
          }
          if (maxSemantic > 0) semanticProvider = process.env.GEMINI_API_KEY ? 'gemini-embedding' : 'openai-embedding';
          // If semantic high but string low, still count as text match (Hindi/English paraphrase)
          if (maxSemantic > 0.78 && textMatchCount === 0) {
            // Don't override textMatchCount but add semantic signal
          }
          // One-shot LLM judge for top candidate when string is ambiguous (0.35-0.58) but semantic moderate
          if (nearbyComplaints[0] && maxSimilarity > 0.25 && maxSimilarity < 0.65 && maxSemantic > 0.55 && maxSemantic < 0.85) {
            const top = nearbyComplaints[0];
            geminiJudgeResult = await geminiDuplicateJudge(newText, `${top.problemVariant} ${top.description || ''}`, complaint.problemVariant);
            if (geminiJudgeResult && geminiJudgeResult.isDuplicate) {
              maxSemantic = Math.max(maxSemantic, geminiJudgeResult.confidence);
              semanticMatchCount = Math.max(semanticMatchCount, 1);
              semanticProvider = 'gemini-judge';
            }
          }
        }
      } catch (e) {
        console.warn('[Duplicate] semantic error', e.message);
      }
    }
  }

  // Confidence: geo density base + best of string vs semantic
  if (nearbyComplaints.length > 0) {
    let conf = 0.45 + Math.min(0.35, nearbyComplaints.length * 0.12);
    const bestSim = Math.max(maxSimilarity, maxSemantic);
    const hasTextSignal = textMatchCount >= 1 || semanticMatchCount >= 1;
    if (hasTextSignal) conf += 0.15;
    if (bestSim > 0.72) conf += 0.10;
    if (maxSemantic > 0.82) conf += 0.07; // extra boost for strong semantic paraphrase (Hindi/English)
    if (geminiJudgeResult?.isDuplicate) conf += 0.05;
    duplicateConfidence = Math.min(0.97, Number(conf.toFixed(2)));
  } else {
    duplicateConfidence = 0;
  }

  // RELAXED duplicate rule: geo + same variant + time window is enough for KESCO's colony-level deduplication
  // Text similarity only boosts confidence, not gates clustering (matches instruction: 50 people same colony transformer = same fault)
  const shouldCluster = nearbyComplaints.length >= 1;

  if (shouldCluster) {
    const nearbyIds = nearbyComplaints.map((c) => c._id);
    let existingCluster = await ComplaintCluster.findOne({
      memberComplaintIds: { $in: nearbyIds },
      problemVariant: complaint.problemVariant,
      status: 'active',
    });

    if (existingCluster) {
      if (!existingCluster.memberComplaintIds.some((id) => id.equals(complaint._id))) {
        existingCluster.memberComplaintIds.push(complaint._id);
        existingCluster.reportCount = existingCluster.memberComplaintIds.length;
        const allCoords = [...nearbyComplaints.map((c) => c.location.coordinates), complaint.location.coordinates];
        const avgLng = allCoords.reduce((s, c) => s + c[0], 0) / allCoords.length;
        const avgLat = allCoords.reduce((s, c) => s + c[1], 0) / allCoords.length;
        existingCluster.locationCentroid = { type: 'Point', coordinates: [avgLng, avgLat] };
        await existingCluster.save();
      }
      cluster = existingCluster;
    } else {
      const allCoords = [...nearbyComplaints.map((c) => c.location.coordinates), complaint.location.coordinates];
      const avgLng = allCoords.reduce((s, c) => s + c[0], 0) / allCoords.length;
      const avgLat = allCoords.reduce((s, c) => s + c[1], 0) / allCoords.length;

      cluster = new ComplaintCluster({
        representativeComplaintId: nearbyComplaints[0] ? nearbyComplaints[0]._id : complaint._id,
        memberComplaintIds: [...nearbyIds, complaint._id],
        locationCentroid: { type: 'Point', coordinates: [avgLng, avgLat] },
        problemVariant: complaint.problemVariant,
        reportCount: nearbyIds.length + 1,
        status: 'active',
      });
      await cluster.save();

      await Complaint.updateMany({ _id: { $in: [...nearbyIds, complaint._id] } }, { isDuplicateOf: cluster._id });
    }
  }

  return { cluster, duplicateConfidence, nearbyCount: nearbyComplaints.length, nearbyComplaints, textMatchCount, maxSimilarity, maxSemantic, semanticMatchCount, semanticProvider, geminiJudgeResult };
}

module.exports = {
  analyzePhoto,
  heuristicPhotoAnalysis,
  defaultSafetyNote,
  calculateGenuinenessEnhanced,
  calculateUrgency,
  estimateResolution,
  findNearestTechnician,
  recommendTechnicians,
  autoAssignIfGenuine,
  performEnhancedTriage,
  detectDuplicateCluster,
  haversineMeters,
  haversineKm,
  getSemanticEmbedding,
  getGeminiEmbedding,
  getOpenAIEmbedding,
  cosineSimilarity,
  geminiDuplicateJudge,
};
