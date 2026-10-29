#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Avvio del broker con validazione bloccante della configurazione.
#
# In produzione (MQTT_REQUIRE_AUTH=true) il container NON parte se:
#   - `allow_anonymous true` compare nel file di configurazione;
#   - `password_file` o `acl_file` mancano o non sono leggibili;
#   - il file delle password è vuoto (nessuna utenza provisionata).
#
# MQTT_VALIDATE_ONLY=true esegue solo i controlli (usato da CI e dal provisioning).
# ─────────────────────────────────────────────────────────────────────────────

set -eu

CONFIG="${MQTT_CONFIG:-/mosquitto/config/mosquitto.prod.conf}"
REQUIRE_AUTH="${MQTT_REQUIRE_AUTH:-true}"

fail() {
  echo "[mosquitto-entrypoint] ERRORE: $*" >&2
  exit 1
}

config_value() {
  # Prima occorrenza di `<chiave> <valore>`, ignorando righe commentate.
  awk -v key="$1" '$1 == key { print $2; exit }' "$CONFIG"
}

[ -f "$CONFIG" ] || fail "configurazione non trovata: $CONFIG"

if [ "$REQUIRE_AUTH" = "true" ]; then
  if grep -Eq '^[[:space:]]*allow_anonymous[[:space:]]+true' "$CONFIG"; then
    fail "allow_anonymous true non è ammesso in produzione ($CONFIG)"
  fi

  grep -Eq '^[[:space:]]*allow_anonymous[[:space:]]+false' "$CONFIG" ||
    fail "allow_anonymous false mancante ($CONFIG)"

  password_file="$(config_value password_file)"
  acl_file="$(config_value acl_file)"

  [ -n "$password_file" ] || fail "password_file non configurato ($CONFIG)"
  [ -n "$acl_file" ] || fail "acl_file non configurato ($CONFIG)"
  [ -s "$password_file" ] ||
    fail "password_file vuoto o assente: $password_file (esegui tools/init-mqtt-auth.sh)"
  [ -r "$acl_file" ] || fail "acl_file non leggibile: $acl_file"

  # Mosquitto gira come utente `mosquitto`: un file 0600 di un altro uid
  # supererebbe il controllo come root ma farebbe fallire l'avvio dopo il drop.
  if command -v su >/dev/null 2>&1 && id mosquitto >/dev/null 2>&1; then
    su -s /bin/sh mosquitto -c "test -r '$password_file'" ||
      fail "password_file non leggibile dall'utente mosquitto: $password_file (chmod 644)"
  fi

  echo "[mosquitto-entrypoint] configurazione verificata: $CONFIG (auth obbligatoria)"
else
  echo "[mosquitto-entrypoint] ATTENZIONE: MQTT_REQUIRE_AUTH=$REQUIRE_AUTH · avvio senza verifica auth ($CONFIG)"
fi

if [ "${MQTT_VALIDATE_ONLY:-false}" = "true" ]; then
  echo "[mosquitto-entrypoint] sola validazione, nessun avvio"
  exit 0
fi

mkdir -p /mosquitto/data
# Il volume dati deve restare scrivibile dall'utente con cui gira il broker.
chown mosquitto:mosquitto /mosquitto/data 2>/dev/null || true

exec /usr/sbin/mosquitto -c "$CONFIG"
