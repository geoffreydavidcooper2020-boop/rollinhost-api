ALTER TABLE bookings ADD COLUMN rate_type TEXT NOT NULL DEFAULT 'nightly';
ALTER TABLE bookings ADD COLUMN booking_source TEXT;

ALTER TABLE bookings ADD CONSTRAINT valid_rate_type
  CHECK (rate_type IN ('nightly', 'weekly', 'monthly'));
