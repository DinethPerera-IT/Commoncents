-- CommonCents — PostgreSQL schema (v1)
CREATE TABLE households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'NZD',
  week_starts_on SMALLINT NOT NULL DEFAULT 1, -- 1 = Monday
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  initials CHAR(2) NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT,              -- argon2id / bcrypt; NULL until account claimed
  weekly_rent NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_admin BOOLEAN NOT NULL DEFAULT false,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,
  sort SMALLINT NOT NULL DEFAULT 0,
  UNIQUE (household_id, name)
);

-- One row per member per week (week_start = Monday date)
CREATE TABLE rent_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  user_id UUID NOT NULL REFERENCES users(id),
  week_start DATE NOT NULL,
  amount_due NUMERIC(10,2) NOT NULL,
  amount_paid NUMERIC(10,2) NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid' CHECK (status IN ('paid','partial','unpaid')),
  is_demo BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);
CREATE INDEX idx_rent_week ON rent_records (household_id, week_start);

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
  receipt_path TEXT,               -- file stored on disk volume, path only in DB
  is_demo BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_expenses_date ON expenses (household_id, expense_date);

CREATE TABLE expense_splits (
  expense_id UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  share_amount NUMERIC(10,2) NOT NULL DEFAULT 0,
  share_percent NUMERIC(5,2),
  PRIMARY KEY (expense_id, user_id)
);
-- App-level invariant: SUM(share_amount) per expense == expenses.amount (validate server-side).

CREATE TABLE recurring_bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  category_id UUID NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('weekly','monthly','prepaid')),
  expected_amount NUMERIC(10,2),
  due_rule TEXT,                   -- e.g. 'MON', 'DAY:12', 'ON_DEPLETION'
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
  amount NUMERIC(10,2) NOT NULL,
  due_date DATE NOT NULL,
  billing_period TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid')),
  paid_by UUID REFERENCES users(id),
  expense_id UUID REFERENCES expenses(id), -- created when marked paid
  is_demo BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX idx_bills_due ON bills (household_id, status, due_date);

CREATE TABLE prepaid_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  name TEXT NOT NULL,              -- 'Fibre / Broadband'
  allocation_method TEXT NOT NULL DEFAULT 'equal' CHECK (allocation_method IN ('equal','percent','custom'))
);

CREATE TABLE prepaid_allocations (
  prepaid_account_id UUID NOT NULL REFERENCES prepaid_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id),
  percent NUMERIC(5,2),
  fixed_amount NUMERIC(10,2),
  PRIMARY KEY (prepaid_account_id, user_id)
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

CREATE TABLE settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  payer UUID NOT NULL REFERENCES users(id),
  recipient UUID NOT NULL REFERENCES users(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  settled_on DATE NOT NULL,
  method TEXT NOT NULL DEFAULT 'bank_transfer',
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','pending','cancelled')),
  is_demo BOOLEAN NOT NULL DEFAULT false,
  CHECK (payer <> recipient)
);

-- Undo support: one row per mutation, with enough of a before/after snapshot to reverse it.
CREATE TABLE activity_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id),
  user_id UUID REFERENCES users(id),
  entity_type TEXT NOT NULL, -- 'expense' | 'bill' | 'settlement' | 'prepaid_topup' | 'prepaid_usage' | 'rent_record'
  entity_id UUID,
  action TEXT NOT NULL CHECK (action IN ('create','update','delete')),
  summary TEXT NOT NULL,
  before_data JSONB,
  after_data JSONB,
  undone BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_activity_household ON activity_log (household_id, created_at DESC);
