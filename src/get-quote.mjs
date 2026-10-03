import "dotenv/config";
import { randomBytes, randomUUID } from "node:crypto";
import { Wallet } from "ethers";

const swapIntentTypes = {
  SwapIntent: [
    { name: "action", type: "string" },
    { name: "audience", type: "string" },
    { name: "sourceChainId", type: "uint256" },
    { name: "destinationChainId", type: "uint256" },
    { name: "sourceAsset", type: "string" },
    { name: "destinationAsset", type: "string" },
    { name: "sourceAddress", type: "string" },
    { name: "destinationAddress", type: "string" },
    { name: "amountInBaseUnits", type: "uint256" },
    { name: "amountOutBaseUnits", type: "uint256" },
    { name: "quoteId", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "deadline", type: "uint256" },
  ],
};

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("Set " + name + " in your local .env file.");
  return value;
}

function positiveInteger(name) {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(name + " must be a positive integer.");
  }
  return value;
}

function apiUrl() {
  const url = new URL(required("BRIVON_API_BASE_URL"));
  const isLocalHttp = url.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error("BRIVON_API_BASE_URL must use HTTPS (HTTP is allowed only for localhost).");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("BRIVON_API_BASE_URL must not contain credentials, a query, or a fragment.");
  }
  return url;
}

async function requestJson(url, options) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 256 * 1024) throw new Error("The API response was too large.");
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("The API returned an invalid JSON response.");
  }
  if (!response.ok) {
    const message = payload?.error?.message ?? "The API request could not be completed.";
    throw new Error(response.status + " " + message);
  }
  return payload;
}

async function main() {
  const baseUrl = apiUrl();
  const apiKey = required("BRIVON_PUBLIC_APP_KEY");
  const sourceChainId = positiveInteger("SOURCE_CHAIN_ID");
  const destinationChainId = positiveInteger("DESTINATION_CHAIN_ID");
  const sourceAddress = required("SOURCE_ADDRESS");
  const destinationAddress = required("DESTINATION_ADDRESS");
  const amountInBaseUnits = required("AMOUNT_IN_BASE_UNITS");
  if (!/^[1-9][0-9]{0,77}$/.test(amountInBaseUnits)) {
    throw new Error("AMOUNT_IN_BASE_UNITS must be a positive integer string.");
  }

  const headers = { Accept: "application/json", "X-API-Key": apiKey };
  const networksResponse = await requestJson(
    new URL("/v1/networks", baseUrl),
    { headers },
  );
  const networks = networksResponse?.data;
  if (!Array.isArray(networks)) throw new Error("The API returned no network catalogue.");

  const source = networks.find((network) => network.chainId === sourceChainId);
  const destination = networks.find((network) => network.chainId === destinationChainId);
  if (!source?.settlementEligible || !destination?.settlementEligible) {
    throw new Error("The selected source or destination is not settlement-enabled.");
  }

  const quoteResponse = await requestJson(
    new URL("/v1/swaps/quotes", baseUrl),
    {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChainId,
        destinationChainId,
        sourceAddress,
        destinationAddress,
        amountInBaseUnits,
      }),
    },
  );
  const quote = quoteResponse?.data;
  if (!quote) throw new Error("The API returned no quote.");

  const createOrder = process.argv.includes("--create-order");
  let order;
  if (createOrder) {
    if (source.family !== "evm") {
      throw new Error("This example creates signed orders only for EVM source networks.");
    }
    if (quote.availability?.status !== "available") {
      throw new Error("The quote is not currently available for order creation.");
    }
    if (baseUrl.protocol !== "https:") {
      throw new Error("Signed order creation requires an HTTPS API URL.");
    }

    const wallet = new Wallet(required("BRIDGE_WALLET_PRIVATE_KEY"));
    if (wallet.address.toLowerCase() !== sourceAddress.toLowerCase()) {
      throw new Error("SOURCE_ADDRESS must match the configured signing wallet.");
    }
    if (destination.family === "evm" &&
        wallet.address.toLowerCase() !== destinationAddress.toLowerCase()) {
      throw new Error("For EVM-to-EVM routes, DESTINATION_ADDRESS must match SOURCE_ADDRESS.");
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    const deadline = Math.min(nowSeconds + 25, Math.floor(quote.expiresAtMs / 1000));
    if (!Number.isSafeInteger(quote.expiresAtMs) || deadline <= nowSeconds) {
      throw new Error("The quote has expired. Request a new quote and try again.");
    }
    const intent = {
      action: "swap",
      audience: baseUrl.origin,
      sourceChainId,
      destinationChainId,
      sourceAsset: quote.sourceAsset?.symbol,
      destinationAsset: quote.destinationAsset?.symbol,
      sourceAddress: quote.sourceAddress,
      destinationAddress: quote.destinationAddress,
      amountInBaseUnits: quote.amountInBaseUnits,
      amountOutBaseUnits: quote.amountOutBaseUnits,
      quoteId: quote.id,
      nonce: "0x" + randomBytes(32).toString("hex"),
      deadline,
    };
    if (typeof intent.sourceAsset !== "string" ||
        typeof intent.destinationAsset !== "string" ||
        typeof intent.sourceAddress !== "string" ||
        typeof intent.destinationAddress !== "string" ||
        typeof intent.quoteId !== "string" ||
        typeof intent.amountInBaseUnits !== "string" ||
        typeof intent.amountOutBaseUnits !== "string") {
      throw new Error("The API quote is missing fields needed to create an order.");
    }
    const signature = await wallet.signTypedData(
      {
        name: "Brivon Settlement",
        version: "1",
        chainId: sourceChainId,
      },
      swapIntentTypes,
      intent,
    );
    const orderResponse = await requestJson(
      new URL("/v1/swaps", baseUrl),
      {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({ intent, signature }),
      },
    );
    order = orderResponse?.data;
    if (!order?.id) throw new Error("The API returned no settlement order.");
  }

  console.log(JSON.stringify({
    source: {
      chainId: source.chainId,
      name: source.name,
      nativeAsset: source.nativeAsset,
    },
    destination: {
      chainId: destination.chainId,
      name: destination.name,
      nativeAsset: destination.nativeAsset,
    },
    quote,
    order: order ?? null,
    nextStep: order
      ? "Order reserved. Review its exact source amount and settlement address; this example has not sent a deposit."
      : "Quote only: no order, deposit instruction, wallet signature, or transaction was created.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "The quote request failed.");
  process.exitCode = 1;
});
