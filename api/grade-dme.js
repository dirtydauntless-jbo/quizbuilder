// DME Mode — grades a student's typed oral-exam answer against the reference answer,
// the way a Designated Mechanic Examiner would: lenient on phrasing/spelling, strict on concept.
const MAX_FIELD_LEN = 3000;

async function callClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 300, messages: [{ role: 'user', content: prompt }] })
  });
  if (!r.ok) throw new Error(`API ${r.status}`);
  const d = await r.json();
  return (d.content || []).map(b => b.text || '').join('');
}

function buildPrompt(question, correctAnswer, studentAnswer) {
  return `You are grading a student's typed answer to an FAA Airframe & Powerplant oral exam question, the way a DME (Designated Mechanic Examiner) would in person: lenient on wording, spelling, and phrasing order, but strict on whether the core aviation maintenance concept is correct and complete enough to satisfy an examiner.

Question: ${question}
Reference answer: ${correctAnswer}
Student's answer: ${studentAnswer}

Grade the student's answer against the reference answer. Respond with JSON only, no other text, in exactly this shape:
{"verdict":"correct"|"partial"|"incorrect","feedback":"one or two short sentences addressed directly to the student"}

Guidelines:
- "correct": captures the essential concept(s), minor wording/spelling differences are fine, doesn't need to be verbatim or include every number unless a specific number/spec IS the answer.
- "partial": gets part of it right but is missing a meaningful piece, or is vague.
- "incorrect": wrong concept, off-topic, or empty.
Keep feedback encouraging but honest.`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { question, correctAnswer, studentAnswer } = req.body || {};
  if (!question || !correctAnswer || typeof studentAnswer !== 'string') {
    return res.status(400).json({ error: 'question, correctAnswer, and studentAnswer are required' });
  }
  if (!studentAnswer.trim()) {
    return res.status(200).json({ verdict: 'incorrect', feedback: 'Type an answer before submitting so it can be graded.' });
  }

  const q = String(question).slice(0, MAX_FIELD_LEN);
  const a = String(correctAnswer).slice(0, MAX_FIELD_LEN);
  const sa = studentAnswer.slice(0, MAX_FIELD_LEN);

  try {
    const raw = await callClaude(buildPrompt(q, a, sa));
    const jsonText = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    const parsed = JSON.parse(jsonText);
    const verdict = ['correct', 'partial', 'incorrect'].includes(parsed.verdict) ? parsed.verdict : 'partial';
    const feedback = typeof parsed.feedback === 'string' && parsed.feedback.trim() ? parsed.feedback.trim().slice(0, 400) : 'Compare your answer to the reference below.';
    return res.status(200).json({ verdict, feedback });
  } catch (e) {
    return res.status(502).json({ error: 'Grading is temporarily unavailable. Compare your answer to the reference below.' });
  }
};
