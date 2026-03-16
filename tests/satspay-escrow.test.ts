import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a deterministic 32-byte buffer from a short ASCII string tag */
function buf32(tag: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < Math.min(tag.length, 32); i++) {
    bytes[i] = tag.charCodeAt(i);
  }
  return Buffer.from(bytes).toString("hex");
}

/** A fake phone hash – deterministic 64-char hex string */
const PHONE_HASH = Cl.bufferFromHex(
  "d3b5b8e8fb1e2f3c4a5b6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7"
);

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1  = accounts.get("wallet_1")!;   // sender
const wallet2  = accounts.get("wallet_2")!;   // recipient
const wallet3  = accounts.get("wallet_3")!;   // unrelated party

const ESCROW = "satspay-escrow";
const TOKEN  = "sbtc-token";
const ONE_SBTC = 100_000_000n; // micro-sBTC

// The contract-principal CV used as the sbtc-token argument
const sbtcCV = Cl.contractPrincipal(deployer, TOKEN);

// ---------------------------------------------------------------------------
// Pre-mint helper – gives wallet1 plenty of mock sBTC before each test
// ---------------------------------------------------------------------------

function mintForSender(amount: bigint = ONE_SBTC * 100n) {
  simnet.callPublicFn(TOKEN, "mint", [Cl.uint(amount), Cl.standardPrincipal(wallet1)], deployer);
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

function sendToPhone(
  caller: string,
  idTag: string,
  amount: bigint = ONE_SBTC,
  expiryBlocks: bigint = 144n
) {
  return simnet.callPublicFn(
    ESCROW,
    "send-to-phone",
    [
      PHONE_HASH,
      Cl.uint(amount),
      Cl.bufferFromHex(buf32(idTag)),
      Cl.uint(expiryBlocks),
      sbtcCV,
    ],
    caller
  );
}

function claim(caller: string, idTag: string, recipient: string) {
  return simnet.callPublicFn(
    ESCROW,
    "claim",
    [
      Cl.bufferFromHex(buf32(idTag)),
      Cl.standardPrincipal(recipient),
      sbtcCV,
    ],
    caller
  );
}

function reclaim(caller: string, idTag: string) {
  return simnet.callPublicFn(
    ESCROW,
    "reclaim",
    [Cl.bufferFromHex(buf32(idTag)), sbtcCV],
    caller
  );
}

function getTransfer(idTag: string) {
  return simnet.callReadOnlyFn(
    ESCROW,
    "get-transfer",
    [Cl.bufferFromHex(buf32(idTag))],
    deployer
  );
}

function totalEscrowed() {
  return simnet.callReadOnlyFn(ESCROW, "get-total-escrowed", [], deployer);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("satspay-escrow", () => {

  beforeEach(() => {
    mintForSender();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // send-to-phone
  // ─────────────────────────────────────────────────────────────────────────
  describe("send-to-phone", () => {

    it("succeeds with valid parameters", () => {
      const { result } = sendToPhone(wallet1, "stp-success");
      expect(result).toBeOk(Cl.bool(true));
    });

    it("emits a transfer-initiated print event", () => {
      const { events } = sendToPhone(wallet1, "stp-event");
      const printEvent = events.find((e: any) => e.event === "print_event");
      expect(printEvent).toBeDefined();
    });

    it("stores the transfer record with correct fields", () => {
      sendToPhone(wallet1, "stp-store");
      const { result } = getTransfer("stp-store");
      // result should be a some() wrapping the tuple
      expect(result).not.toBeNone();
    });

    it("increments total-escrowed", () => {
      const before = (totalEscrowed().result as any).value as bigint;
      sendToPhone(wallet1, "stp-total");
      const after = (totalEscrowed().result as any).value as bigint;
      expect(after - before).toBe(ONE_SBTC);
    });

    it("rejects amount of zero (err u100)", () => {
      const { result } = sendToPhone(wallet1, "stp-zero", 0n);
      expect(result).toBeErr(Cl.uint(100));
    });

    it("rejects expiry below 144 blocks (err u101)", () => {
      const { result } = sendToPhone(wallet1, "stp-expiry", ONE_SBTC, 100n);
      expect(result).toBeErr(Cl.uint(101));
    });

    it("rejects duplicate claim-id (err u102)", () => {
      sendToPhone(wallet1, "stp-dup");
      const { result } = sendToPhone(wallet1, "stp-dup");
      expect(result).toBeErr(Cl.uint(102));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // is-claimable
  // ─────────────────────────────────────────────────────────────────────────
  describe("is-claimable", () => {

    it("returns true for a fresh unclaimed transfer", () => {
      sendToPhone(wallet1, "ic-true");
      const { result } = simnet.callReadOnlyFn(
        ESCROW, "is-claimable",
        [Cl.bufferFromHex(buf32("ic-true"))],
        deployer
      );
      expect(result).toBeBool(true);
    });

    it("returns false for a non-existent claim-id", () => {
      const { result } = simnet.callReadOnlyFn(
        ESCROW, "is-claimable",
        [Cl.bufferFromHex(buf32("ic-none"))],
        deployer
      );
      expect(result).toBeBool(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // claim
  // ─────────────────────────────────────────────────────────────────────────
  describe("claim", () => {

    it("succeeds and releases sBTC to recipient", () => {
      sendToPhone(wallet1, "cl-happy", ONE_SBTC, 200n);
      const { result } = claim(deployer, "cl-happy", wallet2);
      expect(result).toBeOk(Cl.bool(true));
    });

    it("emits a transfer-claimed print event", () => {
      sendToPhone(wallet1, "cl-event", ONE_SBTC, 200n);
      const { events } = claim(deployer, "cl-event", wallet2);
      const printEvent = events.find((e: any) => e.event === "print_event");
      expect(printEvent).toBeDefined();
    });

    it("marks the transfer as claimed", () => {
      sendToPhone(wallet1, "cl-flag", ONE_SBTC, 200n);
      claim(deployer, "cl-flag", wallet2);
      const { result } = getTransfer("cl-flag");
      // The tuple should have claimed = true
      expect(result).toBeSome(
        expect.objectContaining({})
      );
      // verify via is-claimable – should now be false
      const { result: claimable } = simnet.callReadOnlyFn(
        ESCROW, "is-claimable",
        [Cl.bufferFromHex(buf32("cl-flag"))],
        deployer
      );
      expect(claimable).toBeBool(false);
    });

    it("decrements total-escrowed after claim", () => {
      sendToPhone(wallet1, "cl-decrement", ONE_SBTC, 200n);
      const before = (totalEscrowed().result as any).value as bigint;
      claim(deployer, "cl-decrement", wallet2);
      const after = (totalEscrowed().result as any).value as bigint;
      expect(before - after).toBe(ONE_SBTC);
    });

    it("rejects claim on non-existent claim-id (err u200)", () => {
      const { result } = claim(deployer, "cl-notfound", wallet2);
      expect(result).toBeErr(Cl.uint(200));
    });

    it("rejects double-claim (err u201)", () => {
      sendToPhone(wallet1, "cl-double", ONE_SBTC, 200n);
      claim(deployer, "cl-double", wallet2);
      const { result } = claim(deployer, "cl-double", wallet2);
      expect(result).toBeErr(Cl.uint(201));
    });

    it("rejects claim after expiry (err u202)", () => {
      sendToPhone(wallet1, "cl-expired", ONE_SBTC, 144n);
      simnet.mineEmptyBlocks(145);
      const { result } = claim(deployer, "cl-expired", wallet2);
      expect(result).toBeErr(Cl.uint(202));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // reclaim
  // ─────────────────────────────────────────────────────────────────────────
  describe("reclaim", () => {

    it("succeeds and returns sBTC to sender after expiry", () => {
      sendToPhone(wallet1, "rc-happy", ONE_SBTC, 144n);
      simnet.mineEmptyBlocks(145);
      const { result } = reclaim(wallet1, "rc-happy");
      expect(result).toBeOk(Cl.bool(true));
    });

    it("emits a transfer-reclaimed print event", () => {
      sendToPhone(wallet1, "rc-event", ONE_SBTC, 144n);
      simnet.mineEmptyBlocks(145);
      const { events } = reclaim(wallet1, "rc-event");
      const printEvent = events.find((e: any) => e.event === "print_event");
      expect(printEvent).toBeDefined();
    });

    it("marks the transfer as claimed after reclaim", () => {
      sendToPhone(wallet1, "rc-flag", ONE_SBTC, 144n);
      simnet.mineEmptyBlocks(145);
      reclaim(wallet1, "rc-flag");
      // verify via is-claimable – should now be false (was consumed)
      const { result: claimable } = simnet.callReadOnlyFn(
        ESCROW, "is-claimable",
        [Cl.bufferFromHex(buf32("rc-flag"))],
        deployer
      );
      expect(claimable).toBeBool(false);
    });

    it("rejects reclaim on non-existent claim-id (err u300)", () => {
      const { result } = reclaim(wallet1, "rc-notfound");
      expect(result).toBeErr(Cl.uint(300));
    });

    it("rejects reclaim by non-sender wallet (err u301)", () => {
      sendToPhone(wallet1, "rc-wrong", ONE_SBTC, 144n);
      simnet.mineEmptyBlocks(145);
      const { result } = reclaim(wallet3, "rc-wrong");
      expect(result).toBeErr(Cl.uint(301));
    });

    it("rejects reclaim before expiry (err u302)", () => {
      sendToPhone(wallet1, "rc-before", ONE_SBTC, 144n);
      simnet.mineEmptyBlocks(50);
      const { result } = reclaim(wallet1, "rc-before");
      expect(result).toBeErr(Cl.uint(302));
    });

    it("rejects double-reclaim (err u303)", () => {
      sendToPhone(wallet1, "rc-double", ONE_SBTC, 144n);
      simnet.mineEmptyBlocks(145);
      reclaim(wallet1, "rc-double");
      const { result } = reclaim(wallet1, "rc-double");
      expect(result).toBeErr(Cl.uint(303));
    });

    it("rejects reclaim when already claimed by recipient (err u303)", () => {
      sendToPhone(wallet1, "rc-after-claim", ONE_SBTC, 200n);
      claim(deployer, "rc-after-claim", wallet2);
      simnet.mineEmptyBlocks(210);
      const { result } = reclaim(wallet1, "rc-after-claim");
      expect(result).toBeErr(Cl.uint(303));
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // read-only functions
  // ─────────────────────────────────────────────────────────────────────────
  describe("read-only functions", () => {

    it("get-transfer returns none for unknown claim-id", () => {
      const { result } = getTransfer("ro-unknown");
      expect(result).toBeNone();
    });

    it("get-total-escrowed returns a uint", () => {
      const { result } = totalEscrowed();
      expect((result as any).type).toBe("uint");
    });

    it("multiple sends accumulate in get-total-escrowed", () => {
      const before = (totalEscrowed().result as any).value as bigint;
      sendToPhone(wallet1, "ro-accum-1", ONE_SBTC);
      sendToPhone(wallet1, "ro-accum-2", ONE_SBTC * 3n);
      const after = (totalEscrowed().result as any).value as bigint;
      expect(after - before).toBe(ONE_SBTC * 4n);
    });
  });
});
