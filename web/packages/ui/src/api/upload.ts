import { MachApiError } from "./errors";
import type { UploadFile } from "./types";

/**
 * Reads a file the person chose (an <input type="file"> or a drop) into the shape the host takes:
 * `{name, content_base64}` inside the operation's JSON body. Checks the extension and size the
 * host would refuse, so the person hears it before anything is sent; the host checks them again,
 * and the engine judges the content.
 *
 *   const file = await uploadFile(input.files[0], uploadLimits.prd, "prd.import");
 *   await client.op("prd.import", { file });
 */
export async function uploadFile(
  file: Blob & { name: string },
  limit: { maxBytes: number; extensions: readonly string[] },
  operation = "upload",
): Promise<UploadFile> {
  const dot = file.name.lastIndexOf(".");
  const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
  if (!limit.extensions.includes(extension)) {
    throw new MachApiError("invalid", `Choose a ${limit.extensions.join(", ")} file.`, operation);
  }
  if (file.size === 0) throw new MachApiError("invalid", "The file is empty.", operation);
  if (file.size > limit.maxBytes) {
    throw new MachApiError("invalid", `The file is larger than ${sizeWords(limit.maxBytes)}.`, operation);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { name: file.name, content_base64: toBase64(bytes) };
}

/** Base64 of bytes, in chunks so a large file never overflows the argument list. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function sizeWords(bytes: number): string {
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)} MB`;
  if (bytes >= 1024 && bytes % 1024 === 0) return `${bytes / 1024} KB`;
  return `${bytes} bytes`;
}
