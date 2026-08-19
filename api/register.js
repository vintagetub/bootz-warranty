// Vercel serverless function — Bootz product registration + review intake.
//
// One POST does four things, each of which degrades gracefully if unconfigured:
//   1. uploads any photos to a public GCS bucket
//   2. appends a row to the Google Sheet (self-healing header)
//   3. emails the customer a branded confirmation via Resend
//   4. emails an internal alert when a registration comes in at 3 stars or below
//
// Env vars:
//   GOOGLE_SA_KEY   base64 of the service-account JSON key   (required for sheet + photos)
//   SHEET_ID        target Google Sheet ID                   (required for sheet)
//   SHEET_TAB       tab within that sheet                    (optional, default below)
//   GCS_BUCKET      photo bucket name                        (optional, default below)
//   RESEND_API_KEY  Resend key                               (required for any email)
//   MAIL_FROM       e.g. "Bootz <registration@notify.bootz.com>"   (required for any email)
//   MAIL_REPLY_TO   customer-facing reply address            (optional)
//   ALERT_TO        comma-separated internal recipients      (optional; enables low-rating alerts)
//   ALERT_THRESHOLD max star rating that triggers an alert   (optional, default 3)
//   PUBLIC_BASE_URL absolute origin for email images         (optional, default below)

import { google } from 'googleapis';
import { Storage } from '@google-cloud/storage';

const BUCKET = process.env.GCS_BUCKET || 'dreamline-warranty-photos';
// Bootz writes to its OWN tab. The DreamLine/American Standard function targets
// the default first tab with a different 12-column header and self-heals it on
// every write — sharing a tab would leave the two apps rewriting each other's
// header row and misaligning the existing rows.
const TAB = process.env.SHEET_TAB || 'Bootz';
const BASE_URL = process.env.PUBLIC_BASE_URL || 'https://bootz-warranty.vercel.app';
const ALERT_THRESHOLD = Number(process.env.ALERT_THRESHOLD || 3);
const SUPPORT_PHONE = '(800) 443-7269';

const HEADERS = ['Timestamp', 'Brand', 'Registration ID', 'Audience', 'Full Name', 'Email',
  'Company', 'Product', 'Warranty Term', 'Model #', 'Purchase Date', 'Purchased From',
  'Rating', 'Review', 'Photos', 'Marketing Opt-In', 'Source URL'];

const slug = (s) => String(s || 'brand').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

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

async function uploadPhotos(photos, modelNumber, brand) {
  const key = saKey();
  if (!photos?.length || !key) return [];
  const storage = new Storage({
    projectId: key.project_id,
    credentials: { client_email: key.client_email, private_key: key.private_key },
  });
  const bucket = storage.bucket(BUCKET);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = (modelNumber || 'photo').replace(/[^\w-]+/g, '_').slice(0, 40);
  const folder = slug(brand) || 'submissions';
  const urls = [];
  for (let i = 0; i < photos.length; i++) {
    const m = String(photos[i].dataUrl || '').match(/^data:(.*?);base64,(.*)$/);
    if (!m) continue;
    const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    const path = `${folder}/${base}-${stamp}-${i + 1}.${ext}`;
    await bucket.file(path).save(Buffer.from(m[2], 'base64'), {
      contentType: m[1], resumable: false,
      metadata: { cacheControl: 'public, max-age=31536000' },
    });
    urls.push(`https://storage.googleapis.com/${BUCKET}/${path}`);
  }
  return urls;
}

// Create the Bootz tab if it isn't there yet, so a fresh sheet needs no setup.
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

  const lowRating = Number(d.rating) <= ALERT_THRESHOLD;

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
        Hi ${esc((d.fullName || '').split(' ')[0] || 'there')}, thanks for registering &mdash; and for telling us how it went.
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
        ${row('Your rating', d.rating ? `${d.rating} out of 5` : '')}
      </table>
    </td></tr>

    ${lowRating ? `
    <tr><td style="padding:6px 26px 0;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="background:#F0FAFB;border:1px solid #BFE9ED;border-left:4px solid #2FC0CC;border-radius:8px;">
        <tr><td style="padding:14px 16px;">
          <div style="font-size:14.5px;font-weight:500;color:#002D4B;margin-bottom:4px;">We'd like to make this right</div>
          <div style="font-size:13.5px;font-weight:300;color:#64676C;line-height:1.55;">
            Your note is already with our team. If you'd rather sort it out now, call us at
            <a href="tel:18004437269" style="color:#002D4B;font-weight:500;text-decoration:none;">${SUPPORT_PHONE}</a>
            and have your registration number handy.
          </div>
        </td></tr>
      </table>
    </td></tr>` : ''}

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

/* ---------- Internal alert on a low rating ---------- */
function alertHtml(d, photoUrls) {
  const line = (l, v) => v
    ? `<tr><td style="padding:5px 14px 5px 0;color:#64676C;font-size:13px;">${esc(l)}</td>
           <td style="padding:5px 0;color:#000;font-size:13px;font-weight:500;">${esc(v)}</td></tr>`
    : '';
  return `<div style="font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;max-width:600px;">
    <div style="background:#002D4B;color:#fff;padding:16px 18px;border-radius:8px 8px 0 0;">
      <div style="font-size:17px;font-weight:700;">${esc(d.rating)}-star Bootz registration</div>
      <div style="font-size:13.5px;font-weight:300;color:#CFE0EA;margin-top:3px;">${esc(d.registrationId)} &middot; reach out before this becomes a public review</div>
    </div>
    <div style="border:1px solid #E4E5E6;border-top:0;border-radius:0 0 8px 8px;padding:16px 18px;">
      <table cellpadding="0" cellspacing="0">
        ${line('Customer', d.fullName)}
        ${line('Email', d.email)}
        ${line('Audience', d.audience)}
        ${line('Company', d.companyName)}
        ${line('Product', d.productType)}
        ${line('Warranty', d.warrantyTerm)}
        ${line('Model #', d.modelNumber)}
        ${line('Purchased from', d.purchasedFrom)}
        ${line('Purchase date', d.purchaseDate)}
      </table>
      ${d.review ? `<div style="margin-top:14px;padding:12px 14px;background:#EBEBEC;border-radius:8px;
        font-size:14px;color:#000;font-weight:300;line-height:1.55;white-space:pre-wrap;">${esc(d.review)}</div>` : ''}
      ${photoUrls.length ? `<div style="margin-top:12px;font-size:13px;">Photos: ${
        photoUrls.map((u, i) => `<a href="${esc(u)}">${i + 1}</a>`).join(' &middot; ')}</div>` : ''}
      <div style="margin-top:14px;font-size:13px;">
        <a href="mailto:${encodeURIComponent(d.email)}?subject=${encodeURIComponent('About your Bootz product (' + d.registrationId + ')')}"
           style="color:#002D4B;font-weight:500;">Reply to the customer &rarr;</a>
      </div>
    </div>
  </div>`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (b.company) return res.status(200).json({ ok: true });               // honeypot
    if (!b.fullName || !b.email || !b.rating) {
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
      rating: b.rating,
      review: b.review || '',
    };

    const photoUrls = await uploadPhotos(b.photos, d.modelNumber, brand);

    // The sheet is the system of record — if it fails, the submission failed.
    const sheets = sheetsClient();
    if (sheets) {
      await appendRow(sheets, [
        new Date().toISOString(), brand, d.registrationId, d.audience, d.fullName, d.email,
        d.companyName, d.productType, d.warrantyTerm, d.modelNumber, d.purchaseDate,
        d.purchasedFrom, d.rating, d.review, photoUrls.join('\n'),
        b.optIn ? 'Yes' : 'No', b.pageUrl || '',
      ]);
    } else {
      console.log('[register] sheet not configured; submission:', { ...d, photos: photoUrls });
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

    try {
      const alertTo = (process.env.ALERT_TO || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (alertTo.length && Number(d.rating) <= ALERT_THRESHOLD) {
        await sendMail({
          to: alertTo,
          subject: `${d.rating}★ Bootz registration — ${d.fullName} (${d.registrationId})`,
          html: alertHtml(d, photoUrls),
          replyTo: d.email,
        });
      }
    } catch (e) { console.error('[register] alert email error', e?.message || e); }

    return res.status(200).json({
      ok: true, registrationId: d.registrationId, photos: photoUrls.length,
      sheet: !!sheets, emailed,
    });
  } catch (err) {
    console.error('[register] error', err?.message || err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
