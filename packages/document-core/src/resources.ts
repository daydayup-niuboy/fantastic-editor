import { lengthPrefixed, sha256 } from "./hash.js";
import type {
  Diagnostic,
  ResourceKind,
  ResourceReference,
  ResourceSyntax,
  SourceRange,
} from "./model.js";

export interface ClassifiedReference {
  kind: ResourceKind;
  normalizedResolvedRef: string;
  blockedCode?: string;
}

const URI_SCHEME = /^([a-z][a-z\d+.-]*):/i;
const DRIVE_ABSOLUTE = /^[a-z]:[\\/]/i;
const DRIVE_RELATIVE = /^[a-z]:(?![\\/])/i;
const UNC_PATH = /^(?:\\\\|\/\/)/;

function normalizeLocalPath(value: string): { value: string; valid: boolean } {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return { value: value.replace(/\\/g, "/"), valid: false };
  }
  const isUnc = UNC_PATH.test(decoded);
  const slashPath = decoded.replace(/\\/g, "/");
  const prefix = isUnc ? "//" : "";
  const body = isUnc ? slashPath.replace(/^\/+/, "") : slashPath;
  const segments = body.split("/").filter((part) => part !== "" && part !== ".");
  return { value: prefix + segments.join("/"), valid: true };
}

export async function classifyReference(value: string): Promise<ClassifiedReference> {
  if (DRIVE_RELATIVE.test(value)) {
    return {
      kind: "local-path",
      normalizedResolvedRef: normalizeLocalPath(value).value,
      blockedCode: "DRIVE_RELATIVE_PATH_BLOCKED",
    };
  }
  if (DRIVE_ABSOLUTE.test(value) || UNC_PATH.test(value)) {
    const normalized = normalizeLocalPath(value);
    return {
      kind: "local-path",
      normalizedResolvedRef: normalized.value,
      ...(normalized.valid ? {} : { blockedCode: "INVALID_PERCENT_ENCODING" }),
    };
  }

  const scheme = URI_SCHEME.exec(value)?.[1]?.toLowerCase();
  if (!scheme) {
    const normalized = normalizeLocalPath(value);
    return {
      kind: "local-path",
      normalizedResolvedRef: normalized.value,
      ...(normalized.valid ? {} : { blockedCode: "INVALID_PERCENT_ENCODING" }),
    };
  }
  if (scheme === "http" || scheme === "https") {
    return {
      kind: "remote-http",
      normalizedResolvedRef: lengthPrefixed(["remote-http", value]),
      blockedCode: "REMOTE_IMAGE_BLOCKED",
    };
  }
  if (scheme === "data") {
    return {
      kind: "data-uri",
      normalizedResolvedRef: `data-uri:sha256:${await sha256(value)}`,
      blockedCode: "DATA_URI_SOURCE_BLOCKED",
    };
  }
  if (scheme === "file") {
    return {
      kind: "file-uri",
      normalizedResolvedRef: lengthPrefixed(["file-uri", value]),
      blockedCode: "FILE_URI_BLOCKED",
    };
  }
  if (scheme === "app" || scheme === "fantastic-editor") {
    return {
      kind: "app-internal",
      normalizedResolvedRef: lengthPrefixed(["app-internal", value]),
      blockedCode: "APP_INTERNAL_RESOURCE_BLOCKED",
    };
  }
  return {
    kind: "unsupported-scheme",
    normalizedResolvedRef: lengthPrefixed(["unsupported-scheme", value]),
    blockedCode: "UNSUPPORTED_RESOURCE_SCHEME",
  };
}

export interface CreateResourceReferenceInput {
  documentId: string;
  nodeId: string;
  source: SourceRange;
  syntax: ResourceSyntax;
  originalRef: string;
  resolvedRef: string;
}

export async function createResourceReference(
  input: CreateResourceReferenceInput,
): Promise<{ reference: ResourceReference; diagnostic?: Diagnostic }> {
  const classified = await classifyReference(input.resolvedRef);
  const isDataUri = classified.kind === "data-uri";
  const referenceKey = await sha256(
    lengthPrefixed([
      input.documentId,
      String(input.source.from),
      String(input.source.to),
      classified.normalizedResolvedRef,
    ]),
  );
  const reference: ResourceReference = {
    referenceKey,
    nodeId: input.nodeId,
    source: input.source,
    kind: classified.kind,
    syntax: input.syntax,
    originalRef: isDataUri ? "data:[blocked]" : input.originalRef,
    resolvedRef: isDataUri ? "data:[blocked]" : input.resolvedRef,
    normalizedResolvedRef: classified.normalizedResolvedRef,
  };
  if (!classified.blockedCode) return { reference };
  return {
    reference,
    diagnostic: {
      id: `diagnostic-${referenceKey}-${classified.blockedCode}`,
      code: classified.blockedCode,
      severity: "blocking",
      category: "security",
      message: `资源引用已被 P0 安全策略阻止（${classified.kind}）。`,
      source: input.source,
      nodeId: input.nodeId,
      referenceKey,
      suggestedActions: ["改用工作区内经过授权的本地图片路径。"],
    },
  };
}