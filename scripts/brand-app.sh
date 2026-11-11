#!/usr/bin/env bash
# Generate per-tenant branding assets for the Android build.
# Inputs (env): TENANT_SLUG, TENANT_NAME, BRAND_PRIMARY, BRAND_SECONDARY,
#               API_BASE, COUNTRY, CURRENCY, MARKUP, TAGLINE, SUPPORT_EMAIL,
#               LOGO_FILE (optional path to an uploaded logo)
# Outputs: brand.json, app/src/main/res/values/colors.xml,
#          mipmap-*/ic_launcher.png, and (optionally) a generated initials logo.
set -euo pipefail

TENANT_SLUG="${TENANT_SLUG:-smspin}"
TENANT_NAME="${TENANT_NAME:-SMSPin}"
BRAND_PRIMARY="${BRAND_PRIMARY:-#E11D2E}"
BRAND_SECONDARY="${BRAND_SECONDARY:-#0EA5E9}"
API_BASE="${API_BASE:-https://smspin.io}"
COUNTRY="${COUNTRY:-NG}"
CURRENCY="${CURRENCY:-NGN}"
MARKUP="${MARKUP:-0}"
TAGLINE="${TAGLINE:-Virtual numbers, instantly}"
SUPPORT_EMAIL="${SUPPORT_EMAIL:-support@smspin.io}"

# --- 1. brand.json (single source consumed by the app) -----------------------
cat > brand.json <<JSON
{
  "slug": "${TENANT_SLUG}",
  "name": "${TENANT_NAME}",
  "primary": "${BRAND_PRIMARY}",
  "secondary": "${BRAND_SECONDARY}",
  "apiBase": "${API_BASE}",
  "country": "${COUNTRY}",
  "currency": "${CURRENCY}",
  "markup": ${MARKUP},
  "tagline": "${TAGLINE}",
  "supportEmail": "${SUPPORT_EMAIL}"
}
JSON

# --- 2. colours --------------------------------------------------------------
cat > app/src/main/res/values/colors.xml <<XML
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="brand_primary">${BRAND_PRIMARY}</color>
    <color name="brand_on_primary">#FFFFFF</color>
</resources>
XML

# --- 3. logo: uploaded wins, else generate initials mark ---------------------
# Initials from the business name (e.g. "Nova Numbers" -> "NN").
initials() {
  echo "$1" | tr -c 'A-Za-z0-9 ' ' ' | awk '{
    n=split($0,w," "); out="";
    for(i=1;i<=n;i++){ if(length(w[i])>0){ out=out substr(w[i],1,1); if(length(out)==2) break } }
    print toupper(out)
  }'
}

generate_logo() {
  local out="$1" size="$2"
  local text; text="$(initials "$TENANT_NAME")"; [ -z "$text" ] && text="SP"
  command -v magick >/dev/null 2>&1 || command -v convert >/dev/null 2>&1 || { echo "ImageMagick missing"; return 1; }
  local IM; IM="$(command -v magick || command -v convert)"
  "$IM" -size "${size}x${size}" "xc:${BRAND_PRIMARY}" \
    -gravity center -pointsize "$(( size / 2 ))" -fill white \
    -font DejaVu-Sans-Bold -annotate 0 "$text" "$out"
}

mkdir -p app/src/main/res/mipmap-mdpi app/src/main/res/mipmap-hdpi \
         app/src/main/res/mipmap-xhdpi app/src/main/res/mipmap-xxhdpi \
         app/src/main/res/mipmap-xxxhdpi

declare -A DENS=( [mdpi]=48 [hdpi]=72 [xhdpi]=96 [xxhdpi]=144 [xxxhdpi]=192 )
if [ -n "${LOGO_FILE:-}" ] && [ -f "${LOGO_FILE}" ]; then
  echo "Using uploaded logo: ${LOGO_FILE}"
  for d in "${!DENS[@]}"; do
    IM="$(command -v magick || command -v convert)"
    "$IM" "$LOGO_FILE" -resize "${DENS[$d]}x${DENS[$d]}" "app/src/main/res/mipmap-${d}/ic_launcher.png"
  done
else
  echo "No logo uploaded - generating initials logo from '${TENANT_NAME}'"
  for d in "${!DENS[@]}"; do
    generate_logo "app/src/main/res/mipmap-${d}/ic_launcher.png" "${DENS[$d]}"
  done
fi

echo "Branding written: brand.json + colors.xml + launcher icons"
cat brand.json
