module.exports.config = { maxDuration: 60 };

const path = require('path');
let _content = null;
function getContent() {
  if (!_content) {
    try { _content = require(path.join(process.cwd(), '8083_content.json')); } catch { _content = {}; }
  }
  return _content;
}

// Which handbook each topic belongs to
const TOPIC_SUBJECT = {};
const SUBJECT_TOPICS = {
  general:    ['Aircraft Drawings','Aircraft Material Hardware and Processes','Cleaning and Corrosion Control','Fluid Lines and Fittings','Forms and Regulations','Fundamentals of Electricity','Ground Operations and Servicing','Human Factors','Inspection Concepts and Techniques','Mathematics','Physics','Weight and Balance'],
  airframe:   ['Aircraft Electrical Systems','Aircraft Fuel Systems','Aircraft Instrument Systems','Airframe Inspection','Communications and Navigation Systems','Environmental Systems','Fire Protection','Flight Controls','Hydraulic and Pneumatic Systems','Ice and Rain Control Systems','Landing Gear','Metallic Structures','Nonmetallic Structures','Rotorcraft'],
  powerplant: ['Engine Electrical Systems','Engine Exhaust and Reverser Systems','Engine Fire Protection Systems','Engine Fuel and Fuel Metering Systems','Engine Inspection','Engine Instrument Systems','Engine Lubrication Systems','Ignition and Starting Systems','Propellers','Reciprocating Engines','Reciprocating Engine Induction and Cooling','Turbine Engine Air Systems','Turbine Engines']
};
for (const [subj, topics] of Object.entries(SUBJECT_TOPICS)) {
  for (const t of topics) TOPIC_SUBJECT[t] = subj;
}

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
    ? topics.slice().sort(() => Math.random() - 0.5).slice(0, n)
    : topics;
  const base = Math.floor(total / n);
  const rem = total % n;
  const counts = selectedTopics.map((_, i) => i < rem ? base + 1 : base);

  const content = getContent();

  async function askTopic(topic, qCount) {
    if (qCount < 1) return [];
    const subject = TOPIC_SUBJECT[topic] || 'general';
    const sourceText = content[subject]?.[topic] || '';
    const contextSection = sourceText
      ? `\n\nUse this reference text from the FAA ${subject === 'general' ? '8083-30' : subject === 'airframe' ? '8083-31' : '8083-32'} handbook to inform your questions:\n\n${sourceText.slice(0, 4000)}`
      : '';

    const prompt = `You are an FAA Aviation Maintenance Technician (AMT) exam question writer.

Generate ${qCount} multiple choice practice question${qCount > 1 ? 's' : ''} specifically about: ${topic}${contextSection}

Rules:
- Base questions on real FAA A&P exam content for this topic
- Each question must have exactly 4 answer choices labeled A, B, C, D
- CRITICAL — only ONE answer choice may be correct. Before finalizing each question, verify that the 3 wrong answers are FACTUALLY INCORRECT — not just differently worded versions of the right answer. If two choices could both be argued as correct, rewrite the wrong ones until they are unambiguously false.
- Wrong answers must be plausible and in the same category as the correct answer (same units, same type of thing) but must be definitively wrong per FAA standards
- Do NOT use synonyms, paraphrases, or partial truths as distractors — each wrong answer must be clearly incorrect when checked against the FAA handbook
- Wrong answers should reflect specific common misconceptions, wrong values, or incorrect procedures — not vague or opposite answers
- Questions must match the difficulty of the FAA A&P written exam
- Return ONLY a valid JSON array — no markdown, no explanation, no code blocks

Format:
[{"question":"...","choices":{"A":"...","B":"...","C":"...","D":"..."},"correct":"A"}]`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 4096, messages: [{ role: 'user', content: prompt }] })
    });
    if (!r.ok) { console.error(`Topic "${topic}" API error`, r.status); return []; }
    const d = await r.json();
    const text = d.content?.[0]?.text || '';
    try {
      const arr = JSON.parse(text);
      return Array.isArray(arr) ? arr.map(q => ({ ...q, topic })) : [];
    } catch {
      const m = text.match(/\[[\s\S]*?\]/);
      if (!m) return [];
      try { return JSON.parse(m[0]).map(q => ({ ...q, topic })); } catch { return []; }
    }
  }

  try {
    const batches = await Promise.all(selectedTopics.map((t, i) => askTopic(t, counts[i])));
    let questions = batches.flat();
    for (let i = questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [questions[i], questions[j]] = [questions[j], questions[i]];
    }
    questions = questions.slice(0, total);
    if (!questions.length) return res.status(502).json({ error: 'No questions generated. Please try again.' });
    return res.status(200).json({ questions });
  } catch (err) {
    console.error('generate error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
