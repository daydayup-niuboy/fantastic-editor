import { createHash, randomUUID } from "node:crypto";
import type { PreviewDerivedEntry } from "@fantastic-editor/shared";
import type { SingleFileResolutionContext } from "./file-sessions.js";
import type { AssetReadResult } from "./single-file-resource-resolver.js";

const HANDLE_LIFETIME_MS = 5 * 60 * 1000;
const MAX_CACHE_BYTES = 128 * 1024 * 1024;
const HASH_PATTERN = /^[a-f\d]{64}$/i;
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

interface CachedDerivedAsset {
  cacheKey: string;
  sourceContentHash: string;
  transformProfile: string;
  transformerVersion: string;
  derivedContentHash: string;
  png: Uint8Array;
  width: number;
  height: number;
  lastUsedAt: number;
}

interface DerivedGrant {
  handleId: string;
  documentId: string;
  workspaceId: string;
  workspaceRevision: number;
  grantId: string;
  cacheKey: string;
  expiresAt: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cacheKey(sourceContentHash: string, transformProfile: string, transformerVersion: string): string {
  return createHash("sha256")
    .update(`${sourceContentHash.length}:${sourceContentHash}`)
    .update(`${transformProfile.length}:${transformProfile}`)
    .update(`${transformerVersion.length}:${transformerVersion}`)
    .digest("hex");
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.byteLength >= PNG_SIGNATURE.length
    && PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

export class PreviewDerivedAssetCache {
  readonly #assets = new Map<string, CachedDerivedAsset>();
  readonly #grants = new Map<string, DerivedGrant>();

  put(
    context: SingleFileResolutionContext,
    referenceKey: string,
    sourceContentHash: string,
    transformProfile: string,
    transformerVersion: string,
    png: Uint8Array,
    width: number,
    height: number,
  ): PreviewDerivedEntry {
    this.prune();
    if (
      !HASH_PATTERN.test(referenceKey)
      || !HASH_PATTERN.test(sourceContentHash)
      || !transformProfile
      || !transformerVersion
      || !isPng(png)
      || !Number.isInteger(width)
      || !Number.isInteger(height)
      || width <= 0
      || height <= 0
      || width > 4096
      || height > 4096
    ) throw new Error("Invalid preview derived asset.");
    const key = cacheKey(sourceContentHash, transformProfile, transformerVersion);
    let asset = this.#assets.get(key);
    if (!asset) {
      const bytes = png.slice();
      asset = {
        cacheKey: key,
        sourceContentHash,
        transformProfile,
        transformerVersion,
        derivedContentHash: sha256(bytes),
        png: bytes,
        width,
        height,
        lastUsedAt: Date.now(),
      };
      this.#assets.set(key, asset);
    } else {
      asset.lastUsedAt = Date.now();
    }
    const handleId = randomUUID();
    this.#grants.set(handleId, {
      handleId,
      documentId: context.documentId,
      workspaceId: context.workspaceId,
      workspaceRevision: context.workspaceRevision,
      grantId: context.grantId,
      cacheKey: key,
      expiresAt: Date.now() + HANDLE_LIFETIME_MS,
    });
    this.evictIfNeeded();
    return {
      referenceKey,
      sourceContentHash,
      transformProfile,
      previewAssetHandle: handleId,
      mimeType: "image/png",
      width: asset.width,
      height: asset.height,
    };
  }

  reuse(
    context: SingleFileResolutionContext,
    referenceKey: string,
    sourceContentHash: string,
    transformProfile: string,
    transformerVersion: string,
  ): PreviewDerivedEntry | undefined {
    this.prune();
    if (!HASH_PATTERN.test(referenceKey) || !HASH_PATTERN.test(sourceContentHash)) return undefined;
    const key = cacheKey(sourceContentHash, transformProfile, transformerVersion);
    const asset = this.#assets.get(key);
    if (!asset) return undefined;
    asset.lastUsedAt = Date.now();
    const handleId = randomUUID();
    this.#grants.set(handleId, {
      handleId,
      documentId: context.documentId,
      workspaceId: context.workspaceId,
      workspaceRevision: context.workspaceRevision,
      grantId: context.grantId,
      cacheKey: key,
      expiresAt: Date.now() + HANDLE_LIFETIME_MS,
    });
    return {
      referenceKey,
      sourceContentHash,
      transformProfile,
      previewAssetHandle: handleId,
      mimeType: "image/png",
      width: asset.width,
      height: asset.height,
    };
  }

  read(handleId: string, context: SingleFileResolutionContext | undefined): AssetReadResult {
    this.prune();
    const grant = this.#grants.get(handleId);
    if (!grant) return { status: "not-found" };
    if (
      !context
      || grant.documentId !== context.documentId
      || grant.workspaceId !== context.workspaceId
      || grant.workspaceRevision !== context.workspaceRevision
      || grant.grantId !== context.grantId
    ) {
      this.#grants.delete(handleId);
      return { status: "stale" };
    }
    const asset = this.#assets.get(grant.cacheKey);
    if (!asset) {
      this.#grants.delete(handleId);
      return { status: "not-found" };
    }
    asset.lastUsedAt = Date.now();
    return {
      status: "ok",
      bytes: asset.png.slice(),
      mimeType: "image/png",
      contentHash: asset.derivedContentHash,
    };
  }

  revoke(handleId: string): void {
    this.#grants.delete(handleId);
  }

  revokeAll(): void {
    this.#grants.clear();
    this.#assets.clear();
  }

  private prune(): void {
    const now = Date.now();
    for (const [handleId, grant] of this.#grants) {
      if (grant.expiresAt <= now) this.#grants.delete(handleId);
    }
    const referenced = new Set([...this.#grants.values()].map((grant) => grant.cacheKey));
    for (const [key, asset] of this.#assets) {
      if (!referenced.has(key) && now - asset.lastUsedAt >= HANDLE_LIFETIME_MS) this.#assets.delete(key);
    }
  }

  private evictIfNeeded(): void {
    let total = [...this.#assets.values()].reduce((size, asset) => size + asset.png.byteLength, 0);
    if (total <= MAX_CACHE_BYTES) return;
    const referenced = new Set([...this.#grants.values()].map((grant) => grant.cacheKey));
    const candidates = [...this.#assets.values()]
      .filter((asset) => !referenced.has(asset.cacheKey))
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const asset of candidates) {
      this.#assets.delete(asset.cacheKey);
      total -= asset.png.byteLength;
      if (total <= MAX_CACHE_BYTES) break;
    }
  }
}