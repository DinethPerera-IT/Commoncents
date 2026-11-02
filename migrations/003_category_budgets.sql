-- 003: a monthly budget per category (optional). Spending against it is computed from
-- expenses, never stored, so it can't drift out of sync.
CREATE TABLE category_budgets (
  category_id UUID PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  household_id UUID NOT NULL REFERENCES households(id),
  monthly_amount NUMERIC(10,2) NOT NULL CHECK (monthly_amount > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
