-- Login details handed to the buyer once the admin approves the payment (admin-only, never listed publicly).
ALTER TABLE account_listings ADD COLUMN login_password TEXT NOT NULL DEFAULT '';
ALTER TABLE account_listings ADD COLUMN login_note TEXT NOT NULL DEFAULT '';
