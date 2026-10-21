#!/usr/bin/env bash
# Install, update or remove the DEV backend beside the installed plugin.
#
# Run it wherever kubectl reaches the panel's cluster (normally the machine the
# 5stack panel runs on), from a checkout of this fork:
#
#   ./scripts/dev-backend.sh            # install, or re-apply after a change
#   ./scripts/dev-backend.sh update     # restart onto the newest :dev image
#   ./scripts/dev-backend.sh remove     # delete everything this created
#   ./scripts/dev-backend.sh assets on  # serve the dev host's models, art and
#                                       # music from the dev backend (opt-in)
#   ./scripts/dev-backend.sh assets off # back to the installed frontend
#   ./scripts/dev-backend.sh step viewmodel-anims
#                                       # re-run ONE extraction step (or a
#                                       # comma list) in the dev pod, minutes
#                                       # instead of a full run
#
# `assets` only changes where the DEV host (inventory-dev.<domain>) gets those
# files from; see docs/CACHING.md. Re-running the install keeps whichever it is.
#
# It asks nothing: like plugin.sh, it reads the installed plugin instead — its
# database connection, its panel domains, its ingress class and whether it
# terminates TLS in the cluster. See docs/DEV-PLUGIN.md for what runs and why.
set -euo pipefail

NS=5stack
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-ghcr.io/lcrew/5stack-inventory-plugin-backend:dev}"

die() { echo "!! $*" >&2; exit 1; }
say() { echo "--- $*"; }
kc() { kubectl -n "$NS" "$@"; }

command -v kubectl >/dev/null 2>&1 || die "kubectl not found. Run this on the machine your 5stack panel runs on."

# Reach the cluster the way the panel's own plugin.sh does: the panel folder's
# .5stack-env.config names the kubeconfig, and k3s's default stands in for it.
# The panel folder is the current directory or the one this checkout sits in.
if [[ -z "${KUBECONFIG:-}" ]]; then
  for cfg in "$PWD/.5stack-env.config" "$REPO_DIR/../.5stack-env.config"; do
    if [[ -f "$cfg" ]]; then
      KUBECONFIG="$(grep -E '^KUBECONFIG=' "$cfg" | head -1 | cut -d= -f2- | tr -d '"' || true)"
      [[ -n "$KUBECONFIG" ]] && break
    fi
  done
  KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
  export KUBECONFIG
fi
kubectl version -o json >/dev/null 2>&1 ||
  die "kubectl can't reach the cluster ($KUBECONFIG). Run it with sudo, the way you run ./plugin.sh."
kc get deployment inventory-backend >/dev/null 2>&1 ||
  die "No inventory plugin in namespace $NS. The dev backend runs beside an installed one."

case "${1:-install}" in
  remove)
    kc delete ingress/inventory-dev deployment/inventory-dev-backend service/inventory-dev-backend \
      secret/inventory-dev-secrets configmap/inventory-dev-config --ignore-not-found
    kc delete certificate/inventory-dev-ssl --ignore-not-found 2>/dev/null || true
    say "Removed. Its cards are still on the node at /opt/5stack/models/cs2-model-extract/renders-dev;"
    say "delete that folder too if you want them gone. The live plugin was not touched."
    exit 0
    ;;
  update)
    kc rollout restart deployment/inventory-dev-backend
    kc rollout status deployment/inventory-dev-backend --timeout=300s
    exit 0
    ;;
  install) ;;
  step)
    # ONE step of scripts/extract-models.sh, in the dev pod, with the same
    # environment the backend gives a full run (startExtraction in
    # backend/src/main.ts). A scoped run stamps nothing, so the mount still
    # reads as due a full run — see "Step selection" in that script.
    steps="${2:-}"
    [[ "$steps" =~ ^[a-z0-9,-]+$ ]] || die "usage: $0 step <step-id>[,<step-id>...]   e.g. $0 step viewmodel-anims"
    kc get deployment inventory-dev-backend >/dev/null 2>&1 || die "The dev backend is not installed yet. Run $0 first."
    # The backend's own run holds this lock; two runs over one mount is the
    # thing the shared mount must never see.
    if kc exec deployment/inventory-dev-backend -- test -e /cs2-models/extract.lock; then
      die "An extraction is running (or one was killed and left /cs2-models/extract.lock). Wait for it, then retry."
    fi
    say "Running step(s) $steps in the dev backend pod..."
    kc exec deployment/inventory-dev-backend -- env ONLY_STEPS="$steps" CS2_DIR=/cs2-game \
      OUT_DIR=/cs2-models WORK_DIR=/cs2-models/.work bash /app/scripts/extract-models.sh
    say "Done. Reload the page in Safari with Option+Command+R."
    exit 0
    ;;
  assets)
    case "${2:-}" in
      on | off) assets="$2" ;;
      *) die "usage: $0 assets on|off" ;;
    esac
    kc get ingress inventory-dev >/dev/null 2>&1 || die "The dev backend is not installed yet. Run $0 first."
    ;;
  *) die "usage: $0 [install|update|remove|assets on|off|step <id>]" ;;
esac
mode="${1:-install}"
# Where the dev host's asset paths go. A plain re-install keeps what is there,
# so `assets on` survives an update of the manifests; a first install is off.
if [[ -z "${assets:-}" ]]; then
  assets=off
  if kc get ingress inventory-dev -o jsonpath='{.spec.rules[0].http.paths[*].path}' 2>/dev/null |
    tr ' ' '\n' | grep -qx /models; then
    assets=on
  fi
fi

# ---- What the live backend runs with -------------------------------------------
# Read off the live DEPLOYMENT and INGRESS rather than guessed: kustomize
# suffixes the generated ConfigMap and Secret with a content hash, older
# generations can linger, and an install made by an older plugin.sh wires them
# differently (or not at all) — so every piece has a fallback.
ctr='.spec.template.spec.containers[0]'
cm=$(kc get deployment inventory-backend -o jsonpath="{$ctr.envFrom[*].configMapRef.name}" | awk '{print $1}')
sec=$(kc get deployment inventory-backend \
  -o jsonpath="{$ctr.env[?(@.name==\"DATABASE_URL\")].valueFrom.secretKeyRef.name}")
sec_key=$(kc get deployment inventory-backend \
  -o jsonpath="{$ctr.env[?(@.name==\"DATABASE_URL\")].valueFrom.secretKeyRef.key}")

# The live host, from the ingress that serves it.
live_domain=$(kc get ingress inventory-api -o jsonpath='{.spec.rules[0].host}' 2>/dev/null || true)
[[ -n "$live_domain" ]] ||
  live_domain=$(kc get ingress -o jsonpath='{range .items[*]}{.spec.rules[0].host}{"\n"}{end}' | grep -m1 '^inventory\.' || true)
[[ -n "$live_domain" || -n "${DOMAIN:-}" ]] ||
  die "Could not find the live plugin's host. Re-run with DOMAIN=inventory-dev.<your panel domain>."
# inventory.fulm.eu -> inventory-dev.fulm.eu. Override with DOMAIN=...
DOMAIN="${DOMAIN:-inventory-dev.${live_domain#*.}}"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# ---- The ingress, rendered the same way by an install and by `assets` --------
class=$(kc get ingress inventory-api -o jsonpath='{.spec.ingressClassName}' 2>/dev/null || true)
class="${class:-nginx}"
live_tls=$(kc get ingress inventory-api -o jsonpath='{.spec.tls[0].secretName}' 2>/dev/null || true)
render_ingress() {
  # #__TLS__: when the live plugin terminates TLS in the cluster, this host
  # needs a certificate too (made below, from the same issuer).
  # #__ASSETS__: with `assets on`, the mount-backed paths on this host go to the
  # dev backend's own asset routes. Prefix paths, so /models covers
  # /models/ak47.glb but not /modelsfoo; the longest match wins, so they beat `/`.
  sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__CLASS__|$class|" "$REPO_DIR/k8s/dev/ingress.yaml" |
    awk -v d="$DOMAIN" -v tls="$live_tls" -v assets="$assets" '
      /^[ \t]*#__TLS__[ \t]*$/ {
        if (tls != "") { print "  tls:"; print "    - hosts:"; print "        - " d; print "      secretName: inventory-dev-ssl" }
        next
      }
      /^[ \t]*#__ASSETS__[ \t]*$/ {
        if (assets == "on") {
          n = split("/models /paints /images /music /anims", p, " ")
          for (i = 1; i <= n; i++) {
            print "          - backend:"
            print "              service:"
            print "                name: inventory-dev-backend"
            print "                port:"
            print "                  number: 3000"
            print "            path: " p[i]
            print "            pathType: Prefix"
          }
        }
        next
      }
      { print }' >"$tmp/ingress.yaml"
}

if [[ "$mode" == assets ]]; then
  if [[ "$assets" == on ]]; then
    # Only a dev backend that has its asset routes can take these paths over: an
    # older one has no /anims route, so first person would stand still. A miss
    # tells them apart without needing any file to exist — the new route answers
    # one with Timing-Allow-Origin, and an old backend has no such route at all.
    say "Checking the dev backend can serve assets"
    kc exec deploy/inventory-dev-backend -- node -e '
      fetch("http://127.0.0.1:3000/anims/dev-backend-probe.json")
        .then((r) => process.exit(r.headers.get("timing-allow-origin") ? 0 : 1), () => process.exit(1))' ||
      die "This dev backend is too old to serve assets. Run '$0 update' once the dev-backend build is green, then '$0 assets on' again."
  fi
  render_ingress
  kc apply -f "$tmp/ingress.yaml"
  if [[ "$assets" == on ]]; then
    cat <<EOF

$DOMAIN now serves /models, /paints, /images, /music and /anims from the dev
backend: the same files off the same mount, with this fork's caching and
compression. The installed plugin is unchanged. Check it with:

  curl -sI -H 'Accept-Encoding: gzip' https://$DOMAIN/models/ak47.glb | grep -i -e content-encoding -e etag

(expect "content-encoding: gzip" and an etag). To go back: $0 assets off
EOF
  else
    say "Off: $DOMAIN gets its models, art and music from the installed frontend again."
  fi
  exit 0
fi

: >"$tmp/config.env"
if [[ -n "$cm" ]]; then
  say "Config (copied from $cm, INVENTORY_DOMAIN=$DOMAIN)"
  kc get configmap "$cm" -o go-template='{{range $k, $v := .data}}{{$k}}={{$v}}{{"\n"}}{{end}}' |
    grep -v '^INVENTORY_DOMAIN=' >"$tmp/config.env" || true
else
  # An older install with no ConfigMap: the backend's defaults already trust a
  # panel that is a parent domain of this host, which is the usual layout.
  say "Config (the live backend has none to copy; INVENTORY_DOMAIN=$DOMAIN)"
fi
echo "INVENTORY_DOMAIN=$DOMAIN" >>"$tmp/config.env"
kc create configmap inventory-dev-config --from-env-file="$tmp/config.env" --dry-run=client -o yaml | kc apply -f -

# The database connection: the live backend's own secret, or a value written
# straight into its deployment, or — as plugin.sh itself does — the panel's.
db=""
if [[ -n "$sec" ]]; then
  db=$(kc get secret "$sec" -o jsonpath="{.data.${sec_key:-DATABASE_URL}}" | base64 -d)
  src="secret $sec"
fi
if [[ -z "$db" ]]; then
  db=$(kc get deployment inventory-backend -o jsonpath="{$ctr.env[?(@.name==\"DATABASE_URL\")].value}")
  src="the live deployment"
fi
if [[ -z "$db" ]]; then
  panel_secret=$(kc get secret -o name | grep timescaledb-secrets | head -1 || true)
  [[ -n "$panel_secret" ]] &&
    db=$(kc get "$panel_secret" -o jsonpath='{.data.POSTGRES_CONNECTION_STRING}' | base64 -d)
  src="the panel's ${panel_secret#secret/}"
fi
if [[ -z "$db" ]]; then
  echo "The live backend's environment (names only):" >&2
  kc get deployment inventory-backend -o jsonpath="{range $ctr.env[*]}{.name}{' '}{end}{'\n'}" >&2 || true
  die "Could not find the database connection."
fi
say "Database connection (copied from $src)"
kc create secret generic inventory-dev-secrets --from-literal=DATABASE_URL="$db" --dry-run=client -o yaml |
  kc apply -f -

# ---- Manifests -----------------------------------------------------------------
sed -e "s|__IMAGE__|$IMAGE|" "$REPO_DIR/k8s/dev/backend.yaml" >"$tmp/backend.yaml"
render_ingress
if [[ "$assets" == on ]]; then
  say "Assets: /models, /paints, /images, /music, /anims from the dev backend (assets on)"
fi

if [[ -n "$live_tls" ]]; then
  # The live plugin terminates TLS in the cluster, so this host needs a
  # certificate too — from the same issuer as the live one.
  issuer=$(kc get certificate inventory-ssl -o jsonpath='{.spec.issuerRef.name}' 2>/dev/null || true)
  issuer_kind=$(kc get certificate inventory-ssl -o jsonpath='{.spec.issuerRef.kind}' 2>/dev/null || true)
  sed -e "s|__DOMAIN__|$DOMAIN|" -e "s|__ISSUER__|${issuer:-5stack-issuer}|" \
    -e "s|__ISSUER_KIND__|${issuer_kind:-Issuer}|" "$REPO_DIR/k8s/dev/certificate.yaml" >"$tmp/certificate.yaml"
  say "TLS: in-cluster (certificate from ${issuer:-5stack-issuer})"
else
  say "TLS: terminated in front of the cluster (Cloudflare / reverse proxy), no certificate"
fi

# The dev backend is pinned like the live one, to the node plugin.sh labels —
# where the models mount and the CS2 install are. An older install may predate
# the label; then the node the live backend runs on is the one that has them.
if [[ -z "$(kubectl get nodes -l 5stack-inventory=true -o name 2>/dev/null)" ]]; then
  node=$(kc get pods -l app=inventory-backend -o jsonpath='{.items[0].spec.nodeName}' 2>/dev/null || true)
  [[ -n "$node" ]] || die "No node is labeled 5stack-inventory=true and the live backend has no running pod to copy one from."
  say "Labeling $node 5stack-inventory=true (the node the live backend runs on)"
  kubectl label node "$node" 5stack-inventory=true --overwrite
fi

say "Applying"
kc apply -f "$tmp/backend.yaml"
[[ -f "$tmp/certificate.yaml" ]] && kc apply -f "$tmp/certificate.yaml"
kc apply -f "$tmp/ingress.yaml"

# A re-run should land on the newest :dev, and apply alone does not re-pull an
# unchanged tag.
kc rollout restart deployment/inventory-dev-backend >/dev/null
say "Waiting for inventory-dev-backend (first start applies the schema; it is the same one)"
if ! kc rollout status deployment/inventory-dev-backend --timeout=300s; then
  kc get pods -l app=inventory-dev-backend -o wide || true
  echo
  echo "If the pod shows ErrImagePull / ImagePullBackOff, the image is private:"
  echo "  github.com/LCrew -> Packages -> 5stack-inventory-plugin-backend -> Package settings ->"
  echo "  Change visibility -> Public. Then: ./scripts/dev-backend.sh update"
  echo "Otherwise: kubectl -n $NS logs deploy/inventory-dev-backend"
  exit 1
fi

cat <<EOF

Dev backend is running.

1. DNS: point $DOMAIN at the same place as $live_domain
   (Cloudflare: a record like the live one; a Cloudflare Tunnel: add it as a
   public hostname to the same service as $live_domain).
$([[ -n "$live_tls" ]] && echo "   Then wait for the certificate:  kubectl -n $NS get certificate inventory-dev-ssl -w")
2. Check it answers:  curl -s https://$DOMAIN/api/catalog | head -c 200
3. Point the dev copy at it: GitHub repo variable INVENTORY_API = https://$DOMAIN,
   then re-run the dev-plugin workflow (docs/DEV-PLUGIN.md).
EOF
