-- Retain only file fingerprints when order history and images are deleted.
CREATE TABLE payment_proof_fingerprints (
  hash TEXT PRIMARY KEY,
  proof_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX payment_proof_fingerprints_key_idx ON payment_proof_fingerprints (proof_key);
