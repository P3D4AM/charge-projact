#!/bin/bash
# راستی‌آزمایی انتها-به-انتهای لینک دعوت روی wrangler dev واقعی
set -e
B=http://127.0.0.1:8787/api

echo "== 0) login admin (install done previously) =="
curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d '{"username":"admin","password":"admin123"}' > /tmp/inst.json
ADMIN=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/inst.json')).token || ''")
if [ -z "$ADMIN" ]; then
  curl -s -X POST $B/install -H 'content-type: application/json' \
    -d '{"building_name":"برج راستی‌آزمایی","username":"admin","password":"admin123"}' > /tmp/inst.json
  ADMIN=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/inst.json')).token")
fi
echo "admin token: ${ADMIN:0:18}..."

echo "== 1) create manager via /a/users (idempotent), then login =="
curl -s -X POST $B/a/users -H "authorization: Bearer $ADMIN" -H 'content-type: application/json' \
  -d '{"username":"hossein","password":"pass123","role":"manager","full_name":"حسین مدیر"}' > /dev/null || true
curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d '{"username":"hossein","password":"pass123"}' > /tmp/mg.json
MG=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/mg.json')).token")

echo "== 2) create unit + resident account (unlinked) =="
curl -s -X POST $B/units -H "authorization: Bearer $MG" -H 'content-type: application/json' \
  -d '{"number":"5","resident_name":"علی رضایی","area_m2":85}' > /tmp/u.json
UNITID=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/u.json')).unit.id || 0")
if [ "$UNITID" = "0" ]; then
  # واحد از اجرای قبلی هست — از فهرست بگیر
  curl -s $B/units -H "authorization: Bearer $MG" > /tmp/ul.json
  UNITID=$(node -pe "const us=JSON.parse(require('fs').readFileSync('/tmp/ul.json')).units; (us.find(u=>u.number==='5')||{}).id")
fi
curl -s -X POST $B/residents -H "authorization: Bearer $MG" -H 'content-type: application/json' \
  -d "{\"username\":\"unit5\",\"password\":\"123456\",\"unit_id\":$UNITID,\"full_name\":\"علی رضایی\"}" > /dev/null || true
echo "unit id: $UNITID"

echo "== 3) create invite link =="
curl -s -X POST $B/units/$UNITID/invite -H "authorization: Bearer $MG" -H 'content-type: application/json' \
  -d '{"days":7}' > /tmp/inv.json
TOKEN=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/inv.json')).invite.token")
URL=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/inv.json')).invite.url")
echo "token: $TOKEN"
echo "url:   $URL"

echo "== 4) simulate Telegram webhook /start <token> =="
curl -s -X POST http://127.0.0.1:8787/webhook/telegram -H 'content-type: application/json' \
  -d "{\"message\":{\"chat\":{\"id\":9001,\"type\":\"private\"},\"from\":{\"id\":777001,\"username\":\"ali_rezaei\",\"first_name\":\"ساکن\"},\"text\":\"/start $TOKEN\"}}"
echo ""

echo "== 5) verify binding in DB =="
npx wrangler d1 execute building-charges --local --command "SELECT username, telegram_user_id, telegram_username, unit_id FROM users WHERE username='unit5'" --json 2>/dev/null | node -pe "JSON.stringify(JSON.parse(require('fs').readFileSync(0))[0].results, null, 1)"

echo "== 6) resident login + /my/summary =="
curl -s -X POST $B/auth/login -H 'content-type: application/json' -d '{"username":"unit5","password":"123456"}' > /tmp/res.json
RES=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/res.json')).token")
curl -s $B/my/summary -H "authorization: Bearer $RES" | head -c 120
echo ""

echo "== 7) reuse same token again → used response =="
curl -s -X POST http://127.0.0.1:8787/webhook/telegram -H 'content-type: application/json' \
  -d "{\"message\":{\"chat\":{\"id\":9002,\"type\":\"private\"},\"from\":{\"id\":777002,\"username\":\"other\",\"first_name\":\"دیگری\"},\"text\":\"/start $TOKEN\"}}"
echo " (ok = handled)"

echo "== 8) PDF dl-url (POST) → signed URL → GET without auth → %PDF =="
curl -s -X POST $B/pdf/dl-url -H "authorization: Bearer $RES" -H 'content-type: application/json' \
  -d '{"kind":"statement"}' > /tmp/dl.json
DLURL=$(node -pe "JSON.parse(require('fs').readFileSync('/tmp/dl.json')).url")
echo "dl-url: $DLURL"
curl -s "http://127.0.0.1:8787$DLURL" | head -c 8
echo ""
