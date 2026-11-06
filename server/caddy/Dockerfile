# Caddy with the rate-limit module (the stock image has none). Versions are pinned; bump them on purpose.
FROM caddy:2.8.4-builder AS build
RUN xcaddy build --with github.com/mholt/caddy-ratelimit

FROM caddy:2.8.4
COPY --from=build /usr/bin/caddy /usr/bin/caddy
