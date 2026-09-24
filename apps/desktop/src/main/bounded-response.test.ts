import { describe, expect, it } from "vitest";
import { readBoundedResponseText } from "./bounded-response";

describe("bounded response reader", () => {
  it("decodes UTF-8 correctly when a character spans stream chunks", async () => {
    const bytes = new TextEncoder().encode("A中文");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 2));
        controller.enqueue(bytes.slice(2, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    await expect(readBoundedResponseText(new Response(body), bytes.byteLength)).resolves.toBe("A中文");
  });

  it("counts UTF-8 bytes and cancels as soon as the limit is exceeded", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new TextEncoder().encode("中文")); },
      cancel() { cancelled = true; },
    });
    await expect(readBoundedResponseText(new Response(body), 5)).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  it("propagates stream failures", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.error(new Error("network stream failed")); },
    });
    await expect(readBoundedResponseText(new Response(body), 16)).rejects.toThrow("network stream failed");
  });
});
