"""Generates the "VijayBank — APM (Kubernetes)" dashboard for Elastic Cloud (Kibana) as an importable NDJSON file.

    python3 scripts/build-elastic-dashboard.py

Writes elastic/vijaybank-kubernetes-apm-dashboard.ndjson. Import it in Kibana under
Stack Management / Project settings > Saved objects > Import ("Automatically overwrite" so a
re-import updates it). Edit the panels here and re-run rather than hand-editing the NDJSON.

Mirrors the Grafana APM dashboard (scripts/build-dashboards.py) with the data Elastic receives from
the Collector (platform/observability/otel-collector-elastic-values.yaml): traces and OTLP app
metrics. The Collector renames every service to <name>-kubernetes for Elastic only, so this
dashboard shows just the Kubernetes services, and has its own ID: it doesn't replace the Docker
version's "VijayBank — APM" dashboard in the same Elastic project.
Every panel is an ES|QL query. Field names are Elastic's OpenTelemetry-native ones:
spans in traces-* (duration in ns, event.outcome success/failure, kind Server/Client/...),
app metrics in metrics-* as metrics.<name> with labels under attributes.*.
"""

import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "elastic" / "vijaybank-kubernetes-apm-dashboard.ndjson"
DASHBOARD_ID = "vijaybank-kubernetes-apm"
K8S = 'service.name LIKE "*-kubernetes"'                # set by the Collector, Elastic pipelines only

# Incoming requests (server spans); SERVER leaves out the kubelet health probes (Java services trace those).
SERVER_ALL = ('FROM traces-*\n'
              f'| WHERE service.namespace == "vijaybank" AND {K8S} AND kind == "Server"')
SERVER = SERVER_ALL + ' AND NOT (name LIKE "*/health*")'
CLIENT = ('FROM traces-*\n'
          f'| WHERE service.namespace == "vijaybank" AND {K8S} AND kind IN ("Client", "Producer")')
# Per-request flags. Apdex T = 200 ms: satisfied <= 200 ms, tolerating <= 800 ms (4T).
FLAGS = ('| EVAL ms = duration / 1000000.0, err = CASE(event.outcome == "failure", 1, 0),\n'
         '       sat = CASE(duration <= 200000000, 1, 0), tol = CASE(duration > 200000000 AND duration <= 800000000, 1, 0)')
MINUTES = 'DATE_DIFF("second", TO_DATETIME(?_tstart), TO_DATETIME(?_tend)) / 60.0'
BUCKET = 'BUCKET(@timestamp, 1 minute)'


class Layout:
    """Places panels left-to-right on Kibana's 48-column grid."""

    def __init__(self):
        self.panels, self.x, self.y, self.row_h = [], 0, 0, 0

    def newline(self):
        if self.x:
            self.y += self.row_h
            self.x, self.row_h = 0, 0

    def add(self, panel, w, h):
        if self.x + w > 48:
            self.newline()
        i = f"p{len(self.panels) + 1}"
        self.panels.append({"type": "lens", "panelIndex": i, "gridData": {"x": self.x, "y": self.y, "w": w, "h": h, "i": i},
                            "embeddableConfig": {"attributes": panel, "enhancements": {}}})
        self.x += w
        self.row_h = max(self.row_h, h)


def lens(title, esql, vis_type, columns, visualization, desc=""):
    """A by-value Lens panel backed by one ES|QL query. columns: [(name, "number"|"string"|"date")]."""
    index = esql.split()[1].rstrip(",")                    # FROM <pattern>
    view = f"esql-{index}"
    layer = {"index": view, "query": {"esql": esql}, "timeField": "@timestamp",
             "columns": [{"columnId": c, "fieldName": c, "meta": {"type": t}} for c, t in columns]}
    return {"title": title, "description": desc, "visualizationType": vis_type, "type": "lens", "references": [],
            "state": {"datasourceStates": {"textBased": {"layers": {"L": layer},
                                                          "indexPatternRefs": [{"id": view, "title": index, "timeField": "@timestamp"}]}},
                      "query": {"esql": esql}, "filters": [], "visualization": visualization,
                      "adHocDataViews": {view: {"id": view, "title": index, "name": index, "timeFieldName": "@timestamp",
                                                "type": "esql", "sourceFilters": [], "fieldFormats": {}, "runtimeFieldMap": {},
                                                "allowNoIndex": False, "allowHidden": False}}}}


def metric(title, esql, value, desc=""):
    return lens(title, esql, "lnsMetric", [(value, "number")],
                {"layerId": "L", "layerType": "data", "metricAccessor": value}, desc)


def table(title, esql, columns, desc=""):
    return lens(title, esql, "lnsDatatable", columns,
                {"layerId": "L", "layerType": "data", "columns": [{"columnId": c} for c, _ in columns]}, desc)


def chart(title, esql, y, split="service.name", series="line", desc="", x="t"):
    cols = [(x, "date"), (y, "number")] + ([(split, "string")] if split else [])
    layer = {"layerId": "L", "layerType": "data", "seriesType": series, "xAccessor": x, "accessors": [y]}
    if split:
        layer["splitAccessor"] = split
    return lens(title, esql, "lnsXY", cols,
                {"preferredSeriesType": series, "legend": {"isVisible": True, "position": "right"}, "layers": [layer]}, desc)


def bars(title, esql, y, x, desc=""):
    """Horizontal bars of y per category x."""
    return lens(title, esql, "lnsXY", [(x, "string"), (y, "number")],
                {"preferredSeriesType": "bar_horizontal", "legend": {"isVisible": False, "position": "right"},
                 "layers": [{"layerId": "L", "layerType": "data", "seriesType": "bar_horizontal", "xAccessor": x, "accessors": [y]}]}, desc)


# =============================================================== panels
def build():
    L = Layout()

    # ---- Top: headline numbers for the selected time range
    L.add(metric("Services sending traces", f"{SERVER_ALL}\n"
                 "| STATS services = COUNT_DISTINCT(service.name)", "services",
                 "Services that sent at least one incoming request (server span) in the time range. "
                 "Elastic has no health probes (Blackbox stays in the cluster), so this replaces Grafana's UP/DOWN tiles. "
                 "traefik-kubernetes is the cluster's ingress: it also carries Grafana / Jaeger / Argo CD UI traffic."), 12, 7)
    L.add(metric("Requests per minute", f"{SERVER}\n| STATS n = COUNT(*)\n| EVAL rpm = ROUND(n / ({MINUTES}), 1)\n| KEEP rpm", "rpm"), 12, 7)
    L.add(metric("Error %", f"{SERVER}\n{FLAGS}\n| STATS errors = SUM(err), n = COUNT(*)\n"
                 "| EVAL error_pct = ROUND(100.0 * errors / n, 2)\n| KEEP error_pct", "error_pct",
                 "Share of incoming requests whose span outcome is failure (5xx or an unhandled exception)."), 12, 7)
    L.add(metric("p95 response time (ms)", f"{SERVER}\n{FLAGS}\n| STATS p95_ms = ROUND(PERCENTILE(ms, 95), 1)", "p95_ms"), 12, 7)

    # ---- Services overview (same columns as Grafana)
    L.add(table("Services — throughput, response time, errors, Apdex",
                f"{SERVER}\n{FLAGS}\n"
                "| STATS requests = COUNT(*), errors = SUM(err), avg_ms = AVG(ms), p95_ms = PERCENTILE(ms, 95), sat = SUM(sat), tol = SUM(tol) BY service.name\n"
                f"| EVAL rpm = ROUND(requests / ({MINUTES}), 2), error_pct = ROUND(100.0 * errors / requests, 2),\n"
                "       apdex = ROUND((sat + tol / 2.0) / requests, 2), avg_ms = ROUND(avg_ms, 1), p95_ms = ROUND(p95_ms, 1)\n"
                "| KEEP service.name, rpm, avg_ms, p95_ms, error_pct, requests, errors, apdex\n"
                "| SORT requests DESC",
                [("service.name", "string"), ("rpm", "number"), ("avg_ms", "number"), ("p95_ms", "number"), ("error_pct", "number"),
                 ("requests", "number"), ("errors", "number"), ("apdex", "number")],
                "One row per service over the time range. A request is one incoming server span. "
                "Apdex T = 200 ms: 1.0 = every request under 200 ms."), 48, 14)

    # ---- Golden signals
    L.add(chart("Throughput (requests / min)", f"{SERVER}\n| STATS rpm = COUNT(*) BY t = {BUCKET}, service.name", "rpm"), 16, 12)
    L.add(chart("Error %", f"{SERVER}\n{FLAGS}\n| STATS errors = SUM(err), n = COUNT(*) BY t = {BUCKET}, service.name\n"
                "| EVAL error_pct = ROUND(100.0 * errors / n, 2)\n| KEEP t, service.name, error_pct", "error_pct"), 16, 12)
    L.add(chart("p95 response time (ms)", f"{SERVER}\n{FLAGS}\n| STATS p95_ms = PERCENTILE(ms, 95) BY t = {BUCKET}, service.name", "p95_ms"), 16, 12)

    L.add(table("Slowest endpoints", f"{SERVER}\n{FLAGS}\n"
                "| STATS requests = COUNT(*), errors = SUM(err), avg_ms = AVG(ms), p95_ms = PERCENTILE(ms, 95) BY service.name, endpoint = name\n"
                "| EVAL avg_ms = ROUND(avg_ms, 1), p95_ms = ROUND(p95_ms, 1)\n"
                "| SORT p95_ms DESC\n| LIMIT 25",
                [("service.name", "string"), ("endpoint", "string"), ("requests", "number"), ("errors", "number"),
                 ("avg_ms", "number"), ("p95_ms", "number")]), 48, 12)

    # ---- Outgoing calls
    L.add(table("Calls each service makes — databases, HTTP, messaging (slowest first)", f"{CLIENT}\n{FLAGS}\n"
                "| STATS calls = COUNT(*), errors = SUM(err), avg_ms = AVG(ms), p95_ms = PERCENTILE(ms, 95) BY service.name, kind, call = name\n"
                "| EVAL avg_ms = ROUND(avg_ms, 2), p95_ms = ROUND(p95_ms, 2)\n"
                "| SORT p95_ms DESC\n| LIMIT 50",
                [("service.name", "string"), ("kind", "string"), ("call", "string"), ("calls", "number"), ("errors", "number"),
                 ("avg_ms", "number"), ("p95_ms", "number")],
                "Client spans (SQL, Redis, Mongo, HTTP to other services) and Producer spans (RabbitMQ publish)."), 48, 14)

    # ---- JVM runtime (Java & Kotlin services): sum the memory pools per export, then average per minute
    jvm = lambda kind: ('FROM metrics-*\n'
                        f'| WHERE service.namespace == "vijaybank" AND {K8S} AND attributes.jvm.memory.type == "{kind}" AND metrics.jvm.memory.used IS NOT NULL\n'
                        '| STATS used = SUM(metrics.jvm.memory.used) BY service.name, @timestamp\n'
                        f'| STATS used = AVG(used) BY t = {BUCKET}, service.name\n'
                        '| EVAL mb = ROUND(used / 1048576.0, 1)\n| KEEP t, service.name, mb')
    L.add(chart("JVM heap used (MB)", jvm("heap"), "mb"), 24, 12)
    L.add(chart("JVM non-heap used (MB)", jvm("non_heap"), "mb", desc="Metaspace, code cache and compressed class space."), 24, 12)

    # ---- OTP (auth-service's own counters). They are cumulative, so increase = max - min per series.
    otp = lambda metric_name, by: ('FROM metrics-*\n'
                                   f'| WHERE scope.name == "vijaybank.auth" AND {K8S} AND metrics.{metric_name} IS NOT NULL\n'
                                   f'| STATS hi = MAX(metrics.{metric_name}), lo = MIN(metrics.{metric_name}) BY {by}, service.instance.id\n'
                                   f'| EVAL n = hi - lo\n| STATS n = SUM(n) BY {", ".join(b.split(" = ")[0] for b in by.split(", "))}')
    L.add(bars("OTPs sent by purpose", otp("vijaybank.otp.sent", "purpose = attributes.purpose") + "\n| SORT n DESC", "n", "purpose",
               "Increase of vijaybank.otp.sent in the time range."), 16, 12)
    L.add(table("OTP verifications by purpose and result",
                otp("vijaybank.otp.verifications", "purpose = attributes.purpose, result = attributes.result")
                + "\n| WHERE n > 0\n| SORT purpose, result",
                [("purpose", "string"), ("result", "string"), ("n", "number")],
                "SUCCESS, INVALID_OTP, OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED. Anything other than SUCCESS is a failed attempt "
                "(Grafana alerts on these)."), 16, 12)
    L.add(table("OTP failures", otp("vijaybank.otp.verifications", "purpose = attributes.purpose, result = attributes.result")
                + '\n| WHERE result != "SUCCESS"\n| STATS failed = SUM(n) BY purpose\n| SORT failed DESC',
                [("purpose", "string"), ("failed", "number")]), 16, 12)

    # ---- Traces
    L.add(table("Slow requests (> 200 ms) — search the trace.id in Applications > Traces",
                f"{SERVER} AND duration > 200000000\n"
                "| EVAL ms = ROUND(duration / 1000000.0, 1)\n"
                "| KEEP @timestamp, service.name, name, ms, event.outcome, trace.id\n"
                "| SORT @timestamp DESC\n| LIMIT 100",
                [("@timestamp", "date"), ("service.name", "string"), ("name", "string"), ("ms", "number"),
                 ("event.outcome", "string"), ("trace.id", "string")]), 48, 14)
    return L.panels


def main():
    panels = build()
    dashboard = {
        "id": DASHBOARD_ID, "type": "dashboard", "references": [],
        # Without a version Kibana re-runs every dashboard migration since 7.x on import, and the old
        # Lens ones fail on ES|QL panels. 10.2.0 = Kibana 8.15; newer Kibanas migrate it forward.
        "coreMigrationVersion": "8.8.0", "typeMigrationVersion": "10.2.0",
        "attributes": {
            "title": "VijayBank — APM (Kubernetes)",
            "description": "Throughput, response time, errors, Apdex, outgoing calls, JVM and OTP for the VijayBank services "
                           "on the kind cluster (service names ending in -kubernetes). Generated by scripts/build-elastic-dashboard.py.",
            "panelsJSON": json.dumps(panels),
            "optionsJSON": json.dumps({"useMargins": True, "syncColors": True, "syncCursor": True, "syncTooltips": False, "hidePanelTitles": False}),
            "timeRestore": True, "timeFrom": "now-1h", "timeTo": "now", "refreshInterval": {"pause": False, "value": 60000},
            "kibanaSavedObjectMeta": {"searchSourceJSON": json.dumps({"query": {"query": "", "language": "kuery"}, "filter": []})},
        },
    }
    OUT.write_text(json.dumps(dashboard) + "\n")
    print(f"wrote {OUT} ({len(panels)} panels)")


if __name__ == "__main__":
    main()
