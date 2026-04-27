import { Interface, MaxUint256, getAddress } from "ethers";
import { describe, expect, it } from "vitest";
import { extractFacts } from "../../../src/tx/extractFacts.js";
import type { Address } from "../../../src/types/antibody.js";
import type { ProposedTx } from "../../../src/types/context.js";
import { TEST_CHAIN_ID } from "../../fixtures/network.js";

const ZERO: Address = "0x0000000000000000000000000000000000000000";
const TOKEN_USDC = getAddress("0x289ff00235d2b98b0145ff5d4435d3e92f9540a6") as Address;
const TOKEN_WETH = getAddress("0x7b79995e5f793a07bc00c21412e50ecae098e7f9") as Address;
const SOME_RECIPIENT = getAddress("0x000000000000000000000000000000000000beef") as Address;
const SOME_FROM = getAddress("0x000000000000000000000000000000000000face") as Address;

const ERC20 = new Interface([
  "function transfer(address to, uint256 value)",
  "function transferFrom(address from, address to, uint256 value)",
  "function approve(address spender, uint256 value)",
]);

const V2 = new Interface([
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)",
]);

const V3_02 = new Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum))",
]);

const V3 = new Interface([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96))",
  "function exactInput((bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum))",
]);

function tx(over: Partial<ProposedTx> & { to: Address }): ProposedTx {
  return { chainId: TEST_CHAIN_ID, ...over };
}

describe("extractFacts", () => {
  describe("degenerate inputs", () => {
    it("returns all zeros for null tx", () => {
      expect(extractFacts(null)).toEqual({
        tokenAddress: ZERO,
        tokenAmount: 0n,
        originChainId: 0,
      });
    });

    it("returns all-zero facts for tx with no value and no data (nothing actionable)", () => {
      // Per spec: when no facts can be extracted, every field is zero —
      // including originChainId. The indexer treats tokenAmount=0 as
      // "skip pricing", and a zero chainId is a clean tombstone.
      const result = extractFacts(tx({ to: SOME_RECIPIENT }));
      expect(result.tokenAddress).toBe(ZERO);
      expect(result.tokenAmount).toBe(0n);
      expect(result.originChainId).toBe(0);
    });

    it("returns zeros for tx with empty 0x data and zero value", () => {
      const result = extractFacts(tx({ to: SOME_RECIPIENT, data: "0x", value: 0n }));
      expect(result.tokenAmount).toBe(0n);
    });
  });

  describe("native transfer", () => {
    it("extracts tx.value as tokenAmount with 0x0 token address", () => {
      const result = extractFacts(
        tx({ to: SOME_RECIPIENT, value: 5_000_000_000_000_000_000n }),
      );
      expect(result).toEqual({
        tokenAddress: ZERO,
        tokenAmount: 5_000_000_000_000_000_000n,
        originChainId: TEST_CHAIN_ID,
      });
    });

    it("treats 0x as no data and recognizes value > 0 as native", () => {
      const result = extractFacts(tx({ to: SOME_RECIPIENT, value: 1n, data: "0x" }));
      expect(result.tokenAmount).toBe(1n);
      expect(result.tokenAddress).toBe(ZERO);
    });
  });

  describe("ERC20 transfer", () => {
    it("decodes amount from transfer(address,uint256)", () => {
      const data = ERC20.encodeFunctionData("transfer", [SOME_RECIPIENT, 1_500_000n]) as `0x${string}`;
      const result = extractFacts(tx({ to: TOKEN_USDC, data }));
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
      expect(result.tokenAmount).toBe(1_500_000n);
      expect(result.originChainId).toBe(TEST_CHAIN_ID);
    });
  });

  describe("ERC20 transferFrom", () => {
    it("decodes the third argument as amount", () => {
      const data = ERC20.encodeFunctionData("transferFrom", [
        SOME_FROM,
        SOME_RECIPIENT,
        9_999n,
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: TOKEN_USDC, data }));
      expect(result.tokenAmount).toBe(9_999n);
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
    });
  });

  describe("ERC20 approve", () => {
    it("decodes a finite amount", () => {
      const data = ERC20.encodeFunctionData("approve", [SOME_RECIPIENT, 250n]) as `0x${string}`;
      const result = extractFacts(tx({ to: TOKEN_USDC, data }));
      expect(result.tokenAmount).toBe(250n);
    });

    it("preserves MAX_UINT256 (unlimited approval)", () => {
      const data = ERC20.encodeFunctionData("approve", [
        SOME_RECIPIENT,
        MaxUint256,
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: TOKEN_USDC, data }));
      expect(result.tokenAmount).toBe(MaxUint256);
    });
  });

  describe("Uniswap V2 router", () => {
    it("decodes swapExactTokensForTokens (input from path[0])", () => {
      const data = V2.encodeFunctionData("swapExactTokensForTokens", [
        7_500_000n,
        100n,
        [TOKEN_USDC, TOKEN_WETH],
        SOME_RECIPIENT,
        9999999999n,
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: SOME_RECIPIENT, data }));
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
      expect(result.tokenAmount).toBe(7_500_000n);
    });

    it("decodes swapExactTokensForETH", () => {
      const data = V2.encodeFunctionData("swapExactTokensForETH", [
        4_200n,
        1n,
        [TOKEN_USDC, TOKEN_WETH],
        SOME_RECIPIENT,
        9999999999n,
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: SOME_RECIPIENT, data }));
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
      expect(result.tokenAmount).toBe(4_200n);
    });

    it("decodes swapExactETHForTokens (uses tx.value as amountIn, native token)", () => {
      const data = V2.encodeFunctionData("swapExactETHForTokens", [
        100n,
        [TOKEN_WETH, TOKEN_USDC],
        SOME_RECIPIENT,
        9999999999n,
      ]) as `0x${string}`;
      const result = extractFacts(
        tx({ to: SOME_RECIPIENT, data, value: 1_000_000_000_000_000n }),
      );
      expect(result.tokenAddress).toBe(ZERO);
      expect(result.tokenAmount).toBe(1_000_000_000_000_000n);
    });
  });

  describe("Uniswap V3 SwapRouter02 (no deadline)", () => {
    it("decodes exactInputSingle", () => {
      const data = V3_02.encodeFunctionData("exactInputSingle", [
        [TOKEN_USDC, TOKEN_WETH, 3000, SOME_RECIPIENT, 5_555n, 0n, 0n],
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: SOME_RECIPIENT, data }));
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
      expect(result.tokenAmount).toBe(5_555n);
    });

    it("decodes exactInput with first 20 bytes of path = tokenIn", () => {
      // path = tokenIn(20) | fee(3) | tokenOut(20) — total 43 bytes
      const path = `0x${TOKEN_USDC.slice(2)}000bb8${TOKEN_WETH.slice(2)}` as `0x${string}`;
      const data = V3_02.encodeFunctionData("exactInput", [
        [path, SOME_RECIPIENT, 1_234n, 0n],
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: SOME_RECIPIENT, data }));
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
      expect(result.tokenAmount).toBe(1_234n);
    });
  });

  describe("Uniswap V3 SwapRouter (with deadline)", () => {
    it("decodes exactInputSingle with deadline at index 4", () => {
      const data = V3.encodeFunctionData("exactInputSingle", [
        [TOKEN_USDC, TOKEN_WETH, 3000, SOME_RECIPIENT, 9999999999n, 8_888n, 0n, 0n],
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: SOME_RECIPIENT, data }));
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
      expect(result.tokenAmount).toBe(8_888n);
    });

    it("decodes exactInput with deadline at index 2", () => {
      const path = `0x${TOKEN_USDC.slice(2)}000bb8${TOKEN_WETH.slice(2)}` as `0x${string}`;
      const data = V3.encodeFunctionData("exactInput", [
        [path, SOME_RECIPIENT, 9999999999n, 7_777n, 0n],
      ]) as `0x${string}`;
      const result = extractFacts(tx({ to: SOME_RECIPIENT, data }));
      expect(result.tokenAddress.toLowerCase()).toBe(TOKEN_USDC.toLowerCase());
      expect(result.tokenAmount).toBe(7_777n);
    });
  });

  describe("unrecognized selectors", () => {
    it("returns zeros for arbitrary 4-byte selector", () => {
      const result = extractFacts(
        tx({
          to: SOME_RECIPIENT,
          // selector 0xdeadbeef plus padding — not a known function
          data: ("0xdeadbeef" + "00".repeat(32)) as `0x${string}`,
        }),
      );
      expect(result.tokenAmount).toBe(0n);
      expect(result.tokenAddress).toBe(ZERO);
    });

    it("returns zeros (no throw) on truncated calldata for a known selector", () => {
      // transfer selector but no args → decode fails; should be caught
      const result = extractFacts(tx({ to: TOKEN_USDC, data: "0xa9059cbb" }));
      expect(result.tokenAmount).toBe(0n);
      expect(result.tokenAddress).toBe(ZERO);
    });
  });

  describe("chainId handling", () => {
    it("defaults originChainId to 0 when tx.chainId is undefined", () => {
      const result = extractFacts({ to: SOME_RECIPIENT, value: 1n });
      expect(result.originChainId).toBe(0);
    });

    it("propagates the provided chainId from tx", () => {
      const result = extractFacts({ to: SOME_RECIPIENT, value: 1n, chainId: 8453 });
      expect(result.originChainId).toBe(8453);
    });
  });
});
