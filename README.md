# Brivon Cross-Chain Settlement Quote Demo

A standalone Node.js example for requesting a native-asset quote from Brivon's settlement API. It lists the API's network catalogue, checks settlement eligibility, and requests one quote using exact base-unit strings. With an explicit flag, it can sign and create a settlement order for an EVM source route.

This is a client for Brivon's custodial native-asset settlement service. It is not a trustless bridge contract or a general-purpose token bridge. Its default mode calls only GET /v1/networks and POST /v1/swaps/quotes. It does not send a transaction.

## Requirements

- Node.js 22.13 or newer
- A Brivon public app identifier
- EVM or Solana addresses for an API-supported route

## Run

    npm install
    cp .env.example .env

Set the source and destination chain IDs, wallet addresses and a positive amount in base units in .env. The example starts with Brivon Mainnet to Ethereum; change it only to a route enabled by the API.

    npm run quote

The API returns current availability, quote expiry, fees and output amount. A quote can expire or become unavailable before a separate order is created.

To sign an EVM-source order and reserve destination liquidity:

    npm run quote -- --create-order

This requires BRIDGE_WALLET_PRIVATE_KEY in .env and a current available quote. It creates an API order and displays the exact deposit address and amount. It does not submit the source-chain deposit or attach a transaction hash. Order creation can reserve server liquidity while the request waits for a deposit, so use this option only with the configured API operator's permission and an isolated wallet.

## Credentials

BRIVON_PUBLIC_APP_KEY is a public app identifier sent in the X-API-Key header. It is not wallet authorization and is different from the server-only API_KEY. If the service operator has changed the public app identifier, update the local .env; never commit a private service key. The wallet key is used locally to sign the order intent and is never sent to the API.
