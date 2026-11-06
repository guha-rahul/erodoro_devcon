# Stock forge for everyday work; base-forge only where Base precompiles matter.
FORGE      ?= forge
BASE_FORGE ?= $(HOME)/.foundry/bin/base-forge
# The vault recorded in deployments/base.json, used by `verify-mainnet`.
MAINNET_VAULT ?= 0x01C4Ca673057a2Ddc64202a31B81F9BF838f4444

.PHONY: build test test-base fork-test fmt preflight verify-mainnet clean

## Unit + property suites on mocks. No RPC. This is the CI gate.
test:
	$(FORGE) test

## The same suites with Base's real precompiles hosted in-process.
test-base:
	$(BASE_FORGE) test

build:
	$(FORGE) build

fmt:
	$(FORGE) fmt

## The lifecycle against live Base state. Needs configuration —
## see docs/base-fork-testing.md. Fetches a real signed Pyth update first.
fork-test:
	@test -n "$$BASE_RPC_URL"    || (echo "BASE_RPC_URL is unset"    && exit 1)
	@test -n "$$BASE_COLLATERAL" || (echo "BASE_COLLATERAL is unset" && exit 1)
	@test -n "$$BASE_FEED_ID"    || (echo "BASE_FEED_ID is unset"    && exit 1)
	@eval "$$(script/fetch-hermes.sh $$BASE_FEED_ID)" && \
	  FOUNDRY_PROFILE=fork $(BASE_FORGE) test -vv

preflight:
	@test -n "$$BASE_RPC_URL" || (echo "BASE_RPC_URL is unset" && exit 1)
	@test -n "$$BASE_COLLATERAL" || (echo "BASE_COLLATERAL is unset - Preflight.s.sol requires it" && exit 1)
	$(BASE_FORGE) script script/Preflight.s.sol --rpc-url "$$BASE_RPC_URL" -vv

## Preflight against the recorded live mainnet deployment, in one command.
## `preflight` alone only warns about the transfer policies; without BASE_VAULT
## it cannot tell you whether the deployed vault is actually authorized. The
## config lives in .env.fork (real AAPLc) - note that contracts/.env sets
## BASE_COLLATERAL to the *test* asset, so sourcing the wrong file silently
## checks the wrong token. Requires base-forge: stock forge cannot read B20
## precompiles and reports "not a B20 Asset".
verify-mainnet:
	@test -f .env.fork || (echo ".env.fork is missing - see docs/base-fork-testing.md" && exit 1)
	@set -a && . ./.env.fork && set +a && \
	  BASE_VAULT="$${BASE_VAULT:-$(MAINNET_VAULT)}" \
	  BASE_PRICE_DECIMALS="$${BASE_PRICE_DECIMALS:-8}" \
	  BASE_FEED_EXPO_ABS="$${BASE_FEED_EXPO_ABS:-5}" \
	  $(MAKE) preflight

clean:
	$(FORGE) clean
