import { describe, expect, it } from "vitest";
import { synchronizedScrollTop } from "./ai-comparison-scroll";

describe("AI comparison scroll", () => {
  it("maps proportional scroll positions between independently sized textareas", () => {
    expect(synchronizedScrollTop({
      sourceScrollTop: 450,
      sourceScrollHeight: 1100,
      sourceClientHeight: 200,
      targetScrollHeight: 2100,
      targetClientHeight: 300,
    })).toBe(900);
  });

  it("clamps invalid positions and returns zero when either pane cannot scroll", () => {
    expect(synchronizedScrollTop({
      sourceScrollTop: -50,
      sourceScrollHeight: 1100,
      sourceClientHeight: 200,
      targetScrollHeight: 2100,
      targetClientHeight: 300,
    })).toBe(0);
    expect(synchronizedScrollTop({
      sourceScrollTop: 500,
      sourceScrollHeight: 1100,
      sourceClientHeight: 200,
      targetScrollHeight: 300,
      targetClientHeight: 300,
    })).toBe(0);
  });
});
