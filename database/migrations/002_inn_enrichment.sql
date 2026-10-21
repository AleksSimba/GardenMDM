ALTER TABLE contractors ADD COLUMN registry_snapshot JSONB
  CHECK (registry_snapshot IS NULL OR jsonb_typeof(registry_snapshot)='object');

CREATE TABLE party_lookup_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider VARCHAR(40) NOT NULL,
  inn VARCHAR(12) NOT NULL CHECK (inn ~ '^([0-9]{10}|[0-9]{12})$'),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload)='object'),
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now()+interval '24 hours'),
  CHECK (expires_at>fetched_at)
);
CREATE INDEX party_lookup_cache_search_idx ON party_lookup_cache(provider,inn,expires_at DESC);
CREATE INDEX party_lookup_cache_expiry_idx ON party_lookup_cache(expires_at);
