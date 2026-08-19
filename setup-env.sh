#!/usr/bin/env bash
# One-time Vercel env setup for bootz-warranty.
#
#   bash setup-env.sh
#
# Sets only what's needed for the sheet + photo path. Email is intentionally
# left off — see "Turning email on" at the bottom.
set -euo pipefail

cd "$(dirname "$0")"

SA_KEY_JSON="/Users/macbookpro/Downloads/dreamline-warranty/sa-key.json"
SHEET_ID="1MNdrXimnDFoj9iyMrmQMepYEqbawgCMnP-ALZ3CS8ec"   # "DL QR Code"

if [ ! -f "$SA_KEY_JSON" ]; then
  echo "Service-account key not found at $SA_KEY_JSON" >&2
  exit 1
fi

echo "Setting GOOGLE_SA_KEY…"
base64 -i "$SA_KEY_JSON" | tr -d '\n' | vercel env add GOOGLE_SA_KEY production

echo "Setting SHEET_ID…"
printf '%s' "$SHEET_ID" | vercel env add SHEET_ID production

echo "Setting SHEET_TAB…"
printf '%s' "Bootz" | vercel env add SHEET_TAB production

echo
echo "Redeploying so the new env vars take effect…"
vercel deploy --prod --yes

cat <<'NOTE'

Done. Verify with:

  curl -s -X POST https://bootz-warranty.vercel.app/api/register \
    -H "Content-Type: application/json" \
    -d '{"brand":"Bootz","fullName":"Env check","email":"test@example.com","productType":"Aloha","rating":5}'

You want "sheet":true in the response. Then delete the test row from the Bootz
tab of the sheet.

--- Turning email on later -------------------------------------------------
Verify a Bootz sending domain in Resend first (notify.bootz.com), then:

  printf '%s' "<resend key>"                                  | vercel env add RESEND_API_KEY production
  printf '%s' "Bootz <registration@notify.bootz.com>"         | vercel env add MAIL_FROM production
  printf '%s' "georgek@americanbathgroup.com"                 | vercel env add ALERT_TO production
  vercel deploy --prod --yes

Until MAIL_FROM is set, both the customer confirmation and the low-rating alert
are skipped cleanly and the API returns "emailed":false. Nothing else changes.
NOTE
