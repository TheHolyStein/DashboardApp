# Test container for the deploy scripts. Build from the repository root:
#   docker build -f deploy/test/Dockerfile -t dashboard-deploy-test .
#   docker run --rm dashboard-deploy-test
FROM debian:stable-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bats bash git sqlite3 caddy ufw openssh-server systemd \
      curl ca-certificates gnupg iproute2 util-linux sudo \
 && rm -rf /var/lib/apt/lists/*

COPY deploy /src/deploy
WORKDIR /src
# Runs as root: the tests create a system user and chown inside a fake root.
CMD ["bats", "/src/deploy/test"]
