CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE parks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  owner_name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  owner_phone TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  park_id UUID NOT NULL REFERENCES parks(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'rv',
  length_ft INTEGER,
  has_electric BOOLEAN NOT NULL DEFAULT true,
  has_water BOOLEAN NOT NULL DEFAULT true,
  has_sewer BOOLEAN NOT NULL DEFAULT true,
  amp_service INTEGER DEFAULT 30,
  price_per_night INTEGER NOT NULL,
  map_x REAL,
  map_y REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL,
  guest_phone TEXT,
  check_in DATE NOT NULL,
  check_out DATE NOT NULL,
  nights INTEGER NOT NULL,
  nightly_rate INTEGER NOT NULL,
  total INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_payment_intent_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_dates CHECK (check_out > check_in),
  CONSTRAINT valid_status CHECK (status IN ('pending', 'confirmed', 'cancelled'))
);

CREATE TABLE pricing_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  park_id UUID NOT NULL REFERENCES parks(id) ON DELETE CASCADE,
  min_nights INTEGER NOT NULL,
  discount_pct NUMERIC(5, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT valid_discount CHECK (discount_pct >= 0 AND discount_pct <= 100)
);

-- Prevent overlapping confirmed/pending bookings on the same space
CREATE UNIQUE INDEX no_overlap_bookings
  ON bookings (space_id, check_in, check_out)
  WHERE status IN ('pending', 'confirmed');

-- Fast availability lookups
CREATE INDEX idx_bookings_space_dates
  ON bookings (space_id, check_in, check_out)
  WHERE status IN ('pending', 'confirmed');

CREATE INDEX idx_spaces_park ON spaces (park_id);
CREATE INDEX idx_bookings_status ON bookings (status);
CREATE INDEX idx_bookings_stripe ON bookings (stripe_payment_intent_id);
CREATE INDEX idx_pricing_rules_park ON pricing_rules (park_id, min_nights);
