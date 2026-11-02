-- Web Push subscriptions: admins get alerts for new orders/proofs (invoice = ''),
-- buyers get alerts when their invoice is approved or rejected.
CREATE TABLE push_subscriptions (
  id SERIAL PRIMARY KEY,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'buyer',
  invoice TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (endpoint, role, invoice)
);

CREATE INDEX push_subscriptions_role_invoice_idx ON push_subscriptions (role, invoice);
