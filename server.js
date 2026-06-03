require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Imap = require('imap');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));

// ── CONFIG ────────────────────────────────────────────
const API_SECRET = process.env.API_SECRET || 'changeme';
let STORES = [];
try {
  STORES = JSON.parse(process.env.STORES_CONFIG || '[]');
} catch(e) {
  console.error('STORES_CONFIG parse error:', e.message);
}

// ── AUTH MIDDLEWARE ───────────────────────────────────
function auth(req, res, next) {
  const key = req.headers['x-api-secret'] || req.query.secret;
  if (key !== API_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// ── HELPER: Get store config ──────────────────────────
function getStore(storeId) {
  return STORES.find(s => s.id === storeId);
}

// ── IMAP: Fetch inbox ─────────────────────────────────
function fetchInbox(storeConfig, options = {}) {
  return new Promise((resolve, reject) => {
    const { limit = 20, folder = 'INBOX', searchCriteria = ['ALL'], unreadOnly = false } = options;

    const imap = new Imap({
      user: storeConfig.email,
      password: storeConfig.password,
      host: storeConfig.imap_host,
      port: storeConfig.imap_port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
      authTimeout: 10000,
    });

    const emails = [];

    imap.once('ready', () => {
      imap.openBox(folder, true, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        imap.search(searchCriteria, (err, uids) => {
          if (err) { imap.end(); return reject(err); }
          if (!uids || !uids.length) { imap.end(); return resolve([]); }

          // Get last N emails
          const fetchUids = uids.slice(-limit).reverse();
          const fetch = imap.fetch(fetchUids, { bodies: '', struct: true, markSeen: false });

          fetch.on('message', (msg) => {
            let buffer = '';
            let uid;
            let isSeen = false;
            msg.on('attributes', attrs => {
              uid = attrs.uid;
              const flags = attrs.flags || [];
              isSeen = flags.some(f => 
                f === '\\Seen' || 
                f === '\\seen' || 
                f.toLowerCase() === '\\seen' ||
                f.toLowerCase() === 'seen'
              );
            });
            msg.on('body', stream => {
              stream.on('data', chunk => { buffer += chunk.toString('utf8'); });
            });
            msg.once('end', () => {
              simpleParser(buffer).then(parsed => {
                emails.push({
                  uid,
                  messageId: parsed.messageId || '',
                  inReplyTo: parsed.inReplyTo || '',
                  references: parsed.references || [],
                  from: parsed.from?.text || '',
                  to: parsed.to?.text || '',
                  subject: parsed.subject || '(no subject)',
                  date: parsed.date?.toISOString() || new Date().toISOString(),
                  text: parsed.text || '',
                  html: parsed.html || '',
                  snippet: (parsed.text || '').slice(0, 200).replace(/\n/g, ' '),
                  seen: isSeen,
                });
              }).catch(() => {});
            });
          });

          fetch.once('error', err => { imap.end(); reject(err); });
          fetch.once('end', () => { imap.end(); });
        });
      });
    });

    imap.once('end', () => resolve(emails.sort((a,b) => new Date(b.date) - new Date(a.date))));
    imap.once('error', err => reject(err));
    imap.connect();
  });
}

// ── IMAP: Fetch single email by UID ───────────────────
function fetchEmailByUid(storeConfig, uid, folder = 'INBOX') {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: storeConfig.email,
      password: storeConfig.password,
      host: storeConfig.imap_host,
      port: storeConfig.imap_port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
    });

    imap.once('ready', () => {
      imap.openBox(folder, true, (err) => {
        if (err) { imap.end(); return reject(err); }
        const fetch = imap.fetch([uid], { bodies: '' });
        let result = null;
        fetch.on('message', msg => {
          let buffer = '';
          msg.on('body', stream => { stream.on('data', c => buffer += c.toString('utf8')); });
          msg.once('end', () => {
            simpleParser(buffer).then(parsed => {
              result = {
                uid,
                messageId: parsed.messageId || '',
                inReplyTo: parsed.inReplyTo || '',
                references: parsed.references || [],
                from: parsed.from?.text || '',
                to: parsed.to?.text || '',
                subject: parsed.subject || '',
                date: parsed.date?.toISOString() || '',
                text: parsed.text || '',
                html: parsed.html || '',
              };
            }).catch(() => {});
          });
        });
        fetch.once('end', () => { imap.end(); });
      });
    });

    imap.once('end', () => resolve(result));
    imap.once('error', err => reject(err));
    imap.connect();
  });
}

// ── SMTP: Send email ──────────────────────────────────
async function sendEmail(storeConfig, mailOptions) {
  const port = storeConfig.smtp_port || 587;
  const transporter = nodemailer.createTransport({
    host: storeConfig.smtp_host,
    port: port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: {
      user: storeConfig.email,
      pass: storeConfig.password,
    },
    tls: { rejectUnauthorized: false },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  const info = await transporter.sendMail({
    from: `"${storeConfig.name} Support" <${storeConfig.email}>`,
    ...mailOptions,
  });

  return info;
}

// ══ ROUTES ════════════════════════════════════════════

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', stores: STORES.map(s => ({ id: s.id, name: s.name, email: s.email })) });
});

// GET /inbox/:storeId — Lấy danh sách email trong inbox
app.get('/inbox/:storeId', auth, async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  try {
    const limit = parseInt(req.query.limit) || 50;
    const folder = req.query.folder || 'INBOX';
    // Fetch all then filter, OR use UNSEEN search
    const [allEmails, unreadEmails] = await Promise.all([
      fetchInbox(store, { limit, folder, searchCriteria: ['ALL'] }),
      fetchInbox(store, { limit, folder, searchCriteria: ['UNSEEN'] }),
    ]);
    // Mark emails as seen/unseen based on UNSEEN search result
    const unreadUids = new Set(unreadEmails.map(e => e.uid));
    const emails = allEmails.map(e => ({
      ...e,
      seen: !unreadUids.has(e.uid)
    }));
    res.json({ success: true, emails, store: store.name, unreadCount: unreadUids.size });
  } catch(e) {
    console.error('Inbox error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /email/:storeId/:uid — Lấy nội dung 1 email cụ thể
app.get('/email/:storeId/:uid', auth, async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  try {
    const email = await fetchEmailByUid(store, parseInt(req.params.uid), req.query.folder || 'INBOX');
    if (!email) return res.status(404).json({ error: 'Email not found' });
    res.json({ success: true, email });
  } catch(e) {
    console.error('Fetch email error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /thread/:storeId — Lấy toàn bộ thread theo subject hoặc messageId
app.get('/thread/:storeId', auth, async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const { subject, messageId } = req.query;
  if (!subject && !messageId) return res.status(400).json({ error: 'subject or messageId required' });

  try {
    // Search by subject
    const searchCriteria = subject
      ? ['HEADER', 'SUBJECT', subject.replace(/^(re:|fw:|fwd:)\s*/gi, '').trim()]
      : ['ALL'];

    const emails = await fetchInbox(store, { limit: 50, searchCriteria });
    // Sort by date ascending for thread view
    emails.sort((a, b) => new Date(a.date) - new Date(b.date));
    res.json({ success: true, thread: emails, count: emails.length });
  } catch(e) {
    console.error('Thread error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /send/:storeId — Gửi email (reply hoặc new)
app.post('/send/:storeId', auth, async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const {
    to,           // email người nhận
    subject,      // tiêu đề
    text,         // nội dung text
    html,         // nội dung html (tuỳ chọn)
    inReplyTo,    // Message-ID của email cần reply (để nối thread)
    references,   // References header (chuỗi thread IDs)
    replyToName,  // Tên người nhận
  } = req.body;

  if (!to || !subject || !text) {
    return res.status(400).json({ error: 'to, subject, text are required' });
  }

  try {
    const mailOptions = {
      to: replyToName ? `"${replyToName}" <${to}>` : to,
      subject: subject.match(/^re:/i) ? subject : `Re: ${subject}`,
      text,
      html: html || text.replace(/\n/g, '<br>'),
    };

    // Thêm headers để nối thread nếu là reply
    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = references
        ? `${references} ${inReplyTo}`.trim()
        : inReplyTo;
    }

    const info = await sendEmail(store, mailOptions);
    res.json({
      success: true,
      messageId: info.messageId,
      response: info.response,
    });
  } catch(e) {
    console.error('Send error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /mark-seen/:storeId/:uid — Đánh dấu email đã đọc
app.post('/mark-seen/:storeId/:uid', auth, async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const uid = parseInt(req.params.uid);
  const folder = req.body?.folder || 'INBOX';

  return new Promise((resolve) => {
    const imap = new Imap({
      user: store.email, password: store.password,
      host: store.imap_host, port: store.imap_port,
      tls: true, tlsOptions: { rejectUnauthorized: false },
      connTimeout: 15000,
    });
    imap.once('ready', () => {
      imap.openBox(folder, false, (err) => {
        if (err) { imap.end(); res.json({ success: false, error: err.message }); return resolve(); }
        imap.addFlags([uid], ['\\Seen'], (err) => {
          imap.end();
          res.json({ success: !err });
          resolve();
        });
      });
    });
    imap.once('error', (err) => { res.json({ success: false, error: err.message }); resolve(); });
    imap.connect();
  });
});

// POST /test/:storeId — Test kết nối IMAP/SMTP
app.post('/test/:storeId', auth, async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Store not found' });

  const results = { imap: false, smtp: false, errors: [] };

  // Test IMAP
  try {
    const emails = await fetchInbox(store, { limit: 1 });
    results.imap = true;
    results.inboxCount = emails.length;
  } catch(e) {
    results.errors.push(`IMAP: ${e.message}`);
  }

  // Test SMTP
  try {
    const tport = store.smtp_port || 587;
    const transporter = nodemailer.createTransport({
      host: store.smtp_host,
      port: tport,
      secure: tport === 465,
      requireTLS: tport === 587,
      auth: { user: store.email, pass: store.password },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
    });
    await transporter.verify();
    results.smtp = true;
  } catch(e) {
    results.errors.push(`SMTP: ${e.message}`);
  }

  res.json({ success: results.imap && results.smtp, ...results });
});

// ── START ─────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`POD Email Server running on port ${PORT}`);
  console.log(`Stores loaded: ${STORES.length}`);
  STORES.forEach(s => console.log(`  - ${s.name}: ${s.email}`));
});
