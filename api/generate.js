module.exports.config = { maxDuration: 60 };

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topics, count } = req.body || {};
  if (!Array.isArray(topics) || !topics.length) return res.status(400).json({ error: 'topics array required' });

  const total = Math.min(Math.max(parseInt(count) || 5, 1), 100);

  // Distribute question count evenly across topics
  const n = Math.min(topics.length, total);
  const selectedTopics = n < topics.length
    ? topics.slice().sort(() => Math.random() - 0.5).slice(0, n)
    : topics;
  const base = Math.floor(total / n);
  const rem = total % n;
  const counts = selectedTopics.map((_, i) => i < rem ? base + 1 : base);

  async function askTopic(topic, qCount) {
    if (qCount < 1) return [];
    const prompt = `You are an FAA Aviation Maintenance Technician (AMT) exam question writer.

Generate ${qCount} multiple choice practice question${qCount > 1 ? 's' : ''} specifically about: ${topic}

Rules:
- Each question must have exactly 4 answer choices labeled A, B, C, D
- Wrong answers must be plausible — same units, same category, subtly wrong, not obviously wrong
- Wrong answers should reflect real common misconceptions
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
    // Shuffle
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
