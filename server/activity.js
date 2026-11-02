// Activity log + undo. Every mutating endpoint calls logActivity() with a
// before/after snapshot; undoActivity() knows how to reverse each entity type.
import { q, one, all } from './db.js';

export async function logActivity({ householdId, userId, entityType, entityId, action, summary, before, after }) {
  const row = await one(
    `INSERT INTO activity_log (household_id, user_id, entity_type, entity_id, action, summary, before_data, after_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [householdId, userId, entityType, entityId || null, action, summary,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null]);
  return row.id;
}

export async function recentActivity(householdId, limit = 30) {
  return all(
    `SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id=a.user_id
     WHERE a.household_id=$1 ORDER BY a.created_at DESC LIMIT $2`,
    [householdId, limit]);
}

const EXPENSE_COLS = ['household_id', 'category_id', 'description', 'amount', 'expense_date', 'billing_period', 'paid_by', 'is_shared', 'split_method', 'status', 'notes', 'receipt_path', 'is_demo'];
const BILL_COLS = ['household_id', 'recurring_bill_id', 'category_id', 'name', 'amount', 'due_date', 'billing_period', 'status', 'paid_by', 'expense_id', 'is_demo'];
const SETTLEMENT_COLS = ['household_id', 'payer', 'recipient', 'amount', 'settled_on', 'method', 'notes', 'status', 'is_demo'];
const TOPUP_COLS = ['prepaid_account_id', 'amount', 'paid_by', 'topup_date', 'is_demo', 'shares'];
const USAGE_COLS = ['prepaid_account_id', 'amount', 'usage_date', 'note', 'is_demo'];
const RECURRING_COLS = ['category_id', 'name', 'frequency', 'expected_amount', 'due_rule', 'default_payer', 'active'];
const RENT_COLS = ['household_id', 'user_id', 'week_start', 'amount_due', 'amount_paid', 'status', 'is_demo'];

async function reinsert(table, id, cols, row) {
  const values = cols.map((c) => row[c]);
  const placeholders = cols.map((_, i) => '$' + (i + 2));
  await q(`INSERT INTO ${table} (id, ${cols.join(',')}) VALUES ($1, ${placeholders.join(',')})`, [id, ...values]);
}
async function updateBack(table, id, cols, row) {
  const sets = cols.map((c, i) => `${c}=$${i + 2}`).join(',');
  await q(`UPDATE ${table} SET ${sets} WHERE id=$1`, [id, ...cols.map((c) => row[c])]);
}

export async function undoActivity(activityId, actingUser) {
  const a = await one('SELECT * FROM activity_log WHERE id=$1', [activityId]);
  if (!a) throw { code: 'MISSING_FIELD', message: 'Nothing to undo — that action was not found.' };
  if (a.undone) throw { code: 'DUPLICATE_TRANSACTION', message: 'That action was already undone.' };
  if (a.household_id !== actingUser.household_id) throw { code: 'FORBIDDEN', message: 'Not your household.' };

  if (a.entity_type.startsWith('prepaid_') && a.action !== 'delete') {
    const table = a.entity_type === 'prepaid_topup' ? 'prepaid_topups' : 'prepaid_usage';
    const current = await one(`SELECT * FROM ${table} WHERE id=$1`, [a.entity_id]);
    if (!current || ['amount','paid_by','note','shares'].some(k => a.after_data?.[k] !== undefined && JSON.stringify(current[k]) !== JSON.stringify(a.after_data[k])))
      throw {code:'DUPLICATE_TRANSACTION',message:'This record changed since that action. Undo the newer change first.'};
  }
  const before = a.before_data;
  const after = a.after_data;

  switch (a.entity_type) {
    case 'expense': {
      if (a.action === 'create') {
        await q('DELETE FROM expenses WHERE id=$1', [a.entity_id]); // cascades expense_splits
      } else if (a.action === 'delete') {
        await reinsert('expenses', a.entity_id, EXPENSE_COLS, before);
        for (const s of before.splits || []) {
          await q('INSERT INTO expense_splits (expense_id, user_id, share_amount, share_percent) VALUES ($1,$2,$3,$4)',
            [a.entity_id, s.user_id, s.share_amount, s.share_percent]);
        }
      } else {
        await updateBack('expenses', a.entity_id, EXPENSE_COLS, before);
        await q('DELETE FROM expense_splits WHERE expense_id=$1', [a.entity_id]);
        for (const s of before.splits || []) {
          await q('INSERT INTO expense_splits (expense_id, user_id, share_amount, share_percent) VALUES ($1,$2,$3,$4)',
            [a.entity_id, s.user_id, s.share_amount, s.share_percent]);
        }
      }
      break;
    }
    case 'bill': {
      if (a.action === 'delete') {
        await reinsert('bills', a.entity_id, BILL_COLS, before);
      } else if (a.action === 'update') {
        // Undoing a "mark paid" also removes the expense it generated.
        // Restore the bill row FIRST (clearing its expense_id FK reference
        // back to null via the `before` snapshot), then delete the expense —
        // deleting it first would violate bills_expense_id_fkey while the
        // bill row still points at it.
        await updateBack('bills', a.entity_id, BILL_COLS, before);
        if (before.status === 'pending' && after && after.status === 'paid' && after.expense_id) {
          await q('DELETE FROM expenses WHERE id=$1', [after.expense_id]);
        }
      }
      break;
    }
    case 'settlement': {
      if (a.action === 'create') await q('DELETE FROM settlements WHERE id=$1', [a.entity_id]);
      else if (a.action === 'delete') await reinsert('settlements', a.entity_id, SETTLEMENT_COLS, before);
      else await updateBack('settlements', a.entity_id, SETTLEMENT_COLS, before);
      break;
    }
    case 'prepaid_topup': {
      if (a.action === 'create') await q('DELETE FROM prepaid_topups WHERE id=$1', [a.entity_id]);
      else if (a.action === 'delete') await reinsert('prepaid_topups', a.entity_id, TOPUP_COLS, before);
      else await updateBack('prepaid_topups', a.entity_id, TOPUP_COLS, before);
      break;
    }
    case 'prepaid_usage': {
      if (a.action === 'create') await q('DELETE FROM prepaid_usage WHERE id=$1', [a.entity_id]);
      else if (a.action === 'delete') await reinsert('prepaid_usage', a.entity_id, USAGE_COLS, before);
      else await updateBack('prepaid_usage', a.entity_id, USAGE_COLS, before);
      break;
    }
    case 'rent_record': {
      if (!before) {
        // First-ever payment for that week — undo means "never happened".
        await q('DELETE FROM rent_records WHERE id=$1', [a.entity_id]);
      } else {
        await updateBack('rent_records', a.entity_id, RENT_COLS, before);
      }
      break;
    }
    case 'recurring_bill': {
      if (a.action === 'create') {
        // Remove the bill it generated if nobody has paid it yet, then the recurring bill itself
        // (or just stop it, if older bills still point at it).
        if (after.generated_bill_id) await q("DELETE FROM bills WHERE id=$1 AND status='pending'", [after.generated_bill_id]);
        const used = await one('SELECT 1 FROM bills WHERE recurring_bill_id=$1 LIMIT 1', [a.entity_id]);
        if (used) await q('UPDATE recurring_bills SET active=false WHERE id=$1', [a.entity_id]);
        else await q('DELETE FROM recurring_bills WHERE id=$1', [a.entity_id]);
      } else if (a.action === 'update') {
        await updateBack('recurring_bills', a.entity_id, RECURRING_COLS, before);
      } else {
        await q('UPDATE recurring_bills SET active=true WHERE id=$1', [a.entity_id]);
      }
      break;
    }
    case 'budget': {
      // entity_id is the category. No budget before → remove it; otherwise put the old amount back.
      if (!before) await q('DELETE FROM category_budgets WHERE category_id=$1', [a.entity_id]);
      else {
        await q(`INSERT INTO category_budgets (category_id, household_id, monthly_amount) VALUES ($1,$2,$3)
                 ON CONFLICT (category_id) DO UPDATE SET monthly_amount=EXCLUDED.monthly_amount, updated_at=now()`,
          [a.entity_id, before.household_id, before.monthly_amount]);
      }
      break;
    }
    default:
      throw { code: 'DB_ERROR', message: 'This action type cannot be undone.' };
  }

  await q('UPDATE activity_log SET undone=true WHERE id=$1', [activityId]);
  return { ok: true };
}
