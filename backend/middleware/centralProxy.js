function normalizeTarget(target) {
  if (!target) return null;
  const t = String(target).trim();
  if (!t) return null;
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

export function createCentralProxy({ target, timeoutMs = 15000 } = {}) {
  const normalized = normalizeTarget(target);
  if (!normalized) {
    throw new Error("CENTRAL_API_URL is required for central proxy mode.");
  }

  return async (req, res) => {
    const url = `${normalized}${req.originalUrl}`;
    const isWrite = req.method !== "GET" && req.method !== "HEAD";
    const startedAt = Date.now();

    // Log every proxied request; highlight writes (sync operations).
    try {
      const meta = isWrite ? "SYNC" : "READ";
      let payloadSnippet = "";
      if (isWrite && req.body != null) {
        try {
          const json = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
          payloadSnippet = ` body=${json.slice(0, 300)}${json.length > 300 ? "…" : ""}`;
        } catch {
          payloadSnippet = "";
        }
      }
      console.log(
        `[CentralProxy][${meta}] ${req.method} ${req.originalUrl} -> ${url}${payloadSnippet}`
      );
    } catch {
      // Logging should never break the request flow.
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers();

      // Forward only the headers we actually need (avoid hop-by-hop headers).
      const auth = req.headers["authorization"];
      if (auth) headers.set("authorization", String(auth));
      const contentType = req.headers["content-type"];
      if (contentType) headers.set("content-type", String(contentType));

      const init = {
        method: req.method,
        headers,
        signal: controller.signal
      };

      if (req.method !== "GET" && req.method !== "HEAD") {
        if (contentType && String(contentType).includes("application/json")) {
          init.body = JSON.stringify(req.body ?? {});
        } else if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
          init.body = req.body;
        } else if (req.body != null) {
          init.body = JSON.stringify(req.body);
          headers.set("content-type", "application/json");
        }
      }

      const upstream = await fetch(url, init);

      res.status(upstream.status);
      const upstreamContentType = upstream.headers.get("content-type");
      if (upstreamContentType) res.setHeader("content-type", upstreamContentType);

      const text = await upstream.text();
      res.send(text);

      try {
        const duration = Date.now() - startedAt;
        console.log(
          `[CentralProxy][OK] ${req.method} ${req.originalUrl} <- ${upstream.status} in ${duration}ms`
        );
      } catch {
        
      }
    } catch (e) {
      const msg = e?.name === "AbortError" ? "Central server timeout." : "Central server unreachable.";
      try {
        console.error(
          `[CentralProxy][ERROR] ${req.method} ${req.originalUrl}: ${msg}`,
          e?.message || e
        );
      } catch {
        
      }
      res.status(502).json({ message: msg });
    } finally {
      clearTimeout(timer);
    }
  };
}

