#!/usr/bin/env bash
#
# Provisioning delle utenze del broker Mosquitto di produzione.
#
# Crea mosquitto/auth/passwd con hash PBKDF2 (sha512) per:
#   - wallos_backend    readwrite su tutti i topic (rule engine/automazioni)
#   - wallos_kiosk      sola lettura degli stati + scrittura dei comandi
#   - wallos_simulator  opzionale, solo ambienti di test
#
# Le password NON sono versionate: arrivano da variabili d'ambiente (o prompt
# interattivo) e finiscono solo nel file hash. Rigenerare lo script ruota tutte
# le credenziali: aggiorna .env e riavvia i container dopo ogni rotazione.
#
# Uso:
#   MOSQUITTO_BACKEND_PASSWORD='...' MOSQUITTO_KIOSK_PASSWORD='...' \
#     ./tools/init-mqtt-auth.sh
#
# Richiede `mosquitto_passwd` (pacchetto mosquitto-clients) oppure Docker, che
# usa l'immagine eclipse-mosquitto:2 già impiegata dallo stack.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AUTH_DIR="${MOSQUITTO_AUTH_DIR:-$ROOT_DIR/mosquitto/auth}"
PASSWD_FILE="$AUTH_DIR/passwd"
TMP_NAME=".passwd.tmp"
MIN_LENGTH=16

BACKEND_USER="${MOSQUITTO_BACKEND_USERNAME:-wallos_backend}"
KIOSK_USER="${MOSQUITTO_KIOSK_USERNAME:-wallos_kiosk}"
SIM_USER="${MOSQUITTO_SIM_USERNAME:-wallos_simulator}"

info() { printf '  %s\n' "$*"; }
die() { printf 'Errore: %s\n' "$*" >&2; exit 1; }

cleanup() { rm -f "$AUTH_DIR/$TMP_NAME"; }
trap cleanup EXIT

is_placeholder() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    '' | password | password123 | change-me | changeme | wallos | domus | admin | kiosk | secret)
      return 0
      ;;
  esac
  return 1
}

prompt_secret() {
  local label="$1" value=''
  if [ -t 0 ]; then
    read -r -s -p "$label: " value
    printf '\n' >&2
  fi
  printf '%s' "$value"
}

require_secret() {
  local label="$1" env_name="$2" value="${!2:-}"

  if [ -z "$value" ]; then
    value="$(prompt_secret "$label")"
  fi
  [ -n "$value" ] || die "imposta $env_name (nessun input interattivo disponibile)"
  [ "${#value}" -ge "$MIN_LENGTH" ] ||
    die "$env_name troppo corta: minimo $MIN_LENGTH caratteri"
  is_placeholder "$value" && die "$env_name è un valore di default: scegline una diversa"

  printf '%s' "$value"
}

BACKEND_PASSWORD="$(require_secret "Password per $BACKEND_USER" MOSQUITTO_BACKEND_PASSWORD)"
KIOSK_PASSWORD="$(require_secret "Password per $KIOSK_USER" MOSQUITTO_KIOSK_PASSWORD)"
[ "$BACKEND_PASSWORD" != "$KIOSK_PASSWORD" ] ||
  die 'backend e kiosk devono avere password diverse (least privilege)'

SIM_PASSWORD="${MOSQUITTO_SIM_PASSWORD:-}"
if [ -n "$SIM_PASSWORD" ]; then
  [ "${#SIM_PASSWORD}" -ge "$MIN_LENGTH" ] ||
    die "MOSQUITTO_SIM_PASSWORD troppo corta: minimo $MIN_LENGTH caratteri"
fi

if command -v mosquitto_passwd >/dev/null 2>&1; then
  run_passwd() { mosquitto_passwd "$@"; }
elif command -v docker >/dev/null 2>&1; then
  # Percorsi relativi a /auth: funziona anche da Windows/Git Bash.
  run_passwd() { docker run --rm -v "$AUTH_DIR:/auth" -w /auth eclipse-mosquitto:2 mosquitto_passwd "$@"; }
else
  die 'mosquitto_passwd non trovato: installa mosquitto-clients oppure Docker'
fi

mkdir -p "$AUTH_DIR"

printf 'Generazione credenziali broker in %s\n' "$PASSWD_FILE"

# Il file viene costruito a parte e sostituito solo alla fine: un errore a metà
# non lascia il broker senza password valide.
(
  cd "$AUTH_DIR"
  run_passwd -c -B -b "$TMP_NAME" "$BACKEND_USER" "$BACKEND_PASSWORD"
  run_passwd -B -b "$TMP_NAME" "$KIOSK_USER" "$KIOSK_PASSWORD"
  if [ -n "$SIM_PASSWORD" ]; then
    run_passwd -B -b "$TMP_NAME" "$SIM_USER" "$SIM_PASSWORD"
  fi
)

# 0644: il processo mosquitto nel container gira con un uid diverso da quello
# dell'host e deve poter leggere il file. Contiene solo hash PBKDF2, mai il
# testo in chiaro, ed è escluso dal versionamento (.gitignore).
chmod 644 "$AUTH_DIR/$TMP_NAME"
mv "$AUTH_DIR/$TMP_NAME" "$PASSWD_FILE"

printf '\nUtenze provisionate (%s):\n' "$PASSWD_FILE"
info "$BACKEND_USER  readwrite #"
info "$KIOSK_USER    lettura stati, scrittura solo topic di comando"
if [ -n "$SIM_PASSWORD" ]; then info "$SIM_USER  telemetria di test"; fi

cat <<'EOF'

Prossimi passi:
  1. Build del pannello (solo parametri PUBBLICI, nessun segreto):
       VITE_MQTT_HOST=<IP LAN del broker>
       VITE_MQTT_PORT=9001
       VITE_MQTT_PATH=/mqtt
  2. Sul pannello: Impostazioni -> broker, utente wallos_kiosk e la password
     appena generata. Resta nel persist locale: non va mai nella build.
  3. Compose (.env del server, mai con prefisso VITE_):
       MOSQUITTO_BACKEND_USERNAME=wallos_backend
       MOSQUITTO_BACKEND_PASSWORD=<password backend>
       MOSQUITTO_BIND_IP=<IP LAN autorizzato>
  4. docker compose --profile prod up -d --build
  5. node tools/mqtt-auth-check.mjs   (verifica ACL e blocco anonimo)
  6. npm run verify:build-secrets    (controllo extra su dist/; gia' in build)
EOF
