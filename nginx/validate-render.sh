#!/bin/sh
set -eu

fail() {
    printf '%s\n' "$1" >&2
    exit 1
}

validate_port() {
    case "$2" in
        ''|*[!0-9]*) fail "$1 must specify a numeric port." ;;
    esac
    if [ "${#2}" -gt 5 ] || [ "$2" -lt 1 ] || [ "$2" -gt 65535 ]; then
        fail "$1 must specify a port from 1 to 65535."
    fi
}

validate_upstream() {
    case "$2" in
        *:*) ;;
        *) fail "$1 must be a Render private service address in host:port form." ;;
    esac
    case "${2%:*}" in
        ''|*[!a-zA-Z0-9.-]*) fail "$1 must specify a valid hostname." ;;
    esac
    validate_port "$1" "${2##*:}"
}

write_trusted_proxies() {
    cidrs=${RENDER_TRUSTED_PROXY_CIDRS:-}
    case "$cidrs" in
        ,*|*,|*,,*) fail 'RENDER_TRUSTED_PROXY_CIDRS must be a comma-separated list of CIDRs.' ;;
    esac

    while [ -n "$cidrs" ]; do
        cidr=${cidrs%%,*}
        network=${cidr%/*}
        prefix=${cidr##*/}
        case "$network" in
            ''|*[!0-9a-fA-F.:]*) fail 'Each trusted proxy must be an IPv4 or IPv6 CIDR.' ;;
            *:*) max_prefix=128 ;;
            *.*) max_prefix=32 ;;
            *) fail 'Each trusted proxy must be an IPv4 or IPv6 CIDR.' ;;
        esac
        case "$prefix" in
            ''|*[!0-9]*) fail 'Each trusted proxy must specify a numeric CIDR prefix.' ;;
        esac
        if [ "${#prefix}" -gt 3 ] || [ "$prefix" -lt 1 ] || [ "$prefix" -gt "$max_prefix" ]; then
            fail 'Trusted proxy prefixes must be within their address range and greater than zero.'
        fi
        printf 'set_real_ip_from %s;\n' "$cidr"

        case "$cidrs" in
            *,*) cidrs=${cidrs#*,} ;;
            *) break ;;
        esac
    done
}

validate_port PORT "${PORT:-}"
validate_upstream RENDER_AUTH_HOSTPORT "${RENDER_AUTH_HOSTPORT:-}"
validate_upstream RENDER_GAME_HOSTPORT "${RENDER_GAME_HOSTPORT:-}"
[ -n "${NGINX_LOCAL_RESOLVERS:-}" ] || fail 'No DNS resolver was detected.'
write_trusted_proxies > /etc/nginx/render-trusted-proxies.conf
