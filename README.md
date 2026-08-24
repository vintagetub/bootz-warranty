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

## Bazaarvoice site-hosted Product Picker

Below the registration form, on the first screen, the page renders Bazaarvoice's
[site-hosted Product Picker](https://docs.bazaarvoice.com/articles/#!ratings-reviews/generic_review_submission/a/h2_1929406595)
so someone can post a real public review from here instead of being sent off to
a retailer to start over. It loads with the page, not behind a button.

**The public-review ask lives on the first screen only.** The confirmation
screen carries no review invitation at all any more — it is the registration
number, the email status and the support line, nothing else. Asking on both
screens meant asking the same person twice.

Configured in one block near the top of the script in `index.html`:

```js
var BV = {
  clientName:  'bootz',                   // blank disables the whole hand-off
  siteId:      'main_site',               // deployment zone
  environment: 'production',              // 'staging' while testing
  locale:      'en_US',
  campaignId:  'bootz_qr_registration',   // segments these reviews in BV reports
  categoryId:  ''                         // optional; ignored when a family matches
};
```

Blanking `clientName` is the kill switch: the block never appears and `bv.js` is
never requested. Everything else on the page is unaffected.

**Two prerequisites live outside this repo and are still unverified:**

1. **Product Picker must be switched on** in the Bazaarvoice Style Editor (V2).
   If the option isn't there, BV Support has to enable it.
2. **The product feed must map products to categories or product families**, or
   the picker renders an empty list. See
   [product catalog](https://docs.bazaarvoice.com/articles/ratings-reviews/product_catalog/a/Categori).

Because either could be missing on a live page, the block is **hidden until
Bazaarvoice actually paints into it**. If `bv.js` fails to load, or nothing has
rendered within 12 seconds, the empty picker is cleared out and the block falls
back to a **retailer link — still on the first screen**, keyed off "Where did it
come from?" and appearing when they answer it. Same fallback when `clientName`
is blank. If they bought it somewhere we can't link to, the block stays hidden;
there is never an empty panel sitting under the form.

### Scoping the picker

Two levers, in priority order — never both at once, which Bazaarvoice rejects.

**Category, per product group.** `BV_CATEGORY_BY_GROUP` maps the optgroups in
"What did you install?" to category `ExternalId`s, read straight off the
`<optgroup label>` so it stays in step with the dropdown:

| Group | Category `ExternalId` |
| --- | --- |
| Bathtubs | *not yet known* |
| Shower bases | `Shower_Base` |
| Wall kits | *not yet known* |
| Sinks | *not yet known* |

Groups with no ID fall back to `BV.categoryId` (currently `Shower_Base`), so
until the other three are filled in **someone registering a sink or a tub opens
the picker on shower bases**. Filling them in is the fix; BV's picker does show
a breadcrumb dropdown to navigate out in the meantime.

**Family.** `BV_FAMILY` maps each Bootz product family to the `ExternalId` of any product in
the matching Bazaarvoice product family. Every entry is currently **blank**, so
the picker opens on the root category. Fill an entry in and selecting that
product re-renders the picker scoped to that family
(`data-bv-family-product-id`) — but only until the customer touches the picker,
after which it is left alone rather than re-rendered out from under a
half-written review. Family and category are never both set — BV throws a
console error if you do that.

### Why isn't the picker showing?

Add **`?bvdebug=1`** to the URL. The block forces itself visible and prints what
happened — the resolved config, the exact `bv.js` URL requested, whether it
loaded, the picker div with its attributes, and which of the failure paths was
taken. It also goes to the browser console. Without the flag nothing about it is
visible to customers.

The three answers it distinguishes:

| Panel says | Means |
| --- | --- |
| `bv.js FAILED to load` | Blocked (ad blocker, CSP, network) or a wrong `clientName` / `siteId` / `environment` / `locale` — check the URL it printed |
| `loaded OK` then `rendered nothing in 12s` | Bazaarvoice is on the page but has nothing to draw: **Product Picker isn't enabled in the Style Editor**, or the feed has no category/family mappings |
| `rendered into the picker after Nms` | Working |

If the panel doesn't appear at all, the deployed build predates this change —
check the commit the deployment was built from.

When `bv.js` loads but draws nothing, the panel goes further: it lists the `BV`
globals bv.js defined, says whether `BV.ui()` exists, tees any Bazaarvoice
console errors into the panel (handy on a phone with no devtools), and then
tries the documented imperative path, `BV.ui('rr','submit_generic')`, as a
second opinion. If that draws something the declarative `data-bv-show` div is at
fault; if neither draws, **Product Picker isn't deployed to this zone or nothing
is mapped in the catalog** — which is a Bazaarvoice-side fix, not a code one.
The imperative attempt runs only under `?bvdebug=1`, since it can open a
lightbox.

Under `?bvdebug=1` only, **`?bvcategory=X`** and **`?bvfamily=X`** override the
config for one page load, so `ExternalId`s can be tried against the live
catalogue without a redeploy between guesses:

```
?bvdebug=1&bvcategory=BV_MISCELLANEOUS
?bvdebug=1&bvfamily=BZ011-5300
```

(`BV_MISCELLANEOUS` is the default category Bazaarvoice assigns products to when
a catalogue defines no categories of its own — worth trying first.) The two are
mutually exclusive; supplying both warns and uses the family.

**Status as of the first live test (`bootz-warranty-phi.vercel.app`):** `bv.js`
loaded OK in 118 ms, so `clientName` / `siteId` / `environment` / `locale` are
all correct and the deployment zone resolves. The picker div was in the DOM
before bv.js executed. Nothing rendered in 12 s. That puts the remaining fault
entirely on the Bazaarvoice configuration — see the two prerequisites above.

> **Not yet seen working.** Outbound access to `apps.bazaarvoice.com` is blocked
> from the development sandbox (the proxy returns 403 on the CONNECT), so the
> picker listing real products has never been observed. What *has* been verified
> in Chromium is the wiring around it: render-on-load, the campaign ID and
> inline attribute reaching the picker div, family re-scoping, the kill switch,
> `bv.js` blocked, `bv.js` loading but rendering nothing, and the picker leaving
> with the first screen on submit. **The first real test has to happen on the
> deployed page.**

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

- **Real product picker** — the actual Bootz line (Aloha, Bootzcast, Maui,
  Mauicast, Kona, Honolulu, Cambridge, Freedom, ShowerCast, NexTile, the
  glue-up wall systems, and all seven sinks), grouped by category. No more
  free-text product names to clean up later.
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
- **No review gating** — the public-review ask sits on the first screen, before
  anyone has rated anything, so it reaches *everyone* by construction. A low
  rating adds a "let us make it right" message to the confirmation screen but
  never withholds the invitation. Selectively inviting only happy customers is
  review gating; retailer policies and the FTC's consumer-review rule both take
  a dim view of it.
- **Marketing opt-in** — an explicit, unchecked consent box, captured as its own
  column so the list is clean enough to hand to Klaviyo.

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
