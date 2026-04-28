#!/usr/bin/env bash
# Bring up two AXL spokes for the integration tests. The two spokes peer
# with the deployed team hubs (yyz + ewr) AND directly with each other,
# which works around the cold-start gossip propagation gap documented in
# CHALLENGES.md. See FEEDBACK.md for the upstream feature request that
# would remove the need for the direct peer link.
#
# Usage:
#   bash test/fixtures/axl-test-mesh/up.sh
#
# Then run integration tests with:
#   AXL_URL_PUBLISHER=http://localhost:9002 \
#   AXL_URL_SUBSCRIBER=http://localhost:9012 \
#   AXL_IDENTITY_PUBLISHER=/tmp/immunity-spoke-test/spoke1.pem \
#   AXL_IDENTITY_SUBSCRIBER=/tmp/immunity-spoke-test/spoke2.pem \
#   npx vitest run --config vitest.integration.config.ts

set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKDIR="${WORKDIR:-/tmp/immunity-spoke-test}"
mkdir -p "$WORKDIR"

echo "removing any existing test spokes..."
docker rm -f immunity-spoke-test immunity-spoke-test-2 2>/dev/null || true

echo "starting spoke 1 (listens on 9101 host -> 9001 container, API on 9002)..."
docker run -d --name immunity-spoke-test \
  -p 127.0.0.1:9002:9002 \
  -p 127.0.0.1:9101:9001 \
  -v "$FIXTURE_DIR/spoke1.json:/etc/axl/spoke.json:ro" \
  -v immunity-spoke-test-data:/data \
  -e AXL_CONFIG=/etc/axl/spoke.json \
  local/axl-hub:test > /dev/null

echo "starting spoke 2 (dials hubs + spoke1 via host.docker.internal:9101)..."
docker run -d --name immunity-spoke-test-2 \
  -p 127.0.0.1:9012:9002 \
  -v "$FIXTURE_DIR/spoke2.json:/etc/axl/spoke.json:ro" \
  -v immunity-spoke-test-2-data:/data \
  -e AXL_CONFIG=/etc/axl/spoke.json \
  --add-host=host.docker.internal:host-gateway \
  local/axl-hub:test > /dev/null

echo "waiting 8s for handshake + sub_ad propagation..."
sleep 8

# Pull each spoke's PEM out of its container so the SDK's gossip layer can
# reuse the daemon's identity (avoids the gossip-client / daemon identity
# split that pre-0.1.1 axl-pubsub couldn't tolerate).
docker cp immunity-spoke-test:/data/private.pem "$WORKDIR/spoke1.pem"
docker cp immunity-spoke-test-2:/data/private.pem "$WORKDIR/spoke2.pem"
chmod 600 "$WORKDIR"/spoke?.pem

echo
echo "spoke 1 topology:"
curl -s http://localhost:9002/topology | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  self:', d['our_public_key'][:16])
print('  peers:')
for p in d['peers']:
    print(f'   {p[\"public_key\"][:16]}  inbound={p.get(\"inbound\")}  up={p[\"up\"]}')
"
echo "spoke 2 topology:"
curl -s http://localhost:9012/topology | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('  self:', d['our_public_key'][:16])
print('  peers:')
for p in d['peers']:
    print(f'   {p[\"public_key\"][:16]}  inbound={p.get(\"inbound\")}  up={p[\"up\"]}')
"

echo
echo "ready. exports for the integration tests:"
echo "  export AXL_URL_PUBLISHER=http://localhost:9002"
echo "  export AXL_URL_SUBSCRIBER=http://localhost:9012"
echo "  export AXL_IDENTITY_PUBLISHER=$WORKDIR/spoke1.pem"
echo "  export AXL_IDENTITY_SUBSCRIBER=$WORKDIR/spoke2.pem"
