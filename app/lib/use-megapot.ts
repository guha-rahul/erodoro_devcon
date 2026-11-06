"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig, useWriteContract } from "wagmi";
import { readContract, waitForTransactionReceipt } from "wagmi/actions";
import { erc20Abi } from "viem";
import {
  MEGAPOT_CHAIN_ID,
  MegapotJackpotAbi,
  MegapotRandomBuyerAbi,
  MEGAPOT_SOURCE,
  megapotFor,
  referralArguments,
} from "./megapot";
import type { SendState } from "./tx";

const deployment = megapotFor(MEGAPOT_CHAIN_ID)!;

export type MegapotDrawing = {
  drawingId: bigint;
  ticketPrice: bigint;
  prizePool: bigint;
  ballMax: number;
  bonusballMax: number;
};

/**
 * The live Megapot drawing: what a ticket costs and what is on the table.
 *
 * Read straight from the chain rather than the Data API, because the only
 * thing this panel needs is the price it will actually be charged. Polls once a
 * minute — a drawing lasts a day and the ticket price is stable within one.
 */
export function useMegapotDrawing(): MegapotDrawing | null {
  const config = useConfig();
  const [drawing, setDrawing] = useState<MegapotDrawing | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const drawingId = await readContract(config, {
          chainId: MEGAPOT_CHAIN_ID,
          address: deployment.jackpot,
          abi: MegapotJackpotAbi,
          functionName: "currentDrawingId",
        });
        const state = await readContract(config, {
          chainId: MEGAPOT_CHAIN_ID,
          address: deployment.jackpot,
          abi: MegapotJackpotAbi,
          functionName: "getDrawingState",
          args: [drawingId],
        });
        if (live) {
          setDrawing({
            drawingId,
            ticketPrice: state.ticketPrice,
            prizePool: state.prizePool,
            ballMax: state.ballMax,
            bonusballMax: state.bonusballMax,
          });
        }
      } catch {
        if (live) setDrawing(null);
      }
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [config]);

  return drawing;
}

/**
 * Buy Megapot tickets with USDC.
 *
 * Same rule as every other write in this app: the wallet must be on the chain
 * the contract lives on before it signs. Here that is Base mainnet, not the
 * app's default testnet, so the guard is explicit and refuses anything else
 * rather than silently sending a transaction a testnet wallet cannot cover.
 */
export function useMegapotTickets() {
  const { address, chainId } = useAccount();
  const config = useConfig();
  const { writeContractAsync } = useWriteContract();
  const [state, setState] = useState<SendState>({ kind: "idle" });

  const buy = useCallback(
    async (count: bigint, cost: bigint) => {
      if (!address) {
        setState({ kind: "error", message: "Connect a wallet first." });
        return null;
      }
      if (chainId !== MEGAPOT_CHAIN_ID) {
        setState({ kind: "error", message: "Megapot runs on Base mainnet. Switch your wallet before buying." });
        return null;
      }
      if (count <= 0n || cost <= 0n) {
        setState({ kind: "error", message: "Not enough USDC for a ticket." });
        return null;
      }
      try {
        const allowance = await readContract(config, {
          chainId: MEGAPOT_CHAIN_ID,
          address: deployment.usdc,
          abi: erc20Abi,
          functionName: "allowance",
          args: [address, deployment.randomTicketBuyer],
        });
        if (allowance < cost) {
          setState({ kind: "sending", phase: "approval" });
          const approval = await writeContractAsync({
            chainId: MEGAPOT_CHAIN_ID,
            address: deployment.usdc,
            abi: erc20Abi,
            functionName: "approve",
            args: [deployment.randomTicketBuyer, cost],
          });
          setState({ kind: "sending", phase: "confirming", hash: approval });
          const approvalReceipt = await waitForTransactionReceipt(config, { hash: approval });
          if (approvalReceipt.status !== "success") throw new Error("USDC approval reverted.");
        }

        setState({ kind: "sending", phase: "confirming" });
        const { referrers, split } = referralArguments();
        const hash = await writeContractAsync({
          chainId: MEGAPOT_CHAIN_ID,
          address: deployment.randomTicketBuyer,
          abi: MegapotRandomBuyerAbi,
          functionName: "buyTickets",
          args: [count, address, referrers, split, MEGAPOT_SOURCE],
        });
        setState({ kind: "sending", phase: "confirming", hash });
        const receipt = await waitForTransactionReceipt(config, { hash });
        if (receipt.status !== "success") throw new Error("Ticket purchase reverted.");
        setState({ kind: "ok", hash });
        return hash;
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : "Ticket purchase failed.";
        const cancelled = /user rejected|denied|cancell?ed/i.test(message);
        setState(
          cancelled ? { kind: "cancelled", message: "Rejected in the wallet." } : { kind: "error", message },
        );
        return null;
      }
    },
    [address, chainId, config, writeContractAsync],
  );

  return { state, reset: () => setState({ kind: "idle" }), buy };
}
