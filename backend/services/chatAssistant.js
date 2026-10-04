/**
 * Sathi — BijliSathi's AI Assistant
 * Top-tier AI search engine architecture (how Gemini/ChatGPT/Perplexity do it):
 *
 *   LAYER 1 (Grounding): Gemini 2.0 Flash + Google Search tool (google_search grounding)
 *                        or OpenAI gpt-4o-search-preview (built-in web search)
 *   LAYER 2 (Clustering): keyless multi-source live search (DuckDuckGo x multi-query + Wikipedia)
 *                        -> sentence extraction -> dedupe -> relevance ranking -> cross-source
 *                        consensus = only accurate, agreed facts survive
 *   LAYER 3 (Synthesis): LLM composes a ChatGPT-style human answer from clustered facts;
 *                        keyless fallback weaves the top clustered sentences directly
 *
 * @module services/chatAssistant
 */

const Complaint = require('../models/Complaint');

// Sathi — exact-answer assistant: every reply directly answers the asked question, like the best AI assistants do.
const SYSTEM_PROMPT = `You are Sathi, the AI assistant inside the BijliSathi app (KESCO Kanpur electricity help).

CORE RULE — ANSWER EXACTLY WHAT WAS ASKED:
- Read the user's exact question plus the recent chat history (follow-ups like "it", "that", "aur batao" refer to the previous topic — resolve them, never ask the user to repeat).
- First 1-2 lines MUST be the direct, exact answer — no greeting filler, no generic intro, no repeating the question.
- Then, only if action is needed, give a short numbered plan (1. 2. 3.) with one concrete action per step, each with exact specifics (numbers, links, documents, timeframes).
- If the question is factual, answer factually and stop. If ambiguous, ask exactly ONE short clarifying question.
- Reply in the user's language: Hindi/Hinglish question → Hinglish answer; English question → simple English.
- Length: as long as needed for a complete exact answer, usually 60-200 words. Plain sentences and numbered steps only.
- Use ONLY the provided complaint/account facts for personal data — never invent IDs, phone numbers, ETAs, or URLs. Web results provided were fetched seconds ago: prefer facts multiple sources agree on.
- Domain: electricity, KESCO, bills, faults, safety, BijliSathi first; anything else, answer briefly and helpfully like a top assistant, then add one relevant power tip.
- Sign off as "— Sathi".
- Facts: helpline 1912 (24x7), 1800-180-1912, helpline@kesco.co.in, www.kesco.co.in, HQ: 14/71 Civil Lines, Kanpur 208001. Safety: never touch hanging/sparking wires, stay dry, call 1912.
- Current date: 2026.`;

/* ------------------------------------------------------------------ */
/* LAYER 1 — Google-grounded / search-native AI (how big companies do) */
/* ------------------------------------------------------------------ */

/** Gemini (current gen) with the official Google Search grounding tool; null on quota -> pipeline falls back to cluster+synthesize */
async function geminiGroundedAnswer(question) {
  if (!process.env.GEMINI_API_KEY) return null;
  for (const model of ['gemini-3.6-flash', 'gemini-flash-latest']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nAnswer this user question using Google Search. Question: "${question}"` }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
        }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join('\n');
      if (!text) continue;
      return {
        text: text.trim(),
        provider: 'Sathi AI',
      };
    } catch {}
  }
  return null;
}

/** OpenAI search-native model (how ChatGPT search works) */
async function openAISearchAnswer(question) {
  if (!process.env.OPENAI_API_KEY) return null;
  for (const model of ['gpt-4o-search-preview', 'gpt-4o-mini-search-preview']) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 15000);
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: `Search the web and answer accurately: "${question}"` },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text) return { text: text.trim(), provider: 'Sathi AI' };
    } catch {}
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* SATHI BRAIN — curated expert knowledge (instant, keyless, accurate) */
/* How top AIs stay accurate on a domain: verified facts first, web    */
/* only for anything beyond.                                           */
/* ------------------------------------------------------------------ */

const SATHI_KB = [
  {
    kws: ['helpline', 'helpline number', 'phone', 'contact', 'number', 'call', '1912', 'customer care'],
    hint: 'helpline',
    en: `KESCO's 24x7 helpline is **1912** (toll-free alternative: 1800-180-1912; office: 0512-2300000).\n\n• Email: helpline@kesco.co.in\n• HQ: Kesa House, 14/71 Civil Lines, Kanpur 208001\n• Website: www.kesco.co.in\n\nFor emergencies like sparking wires or transformer blasts, call 1912 immediately — and report it on BijliSathi so the nearest lineman is dispatched with live tracking. — Sathi`,
    hi: `KESCO ka 24x7 helpline number **1912** hai (toll-free: 1800-180-1912).\n\n• Email: helpline@kesco.co.in\n• HQ: Kesa House, 14/71 Civil Lines, Kanpur 208001\n• Website: www.kesco.co.in\n\nSparking ya transformer blast jaisi emergency mein turant 1912 call karein — aur BijliSathi par report karein taaki sabse paas ka lineman turant bhej jaaye. — Sathi`,
  },
  {
    kws: ['bill', 'payment', 'pay', 'bill pay', 'online payment', 'bill jama', 'bhugtan'],
    hint: 'billing',
    en: `Paying your KESCO bill takes 2 minutes:\n\n1. Go to **www.kesco.co.in** → "Quick Bill Payment"\n2. Or use the **Urja app** (urja.gov.in) — Government of UP's official app\n3. Enter your 12-digit KESCO account/consumer number → pay via UPI, debit/credit card, or net banking\n4. You can also pay at any KESCO sub-division counter or CSC centre\n\nTip: always check your meter reading matches the bill. If the bill looks wrong, email helpline@kesco.co.in with a meter photo. — Sathi`,
    hi: `KESCO bill online pay karna 2 minute ka kaam hai:\n\n1. **www.kesco.co.in** kholo → "Quick Bill Payment"\n2. Ya **Urja app** (urja.gov.in) use karo — UP sarkar ka official app\n3. Apna 12-digit account/consumer number daalo → UPI, card ya net banking se pay karo\n4. KESCO counter ya CSC centre se bhi jama kar sakte hain\n\nTip: bill ki reading apne meter se milaan karein. Galat lage to meter ki photo ke saath helpline@kesco.co.in par email karein. — Sathi`,
  },
  {
    kws: ['power cut', 'power outage', 'no power', 'light nahi', 'bijli nahi', 'current nahi', 'outage', 'light chali', 'supply'],
    hint: 'power-cut',
    en: `No power? Do this:\n\n1. Check your main breaker — if only YOUR house is out, it's an internal fault (call a local electrician)\n2. If the whole street/colony is out, it's a grid fault — **report it on BijliSathi** with a photo; it reaches the nearest KESCO lineman directly with live tracking\n3. For emergencies (sparking, transformer blast), call **1912** right away\n\nMost urban faults are fixed in a few hours; transformer faults can take longer. Track your report live on BijliSathi. — Sathi`,
    hi: `Bijli nahi hai? Ye karein:\n\n1. Apna main breaker check karein — agar sirf aapka ghar hai to internal fault hai (electrician ko bulayein)\n2. Agar puri gali/colony ki bijli gayi hai to grid fault hai — **BijliSathi par report karein** photo ke saath; seedha sabse paas ke KESCO lineman ke paas jayegi, live tracking ke saath\n3. Emergency (sparking, transformer blast) mein **1912** turant call karein\n\nZyadatar faults kuch ghanton mein theek ho jaate hain. BijliSathi par live track karein. — Sathi`,
  },
  {
    kws: ['spark', 'sparking', 'fire', 'aag', 'danger', 'khatra', 'safety', 'hanging wire', 'toota tar', 'short circuit', 'transformer blast', 'blast'],
    hint: 'safety',
    en: `⚠️ Electrical safety — this is critical:\n\n• NEVER touch a hanging or sparking wire, even with a wooden stick\n• Stay at least 3 metres away; keep children and animals away\n• Never touch switches/plugs with wet hands\n• If a wire falls on someone's vehicle, they should stay inside and call 1912\n\n**Emergency: call 1912 immediately**, then report it on BijliSathi — sparking faults get top urgency and the nearest lineman is dispatched first. — Sathi`,
    hi: `⚠️ Bijli ki safety — ye bahut zaroori hai:\n\n• Katay/sulagte taar ko KABHI mat chhuein, lakdi ke stick se bhi nahi\n• Kam se kam 3 metre door rahein; bachche aur jaanwar ko door rakhein\n• Geelay haath switch/plug ko mat lagayein\n• Agar taar kisi gaadi par gir jaye, to andar hi baithe rahein aur 1912 call karein\n\n**Emergency: turant 1912 call karein**, phir BijliSathi par report karein — sparking wali report ko sabse pehle priority milti hai. — Sathi`,
  },
  {
    kws: ['complaint', 'register', 'report', 'shikayat', 'darz kare', 'how to report'],
    hint: 'report',
    en: `Reporting a fault on BijliSathi takes 60 seconds:\n\n1. Open BijliSathi → **Report New Issue**\n2. Pick the problem (no power, sparking transformer, broken wire, meter fault, voltage issue, streetlight)\n3. Add a clear photo + your location (GPS auto-fills) + a short description\n4. Done — AI verifies your photo, merges duplicates nearby, and auto-assigns the **nearest KESCO lineman**\n\nYou get a live tracking link, ETA, and notifications at every step — like Rapido/Ola for electricity faults. — Sathi`,
    hi: `BijliSathi par shikayat 60 second mein:\n\n1. BijliSathi kholo → **Report New Issue**\n2. Problem chuno (bijli nahi, sparking transformer, kata taar, meter fault, voltage, streetlight)\n3. Saaf photo + location (GPS khud bhar jaata hai) + chhota description daalo\n4. Bas — AI photo verify karta hai, paas ki same shikayaton ko jodta hai, aur **sabse paas ke KESCO lineman** ko bhej deta hai\n\nLive tracking link, ETA aur har step par notification milta hai. — Sathi`,
  },
  {
    kws: ['voltage', 'fluctuation', 'low voltage', 'high voltage', 'voltage kam', 'voltage zyada', 'light jal'],
    hint: 'voltage',
    en: `Voltage fluctuation damages appliances — take it seriously:\n\n• Normal supply: 220V ±10% (198–242V). Outside this range = genuine complaint\n• Note the time it happens (peak hours 6–11 PM are common)\n• **Report it on BijliSathi** with the affected appliance/photo if possible — voltage issues are routed to KESCO's line staff\n• Use a voltage stabiliser for fridge/AC in the meantime\n\nRepeated fluctuations in your area usually mean an overloaded transformer — multiple reports from the same colony speed up the fix. — Sathi`,
    hi: `Voltage fluctuation se appliance kharab hoti hai — ise seriously lein:\n\n• Normal supply: 220V ±10% (198–242V). Isse bahar = asli shikayat\n• Time note karein (shaam 6–11 baje aam hai)\n• **BijliSathi par report karein** — voltage ki shikayat seedha KESCO line staff ke paas jaati hai\n• Tab tak fridge/AC par voltage stabiliser lagayein\n\nAapke area mein baar-baar fluctuation ka matlab overloaded transformer hai — colony ki ek se zyada report se kaam jaldi hota hai. — Sathi`,
  },
  {
    kws: ['meter', 'meter fault', 'meter reading', 'slow meter', 'fast meter', 'meter change', 'new meter', 'meter bijli'],
    hint: 'meter',
    en: `Meter issues — who handles what:\n\n• **Fast/spark/burnt meter**: report on BijliSathi (Meter Fault) — urgent, safe to report with a photo\n• **Wrong reading/bill**: photograph your meter, compare with the bill, email helpline@kesco.co.in\n• **New meter / name transfer / load change**: visit your KESCO sub-division office with last bill + ID + ownership proof\n\nNever open or bypass a meter yourself — it's dangerous and a legal offence under the Electricity Act. — Sathi`,
    hi: `Meter ki samasya — kaun kya karega:\n\n• **Jala/spark meter**: BijliSathi par report karein (Meter Fault) — urgent hai, photo ke saath report karein\n• **Galat reading/bill**: meter ki photo lein, bill se milayein, helpline@kesco.co.in par email karein\n• **Naya meter / naam transfer / load change**: KESCO sub-division office jayein — purana bill + ID + ownership proof le jayein\n\nMeter ko khud kholna/bypass karna kabhi na karein — khatarnak aur Electricity Act ke under apradh hai. — Sathi`,
  },
  {
    kws: ['grievance', 'no action', 'koi action nahi', 'not resolved', 'complaint not solved', 'cgrf', 'consumer court', 'upar adhikari', 'higher officer'],
    hint: 'escalation',
    en: `If KESCO doesn't act on your complaint, escalate in this order:\n\n1. **1912** — quote your complaint number, ask for escalation\n2. **CGRF (Consumer Grievance Redressal Forum)** — every KESCO zone has one; file free of cost at the zonal office\n3. **Ombudsman (UPERC)** — if CGRF doesn't resolve in 2 months: uperc.org\n4. Email: helpline@kesco.co.in with your complaint number and photos\n\nOn BijliSathi, every report has a tracking ID and timestamp — perfect evidence for escalation. — Sathi`,
    hi: `Agar KESCO aapki shikayat par kaam na kare, to is order mein aage badhein:\n\n1. **1912** — apna complaint number batayein, escalation maangein\n2. **CGRF (Consumer Grievance Redressal Forum)** — har KESCO zone mein hota hai; zonal office par muft mein apply karein\n3. **Ombudsman (UPERC)** — CGRF 2 mahine mein na hal kare to: uperc.org\n4. Email: helpline@kesco.co.in — complaint number aur photos ke saath\n\nBijliSathi ki har report ka tracking ID aur time-stamp hota hai — escalation ka sabse strong saboot. — Sathi`,
  },
  {
    kws: ['streetlight', 'street light', 'streetlight not working', 'sarkari light', 'batti street'],
    hint: 'streetlight',
    en: `Broken streetlight? Report it on BijliSathi:\n\n1. Report New Issue → **Streetlight**\n2. Add a photo of the dark spot with the pole number if visible\n3. KESCO's maintenance crew gets it directly with the exact GPS location\n\nStreetlight faults are low-urgency but usually fixed within a few days. Dark stretches are accident risks — reporting helps your whole neighbourhood. — Sathi`,
    hi: `Streetlight kharab? BijliSathi par report karein:\n\n1. Report New Issue → **Streetlight**\n2. Andhere jagah ki photo lagayein — pole number dikhe to aur behtar\n3. KESCO maintenance crew ko exact GPS location ke saath seedha mil jaata hai\n\nStreetlight faults low-urgency hote hain par aam taur par kuch dino mein theek ho jaate hain. Andha raasta accident ka risk hai — report karne se pura mohalla bachta hai. — Sathi`,
  },
  {
    kws: ['new connection', 'connection lagwa', 'naya connection', 'load sanction', 'load badha', 'name transfer', 'transfer'],
    hint: 'connection',
    en: `New KESCO connection / load change — documents you need:\n\n• Last paid bill (or neighbour's bill for the area)\n• ID proof (Aadhaar) + address proof\n• Ownership proof (registry / rent agreement)\n• For load increase: old sanctioned-load papers\n\nApply at your **sub-division office** (find via www.kesco.co.in) — the urja.gov.in portal also takes online applications. Processing usually takes 1–4 weeks depending on load. — Sathi`,
    hi: `Naya KESCO connection / load badwane ke liye documents:\n\n• Pichha hua bill (ya mohalle ka koi bill)\n• ID proof (Aadhaar) + address proof\n• Ownership proof (registry / rent agreement)\n• Load badhane ke liye: purana sanctioned-load paper\n\nApne **sub-division office** mein apply karein (www.kesco.co.in par dekhein) — urja.gov.in par online bhi ho jaata hai. Load ke hisaab se 1–4 hafte lagte hain. — Sathi`,
  },
];

/** Match a question against the curated brain — returns the best entry or null */
function matchKnowledgeBase(question) {
  const q = ` ${String(question).toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  let best = null;
  let bestScore = 0;
  for (const entry of SATHI_KB) {
    let score = 0;
    for (const kw of entry.kws) {
      if (q.includes(` ${kw} `) || q.includes(`${kw}`)) score += kw.includes(' ') ? 2.5 : 1.5;
    }
    if (score > bestScore) { bestScore = score; best = entry; }
  }
  return bestScore >= 1.5 ? best : null;
}

function isHinglish(question) {
  return /(nahi|kaise|kare|karein|hai|kya|kab|mera|meri|bata|chahiye|kar|raha|rahi|liye|wala|bijli|bill ka|kahan)\b/i.test(String(question));
}

/* ------------------------------------------------------------------ */
/* LAYER 2 — Keyless live multi-source search + clustering             */
/* ------------------------------------------------------------------ */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCharCode(+n); } catch { return ''; } });
}
const stripTags = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, ''));

/** DuckDuckGo HTML search */
async function ddgSearch(query, limit = 5) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' },
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) return [];
    const html = await res.text();
    const out = [];
    const re = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) && out.length < limit) {
      const text = stripTags(m[1]).replace(/\s+/g, ' ').trim();
      if (text.length > 40) out.push(text);
    }
    return out;
  } catch {
    return [];
  }
}

/** Wikipedia search */
async function wikiSearch(query, limit = 2) {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${limit}`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.query?.search || []).map((r) => `${r.title} (Wikipedia): ${stripTags(r.snippet || '')}`);
  } catch {
    return [];
  }
}

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'what', 'how', 'when', 'why', 'who', 'my', 'me', 'i', 'do', 'does', 'did', 'can', 'should', 'in', 'ka', 'ki', 'ke', 'hai', 'kya', 'kaise', 'kab', 'kahan', 'mein', 'aur']);

function keywordsOf(text) {
  return [...new Set(String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)))];
}

/** Split snippets into clean sentences */
function toSentences(snippets) {
  const sents = [];
  for (const sn of snippets) {
    for (let s of sn.split(/(?<=[.!?])\s+|\s*\|\s*|\s*•\s*/)) {
      s = s.replace(/^[-•\s]+/, '').trim();
      if (s.length >= 45 && s.length <= 320 && /[a-zA-Z]/.test(s)) sents.push(s);
    }
  }
  return sents;
}

function tokenSet(s) {
  return new Set(keywordsOf(s));
}
function jaccard(a, b) {
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter || 1);
}

/**
 * Cluster + rank: keep only sentences that answer the question, dedupe near-duplicates
 * (cross-source consensus), rank by keyword relevance + source diversity.
 */
function clusterFacts(question, snippets, max = 5) {
  const kws = keywordsOf(question);
  const sents = toSentences(snippets);
  const scored = sents.map((s) => {
    const toks = keywordsOf(s);
    let overlap = 0;
    for (const k of kws) if (toks.includes(k)) overlap++;
    const score = overlap / Math.sqrt(toks.length || 1) + (kws.some((k) => s.toLowerCase().includes(k)) ? 0.3 : 0);
    return { s, score, toks: tokenSet(s) };
  }).filter((x) => x.score > 0.15);

  scored.sort((a, b) => b.score - a.score);

  // Dedupe near-identical facts (consensus across sources counts once, but is a strong signal)
  const kept = [];
  for (const cand of scored) {
    if (cand.score < 0.22 && kept.length >= 2) continue; // relevance floor once we have good facts
    const dup = kept.find((k) => jaccard(k.toks, cand.toks) > 0.55);
    if (dup) { dup.agree = (dup.agree || 1) + 1; continue; }
    kept.push({ ...cand, agree: 1 });
    if (kept.length >= max) break;
  }
  // Re-rank: agreement (multiple sources saying the same thing = accurate) + relevance
  kept.sort((a, b) => b.score + Math.log2(b.agree) - (a.score + Math.log2(a.agree)));
  return kept.map((k) => k.s);
}

/** Full keyless pipeline: multi-query live search -> clustered facts */
async function liveClusterSearch(question) {
  const qs = [question, `${question} India`];
  const [first, second, wiki] = await Promise.all([ddgSearch(qs[0], 5), (async () => { await new Promise((r) => setTimeout(r, 500)); return ddgSearch(qs[1], 4); })(), wikiSearch(question, 2)]);
  const snippets = [...first, ...second, ...wiki].filter(Boolean);
  if (!snippets.length) return { facts: [], sources: 0 };
  const facts = clusterFacts(question, snippets, 5);
  return { facts, sources: snippets.length };
}

/* ------------------------------------------------------------------ */
/* LAYER 3 — Synthesis                                                 */
/* ------------------------------------------------------------------ */

/** LLM synthesis of clustered facts (used when an LLM key exists) */
async function synthesizeWithLLM(question, facts, sources, historyText = '') {
  if (!facts.length) return null;
  const llm = await callLLM({
    system: SYSTEM_PROMPT,
    user: `${historyText ? `Recent chat:\n${historyText}\n\n` : ''}Web results (fetched seconds ago — treat as ground truth, prefer facts multiple sources agree on):\n${facts.map((f) => `• ${f}`).join('\n')}\n\nUser question: "${question}"\n\nAnswer exactly what was asked: direct answer first, then a short numbered plan only if action is needed. Up to ~200 words. Plain sentences and steps only.`,
    maxTokens: 650,
  });
  if (llm?.text) return { text: llm.text, provider: 'Sathi AI' };
  return null;
}

/** Keyless extractive synthesis — direct answer woven from top facts */
function extractiveAnswer(question, facts, sources) {
  if (!facts.length) return null;
  const lead = facts[0];
  const support = facts.slice(1, 4);
  let body = `${lead}`;
  if (support.length) body += `\n\n${support.map((s) => `• ${s}`).join('\n')}`;
  const q = question.toLowerCase();
  let next = 'Ask me a follow-up if any step is unclear — I\u2019ll walk you through it.';
  if (q.includes('helpline') || q.includes('number')) next = 'For emergencies like sparking wires, call 1912 immediately.';
  else if (q.includes('power') || q.includes('bijli') || q.includes('cut')) next = 'Report it on BijliSathi with a photo — it reaches the nearest KESCO lineman directly.';
  return `${body}\n\nNext step: ${next} — Sathi`;
}

/** Strip markdown/meta junk, reasoning blocks, and bare headings from LLM output */
function cleanLLMText(t) {
  let text = String(t || '');
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '');
  text = text.trim();
  // Drop a leading bare heading line like "Greeting & Direct Answer" or "**:"
  const lines = text.split('\n');
  while (lines.length && (/^[\s*#>:•\-]+$/.test(lines[0]) || /^[A-Z][A-Za-z&' ]{2,38}:?$/.test(lines[0].replace(/\*/g, '').trim()))) {
    lines.shift();
  }
  text = lines.join('\n').replace(/^[\s*>:]+/, '').trim();
  return text;
}

/* Free-AI provider chain — Sathi auto-uses every key that exists, first success wins.
   Stack them (all free tiers, no card needed) for effectively unlimited ChatGPT-class power:
   - GROQ_API_KEY       https://console.groq.com        (fastest, generous free Llama 3.3 70B)
   - OPENROUTER_API_KEY https://openrouter.ai           (many :free models)
   - MISTRAL_API_KEY    https://console.mistral.ai      (free tier)
   - GITHUB_MODELS_TOKEN https://github.com/settings/personal-access-tokens (GitHub Models, free)
   - GEMINI_API_KEY     https://aistudio.google.com     (Google, free tier)
   - OPENAI_API_KEY     https://platform.openai.com     (paid, best quality)
*/
const LLM_PROVIDERS = [
  {
    // Verified against our key: gpt-oss-120b ✓, qwen3.6-27b ✓, gpt-oss-20b ✓ (llama-3.3-70b was retired by Groq)
    env: 'GROQ_API_KEY',
    base: 'https://api.groq.com/openai/v1/chat/completions',
    models: ['openai/gpt-oss-120b', 'qwen/qwen3.6-27b', 'openai/gpt-oss-20b'],
    label: () => 'Sathi AI',
    tokenBoost: 3, // gpt-oss spends tokens on hidden reasoning first; qwen needs headroom for full step-by-step answers
  },
  {
    env: 'OPENROUTER_API_KEY',
    base: 'https://openrouter.ai/api/v1/chat/completions',
    models: ['meta-llama/llama-3.3-70b-instruct:free', 'google/gemini-2.0-flash-exp:free', 'mistralai/mistral-7b-instruct:free'],
    label: () => 'Sathi AI',
    extraHeaders: (key) => ({ 'HTTP-Referer': 'https://bijlisathi.in', 'X-Title': 'BijliSathi Sathi AI' }),
  },
  {
    env: 'MISTRAL_API_KEY',
    base: 'https://api.mistral.ai/v1/chat/completions',
    models: ['mistral-small-latest', 'open-mistral-nemo'],
    label: () => 'Sathi AI',
  },
  {
    env: 'GITHUB_MODELS_TOKEN',
    base: 'https://models.github.ai/inference/chat/completions',
    models: ['openai/gpt-4o-mini', 'meta/Llama-3.3-70B-Instruct'],
    label: () => 'Sathi AI',
  },
];

/** Generic OpenAI-compatible caller with failover across model list */
async function tryOpenAICompatible(base, key, models, labelFn, system, user, maxTokens, extraHeaders, tokenBoost = 1) {
  const boosted = Math.round(maxTokens * tokenBoost);
  for (const model of models) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 12000);
      const res = await fetch(base, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(extraHeaders ? extraHeaders(key) : {}) },
        body: JSON.stringify({
          model,
          max_tokens: boosted,
          temperature: 0.7,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
        signal: controller.signal,
      });
      clearTimeout(t);
      if (!res.ok) continue;
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      if (text && String(text).trim().length > 10) return { text: cleanLLMText(text), provider: labelFn(model) };
    } catch {}
  }
  return null;
}

/** Call LLM — free-provider chain -> Gemini -> GPT-4o */
async function callLLM({ system, user, maxTokens = 500 }) {
  for (const p of LLM_PROVIDERS) {
    const key = process.env[p.env];
    if (!key) continue;
    const out = await tryOpenAICompatible(p.base, key, p.models, p.label, system, user, maxTokens, p.extraHeaders, p.tokenBoost || 1);
    if (out) return out;
  }
  if (process.env.GEMINI_API_KEY) {
    for (const model of ['gemini-3.6-flash', 'gemini-flash-latest', 'gemini-2.0-flash']) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 12000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: `${system}\n\nUser: ${user}` }] }],
            generationConfig: { temperature: 0.7, maxOutputTokens: maxTokens, topP: 0.9 },
          }),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (!res.ok) continue;
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { text: cleanLLMText(text), provider: 'Sathi AI' };
      } catch {}
    }
  }
  if (process.env.OPENAI_API_KEY) {
    for (const model of ['gpt-4o', 'gpt-4o-mini']) {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 12000);
        const res = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            temperature: 0.7,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
          }),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (!res.ok) continue;
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content;
        if (text) return { text: cleanLLMText(text), provider: 'Sathi AI' };
      } catch {}
    }
  }
  return null;
}

/** Human-like ETA notification (email + UI) — false complaints never get a fix time */
async function generateEtaMessage({ complaint, eta, assignment, duplicateInfo, photoAnalysis }) {
  const isDup = !!complaint.isDuplicateOf;
  const isFake = complaint.genuinenessScore < 0.4;
  const hasTech = !!assignment?.assigned || !!complaint.assignedTechnicianId;
  const etaLabel = isFake ? null : (eta?.label || (complaint.etaMinutes ? (complaint.etaMinutes < 60 ? `~${complaint.etaMinutes} mins` : `~${Math.round(complaint.etaMinutes / 60)} hours`) : null));

  const context = `Complaint: ${complaint.problemVariant} — ${complaint.description?.slice(0, 180) || 'no description'}
Status: ${complaint.status}${isFake ? ' (flagged possible false/spam — under KESCO verification)' : ''}
ETA: ${isFake ? 'withheld — the citizen must NOT be given any fix time' : `${etaLabel || 'being calculated'} (by ${eta?.estimatedAt ? new Date(eta.estimatedAt).toLocaleString('en-IN') : new Date(complaint.estimatedResolutionAt).toLocaleString('en-IN')})`}
Duplicate: ${isDup ? `merged with nearby reports — ${duplicateInfo || 'neighbors reported the same fault'}` : 'unique'}
Technician: ${hasTech ? `assigned ${assignment?.technician?.name || 'nearest lineman'}` : 'awaiting dispatch'}
Photo AI verdict: ${photoAnalysis ? `${photoAnalysis.provider} • likely fault: ${photoAnalysis.detectedFault || 'as reported'} • severity: ${photoAnalysis.severity || 'medium'} • "${photoAnalysis.reasoning || ''}"` : 'none'}
Safety advice to include: ${photoAnalysis?.safetyAdvice || 'stay away from damaged wires, call 1912 for emergencies'}`;

  const llm = await callLLM({
    system: SYSTEM_PROMPT,
    user: isFake
      ? `Write a short, firm but polite notice for the citizen (3-4 sentences, under 80 words). Their report's text and photo did not match a real electrical fault, so it is marked as a FALSE complaint and held for KESCO officer verification in the false-complaint queue. Clearly warn: please do not send false complaints — they waste the electricity department's time and delay real fault repairs. Do NOT state, hint at, or promise any fix time. Context:\n${context}`
      : `Write a short, reassuring ETA notification for the citizen. Structure: 1-2 sentence diagnosis of their fault (use the Photo AI verdict), then numbered steps covering what happens next and what THEY should do now — include exactly ONE safety precaution from the context. Under 90 words total. Context:\n${context}`,
    maxTokens: 400,
  });
  if (llm?.text) return { message: llm.text, provider: llm.provider };

  // Template fallback
  let msg = `Namaste! Your report for ${complaint.problemVariant.replace(/-/g, ' ')} is registered. `;
  if (isFake) {
    msg = `Namaste! Your report for ${complaint.problemVariant.replace(/-/g, ' ')} is registered as a FALSE complaint — its text and photo did not match a real electrical fault — and is held for KESCO officer verification. `;
    if (isDup) msg += `A similar nearby report was found, so both will be checked together. `;
    msg += `Please do not send false complaints — they waste the electricity department's time and delay repairs for real faults. No fix time can be shown until it's verified. — Sathi`;
    return { message: msg, provider: 'Sathi' };
  }
  if (photoAnalysis?.detectedFault) msg += `Our AI engineer's diagnosis: ${photoAnalysis.detectedFault}. `;
  if (isDup) msg += `Your neighbors reported the same fault nearby, so it's merged into one job for a faster fix — no need to report again. `;
  msg += etaLabel ? `Estimated fix: ${etaLabel}. ` : `The fix time is being calculated. `;
  msg += hasTech ? `The nearest lineman is assigned — watch his live location on Track. ` : `The nearest technician will be assigned shortly — you'll be notified. `;
  if (photoAnalysis?.safetyAdvice) msg += `Safety first: ${photoAnalysis.safetyAdvice} `;
  msg += `— Sathi`;
  return { message: msg, provider: 'Sathi' };
}

/** Technician-set ETA notification — technician read description + photo, then gave fix time */
async function generateTechEtaMessage({ complaint, etaMinutes, etaLabel, estimatedAt, technicianName, safetyPrecautions }) {
  const fault = String(complaint.problemVariant || 'fault').replace(/-/g, ' ');
  const context = `Fault: ${fault} — ${String(complaint.description || '').slice(0, 180)}\nTechnician: ${technicianName}\nETA: ${etaLabel} by ${estimatedAt ? new Date(estimatedAt).toLocaleString('en-IN') : ''}\nSafety: ${String(safetyPrecautions || '').slice(0, 300)}`;
  try {
    const llm = await callLLM({
      system: SYSTEM_PROMPT,
      user: `Write a short reassuring update for the citizen (under 90 words). Their assigned lineman ${technicianName} has accepted the ${fault} job after reading the description and photo, and estimates resolution in ${etaLabel}. Include exactly ONE safety precaution from context. Mention live GPS tracking is now active on the Track page. Context:\n${context}`,
      maxTokens: 350,
    });
    if (llm?.text) return { message: llm.text, provider: llm.provider };
  } catch {}
  let msg = `Namaste! Your lineman ${technicianName} has accepted your ${fault} complaint after reviewing your photo and description. `;
  msg += `Estimated resolution: ${etaLabel}${estimatedAt ? ` (by ${new Date(estimatedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })})` : ''}. `;
  msg += `Live GPS tracking is now active — watch him on the Track page. `;
  if (safetyPrecautions) msg += `Safety first: ${String(safetyPrecautions).split('\n')[0]} `;
  msg += `— Sathi`;
  return { message: msg, provider: 'Sathi' };
}

/** AI resolution note — sent when the lineman marks the job resolved */
async function generateResolutionMessage({ complaint, technicianName, resolutionNotes, safetyPrecautions }) {
  const fault = String(complaint.problemVariant || 'fault').replace(/-/g, ' ');
  const context = `Fault: ${fault} — ${String(complaint.description || '').slice(0, 180)}\nResolved by: ${technicianName}\nTechnician notes: ${String(resolutionNotes || '').slice(0, 300)}\nReported: ${complaint.createdAt ? new Date(complaint.createdAt).toLocaleString('en-IN') : ''} • Resolved: ${new Date().toLocaleString('en-IN')}`;
  try {
    const llm = await callLLM({
      system: SYSTEM_PROMPT,
      user: `Write a warm resolution confirmation for the citizen (under 90 words). Their ${fault} complaint is now resolved by lineman ${technicianName}. Summarize what was fixed in one line (use technician notes), confirm power should be normal, ask them to confirm on the Track page or reopen if still faulty, and thank them. Context:\n${context}`,
      maxTokens: 350,
    });
    if (llm?.text) return { message: llm.text, provider: llm.provider };
  } catch {}
  let msg = `Namaste! Your ${fault} complaint is now resolved by lineman ${technicianName}. `;
  if (resolutionNotes) msg += `Work done: ${String(resolutionNotes).slice(0, 160)}. `;
  msg += `Power supply should now be normal. Please confirm on the Track page — or reopen if the issue persists. Thank you for reporting via BijliSathi. — Sathi`;
  void safetyPrecautions;
  return { message: msg, provider: 'Sathi' };
}

/** Website + KESCO knowledge (instant, local) */
async function searchWebsiteKnowledge(question) {
  const q = question.toLowerCase();
  const knowledge = [];
  try {
    if (q.includes('complaint') || q.includes('fault') || q.includes('power') || q.includes('bijli')) {
      const recent = await Complaint.find().sort({ createdAt: -1 }).limit(3).select('problemVariant status');
      if (recent.length) knowledge.push(`Recent reports on BijliSathi: ${recent.map((c) => `${c.problemVariant} (${c.status})`).join(', ')}`);
    }
  } catch {}
  if (q.includes('kesco') || q.includes('kanpur') || q.includes('helpline') || q.includes('1912')) {
    knowledge.push('KESCO Kanpur: helpline 1912 (24x7), 1800-180-1912, helpline@kesco.co.in, 14/71 Civil Lines Kanpur 208001, www.kesco.co.in');
  }
  if (q.includes('bill') || q.includes('payment')) {
    knowledge.push('Billing: pay at www.kesco.co.in, via 1912, or KESCO counters.');
  }
  if (q.includes('safety') || q.includes('danger') || q.includes('wire')) {
    knowledge.push('Safety: stay away from hanging/sparking wires, keep dry, call 1912 for emergencies.');
  }
  return knowledge.join(' | ');
}

/** Short but ACTIONABLE fallback for complaint-specific questions (uses real complaint data) */
function fallbackAnswer({ question, complaint, ai }) {
  const q = question.toLowerCase();
  const sign = `— Sathi`;

  if (q.includes('helpline') || q.includes('1912') || q.includes('contact') || q.includes('number')) {
    return `KESCO helpline solution:\n1. Call **1912** (24x7) or 1800-180-1912 — keep your complaint ID ${complaint.ticketId || String(complaint._id || '').slice(-8).toUpperCase() || '…'} ready.\n2. Email helpline@kesco.co.in with the ID + photos if phone lines are busy.\n3. For sparking/hanging wires, don't wait — 1912 immediately and stay 3m away. ${sign}`;
  }
  if (q.includes('bill') || q.includes('payment') || q.includes('meter reading')) {
    return `Bill fix in 4 steps:\n1. Compare your meter reading with the bill photo.\n2. Pay at www.kesco.co.in → "Quick Bill Payment", via the Urja app, or any KESCO counter.\n3. Reading looks wrong? Email helpline@kesco.co.in with a meter photo + bill number — they recheck within days.\n4. BijliSathi handles faults only — for meter faults use Report New Issue. ${sign}`;
  }
  if (q.includes('safety') || q.includes('khatra') || q.includes('danger') || q.includes('spark')) {
    return `Do this NOW:\n1. Stay 3+ metres away; keep children/animals back.\n2. Never touch the wire — even with wood.\n3. Call **1912** immediately (24x7).\n4. Then report it on BijliSathi — sparking gets top urgency and the nearest lineman first. ${sign}`;
  }
  if (q.includes('when') || q.includes('kitne') || q.includes('kab tak') || q.includes('time')) {
    const eta = ai?.etaLabel || (complaint.etaMinutes ? `~${complaint.etaMinutes < 60 ? complaint.etaMinutes + ' minutes' : Math.round(complaint.etaMinutes / 60) + ' hours'}` : null);
    return `Your fix plan:\n1. Current estimate: ${eta || 'being calculated right now'} — based on fault type, lineman distance and workload.\n2. Open Track — you'll see live status the moment a lineman is assigned.\n3. You'll be notified automatically at every stage; nothing more is needed from your side unless it's an emergency (then 1912). ${sign}`;
  }
  if (q.includes('technician') || q.includes('lineman') || q.includes('who')) {
    if (complaint.assignedTechnicianId && typeof complaint.assignedTechnicianId === 'object') return `Assigned: ${complaint.assignedTechnicianId.name || 'KESCO lineman'}.\n1. His live GPS appears on Track once he accepts.\n2. No call needed — the system routes him automatically.\n3. Not moving for hours? Call 1912 with your complaint ID. ${sign}`;
    if (complaint.status === 'working') return `A technician is on the way.\n1. Open Track to watch his live location.\n2. Keep the area accessible and safe.\n3. Emergency? 1912 anytime. ${sign}`;
    return `Dispatch plan:\n1. AI is picking the nearest available lineman right now.\n2. You'll get an instant notification on assignment.\n3. Track shows everything live after that. ${sign}`;
  }
  if (q.includes('status') || q.includes('kya hua') || q.includes('track')) {
    return `Status check:\n1. Current: ${complaint.status} • ETA ${ai?.etaLabel || (complaint.etaMinutes ? `~${complaint.etaMinutes} min` : 'calculating')}.\n2. Open Track for the live pulse and lineman GPS.\n3. Every change notifies you automatically. ${sign}`;
  }
  return `I'm Sathi — ask me anything: "power cut in my area?", "how do I pay my bill?", "when will it be fixed?" — I give exact, step-by-step answers using your real complaint data. ${sign}`;
}

/** Main chat — Sathi: grounded AI search -> clustered live search -> synthesis */
async function chatWithComplaintContext({ complaint, ai, question, history = [] }) {
  const isGeneral = complaint._id === 'general' || !complaint._id || complaint.problemVariant === 'general';

  if (!isGeneral) {
    // Complaint-specific: real data first, no web needed
    const websiteKnowledge = await searchWebsiteKnowledge(question);
    const context = `Complaint ID: ${complaint._id}
Variant: ${complaint.problemVariant}
Description: ${complaint.description || '—'}
Status: ${complaint.status}
Genuineness: ${Math.round((ai?.genuinenessScore ?? complaint.genuinenessScore ?? 0.7) * 100)}%
Urgency: ${ai?.urgencyScore ?? complaint.urgencyScore}/10
ETA: ${ai?.etaLabel || (complaint.etaMinutes ? `~${complaint.etaMinutes}m` : 'not yet')}
Duplicate: ${ai?.isDuplicate || !!complaint.isDuplicateOf ? 'YES — merged with nearby reports' : 'no'}
Photo AI: ${ai?.photoAnalysis ? `${ai.photoAnalysis.provider} relevant=${ai.photoAnalysis.isRelevant} "${ai.photoAnalysis.reasoning}"` : 'none'}
Technician: ${complaint.assignedTechnicianId && typeof complaint.assignedTechnicianId === 'object' ? `${complaint.assignedTechnicianId.name} (${complaint.assignedTechnicianId.status})` : 'not assigned'}`;

    const historyText = history.slice(-6).map((m) => `${m.role}: ${m.content}`).join('\n');
    const userPrompt = `${historyText ? `History:\n${historyText}\n\n` : ''}Complaint context:\n${context}${websiteKnowledge ? `\n\nVerified platform knowledge: ${websiteKnowledge}` : ''}\n\nUser's question: "${question}"\n\nAnswer as Sathi with a TRUE SOLUTION like ChatGPT would: one-line diagnosis from the complaint data, then a numbered step-by-step plan — what is already happening on this complaint AND exactly what the citizen should do now (safety steps, Track page, 1912 for emergencies, escalation path if stuck). Specific and complete; up to ~180 words.`;

    const llm = await callLLM({ system: SYSTEM_PROMPT, user: userPrompt, maxTokens: 650 });
    if (llm?.text) return { answer: llm.text, provider: llm.provider };
    return { answer: fallbackAnswer({ question, complaint, ai }), provider: 'Sathi' };
  }

  // General question — exact-answer pipeline (LLM first, like the best assistants):
  const historyText = (history || []).slice(-6).map((m) => `${m.role}: ${m.content}`).join('\n');
  const websiteKnowledge = await searchWebsiteKnowledge(question);

  // 0) Direct LLM answer with history + verified platform knowledge (exact, contextual)
  const direct = await callLLM({
    system: SYSTEM_PROMPT,
    user: `${historyText ? `Recent chat:\n${historyText}\n\n` : ''}${websiteKnowledge ? `Verified platform knowledge:\n${websiteKnowledge.split(' | ').map((k) => `• ${k}`).join('\n')}\n\n` : ''}User question: "${question}"\n\nAnswer exactly what was asked — direct answer first, then numbered steps only if action is needed.`,
    maxTokens: 600,
  }).catch(() => null);
  if (direct?.text) return { answer: direct.text, provider: 'Sathi AI' };

  // 1) Curated expert brain — instant, accurate domain answers
  const kb = matchKnowledgeBase(question);
  if (kb) {
    return { answer: isHinglish(question) ? kb.hi : kb.en, provider: 'Sathi AI' };
  }

  // 2) Grounded / search-native models
  const grounded = await geminiGroundedAnswer(question).catch(() => null);
  if (grounded) return { answer: grounded.text, provider: grounded.provider };

  const oaiSearch = await openAISearchAnswer(question).catch(() => null);
  if (oaiSearch) return { answer: oaiSearch.text, provider: oaiSearch.provider };

  // 3) Keyless multi-source clustering + synthesis
  const { facts, sources } = await liveClusterSearch(question);
  if (facts.length) {
    const synth = await synthesizeWithLLM(question, facts, sources, historyText);
    if (synth) return { answer: synth.text, provider: synth.provider };
    const ext = extractiveAnswer(question, facts, sources);
    if (ext) return { answer: ext, provider: 'Sathi AI' };
  }

  // 4) Local knowledge, direct
  if (websiteKnowledge) {
    return { answer: `${websiteKnowledge.split(' | ').map((k) => `• ${k}`).join('\n')}\n\n— Sathi`, provider: 'Sathi AI' };
  }
  return { answer: `I couldn't reach the web this second. Quick help: KESCO helpline is **1912** (24x7). Try again in a moment and I'll fetch the exact answer for you. — Sathi`, provider: 'Sathi AI' };
}

module.exports = { chatWithComplaintContext, generateEtaMessage, generateTechEtaMessage, generateResolutionMessage, callLLM, SYSTEM_PROMPT, globalWebSearch: liveClusterSearch, geminiGroundedAnswer, openAISearchAnswer };
