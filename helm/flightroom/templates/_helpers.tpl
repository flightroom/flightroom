{{/*
Expand the name of the chart.
*/}}
{{- define "flightroom.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Fully qualified app name, truncated to the 63 chars a DNS name allows.
*/}}
{{- define "flightroom.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version, as used by the chart label.
*/}}
{{- define "flightroom.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "flightroom.labels" -}}
helm.sh/chart: {{ include "flightroom.chart" . }}
{{ include "flightroom.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "flightroom.selectorLabels" -}}
app.kubernetes.io/name: {{ include "flightroom.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Name of the service account to use.
*/}}
{{- define "flightroom.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "flightroom.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Name of the PersistentVolumeClaim holding the uploaded microfrontends.
*/}}
{{- define "flightroom.pvcName" -}}
{{- if .Values.persistence.existingClaim }}
{{- .Values.persistence.existingClaim }}
{{- else }}
{{- printf "%s-microfrontends" (include "flightroom.fullname" .) }}
{{- end }}
{{- end }}

{{/*
"true" when the microfrontends volume can be mounted by a single node only,
i.e. persistence is on and the access modes do not include ReadWriteMany.
*/}}
{{- define "flightroom.singleNodeVolume" -}}
{{- if and .Values.persistence.enabled (not (has "ReadWriteMany" .Values.persistence.accessModes)) }}
{{- "true" }}
{{- end }}
{{- end }}

{{/*
Deployment strategy type: strategy.type wins, otherwise Recreate on a single
node volume and RollingUpdate on a shared one.
*/}}
{{- define "flightroom.strategyType" -}}
{{- default (ternary "Recreate" "RollingUpdate" (eq (include "flightroom.singleNodeVolume" .) "true")) .Values.strategy.type }}
{{- end }}

{{/*
Fails the render on value combinations that cannot work.
*/}}
{{- define "flightroom.validateValues" -}}
{{- if and (include "flightroom.singleNodeVolume" .) (or .Values.autoscaling.enabled (gt (int .Values.replicaCount) 1)) }}
{{- fail (printf "persistence.accessModes is %s: the volume attaches to a single node, so replicaCount > 1 or autoscaling.enabled would leave the other pods unable to mount it. Use a ReadWriteMany volume (persistence.accessModes: [ReadWriteMany], on a StorageClass that supports it) or keep replicaCount: 1 with autoscaling disabled." (join ", " .Values.persistence.accessModes)) }}
{{- end }}
{{- end }}

{{/*
Folder the microfrontends are stored in: persistence.mountPath wins, otherwise
the value of MICROFRONTEND_HOST_FOLDER, otherwise the application default.
*/}}
{{- define "flightroom.microfrontendFolder" -}}
{{- $fromEnv := "" }}
{{- with .Values.env }}
{{- $fromEnv = default "" (get . "MICROFRONTEND_HOST_FOLDER") }}
{{- end }}
{{- default (default "/upload-microfrontends" $fromEnv) .Values.persistence.mountPath }}
{{- end }}

{{/*
Environment variables of a values map, filtered and quoted, as "KEY: value"
lines. Empty strings and nulls are dropped so that the application keeps its
own defaults instead of receiving an empty variable.
Usage: include "flightroom.envEntries" .Values.env
*/}}
{{- define "flightroom.envEntries" -}}
{{- range $key, $value := . }}
{{- if not (kindIs "invalid" $value) }}
{{- if ne (toString $value) "" }}
{{ $key }}: {{ toString $value | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end }}

{{/*
True when the given map has at least one usable entry.
*/}}
{{- define "flightroom.hasEnvEntries" -}}
{{- $found := "" }}
{{- range $key, $value := . }}
{{- if not (kindIs "invalid" $value) }}
{{- if ne (toString $value) "" }}
{{- $found = "true" }}
{{- end }}
{{- end }}
{{- end }}
{{- $found }}
{{- end }}
