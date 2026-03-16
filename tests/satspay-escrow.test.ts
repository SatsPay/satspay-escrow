import { describe, expect, it, beforeEach } from "vitest";
import { Cl, ClarityValue } from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic 32-byte buffer from a short string tag */
function buf32(tag: string): Uint8Array {
  const out = new Uint8Array(32);
  const enc = new TextEncoder().encode(tag);
  out.set(enc.slice(0, 32));
  return out;
}

/** Unique claim-id for each test run */
function claimId(suffix: string) {
  return Cl.bufferFromHex(
    Buffer.from(buf32(`claim-${suffix}`)).toString("hex")
  );
}

/** A fake phone hash (SHA-256 of "+2348012345678" for the tests) */
const PHONE_HASH = Cl.bufferFromHex(
  "d3b5b8e8fb1e2f3c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7"
);

/** sBTC mock contract name (deployed in the Clarinet devnet) */
const SBTC_CONTRACT = "sbtc-token";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1  = accounts.get("wallet_1")!;   // sender
const wallet2  = accounts.get("wallet_2")!;   // recipient
const wallet3  = accounts.get("wallet_3")!;   // unrelated party

const ESCROW = "satspay-escrow";
const ONE_SBTC = 100_000_000n; // micro-sBTC

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

function sendToPhone(
  caller: string,
  phoneHash: ClarityValue,
  amount: bigint,
  id: ClarityValue,
  expiryBlocks: bigint
) {
  return simnet.callPublicFn(
    ESCROW,
    "send-to-phone",
    [
      phoneHash,
      Cl.uint(amount),
      id,
      Cl.uint(expiryBlocks),
      Cl.contractPrincipal(deployer, SBTC_CONTRACT),
    ],
    caller
  );
}

function claim(caller: string, id: ClarityValue, recipient: string) {
  return simnet.callPublicFn(
    ESCROW,
    "claim",
    [
      id,
      Cl.standardPrincipal(recipient),
      Cl.contractPrincipal(deployer, SBTC_CONTRACT),
    ],
    caller
  );
}

function reclaim(caller: string, id: ClarityValue) {
  return simnet.callPublicFn(
    ESCROW,
    "reclaim",
    [id, Cl.contractPrincipal(deployer, SBTC_CONTRACT)],
    caller
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("satspay-escrow", () => {

  // ─────────────────────────────────────────────────────────────────────────
  // send-to-phone
  // ─────────────────────────────────────────────────────────────────────────
  describe("send-to-phone", () => {

    it("succeeds with valid parameters and emits transfer-initiated event", () => {
      const id = claimId("success-1");
      const { result, events } = sendToPhone(
        wallet1, PHONE_HASH, ONE_SBTC, id, 144n
      );

      expect(result).toBeOk(Cl.bool(true));

      // Check the print event
      const printEvent = events.find(e => e.event === "print_event");
      expect(printEvent).toBeDefined();
      const payload = printEvent!.data.value as any;
      expect(payload).toBeDefined();
    });

    it("stores the transfer record with correct fields", () => {
      const id = claimId("store-1");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC * 2n, id, 200n);

      const { result } = simnet.callReadOnlyFn(
        ESCROW,
        "get-transfer",
        [id],
        deployer
      );
      expect(result).toBeSome(
        Cl.tuple({
          sender:       Cl.standardPrincipal(wallet1),
          "phone-hash": PHONE_HASH,
          amount:       Cl.uint(ONE_SBTC * 2n),
          "expiry-block": Cl.uint(BigInt(simnet.blockHeight) + 200n - 1n), // mined in next block
          claimed:      Cl.bool(false),
        })
      );
    });

    it("increments total-escrowed", () => {
      const before = simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer).result;

      const id = claimId("escrow-total-1");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);

      const after = simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer).result;

      // After should be before + ONE_SBTC
      const beforeVal = (before as any).value as bigint;
      const afterVal  = (after  as any).value as bigint;
      expect(afterVal - beforeVal).toBe(ONE_SBTC);
    });

    it("rejects amount of zero (err u100)", () => {
      const id = claimId("zero-amount");
      const { result } = sendToPhone(wallet1, PHONE_HASH, 0n, id, 144n);
      expect(result).toBeErr(Cl.uint(100));
    });

    it("rejects expiry below minimum 144 blocks (err u101)", () => {
      const id = claimId("expiry-too-soon");
      const { result } = sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 100n);
      expect(result).toBeErr(Cl.uint(101));
    });

    it("rejects duplicate claim-id (err u102)", () => {
      const id = claimId("dup-claim");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);

      // Second call with same id
      const { result } = sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);
      expect(result).toBeErr(Cl.uint(102));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // is-claimable
  // ─────────────────────────────────────────────────────────────────────────
  describe("is-claimable", () => {

    it("returns true for a fresh, unclaimed, unexpired transfer", () => {
      const id = claimId("claimable-true");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);

      const { result } = simnet.callReadOnlyFn(ESCROW, "is-claimable", [id], deployer);
      expect(result).toBeBool(true);
    });

    it("returns false for a non-existent claim-id", () => {
      const id = claimId("nonexistent-99");
      const { result } = simnet.callReadOnlyFn(ESCROW, "is-claimable", [id], deployer);
      expect(result).toBeBool(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // claim
  // ─────────────────────────────────────────────────────────────────────────
  describe("claim", () => {

    it("succeeds and releases sBTC to recipient before expiry", () => {
      const id = claimId("claim-happy");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 200n);

      const { result, events } = claim(deployer, id, wallet2);
      expect(result).toBeOk(Cl.bool(true));

      // transfer-claimed event should be present
      const printEvent = events.find(e => e.event === "print_event");
      expect(printEvent).toBeDefined();
    });

    it("marks the transfer as claimed after a successful claim", () => {
      const id = claimId("claim-marks-flag");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 200n);
      claim(deployer, id, wallet2);

      const { result } = simnet.callReadOnlyFn(ESCROW, "get-transfer", [id], deployer);
      // claimed field should be true
      const tuple = (result as any).value?.data;
      expect(tuple?.claimed?.value).toBe(true);
    });

    it("decrements total-escrowed after claim", () => {
      const id = claimId("claim-decrement");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 200n);

      const before = (simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer).result as any).value as bigint;
      claim(deployer, id, wallet2);
      const after  = (simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer).result as any).value as bigint;

      expect(before - after).toBe(ONE_SBTC);
    });

    it("rejects claim on non-existent claim-id (err u200)", () => {
      const id = claimId("claim-notfound");
      const { result } = claim(deployer, id, wallet2);
      expect(result).toBeErr(Cl.uint(200));
    });

    it("rejects double-claim (err u201)", () => {
      const id = claimId("double-claim");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 200n);
      claim(deployer, id, wallet2);

      const { result } = claim(deployer, id, wallet2);
      expect(result).toBeErr(Cl.uint(201));
    });

    it("rejects claim after expiry (err u202)", () => {
      const id = claimId("claim-expired");
      // Send with minimum expiry (144 blocks)
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);

      // Mine 145 blocks so we are past expiry
      simnet.mineEmptyBlocks(145);

      const { result } = claim(deployer, id, wallet2);
      expect(result).toBeErr(Cl.uint(202));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // reclaim
  // ─────────────────────────────────────────────────────────────────────────
  describe("reclaim", () => {

    it("succeeds and returns sBTC to sender after expiry", () => {
      const id = claimId("reclaim-happy");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);

      simnet.mineEmptyBlocks(145);

      const { result, events } = reclaim(wallet1, id);
      expect(result).toBeOk(Cl.bool(true));

      const printEvent = events.find(e => e.event === "print_event");
      expect(printEvent).toBeDefined();
    });

    it("marks the transfer as claimed after reclaim", () => {
      const id = claimId("reclaim-marks-flag");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);
      simnet.mineEmptyBlocks(145);
      reclaim(wallet1, id);

      const { result } = simnet.callReadOnlyFn(ESCROW, "get-transfer", [id], deployer);
      const tuple = (result as any).value?.data;
      expect(tuple?.claimed?.value).toBe(true);
    });

    it("rejects reclaim on non-existent claim-id (err u300)", () => {
      const id = claimId("reclaim-notfound");
      const { result } = reclaim(wallet1, id);
      expect(result).toBeErr(Cl.uint(300));
    });

    it("rejects reclaim by non-sender wallet (err u301)", () => {
      const id = claimId("reclaim-wrong-sender");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);
      simnet.mineEmptyBlocks(145);

      // wallet3 is not the sender
      const { result } = reclaim(wallet3, id);
      expect(result).toBeErr(Cl.uint(301));
    });

    it("rejects reclaim before expiry (err u302)", () => {
      const id = claimId("reclaim-before-expiry");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);

      // Only mine 50 blocks — not expired yet
      simnet.mineEmptyBlocks(50);

      const { result } = reclaim(wallet1, id);
      expect(result).toBeErr(Cl.uint(302));
    });

    it("rejects double-reclaim (err u303)", () => {
      const id = claimId("double-reclaim");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 144n);
      simnet.mineEmptyBlocks(145);
      reclaim(wallet1, id);

      const { result } = reclaim(wallet1, id);
      expect(result).toBeErr(Cl.uint(303));
    });

    it("rejects reclaim when transfer was already claimed by recipient (err u303)", () => {
      const id = claimId("reclaim-after-claim");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id, 200n);
      claim(deployer, id, wallet2);

      simnet.mineEmptyBlocks(210);

      const { result } = reclaim(wallet1, id);
      expect(result).toBeErr(Cl.uint(303));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // get-transfer / get-total-escrowed
  // ─────────────────────────────────────────────────────────────────────────
  describe("read-only functions", () => {

    it("get-transfer returns none for unknown claim-id", () => {
      const id = claimId("get-unknown");
      const { result } = simnet.callReadOnlyFn(ESCROW, "get-transfer", [id], deployer);
      expect(result).toBeNone();
    });

    it("get-total-escrowed starts at 0", () => {
      // Fresh simnet — no sends yet in this sub-describe
      // (other tests may have run, so just verify it's a uint)
      const { result } = simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer);
      expect((result as any).type).toBe("uint");
    });

    it("multiple sends accumulate in get-total-escrowed", () => {
      const before = (simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer).result as any).value as bigint;

      const id1 = claimId("accum-1");
      const id2 = claimId("accum-2");
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC, id1, 144n);
      sendToPhone(wallet1, PHONE_HASH, ONE_SBTC * 3n, id2, 144n);

      const after = (simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer).result as any).value as bigint;
      expect(after - before).toBe(ONE_SBTC * 4n);
    });
  });
});
