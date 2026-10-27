# ChainPilot

A modular BNB Chain assistant. **Position Guard** is the first working module: read a Venus isolated-pool position, detect elevated liquidation risk, and repay debt from a user-funded reserve with limits enforced by a contract.

**Development release · BSC testnet only · Not audited.** Local acceptance covers signed enrollment and subscription-gated execution, plus supply, borrowing and repayment against real Venus contracts on a local testnet fork. Read-only checks also pass against the deployed Venus testnet contracts. The live Cloudflare service is registered as ERC-8004 agent **2677** on BNB testnet, with its service wallet bound and execution enabled. Pokter’s fresh compatibility check passed on October 27, 2026; its catalogue may still show an older quote measurement. A complete funded hire, delivery and settlement have not yet been verified. The Position Guard factory and repayment vaults are not deployed. Local transactions are not campaign evidence.

## Run it

Requirements: Node 22+; Foundry 1.5.1 with Solidity 0.8.28 for contract builds/tests.

```sh
nvm use
npm ci
npm test
npm run contracts:test
npm run contracts:build
npm run test:e2e
npm run check:live
npm start
```

Open **http://localhost:3001**. Analyze the registered campaign wallet without connecting or signing. The default read is live, not a sample dataset. This wallet currently has no position in the selected testnet pool.

For configured operation:

```sh
cp .env.example .env
node --env-file=.env src/server.js
# A second process, on the same host and persistent data volume:
npm run worker
```

In the Node deployment, the web server never signs transactions. Its separate worker defaults to monitor-only and requires an explicit execution setting, verified vault provenance, active paid subscription, and a separate keeper key file before signing anything. Use one worker per keeper. Do not use the campaign owner's private key as the keeper key.

## What works

- Live position accounting at one pinned block, using liquidation thresholds rather than borrowing collateral factors. Results must match Venus's own liquidation liquidity.
- Repayment planning with exact integer arithmetic and token decimal conversion. The chosen testnet USDT token has **6 decimals**, unlike some mainnet tokens with the same ticker.
- A single-market vault that permits only debt repayment for its owner. It enforces funding, per-action cap, expiry, cooldown, pause, and measurable health-factor improvement; it resets the market allowance after use.
- A factory proving which vaults were created from this code. The worker rejects arbitrary vault addresses.
- Owner-signed enrollment tied to service origin, chain, vault, subscription ID, target health factor and expiry.
- HelloFugu subscription verification directly from contracts, including cancellation and expiry. A listed name or a payment screenshot does not authorize service.
- Worker simulation, gas ceiling, two-confirmation receipts, pending-transaction reconciliation, and durable observation logs. Errors fail closed.
- Callable MCP tools, A2A messages, ERC-8004 registration metadata, a wallet-driven setup dashboard, and an evidence checklist.

The decision engine is deterministic. There is no LLM in the transaction authorization path. Portfolio Watch, Yield Watch and Rebalancing are roadmap ideas, not implemented modules.

## Verified network profile

Only **Venus isolated pools on BSC testnet, chain 97**, are configured. This is not a Venus Core adapter. Changing only the RPC cannot enable mainnet.

| Contract | Address |
| --- | --- |
| DeFi Comptroller | `0x23a73971A6B9f6580c048B9CB188869B2A2aA2aD` |
| vUSDT DeFi market | `0x80CC30811e362aC9aB857C3d7875CbcCc0b65750` |
| USDT underlying, read from market | `0xA11c8D9DC9b66E209Ef60F0C8D969D3CD988782c` |
| ERC-8004 IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` |
| HelloFugu listing registry | `0xb2f36070E6eae3353E8e755172B477DF213ae248` |
| HelloFugu subscription | `0xfdb083371f44Cf53181350389D3217e51B431776` |

Venus source/deployment reference: [943e7db](https://github.com/VenusProtocol/isolated-pools/tree/943e7db1855c8ab4a09104f1d09e2b2db0506b95). HelloFugu interface reference: [52b3e89](https://github.com/Lexirieru/fugugent/tree/52b3e89b94d18e4bf6a5ec84a9c925255294f478). Integrations use their public interfaces; this agent is an original implementation, not a fork of their agents. Dependencies are pinned in package-lock.json.

Testnet oracle prices and token balances are development data and must not be treated as mainnet economic values. The reader uses stored interest; execution accrues all entered markets before checking risk again. A cap-limited payment may improve health without reaching the requested target. No swaps, borrowing, collateral withdrawals, native-BNB repayments or guarantees against liquidation are supported.

## Deployment and onboarding

1. Host the Node service at a stable HTTPS origin and set `PUBLIC_URL`. Use persistent storage for `DATA_DIR`; an ephemeral filesystem can lose enrollments and receipt state. A Dockerfile is included. `RUN_WORKER=true` runs HTTP and the worker under a common supervisor; mount the persistent data directory and the keeper secret file. No secret belongs in the image.
2. Use a dedicated keeper address and configure `KEEPER_ADDRESS`. It needs testnet gas only. Keep the secret in the host's secret manager or a permission-restricted mounted file, referenced by `KEEPER_KEY_FILE`.
3. As the campaign wallet, use Operator setup to deploy the factory. This creates a contract but does not fund a reserve. Set the resulting `FACTORY_ADDRESS` on the host. Verify its controller/market and publish it below.
4. Check the service externally at `/health`, `/.well-known/agent-card.json`, `/registration.json` and `/mcp`. Configure the worker and inspect its heartbeat before advertising automatic execution.
5. As the campaign wallet, register the ERC-8004 identity pointing to the HTTPS `/registration.json`. Set the actual `AGENT_ID` and publish it here. Never register the same agent under multiple IDs.
6. Set an explicit service price/duration, then list on HelloFugu from the same owner wallet. Set `LISTING_ID` and publish the listing URL here. HelloFugu's own `/list` flow is also supported, using the public agent card endpoint and this repository.
7. A real user hires the listing, creates their repayment vault, approves a specific reserve amount, funds it, and signs enrollment with the subscription ID. They must already have a supported Venus borrowing position; setup does not fabricate a position or borrow for them.
8. Run the worker with `EXECUTION_ENABLED=false` first. Inspect its decisions. Enable execution only after the user has reviewed the vault permissions, budget, expiry and asset. Keep monitoring uptime and balances.
9. Users can pause their vault or withdraw unused reserve directly, without the agent's cooperation. Subscription cancellation/expiry stops the worker from taking new actions but does not pause the vault onchain: use its pause control to revoke keeper execution immediately. A keeper already authorized onchain can call within the vault limits until paused or expired.

Keep keys out of chat, command arguments, source, logs and GitHub. The registered campaign wallet remains the identity owner. A separate keeper is the service's execution key, not a second campaign participant.

## Campaign identity and remaining requirements

| Field | Status |
| --- | --- |
| Agent name / category | ChainPilot / Health factor |
| Public repository | https://github.com/mana-devs/chainpilot |
| Campaign registration | Submitted through Google Forms on October 27, 2026 |
| Campaign owner | `0xf5506B65e71601991895cD40bD2E875F29cca0da` |
| Identity network | BSC testnet, chain 97 |
| Registry ID | **2677** on the ERC-8004 IdentityRegistry, BSC testnet (chain 97), owned by the campaign owner above |
| Service wallet | `0x49aE851687Cc05d8e2CC32C5a7bA9bF0e8C14040`, bound to the identity; testnet gas funded |
| Position Guard factory | **Not deployed** |
| Public endpoint | https://chainpilot.cryptonaito.workers.dev — Cloudflare Free, persistent SQLite Durable Object and scheduled worker |
| Marketplace listing | [Pokter agent 2677](https://pokter.xyz/agents/97/2677); fresh compatibility checks pass, catalogue sweep may lag; no completed hire verified |
| Three independent completed hires | **Pending real users and organizer review** |
| Five onchain actions across three days | **Pending real category-consistent activity** |
| Participant's three different-agent hires across two marketplaces | **Pending separate hires** |

The campaign deadline is **November 5, 2026 at 12:00 UTC (1:00 p.m. Lagos)**. Budget at least three separate days for genuine execution. Do not schedule unnecessary transactions merely to fill the quota, hire from wallets you control or fund, or treat multiple registrations as multiple agents.

`GET /v1/campaign` exposes these checks without marking the overall campaign complete. `POST /v1/evidence/repayment` verifies successful keeper transactions, vault provenance, repayment events, confirmations and UTC dates; hashes are deduplicated. Completed paid subscriptions with recorded service are candidate hire evidence, not proof of independent funding. Final eligibility, originality, independence and prize allocation remain the organizer's decision.

## API

| Route | Purpose |
| --- | --- |
| `GET /health` | HTTP availability and recent worker heartbeat |
| `GET /.well-known/agent-card.json` | A2A capability card |
| `GET /registration.json` | ERC-8004 registration file |
| `POST /v1/position` | `{ "borrower": "0x..." }` live Venus read |
| `POST /v1/vault` | `{ "vault": "0x...", "targetBps": 15000 }` inspection |
| `POST /v1/enrollment-message` | Prepare a short-lived enrollment message |
| `POST /v1/enroll` | Verify signature, subscription and vault; persist enrollment |
| `POST /v1/transactions/prepare` | Prepare supported unsigned wallet transactions |
| `POST /v1/evidence/repayment` | `{ "hash": "0x..." }` verify a repayment receipt |
| `GET /v1/campaign` | Evidence and outstanding requirements |
| `POST /mcp` | Stateless MCP JSON-RPC: initialize, tools/list, tools/call |
| `POST /a2a` | A2A message/send; Cloudflare also supports `negotiate`, `notify_funded`, and `preview` |

The Node runtime exposes MCP tools `analyze_position`, `inspect_vault`, and `campaign_status`; the Cloudflare runtime exposes `analyze_position`. The Node HTTP server does not sign transactions. With execution enabled, the Cloudflare runtime signs constrained Pokter quotes and submits/settles verified funded jobs using its dedicated service wallet. Operator registration, wallet binding, vault creation and reserve funding are prepared unsigned for the user’s browser wallet. Smart-contract-wallet enrollment signatures (ERC-1271) are not implemented; this release supports EOA owners.

## Checks and evidence

- `npm test`: planner, decimal conversion, stale data, state storage, HTTP/MCP metadata, validation and origin handling.
- `forge test -vv`: authorization, risk limits, protocol failures, cooldown, expiry, withdrawal and fuzzed reserve accounting.
- `npm run test:e2e`: isolated local Anvil chain, deployment, signed enrollment, worker execution, receipt, cancellation and unauthorized-withdrawal rejection. **Never a public campaign transaction.**
- `npm run check:live`: read-only RPC compatibility report in ignored `artifacts/live-check.json`.
- `RUN_VENUS_FORK=true forge test --match-contract VenusForkTest -vv`: real Venus contract acceptance on a local fork. Supplies and borrows in the configured DeFi market, funds a reserve, and confirms repayment improves health factor and clears allowance. Never broadcasts. Skipped in ordinary offline tests.

For Render, use the [launch runbook](docs/RENDER-LAUNCH.md). Optional persistent keeper bootstrap creates an operational key on the host without exposing it to chat or source control.

Tests do not constitute a security audit. Public-protocol repayment execution and real marketplace subscription completion still require an onchain acceptance run after deployment.

[Official campaign rules](https://www.bnbchain.org/en/hackathons/smart-money-era-set-and-earn) · [HelloFugu listing](https://app.hellofugu.xyz/list)

## Free Cloudflare hosting and Pokter

The Cloudflare runtime uses SQLite-backed Durable Objects for durable state and scheduled work. See [Cloudflare launch instructions](docs/CLOUDFLARE-LAUNCH.md) for deployment, service-wallet binding and the Pokter escrow flow. The checked-in deployment now enables execution for the existing configured testnet service. For a new deployment, set `EXECUTION_ENABLED=false` until identity, wallet binding and gas funding are complete. Fresh external Pokter compatibility checks pass; a complete public testnet hire remains required. A brief that names no borrower is priced for a report on the eventual hiring wallet. A Pokter risk-report hire does not activate HelloFugu vault subscriptions.

`npm run test:cloud` explicitly overrides execution to false in its temporary local runtime, so CI remains isolated from the live execution setting.
