// Emails a student's weak-area practice-report breakdown directly to an instructor's email
// address — the alternative to the in-site "Send to Instructor" delivery (index.html
// pxSendReportTo), which requires the instructor to already have a classroomamt account that
// shows up in the instructorDirectory search. This path needs no account on either side.
//
// Sends over raw SMTPS (no npm dependency) because package.json/package-lock.json are
// git-ignored in this repo (see .gitignore) — anything added there never reaches Vercel's
// build, so a nodemailer require() would crash at runtime in production. Every other api/*.js
// function in this repo is dependency-free for the same reason (fetch is a Node built-in).
const tls = require('tls');

const MAX_STR = 200;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SMTP_TIMEOUT_MS = 15000;

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// RFC 2047 encoded-word — needed for any header value (e.g. Subject) containing non-ASCII.
function encodeHeader(s) {
  const str = String(s);
  if (/^[\x00-\x7F]*$/.test(str)) return str;
  return '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

function buildHtml({ studentName, studentEmail, classroomName, comp }) {
  const rows = comp.rows.map(r => {
    const col = r.pct >= 70 ? '#22c55e' : r.pct >= 50 ? '#f59e0b' : '#ef4444';
    return `<tr><td style="padding:5px 10px;border-bottom:1px solid #e5e5e5">${esc(r.t)}</td><td style="padding:5px 10px;border-bottom:1px solid #e5e5e5;text-align:right">${r.correct}/${r.total}</td><td style="padding:5px 10px;border-bottom:1px solid #e5e5e5;text-align:right;color:${col};font-weight:700">${r.pct}%</td></tr>`;
  }).join('');
  const weak = comp.weak.map(r => `<li>${esc(r.t)} — ${r.correct}/${r.total} (${r.pct}%)</li>`).join('');
  return `
  <div style="font-family:Arial,sans-serif;color:#111;max-width:600px;margin:0 auto">
    <h2 style="margin:0 0 4px">📊 Practice Exam Report</h2>
    <p style="color:#555;margin:0 0 16px">via Classroom AMT (classroomamt.com)</p>
    <p><b>Student:</b> ${esc(studentName)}${studentEmail ? ' &lt;' + esc(studentEmail) + '&gt;' : ''}${classroomName ? '<br><b>Class:</b> ' + esc(classroomName) : ''}</p>
    <p><b>${esc(comp.label)}</b> — ${comp.overallPct}% (${comp.totCorrect}/${comp.totQ}) across ${comp.examCount} exam${comp.examCount === 1 ? '' : 's'}</p>
    ${weak ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin:12px 0"><b>⚠ Weakest topics:</b><ul style="margin:6px 0 0;padding-left:20px">${weak}</ul></div>` : ''}
    <table style="width:100%;border-collapse:collapse;margin-top:12px;font-size:14px">
      <thead><tr><th style="text-align:left;padding:5px 10px;border-bottom:2px solid #ccc">Topic</th><th style="text-align:right;padding:5px 10px;border-bottom:2px solid #ccc">Score</th><th style="text-align:right;padding:5px 10px;border-bottom:2px solid #ccc">%</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#999;font-size:12px;margin-top:24px">Sent by ${esc(studentName)} via Classroom AMT's practice exam tracker.</p>
  </div>`;
}

// Minimal SMTPS client (implicit TLS, port 465) — just enough of RFC 5321/2822 to authenticate
// with a Gmail App Password and deliver one HTML message. No STARTTLS negotiation needed since
// port 465 is TLS from the first byte.
function sendGmailSmtp({ user, pass, to, subject, html, replyTo }) {
  return new Promise((resolve, reject) => {
    const dotStuffed = html.replace(/^\./gm, '..').replace(/\r\n|\r|\n/g, '\r\n');
    const headers = [
      `From: Classroom AMT <${user}>`,
      `To: ${to}`,
      ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
      `Subject: ${encodeHeader(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@classroomamt.com>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: 8bit`,
    ].join('\r\n');
    const message = headers + '\r\n\r\n' + dotStuffed + '\r\n.';

    // Each step's `expect` is the response code for whatever was sent by the PREVIOUS step
    // (step 0 sends nothing — it's just the server's connection greeting).
    const steps = [
      { expect: 220 },
      { send: 'EHLO classroomamt.com', expect: 250 },
      { send: 'AUTH LOGIN', expect: 334 },
      { send: Buffer.from(user, 'utf8').toString('base64'), expect: 334 },
      { send: Buffer.from(pass, 'utf8').toString('base64'), expect: 235 },
      { send: `MAIL FROM:<${user}>`, expect: 250 },
      { send: `RCPT TO:<${to}>`, expect: 250 },
      { send: 'DATA', expect: 354 },
      { send: message, expect: 250 },
      { send: 'QUIT', expect: 221 },
    ];
    let idx = 0;
    let buf = '';
    let finished = false;

    const socket = tls.connect({ host: 'smtp.gmail.com', port: 465, servername: 'smtp.gmail.com' });
    const timer = setTimeout(() => finish(new Error('SMTP connection timed out')), SMTP_TIMEOUT_MS);

    function finish(err) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch (e) {}
      if (err) reject(err); else resolve();
    }

    socket.on('error', finish);

    socket.on('data', chunk => {
      if (finished) return;
      buf += chunk.toString('utf8');
      if (!buf.endsWith('\r\n')) return; // response not fully buffered yet
      const lines = buf.trim().split('\r\n');
      const last = lines[lines.length - 1];
      if (/^\d{3}-/.test(last)) return; // multi-line reply (e.g. EHLO's capability list) continues
      buf = '';
      const code = parseInt(last.slice(0, 3), 10);
      if (code !== steps[idx].expect) return finish(new Error(`SMTP rejected at step ${idx}: ${last}`));
      idx++;
      if (idx >= steps.length) return finish(); // QUIT acknowledged — done
      if (steps[idx].send != null) socket.write(steps[idx].send + '\r\n');
    });
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { toEmail, studentName, studentEmail, classroomName, comp } = req.body || {};
  if (!toEmail || !EMAIL_RE.test(String(toEmail).trim())) {
    return res.status(400).json({ error: 'A valid instructor email address is required.' });
  }
  if (!comp || typeof comp.overallPct !== 'number' || !Array.isArray(comp.rows)) {
    return res.status(400).json({ error: 'No report data to send.' });
  }
  if (!process.env.GMAIL_ADDRESS || !process.env.GMAIL_APP_PASSWORD) {
    return res.status(500).json({ error: 'Email delivery is not configured yet — contact the site admin.' });
  }

  const safeComp = {
    label: String(comp.label || 'Practice Report').slice(0, MAX_STR),
    overallPct: Number(comp.overallPct) || 0,
    totCorrect: Number(comp.totCorrect) || 0,
    totQ: Number(comp.totQ) || 0,
    examCount: Number(comp.examCount) || 0,
    rows: (comp.rows || []).slice(0, 60).map(r => ({ t: String(r.t || '').slice(0, MAX_STR), correct: Number(r.correct) || 0, total: Number(r.total) || 0, pct: Number(r.pct) || 0 })),
    weak: (comp.weak || []).slice(0, 8).map(r => ({ t: String(r.t || '').slice(0, MAX_STR), correct: Number(r.correct) || 0, total: Number(r.total) || 0, pct: Number(r.pct) || 0 })),
  };
  const sName = String(studentName || 'A student').slice(0, MAX_STR);
  const sEmail = studentEmail && EMAIL_RE.test(String(studentEmail)) ? String(studentEmail).trim().slice(0, MAX_STR) : '';
  const cName = String(classroomName || '').slice(0, MAX_STR);

  try {
    await sendGmailSmtp({
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD,
      to: String(toEmail).trim(),
      replyTo: sEmail || undefined,
      subject: `📊 ${sName}'s Practice Exam Report — ${safeComp.label}`,
      html: buildHtml({ studentName: sName, studentEmail: sEmail, classroomName: cName, comp: safeComp }),
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('send-report-email failed', e);
    return res.status(502).json({ error: 'Could not send the email. Try again in a moment.' });
  }
};
