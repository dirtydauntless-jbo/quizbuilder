module.exports.config = { maxDuration: 60 };

const path = require('path');
const fs   = require('fs');

// ── Lazy-load reference content (8083 text) ──────────────────────────────────
let _content = null;
function getContent() {
  if (!_content) {
    try { _content = require(path.join(process.cwd(), '8083_content.json')); } catch { _content = {}; }
  }
  return _content;
}

// ── Lazy-load FAA question bank ───────────────────────────────────────────────
let _faaBank = null;
function getFaaBank() {
  if (_faaBank === null) {
    try { _faaBank = require(path.join(process.cwd(), 'faa_questions.json')); }
    catch { _faaBank = {}; }
  }
  return _faaBank;
}

// ── Build verified set of figure labels whose image file is actually on disk ──
// Checked once per cold start — the only guarantee a figure question is askable.
let _availableFigures = null;
function getAvailableFigures() {
  if (_availableFigures !== null) return _availableFigures;
  _availableFigures = new Set();
  try {
    const index = require(path.join(process.cwd(), 'figures-index.json'));
    const dir   = path.join(process.cwd(), 'public', 'figures');
    for (const [label, filename] of Object.entries(index)) {
      if (fs.existsSync(path.join(dir, filename))) {
        _availableFigures.add(label);
      }
    }
  } catch { /* no index → set stays empty → all figure questions excluded */ }
  return _availableFigures;
}

// ── Topic → subject mapping ───────────────────────────────────────────────────
const TOPIC_SUBJECT = {};
const SUBJECT_TOPICS = {
  general:    ['Aircraft Drawings','Aircraft Material Hardware and Processes','Cleaning and Corrosion Control','Fluid Lines and Fittings','Forms and Regulations','Fundamentals of Electricity','Ground Operations and Servicing','Human Factors','Inspection Concepts and Techniques','Mathematics','Physics','Weight and Balance'],
  airframe:   ['Aircraft Electrical Systems','Aircraft Fuel Systems','Aircraft Instrument Systems','Airframe Inspection','Communications and Navigation Systems','Environmental Systems','Fire Protection','Flight Controls','Hydraulic and Pneumatic Systems','Ice and Rain Control Systems','Landing Gear','Metallic Structures','Nonmetallic Structures','Rotorcraft'],
  powerplant: ['Engine Electrical Systems','Engine Exhaust and Reverser Systems','Engine Fire Protection Systems','Engine Fuel and Fuel Metering Systems','Engine Inspection','Engine Instrument Systems','Engine Lubrication Systems','Ignition and Starting Systems','Propellers','Reciprocating Engines','Reciprocating Engine Induction and Cooling','Turbine Engine Air Systems','Turbine Engines']
};
for (const [subj, topics] of Object.entries(SUBJECT_TOPICS)) {
  for (const t of topics) TOPIC_SUBJECT[t] = subj;
}

// Calculation-heavy topics: use ONLY the verified FAA bank (never AI-generated), so we never
// ship a question whose "correct" choice has an arithmetic error. The bank has plenty here
// (Mathematics 96, Physics 96, Weight and Balance 43).
const FAA_ONLY_TOPICS = new Set(['Mathematics', 'Physics', 'Weight and Balance']);

// ── Shared utils ──────────────────────────────────────────────────────────────
async function callClaude(prompt, maxTokens = 4096) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  const d = await r.json();
  return d.content?.[0]?.text || '';
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\[[\s\S]*\]/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ── Pull random FAA questions for a topic ────────────────────────────────────
function getFaaQuestions(topic, n) {
  if (n < 1) return [];
  const subject = TOPIC_SUBJECT[topic] || 'general';
  const bank = getFaaBank();
  const available = getAvailableFigures();
  const allPool = bank[subject]?.[topic];
  if (!Array.isArray(allPool) || !allPool.length) return [];
  // Only serve figure questions whose VERIFIED image (appendix-qualified id, e.g. "1-15")
  // is confirmed present on disk. The 21 unverifiable ones keep their old numeric figureNum
  // (not in the index) and stay excluded.
  const pool = allPool.filter(q => (!q.figureNum || available.has(q.figureNum)) && !q.needsReview);
  if (!pool.length) return [];
  const take = Math.min(n, pool.length);
  const indices = shuffle([...Array(pool.length).keys()]).slice(0, take);
  const handbook = subject === 'general' ? 'FAA-H-8083-30B' : subject === 'airframe' ? 'FAA-H-8083-31B' : 'FAA-H-8083-32B';
  return indices.map(i => ({
    question:    pool[i].question,
    choices:     pool[i].choices,
    correct:     pool[i].correct,
    topic,
    subject,
    handbook,
    explanation: pool[i].explanation || '',
    source:      'faa',
    ...(pool[i].id != null ? { id: String(pool[i].id) } : {}),
    ...(pool[i].figureNum ? { figureNum: pool[i].figureNum } : {}),
  }));
}

// ── AI-generate questions for a topic (3-choice to match FAA format) ─────────
// Generated in small batches (≤8 per Claude call) so every question stays tightly on the
// SELECTED topic and its 8083 section — a single large request overflows the token budget and
// makes the model "pad" with off-topic general material to reach the count.
const AI_BATCH = 8;
async function generateForTopic(topic, qCount, content) {
  if (qCount < 1) return [];
  const subject = TOPIC_SUBJECT[topic] || 'general';
  const handbook = subject === 'general' ? 'FAA-H-8083-30B' : subject === 'airframe' ? 'FAA-H-8083-31B' : 'FAA-H-8083-32B';
  const sourceText = content[subject]?.[topic] || '';
  const contextSection = sourceText
    ? `\n\nBase every question ONLY on this reference text from ${handbook} (the "${topic}" section):\n\n${sourceText.slice(0, 6000)}`
    : '';

  const buildPrompt = (n) => `You are an FAA Aviation Maintenance Technician (AMT) exam question writer.

Generate ${n} multiple choice practice question${n > 1 ? 's' : ''} STRICTLY about the single topic: "${topic}" (${subject} subject). Every question must be specifically about ${topic} — do NOT write questions about any other ${subject} topic.${contextSection}

Rules:
- Each question has exactly 3 choices: A, B, C (this matches the real FAA AMT test format)
- EXACTLY ONE correct answer: the correct choice must be the ONLY true/defensible one; both wrong choices must be factually FALSE. Never let a distractor be an alternative correct statement or a second valid formula for what is asked (e.g., if the answer is P = V × I, do NOT use P = I² × R as a wrong choice since it is also correct — use a genuinely wrong formula like P = V / I). Before finalizing each question, re-read all three choices and confirm only one is correct.
- Prefer focused questions over compound ones ("what is X AND how is it calculated") — compound phrasing tends to make more than one choice partly correct.
- ONLY ONE choice is correct — verify that wrong answers are factually incorrect, not synonyms or paraphrases of the correct answer
- DISTRACTOR QUALITY (important): the two wrong answers must be moderately challenging — about a 7 out of 10 in how closely they relate to the correct answer. A well-prepared student should still pick the right one after careful reading, but a guesser must NOT be able to eliminate the wrong answers at a glance. Specifically:
  * Keep every choice in the SAME subject area and addressing the SAME concept as the question — NEVER use an obviously off-topic or absurd option (for example, do not put "computer programming skills" or "engine overhaul training" as a distractor on a human-factors question)
  * Build each wrong answer from a realistic mistake an AMT student might actually make: a common misconception, a true-but-irrelevant fact, a correct principle applied to the wrong situation, or the right idea with one key detail changed
  * Match the correct answer's length, specificity, terminology, and tone so the correct choice does not visibly stand out
  * Still keep each wrong answer unambiguously incorrect to a knowledgeable A&P technician — there must be exactly one defensible answer
- If the correct answer contains a number, ALL wrong answers must also contain a different specific number in the same units
- If the correct answer contains units (psi, inches, degrees, volts, etc.), ALL wrong answers must use those same units
- All choices should be similar in length and grammatical structure
- For the explanation field: write 1-2 sentences explaining WHY the correct answer is correct per FAA standards, then cite the specific chapter number and section name from ${handbook} where this is covered
- Return ONLY a valid JSON array, no markdown

Format: [{"question":"...","choices":{"A":"...","B":"...","C":"..."},"correct":"A","explanation":"..."}]`;

  // Split into batches of ≤AI_BATCH, all for the same topic, run in parallel.
  const batches = [];
  for (let remaining = qCount; remaining > 0; remaining -= AI_BATCH) {
    batches.push(Math.min(AI_BATCH, remaining));
  }
  try {
    const results = await Promise.all(batches.map(n =>
      callClaude(buildPrompt(n)).then(t => parseJSON(t)).catch(() => [])
    ));
    const seen = new Set();
    const out = [];
    for (const arr of results) {
      if (!Array.isArray(arr)) continue;
      for (const q of arr) {
        if (q && q.question && !seen.has(q.question)) {
          seen.add(q.question);
          out.push({ ...q, topic, handbook, source: 'ai' });
        }
      }
    }
    return out.slice(0, qCount);
  } catch { return []; }
}

// ── QC pass — only run on AI-generated questions ─────────────────────────────
async function qcBatch(questions) {
  if (!questions.length) return questions;

  const prompt = `You are a quality-control editor for FAA A&P exam questions. Review each question below and fix any issues with the answer choices.

Check for and fix:
0. EXACTLY ONE CORRECT ANSWER (most important): verify that ONLY the marked correct choice is factually true; the other two MUST be factually FALSE. If any wrong choice is ALSO a true/defensible statement or a valid alternative formula for what the question asks (for example, on "how is electrical power calculated" both "P = V × I" and "P = I² × R" are correct), REWRITE that choice so it is genuinely incorrect — use a wrong formula, a wrong definition, or a value that does not apply. After editing, re-read all three choices and confirm a knowledgeable A&P technician would accept one and reject the other two. Also avoid compound questions that invite multiple right answers.
1. If the correct answer has a number, every wrong answer must also have a DIFFERENT specific number (same units — do not drop units or change to a different unit type)
2. If the correct answer has units (psi, inches, degrees, rpm, volts, lbs, etc.), all wrong answers must use those exact same units
3. No wrong answer may be a synonym, paraphrase, or restatement of the correct answer — if one is, replace it with a factually incorrect but plausible alternative
4. No two wrong answers may mean the same thing — if two are similar, replace one
5. All choices should be similar in grammatical structure and length
6. Each wrong answer must be clearly incorrect per FAA standards
7. DISTRACTOR DIFFICULTY: replace any wrong answer that is off-topic, absurd, or eliminable without real subject knowledge. Every distractor must stay in the same subject area and address the same concept as the question, and should read as a realistic mistake (a common misconception, a true-but-irrelevant fact, or a correct principle applied to the wrong context). Aim for moderately challenging (about 7/10 related to the correct answer) while keeping exactly one defensible answer

Return the corrected questions as a JSON array in EXACTLY the same format, preserving all fields (question, choices, correct, explanation, topic, handbook, source). Do not change the question text or the correct answer's meaning — only fix the wrong answer choices (and, if a distractor was independently correct, make it incorrect). No markdown, just the JSON array.

Questions to review:
${JSON.stringify(questions)}`;

  try {
    const text = await callClaude(prompt, 4096);
    const arr = parseJSON(text);
    if (Array.isArray(arr) && arr.length === questions.length) return arr;
    return questions;
  } catch { return questions; }
}

// ── Mix FAA + AI questions for one topic ──────────────────────────────────────
async function buildTopicQuestions(topic, total, content, faaRatioOverride) {
  if (total < 1) return [];

  const bank = getFaaBank();
  const subject = TOPIC_SUBJECT[topic] || 'general';
  const bankPool = bank[subject]?.[topic];
  const bankSize = Array.isArray(bankPool) ? bankPool.length : 0;

  // Calculation-heavy topics → verified bank only (no AI arithmetic errors).
  // A caller-supplied ratio (e.g. focused exam = 0.5) overrides the random default.
  // Otherwise → random 20–60% FAA, rest AI, capped at what's available.
  const targetFaaPct = FAA_ONLY_TOPICS.has(topic) ? 1
    : (typeof faaRatioOverride === 'number' ? faaRatioOverride : (0.20 + Math.random() * 0.40));
  const faaCount = Math.min(Math.round(total * targetFaaPct), bankSize, total);
  const aiCount = total - faaCount;

  const [faaQuestions, aiQuestions] = await Promise.all([
    Promise.resolve(getFaaQuestions(topic, faaCount)),
    generateForTopic(topic, aiCount, content),
  ]);

  return [...faaQuestions, ...aiQuestions];
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topics, count, mode, faaRatio } = req.body || {};
  if (!Array.isArray(topics) || !topics.length) return res.status(400).json({ error: 'topics array required' });

  // MODE: 'all' — return EVERY stored bank question for the selected topics (no AI, no cap).
  if (mode === 'all') {
    const seen = new Set();
    const all = [];
    for (const t of topics) {
      for (const q of getFaaQuestions(t, 100000)) {
        if (!seen.has(q.question)) { seen.add(q.question); all.push(q); }
      }
    }
    if (!all.length) return res.status(502).json({ error: 'No stored questions found for the selected topics.' });
    shuffle(all);
    return res.status(200).json({ questions: all });
  }

  // Focused exam passes faaRatio (e.g. 0.5 = half verified FAA, half AI from the 8083).
  const fr = (typeof faaRatio === 'number' && faaRatio >= 0 && faaRatio <= 1) ? faaRatio : undefined;
  const total = Math.min(Math.max(parseInt(count) || 5, 1), 100);
  const n = Math.min(topics.length, total);
  const selectedTopics = n < topics.length
    ? shuffle(topics.slice()).slice(0, n)
    : topics;
  const base = Math.floor(total / n);
  const rem  = total % n;
  const counts = selectedTopics.map((_, i) => i < rem ? base + 1 : base);

  const content = getContent();

  try {
    // Step 1: Build each topic's question mix in parallel
    const batches = await Promise.all(
      selectedTopics.map((t, i) => buildTopicQuestions(t, counts[i], content, fr))
    );
    let questions = batches.flat();

    if (!questions.length) return res.status(502).json({ error: 'No questions generated. Please try again.' });

    // Step 2: QC pass — only on AI-generated questions (in chunks of 10)
    const aiQs   = questions.filter(q => q.source === 'ai');
    const faaQs  = questions.filter(q => q.source === 'faa');
    const chunks = [];
    for (let i = 0; i < aiQs.length; i += 10) chunks.push(aiQs.slice(i, i + 10));
    const reviewed = await Promise.all(chunks.map(c => qcBatch(c)));
    questions = [...faaQs, ...reviewed.flat()];

    // Step 2.5: Backfill from the FAA bank if the AI under-generated, so the
    // exam always reaches `total` whenever enough unique questions exist.
    if (questions.length < total) {
      const used = new Set(questions.map(q => q.question));
      const extras = [];
      for (const t of selectedTopics) {
        for (const q of getFaaQuestions(t, 1000)) {        // whole available pool for the topic
          if (!used.has(q.question)) { used.add(q.question); extras.push(q); }
        }
      }
      shuffle(extras);
      for (const q of extras) { if (questions.length >= total) break; questions.push(q); }
    }

    // Step 3: Shuffle and trim
    shuffle(questions);
    questions = questions.slice(0, total);

    return res.status(200).json({ questions });
  } catch (err) {
    console.error('generate error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
