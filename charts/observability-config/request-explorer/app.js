// VijayBank Request Explorer (Kubernetes): replays real traces from Jaeger as hops between pods.
// Data: Jaeger's trace search + trace APIs, proxied by this pod's nginx at /jaeger/.
"use strict";

// ------------------------------------------------------------------ the map
// Fixed layout of the stack (SVG viewBox 1132 x 660). x/y = box centre; `prod` = position in the
// production view. `mode` limits a node to one view. Production-only nodes are illustrative.
// `ns` = Kubernetes namespace the pod runs in.
const NODES = {
  browser:              { label: "Your browser", tech: "React app", x: 75, y: 330, prod: { x: 75, y: 600 },
    about: "The React app from web-frontend runs here. It calls /api/... on the same origin (bank.localhost), so the browser never talks to a bank service directly." },
  traefik:              { label: "traefik", tech: "Ingress :80", x: 228, y: 330, ns: "traefik",
    about: "The cluster's front door (Gateway API). kind maps port 80 on your Mac to port 80 of the control-plane node, where the Traefik pod listens (hostPort). It matches the HTTPRoute for bank.localhost and sends the request straight to a web-frontend pod IP (it watches the Service's endpoints itself, so no ClusterIP / kube-proxy on this hop). Traefik is traced: its timing is real." },
  router:               { label: "Home Wi-Fi router", tech: "NAT · DNS forwarder", x: 75, y: 500, mode: "prod", illus: true,
    about: "Illustrative. Your laptop's default gateway. It forwards DNS questions to the ISP and rewrites the source address of outgoing packets from your private IP (192.168.x.x) to the one public IP your ISP gave you (source NAT), remembering the mapping so replies find their way back." },
  internet:             { label: "Internet / ISP", tech: "BGP-routed networks", x: 75, y: 400, mode: "prod", illus: true, noIp: true,
    about: "Illustrative. Your ISP and the networks between you and the bank, connected by BGP routers. Every router only looks at the destination IP and passes the packet one hop closer; the payload stays encrypted by TLS the whole way." },
  lb:                   { label: "Load balancer + WAF", tech: "HTTPS :443", x: 75, y: 290, mode: "prod", illus: true,
    about: "Illustrative. The bank's public entry point (e.g. a cloud load balancer in front of the cluster). TLS ends here: the certificate for the bank's domain lives on it. A web application firewall blocks attacks, then the request goes on to the cluster's ingress (Traefik)." },
  "web-frontend":       { label: "web-frontend", tech: "nginx :8080", x: 381, y: 330, ns: "vijaybank",
    about: "nginx serves the React files and forwards every /api/ call to api-gateway:8000 (reverse proxy, via the api-gateway Service). It is not instrumented, so its own time is not measured: it is the gap between Traefik's call and the gateway's span." },
  "api-gateway":        { label: "api-gateway", tech: "Go :8000", x: 534, y: 330, ns: "vijaybank",
    about: "Single entry point. Checks the JWT (keys from auth-service's JWKS), checks the token isn't revoked (Redis deny-list), applies the rate limit, then forwards the call to the owning service." },
  "auth-service":       { label: "auth-service", tech: "Java :8081", x: 705, y: 55, ns: "vijaybank",
    about: "Passwords, login and step-up OTPs, JWTs. OTP challenges live in Redis with a TTL and an attempt counter." },
  "customer-service":   { label: "customer-service", tech: "Python :8082", x: 705, y: 135, ns: "vijaybank",
    about: "Customer profile and KYC details (Postgres)." },
  "account-service":    { label: "account-service", tech: "Java :8083", x: 705, y: 215, ns: "vijaybank",
    about: "Savings / current accounts and fixed deposits. Balances come from the ledger." },
  "transfer-service":   { label: "transfer-service", tech: ".NET :8085", x: 705, y: 330, ns: "vijaybank",
    about: "Owns transfers: validates mode and limits, verifies the OTP with auth, asks fraud for a score, posts the debit to the ledger, then publishes events to RabbitMQ. IMPS/NEFT/RTGS finish later via settlement-worker." },
  "payment-service":    { label: "payment-service", tech: "Node :8090", x: 705, y: 445, ns: "vijaybank",
    about: "Bill payments: fetches the bill, takes an OTP, posts the journal to the ledger and publishes billpay events." },
  "card-service":       { label: "card-service", tech: "Kotlin :8091", x: 705, y: 525, ns: "vijaybank",
    about: "Debit cards: block / unblock, limits, international usage." },
  "statement-service":  { label: "statement-service", tech: "Go :8089", x: 705, y: 605, ns: "vijaybank",
    about: "Builds PDF statements from account, ledger and customer data." },
  "fraud-service":      { label: "fraud-service", tech: "Python :8086", x: 880, y: 135, ns: "vijaybank",
    about: "Scores every transfer (0-100) with rules such as new beneficiary, amount spike, odd hours. 80+ blocks it. If fraud is down, transfers fail closed (503)." },
  "ledger-service":     { label: "ledger-service", tech: "Go :8084", x: 880, y: 245, ns: "vijaybank",
    about: "Double-entry ledger: every journal has equal debits and credits, written in one Postgres transaction with row locks (SELECT ... FOR UPDATE). Idempotency key makes retries safe." },
  "settlement-worker":  { label: "settlement-worker", tech: ".NET :8092", x: 880, y: 355, ns: "vijaybank",
    about: "Consumes settlement.transfers from RabbitMQ, simulates the interbank network (IMPS seconds, NEFT batches), posts the settlement journal and publishes transfer.settled or transfer.failed." },
  "notification-service": { label: "notification-service", tech: "Node :8087", x: 880, y: 465, ns: "vijaybank",
    about: "Listens to bank events and sends SMS/email (stored in MongoDB; the dev inbox shows them)." },
  "audit-service":      { label: "audit-service", tech: "Python :8088", x: 880, y: 565, ns: "vijaybank",
    about: "Writes every business event to an append-only audit trail in MongoDB." },
  postgres:             { label: "postgres", tech: "PostgreSQL :5432", x: 1058, y: 150, ns: "middleware",
    about: "One database per service (ledger, transfer, account, ...). Services never read each other's tables." },
  redis:                { label: "redis", tech: "Redis :6379", x: 1058, y: 265, ns: "middleware",
    about: "Short-lived data: OTP challenges, token deny-list, rate-limit counters. Keys are masked in this view." },
  rabbitmq:             { label: "rabbitmq", tech: "RabbitMQ :5672", x: 1058, y: 390, ns: "middleware",
    about: "Topic exchange vijaybank.events. Each consumer has its own queue, so one published event reaches settlement, notification and audit independently." },
  mongodb:              { label: "mongodb", tech: "MongoDB :27017", x: 1058, y: 520, ns: "middleware",
    about: "Notifications and the audit trail (document store)." },
};
const BOX = { w: 142, h: 50 };
const PROTO_COLOR = { HTTP: "var(--http)", HTTPS: "var(--tls)", DNS: "var(--dns)", SQL: "var(--sql)", Redis: "var(--redis)", AMQP: "var(--amqp)", Mongo: "var(--mongo)" };
// Documentation-range example addresses for the illustrative production hops (RFC 1918 / RFC 5737).
const EXAMPLE_IPS = { browser: "192.168.1.10", router: "192.168.1.1", lb: "203.0.113.10" };
const DB_PROTOS = new Set(["SQL", "Redis", "Mongo"]);
const PAYMENT = /^POST \/api\/(transfers|bill-payments)/;
const NOISE = /dev-inbox|\/health/;
const GRAFANA = "http://grafana.localhost";
const JAEGER_UI = "http://jaeger.localhost";

// ------------------------------------------------------------------ state
const state = {
  mode: "k8s", filter: "payments", cache: new Map(), traces: [], seen: null, selected: null, trace: null,
  events: [], visible: [], idx: -1, playing: false, timer: null, refetch: null,
};
const $ = (s) => document.querySelector(s);
const svg = $("#diagram");
const NS = "http://www.w3.org/2000/svg";

// ------------------------------------------------------------------ Jaeger
async function jaeger(path) {
  const r = await fetch("/jaeger/" + path);
  if (!r.ok) throw new Error(`Jaeger ${r.status}`);
  return r.json();
}

// Jaeger's JSON -> the OTLP shape parseTrace() reads (one resource per Jaeger process).
function jaegerValue(t) {
  if (t.type === "bool") return { boolValue: t.value };
  if (t.type === "int64") return { intValue: t.value };
  if (t.type === "float64") return { doubleValue: t.value };
  return { stringValue: String(t.value) };
}
function toOtlp(t) {
  const byProc = {};
  for (const sp of t.spans) {
    const tags = Object.fromEntries(sp.tags.map((x) => [x.key, x.value]));
    const parent = (sp.references || []).find((r) => r.refType === "CHILD_OF");
    const errorCode = tags["otel.status_code"] === "ERROR" || tags.error === true;
    (byProc[sp.processID] = byProc[sp.processID] || []).push({
      spanId: sp.spanID, parentSpanId: parent ? parent.spanID : "", name: sp.operationName,
      kind: "SPAN_KIND_" + String(tags["span.kind"] || "internal").toUpperCase(),
      startTimeUnixNano: String(BigInt(sp.startTime) * 1000n), endTimeUnixNano: String(BigInt(sp.startTime + sp.duration) * 1000n),
      attributes: sp.tags.filter((x) => !/^(span\.kind|otel\.|error$|internal\.span)/.test(x.key)).map((x) => ({ key: x.key, value: jaegerValue(x) })),
      status: errorCode ? { code: "STATUS_CODE_ERROR", message: tags["otel.status_description"] } : {},
    });
  }
  return { resourceSpans: Object.entries(byProc).map(([pid, spans]) => {
    const pr = t.processes[pid];
    const res = [{ key: "service.name", value: { stringValue: pr.serviceName } }].concat((pr.tags || []).map((x) => ({ key: x.key, value: jaegerValue(x) })));
    return { resource: { attributes: res }, scopeSpans: [{ spans }] };
  }) };
}

// List entry for a trace: named after the gateway's server span (the route), timed from the first span.
function summary(t) {
  const P = t.processes;
  const gw = t.spans.filter((sp) => P[sp.processID].serviceName === "api-gateway" &&
                                     sp.tags.some((x) => x.key === "span.kind" && x.value === "server"))
                    .sort((a, b) => a.startTime - b.startTime)[0];
  if (!gw) return null;                                        // static files etc.: never reach the gateway
  const first = Math.min(...t.spans.map((sp) => sp.startTime));
  const last = Math.max(...t.spans.map((sp) => sp.startTime + sp.duration));
  const tag = (k) => (gw.tags.find((x) => x.key === k) || {}).value;
  return { traceID: t.traceID, rootTraceName: gw.operationName, target: tag("http.target") || tag("url.path"),
           startTimeUnixNano: String(BigInt(first) * 1000n), durationMs: Math.round((last - first) / 1000) };
}

async function poll() {
  // Search Traefik's spans for bank.localhost: every request from the bank's web page passes Traefik,
  // while health probes (kubelet -> pod) never do. Traefik also serves Grafana, Jaeger etc., hence the
  // host filter. POSTs (payments, logins) and GETs are asked for separately so the web page's frequent
  // GETs can't crowd payments out. After the first load only the last few minutes are asked for.
  const nowUs = Date.now() * 1000, hourAgo = nowUs - 3600e6;
  const since = state.cache.size ? Math.max(hourAgo, Number(state.newest || 0) / 1000 - 120e6) : hourAgo;
  const q = (op, limit) => jaeger(`api/traces?service=traefik&operation=${op}&tags=${encodeURIComponent('{"server.address":"bank.localhost"}')}` +
                                  `&start=${Math.floor(since)}&end=${nowUs + 60e6}&limit=${limit}`);
  try {
    const [posts, gets] = await Promise.all([q("POST", state.cache.size ? 40 : 100), q("GET", 30)]);
    const first = state.seen === null;
    for (const t of [...(posts.data || []), ...(gets.data || [])]) {
      const sm = summary(t);
      if (!sm || NOISE.test(sm.rootTraceName) || NOISE.test(sm.target || "")) continue;
      const old = state.cache.get(sm.traceID);
      if (!old && !first) sm.isNew = true;
      state.cache.set(sm.traceID, old ? { ...sm, isNew: old.isNew } : sm);
    }
    for (const [id, t] of state.cache) if (BigInt(t.startTimeUnixNano) / 1000n < BigInt(Math.floor(hourAgo))) state.cache.delete(id);
    const list = [...state.cache.values()].sort((a, b) => Number(BigInt(b.startTimeUnixNano) - BigInt(a.startTimeUnixNano)));
    state.newest = list.length ? list[0].startTimeUnixNano : state.newest;
    setLive(true, `Live · ${list.length} requests in the last hour`);
    const fresh = state.seen ? list.filter((t) => !state.seen.has(t.traceID)) : [];
    state.seen = new Set(list.map((t) => t.traceID));
    state.traces = list;
    renderList();
    // Auto-play the newest payment once its spans have reached Jaeger (exporters batch for a few seconds).
    const pay = fresh.find((t) => PAYMENT.test(t.rootTraceName || ""));
    if (pay && $("#follow").checked) setTimeout(() => select(pay.traceID, true), 6000);
  } catch (e) {
    setLive(false, "Jaeger not reachable — is the observability namespace running?");
  }
}

function setLive(ok, text) {
  $("#live-dot").className = "dot " + (ok ? "on" : "off");
  $("#live-text").textContent = text;
}

// ------------------------------------------------------------------ left list
function friendly(name, target) {
  if (/^POST \/api\/transfers\/\*/.test(name)) return /confirm$/.test(target || "") ? "Transfer · confirm with OTP" : "Transfer · " + (target ? target.split("/").pop() : "action");
  if (/^POST \/api\/transfers$/.test(name)) return "Transfer · create (OTP sent)";
  if (/^POST \/api\/bill-payments\/\*/.test(name))
    return target ? (/fetch$/.test(target) ? "Bill payment · fetch bill" : /confirm$/.test(target) ? "Bill payment · confirm with OTP" : "Bill payment") : "Bill payment · fetch / confirm";
  if (/^POST \/api\/bill-payments$/.test(name)) return "Bill payment · create (OTP sent)";
  if (/^POST \/api\/auth\/login/.test(name)) return "Login · password";
  if (/^POST \/api\/auth\/otp\/verify/.test(name)) return "Login · OTP";
  return name;
}

function renderList() {
  const ol = $("#traces");
  const list = state.traces.filter((t) => state.filter === "all" || PAYMENT.test(t.rootTraceName || ""));
  if (!list.length) {
    ol.innerHTML = `<li class="empty">${state.filter === "payments" ? "No payments in the last hour yet." : "No requests yet."}</li>`;
    return;
  }
  ol.innerHTML = "";
  for (const t of list.slice(0, 40)) {
    const li = document.createElement("li");
    li.className = t.traceID === state.selected ? "active" : "";
    const when = new Date(Number(BigInt(t.startTimeUnixNano) / 1000000n)).toLocaleTimeString();
    li.innerHTML = `<div class="t-name"></div><div class="t-meta"><span>${when}</span><span>${t.durationMs ?? "<1"} ms</span></div>`;
    li.querySelector(".t-name").textContent = friendly(t.rootTraceName || "?", t.target);
    if (t.isNew) li.querySelector(".t-name").insertAdjacentHTML("beforeend", '<span class="new">NEW</span>');
    li.onclick = () => select(t.traceID, false);
    ol.appendChild(li);
  }
}

// ------------------------------------------------------------------ trace -> hops
function attrValue(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("intValue" in v) return Number(v.intValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("boolValue" in v) return v.boolValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(attrValue);
  return JSON.stringify(v);
}
const attrs = (list) => Object.fromEntries((list || []).map((a) => [a.key, attrValue(a.value)]));

function parseTrace(d) {
  const spans = [];
  for (const b of d.batches || d.resourceSpans || []) {
    const res = attrs(b.resource && b.resource.attributes);
    for (const ss of b.scopeSpans || b.instrumentationLibrarySpans || []) {
      for (const s of ss.spans || []) {
        spans.push({
          id: s.spanId, parent: s.parentSpanId || "", service: res["service.name"], r: res,
          kind: (s.kind || "").replace("SPAN_KIND_", ""), name: s.name,
          start: BigInt(s.startTimeUnixNano), end: BigInt(s.endTimeUnixNano), a: attrs(s.attributes),
          error: s.status && s.status.code === "STATUS_CODE_ERROR", statusMsg: s.status && s.status.message,
        });
      }
    }
  }
  const byId = new Map(spans.map((s) => [s.id, s]));
  const t0 = spans.reduce((m, s) => (s.start < m ? s.start : m), spans[0].start);
  for (const s of spans) {
    s.t = Number(s.start - t0) / 1e6;
    s.ms = Number(s.end - s.start) / 1e6;
    s.p = byId.get(s.parent);
  }
  for (const s of spans) if (s.p) (s.p.kids = s.p.kids || []).push(s);
  return { spans, byId, t0 };
}

// The request's first span. Spans can reach Jaeger out of order, so a span whose parent hasn't
// arrived yet must not be mistaken for the root: only a span with no parent ID at all counts.
const rootSpan = (tr) => tr.spans.find((s) => !s.parent && s.service === "traefik") || tr.spans.find((s) => !s.parent)
  || tr.spans.reduce((a, b) => (b.t < a.t ? b : a));
// The gateway's first server span: names the request (route) and its URL path.
const gatewaySpan = (tr) => tr.spans.filter((s) => s.service === "api-gateway" && s.kind === "SERVER").sort((a, b) => a.t - b.t)[0];

const num = (v) => (v === undefined || v === null || v === "" ? null : Number(v));
const nodePort = (id) => { const m = /:(\d+)$/.exec((NODES[id] || {}).tech || ""); return m ? Number(m[1]) : null; };

const isIp = (v) => typeof v === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(v);
const host = (u) => { try { return new URL(u).hostname; } catch { return undefined; } };
const path = (u) => { try { return new URL(u).pathname; } catch { return u; } };
const oneLine = (s, n = 140) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

// Redis keys hold OTP challenge and session token IDs: show only the command and the key's prefix.
function maskRedis(stmt) {
  const [cmd, key, ...rest] = String(stmt || "").split(/\s+/);
  const k = key ? key.split(":")[0] + (key.includes(":") ? ":•••" : "") : "";
  return [cmd && cmd.toUpperCase(), k, rest.length ? "…" : ""].filter(Boolean).join(" ");
}

function destination(s) {
  const a = s.a;
  const sys = a["db.system"];
  if (sys === "postgresql") return ["postgres", "SQL"];
  if (sys === "redis") return ["redis", "Redis"];
  if (sys === "mongodb") return ["mongodb", "Mongo"];
  if (s.kind === "PRODUCER" || a["messaging.system"] === "rabbitmq") return ["rabbitmq", "AMQP"];
  const h = a["server.address"] || a["net.peer.name"] || host(a["url.full"] || a["http.url"]);
  return [NODES[h] ? h : null, "HTTP"];
}

function buildEvents(tr) {
  const ips = {};
  const setIp = (node, ip) => { if (node && NODES[node] && isIp(ip) && !ips[node]) ips[node] = ip; };
  const ev = [];
  const push = (e) => ev.push(e);
  const root = rootSpan(tr);

  // Pod, node and pod IP of every traced service (from the Collector's k8s_attributes).
  const pods = {};
  for (const s of tr.spans) {
    if (NODES[s.service] && s.r && s.r["k8s.pod.name"] && !pods[s.service]) {
      pods[s.service] = { pod: s.r["k8s.pod.name"], node: s.r["k8s.node.name"], ip: s.r["k8s.pod.ip"] };
      setIp(s.service, s.r["k8s.pod.ip"]);
    }
  }

  // Browser -> Traefik -> nginx -> gateway. Traefik is traced (its server span = the whole request as
  // the cluster saw it, its client span = the call to a web-frontend pod); nginx isn't, so the
  // nginx -> gateway hop shares the gateway span's timing.
  const gw = gatewaySpan(tr);
  if (gw) {
    const edge = root && root.service === "traefik" ? root : null;
    const toWeb = edge && (edge.kids || []).concat(...(edge.kids || []).map((k) => k.kids || [])).find((k) => k.kind === "CLIENT");
    const target = gw.a["http.target"] || gw.a["url.path"] || gw.name;
    const method = (edge && edge.name) || gw.a["http.method"] || gw.name.split(" ")[0];
    const status = (edge && edge.a["http.response.status_code"]) || gw.a["http.status_code"] || gw.a["http.response.status_code"];
    const req = `${method} ${target}`;
    if (edge) setIp("browser", edge.a["client.address"]);
    if (toWeb) setIp("web-frontend", toWeb.a["server.address"]);
    setIp("web-frontend", gw.a["net.sock.peer.addr"] || gw.a["client.address"]);
    const inT = edge ? edge.t : gw.t, outT = edge ? edge.t + edge.ms : gw.t + gw.ms;
    const hops = entryHops(state.mode, req, status, edge || gw, ips);
    const inbound = hops.findIndex((e) => e.to === "traefik") + 1;
    hops.forEach((e, i) => push({ ...e, t: i < inbound ? inT - (inbound - i) * 1e-6 : outT + (i - inbound + 1) * 1e-6 }));
    if (toWeb) {
      const net = { src: null, dst: 8080, ver: "1.1", host: "web-frontend", direct: true };
      push({ t: toWeb.t, from: "traefik", to: "web-frontend", proto: "HTTP", info: `${req}  → web-frontend pod ${toWeb.a["server.address"] || ""}:8080`, span: toWeb, took: toWeb.ms, net });
      push({ t: toWeb.t + toWeb.ms, from: "web-frontend", to: "traefik", proto: "HTTP", info: `HTTP ${status}`, result: status, span: toWeb, resp: true, net });
    }
    const proxied = { src: num(gw.a["net.sock.peer.port"] || gw.a["network.peer.port"]), dst: 8000,
                      ver: gw.a["net.protocol.version"] || gw.a["network.protocol.version"] || "1.0", host: "api-gateway" };
    push({ t: gw.t, from: "web-frontend", to: "api-gateway", proto: "HTTP", info: `${req}  → proxied to api-gateway:8000`, span: gw, took: gw.ms, net: proxied });
    push({ t: gw.t + gw.ms, from: "api-gateway", to: "web-frontend", proto: "HTTP", info: `HTTP ${gw.a["http.status_code"] || gw.a["http.response.status_code"] || status}`, result: gw.a["http.status_code"] || gw.a["http.response.status_code"] || status, span: gw, resp: true, net: proxied });
  }

  for (const s of tr.spans) {
    const a = s.a;
    if (s.service === "traefik") continue;                   // handled above
    if (s.kind === "SERVER" && s.p && s.p.kind === "CLIENT" && s.p.service !== "traefik") {   // under Traefik the peer is nginx
      setIp(s.p.service, a["network.peer.address"] || a["client.address"] || a["net.sock.peer.addr"] || a["net.peer.ip"]);
      const h = (a["http.host"] || "").split(":")[0];
      setIp(s.service, h);
    }
    if (s.kind === "CONSUMER") {
      const key = a["messaging.rabbitmq.routing_key"] || a["messaging.rabbitmq.destination.routing_key"];
      const queue = a["messaging.destination.name"] || (a["messaging.destination"] || "").replace(/^ctag.*/, "");
      const info = `deliver from ${queue ? "queue " + queue : s.service + "'s queue"}${key ? " (key " + key + ")" : ""}`;
      const net = { src: null, dst: 5672, client: s.service };   // the consumer opened the connection to :5672
      push({ t: s.t, from: "rabbitmq", to: s.service, proto: "AMQP", info, span: s, took: s.ms, net, deliver: true });
      push({ t: s.t + s.ms, from: s.service, to: "rabbitmq", proto: "AMQP", info: s.error ? "nack" : "ack", result: s.error ? "error" : "ack", span: s, resp: true, net, deliver: true });
      continue;
    }
    if (s.kind !== "CLIENT" && s.kind !== "PRODUCER") continue;
    if (s.p && s.p.kind === "CLIENT") continue;               // driver-internal child spans (e.g. pgx)
    if (s.name === "pool.acquire") continue;
    const [to, proto] = destination(s);
    if (!to || to === s.service) continue;
    // Clients connect to the Service's ClusterIP (10.96.x.x); kube-proxy then rewrites it to a pod IP.
    const svcIp = [a["net.peer.ip"], a["network.peer.address"], a["net.sock.peer.addr"], a["net.peer.name"]].find((v) => isIp(v) && v.startsWith("10.96."));
    if (!pods[to]) setIp(to, svcIp);
    let info, result;
    if (proto === "SQL") {
      info = oneLine(a["db.statement"] || s.name);
      result = a["pgx.rows_affected"] !== undefined ? `${a["pgx.rows_affected"]} row(s)` : "OK";
    } else if (proto === "Redis") {
      info = maskRedis(a["db.statement"] || s.name);
      result = "OK";
    } else if (proto === "Mongo") {
      info = `${a["db.operation"] || a["db.statement"] || s.name} ${a["db.name"] || ""}.${a["db.mongodb.collection"] || ""}`;
      result = "OK";
    } else if (proto === "AMQP") {
      info = `publish to exchange ${a["messaging.destination.name"] || "?"}, routing key ${a["messaging.rabbitmq.destination.routing_key"] || "?"}`;
      result = "confirmed";
    } else {
      const method = a["http.request.method"] || a["http.method"] || s.name.split(" ").pop();
      info = `${method} ${path(a["url.full"] || a["http.url"] || "")}`;
      result = a["http.response.status_code"] || a["http.status_code"];
    }
    if (s.error) result = "error";
    const kid = (s.kids || []).find((k) => k.kind === "SERVER");
    const net = {
      src: kid ? num(kid.a["network.peer.port"] || kid.a["net.sock.peer.port"] || kid.a["net.peer.port"]) : null,
      dst: num(a["server.port"] || a["net.peer.port"]) || nodePort(to),
      ver: a["network.protocol.version"] || a["net.protocol.version"] || (kid && (kid.a["network.protocol.version"] || kid.a["net.protocol.version"] || kid.a["http.flavor"])),
      host: to, svcIp,
    };
    push({ t: s.t, from: s.service, to, proto, info, span: s, took: s.ms, net });
    const reply = { HTTP: `HTTP ${result}`, SQL: "query result", Redis: "reply", Mongo: "write acknowledged", AMQP: "publisher confirm" }[proto];
    push({ t: s.t + s.ms, from: to, to: s.service, proto, info: reply, result, span: s, resp: true, net });
  }
  ev.sort((x, y) => x.t - y.t || (x.resp === y.resp ? 0 : x.resp ? -1 : 1));
  ev.forEach((e, i) => (e.n = i + 1));
  return { events: ev, ips, pods };
}

// How the request reaches Traefik. Kubernetes: the real path on your Mac (kind's port mapping),
// timed by Traefik's own span. Production: an illustrative path for a real bank (DNS, home router,
// internet, load balancer with TLS) in front of the same cluster.
function entryHops(mode, req, status, edge, ips) {
  const hop = (from, to, proto, info, extra = {}) => ({ from, to, proto, info, span: edge, ...extra });
  const measured = edge.service === "traefik" ? { took: edge.ms } : { unmeasured: true };
  if (mode === "k8s") {
    const src = ips.browser || "172.18.0.1";
    const L = [["L7 Application", `HTTP/1.1 · ${req}`], ["L6 Presentation", "JSON, UTF-8 · not encrypted (plain http://)"],
      ["L5 Session", "Keep-alive connection from the browser"],
      ["L4 Transport", `TCP  browser → bank.localhost:80; Traefik sees it from ${src} (Docker's gateway on the kind network)`],
      ["L3 Network", "IPv4: 127.0.0.1 on the Mac → Docker Desktop forwards host port 80 → kind control-plane node 172.18.0.x:80 → Traefik pod (hostPort)"],
      ["L2 Data link", "Loopback on the Mac, then the Docker bridge network \"kind\" into the node container"],
      ["L1 Physical", "None: the browser and the whole cluster run on the same Mac"]];
    const pkts = [["DNS", "browser", "bank.localhost → 127.0.0.1 (*.localhost never leaves the machine)"],
      ["TCP", "browser → 127.0.0.1:80", "SYN / SYN, ACK / ACK (new connection)"], ["FWD", "macOS → Docker VM", "kind's extraPortMappings: host :80 → control-plane node :80"],
      ["HTTP", "→ Traefik", `${req} HTTP/1.1, Host: bank.localhost → matched by the HTTPRoute for bank.localhost`]];
    return [
      hop("browser", "traefik", "HTTP", `${req}  to bank.localhost:80`, { ...measured, layers: L, pkts }),
      hop("traefik", "browser", "HTTP", `HTTP ${status}`, { resp: true, result: status, layers: L, pkts }),
    ];
  }
  Object.assign(ips, EXAMPLE_IPS);
  const il = { illus: true };
  const tls = (l3, l2, l4 = "TCP  192.168.1.10:ephemeral → 203.0.113.10:443") => [["L7 Application", `HTTP/2 · ${req} (inside TLS)`],
    ["L6 Presentation", "TLS 1.3: encrypted; routers see only IPs and ports"], ["L5 Session", "TLS session on one TCP connection"],
    ["L4 Transport", l4], ["L3 Network", l3], ["L2 Data link", l2], ["L1 Physical", "Wi-Fi radio, then fibre / copper"]];
  return [
    hop("browser", "router", "DNS", "A? netbanking.vijaybank.example", { ...il,
      layers: [["L7 Application", "DNS query"], ["L4 Transport", "UDP 192.168.1.10:ephemeral → 192.168.1.1:53"], ["L3 Network", "IPv4 on the home LAN"], ["L2 Data link", "Wi-Fi (802.11) frame to the router"]],
      pkts: [["DNS", "browser → router", "A? netbanking.vijaybank.example"], ["DNS", "router → ISP resolver", "forwarded (cache miss)"]] }),
    hop("router", "browser", "DNS", "A 203.0.113.10 (bank's public IP)", { ...il, resp: true, result: "NOERROR",
      layers: [["L7 Application", "DNS answer"], ["L4 Transport", "UDP 192.168.1.1:53 → 192.168.1.10"], ["L3 Network", "IPv4 on the home LAN"]],
      pkts: [["DNS", "ISP resolver → router", "A 203.0.113.10, TTL 300"], ["DNS", "router → browser", "A 203.0.113.10 (cached by browser and OS)"]] }),
    hop("browser", "router", "HTTPS", `${req}  to 203.0.113.10:443, encrypted`, { ...il,
      layers: tls("IPv4 192.168.1.10 → 203.0.113.10 (private source address)", "Wi-Fi frame to the router (default gateway)"),
      pkts: [["TCP", "browser → 203.0.113.10:443", "SYN / SYN, ACK / ACK"], ["TLS", "browser → bank", "ClientHello (SNI netbanking.vijaybank.example)"],
             ["TLS", "bank → browser", "ServerHello + certificate + Finished"], ["TLS", "browser → bank", "Finished, then the encrypted HTTP request"]] }),
    hop("router", "internet", "HTTPS", "source NAT 192.168.1.10 → your public IP; ISP routes it", { ...il,
      layers: tls("IPv4 public-IP → 203.0.113.10 (source rewritten by NAT); each router picks the next hop by destination", "Ethernet / fibre links between routers"),
      pkts: [["NAT", "router", "source 192.168.1.10:ephemeral → public-IP:port (mapping remembered)"], ["IP", "ISP → … → bank's network", "routed hop by hop (BGP), TTL decreases at each router"]] }),
    hop("internet", "lb", "HTTPS", "arrives at the bank's public IP: TLS ends here, WAF checks", { ...il,
      layers: tls("IPv4 public-IP → 203.0.113.10", "Bank's edge network", "TCP  public-IP:port → 203.0.113.10:443"),
      pkts: [["TLS", "load balancer", "decrypts with the bank's certificate key"], ["WAF", "load balancer", "blocks SQL injection, bots, abusive rates"]] }),
    hop("lb", "traefik", "HTTP", `${req}  forwarded to the cluster's ingress (decrypted)`, { ...il,
      layers: [["L7 Application", `HTTP/1.1 · ${req}`], ["L6 Presentation", "Plain HTTP inside the data centre (or re-encrypted: mTLS)"],
               ["L4 Transport", "TCP  load balancer → a node's ingress port (NodePort / hostPort)"], ["L3 Network", "IPv4, private data-centre network"]],
      pkts: [["HTTP", "load balancer → Traefik", `${req} + X-Forwarded-For: <your public IP>`]] }),
    hop("traefik", "lb", "HTTP", `HTTP ${status}`, { ...il, resp: true, result: status }),
    hop("lb", "internet", "HTTPS", `HTTP ${status}, encrypted again by the load balancer`, { ...il, resp: true, result: status }),
    hop("internet", "router", "HTTPS", "routed back to your public IP", { ...il, resp: true, result: status }),
    hop("router", "browser", "HTTPS", "NAT maps it back to 192.168.1.10; the browser decrypts it", { ...il, resp: true, result: status }),
  ];
}

// ------------------------------------------------------------------ diagram
function el(name, at = {}, parent = svg) {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(at)) e.setAttribute(k, v);
  parent.appendChild(e);
  return e;
}

const shown = (id) => !NODES[id].mode || NODES[id].mode === state.mode;
const pos = (id) => (state.mode === "prod" && NODES[id].prod) || NODES[id];

function zone(x, y, w, h, text, cls = "") {
  el("rect", { class: "zone " + cls, x, y, width: w, height: h });
  el("text", { class: "zone-label", x: x + 8, y: y + 16 }).textContent = text;
}

function drawBase() {
  svg.innerHTML = "";
  if (state.mode === "k8s") {
    zone(2, 280, 148, 100, "Your Mac");
    zone(154, 8, 976, 648, "kind cluster vijaybank · pods 10.244.0.0/16");
  } else {
    zone(2, 240, 148, 416, "Internet & bank edge · example", "illus");
    zone(154, 8, 976, 648, "Bank Kubernetes cluster · real trace from Traefik on");
  }
  zone(158, 270, 140, 120, "ns traefik");
  zone(306, 30, 670, 622, "ns vijaybank");
  zone(980, 30, 146, 622, "ns middleware");
  state.edgeLayer = el("g");
  state.nodeLayer = el("g");
  state.packetLayer = el("g");
  state.nodeEls = {};
  for (const [id, n] of Object.entries(NODES)) {
    if (!shown(id)) continue;
    const { x, y } = pos(id);
    const g = el("g", { class: "node" + (n.illus ? " illus" : ""), transform: `translate(${x - BOX.w / 2},${y - BOX.h / 2})` }, state.nodeLayer);
    el("rect", { width: BOX.w, height: BOX.h }, g);
    el("text", { x: 10, y: 18, "font-weight": 600 }, g).textContent = n.label;
    const tech = el("text", { class: "tech", x: 10, y: 32 }, g);
    tech.textContent = n.tech;
    const ip = el("text", { class: "ip", x: 10, y: 45 }, g);
    g.onclick = () => showNode(id);
    state.nodeEls[id] = { g, ip, tech };
  }
}

function edgePath(from, to) {
  const A = pos(from), B = pos(to);
  if (Math.abs(A.x - B.x) < 10) {                          // same column: bow out to the right
    const x = A.x + BOX.w / 2, bow = 60 + Math.abs(A.y - B.y) * 0.15;
    return `M ${x} ${A.y} C ${x + bow} ${A.y}, ${x + bow} ${B.y}, ${x} ${B.y}`;
  }
  const dir = B.x > A.x ? 1 : -1;
  const x1 = A.x + dir * BOX.w / 2, x2 = B.x - dir * BOX.w / 2, mid = (x1 + x2) / 2;
  return `M ${x1} ${A.y} C ${mid} ${A.y}, ${mid} ${B.y}, ${x2} ${B.y}`;
}

const pairKey = (a, b) => [a, b].sort().join("|");

function drawTrace() {
  state.edgeLayer.innerHTML = "";
  state.packetLayer.innerHTML = "";
  state.edges = {};
  const used = new Set();
  for (const e of state.visible) {
    used.add(e.from); used.add(e.to);
    const k = pairKey(e.from, e.to);
    if (!state.edges[k]) {
      const [a, b] = k.split("|");
      state.edges[k] = { el: el("path", { class: "edge used", d: edgePath(a, b), style: `stroke:${PROTO_COLOR[e.proto]}` }, state.edgeLayer), a, b };
    }
  }
  for (const [id, n] of Object.entries(state.nodeEls)) {
    n.g.classList.toggle("used", used.has(id));
    n.g.classList.remove("active", "error");
    const example = state.mode === "prod" && EXAMPLE_IPS[id];
    const pod = state.pods && state.pods[id];
    n.tech.textContent = pod ? `${pod.pod.split("-").pop()} · ${(pod.node || "").replace(/^vijaybank-/, "")}` : NODES[id].tech;
    const svcIp = !pod && NODES[id].ns === "middleware" && state.ips[id] ? "svc " : "";
    n.ip.textContent = NODES[id].noIp ? "" : state.ips[id] ? svcIp + state.ips[id] + (example ? " · example" : "") : used.has(id) ? "IP not recorded" : "";
  }
}

function animatePacket(e, ms) {
  const edge = state.edges[pairKey(e.from, e.to)];
  if (!edge) return;
  const p = edge.el, len = p.getTotalLength(), forward = edge.a === e.from;
  const dot = el("circle", { class: "packet", r: 7, fill: PROTO_COLOR[e.proto] }, state.packetLayer);
  const label = el("text", { class: "edge-label", fill: PROTO_COLOR[e.proto] }, state.packetLayer);
  label.textContent = oneLine(e.info, 46);
  const start = performance.now();
  (function frame(now) {
    const k = Math.min(1, (now - start) / ms);
    const pt = p.getPointAtLength((forward ? k : 1 - k) * len);
    dot.setAttribute("cx", pt.x); dot.setAttribute("cy", pt.y);
    label.setAttribute("x", pt.x + 10); label.setAttribute("y", pt.y - 10);
    if (k < 1) requestAnimationFrame(frame);
    else setTimeout(() => { dot.remove(); label.remove(); }, 250);
  })(start);
}

// ------------------------------------------------------------------ playback
function applyFilter() {
  const showDb = $("#show-db").checked;
  state.visible = state.events.filter((e) => showDb || !DB_PROTOS.has(e.proto));
  state.idx = -1;
  drawTrace();
  renderTable();
  $("#hop-count").textContent = `(${state.visible.length})`;
}

function stepTo(i, animate = true) {
  state.idx = i;
  const e = state.visible[i];
  if (!e) return;
  for (const n of Object.values(state.nodeEls)) n.g.classList.remove("active", "error");
  Object.values(state.edges).forEach((x) => x.el.classList.remove("active"));
  state.nodeEls[e.from].g.classList.add("active");
  state.nodeEls[e.to].g.classList.add(e.span.error ? "error" : "active");
  state.edges[pairKey(e.from, e.to)].el.classList.add("active");
  if (animate) animatePacket(e, Math.min(700, delayAfter(i) * 0.85));
  renderTable();
  showEvent(e);
}

function delayAfter(i) {
  const pace = $("#pace").value;
  if (pace === "even") return 800;
  const next = state.visible[i + 1];
  const gap = next ? next.t - state.visible[i].t : 0;
  const mult = pace === "real10" ? 10 : 1;
  return Math.max(pace === "real" ? 60 : 250, Math.min(gap * mult, 4000));
}

function play() {
  if (!state.visible.length) return;
  if (state.idx >= state.visible.length - 1) state.idx = -1;
  state.playing = true;
  $("#btn-play").textContent = "❚❚ Pause";
  const tick = () => {
    if (!state.playing) return;
    stepTo(state.idx + 1);
    if (state.idx >= state.visible.length - 1) return pause();
    state.timer = setTimeout(tick, delayAfter(state.idx));
  };
  tick();
}

function pause() {
  state.playing = false;
  clearTimeout(state.timer);
  $("#btn-play").textContent = "▶ Play";
}

function reset() {
  pause();
  state.idx = -1;
  for (const n of Object.values(state.nodeEls)) n.g.classList.remove("active", "error");
  Object.values(state.edges || {}).forEach((x) => x.el.classList.remove("active"));
  state.packetLayer.innerHTML = "";
  renderTable();
}

// ------------------------------------------------------------------ table + details
const label = (id) => (NODES[id] ? NODES[id].label : id);
const fmtMs = (v) => (v === undefined ? "" : v < 1 ? v.toFixed(2) + " ms" : v < 1000 ? v.toFixed(1) + " ms" : (v / 1000).toFixed(2) + " s");

function resultHtml(e) {
  if (e.result === undefined) return "";
  const bad = e.span.error || /^[45]\d\d$/.test(String(e.result)) || e.result === "error";
  return `<span class="${bad ? "err" : "ok"}">${e.result}</span>`;
}

function renderTable() {
  const tb = $("#hops");
  if (!state.visible.length) {
    tb.innerHTML = `<tr><td colspan="8" class="muted">${state.trace ? "No hops." : "No request selected."}</td></tr>`;
    return;
  }
  tb.innerHTML = "";
  state.visible.forEach((e, i) => {
    const tr = document.createElement("tr");
    tr.className = (e.resp ? "resp " : "") + (e.illus ? "illus " : "") + (i === state.idx ? "active" : state.idx >= 0 && i > state.idx ? "future" : "");
    const from = label(e.from) + (state.ips[e.from] ? ` <span class="muted">${state.ips[e.from]}</span>` : "");
    const to = label(e.to) + (state.ips[e.to] ? ` <span class="muted">${state.ips[e.to]}</span>` : "");
    tr.innerHTML = `<td>${i + 1}</td><td>${e.illus ? "—" : "+" + Math.max(0, e.t).toFixed(1) + " ms"}</td><td>${from}</td><td>${to}</td>` +
      `<td><span class="proto" style="background:${PROTO_COLOR[e.proto]}">${e.proto}</span></td><td class="info"></td>` +
      `<td>${resultHtml(e)}</td><td>${e.resp ? "" : fmtMs(e.took)}</td>`;
    tr.querySelector(".info").textContent = (e.resp ? "↩ " : "") + e.info + (e.illus ? "  (illustrative)" : e.unmeasured ? "  (not measured)" : "");
    tr.onclick = () => { pause(); state.packetLayer.innerHTML = ""; stepTo(i); };
    tb.appendChild(tr);
    if (i === state.idx) {                                   // scroll the table only, not the page
      const wrap = tb.closest(".table-wrap"), top = tr.offsetTop - wrap.clientHeight / 2;
      wrap.scrollTop = Math.max(0, top);
    }
  });
}

const podLine = (id) => {
  const p = state.pods && state.pods[id];
  return p ? `<br><span class="muted">pod ${esc(p.pod)} · node ${esc(p.node)} · ns ${esc(NODES[id].ns)}</span>`
           : NODES[id] && NODES[id].ns ? `<br><span class="muted">ns ${esc(NODES[id].ns)}</span>` : "";
};

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function showEvent(e) {
  const s = e.span;
  const keep = Object.entries(s.a).filter(([k]) => !/user_agent|thread|code\.|connection_string|telemetry|messaging\.url/.test(k))
    .map(([k, v]) => [k, k === "db.statement" && e.proto === "Redis" ? maskRedis(v) : v]);
  const at = state.ips[e.to] ? ` (${state.ips[e.to]})` : "";
  $("#details").innerHTML = `
    <div><span class="badge" style="background:${PROTO_COLOR[e.proto]}">${e.proto}</span> ${e.resp ? "Response" : "Request"} #${state.idx + 1} of ${state.visible.length}</div>
    <dl>
      <dt>From</dt><dd>${esc(label(e.from))}${state.ips[e.from] ? " (" + state.ips[e.from] + ")" : ""}${podLine(e.from)}</dd>
      <dt>To</dt><dd>${esc(label(e.to))}${esc(at)}${podLine(e.to)}</dd>
      <dt>What</dt><dd>${esc(e.info)}</dd>
      <dt>Result</dt><dd>${resultHtml(e) || "—"}${s.error && s.statusMsg ? " · " + esc(s.statusMsg) : ""}</dd>
      ${e.illus ? "<dt>At</dt><dd>Illustrative: not part of the trace</dd>" : `<dt>At</dt><dd>+${Math.max(0, e.t).toFixed(2)} ms after the request started</dd>`}
      ${e.resp || e.illus || e.unmeasured ? "" : `<dt>Took</dt><dd>${fmtMs(e.took)}</dd>`}
      ${e.illus || e.unmeasured ? "" : `<dt>Span</dt><dd>${esc(s.service)} · ${esc(s.kind.toLowerCase())} · ${esc(s.name)}</dd>`}
    </dl>
    ${e.illus ? '<p class="muted">How this request would reach a real bank over the internet. Your lab has no such hop: the browser and the cluster are on the same Mac. Addresses are documentation examples.</p>' : ""}
    ${e.unmeasured ? '<p class="muted">Real hop, but nothing on it is instrumented, so it has no timing of its own.</p>' : ""}
    ${layersHtml(e)}
    <h3>About ${esc(label(e.resp ? e.from : e.to))}</h3>
    <p class="about">${esc(NODES[e.resp ? e.from : e.to].about)}</p>
    ${e.illus || e.unmeasured ? "" : `<h3>Recorded attributes</h3>
    <pre>`}${esc(keep.map(([k, v]) => `${k}: ${typeof v === "string" ? v.replace(/\s+/g, " ") : JSON.stringify(v)}`).join("\n"))}${e.illus || e.unmeasured ? "" : "</pre>"}`;
}

// ------------------------------------------------------------------ network layers
// What the hop looks like below the span: L7 down to L1. Addresses and ports come from the trace
// when it recorded them; the packet sequence is the protocol's usual exchange, not a capture.
const L7 = {
  HTTP: (e) => `HTTP/${e.net.ver || "1.1"}`, SQL: () => "PostgreSQL protocol v3 (extended query)", Redis: () => "RESP (Redis protocol)",
  AMQP: () => "AMQP 0-9-1", Mongo: () => "MongoDB wire protocol (OP_MSG)",
};
const L6 = {
  HTTP: "JSON body, UTF-8 text headers", SQL: "Postgres binary/text messages", Redis: "RESP text frames",
  AMQP: "Binary frames; JSON event as the body", Mongo: "BSON documents",
};
const L5 = {
  HTTP: "Keep-alive connection, reused for many requests", SQL: "Pooled connection, opened and authenticated earlier",
  Redis: "One long-lived connection per client", AMQP: "Long-lived connection with a channel inside it", Mongo: "Pooled connection",
};

// Who opened the connection (client) and who listens (server). For a RabbitMQ delivery the
// consumer is the client: it connected to :5672, and the broker pushes messages down that connection.
function endpoints(e) {
  const client = e.deliver ? (e.resp ? e.from : e.to) : (e.resp ? e.to : e.from);
  return { client, server: client === e.from ? e.to : e.from };
}

const fqdn = (id) => (NODES[id] && NODES[id].ns ? `${id}.${NODES[id].ns}.svc.cluster.local` : id);

function packets(e) {
  const a = e.span.a, n = e.net, { client: c, server: srv } = endpoints(e);
  const C = label(c), S = label(srv);
  const tcp = [
    ["DNS", `${C} → CoreDNS 10.96.0.10`, `A? ${fqdn(srv)}  (UDP 53; answer = the Service's ClusterIP, cached afterwards)`],
    ["TCP", `${C} → ${S}`, "SYN"], ["TCP", `${S} → ${C}`, "SYN, ACK"], ["TCP", `${C} → ${S}`, "ACK  (handshake: only on a new connection)"],
  ];
  if (!n.direct) tcp.splice(1, 0, ["NAT", `kube-proxy on ${(state.pods[c] || {}).node || "the client's node"}`,
    `iptables DNAT: Service ${n.svcIp || "ClusterIP"}:${n.dst || ""} → a ${S} pod IP (connection tracked, replies rewritten back)`]);
  const statement = oneLine(a["db.statement"] || e.span.name, 70);
  const p = {
    HTTP: [[`HTTP`, `${C} → ${S}`, `${e.info.replace(/ +\(.*$|  →.*$/, "")} HTTP/${n.ver || "1.1"}  + headers (Host, Content-Type, traceparent) + body`],
           ["TCP", `${S} → ${C}`, "ACK"],
           ["HTTP", `${S} → ${C}`, `HTTP/${n.ver || "1.1"} ${e.result || (state.visible.find((x) => x.resp && x.span === e.span) || {}).result || ""} + headers + JSON body`],
           ["TCP", `${C} → ${S}`, "ACK"]],
    SQL: [["PG", `${C} → ${S}`, `Parse: ${statement}`], ["PG", `${C} → ${S}`, "Bind (parameter values) · Execute · Sync"],
          ["PG", `${S} → ${C}`, "ParseComplete · BindComplete · DataRow × n · CommandComplete · ReadyForQuery"]],
    Redis: [["RESP", `${C} → ${S}`, `*N array: ${maskRedis(a["db.statement"] || e.span.name)}`], ["RESP", `${S} → ${C}`, "reply (integer / bulk string / OK)"]],
    Mongo: [["MONGO", `${C} → ${S}`, `OP_MSG { ${a["db.operation"] || "insert"}: "${a["db.mongodb.collection"] || "?"}", documents: [BSON] }`],
            ["MONGO", `${S} → ${C}`, "OP_MSG { ok: 1, n: 1 }"]],
    AMQP: e.deliver
      ? [["AMQP", `${S} → ${C}`, "basic.deliver (consumer tag, routing key) method frame"], ["AMQP", `${S} → ${C}`, "content header frame (headers incl. traceparent)"],
         ["AMQP", `${S} → ${C}`, "content body frame (JSON event)"], ["AMQP", `${C} → ${S}`, "basic.ack (message handled, broker can delete it)"]]
      : [["AMQP", `${C} → ${S}`, `basic.publish (exchange ${a["messaging.destination.name"] || "?"}, key ${a["messaging.rabbitmq.destination.routing_key"] || "?"})`],
         ["AMQP", `${C} → ${S}`, "content header frame (headers incl. traceparent)"], ["AMQP", `${C} → ${S}`, "content body frame (JSON event)"],
         ["AMQP", `${S} → ${C}`, "basic.ack (publisher confirm: broker has the message)"]],
  }[e.proto];
  // Connections are pooled / kept alive, so DNS and the handshake usually happened on an earlier request.
  return (e.proto === "HTTP" ? tcp : tcp.slice(1)).concat(p);
}

function layersHtml(e) {
  if (e.layers) {
    return `<h3>Network layers for this hop${e.illus ? ' <span class="muted">(illustrative)</span>' : ""}</h3>
      <table class="layers">${e.layers.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>
      <h3>Typical packets</h3>
      <ol class="packets">${(e.pkts || []).map(([pr, d, t]) => `<li><b>${pr}</b> <span class="muted">${esc(d)}</span><br>${esc(t)}</li>`).join("")}</ol>`;
  }
  const n = e.net || {};
  const { client, server } = endpoints(e);
  const at = (id, port) => `${label(id)} ${state.ips[id] ? state.ips[id] + port : port.replace(/^:/, "port ") + " (IP not recorded)"}`;
  const cPort = n.src ? `:${n.src}` : ":ephemeral";
  const sPort = n.dst ? `:${n.dst}` : "";
  const dir = client === e.from ? "→" : "←";
  const pc = state.pods[client] || {}, ps = state.pods[server] || {};
  const sameNode = pc.node && ps.node && pc.node === ps.node;
  const where = !pc.node || !ps.node ? "node of the server pod not in the trace (data stores aren't traced)"
    : sameNode ? `both pods on ${pc.node}: routed inside that node` : `${pc.node} → ${ps.node}: routed node to node`;
  const svc = n.direct ? `straight to the pod IP (Traefik reads the Service's endpoints itself)`
    : `to the ${label(server)} Service${n.svcIp ? " " + n.svcIp : ""} (ClusterIP); kube-proxy's iptables rules DNAT it to a pod IP`;
  const rows = [
    ["L7 Application", L7[e.proto](e) + " · " + e.info.replace(/ +\(.*$|  →.*$/, "")],
    ["L6 Presentation", L6[e.proto] + " · not encrypted (no TLS inside the cluster)"],
    ["L5 Session", L5[e.proto]],
    ["L4 Transport", `TCP  ${at(client, cPort)} ${dir} ${at(server, sPort)} · ${svc}`],
    ["L3 Network", `IPv4 pod network 10.244.0.0/16 (kindnet CNI) · ${where}`],
    ["L2 Data link", sameNode ? "Pod veth → node's network stack → other pod's veth"
                              : "Pod veth → node eth0 → Docker bridge \"kind\" (172.18.0.0/16) → other node's eth0 → pod veth"],
    ["L1 Physical", "None: every kind node is a container in the Docker Desktop VM"],
  ];
  const pk = packets(e);
  return `<h3>Network layers for this hop</h3>
    <table class="layers">${rows.map(([k, v]) => `<tr><th>${k}</th><td>${esc(v)}</td></tr>`).join("")}</table>
    <h3>Typical packets <span class="muted">(protocol's usual exchange, not captured)</span></h3>
    <ol class="packets">${pk.map(([pr, d, t]) => `<li><b>${pr}</b> <span class="muted">${esc(d)}</span><br>${esc(t)}</li>`).join("")}</ol>
    ${e.proto !== "HTTP" ? '<p class="muted">The connection is pooled, so its DNS lookup and TCP handshake happened earlier, not on this call.</p>' : ""}`;
}

function showNode(id) {
  const n = NODES[id];
  if (!state.ips) state.ips = {};
  const calls = state.visible.filter((e) => !e.resp && (e.from === id || e.to === id));
  $("#details").innerHTML = `
    <h3>${esc(n.label)} · ${esc(n.tech)}</h3>
    <p class="about">${esc(n.about)}</p>
    <dl><dt>IP</dt><dd>${esc(state.ips && state.ips[id] || "not recorded in this trace")}</dd>
    ${state.pods && state.pods[id] ? `<dt>Pod</dt><dd>${esc(state.pods[id].pod)}</dd><dt>Node</dt><dd>${esc(state.pods[id].node)}</dd>` : ""}
    ${n.ns ? `<dt>Namespace</dt><dd>${esc(n.ns)}</dd><dt>Service DNS</dt><dd>${esc(fqdn(id))}</dd>` : ""}
    <dt>Hops</dt><dd>${calls.length} in this request</dd></dl>`;
}

// ------------------------------------------------------------------ select a trace
async function select(id, autoplay) {
  if (!/^[0-9a-f]{16,32}$/.test(id)) return;
  pause();
  setHash(id);
  clearTimeout(state.refetch);
  state.selected = id;
  const t = state.traces.find((x) => x.traceID === id);
  if (t) t.isNew = false;
  renderList();
  try {
    const d = toOtlp((await jaeger(`api/traces/${id}`)).data[0]);
    if (state.selected !== id) return;
    load(d, id);
    if (autoplay) play();
    // Spans from async consumers (settlement, notifications) can arrive after the first fetch.
    const young = Date.now() - Number(state.trace.t0 / 1000000n) < 30000;
    if (young) scheduleRefetch(id, 4);
  } catch (e) {
    $("#trace-title").textContent = "Could not load trace";
    $("#summary").textContent = String(e);
  }
}

function scheduleRefetch(id, left) {
  state.refetch = setTimeout(async () => {
    if (state.selected !== id || !left) return;
    const j = await jaeger(`api/traces/${id}`).catch(() => null);
    const d = j && j.data && j.data[0] ? toOtlp(j.data[0]) : null;
    const spans = d && d.resourceSpans.reduce((n, b) => n + b.scopeSpans[0].spans.length, 0);
    if (spans && spans !== state.trace.spans.length && !state.playing) load(d, id);
    scheduleRefetch(id, left - 1);
  }, 3000);
}

function rebuild() {
  const { events, ips, pods } = buildEvents(state.trace);
  state.events = events;
  state.ips = ips;
  state.pods = pods;
}

function load(d, id) {
  state.trace = parseTrace(d);
  rebuild();
  const root = gatewaySpan(state.trace) || rootSpan(state.trace);
  const services = new Set(state.trace.spans.map((s) => s.service));
  const dur = Math.max(...state.trace.spans.map((s) => s.t + s.ms));
  const errors = state.trace.spans.filter((s) => s.error).length;
  $("#trace-title").textContent = friendly(root.name, root.a["http.target"] || root.a["url.path"]);
  const explore = `${GRAFANA}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify({ a: { datasource: "jaeger", queries: [{ refId: "A", datasource: { type: "jaeger", uid: "jaeger" }, query: id }], range: { from: "now-1h", to: "now" } } }))}`;
  $("#summary").innerHTML = `<b>${services.size}</b> services · <b>${state.trace.spans.length}</b> spans · <b>${fmtMs(dur)}</b> end to end` +
    (errors ? ` · <b class="err">${errors} error span(s)</b>` : "") +
    ` · trace <code>${id.slice(0, 12)}…</code> · <a href="${JAEGER_UI}/trace/${id}" target="_blank" rel="noopener">open in Jaeger</a>` +
    ` · <a href="${explore}" target="_blank" rel="noopener">Grafana</a>`;
  applyFilter();
  $("#details").innerHTML = '<p class="muted">Press Play, Step, or click a row.</p>';
}

// ------------------------------------------------------------------ wiring
document.querySelectorAll(".filters button").forEach((b) => (b.onclick = () => {
  document.querySelectorAll(".filters button").forEach((x) => x.classList.toggle("active", x === b));
  state.filter = b.dataset.filter;
  renderList();
}));
$("#btn-play").onclick = () => (state.playing ? pause() : play());
const step = (d) => {
  pause();
  state.packetLayer.innerHTML = "";
  const i = state.idx + d;
  if (i >= 0 && i < state.visible.length) stepTo(i);
};
$("#btn-step").onclick = () => step(1);
$("#btn-back").onclick = () => step(-1);
$("#btn-reset").onclick = reset;
$("#show-db").onchange = () => { pause(); applyFilter(); };

// Keyboard: space = play/pause, arrows = step, R = reset (not while typing in a field).
document.addEventListener("keydown", (ev) => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) || ev.metaKey || ev.ctrlKey) return;
  if (ev.key === " ") { ev.preventDefault(); state.playing ? pause() : play(); }
  else if (ev.key === "ArrowRight") step(1);
  else if (ev.key === "ArrowLeft") step(-1);
  else if (ev.key === "r" || ev.key === "R") reset();
});

function setMode(mode) {
  state.mode = mode === "prod" ? "prod" : "k8s";
  document.querySelectorAll(".modes button").forEach((b) => b.classList.toggle("active", b.dataset.mode === state.mode));
  pause();
  drawBase();
  if (state.trace) { rebuild(); applyFilter(); }
  setHash(state.selected);
}
document.querySelectorAll(".modes button").forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

// Shareable link: #trace=<id>&view=prod
function setHash(id) {
  const h = new URLSearchParams();
  if (id) h.set("trace", id);
  if (state.mode === "prod") h.set("view", "prod");
  history.replaceState(null, "", h.toString() ? "#" + h : location.pathname);
}
$("#trace-form").onsubmit = (ev) => {
  ev.preventDefault();
  const id = $("#trace-id").value.trim().toLowerCase();
  if (/^[0-9a-f]{16,32}$/.test(id)) select(id, true);
  else $("#trace-id").setCustomValidity("Paste a 32-character trace ID"), $("#trace-id").reportValidity();
};
$("#trace-id").oninput = () => $("#trace-id").setCustomValidity("");

const start = new URLSearchParams(location.hash.slice(1));
setMode(start.get("view"));
poll();
setInterval(poll, 3000);
if (start.get("trace")) select(start.get("trace"), false);
