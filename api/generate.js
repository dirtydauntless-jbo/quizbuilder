module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { topics, count = 5 } = req.body || {};

  if (!topics || !Array.isArray(topics) || topics.length === 0) {
    return res.status(400).json({ error: 'topics array is required' });
  }

  const safeCount = Math.min(Math.max(parseInt(count) || 5, 1), 20);
  const topicList = topics.slice(0, 20).join(', ');

  const prompt = `You are an FAA Aviation Maintenance Technician (AMT) exam question writer.

Generate ${safeCount} multiple choice practice questions spanning these FAA A&P topics: ${topicList}

Rules:
- Distribute questions across the listed topics (do not focus on only one)
- Each question must have exactly 4 answer choices labeled A, B, C, D
- Wrong answers must be plausible — same units, same category, subtly wrong (not obviously wrong)
- Wrong answers should reflect common misconceptions or close-but-incorrect values
- Questions must be at the level of the FAA A&P written exam
- Do not repeat questions
- Return ONLY a valid JSON array with no explanation, no markdown, no code blocks

Format:
[
  {
    "question": "...",
    "choices": { "A": "...", "B": "...", "C": "...", "D": "..." },
    "correct": "A"
  }
]`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic API error:', err);
      return res.status(502).json({ error: 'Failed to reach AI service' });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '';

    let questions;
    try {
      questions = JSON.parse(text);
    } catch {
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) return res.status(502).json({ error: 'Invalid response from AI service' });
      questions = JSON.parse(match[0]);
    }

    if (!Array.isArray(questions)) {
      return res.status(502).json({ error: 'Unexpected response format' });
    }

    return res.status(200).json({ questions });
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
