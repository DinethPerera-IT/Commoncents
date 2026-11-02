-- Legacy liabilities are frozen by migrate.js in this same transaction before adoption.
ALTER TABLE prepaid_topups ADD COLUMN shares JSONB;
ALTER TABLE prepaid_accounts ADD COLUMN utilities_adopted BOOLEAN NOT NULL DEFAULT true;
UPDATE prepaid_accounts SET name='Fibre & Electricity';
ALTER TABLE recurring_bills ADD COLUMN utilities_retired BOOLEAN NOT NULL DEFAULT false;
UPDATE recurring_bills r SET active=false, utilities_retired=true FROM categories c
 WHERE r.category_id=c.id AND c.name='Electricity' AND r.frequency='monthly'
 AND EXISTS (SELECT 1 FROM prepaid_accounts p WHERE p.household_id=r.household_id);
-- Original categories/budgets and paid/unpaid bills remain untouched.
CREATE VIEW cash_outflows AS
 SELECT e.id,e.household_id,e.category_id,e.description,e.amount,e.expense_date,e.paid_by,
 CASE WHEN c.name IN ('Fibre / Broadband','Fibre & Electricity','Electricity') THEN 'Fibre & Electricity' ELSE c.name END AS category
 FROM expenses e JOIN categories c ON c.id=e.category_id
 UNION ALL
 SELECT t.id,p.household_id,c.id,'Fibre & Electricity top-up',t.amount,t.topup_date,t.paid_by,'Fibre & Electricity'
 FROM prepaid_topups t JOIN prepaid_accounts p ON p.id=t.prepaid_account_id
 JOIN LATERAL (SELECT id FROM categories WHERE household_id=p.household_id AND name IN ('Fibre / Broadband','Fibre & Electricity') ORDER BY sort LIMIT 1) c ON true;
