-- NEBU Bestellsystem v2: eine Zeile pro Bestellung, persönliche Mitarbeiterzugänge,
-- serverseitige Sitzungen (sperrbar), Änderungsprotokoll, atomare Drosselung, Einstellungen.
-- Gilt identisch für Test- und Live-Datenbank (jede Netlify-Umgebung hat ihre eigene Datenbank).

CREATE TABLE IF NOT EXISTS nebu_staff (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 40),
  name_key text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('owner','staff')),
  pin_hash text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS nebu_staff_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id uuid NOT NULL REFERENCES nebu_staff(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_reason text,
  device text,
  last_seen_at timestamptz
);
CREATE INDEX IF NOT EXISTS nebu_staff_sessions_staff ON nebu_staff_sessions (staff_id);

CREATE TABLE IF NOT EXISTS nebu_orders (
  id text PRIMARY KEY,
  request_id text NOT NULL UNIQUE,
  token_hash text,
  token_expires_at timestamptz,
  status text NOT NULL,
  fulfillment text NOT NULL CHECK (fulfillment IN ('pickup','delivery')),
  version integer NOT NULL DEFAULT 0,
  data jsonb NOT NULL,
  kitchen_print jsonb,
  phone_key text,
  address_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  anonymized_at timestamptz
);
CREATE INDEX IF NOT EXISTS nebu_orders_created ON nebu_orders (created_at DESC);
CREATE INDEX IF NOT EXISTS nebu_orders_open ON nebu_orders (status) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS nebu_orders_print ON nebu_orders ((kitchen_print->>'status')) WHERE kitchen_print IS NOT NULL;
CREATE INDEX IF NOT EXISTS nebu_orders_phone ON nebu_orders (phone_key, created_at);
CREATE INDEX IF NOT EXISTS nebu_orders_address ON nebu_orders (address_key, created_at);

CREATE TABLE IF NOT EXISTS nebu_audit (
  id bigserial PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  staff_id uuid,
  staff_name text,
  action text NOT NULL,
  order_id text,
  detail jsonb
);
CREATE INDEX IF NOT EXISTS nebu_audit_at ON nebu_audit (at DESC);
CREATE INDEX IF NOT EXISTS nebu_audit_order ON nebu_audit (order_id);

CREATE TABLE IF NOT EXISTS nebu_rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

CREATE TABLE IF NOT EXISTS nebu_push_subscriptions (
  endpoint text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('staff','customer')),
  staff_id uuid REFERENCES nebu_staff(id) ON DELETE CASCADE,
  order_id text REFERENCES nebu_orders(id) ON DELETE CASCADE,
  subscription jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nebu_push_order ON nebu_push_subscriptions (order_id);

CREATE TABLE IF NOT EXISTS nebu_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

-- Testdaten aus der alten Einzelzeilen-Tabelle übernehmen (nur wenn vorhanden; Live hat sie nicht).
-- Alte Kunden-Status-Tokens werden bewusst NICHT übernommen (sie lagen im Klartext vor).
DO $$
BEGIN
  IF to_regclass('public.nebu_test_order_state') IS NOT NULL THEN
    INSERT INTO nebu_orders (id, request_id, status, fulfillment, version, data, kitchen_print, created_at, updated_at, closed_at)
    SELECT e->>'id',
           COALESCE(NULLIF(e->>'requestId',''), 'legacy-' || (e->>'id')),
           COALESCE(e->>'status','new'),
           CASE WHEN e->>'fulfillment' = 'pickup' THEN 'pickup' ELSE 'delivery' END,
           COALESCE((e->>'version')::int, 0),
           (e - 'customerToken' - 'kitchenPrint' - 'requestId'),
           e->'kitchenPrint',
           COALESCE((e->>'createdAt')::timestamptz, now()),
           COALESCE((e->>'updatedAt')::timestamptz, now()),
           CASE WHEN e->>'status' IN ('picked_up','delivered','rejected','delivery_failed')
                THEN COALESCE((e->>'updatedAt')::timestamptz, now()) END
    FROM nebu_test_order_state s, jsonb_array_elements(s.orders) e
    WHERE s.migrated AND e ? 'id'
    ON CONFLICT DO NOTHING;
  END IF;
END $$;
