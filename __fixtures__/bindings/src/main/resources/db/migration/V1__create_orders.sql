CREATE TABLE orders (
  id        BIGSERIAL PRIMARY KEY,
  reference VARCHAR(64) NOT NULL
);

CREATE INDEX idx_orders_reference ON orders (reference);
