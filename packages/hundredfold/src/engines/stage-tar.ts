import type { StageFileSet } from "../gateway/department-stage/file-set.js";

/**
 * A department's stage file set as a ustar stream, for the remote sync to unpack
 * (`remote-department-stage.ts`). Regular files only, with the owner-execute bit kept
 * and nothing else about a mode: nothing in it is a link or a device, and no path in it
 * is absolute, holds a `.` or `..` part, or carries a control character, so it unpacks
 * inside the incoming directory and lists one path per line.
 */

const BLOCK = 512;

function tarField(header: Buffer, offset: number, length: number, value: string): void {
  header.write(value, offset, length, "utf-8");
}

function octal(value: number, length: number): string {
  return `${value.toString(8).padStart(length - 1, "0")}\0`;
}

/** A stage path as tar writes it: relative, no `.`/`..`/empty part, no control character. Throws otherwise. */
function checkedStagePath(rel: string): string {
  const control = [...rel].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f);
  if (!rel || rel.startsWith("/") || control || rel.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error(`"${rel}" cannot be staged on a remote host`);
  }
  return rel;
}

/** ustar keeps up to 100 bytes in `name` and 155 in `prefix`, split at a slash. */
function splitTarName(rel: string): { name: string; prefix: string } {
  if (Buffer.byteLength(rel) <= 100) return { name: rel, prefix: "" };
  for (let i = rel.indexOf("/"); i !== -1; i = rel.indexOf("/", i + 1)) {
    const prefix = rel.slice(0, i);
    const name = rel.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new Error(`"${rel}" is too long a path to stage on a remote host`);
}

function tarHeader(rel: string, size: number, mode: number, mtimeSeconds: number): Buffer {
  const header = Buffer.alloc(BLOCK);
  const { name, prefix } = splitTarName(rel);
  tarField(header, 0, 100, name);
  tarField(header, 100, 8, octal(mode, 8));
  tarField(header, 108, 8, octal(0, 8));
  tarField(header, 116, 8, octal(0, 8));
  tarField(header, 124, 12, octal(size, 12));
  tarField(header, 136, 12, octal(mtimeSeconds, 12));
  header.fill(" ", 148, 156);
  tarField(header, 156, 1, "0");
  tarField(header, 257, 6, "ustar\0");
  tarField(header, 263, 2, "00");
  tarField(header, 345, 155, prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  tarField(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

/** The file set as a ustar stream of regular files only: nothing in it is a link or a device. */
export function buildStageTar(files: StageFileSet, now: number = Date.now()): Buffer {
  const mtime = Math.floor(now / 1000);
  const parts: Buffer[] = [];
  for (const [rel, file] of files) {
    parts.push(tarHeader(checkedStagePath(rel), file.content.length, file.executable ? 0o755 : 0o644, mtime));
    parts.push(file.content);
    const pad = (BLOCK - (file.content.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}
