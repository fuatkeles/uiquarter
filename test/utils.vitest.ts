import { describe, it, expect } from "vitest";
import {
  stableStringify,
  stableReplacer,
  compare,
  sortedRecord,
  computeEmptyHash,
} from "../src/core/utils.js";

describe("stableStringify", () => {
  it("produces deterministic output regardless of key insertion order", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });

  it("sorts nested object keys", () => {
    const obj = { outer: { z: 1, a: 2 }, b: "hello" };
    const parsed = JSON.parse(stableStringify(obj));
    const keys = Object.keys(parsed);
    expect(keys).toEqual(["b", "outer"]);
    const innerKeys = Object.keys(parsed.outer);
    expect(innerKeys).toEqual(["a", "z"]);
  });

  it("preserves arrays in order", () => {
    const obj = { items: [3, 1, 2] };
    const parsed = JSON.parse(stableStringify(obj));
    expect(parsed.items).toEqual([3, 1, 2]);
  });

  it("appends trailing newline", () => {
    const result = stableStringify({ a: 1 });
    expect(result.endsWith("\n")).toBe(true);
  });

  it("handles empty object", () => {
    expect(stableStringify({})).toBe("{}\n");
  });

  it("handles null", () => {
    expect(stableStringify(null)).toBe("null\n");
  });
});

describe("stableReplacer", () => {
  it("sorts object keys", () => {
    const result = stableReplacer("", { c: 1, a: 2, b: 3 });
    expect(Object.keys(result as Record<string, unknown>)).toEqual(["a", "b", "c"]);
  });

  it("returns arrays unchanged", () => {
    const arr = [3, 1, 2];
    expect(stableReplacer("", arr)).toBe(arr);
  });

  it("returns primitives unchanged", () => {
    expect(stableReplacer("", 42)).toBe(42);
    expect(stableReplacer("", "hello")).toBe("hello");
    expect(stableReplacer("", null)).toBe(null);
  });
});

describe("compare", () => {
  it("returns -1 for a < b", () => {
    expect(compare("a", "b")).toBe(-1);
  });

  it("returns 1 for a > b", () => {
    expect(compare("b", "a")).toBe(1);
  });

  it("returns 0 for a === b", () => {
    expect(compare("x", "x")).toBe(0);
  });
});

describe("sortedRecord", () => {
  it("returns record with sorted keys", () => {
    const result = sortedRecord({ z: 1, a: 2, m: 3 });
    expect(Object.keys(result)).toEqual(["a", "m", "z"]);
    expect(result["z"]).toBe(1);
    expect(result["a"]).toBe(2);
  });

  it("handles empty record", () => {
    expect(Object.keys(sortedRecord({}))).toEqual([]);
  });
});

describe("computeEmptyHash", () => {
  it("returns a 64-char hex string", () => {
    const hash = computeEmptyHash();
    expect(typeof hash).toBe("string");
    expect((hash as string).length).toBe(64);
    expect(/^[0-9a-f]+$/.test(hash as string)).toBe(true);
  });

  it("is deterministic", () => {
    expect(computeEmptyHash()).toBe(computeEmptyHash());
  });
});
