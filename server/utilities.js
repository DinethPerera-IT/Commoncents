import { one, all, q, tx } from './db.js';
import { equalSplit, percentSplit, toCents, today, fibreStats } from './calc.js';
import { logActivity } from './activity.js';
const fail = message => { throw {code:'INVALID_AMOUNT',message}; };
export const amountOf = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0 || n > 99999999.99 || Math.abs(n*100-Math.round(n*100))>0.00001) fail('Enter a positive amount with at most two decimal places.');
  return toCents(n)/100;
};
function dateOf(value) {
  const d = value instanceof Date ? [value.getFullYear(),String(value.getMonth()+1).padStart(2,'0'),String(value.getDate()).padStart(2,'0')].join('-') : String(value === undefined || value === null ? today() : value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d) fail('Enter a valid date.');
  return d;
}
export async function utilitiesLock(household) {
  return one('SELECT * FROM prepaid_accounts WHERE household_id=$1 ORDER BY id LIMIT 1 FOR UPDATE', [household]);
}
export async function checkCredit(id) {
  const r = await one(`SELECT (SELECT COALESCE(SUM(amount),0) FROM prepaid_topups WHERE prepaid_account_id=$1)
    - (SELECT COALESCE(SUM(amount),0) FROM prepaid_usage WHERE prepaid_account_id=$1) AS credit`, [id]);
  if (Number(r.credit)<0) fail('This change would leave negative prepaid credit. Record missing top-ups first.');
}
export async function allocate(amount, users, method='equal', rows=[]) {
  if (method==='equal') return equalSplit(amount,users.map(u=>u.id));
  if (!['percent','custom'].includes(method) || !Array.isArray(rows) || rows.length!==users.length || new Set(rows.map(r=>r.user_id)).size!==users.length || rows.some(r=>!users.some(u=>u.id===r.user_id))) fail('Provide one allocation for every active member.');
  const key = method==='percent'?'percent':'fixed_amount';
  if (rows.some(r=>!Number.isFinite(Number(r[key])) || Number(r[key])<0)) fail('Shares must be zero or greater.');
  if (method==='percent') {
    if (Math.abs(rows.reduce((s,r)=>s+Number(r.percent),0)-100)>0.000001) fail('Percentages must add up to 100%.');
    return Object.fromEntries(percentSplit(amount,rows.map(r=>({user_id:r.user_id,share_percent:Number(r.percent)}))).map(r=>[r.user_id,r.share_amount]));
  }
  if (rows.some(r=>Math.abs(Number(r.fixed_amount)*100-toCents(r.fixed_amount))>0.00001) || rows.reduce((s,r)=>s+toCents(r.fixed_amount),0)!==toCents(amount)) fail('Custom shares must add up to the top-up.');
  return Object.fromEntries(rows.map(r=>[r.user_id,Number(r.fixed_amount)]));
}
export function registerUtilities(app, wrap) {
  app.get('/api/prepaid',wrap(async(req,res)=>{
    const acc=await one('SELECT * FROM prepaid_accounts WHERE household_id=$1 LIMIT 1',[req.user.household_id]);
    const topups=await all('SELECT t.*,u.name AS paid_by_name FROM prepaid_topups t JOIN users u ON u.id=t.paid_by WHERE prepaid_account_id=$1 ORDER BY topup_date DESC',[acc.id]);
    const usage=await all('SELECT * FROM prepaid_usage WHERE prepaid_account_id=$1 ORDER BY usage_date DESC',[acc.id]);
    res.json({...acc,...fibreStats(topups,usage),topups,usage});
  }));
  for (const kind of ['topups','usage']) for (const verb of ['post','patch','delete']) {
    const table='prepaid_'+kind, date=kind==='topups'?'topup_date':'usage_date', entity=kind==='topups'?'prepaid_topup':'prepaid_usage';
    app[verb]('/api/prepaid/'+kind+(verb==='post'?'':'/:id'),wrap(async(req,res)=>{
      const result=await tx(async()=>{
        const acc=await utilitiesLock(req.user.household_id);
        const before=verb==='post'?null:await one(`SELECT * FROM ${table} WHERE id=$1 AND prepaid_account_id=$2`,[req.params.id,acc.id]);
        if (verb!=='post'&&!before) throw {code:'MISSING_FIELD',message:'Record not found.'};
        let after=null;
        if (verb==='delete') await q(`DELETE FROM ${table} WHERE id=$1`,[before.id]);
        else {
          const body=req.body||{}, amount=amountOf(body.amount??before?.amount), day=dateOf(body[date]??before?.[date]);
          if (kind==='topups') {
            const users=await all('SELECT id FROM users WHERE household_id=$1 AND active ORDER BY created_at',[req.user.household_id]);
            const payer=body.paid_by||before?.paid_by||req.user.id;
            if (!users.some(u=>u.id===payer)) fail('Choose an active household member as payer.');
            const shares=body.method || !before ? await allocate(amount,users,body.method||'equal',body.allocations||[]) : before.shares;
            if (!body.method && before && amount!==Number(before.amount)) fail('Choose the allocation again when changing a top-up amount.');
            if (before) after=await one('UPDATE prepaid_topups SET amount=$1,paid_by=$2,topup_date=$3,shares=$4 WHERE id=$5 RETURNING *',[amount,payer,day,JSON.stringify(shares),before.id]);
            else after=await one('INSERT INTO prepaid_topups(prepaid_account_id,amount,paid_by,topup_date,shares) VALUES($1,$2,$3,$4,$5) RETURNING *',[acc.id,amount,payer,day,JSON.stringify(shares)]);
          } else {
            const note=String(body.note??before?.note??'').slice(0,500);
            if(before) after=await one('UPDATE prepaid_usage SET amount=$1,usage_date=$2,note=$3 WHERE id=$4 RETURNING *',[amount,day,note,before.id]);
            else after=await one('INSERT INTO prepaid_usage(prepaid_account_id,amount,usage_date,note) VALUES($1,$2,$3,$4) RETURNING *',[acc.id,amount,day,note]);
          }
        }
        await checkCredit(acc.id);
        const activity_id=await logActivity({householdId:req.user.household_id,userId:req.user.id,entityType:entity,entityId:after?.id||before.id,action:{post:'create',patch:'update',delete:'delete'}[verb],summary:({post:'Recorded',patch:'Edited',delete:'Deleted'}[verb])+' Fibre & Electricity '+(kind==='topups'?'top-up':'usage'),before,after});
        return {ok:true,activity_id,id:after?.id};
      });res.json(result);
    }));
  }
  app.put('/api/prepaid/allocation',wrap(async(_req,_res)=>{throw {code:'INVALID_AMOUNT',message:'Set allocation on each top-up. Historical shares cannot be changed here.'};}));
}
