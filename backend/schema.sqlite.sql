--Schema for sqlite
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  email TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin', 'staff')),
  allowed_pages TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);


CREATE TABLE IF NOT EXISTS customers (
  customer_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  address TEXT,
  total_balance REAL NOT NULL DEFAULT 0
);


CREATE TABLE IF NOT EXISTS suppliers (
  supplier_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  contact TEXT,
  address TEXT
);


CREATE TABLE IF NOT EXISTS products (
  product_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  supplier_id INTEGER,
  supplier_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  recorded_at TEXT DEFAULT (datetime('now','localtime')),
  recorded_by INTEGER,
  recorded_by_name TEXT,
  FOREIGN KEY (supplier_id) REFERENCES suppliers(supplier_id),
  FOREIGN KEY (recorded_by) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_products_supplier ON products(supplier_id);


CREATE TABLE IF NOT EXISTS sales (
  sale_id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER,
  transaction_type TEXT DEFAULT 'walk-in' CHECK (transaction_type IN ('walk-in', 'online')),
  customer_name TEXT,
  customer_contact TEXT,
  customer_address TEXT,
  or_number TEXT,
  sale_uuid TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  remaining_balance REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'unpaid',
  sale_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_customer ON sales(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_date ON sales(sale_date);
CREATE INDEX IF NOT EXISTS idx_sales_or_number ON sales(or_number);


CREATE TABLE IF NOT EXISTS sale_items (
  sale_item_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price REAL NOT NULL,
  subtotal REAL NOT NULL,
  FOREIGN KEY (sale_id) REFERENCES sales(sale_id),
  FOREIGN KEY (product_id) REFERENCES products(product_id)
);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);


CREATE TABLE IF NOT EXISTS payments (
  payment_id INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id INTEGER NOT NULL,
  amount_paid REAL NOT NULL,
  payment_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  reference_number TEXT,
  payment_method TEXT,
  FOREIGN KEY (sale_id) REFERENCES sales(sale_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_sale ON payments(sale_id);


CREATE TABLE IF NOT EXISTS settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (setting_key, setting_value) VALUES ('markup_percent', '10');


CREATE TABLE IF NOT EXISTS password_reset_requests (
  request_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  username TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'rejected')),
  resolved_at TEXT,
  resolved_by INTEGER,
  resolution_note TEXT,
  FOREIGN KEY (user_id) REFERENCES users(user_id),
  FOREIGN KEY (resolved_by) REFERENCES users(user_id)
);
CREATE INDEX IF NOT EXISTS idx_prr_status_requested ON password_reset_requests(status, requested_at);
CREATE INDEX IF NOT EXISTS idx_prr_username ON password_reset_requests(username);


-- Activity log for dashboard "Recent Activity" and analytics
CREATE TABLE IF NOT EXISTS activity_log (
  activity_id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('sale','payment','product','customer')),
  title TEXT NOT NULL,
  details TEXT,
  amount REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_activity_created_at ON activity_log(created_at DESC);
