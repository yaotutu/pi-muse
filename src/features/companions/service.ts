import { createHash } from "node:crypto";
import { createSerializedWriter } from "../../shared/serialized-writer.js";
import { COMPANION_STATES, CompanionError, isCompanionPackId, MAX_COMPANION_PNG_BYTES, type CompanionMetadata, type CompanionSnapshot, type CompanionState, type CompanionStore, type CompanionPackSummary } from "./types.js";

export const validateCompanionMetadata = (value: unknown, manifest = false): CompanionMetadata => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompanionError("INVALID_COMPANION_METADATA", "Invalid companion metadata", 400);
  const record = value as Record<string, unknown>;
  const keys = manifest ? ["schemaVersion", "name", "description"] : ["name", "description"];
  if (Object.keys(record).some((key) => !keys.includes(key)) || (manifest && record.schemaVersion !== 1) ||
    typeof record.name !== "string" || !record.name.trim() || record.name.trim().length > 80 ||
    (record.description !== undefined && (typeof record.description !== "string" || record.description.length > 200)))
    throw new CompanionError("INVALID_COMPANION_METADATA", "Invalid companion metadata", 400);
  return { name: record.name.trim(), description: (record.description as string | undefined) ?? "" };
};
export const validateCompanionPng = (bytes: Uint8Array): void => {
  if (bytes.length > MAX_COMPANION_PNG_BYTES) throw new CompanionError("REQUEST_TOO_LARGE", "PNG exceeds 768 KiB", 413);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < signature.length || signature.some((byte, index) => bytes[index] !== byte))
    throw new CompanionError("INVALID_PNG", "Invalid PNG signature", 400);
};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const missing = (pack: CompanionSnapshot) => COMPANION_STATES.filter((state) => !pack.assets[state]);
const summary = (pack: CompanionSnapshot): CompanionPackSummary => {
  const version = createHash("sha256").update(JSON.stringify({ schemaVersion: 1, name: pack.name, description: pack.description }));
  // 按固定状态顺序加入长度边界，避免在两个文件之间搬移字节却得到同一版本。
  for (const state of COMPANION_STATES) {
    const bytes = pack.assets[state]!;
    version.update(`:${bytes.length}:`).update(bytes);
  }
  return { id: pack.id, name: pack.name, description: pack.description, states: [...COMPANION_STATES], version: version.digest("hex"), updatedAt: pack.updatedAt };
};
export const createCompanionService = (store: CompanionStore) => {
  const serial = createSerializedWriter();
  const idOf = (id: string) => {
    if (!isCompanionPackId(id)) throw new CompanionError("INVALID_COMPANION_ID", "Invalid companion pack ID", 400);
    return id;
  };
  const stateOf = (state: string): CompanionState => {
    if (!(COMPANION_STATES as readonly string[]).includes(state)) throw new CompanionError("INVALID_COMPANION_STATE", "Invalid companion state", 400);
    return state as CompanionState;
  };
  const completePack = async (id: string) => {
    idOf(id);
    let pack: CompanionSnapshot | null;
    try { pack = await store.read(id); }
    catch (error) {
      if (!(error instanceof CompanionError) || error.code !== "INVALID_COMPANION_PACK") throw error;
      pack = null;
    }
    if (!pack || missing(pack).length) throw new CompanionError("COMPANION_NOT_FOUND", "Companion pack not found or incomplete", 404);
    return pack;
  };
  return {
    list: () => serial(async () => {
      const { packs, diagnostics } = await store.list();
      const companions: CompanionPackSummary[] = [];
      for (const pack of packs) {
        const absent = missing(pack);
        if (absent.length) diagnostics.push({ id: pack.id, message: `Missing states: ${absent.join(", ")}` });
        else companions.push(summary(pack));
      }
      return { companions, diagnostics };
    }),
    get: (id: string) => serial(async () => ({ companion: summary(await completePack(id)) })),
    asset: (id: string, state: string) => serial(async () => {
      idOf(id);
      const validState = stateOf(state);
      const bytes = (await completePack(id)).assets[validState]!;
      return { bytes, etag: hash(bytes) };
    }),
    saveMetadata: (id: string, value: unknown) => serial(async () => {
      idOf(id);
      const metadata = validateCompanionMetadata(value);
      await store.writeMetadata(id, metadata);
      const pack = (await store.read(id))!;
      const missingStates = missing(pack);
      return { id, ...metadata, complete: missingStates.length === 0, missingStates };
    }),
    saveAsset: (id: string, state: string, dataBase64: unknown) => serial(async () => {
      idOf(id);
      const validState = stateOf(state);
      if (typeof dataBase64 !== "string" || !dataBase64 || dataBase64.startsWith("data:"))
        throw new CompanionError("INVALID_PNG", "Expected strict base64 PNG without data: prefix", 400);
      if (dataBase64.length > Math.ceil(MAX_COMPANION_PNG_BYTES / 3) * 4) throw new CompanionError("REQUEST_TOO_LARGE", "PNG exceeds 768 KiB", 413);
      if (dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64))
        throw new CompanionError("INVALID_PNG", "Expected strict base64 PNG without data: prefix", 400);
      const bytes = Buffer.from(dataBase64, "base64");
      if (bytes.toString("base64") !== dataBase64) throw new CompanionError("INVALID_PNG", "Non-canonical base64", 400);
      validateCompanionPng(bytes);
      await store.writeAsset(id, validState, bytes);
      return { id, state: validState, size: bytes.length, etag: hash(bytes) };
    }),
    remove: (id: string) => serial(async () => {
      if (!await store.remove(idOf(id))) throw new CompanionError("COMPANION_NOT_FOUND", "Companion pack not found", 404);
      return { ok: true as const, id };
    }),
  };
};
export type CompanionService = ReturnType<typeof createCompanionService>;
