#!/bin/sh
set -eu
umask 077

valid_password() {
    case "$1" in
        *[!A-Za-z0-9_+/=-]*) return 1 ;;
    esac
    [ "${#1}" -ge 32 ] && [ "${#1}" -le 128 ]
}

writer=${REVOCATIONS_WRITER_PASSWORD:-}
reader=${REVOCATIONS_READER_PASSWORD:-}
if ! valid_password "$writer" || ! valid_password "$reader" || [ "$writer" = "$reader" ]; then
    echo 'Set distinct generated revocation-store passwords for the writer and reader.' >&2
    exit 1
fi

writer_hash=$(printf '%s' "$writer" | sha256sum)
reader_hash=$(printf '%s' "$reader" | sha256sum)
acl=$(mktemp /tmp/amazegame-valkey.XXXXXX)
cat > "$acl" <<EOF
user default off resetpass -@all
user writer on #${writer_hash%% *} -@all +ping +client|setinfo +waitaof (+zadd +zremrangebyscore ~amazegame:revocations:v1) (+set ~amazegame:revocation-sync:v1)
user reader on #${reader_hash%% *} -@all +ping +client|setinfo +zrangebyscore %R~amazegame:revocations:v1
EOF
chown valkey:valkey "$acl"
unset REVOCATIONS_WRITER_PASSWORD REVOCATIONS_READER_PASSWORD writer reader

exec docker-entrypoint.sh valkey-server --port 6379 --bind 0.0.0.0 \
    --protected-mode yes --aclfile "$acl" --dir /data \
    --appendonly yes --appendfsync everysec --maxmemory 128mb --maxmemory-policy noeviction
