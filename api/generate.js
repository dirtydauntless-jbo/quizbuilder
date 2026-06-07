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

// ── Lazy-load O&P (oral & practical) study questions ─────────────────────────
let _opBank = null;
function getOPBank() {
  if (_opBank === null) {
    try { _opBank = require(path.join(process.cwd(), 'op_questions.json')); }
    catch { _opBank = {}; }
  }
  return _opBank;
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

// Spec/timing-heavy topics where AI is shakier on precise facts → lean harder on the verified
// bank (≥75% FAA), so only a small share is AI-generated.
const HIGH_FAA_TOPICS = new Set([
  'Reciprocating Engines',
  'Turbine Engines',
  'Reciprocating Engine Induction and Cooling',
  'Ignition and Starting Systems',
  'Engine Fuel and Fuel Metering Systems'
]);
const HIGH_FAA_MIN = 0.75;

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

// ── Answer-choice evaluation helpers ─────────────────────────────────────────
function _normChoice(s){ return String(s==null?'':s).toLowerCase().replace(/\s+/g,' ').replace(/[.;,·\s]+$/,'').trim(); }
// True only if every choice is non-empty and no two are textually equivalent
function choicesAllDistinct(choices){
  const vals = Object.values(choices || {}).map(_normChoice);
  if (!vals.length || vals.some(v => !v)) return false;
  return new Set(vals).size === vals.length;
}
// Randomize which letter holds the correct answer (keeps text↔correct mapping intact)
function shuffleChoicePositions(q){
  const letters = Object.keys(q.choices || {});
  if (letters.length < 2 || !q.correct || !(q.correct in q.choices)) return q;
  const entries = letters.map(l => ({ isCorrect: l === q.correct, val: q.choices[l] }));
  shuffle(entries);
  const nc = {}; let cor = letters[0];
  entries.forEach((e, i) => { nc[letters[i]] = e.val; if (e.isCorrect) cor = letters[i]; });
  q.choices = nc; q.correct = cor;
  return q;
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
  const SLICE = 7000;
  // Rotate the reference window across the whole section per batch, so generated questions
  // cover the entire 8083 chapter (and probe deeper material) instead of only the opening.
  const ctxFor = (b, nBatches) => {
    if (!sourceText) return '';
    let slice;
    if (sourceText.length <= SLICE) slice = sourceText;
    else {
      const step = Math.max(1, Math.floor((sourceText.length - SLICE) / Math.max(1, nBatches)));
      const start = Math.min(sourceText.length - SLICE, b * step + Math.floor(Math.random() * step));
      slice = sourceText.slice(start, start + SLICE);
    }
    return `\n\nBase every question ONLY on this reference text from ${handbook} (the "${topic}" section). Draw from ACROSS this passage — including details, procedures, limits, and exceptions — not just the first sentences:\n\n${slice}`;
  };

  const buildPrompt = (n, ctx) => `You are an FAA Aviation Maintenance Technician (AMT) exam question writer.

Generate ${n} CHALLENGING multiple choice practice question${n > 1 ? 's' : ''} STRICTLY about the single topic: "${topic}" (${subject} subject). Every question must be specifically about ${topic} — do NOT write questions about any other ${subject} topic.${ctx}

Rules:
- DIFFICULTY (important): write at or above the real FAA written-test level. Favor questions that make the student APPLY or INTERPRET the material — scenarios ("a technician finds…/ what should be done"), cause-and-effect, limits/tolerances, procedures, comparisons, and calculations where appropriate — over simple "what is the definition of X" recall. Pull specific facts (values, steps, exceptions) from the reference passage so a student must actually know the material, not just eliminate silly options.
- Each question has exactly 3 choices: A, B, C (this matches the real FAA AMT test format)
- ACCURACY: the marked correct answer MUST be factually correct and supported by the reference text. Re-verify it against the passage before finalizing — never mark a wrong choice as correct.
- EXACTLY ONE correct answer: the correct choice must be the ONLY true/defensible one; both wrong choices must be factually FALSE. Never let a distractor be an alternative correct statement or a second valid formula for what is asked (e.g., if the answer is P = V × I, do NOT use P = I² × R as a wrong choice since it is also correct — use a genuinely wrong formula like P = V / I). Before finalizing each question, re-read all three choices and confirm only one is correct.
- LAW / FORMULA REARRANGEMENTS: never ask an open-ended question whose choices are just different correct rearrangements of the same law. For example, do NOT ask "what is the relationship between voltage, current, and resistance?" with choices V = I × R, I = V / R, R = V / I — all three are correct. Instead ask a question that targets ONE form (e.g., "Which equation is used to find resistance when voltage and current are known?" → only R = V / I is correct, and the other two choices must be WRONG rearrangements such as R = I / V or R = I × V).
- Prefer focused questions over compound ones ("what is X AND how is it calculated") — compound phrasing tends to make more than one choice partly correct.
- ONLY ONE choice is correct — verify that wrong answers are factually incorrect, not synonyms or paraphrases of the correct answer
- ALL THREE choices must be DISTINCT IN MEANING: no two choices may say the same thing, be paraphrases, or describe the same outcome in different words. Every choice must be clearly different.
- DISTRACTOR QUALITY (important): the two wrong answers must be moderately challenging — about a 7 out of 10 in how closely they relate to the correct answer. A well-prepared student should still pick the right one after careful reading, but a guesser must NOT be able to eliminate the wrong answers at a glance. Specifically:
  * Keep every choice in the SAME subject area and addressing the SAME concept as the question — NEVER use an obviously off-topic or absurd option (for example, do not put "computer programming skills" or "engine overhaul training" as a distractor on a human-factors question)
  * Build each wrong answer from a realistic mistake an AMT student might actually make: a common misconception, a true-but-irrelevant fact, a correct principle applied to the wrong situation, or the right idea with one key detail changed
  * Match the correct answer's length, specificity, terminology, and tone so the correct choice does not visibly stand out
  * Still keep each wrong answer unambiguously incorrect to a knowledgeable A&P technician — there must be exactly one defensible answer
- If the correct answer contains a number, ALL wrong answers must also contain a different specific number in the same units
- If the correct answer contains units (psi, inches, degrees, volts, etc.), ALL wrong answers must use those same units
- All choices should be similar in length and grammatical structure
- For the explanation field: write 1-2 sentences explaining WHY the correct answer is correct per FAA standards. Do NOT reference any choice by its letter (never write "Choice A/B/C" or "option B") — the choice order is randomized afterward, so refer to options by their wording/content if you must mention them. Do NOT cite or include the handbook designation — never write "${handbook}" or "FAA-H-8083" in the explanation. Keep it about the concept itself; you may name the relevant subject/chapter topic in plain words if useful.
- Return ONLY a valid JSON array, no markdown

Format: [{"question":"...","choices":{"A":"...","B":"...","C":"..."},"correct":"A","explanation":"..."}]`;

  // Split into batches of ≤AI_BATCH, all for the same topic, run in parallel.
  const batches = [];
  for (let remaining = qCount; remaining > 0; remaining -= AI_BATCH) {
    batches.push(Math.min(AI_BATCH, remaining));
  }
  try {
    const results = await Promise.all(batches.map((n, b) =>
      callClaude(buildPrompt(n, ctxFor(b, batches.length))).then(t => parseJSON(t)).catch(() => [])
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

// ── Convert O&P (oral & practical) study Q&A into 3-choice multiple-choice ────
// The O&P answer becomes the correct choice; the AI writes two plausible wrong choices.
async function generateFromOP(topic, qCount) {
  if (qCount < 1) return [];
  const subject = TOPIC_SUBJECT[topic] || 'general';
  const op = getOPBank();
  const pool = op[subject] && op[subject][topic];
  if (!Array.isArray(pool) || !pool.length) return [];
  const handbook = subject === 'general' ? 'FAA-H-8083-30B' : subject === 'airframe' ? 'FAA-H-8083-31B' : 'FAA-H-8083-32B';
  const picks = shuffle(pool.slice()).slice(0, Math.min(qCount, pool.length));
  const out = [];
  for (let i = 0; i < picks.length; i += AI_BATCH) {
    const batch = picks.slice(i, i + AI_BATCH);
    const prompt = `You convert FAA oral & practical (O&P) study questions into 3-choice multiple-choice exam questions, all on the topic "${topic}".
For EACH item below (a question and its correct answer), write ONE multiple-choice question:
- Keep the question's meaning; you may lightly reword for a written-test format.
- The CORRECT choice must be a concise statement of the provided correct answer.
- Write TWO incorrect but plausible distractors in the same style and length. They must be factually FALSE, stay on the "${topic}" topic, and leave EXACTLY ONE correct choice — never make a distractor that is also true. All three choices must be DISTINCT IN MEANING — no two may be paraphrases or convey the same idea.
- explanation: 1-2 sentences on why the answer is correct. Do NOT reference choices by letter (no "Choice A/B/C") since order is randomized, and do NOT mention any handbook number.
Return ONLY a JSON array, same order as the items: [{"question":"...","choices":{"A":"...","B":"...","C":"..."},"correct":"A","explanation":"..."}]
Items:
${JSON.stringify(batch.map(c => ({ question: c.q, answer: c.a })))}`;
    try {
      const arr = parseJSON(await callClaude(prompt, 4096));
      if (Array.isArray(arr)) arr.forEach(q => { if (q && q.question && q.choices) out.push({ ...q, topic, subject, handbook, source: 'op' }); });
    } catch { /* skip this batch */ }
  }
  return out.slice(0, qCount);
}

// ── QC pass — run on AI-generated and O&P-converted questions ────────────────
async function qcBatch(questions) {
  if (!questions.length) return questions;

  const prompt = `You are a quality-control editor for FAA A&P exam questions. Review each question below and fix any issues with the answer choices.

Check for and fix:
0a. ACCURACY: confirm the marked correct answer is factually correct per FAA standards. If the marked answer is actually wrong, fix it — re-mark the truly correct choice, or correct that choice's wording. Never leave a wrong answer marked correct.
0b. DIFFICULTY: if a question is trivially easy or answerable without real subject knowledge (obvious answer, silly distractors), rewrite it to FAA-written-test level — make the distractors plausible and, where natural, turn it into an application/scenario question. Keep it accurate.
0. EXACTLY ONE CORRECT ANSWER (most important): verify that ONLY the marked correct choice is factually true; the other two MUST be factually FALSE. If any wrong choice is ALSO a true/defensible statement or a valid alternative formula for what the question asks, REWRITE that choice so it is genuinely incorrect — use a wrong formula, a wrong definition, or a value that does not apply. Two common traps to fix: (a) multiple valid formulas for the same quantity (e.g., "how is electrical power calculated" with both P = V × I and P = I² × R) and (b) a law asked open-endedly whose choices are just correct rearrangements (e.g., "relationship between voltage, current, resistance?" with V = I × R, I = V / R, and R = V / I — all correct). In these cases, keep the marked answer and rewrite the OTHER choices into incorrect rearrangements/formulas (e.g., R = I / V, P = V / I) so only one choice is right. After editing, re-read all three choices and confirm a knowledgeable A&P technician would accept exactly one and reject the other two.
1. If the correct answer has a number, every wrong answer must also have a DIFFERENT specific number (same units — do not drop units or change to a different unit type)
2. If the correct answer has units (psi, inches, degrees, rpm, volts, lbs, etc.), all wrong answers must use those exact same units
3. No wrong answer may be a synonym, paraphrase, or restatement of the correct answer — if one is, replace it with a factually incorrect but plausible alternative
4. ALL THREE choices must be DISTINCT IN MEANING — no two of the three may say the same thing, be paraphrases of each other, or describe the same outcome with different wording (this applies to the correct choice vs a distractor AND to the two distractors). If any two convey the same idea, rewrite one into a clearly different, factually incorrect statement.
5. All choices should be similar in grammatical structure and length
6. Each wrong answer must be clearly incorrect per FAA standards
7. DISTRACTOR DIFFICULTY: replace any wrong answer that is off-topic, absurd, or eliminable without real subject knowledge. Every distractor must stay in the same subject area and address the same concept as the question, and should read as a realistic mistake (a common misconception, a true-but-irrelevant fact, or a correct principle applied to the wrong context). Aim for moderately challenging (about 7/10 related to the correct answer) while keeping exactly one defensible answer

8. EXPLANATION must NOT reference choices by letter (no "Choice A/B/C" or "option B") — the choice order is randomized after this step, so any letter reference will be wrong. Rewrite such references to describe the option by its content, or just explain why the correct answer is right.

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

// ── Dedicated semantic-distinctness vet (runs AFTER qcBatch on AI/O&P questions) ─
// qcBatch is a broad checklist where "distinct meaning" is just one of many items, so it
// can get under-weighted. This pass does exactly ONE job: catch answer choices that MEAN
// the same thing even when worded differently (synonyms, paraphrases, equivalent numbers/
// units, restated outcomes) and rewrite the offender so all three choices are clearly
// distinct with exactly one correct. Anything it genuinely cannot make distinct gets its
// `correct` blanked so the caller's filter drops it (better to drop than to ship a dud).
async function vetDistinctChoices(questions) {
  if (!questions.length) return questions;

  const prompt = `You are a strict FAA A&P exam answer-choice auditor. Your ONLY job is to guarantee that no two of a question's three choices mean the same thing.

For EACH question below:
- Compare the three choices pairwise (A vs B, A vs C, B vs C).
- Treat two choices as EQUIVALENT (a violation) if a knowledgeable A&P technician would read them as saying the SAME thing, even when the wording differs. This includes: synonyms or paraphrases ("prevents corrosion" vs "stops rust"; "increases" vs "becomes greater"), the same outcome restated ("the engine will not start" vs "the engine fails to start"), and numerically/dimensionally equal values ("0.5 in" vs "1/2 inch" vs ".50\""; "32°F" vs "0°C").
- If ANY pair is equivalent, KEEP the marked correct choice exactly as-is and REWRITE the other offending choice into a clearly DIFFERENT, factually FALSE but plausible distractor on the same topic — matching the correct choice's length, units, and style — so that all three choices are now distinct in meaning and exactly ONE is correct.
- If two equivalent choices were BOTH essentially the correct answer, keep the correct one and replace the other with a genuinely wrong distractor.
- Do NOT change the question text, the correct answer's meaning, or the explanation — except remove any "Choice A/B/C"/"option B" letter reference (choice order is randomized later).
- If you genuinely cannot produce three distinct-meaning choices for a question, set its "correct" field to "" (empty string) so it will be discarded.

Return a JSON array in the SAME order and format, preserving ALL fields present on each item (question, choices, correct, explanation, topic, handbook, source, subject, id, figureNum). No markdown — just the JSON array.

Questions:
${JSON.stringify(questions)}`;

  try {
    const arr = parseJSON(await callClaude(prompt, 4096));
    if (Array.isArray(arr) && arr.length === questions.length) return arr;
    return questions;
  } catch { return questions; }
}

// ── Mix FAA + O&P + AI questions for one topic ───────────────────────────────
async function buildTopicQuestions(topic, total, content, faaRatioOverride, opRatioOverride) {
  if (total < 1) return [];

  const bank = getFaaBank();
  const subject = TOPIC_SUBJECT[topic] || 'general';
  const bankPool = bank[subject]?.[topic];
  const bankSize = Array.isArray(bankPool) ? bankPool.length : 0;
  const isFaaOnly = FAA_ONLY_TOPICS.has(topic);

  // Calculation-heavy topics → verified bank only (no AI/O&P arithmetic errors).
  // Otherwise: caller may request a FAA share (focused exam = 0.5) and an O&P share (0.25);
  // the remainder is AI from the 8083. Default (official exams) = random 20–60% FAA, rest AI.
  let faaPct = isFaaOnly ? 1
    : (typeof faaRatioOverride === 'number' ? faaRatioOverride : (0.20 + Math.random() * 0.40));
  // Spec/timing-heavy topics lean harder on the verified bank (less AI exposure)
  if(!isFaaOnly && HIGH_FAA_TOPICS.has(topic)) faaPct = Math.max(faaPct, HIGH_FAA_MIN);
  const opPct  = isFaaOnly ? 0 : (typeof opRatioOverride === 'number' ? opRatioOverride : 0);

  let faaCount = Math.min(Math.round(total * faaPct), bankSize, total);
  let opCount  = Math.min(Math.round(total * opPct), Math.max(0, total - faaCount));
  let aiCount  = Math.max(0, total - faaCount - opCount);

  const [faaQuestions, opQuestions, aiQuestions] = await Promise.all([
    Promise.resolve(getFaaQuestions(topic, faaCount)),
    generateFromOP(topic, opCount),
    generateForTopic(topic, aiCount, content),
  ]);

  return [...faaQuestions, ...opQuestions, ...aiQuestions];
}

// ── Handler ───────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topics, count, mode, faaRatio, opRatio } = req.body || {};
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
    return res.status(200).json({ questions: all.filter(q => choicesAllDistinct(q.choices)) });
  }

  // Focused exam passes faaRatio (0.5 = half verified FAA) and opRatio (0.4 = O&P share);
  // the remainder (~0.1) is AI from the 8083.
  const fr = (typeof faaRatio === 'number' && faaRatio >= 0 && faaRatio <= 1) ? faaRatio : undefined;
  const or = (typeof opRatio === 'number' && opRatio >= 0 && opRatio <= 1) ? opRatio : undefined;
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
      selectedTopics.map((t, i) => buildTopicQuestions(t, counts[i], content, fr, or))
    );
    let questions = batches.flat();

    if (!questions.length) return res.status(502).json({ error: 'No questions generated. Please try again.' });

    // Step 2: QC pass — on AI-generated AND O&P-converted questions (in chunks of 10)
    const genQs  = questions.filter(q => q.source === 'ai' || q.source === 'op');
    const faaQs  = questions.filter(q => q.source === 'faa');
    const chunks = [];
    for (let i = 0; i < genQs.length; i += 10) chunks.push(genQs.slice(i, i + 10));
    const reviewed = await Promise.all(chunks.map(c => qcBatch(c)));
    let genReviewed = reviewed.flat();

    // Step 2.2: dedicated semantic-distinctness vet — catch choices that MEAN the same thing
    // even when worded differently (the broad qcBatch can miss these). Re-chunk and run focused.
    const vchunks = [];
    for (let i = 0; i < genReviewed.length; i += 10) vchunks.push(genReviewed.slice(i, i + 10));
    const vetted = await Promise.all(vchunks.map(c => vetDistinctChoices(c)));
    questions = [...faaQs, ...vetted.flat()];

    // Step 2.4: drop any question whose choices aren't all distinct OR whose correct answer is
    // missing/invalid (the vet blanks `correct` on questions it could not make distinct).
    questions = questions.filter(q => choicesAllDistinct(q.choices) && q.correct && q.choices && (q.correct in q.choices));

    // Step 2.5: Backfill from the FAA bank if we're short, so the exam still reaches `total`.
    if (questions.length < total) {
      const used = new Set(questions.map(q => q.question));
      const extras = [];
      for (const t of selectedTopics) {
        for (const q of getFaaQuestions(t, 1000)) {        // whole available pool for the topic
          if (!used.has(q.question) && choicesAllDistinct(q.choices)) { used.add(q.question); extras.push(q); }
        }
      }
      shuffle(extras);
      for (const q of extras) { if (questions.length >= total) break; questions.push(q); }
    }

    // Step 3: evaluate choices — randomize the correct answer's position on AI questions
    // (so it isn't always "A") and strip any leftover handbook citation, then shuffle + trim.
    questions.forEach(q => {
      if (q.source === 'ai' || q.source === 'op') {
        shuffleChoicePositions(q);
        if (q.explanation) {
          q.explanation = q.explanation
            .replace(/\s*\((?:ref:?\s*)?FAA-H-8083[^)]*\)/gi, '')   // drop "(Ref: FAA-H-8083-30B, Ch ...)"
            .replace(/\s*(?:per|see|ref(?:erence)?:?)?\s*FAA-H-8083-?\d*[AB]?[^.]*/gi, '') // drop bare mentions
            .replace(/\s{2,}/g, ' ').replace(/\s+([.,;])/g, '$1').trim();
        }
      }
    });
    shuffle(questions);
    questions = questions.slice(0, total);

    return res.status(200).json({ questions });
  } catch (err) {
    console.error('generate error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
