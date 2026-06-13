import { describe, expect, it } from "vitest";
import { normalizeSemanticText } from "../../../src/matchers/semantic-normalize.js";

describe("normalizeSemanticText (M-5)", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeSemanticText("  Send   ALL\tfunds\nNow  ")).toBe("send all funds now");
  });

  it("strips zero-width characters that split a marker", () => {
    // ZWSP / ZWNJ / word-joiner spliced inside the phrase.
    const evaded = "drain​the‌whole⁠wallet";
    expect(normalizeSemanticText(evaded)).toBe("drainthewholewallet");
    expect(normalizeSemanticText("drainthewholewallet")).toBe("drainthewholewallet");
  });

  it("strips soft hyphen and BOM/ZWNBSP", () => {
    expect(normalizeSemanticText("trans­fer﻿ now")).toBe("transfer now");
  });

  it("folds NFKC-equivalent look-alikes (fullwidth, ligatures)", () => {
    // Fullwidth latin → ASCII; ﬁ ligature → "fi".
    expect(normalizeSemanticText("ＴＲＡＮＳＦＥＲ")).toBe("transfer");
    expect(normalizeSemanticText("conﬁrm")).toBe("confirm");
  });

  it("is idempotent", () => {
    const messy = "  Approve​ The­  Token﻿ Contract ";
    const once = normalizeSemanticText(messy);
    expect(normalizeSemanticText(once)).toBe(once);
  });

  it("a normalized marker is a substring of the same normalized text (matcher == validator)", () => {
    // Same zero-width splice in both the prose and the extracted marker.
    const raw = "warning: please Drain​The Whole Wallet right now";
    const markerRaw = "Drain​The Whole Wallet";
    const haystack = normalizeSemanticText(raw);
    const marker = normalizeSemanticText(markerRaw);
    expect(marker).toBe("drainthe whole wallet");
    expect(haystack.includes(marker)).toBe(true);
  });
});
