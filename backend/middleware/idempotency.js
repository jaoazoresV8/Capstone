const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function createIdempotencyMiddleware(pool) {
  return async function idempotencyMiddleware(req, res, next) {
    const method = req.method?.toUpperCase?.() || "";
    if (!WRITE_METHODS.has(method)) return next();

    let key =
      req.headers["idempotency-key"] ||
      req.headers["Idempotency-Key"] ||
      req.headers["x-idempotency-key"];

    if (!key || typeof key !== "string" || !key.trim()) {
      const body = req.body || {};
      const bodyKey =
        (typeof body.transaction_uuid === "string" && body.transaction_uuid.trim()) ||
        (typeof body.transactionId === "string" && body.transactionId.trim()) ||
        (typeof body.uuid === "string" && body.uuid.trim()) ||
        null;

      if (!bodyKey) {
        return next();
      }

      key = bodyKey;
    }

    const idemKey = key.trim();
    const path = req.originalUrl.split("?")[0];

    try {
      const [rows] = await pool.query(
        "SELECT response_status, response_body FROM idempotency_keys WHERE idem_key = ? AND method = ? AND path = ?",
        [idemKey, method, path]
      );
      if (rows && rows.length > 0) {
        const row = rows[0];
        const status = Number(row.response_status) || 200;
        let body = row.response_body;
        try {
          body = JSON.parse(body);
          return res.status(status).json(body);
        } catch {
          return res.status(status).send(String(body));
        }
      }
    } catch (e) {
      console.warn("[idempotency] lookup failed:", e?.message || e);
    }

    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    function storeResponse(body, isJson) {
      const status = res.statusCode || 200;
      let storedBody;
      try {
        storedBody = isJson ? JSON.stringify(body ?? null) : String(body ?? "");
      } catch {
        storedBody = isJson ? "{}" : "";
      }

      pool
        .query(
          "INSERT OR IGNORE INTO idempotency_keys (idem_key, method, path, response_status, response_body) VALUES (?, ?, ?, ?, ?)",
          [idemKey, method, path, status, storedBody]
        )
        .catch((e) => {
          console.warn("[idempotency] insert failed:", e?.message || e);
        });
    }

    res.json = (body) => {
      storeResponse(body, true);
      return originalJson(body);
    };

    res.send = (body) => {
      storeResponse(body, false);
      return originalSend(body);
    };

    return next();
  };
}

