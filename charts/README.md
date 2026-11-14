# Helm charts

Same layout as a typical company chart repo: one shared chart with the templates,
and one thin chart per service that only holds values.

```
charts/
  generic-application/   shared templates (Deployment or Job, Service, ConfigMap, probes, HTTPRoute)
  <service>/             Chart.yaml (depends on generic-application) + values.yaml + values-kind.yaml
```

Values precedence: `generic-application/values.yaml` (defaults) → `<service>/values.yaml`
→ `<service>/values-kind.yaml`. In a service chart, everything sits under the
`generic-application:` key.

## generic-application values

| Key | Purpose |
|---|---|
| `image.repository`, `image.tag` | Required. Image in the local registry (`localhost:5001/vijaybank/...`) |
| `containerPort` | Port the app listens on; used by probes and the Service |
| `middleware.*` | Data-store hostnames, used in service values as `{{ .Values.middleware.postgres }}` |
| `env` | Plain settings → ConfigMap → env vars. Rendered with `tpl` |
| `secretEnv` | `NAME: { secret: <secret>, key: <key> }` → env var from a Secret |
| `extraEnv` | Raw env entries after `secretEnv`; can use `$(NAME)` to embed a secret value |
| `envFrom` | Extra whole Secrets / ConfigMaps as env vars |
| `health.*` | Startup, readiness and liveness HTTP probes (default `/health/ready`) |
| `otel.*` | OpenTelemetry settings; `otel.env` holds language extras (Java agent, Node loader) |
| `resources` | Requests / limits |
| `route.*` | HTTPRoute on the shared Traefik Gateway `main` |
| `job.*` | Run as a one-off Job instead of a Deployment |

Pods restart automatically when `env` changes (config checksum annotation).
