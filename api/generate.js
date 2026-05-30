module.exports.config = { maxDuration: 60 };

const path = require('path');

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

// ── Lazy-load figures index (figure label → filename) ────────────────────────
let _figIndex = null;
function getFigureIndex() {
  if (_figIndex === null) {
    try { _figIndex = require(path.join(process.cwd(), 'figures-index.json')); }
    catch { _figIndex = {}; }
  }
  return _figIndex;
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
  const figIndex = getFigureIndex();
  const allPool = bank[subject]?.[topic];
  if (!Array.isArray(allPool) || !allPool.length) return [];
  // Exclude figure questions whose image isn't in the figures index
  const pool = allPool.filter(q => !q.figureNum || figIndex[q.figureNum]);
  if (!pool.length) return [];
  const available = Math.min(n, pool.length);
  const indices = shuffle([...Array(pool.length).keys()]).slice(0, available);
  const handbook = subject === 'general' ? 'FAA-H-8083-30A' : subject === 'airframe' ? 'FAA-H-8083-31B' : 'FAA-H-8083-32A';
  return indices.map(i => ({
    question:    pool[i].question,
    choices:     pool[i].choices,
    correct:     pool[i].correct,
    topic,
    handbook,
    explanation: '',
    source:      'faa',
    ...(pool[i].figureNum ? { figureNum: pool[i].figureNum } : {}),
  }));
}

// ── AI-generate questions for a topic (3-choice to match FAA format) ─────────
async function generateForTopic(topic, qCount, content) {
  if (qCount < 1) return [];
  const subject = TOPIC_SUBJECT[topic] || 'general';
  const handbook = subject === 'general' ? 'FAA-H-8083-30A' : subject === 'airframe' ? 'FAA-H-8083-31B' : 'FAA-H-8083-32A';
  const sourceText = content[subject]?.[topic] || '';
  const contextSection = sourceText
    ? `\n\nReference text from ${handbook}:\n\n${sourceText.slice(0, 4000)}`
    : '';

  const prompt = `You are an FAA Aviation Maintenance Technician (AMT) exam question writer.

Generate ${qCount} multiple choice practice question${qCount > 1 ? 's' : ''} about: ${topic}${contextSection}

Rules:
- Each question has exactly 3 choices: A, B, C (this matches the real FAA AMT test format)
- ONLY ONE choice is correct — verify that wrong answers are factually incorrect, not synonyms or paraphrases of the correct answer
- Wrong answers must be plausible but unambiguously wrong per FAA standards
- If the correct answer contains a number, ALL wrong answers must also contain a different specific number in the same units
- If the correct answer contains units (psi, inches, degrees, volts, etc.), ALL wrong answers must use those same units
- All choices should be similar in length and grammatical structure
- For the explanation field: write 1-2 sentences explaining WHY the correct answer is correct per FAA standards, then cite the specific chapter number and section name from ${handbook} where this is covered
- Return ONLY a valid JSON array, no markdown

Format: [{"question":"...","choices":{"A":"...","B":"...","C":"..."},"correct":"A","explanation":"..."}]`;

  try {
    const text = await callClaude(prompt);
    const arr = parseJSON(text);
    return Array.isArray(arr) ? arr.map(q => ({ ...q, topic, handbook, source: 'ai' })) : [];
  } catch { return []; }
}

// ── QC pass — only run on AI-generated questions ─────────────────────────────
async function qcBatch(questions) {
  if (!questions.length) return questions;

  const prompt = `You are a quality-control editor for FAA A&P exam questions. Review each question below and fix any issues with the answer choices.

Check for and fix:
1. If the correct answer has a number, every wrong answer must also have a DIFFERENT specific number (same units — do not drop units or change to a different unit type)
2. If the correct answer has units (psi, inches, degrees, rpm, volts, lbs, etc.), all wrong answers must use those exact same units
3. No wrong answer may be a synonym, paraphrase, or restatement of the correct answer — if one is, replace it with a factually incorrect but plausible alternative
4. No two wrong answers may mean the same thing — if two are similar, replace one
5. All choices should be similar in grammatical structure and length
6. Each wrong answer must be clearly incorrect per FAA standards

Return the corrected questions as a JSON array in EXACTLY the same format, preserving all fields (question, choices, correct, explanation, topic, handbook, source). Do not change questions, correct answers, or explanations — only fix wrong answer choices if needed. No markdown, just the JSON array.

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
async function buildTopicQuestions(topic, total, content) {
  if (total < 1) return [];

  const bank = getFaaBank();
  const subject = TOPIC_SUBJECT[topic] || 'general';
  const bankPool = bank[subject]?.[topic];
  const bankSize = Array.isArray(bankPool) ? bankPool.length : 0;

  // Randomly choose FAA ratio between 20–60%, but cap at what's available
  const targetFaaPct = 0.20 + Math.random() * 0.40;  // 20%–60%
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

  const { topics, count } = req.body || {};
  if (!Array.isArray(topics) || !topics.length) return res.status(400).json({ error: 'topics array required' });

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
      selectedTopics.map((t, i) => buildTopicQuestions(t, counts[i], content))
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

    // Step 3: Shuffle and trim
    shuffle(questions);
    questions = questions.slice(0, total);

    return res.status(200).json({ questions });
  } catch (err) {
    console.error('generate error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
