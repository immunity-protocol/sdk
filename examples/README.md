# Examples

Three minimal, single-concept agents. Each runs against the live 0G Galileo testnet and an externally-managed AXL node.

## Setup

```sh
# 1. Install deps with the legacy resolver (0G storage SDK pins ethers exactly).
npm install --legacy-peer-deps

# 2. Bring up a local AXL mesh. See infra/axl-mesh/README.md for details.
docker compose -f infra/axl-mesh/compose.yml up -d

# 3. Configure env.
cat > .env <<EOF
WALLET_PRIVATE_KEY=0x...   # Galileo testnet wallet with some 0G + (will mint USDC)
AXL_URL=http://localhost:9002
EOF
```

## basic-agent.ts

Gates an outbound transaction with `Immunity.check()`. Demonstrates: lifecycle (`start`/`stop`), prepaid funding, the three decisions returned by `check()`.

```sh
node --import tsx examples/basic-agent.ts
```

## publisher.ts

Mints an ADDRESS antibody for a known-bad target. Demonstrates: `Immunity.publish()`, on-chain stake, gossip propagation to peers, `publisherStats()`.

```sh
node --import tsx examples/publisher.ts
```

## escalation.ts

Hooks an `onEscalate` handler that asks the operator (via stdin in the demo) before allowing a SUSPICIOUS action. Demonstrates: human-in-the-loop wiring, escalation timeout, `onTimeout` policy.

```sh
node --import tsx examples/escalation.ts
```

## Running against a fresh testnet wallet

The examples auto-mint MockUSDC from the deployed faucet contract on first run. They still need a small 0G balance for native gas. Use the Google Cloud testnet faucet:

  https://cloud.google.com/application/web3/faucet/0g/galileo

0.1 0G/day per wallet covers all three examples.
