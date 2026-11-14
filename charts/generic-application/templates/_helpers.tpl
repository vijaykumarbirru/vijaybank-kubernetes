{{/* Resource name: nameOverride or the release name. */}}
{{- define "app.name" -}}
{{- default .Release.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "app.labels" -}}
{{ include "app.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/part-of: vijaybank
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- end -}}

{{- define "app.image" -}}
{{- required "image.repository is required" .Values.image.repository }}:{{ required "image.tag is required" .Values.image.tag }}
{{- end -}}

{{- define "app.servicePort" -}}
{{- default .Values.containerPort .Values.service.port -}}
{{- end -}}

{{/* Pod template shared by the Deployment and the Job. */}}
{{- define "app.podTemplate" -}}
metadata:
  labels:
    {{- include "app.selectorLabels" . | nindent 4 }}
    {{- with .Values.podLabels }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
  annotations:
    # Restart pods when the settings change.
    checksum/config: {{ include (print $.Template.BasePath "/configmap.yaml") . | sha256sum }}
    {{- with .Values.podAnnotations }}
    {{- toYaml . | nindent 4 }}
    {{- end }}
spec:
  {{- if .Values.job.enabled }}
  restartPolicy: OnFailure
  {{- end }}
  {{- with .Values.podSecurityContext }}
  securityContext:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  containers:
    - name: {{ include "app.name" . }}
      image: {{ include "app.image" . }}
      imagePullPolicy: {{ .Values.image.pullPolicy }}
      {{- if not .Values.job.enabled }}
      ports:
        - name: http
          containerPort: {{ .Values.containerPort }}
          protocol: TCP
      {{- end }}
      envFrom:
        - configMapRef:
            name: {{ include "app.name" . }}
        {{- with .Values.envFrom }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- if or .Values.secretEnv .Values.extraEnv }}
      env:
        {{- range $name, $ref := .Values.secretEnv }}
        - name: {{ $name }}
          valueFrom:
            secretKeyRef:
              name: {{ $ref.secret }}
              key: {{ $ref.key }}
        {{- end }}
        {{- with .Values.extraEnv }}
        {{- tpl (toYaml .) $ | nindent 8 }}
        {{- end }}
      {{- end }}
      {{- if and .Values.health.enabled (not .Values.job.enabled) }}
      startupProbe:
        httpGet: { path: {{ .Values.health.path }}, port: http }
        {{- toYaml .Values.health.startup | nindent 8 }}
      readinessProbe:
        httpGet: { path: {{ .Values.health.path }}, port: http }
        {{- toYaml .Values.health.readiness | nindent 8 }}
      livenessProbe:
        httpGet: { path: {{ default .Values.health.path .Values.health.livenessPath }}, port: http }
        {{- toYaml .Values.health.liveness | nindent 8 }}
      {{- end }}
      {{- with .Values.resources }}
      resources:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.securityContext }}
      securityContext:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.volumeMounts }}
      volumeMounts:
        {{- toYaml . | nindent 8 }}
      {{- end }}
  {{- with .Values.volumes }}
  volumes:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.nodeSelector }}
  nodeSelector:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.tolerations }}
  tolerations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  {{- with .Values.affinity }}
  affinity:
    {{- toYaml . | nindent 4 }}
  {{- end }}
{{- end -}}
