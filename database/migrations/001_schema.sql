CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = clock_timestamp(); RETURN NEW; END $$;

CREATE TABLE contractors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name VARCHAR(255) NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 255),
  inn VARCHAR(12) NOT NULL UNIQUE CHECK (inn ~ '^([0-9]{10}|[0-9]{12})$'),
  kpp VARCHAR(9),
  status VARCHAR(50) NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (status IN ('PENDING_REVIEW','ACTIVE','REJECTED','MERGED','ARCHIVED')),
  legal_address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((length(inn)=10 AND kpp IS NOT NULL AND kpp ~ '^[0-9]{9}$') OR (length(inn)=12 AND kpp IS NULL))
);
CREATE INDEX contractors_status_idx ON contractors(status);
CREATE TRIGGER contractors_updated BEFORE UPDATE ON contractors FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE FUNCTION immutable_inn() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN IF NEW.inn IS DISTINCT FROM OLD.inn THEN RAISE EXCEPTION 'immutable inn' USING ERRCODE='23514'; END IF; RETURN NEW; END $$;
CREATE TRIGGER contractors_immutable_inn BEFORE UPDATE ON contractors FOR EACH ROW EXECUTE FUNCTION immutable_inn();

CREATE TABLE contractor_bank_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  bank_name VARCHAR(255) NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 2 AND 255),
  bik VARCHAR(9) NOT NULL CHECK (bik ~ '^[0-9]{9}$'),
  account_number VARCHAR(20) NOT NULL CHECK (account_number ~ '^[0-9]{20}$'),
  correspondent_account VARCHAR(20) CHECK (correspondent_account ~ '^[0-9]{20}$'),
  currency VARCHAR(3) NOT NULL DEFAULT 'RUB' CHECK (currency IN ('RUB','USD','EUR','CNY')),
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(contractor_id,bik,account_number)
);
CREATE INDEX accounts_contractor_idx ON contractor_bank_accounts(contractor_id);
CREATE UNIQUE INDEX accounts_one_primary_idx ON contractor_bank_accounts(contractor_id) WHERE is_primary;
CREATE TRIGGER accounts_updated BEFORE UPDATE ON contractor_bank_accounts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE FUNCTION lock_account_parent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid UUID;
BEGIN
  IF TG_OP='UPDATE' AND NEW.contractor_id IS DISTINCT FROM OLD.contractor_id THEN
    RAISE EXCEPTION 'immutable contractor_id' USING ERRCODE='23514';
  END IF;
  IF TG_OP='DELETE' THEN cid=OLD.contractor_id; ELSE cid=NEW.contractor_id; END IF;
  PERFORM id FROM contractors WHERE id=cid FOR UPDATE;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER accounts_parent_lock BEFORE INSERT OR UPDATE OR DELETE ON contractor_bank_accounts
FOR EACH ROW EXECUTE FUNCTION lock_account_parent();

CREATE FUNCTION check_contractor_accounts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cid UUID; account_count INTEGER; primary_count INTEGER;
BEGIN
  IF TG_TABLE_NAME='contractors' THEN cid=NEW.id;
  ELSIF TG_OP='DELETE' THEN cid=OLD.contractor_id;
  ELSE cid=NEW.contractor_id; END IF;
  IF EXISTS(SELECT 1 FROM contractors WHERE id=cid) THEN
    SELECT count(*),count(*) FILTER (WHERE is_primary) INTO account_count,primary_count
    FROM contractor_bank_accounts WHERE contractor_id=cid;
    IF account_count<1 OR primary_count<>1 THEN
      RAISE EXCEPTION 'contractor requires accounts and exactly one primary' USING ERRCODE='23514', CONSTRAINT='contractor_accounts_required';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER contractor_accounts_required AFTER INSERT OR UPDATE ON contractors
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_contractor_accounts();
CREATE CONSTRAINT TRIGGER account_set_required AFTER INSERT OR UPDATE OR DELETE ON contractor_bank_accounts
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_contractor_accounts();

CREATE FUNCTION valid_tep(items JSONB) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item JSONB; seen TEXT[]='{}'; n TEXT;
BEGIN
  IF jsonb_typeof(items)<>'array' THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
    IF jsonb_typeof(item)<>'object' OR NOT (item ?& ARRAY['name','value','unit']) THEN RETURN false; END IF;
    IF jsonb_typeof(item->'name')<>'string' OR jsonb_typeof(item->'unit')<>'string'
       OR jsonb_typeof(item->'value')<>'number' THEN RETURN false; END IF;
    n=lower(btrim(item->>'name'));
    IF length(n)=0 OR length(btrim(item->>'unit'))=0 OR (item->>'value')::numeric<0 OR n=ANY(seen) THEN RETURN false; END IF;
    seen=array_append(seen,n);
  END LOOP;
  RETURN true;
END $$;
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 255),
  address TEXT NOT NULL CHECK (length(btrim(address))>0),
  tep JSONB NOT NULL DEFAULT '[]' CHECK (valid_tep(tep)),
  customer_id UUID NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  intermediary_id UUID REFERENCES contractors(id) ON DELETE RESTRICT,
  contractor_id UUID NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  city VARCHAR(120) NOT NULL CHECK (length(btrim(city))>0),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL CHECK (end_date>=start_date),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX projects_customer_idx ON projects(customer_id);
CREATE INDEX projects_intermediary_idx ON projects(intermediary_id);
CREATE INDEX projects_contractor_idx ON projects(contractor_id);
CREATE INDEX projects_city_idx ON projects(city);
CREATE INDEX projects_start_idx ON projects(start_date);
CREATE INDEX projects_end_idx ON projects(end_date);
CREATE TRIGGER projects_updated BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
