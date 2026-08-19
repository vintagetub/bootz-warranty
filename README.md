# Bootz — Product Registration & Review

Mobile-first landing page (for packaging QR codes) where a customer or installer
**registers their Bootz product** and **leaves a review with photos**. Every
submission gets a registration number, lands as a row in a Google Sheet, and
triggers a branded confirmation email — plus an internal alert when the rating
is low enough to be worth a phone call.

**Live:** https://bootz-warranty.vercel.app

```
index.html         # the page (navy #002D4B hero, cyan #2FC0CC, black buttons)
api/register.js    # serverless: photos -> GCS, row -> Sheet, mail -> Resend
assets/            # logos, QR codes, favicon
make_qr.py         # regenerate the QR codes if the URL changes
```

## What happens on submit

```
Browser ──POST /api/register──▶  1. photos      → GCS bucket (public URLs)
                                 2. row         → Google Sheet   ← system of record
                                 3. confirmation→ customer, via Resend
                                 4. alert       → internal, only if rating ≤ 3
```

Steps 3 and 4 are best-effort: a mail failure is logged but never loses a
registration. Every step is skipped cleanly if its env vars are missing, so the
page keeps working while things are being wired up.

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
- **Low-rating alert** — 3 stars or below emails the internal list with the
  review, the photos and a one-click reply-to-customer link, so someone can
  intervene before it becomes a public 1-star.
- **No review gating** — the public-review hand-off is offered to *everyone*,
  whatever they rated it. On a low rating the "let us make it right" message
  moves above it, but the invitation is never withheld. Selectively inviting
  only happy customers is review gating; retailer policies and the FTC's
  consumer-review rule both take a dim view of it.
- **Marketing opt-in** — an explicit, unchecked consent box, captured as its own
  column so the list is clean enough to hand to Klaviyo.
- **Bazaarvoice Product Picker** — the public review can be written on this page
  instead of chasing the customer to a retailer. Built but off; see below.

## Bazaarvoice Product Picker (site-hosted)

**Two different controls, confusingly similar names.** Don't mix them up:

| | What it selects | Where it lives | Fails how |
|---|---|---|---|
| **Product dropdown** (`#productFamily`) | The Bootz product being registered — drives the warranty term and the sheet | On the form, before submit | Can't; it's native HTML with no dependencies |
| **BV Product Picker** | A product in *Bazaarvoice's* catalog, so a review can attach to it | Confirmation screen, after submit | Falls back to the retailer link |

They can't be collapsed into one control as things stand — the dropdown has to
keep working for every Bootz product whether or not it exists in the BV feed,
because warranty registration is this page's primary job and can't be made to
depend on a third party's catalog or uptime.

**Live**, pointed at the `bootz` production deployment. The config block is near
the top of the `<script>` in `index.html`:

```js
var BV = {
  clientName:  'bootz',                 // blank disables the picker
  siteId:      'main_site',             // deployment zone
  environment: 'production',            // 'staging' to test against the BV staging catalog
  locale:      'en_US',
  campaignId:  'bootz_qr_registration', // segments these reviews in BV reports
  categoryId:  ''                       // optional; ignored when a family matches
};
```

The on-site picker is the primary call to action on the confirmation screen, with
the retailer link (Home Depot / Lowe's / Menards / Amazon) kept as a secondary
line underneath. Blanking `clientName` reverts the page to the retailer-only
hand-off — that's the kill switch if anything goes wrong.

**How it behaves.** `bv.js` is *not* loaded on page load. This page is opened
from a QR code on a carton, and most people register and leave; pulling in
Bazaarvoice — and its cookies — for all of them to serve the few who write a
public review is the wrong trade. Instead the "Write a public review" button
injects `<div data-bv-show="product_picker">` and appends `bv.js` on click.

- `data-bv-inline="true"` — renders in place rather than a lightbox. A BV
  lightbox inside a 390 px viewport is cramped, and inline sidesteps the
  close-button-reveals-a-blank-page problem entirely.
- `data-bv-campaign-id` — set, so this program is measurable in BV separately
  from organic PDP reviews.
- `data-bv-family-product-id` — we already know what they registered, so the
  picker opens scoped to that product family instead of making them browse the
  catalog. Sourced from `BV_FAMILY`, which maps our product names to BV
  ExternalIds; **every entry is currently blank** — fill them from the BV product
  catalog. Unmapped products fall back to the root category, which still works.
- Never both `data-bv-family-product-id` and `data-bv-category-id` — BV throws a
  console error if you set both.

### One product selection, not two

The customer already told us what they installed in the product dropdown, so they
should never pick a product again. Three tiers, best first, each falling through
to the next only if it doesn't render:

| Tier | What opens | Needs | Customer taps |
|---|---|---|---|
| 1 | BV review form, already attached to their product | an ExternalId in `BV_PRODUCT` | rating + review only |
| 2 | Product Picker, scoped to that product's family | an ExternalId in `BV_FAMILY` | one tap to confirm the product |
| 3 | Retailer link (original behaviour) | nothing | leaves the site |

**`BV.submissionShow` is the one unverified value in this file.** Every other
attribute comes from the Product Picker doc; the site-hosted submission
container's `data-bv-show` value does not appear there, and all four BV
documentation domains are blocked from the dev sandbox, so `'review_submission'`
is an educated guess. **Confirm it with your BV rep.** If it's wrong, tier 1
simply never paints and tier 2 takes over after 5 seconds — a bad guess costs a
few seconds, not the feature.

`BV_PRODUCT` is empty today, so **tier 1 is dormant and behaviour is identical to
tier 2 until you fill it in**. That makes this safe to ship before the ExternalIds
are known. Note the two maps hold different things: `BV_PRODUCT` wants the exact
product's ExternalId, `BV_FAMILY` wants any product in the right family.

**It degrades instead of dead-ending.** If `bv.js` fails to load, or loads but
renders nothing within 8 seconds, the page hides the empty picker and restores
the retailer link with its original wording. If there's no retailer to fall back
to, the whole block is hidden and the support number stays. This matters because
the two remaining prerequisites below are both invisible from here — if either
isn't in place, customers get the old behaviour rather than a broken box.

**Two prerequisites live outside this repo and are unverified:**

1. Product Picker enabled in the BV **Style Editor**. If the option isn't there,
   BV Support has to turn it on.
2. A BV **product feed** with products mapped to categories and product
   families. Without those mappings the picker renders an empty list — this is
   the step most likely to need real work, since it means the Bootz catalog has
   to exist in BV with the same families as `BV_FAMILY`.

Neither could be checked from the dev sandbox (outbound access to
`apps.bazaarvoice.com` is blocked), so **the first real test is the deployed
page**: register a product, tap "Write a public review", and confirm the picker
lists products rather than falling back. Setting `environment: 'staging'` runs
the same check against the BV staging catalog first.

**Known friction:** BV's submission form can't be pre-filled from the page, so a
customer who already typed a review here has to retype it. Tier 1 removes the
product re-selection, but not the retyping — the page softens that by showing
their text back with a "Copy it" button. The only real fix is submitting
server-side through the BV **Conversations API**, which needs an API key and
skips BV's form entirely. Worth costing out if the retype hurts completion.

**Why the dropdown can't just *be* the BV picker.** The Product Picker doc defines
no event, callback, or getter that hands the selected product back to the host
page — it's a closed flow from selection into BV's own form. So it can't act as
the form's product field. Even if it could, the dropdown has to keep working for
every Bootz product whether or not it's in the BV feed, and warranty registration
can't be made to depend on a third party's catalog or uptime. Tier 1 gets the same
outcome the right way round: our dropdown drives BV, not the reverse.

**Not review gating.** The picker is offered to everyone regardless of rating,
same as the retailer link it replaces. On a low rating the "let us make it right"
message moves above it; the invitation is never withheld.

## Environment variables

Set on the Vercel project (`bootz-warranty`) — run `bash setup-env.sh` for the
required ones. Nothing is required for the page to load; each unset var just
disables its own step.

> **Email is deliberately off right now.** `MAIL_FROM` is unset, so the
> confirmation and the low-rating alert are both skipped and the API returns
> `"emailed": false`. Resend has only `notify.americanstandardbathing.com`
> verified, and sending a Bootz confirmation from an American Standard address
> is the wrong branding. Verify `notify.bootz.com` in Resend, set
> `RESEND_API_KEY` + `MAIL_FROM`, redeploy — no code change needed.
>
> Separately: Resend mail to `@americanbathgroup.com` currently sits in
> Mimecast's hold queue (the sending subdomain has no SPF record). Sort that
> with IT before relying on `ALERT_TO` pointing at an ABG inbox.

| Var | Purpose | State |
|---|---|---|
| `GOOGLE_SA_KEY` | base64 of the service-account JSON key | needed for sheet + photos |
| `SHEET_ID` | target Google Sheet | needed for sheet |
| `SHEET_TAB` | tab within it (default `Bootz`) — see the warning below | optional |
| `GCS_BUCKET` | photo bucket (default `dreamline-warranty-photos`) | optional |
| `RESEND_API_KEY` | Resend key | needed for any email |
| `MAIL_FROM` | e.g. `Bootz <registration@notify.bootz.com>` | needed for any email |
| `MAIL_REPLY_TO` | customer-facing reply address | optional |
| `ALERT_TO` | comma-separated internal recipients | enables low-rating alerts |
| `ALERT_THRESHOLD` | max stars that trigger an alert (default `3`) | optional |
| `PUBLIC_BASE_URL` | absolute origin for email images (default the live URL) | optional |

## Shared infrastructure

Reuses what was already provisioned for DreamLine / American Standard — same
service account, same photo bucket, same sheet, so all brands stay in one
dataset with a `Brand` column.

| Piece | Value |
|---|---|
| Vercel project | `bootz-warranty` (iamgeorgekelly) |
| Service account | `dl-warranty-writer@dl-warranty-reg-2026.iam.gserviceaccount.com` |
| Photo bucket | `gs://dreamline-warranty-photos` (project `care-diem`, public-read) |
| Sheet | `1MNdrXimnDFoj9iyMrmQMepYEqbawgCMnP-ALZ3CS8ec` ("DL QR Code") |
| Tab | **`Bootz`** — its own tab, auto-created on first write |

Photos are namespaced by brand folder (`bootz/…`).

**Bootz must stay on its own tab.** The DreamLine / American Standard function
writes to the default first tab and self-heals a *different* 12-column header on
every submission. If both apps shared a tab they'd rewrite each other's header
row on every write and misalign the existing rows. `SHEET_TAB` controls this and
defaults to `Bootz`; the tab is created automatically if missing.

## Sheet columns

`Timestamp · Brand · Registration ID · Audience · Full Name · Email · Company ·
Product · Warranty Term · Model # · Purchase Date · Purchased From · Rating ·
Review · Photos · Marketing Opt-In · Source URL`

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
