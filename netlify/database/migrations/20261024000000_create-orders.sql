CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  invoice TEXT UNIQUE NOT NULL,
  username TEXT NOT NULL,
  package TEXT NOT NULL,
  account_type TEXT NOT NULL DEFAULT '',
  total INTEGER NOT NULL,
  language TEXT NOT NULL DEFAULT 'id',
  status TEXT NOT NULL DEFAULT 'waiting_proof',
  sender_name TEXT,
  proof_key TEXT,
  proof_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  proof_at TIMESTAMPTZ
);

CREATE INDEX orders_created_at_idx ON orders (created_at DESC);
CREATE INDEX orders_username_idx ON orders (LOWER(username));
