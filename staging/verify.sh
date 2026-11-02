#!/usr/bin/env bash
# Phase 1 verification against the staging copy (port 3041). Prints PASS/FAIL per check.
set -u
API=http://127.0.0.1:3041; J=$(mktemp)
# Unique per run: the app rejects an identical expense twice in a row (double-tap guard),
# and the limiter remembers an IP for 15 min, so each run uses fresh values.
RUN=$(date +%s); IP1=203.0.113.$((RUN % 200 + 1)); IP2=198.51.100.$((RUN % 200 + 1)); trap 'rm -f $J /tmp/cc-r.$$' EXIT
pass() { printf '  PASS  %s\n' "$*"; }; fail() { printf '  FAIL  %s\n' "$*"; }
check() { if [ "$2" = "$3" ]; then pass "$1 ($2)"; else fail "$1 (got $2, want $3)"; fi; }
sql() { docker exec ccstage-db-1 psql -U commoncents -d commoncents -qAtc "$1"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== basics"
check "healthz without login" "$(code $API/healthz)" 200
check "API needs login" "$(code $API/api/expenses)" 401
check "SPA deep link (Express 5 regex route)" "$(curl -s $API/some/deep/link | grep -c '<div id="app">')" 1
check "login" "$(code -c $J -H 'Content-Type: application/json' -d '{"name":"Dominic","password":"stage-only-password"}' $API/api/auth/login)" 200
check "expenses list with query filters" "$(code -b $J "$API/api/expenses?status=pending&sort=amount")" 200
H=$(curl -sI $API/); echo "$H" | grep -qi "content-security-policy: default-src 'self';script-src 'self'" && pass "CSP header" || fail "CSP header"
echo "$H" | grep -qi 'strict-transport-security' && fail "HSTS should be off on http" || pass "no HSTS on plain http"
echo "$H" | grep -qi 'x-powered-by' && fail "x-powered-by present" || pass "no x-powered-by"
SW=$(curl -s $API/sw.js | sed -n "s/.*cc-shell-\([0-9a-f]*\).*/\1/p"); B=$(curl -s $API/healthz | sed -n 's/.*"build":"\([0-9a-f]*\)".*/\1/p')
check "service worker cache name = build id" "$SW" "$B"

echo "== receipts"
OLD=$(sql "select receipt_path from expenses where receipt_path is not null limit 1")
check "receipt restored from backup opens" "$(code -b $J $API/api/receipts/$(basename "$OLD"))" 200
printf '\x89PNG\r\n\x1a\n%0100d' 0 > /tmp/cc-r.$$
CAT=$(sql "select name from categories order by sort limit 1"); ME=$(sql "select id from users where name='Dominic'")
R=$(curl -s -b $J -F description="Phase1 receipt test $RUN" -F amount=12.34 -F expense_date=$(date +%F) -F category="$CAT" -F paid_by=$ME -F split_method=equal -F "receipt=@/tmp/cc-r.$$;type=image/png" $API/api/expenses)
EID=$(echo "$R" | sed -n 's/.*"id":"\([0-9a-f-]*\)".*/\1/p' | head -1)
RP=$([ -n "$EID" ] && sql "select receipt_path from expenses where id='$EID'"); [ -n "$EID" ] && [ -n "$RP" ] && pass "expense with receipt created" || fail "expense with receipt: $R"
echo "$EID $RP" > ${STATE:-/dev/null}

echo "== bills: pay -> undo, pay -> unpay"
BID=$(sql "select id from bills where status='pending' order by due_date limit 1")
ACT=$(curl -s -b $J -X POST -H 'Content-Type: application/json' -d '{}' $API/api/bills/$BID/pay | sed -n 's/.*"activity_id":"\([0-9a-f-]*\)".*/\1/p')
check "bill paid" "$(sql "select status from bills where id='$BID'")" paid
check "undo the payment" "$(code -b $J -X POST $API/api/activity/$ACT/undo)" 200
check "bill pending again, expense gone" "$(sql "select status||':'||coalesce(expense_id::text,'none') from bills where id='$BID'")" "pending:none"
curl -s -b $J -X POST -H 'Content-Type: application/json' -d '{}' $API/api/bills/$BID/pay >/dev/null
check "unpay route" "$(code -b $J -X POST $API/api/bills/$BID/unpay)" 200
X=$(sql "select id from expenses where not is_demo and description not like 'Phase1 receipt test%' limit 1")
check "edit expense with no date supplied (README bug 1)" "$(code -b $J -X PATCH -H 'Content-Type: application/json' -d '{"notes":"phase1 edit"}' $API/api/expenses/$X)" 200

echo "== login rate limit (per client IP from X-Forwarded-For)"
for i in $(seq 1 10); do c=$(code -H "X-Forwarded-For: $IP1" -H 'Content-Type: application/json' -d '{"name":"Dominic","password":"wrong"}' $API/api/auth/login); [ $c = 401 ] || fail "attempt $i got $c"; done
check "11th wrong attempt" "$(code -H "X-Forwarded-For: $IP1" -H 'Content-Type: application/json' -d '{"name":"Dominic","password":"wrong"}' $API/api/auth/login)" 429
check "even the right password is blocked for that IP" "$(code -H "X-Forwarded-For: $IP1" -H 'Content-Type: application/json' -d '{"name":"Dominic","password":"stage-only-password"}' $API/api/auth/login)" 429
check "another client is not affected" "$(code -H "X-Forwarded-For: $IP2" -H 'Content-Type: application/json' -d '{"name":"Dominic","password":"wrong"}' $API/api/auth/login)" 401
check "DB error text not sent to client" "$(curl -s -b $J -X PATCH -H 'Content-Type: application/json' -d '{"amount":5}' $API/api/bills/not-a-uuid | grep -c 'invalid input syntax')" 0
