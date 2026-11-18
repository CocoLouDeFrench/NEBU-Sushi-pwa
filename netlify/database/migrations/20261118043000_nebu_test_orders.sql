-- Isolated NEBU test order queue. A single locked row serializes multi-device writes.
CREATE TABLE IF NOT EXISTS nebu_test_order_state (
  id integer PRIMARY KEY CHECK (id = 1),
  orders jsonb NOT NULL DEFAULT '[]'::jsonb,
  migrated boolean NOT NULL DEFAULT false
);
INSERT INTO nebu_test_order_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
