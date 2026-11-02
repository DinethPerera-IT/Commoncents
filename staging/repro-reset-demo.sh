#!/usr/bin/env bash
# Reproduction for reset-demo vs bills.expense_id, run against the staging copy (port 3041).
set -u
API=http://127.0.0.1:3041; J=$(mktemp); trap 'rm -f $J' EXIT
sql() { docker exec ccstage-db-1 psql -U commoncents -d commoncents -qAtc "$1"; }
curl -s -c $J -H 'Content-Type: application/json' -d '{"name":"Dominic","password":"stage-only-password"}' $API/api/auth/login >/dev/null
CAT=$(sql "select id from categories limit 1"); HH=$(sql "select id from households limit 1"); U=$(sql "select id from users limit 1")

echo "--- A: pay a demo bill through the API, then reset-demo"
DB=$(sql "insert into bills (household_id,category_id,name,amount,due_date,status,is_demo) values ('$HH','$CAT','DEMO bill A',40,current_date,'pending',true) returning id")
curl -s -b $J -X POST $API/api/bills/$DB/pay -H 'Content-Type: application/json' -d '{}' | head -c 80; echo
curl -s -b $J -X POST $API/api/admin/reset-demo -w '  -> HTTP %{http_code}\n' -o /dev/null
echo "  leftover 'DEMO bill A' expenses (should be 0): $(sql "select count(*) from expenses where description='DEMO bill A'")"

echo "--- B: a REAL bill paid with a demo expense, then reset-demo"
DE=$(sql "insert into expenses (household_id,category_id,description,amount,expense_date,paid_by,is_demo) values ('$HH','$CAT','DEMO expense B',25,current_date,'$U',true) returning id")
RB=$(sql "insert into bills (household_id,category_id,name,amount,due_date,status,paid_by,expense_id,is_demo) values ('$HH','$CAT','REAL bill B',25,current_date,'paid','$U','$DE',false) returning id")
curl -s -b $J -X POST $API/api/admin/reset-demo -w '  -> HTTP %{http_code}\n' -o /dev/null
echo "  real bill B now: $(sql "select status||' expense_id='||coalesce(expense_id::text,'null') from bills where id='$RB'")"
echo "  demo expense B left (should be 0): $(sql "select count(*) from expenses where id='$DE'")"
echo "  real expenses still there: $(sql "select count(*) from expenses where not is_demo and description not like 'DEMO%'")"
