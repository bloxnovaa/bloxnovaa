-- Roblox accounts for sale. account_username stays admin-only; the storefront shows the
-- avatar (via roblox_user_id), the game and the item list (pets, clothes, gamepasses, ...).
CREATE TABLE account_listings (
  id SERIAL PRIMARY KEY,
  universe_id BIGINT,
  game_name TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL,
  badge TEXT NOT NULL DEFAULT '',
  account_username TEXT NOT NULL DEFAULT '',
  roblox_user_id BIGINT,
  account_created TIMESTAMPTZ,
  price INTEGER NOT NULL,
  strike_price INTEGER,
  items JSONB NOT NULL DEFAULT '[]',
  description TEXT NOT NULL DEFAULT '',
  photos JSONB NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'available',
  reserved_invoice TEXT,
  reserved_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sold_at TIMESTAMPTZ
);

CREATE INDEX account_listings_status_idx ON account_listings (status, created_at DESC);

-- Orders placed for an account listing (NULL for Robux top ups) plus the buyer's contact.
ALTER TABLE orders ADD COLUMN listing_id INTEGER;
ALTER TABLE orders ADD COLUMN contact TEXT;
