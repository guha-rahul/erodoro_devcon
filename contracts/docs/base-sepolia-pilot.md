# Base Sepolia pilot

This runbook deploys and operates the current testnet contracts. It uses four separate accounts.

The pilot uses a test B20 stock and test quote token. It does not prove market demand or mainnet readiness.

## Prepare the accounts

Create one deployer, one seller, one maker, and one settlement caller. Use testnet-only accounts.

Store each account in an encrypted Foundry keystore. The `.pilot-keys` directory is ignored by Git. Do not export a raw private key.

```sh
mkdir -p .pilot-keys
cast wallet new .pilot-keys deployer --password
cast wallet new .pilot-keys seller --password
cast wallet new .pilot-keys maker --password
cast wallet new .pilot-keys settler --password
```

Store the shared testnet-keystore password in `.pilot-keys/password`. Restrict access to the file. Never use these accounts on mainnet.

```sh
chmod 600 .pilot-keys/*
```

Get each address with this command. Replace `deployer` with each account name.

```sh
cast wallet address --keystore .pilot-keys/deployer \
  --password-file .pilot-keys/password
```

Copy `.env.example` to `.env`. Set the four address fields and `BASE_SEPOLIA_RPC_URL`. Keep all raw-key variables unset.

Set `PYTH_ADDRESS` to the Base Sepolia Pyth receiver. Make sure that the address contains contract code.

Get Base Sepolia ETH from the [official Base faucet list](https://docs.base.org/base-chain/network-information/network-faucets). Fund the deployer first. Send a small testnet amount from it to the other three accounts. Each account only needs gas.

Use these local variables in the commands below:

```sh
source .env
KEY_PASSWORD_FILE=.pilot-keys/password
```

## Create the test stock

Run this command with `base-forge`:

```sh
source .env
base-forge script script/CreateTestAsset.s.sol:CreateTestAsset \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/deployer --password-file "$KEY_PASSWORD_FILE" \
  --sender "$DEPLOYER_ADDRESS"
```

Set `BASE_COLLATERAL` to the reported token address. The deployer must remain the B20 admin during pilot deployment.

## Deploy the pilot stack

Run this command:

```sh
base-forge script script/DeployPilot.s.sol:DeployPilot \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/deployer --password-file "$KEY_PASSWORD_FILE" \
  --sender "$DEPLOYER_ADDRESS"
```

The script deploys these contracts:

- The vault, Pyth adapter, and factory.
- The RFQ contract and test quote token.
- The faucet and issuer-control sandbox.

The script grants only the required B20 roles. Record every reported address in `.env` and the deployment file.

## Deploy the UMA fallback

Set all `UMA_*` variables in `.env`. Then run this command:

```sh
forge script script/DeployUmaFallback.s.sol:DeployUmaFallback \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/deployer --password-file "$KEY_PASSWORD_FILE" \
  --sender "$DEPLOYER_ADDRESS"
```

Set `FALLBACK_ADAPTER_ADDRESS` to the reported address. Set it to the zero address if this pilot excludes fallback settlement.

## List one series

Set `SERIES_HORIZON` to at least 600. Then run this command:

Choose a maturity inside the regular US equity session. The listed pilot allows a 60-second price window.

```sh
base-forge script script/ListSeries.s.sol:ListSeries \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/deployer --password-file "$KEY_PASSWORD_FILE" \
  --sender "$DEPLOYER_ADDRESS"
```

Set `SERIES_ID` to the reported series ID. Record the maturity timestamp.

## Run the separate roles

Run each step with the specified account key:

```sh
base-forge script script/Lifecycle.s.sol:Lifecycle --sig 'claimSeller()' \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/seller --password-file "$KEY_PASSWORD_FILE" \
  --sender "$SELLER_ADDRESS"

base-forge script script/Lifecycle.s.sol:Lifecycle --sig 'claimMaker()' \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/maker --password-file "$KEY_PASSWORD_FILE" \
  --sender "$MAKER_ADDRESS"

base-forge script script/Lifecycle.s.sol:Lifecycle --sig 'split(uint256)' 100000000 \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/seller --password-file "$KEY_PASSWORD_FILE" \
  --sender "$SELLER_ADDRESS"

base-forge script script/Lifecycle.s.sol:Lifecycle --sig 'prepareMaker()' \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/maker --password-file "$KEY_PASSWORD_FILE" \
  --sender "$MAKER_ADDRESS"
```

Choose an expiry and nonce. Run `quoteDigest` to get the exact EIP-712 digest.

```sh
base-forge script script/Lifecycle.s.sol:Lifecycle \
  --sig 'quoteDigest(uint256,uint256,uint256,uint256)' \
  100000000 6150000 "$QUOTE_EXPIRY" "$QUOTE_NONCE" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" -vv
```

Copy the returned digest to `QUOTE_DIGEST`. The maker signs it without an Ethereum message prefix.

```sh
cast wallet sign --no-hash "$QUOTE_DIGEST" \
  --keystore .pilot-keys/maker --password-file "$KEY_PASSWORD_FILE"
```

Copy the returned signature to `MAKER_SIGNATURE`. The seller fills the signed quote.

```sh
base-forge script script/Lifecycle.s.sol:Lifecycle \
  --sig 'sellNSigned(uint256,uint256,uint256,uint256,bytes)' \
  100000000 6150000 "$QUOTE_EXPIRY" "$QUOTE_NONCE" "$MAKER_SIGNATURE" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/seller --password-file "$KEY_PASSWORD_FILE" \
  --sender "$SELLER_ADDRESS"
```

An external maker follows the same digest and signature flow. The maker never sends its private key to Erodoro.

Wait until the maturity and settlement-delay timestamps pass. Then get the first signed update at or after maturity:

```sh
eval "$(script/fetch-hermes.sh "$FEED_ID" "$SERIES_MATURITY")"
```

Set `SERIES_MATURITY` to the recorded Unix timestamp before you run this command.

Settle and redeem each claim from its holder account:

```sh
base-forge script script/Lifecycle.s.sol:Lifecycle --sig 'settle(bytes)' "$BASE_PYTH_UPDATE" \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/settler --password-file "$KEY_PASSWORD_FILE" \
  --sender "$SETTLER_ADDRESS"

base-forge script script/Lifecycle.s.sol:Lifecycle --sig 'redeemP()' \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/seller --password-file "$KEY_PASSWORD_FILE" \
  --sender "$SELLER_ADDRESS"

base-forge script script/Lifecycle.s.sol:Lifecycle --sig 'redeemN()' \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --broadcast -vv \
  --keystore .pilot-keys/maker --password-file "$KEY_PASSWORD_FILE" \
  --sender "$MAKER_ADDRESS"
```

## Record the evidence

Copy each transaction hash from `broadcast/`. Record the exact contract configuration and all account addresses.

Record these balances before and after each action:

- The seller stock, P, N, and quote-token balances.
- The maker N and quote-token balances.
- The vault stock balance and `lockedOf` value.
- The settlement price and P and N pools.

Add the results to `deployments/base-sepolia.json` and the repository `status.md`. Do not mark Task 5 complete without these records.
