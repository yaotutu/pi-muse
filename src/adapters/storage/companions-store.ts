import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { companionPackDir, type DataLayout } from "./data-layout.js";
import { COMPANION_STATES, CompanionError, isCompanionPackId, MAX_COMPANION_PNG_BYTES, type CompanionSnapshot, type CompanionStore } from "../../features/companions/types.js";
import { validateCompanionMetadata, validateCompanionPng } from "../../features/companions/service.js";

const absent = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
const unsafe = () => new CompanionError("UNSAFE_COMPANION_PATH", "Companion paths must be non-link directories and regular files", 409);
const corrupted = () => new CompanionError("INVALID_COMPANION_PACK", "Companion pack contains invalid metadata or PNG", 409);

/** 文件系统边界仅在 adapter。读取不建目录，坏包只报告、不修复；写入先验证现存内容。 */
export const createCompanionStore = (layout: DataLayout): CompanionStore => {
  const directory = async (path: string, create = false): Promise<boolean> => {
    try {
      const entry = await lstat(path);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw unsafe();
      return true;
    } catch (error) {
      if (!absent(error)) throw error;
      if (!create) return false;
      await mkdir(path, { mode: 0o700 });
      return directory(path);
    }
  };
  const container = async (create = false) => {
    if (!await directory(layout.root)) throw unsafe();
    return directory(layout.companionsDir, create);
  };
  const packDirectory = async (id: string, create = false) =>
    await container(create) && await directory(companionPackDir(layout, id), create);
  const regular = async (path: string) => {
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) throw unsafe();
      return entry;
    } catch (error) { if (absent(error)) return null; throw error; }
  };
  const readRegular = async (path: string, maximum: number) => {
    const entry = await regular(path);
    if (!entry) return null;
    if (entry.size > maximum) throw corrupted();
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > maximum) throw corrupted();
      // 有界读取，即使外部文件在 stat 后增长也不会分配无限内存。
      const bytes = Buffer.alloc(maximum + 1);
      let size = 0;
      while (size < bytes.length) {
        const result = await file.read(bytes, size, bytes.length - size, null);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      if (size > maximum) throw corrupted();
      return { bytes: bytes.subarray(0, size), mtimeMs: stat.mtimeMs };
    } finally { await file.close(); }
  };
  const read: CompanionStore["read"] = async (id) => {
    if (!await packDirectory(id)) return null;
    const dir = companionPackDir(layout, id);
    let metadata = { name: id, description: "" };
    let updated = (await lstat(dir)).mtimeMs;
    const manifest = await readRegular(join(dir, "manifest.json"), 16_384);
    if (manifest) {
      try { metadata = validateCompanionMetadata(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifest.bytes)), true); }
      catch { throw corrupted(); }
      updated = Math.max(updated, manifest.mtimeMs);
    }
    const assets: CompanionSnapshot["assets"] = {};
    for (const state of COMPANION_STATES) {
      const asset = await readRegular(join(dir, `${state}.png`), MAX_COMPANION_PNG_BYTES);
      if (!asset) continue;
      try { validateCompanionPng(asset.bytes); } catch { throw corrupted(); }
      assets[state] = asset.bytes;
      updated = Math.max(updated, asset.mtimeMs);
    }
    return { id, ...metadata, assets, updatedAt: new Date(updated).toISOString() };
  };
  const atomicWrite = async (id: string, name: string, bytes: Uint8Array) => {
    await packDirectory(id, true);
    const dir = companionPackDir(layout, id);
    const target = join(dir, name);
    await regular(target);
    const temp = join(dir, `tmp-${randomUUID()}`);
    const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(bytes); } finally { await file.close(); }
      await packDirectory(id);
      await regular(target);
      await rename(temp, target);
    } finally {
      await unlink(temp).catch((error: unknown) => { if (!absent(error)) throw error; });
    }
  };
  const checkTree = async (dir: string): Promise<void> => {
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      const entry = await lstat(path);
      if (entry.isSymbolicLink()) throw unsafe();
      if (entry.isDirectory()) await checkTree(path);
      else if (!entry.isFile()) throw unsafe();
    }
  };
  return {
    read,
    list: async () => {
      const packs: CompanionSnapshot[] = [];
      const diagnostics: { id: string; message: string }[] = [];
      try { if (!await container()) return { packs, diagnostics }; }
      catch { return { packs, diagnostics: [{ id: "companions", message: "Unsafe or unreadable companions directory" }] }; }
      for (const id of (await readdir(layout.companionsDir)).sort()) {
        if (!isCompanionPackId(id)) { diagnostics.push({ id, message: "Invalid companion pack ID" }); continue; }
        try { const pack = await read(id); if (pack) packs.push(pack); }
        catch (error) { diagnostics.push({ id, message: error instanceof CompanionError ? error.message : "Unreadable companion pack" }); }
      }
      return { packs, diagnostics };
    },
    writeMetadata: async (id, metadata) => {
      await read(id);
      await atomicWrite(id, "manifest.json", Buffer.from(JSON.stringify({ schemaVersion: 1, ...metadata }) + "\n"));
    },
    writeAsset: async (id, state, bytes) => {
      await read(id);
      await atomicWrite(id, `${state}.png`, bytes);
    },
    remove: async (id) => {
      if (!await packDirectory(id)) return false;
      const dir = companionPackDir(layout, id);
      await checkTree(dir);
      await packDirectory(id);
      await rm(dir, { recursive: true });
      return true;
    },
  };
};
