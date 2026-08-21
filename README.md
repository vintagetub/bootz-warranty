# Bootz — Warranty Registration

Mobile-first landing page (for packaging QR codes) where a customer or installer
**registers their Bootz product** for warranty, and can **optionally leave a
public review** in the same form via Bazaarvoice. Every registration gets a
registration number, lands as a row in a Google Sheet, and triggers a branded
confirmation email. Reviews go straight to Bazaarvoice — this app never stores
review content.

**Live:** https://bootz-warranty.vercel.app

```
index.html         # the page (navy #002D4B hero, cyan #2FC0CC, black buttons)
api/register.js    # serverless: row -> Sheet, confirmation mail -> Resend
assets/            # logos, QR codes, favicon
make_qr.py         # regenerate the QR codes if the URL changes
```

## What happens on submit

```
Warranty  Browser ──POST /api/register──▶ 1. row → Google Sheet  ← system of record
                                          2. confirmation → customer, via Resend

Review    Browser ──────────────────────▶ Bazaarvoice, direct from the page
          (optional)                      ← system of record for review content
```

The two are independent. The review posts on Bazaarvoice's own button, so a
Bazaarvoice outage can't block a registration, and registering doesn't require a
review. Step 2 is best-effort: a mail failure is logged but never loses a
registration. Every step is skipped cleanly if its env vars are missing.

## Brand spec (Bootz 2022 Brand Guidelines)

| | |
|---|---|
| Brand cyan | `#2FC0CC` |
| Highlight / hero | `#002D4B` |
| Buttons | `#000000` |
| Backgrounds | `#FFFFFF` · `#EBEBEC` · `#64676C` |
| Type | Helvetica Neue — Light (body) / Roman (subheads) / Bold (titles) |
| Case | **Title and Sentence case only.** No all-caps, small-caps or all-lowercase |
| Logo | Black or white only. White over navy/cyan/black/images; black over white |

The page uses a native Helvetica Neue → Helvetica → Arial stack rather than a
webfont substitute, so it renders in the real brand face on Apple devices and a
faithful fallback everywhere else.

## What this does that the DreamLine / American Standard version didn't

- **Real product dropdown** — the actual Bootz line (Aloha, Bootzcast, Maui,
  Mauicast, Kona, Honolulu, Cambridge, Freedom, ShowerCast, NexTile, the
  glue-up wall systems, and all seven sinks), grouped by category. No more
  free-text product names to clean up later. *(Called a "product picker" in
  earlier drafts — renamed to keep it distinct from Bazaarvoice's Product
  Picker, which is a different control doing a different job. See below.)*
- **Review handled by Bazaarvoice** — the review form is embedded in the
  registration form itself, scoped to the product they picked in the dropdown, and
  entirely optional. One page, one product selection, no second screen.
- **Live warranty term** — picking a product shows what it actually carries
  (lifetime / 15-year / 10-year / 1-year), sourced from
  [bootz.com/warranty](https://bootz.com/warranty/). It also lands in the sheet
  and the confirmation email.
- **Homeowner vs. trade** — Bootz sells heavily through plumbers, builders and
  property managers. The toggle segments the data and reveals a company field.
- **Registration number** — `BTZ-2608-J4K7Q`. Shown on screen, emailed, stored.
  Uses an alphabet with no `I O 0 1` so it survives being read over the phone.
- **Confirmation email** — branded, with the product, warranty term, model and
  registration number.
- **No review gating** — the review form is shown to everyone who picks a
  product, with no pre-screening on how they feel about it. Selectively inviting
  only happy customers is review gating; retailer policies and the FTC's
  consumer-review rule both take a dim view of it.
- **Marketing opt-in** — an explicit, unchecked consent box, captured as its own
  column so the list is clean enough to hand to Klaviyo.

## Bazaarvoice review integration

**Two product-selection controls, confusingly similar names.** Don't mix them up:

| | What it selects | Needed for |
|---|---|---|
| **Product dropdown** (`#productFamily`) | The Bootz product being registered | Warranty term, sheet row, confirmation email |
| **BV Product Picker** | A product in *Bazaarvoice's* catalog | Attaching a review to a BV product |

They can't be collapsed into one control. BV's picker exposes no event or getter
that returns the selection to the page, so it can't act as the form's product
field — and the dropdown has to keep working for products absent from the BV feed,
because warranty registration is this page's primary job and can't be made to
depend on a third party's catalog or uptime. So **the dropdown drives BV, not the
reverse**: picking a product is what brings up the review form, already attached
to it.

**Live**, pointed at the `bootz` production deployment. Config sits near the top
of the `<script>` in `index.html`:

```js
var BV = {
  clientName:  'bootz',                 // blank hides the review section entirely
  siteId:      'main_site',             // deployment zone
  environment: 'production',            // 'staging' to test against the BV staging catalog
  locale:      'en_US',
  campaignId:  'bootz_qr_registration', // segments these reviews in BV reports
  categoryId:  '',                      // optional; ignored when a family matches
  submissionShow: 'review_submission'   // ← unverified; see below
};
```

Blanking `clientName` hides the review section and leaves a clean warranty-only
form. That's the kill switch.

### How it behaves

`bv.js` is **not** loaded on page load. This page is opened from a QR code on a
carton and the review is optional, so pulling in Bazaarvoice — and its cookies —
for everyone who just wants a warranty on file is the wrong trade. Selecting a
product in the dropdown is what injects the BV element and appends `bv.js`.

Three tiers, best first, each falling through only if it doesn't render:

| Tier | What appears | Needs | Customer supplies |
|---|---|---|---|
| 1 | BV review form, product already attached | an ExternalId in `BV_PRODUCT` | rating + review |
| 2 | Product Picker scoped to that family | an ExternalId in `BV_FAMILY` | one tap to confirm, then rating + review |
| 3 | Nothing — section says so and bows out | — | nothing; registration unaffected |

`BV_PRODUCT` wants the exact product's ExternalId; `BV_FAMILY` wants any product
in the right family. **Both ship empty**, so today every product lands on tier 2
at the root category. Filling `BV_PRODUCT` is what turns tier 1 on.

Other details worth knowing:

- The review element is injected **once**, on the first product selection. Changing
  the dropdown afterwards still updates the warranty term, but deliberately does
  not re-render BV — that would throw away a review someone had started typing.
- Registering does **not** tear the review section down. It moves below the
  confirmation and stays usable, for the same reason.
- `data-bv-inline="true"` on the picker — a BV lightbox in a 390 px viewport is
  cramped, and inline sidesteps the close-reveals-a-blank-page problem.
- Never both `data-bv-family-product-id` and `data-bv-category-id` — BV throws a
  console error if you set both.
- The review section sits **outside** the `<form>` element on purpose. BV renders
  its own `<form>`, and nested forms are invalid HTML that browsers silently
  break. A top border makes the seam read as one continuous form.

### Two buttons, and why there can't be one

The page has two submit buttons: **Register my product** (ours) and Bazaarvoice's
**Post review** inside the review section. That's not a design choice — the JS
embed gives no way for our submit to carry BV's fields. No callback, no
programmatic submit, nothing our form can reach. One button submitting both would
require the **Conversations API**, which is **$10k per brand** and therefore out.

So the embed is permanent, and the risk it creates is someone typing a review,
hitting Register, and leaving believing they posted it. Three things guard that:

- The review section says up front that it posts on its own button, separately.
- Registering does **not** clear the review form.
- After registering, the note under the review turns into a raised warning:
  *"Started a review? It hasn't been sent yet."*

Don't "solve" this by having our button reach into BV's widget and click its
submit. If BV renders in an iframe it's impossible cross-origin, and if it
doesn't, it's an undocumented internal that will break on a BV release — silently,
losing reviews, with nothing in our logs. Two honest buttons beat one that
sometimes lies.

### Unverified: `BV.submissionShow`

Every other attribute comes from the Product Picker doc. The site-hosted
submission container's `data-bv-show` value does not appear there, and all four BV
documentation domains are blocked from the dev sandbox, so `'review_submission'`
is an educated guess. **Confirm it with your BV rep.** If it's wrong, tier 1 never
paints and tier 2 takes over after 5 seconds — a bad guess costs seconds, not the
feature.

Two more prerequisites can't be checked from here either:

1. The review feature must be enabled in the BV **Style Editor**. If the option
   isn't there, BV Support has to turn it on.
2. The BV **product feed** must map products to categories and families, or the
   picker renders an empty list.

**The first real test is the deployed page**: pick a product and see whether a
review form appears or the section bows out. Setting `environment: 'staging'` runs
that check against the BV staging catalog first.

### Open question — picker vs. model-number dropdown

Sheila asked for the category-based Product Picker; Craig and Molly both think a
model-number dropdown would be simpler for the customer. Unresolved, and
explicitly out of the original scope, so it isn't blocking. Worth knowing for that
conversation: **tier 1 needs no picker at all.** Once `BV_PRODUCT` is filled the
customer selects a product exactly once, in our own dropdown, and BV's picker only
appears as the fallback for products missing from the feed. If the picker turns out
to be wanted for its own sake, leave `BV_PRODUCT` blank and everything lands on
tier 2.

## What was removed when Bazaarvoice took over the review

Per the 2026-08-21 meeting (Craig, George, Molly): Bazaarvoice is the system of
record for review content, the Google Sheet was only ever a placeholder for it,
and the standalone second review screen was redundant once BV was embedded.

| Removed | Was |
|---|---|
| Star rating field | Required on the form; also gated the API (400 without it) |
| Review textarea | Optional free text → sheet |
| Photo upload (up to 3) | Client-side resize → GCS bucket → public URLs in the sheet |
| `Rating` · `Review` · `Photos` sheet columns | 3 of 17 columns |
| Low-rating alert | ≤ 3★ emailed the internal list with the review, photo links and a reply-to-customer link |
| Second review screen | Post-submit review step with retailer hand-off |
| `ALERT_TO` · `ALERT_THRESHOLD` · `GCS_BUCKET` | Env vars, now unused |
| `@google-cloud/storage` | Dependency, now unused |

**The low-rating alert is the one with teeth.** It existed to catch an unhappy
customer *before* they posted publicly — same-day, with their words and photos in
front of a human. Customer follow-up now belongs to Leah's team working from
Bazaarvoice, and BV moderation queues are not usually real-time, so that
same-day recovery window is gone rather than moved. Flagging it because it will be
missed before anyone remembers it was there. Restoring it needs only an optional
rating field on the form and `ALERT_TO` pointed at Leah's team.

> **Sheet migration.** The header is now 14 columns, down from 17. `appendRow`
> rewrites row 1 whenever `HEADERS` changes but cannot rewrite the rows beneath —
> so pointing this at a tab that already holds 17-column rows will silently
> re-label their columns. **If the `Bootz` tab has data worth keeping, set
> `SHEET_TAB` to a fresh tab before deploying.** Photo URLs already in the sheet
> keep working; the bucket isn't being emptied.

## Environment variables

Set on the Vercel project (`bootz-warranty`) — run `bash setup-env.sh` for the
required ones. Nothing is required for the page to load; each unset var just
disables its own step.

> **Email is deliberately off right now.** `MAIL_FROM` is unset, so the
> confirmation email is skipped and the API returns `"emailed": false`. Resend has only `notify.americanstandardbathing.com`
> verified, and sending a Bootz confirmation from an American Standard address
> is the wrong branding. Verify `notify.bootz.com` in Resend, set
> `RESEND_API_KEY` + `MAIL_FROM`, redeploy — no code change needed.
>
> Separately: Resend mail to `@americanbathgroup.com` currently sits in
> Mimecast's hold queue (the sending subdomain has no SPF record). Sort that with
> IT before pointing any internal notification at an ABG inbox.

| Var | Purpose | State |
|---|---|---|
| `GOOGLE_SA_KEY` | base64 of the service-account JSON key | needed for sheet |
| `SHEET_ID` | target Google Sheet | needed for sheet |
| `SHEET_TAB` | tab within it (default `Bootz`) — see the warning below | optional |
| `RESEND_API_KEY` | Resend key | needed for any email |
| `MAIL_FROM` | e.g. `Bootz <registration@notify.bootz.com>` | needed for any email |
| `MAIL_REPLY_TO` | customer-facing reply address | optional |
| `PUBLIC_BASE_URL` | absolute origin for email images (default the live URL) | optional |

## Shared infrastructure

Reuses what was already provisioned for DreamLine / American Standard — same
service account, same photo bucket, same sheet, so all brands stay in one
dataset with a `Brand` column.

| Piece | Value |
|---|---|
| Vercel project | `bootz-warranty` (iamgeorgekelly) |
| Service account | `dl-warranty-writer@dl-warranty-reg-2026.iam.gserviceaccount.com` |
| Sheet | `1MNdrXimnDFoj9iyMrmQMepYEqbawgCMnP-ALZ3CS8ec` ("DL QR Code") |
| Tab | **`Bootz`** — its own tab, auto-created on first write |

Photos are no longer uploaded; the bucket is left as-is for the other brands and
for the URLs already sitting in the sheet.

**Bootz must stay on its own tab.** The DreamLine / American Standard function
writes to the default first tab and self-heals a *different* 12-column header on
every submission. If both apps shared a tab they'd rewrite each other's header
row on every write and misalign the existing rows. `SHEET_TAB` controls this and
defaults to `Bootz`; the tab is created automatically if missing.

## Sheet columns

`Timestamp · Brand · Registration ID · Audience · Full Name · Email · Company ·
Product · Warranty Term · Model # · Purchase Date · Purchased From ·
Marketing Opt-In · Source URL`

14 columns. `Rating`, `Review` and `Photos` were removed when Bazaarvoice took
over the review — see the migration note above before deploying against a tab
that already has rows.

## QR codes

`assets/bootz-warranty-qr.png` — black on white, 1800 px, 30% error correction.
Black is the production choice: highest contrast on a printed carton and on-spec
for Bootz print colors. `assets/bootz-warranty-qr-navy.png` is a `#002D4B`
variant for artwork that wants the brand highlight.

If the URL ever changes, edit `URL` in `make_qr.py`, run `python3 make_qr.py`,
and reprint — the old code will not redirect.

## Local preview

```bash
python3 -m http.server 8793 --directory /Users/macbookpro/Downloads/bootz-warranty
```

Registered in the root `.claude/launch.json` as `bootz-warranty`. The form posts
to `/api/register`, which only exists on Vercel — locally the submit will fail
unless you stub it or run `vercel dev`.

## Deploying

```bash
vercel deploy --prod --yes
```
