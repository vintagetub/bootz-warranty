// Vercel serverless function — Bootz warranty registration.
//
// One POST does two things, each of which degrades gracefully if unconfigured:
//   1. appends a row to the Google Sheet (self-healing header)
//   2. emails the customer a branded confirmation via Resend
//
// Reviews are NOT handled here. They go directly to Bazaarvoice from the page,
// which is the system of record for review content — so this function no longer
// takes a rating, review text or photos, and there is no low-rating alert. See
// the README for what that removed and who picks up customer follow-up.
//
// Env vars:
//   GOOGLE_SA_KEY   base64 of the service-account JSON key   (required for sheet)
//   SHEET_ID        target Google Sheet ID                   (required for sheet)
//   SHEET_TAB       tab within that sheet                    (optional, default below)
//   RESEND_API_KEY  Resend key                               (required for any email)
//   MAIL_FROM       e.g. "Bootz <registration@notify.bootz.com>"   (required for any email)
//   MAIL_REPLY_TO   customer-facing reply address            (optional)
//   PUBLIC_BASE_URL absolute origin for email images         (optional, default below)

import { google } from 'googleapis';

// Bootz writes to its OWN tab. The DreamLine/American Standard function targets
// the default first tab with a different 12-column header and self-heals it on
// every write — sharing a tab would leave the two apps rewriting each other's
// header row and misaligning the existing rows.
//
// NOTE: the header below is narrower than it used to be (Rating, Review and
// Photos are gone). appendRow rewrites row 1 whenever HEADERS changes, but it
// cannot rewrite the rows underneath — so pointing this at a tab that already
// holds 17-column rows would re-label their columns. Point SHEET_TAB at a fresh
// tab if the existing one has data worth keeping.
const TAB = process.env.SHEET_TAB || 'Bootz';
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://bootz-warranty.vercel.app';
const SUPPORT_PHONE = '(800) 443-7269';

const HEADERS = ['Timestamp', 'Brand', 'Registration ID', 'Audience', 'Full Name', 'Email',
  'Company', 'Product', 'Warranty Term', 'Model #', 'Purchase Date', 'Purchased From',
  'Marketing Opt-In', 'Source URL'];

// Escape anything that reaches an HTML email or the internal alert.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Human-friendly, unambiguous id: BTZ-2608-J4K7Q  (no I/O/0/1 to survive being read over the phone)
function registrationId(now = new Date()) {
  const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const yy = String(now.getUTCFullYear()).slice(2);
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  let tail = '';
  for (let i = 0; i < 5; i++) tail += ALPHA[Math.floor(Math.random() * ALPHA.length)];
  return `BTZ-${yy}${mm}-${tail}`;
}

let _key;
function saKey() {
  if (_key) return _key;
  if (!process.env.GOOGLE_SA_KEY) return null;
  _key = JSON.parse(Buffer.from(process.env.GOOGLE_SA_KEY, 'base64').toString('utf8'));
  return _key;
}

function sheetsClient() {
  const key = saKey();
  if (!key || !process.env.SHEET_ID) return null;
  const auth = new google.auth.JWT({
    email: key.client_email, key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function ensureTab(sheets, spreadsheetId) {
  const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
  if (meta.data.sheets?.some((s) => s.properties.title === TAB)) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: TAB } } }] },
  });
}

async function appendRow(sheets, row) {
  const spreadsheetId = process.env.SHEET_ID;
  const lastCol = String.fromCharCode(64 + HEADERS.length); // A..Z, HEADERS is well under 26
  await ensureTab(sheets, spreadsheetId);
  // Self-healing header: create it, or widen it when new columns are added.
  const head = await sheets.spreadsheets.values.get({
    spreadsheetId, range: `'${TAB}'!A1:${lastCol}1`,
  });
  const current = head.data.values?.[0] || [];
  if (current.join('') !== HEADERS.join('')) {
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'RAW',
      requestBody: { values: [HEADERS] },
    });
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId, range: `'${TAB}'!A1`, valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS', requestBody: { values: [row] },
  });
}

async function sendMail({ to, subject, html, replyTo }) {
  if (!process.env.RESEND_API_KEY || !process.env.MAIL_FROM) return false;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) {
    console.error('[register] resend failed', res.status, await res.text().catch(() => ''));
    return false;
  }
  return true;
}

/* ---------- Customer confirmation (Bootz 2022 brand guidelines) ----------
   Highlight #002D4B · brand cyan #2FC0CC · button #000000 · bg #EBEBEC
   White logo over the navy band. Title and Sentence case only. */
function confirmationHtml(d) {
  const row = (label, value) => value
    ? `<tr>
         <td style="padding:7px 0;font-size:14px;color:#64676C;font-weight:300;width:44%;">${esc(label)}</td>
         <td style="padding:7px 0;font-size:14px;color:#000000;font-weight:400;">${esc(value)}</td>
       </tr>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Your Bootz registration</title></head>
<body style="margin:0;padding:0;background:#EBEBEC;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#EBEBEC;padding:24px 12px;">
<tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:10px;overflow:hidden;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">

    <tr><td style="background:#2FC0CC;height:5px;line-height:5px;font-size:0;">&nbsp;</td></tr>
    <tr><td align="center" style="background:#002D4B;padding:30px 24px 26px;">
      <img src="${BASE_URL}/assets/bootz-logo-white.png" width="120" alt="Bootz" style="display:block;border:0;width:120px;height:auto;margin:0 auto 14px;" />
      <div style="font-size:21px;font-weight:700;color:#FFFFFF;line-height:1.25;">You're registered</div>
      <div style="font-size:14.5px;font-weight:300;color:#CFE0EA;margin-top:7px;">Your warranty record is on file.</div>
    </td></tr>

    <tr><td style="padding:28px 26px 6px;">
      <p style="margin:0 0 18px;font-size:15.5px;font-weight:300;color:#000000;line-height:1.6;">
        Hi ${esc((d.fullName || '').split(' ')[0] || 'there')}, thanks for registering.
        Hold on to the number below; it&rsquo;s all we need if you ever call in.
      </p>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#EBEBEC;border-radius:8px;margin-bottom:20px;">
        <tr><td align="center" style="padding:16px;">
          <div style="font-size:12px;color:#64676C;font-weight:300;margin-bottom:4px;">Your registration number</div>
          <div style="font-size:22px;font-weight:700;color:#002D4B;letter-spacing:.06em;">${esc(d.registrationId)}</div>
        </td></tr>
      </table>

      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #E4E5E6;">
        ${row('Product', d.productType)}
        ${row('Warranty', d.warrantyTerm)}
        ${row('Model number', d.modelNumber)}
        ${row('Purchased from', d.purchasedFrom)}
        ${row('Purchase date', d.purchaseDate)}
      </table>
    </td></tr>

    <tr><td style="padding:22px 26px 28px;">
      <a href="https://bootz.com/warranty/"
         style="display:block;text-align:center;background:#000000;color:#FFFFFF;text-decoration:none;
                border-radius:8px;padding:14px;font-size:15.5px;font-weight:500;">Read the full warranty terms</a>
      <p style="margin:18px 0 0;font-size:13px;font-weight:300;color:#64676C;line-height:1.6;text-align:center;">
        Questions about your product? Call Bootz support at
        <a href="tel:18004437269" style="color:#002D4B;font-weight:500;text-decoration:none;">${SUPPORT_PHONE}</a>,
        Monday to Friday.
      </p>
    </td></tr>

    <tr><td align="center" style="background:#EBEBEC;padding:20px 26px 24px;">
      <img src="${BASE_URL}/assets/bootz-logo-black.png" width="76" alt="Bootz" style="display:block;border:0;width:76px;height:auto;margin:0 auto 10px;opacity:.9;" />
      <div style="font-size:11.5px;font-weight:300;color:#64676C;line-height:1.6;">
        American-made bathware since 1937<br/>
        Bootz Industries, an American Bath Group company &middot; 435 Industrial Road, Savannah, TN 38372<br/>
        You're getting this because you registered a Bootz product at ${esc(BASE_URL.replace(/^https?:\/\//, ''))}.
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.company) return res.status(200).json({ ok: true });               // honeypot
    // The review is optional and no longer arrives here, so it is not required.
    if (!b.fullName || !b.email) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }

    const brand = b.brand || 'Bootz';
    const d = {
      registrationId: registrationId(),
      audience: b.audience || 'Homeowner',
      companyName: b.companyName || '',
      fullName: b.fullName,
      email: b.email,
      productType: b.productType || '',
      warrantyTerm: b.warrantyTerm || '',
      modelNumber: b.modelNumber || '',
      purchaseDate: b.purchaseDate || '',
      purchasedFrom: b.purchasedFrom || '',
    };

    // The sheet is the system of record for the warranty — if it fails, the
    // submission failed. Review content lives in Bazaarvoice, not here.
    const sheets = sheetsClient();
    if (sheets) {
      await appendRow(sheets, [
        new Date().toISOString(), brand, d.registrationId, d.audience, d.fullName, d.email,
        d.companyName, d.productType, d.warrantyTerm, d.modelNumber, d.purchaseDate,
        d.purchasedFrom, b.optIn ? 'Yes' : 'No', b.pageUrl || '',
      ]);
    } else {
      console.log('[register] sheet not configured; submission:', d);
    }

    // Email is best-effort — a mail failure must never lose a registration.
    let emailed = false;
    try {
      emailed = await sendMail({
        to: d.email,
        subject: `Your Bootz registration — ${d.registrationId}`,
        html: confirmationHtml(d),
        replyTo: process.env.MAIL_REPLY_TO,
      });
    } catch (e) { console.error('[register] confirmation email error', e?.message || e); }

    return res.status(200).json({
      ok: true, registrationId: d.registrationId, sheet: !!sheets, emailed,
    });
  } catch (err) {
    console.error('[register] error', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
