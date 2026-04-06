ALTER TABLE parks ADD COLUMN slug TEXT UNIQUE;

-- Backfill slugs from park name: lowercase, replace non-alphanumeric with hyphens, trim
UPDATE parks
SET slug = LOWER(REGEXP_REPLACE(TRIM(name), '[^a-zA-Z0-9]+', '-', 'g'));

ALTER TABLE parks ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX idx_parks_slug ON parks (slug);
