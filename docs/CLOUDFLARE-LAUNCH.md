# ChainPilot on Cloudflare Free and Pokter

The Cloudflare runtime serves the dashboard and anonymous A2A/MCP discovery through a Worker. One SQLite-backed Durable Object serializes jobs, stores its service key and immutable delivery bytes, and runs one-minute alarms. A five-minute cron restarts alarms after an outage. This replaces the Node filesystem store for this deployment; D1 is not required.

## Cost and scope

Stay on Workers Free. No domain or card is needed. Free quotas are hard limits; exceeding them can interrupt the agent. This is a small testnet deployment, not an uptime or liquidation-protection guarantee. Do not delete the Durable Object namespace: its stored service wallet and receipts would be lost. Do not fund this wallet with mainnet assets. Source and compiled public assets are uploaded to the user's Cloudflare account; borrower requests, quotes and public reports are processed there. No campaign-wallet private key is requested or stored.

## Deploy

Use Node 22 and the pinned Wrangler dependency:

```sh
npm ci
npm test
npm run cloud:check
npm run test:cloud
npx wrangler login --scopes account:read user:read workers:write workers_scripts:write workers_tail:read
npm run cloud:deploy
```

For a new deployment, set `EXECUTION_ENABLED=false` before deploying. The checked-in configuration currently enables execution for the existing configured ChainPilot service. Analysis and discovery work, but paid quotes decline until the identity is configured and execution is explicitly enabled. The service generates its own testnet wallet in private Durable Object storage. Only its address is returned by `/health` and `/v1/config`. No endpoint exports its key or accepts arbitrary signing requests.

## Operator sequence

1. Open the deployment's dashboard. Confirm BNB testnet (97), the expected campaign wallet and the reported service-wallet address.
2. Register the ERC-8004 identity using the campaign wallet. Its URI must be this deployment's `/registration.json`.
3. Enter the returned ID under **Cloudflare operator configuration** and sign **Save configuration**. The signed message binds the origin, chain, ID, optional factory and short expiry; the server verifies identity ownership onchain.
4. Click **Bind service wallet to identity** and review the registry transaction in the campaign wallet. This sets `agentWallet` after the service wallet supplies an EIP-712 proof. It does not transfer ownership of the identity.
5. Fund the service wallet with a small amount of **testnet BNB only** for delivery/settlement gas. This requires a separate user-reviewed wallet transaction. The service caps each escrow transaction at 0.002 test BNB in estimated gas; this is a per-transaction ceiling, not a total allowance.
6. Enable execution by changing the deployment variable to `EXECUTION_ENABLED=true`, after reviewing the effect: accepted funded jobs can submit and settle automatically; enrolled, authorized HelloFugu vaults can execute bounded repayments. Deploy the reviewed configuration. The public configuration endpoint cannot enable execution.
7. Import the identity at https://pokter.xyz/build/import and run its external checks. No listing fee is charged by Pokter; registry gas applies.
8. Test a paid job from a separate wallet, then verify its delivery hash, review window and completed settlement. Your own test wallet does not satisfy the campaign's independence requirement.

## Pokter service

- Category: `health-factor`.
- Skill: read-only Venus DeFi isolated-pool risk report for one borrower on BNB testnet.
- Price: 0.01 test U, using the testnet escrow's 18-decimal token.
- `negotiate` returns an EIP-191 quote signed by the registered service wallet. The signed canonical JSON binds the task, deliverables, quality standards, success criteria, price, token, expiry, chain and escrow.
- `notify_funded` checks the actual onchain job, identity, provider, budget, payment token, router, policy and saved quote before enqueueing work.
- Reports include collateral, debt, health factor, source block, assumptions and limitations. No buyer funds move during the assessment.
- Exact delivery bytes remain served at `/deliveries/{jobId}.json`; `submit` commits their keccak256 hash.
- The worker reads the actual deadline and policy review window, then settles after the window. Pending signed transactions are stored before broadcasting; retries reuse the exact bytes. One job is processed at a time.
- The runtime exposes at most 100 completed-job summaries. Independence of buyers and prize eligibility remain organizer decisions.

Position Guard's subscription enrollment remains the existing HelloFugu integration. A Pokter risk-report hire does **not** authorize vault repayments or create a HelloFugu subscription. Do not represent escrow submissions as category-consistent DeFi actions for the campaign. The five onchain actions across three days, independent hires, and participant hires on two marketplaces remain separate work.

## Verification and sources

`npm test` checks quote signatures, canonicalization, changed terms, identity/token/policy/deadline rejection and bounded transaction preparation. `npm run test:cloud` starts the actual local Workers runtime twice, tests discovery, origin/body limits, disabled execution, scheduler and service-wallet persistence. It sends no blockchain transactions. A public end-to-end escrow hire and Pokter's external compatibility check still require the registered identity and service gas.

Primary references checked 2026-10-27:

- https://pokter.xyz/guides/list-your-agent
- https://pokter.xyz/build/integration
- https://pokter.xyz/api/v1/integration (version 2026-10-25)
- https://github.com/bnb-chain/bnbagent-sdk/tree/245fcf18c178c678a34870d8cc8b5a841e45ea30 (ABI subset in `src/marketplace/pokter-abi.js`)
- https://developers.cloudflare.com/durable-objects/platform/pricing/
- https://developers.cloudflare.com/durable-objects/platform/limits/

Tests are not a security audit. The deployment intentionally supports chain 97 only.
