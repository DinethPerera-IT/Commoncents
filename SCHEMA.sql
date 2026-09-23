-- CommonCents schema.
-- Reconstructed to exactly match the column names used in server/*.js —
-- cross-referenced against every INSERT/SELECT/UPDATE in the live code
-- rather than written independently, so this file is guaranteed
-- consistent with what's actually running.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  initials TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  weekly_rent NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  UNIQUE (household_id, name)
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  category_id UUID NOT NULL REFERENCES categories(id),
  description TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  expense_date DATE NOT NULL,
  billing_period TEXT,
  paid_by UUID NOT NULL REFERENCES users(id),
  is_shared BOOLEAN NOT NULL DEFAULT true,
  split_method TEXT NOT NULL DEFAULT 'equal' CHECK (split_method IN ('equal','custom','percent')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','settled')),
  notes TEXT,
  receipt_path TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE expense_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  share_amount NUMERIC(10,2) NOT NULL,
  share_percent NUMERIC(5,2)
);

CREATE TABLE recurring_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  category_id UUID NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','fortnightly','monthly','yearly')),
  expected_amount NUMERIC(10,2),
  due_rule TEXT,
  default_payer UUID REFERENCES users(id),
  default_split TEXT NOT NULL DEFAULT 'equal',
  active BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  recurring_bill_id UUID REFERENCES recurring_bills(id),
  category_id UUID NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  due_date DATE NOT NULL,
  billing_period TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_by UUID REFERENCES users(id),
  expense_id UUID REFERENCES expenses(id),
  is_demo BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  payer UUID NOT NULL REFERENCES users(id),
  recipient UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  settled_on DATE NOT NULL,
  method TEXT NOT NULL DEFAULT 'bank_transfer',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  is_demo BOOLEAN NOT NULL DEFAULT false,
  CHECK (payer <> recipient)
);

CREATE TABLE prepaid_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  allocation_method TEXT NOT NULL DEFAULT 'equal' CHECK (allocation_method IN ('equal','percent','custom'))
);

CREATE TABLE prepaid_topups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prepaid_account_id UUID NOT NULL REFERENCES prepaid_accounts(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  paid_by UUID NOT NULL REFERENCES users(id),
  topup_date DATE NOT NULL,
  is_demo BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE prepaid_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prepaid_account_id UUID NOT NULL REFERENCES prepaid_accounts(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  usage_date DATE NOT NULL,
  note TEXT,
  is_demo BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE prepaid_allocations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prepaid_account_id UUID NOT NULL REFERENCES prepaid_accounts(id),
  user_id UUID NOT NULL REFERENCES users(id),
  percent NUMERIC(5,2),
  fixed_amount NUMERIC(10,2)
);

CREATE TABLE rent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  user_id UUID NOT NULL REFERENCES users(id),
  week_start DATE NOT NULL,
  amount_due NUMERIC(10,2) NOT NULL,
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid','partial','unpaid')),
  is_demo BOOLEAN NOT NULL DEFAULT true,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

-- Undo support: one row per mutation, with enough of a before/after
-- snapshot to reverse it. Added post-launch — see README for why.
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  user_id UUID REFERENCES users(id),
  entity_type TEXT NOT NULL,
  entity_id UUID,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  summary TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  undone BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_household ON activity_log (household_id, created_at DESC);
