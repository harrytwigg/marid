import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveBin } from "../shared/resolve-bin.js";
import type { ArchiveCodec } from "./codec.js";

/** What a home is worth keeping: configuration and authored content. */
export const ARCHIVE_INCLUDES = ["config.yaml", "cron", "docs", "knowledge", "org", "secrets", "skills"] as const;

/**
 * Reproducible caches and nested checkouts. A skill that vendors its own git
 * clone can be larger than the rest of the home put together, and none of it is
 * content the operator would lose. Each pattern carries a leading wildcard-slash
 * so it matches at any depth in both bsdtar and GNU tar, the top level included,
 * since every entry is emitted relative to the home directory.
 */
export const ARCHIVE_EXCLUDES = [
  "*/node_modules", "*/tmp", "*/uploads", "*/.git", "*/.venv", "*/__pycache__",
] as const;

export interface ArchiveResult {
  uncompressedBytes: number;
  compressedBytes: number;
  sha256: string;
}

function archiveArgv(home: string): string[] {
  const present = ARCHIVE_INCLUDES.filter((entry) => fs.existsSync(path.join(home, entry)));
  if (present.length === 0) throw new Error(`nothing to archive in ${home}`);
  return [
    "-cf", "-", "-C", home,
    ...ARCHIVE_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
    ...present.map((entry) => `./${entry}`),
  ];
}

function failed(name: string, code: number | null, stderr: string): Error {
  return new Error(`${name} exited with ${code ?? "a signal"}: ${stderr.trim().split("\n").slice(-3).join("; ")}`);
}

/**
 * Settles an archive promise exactly once.
 *
 * Success needs every part to finish - tar, the compressor and the file - not
 * just the file to close: resolving on the file alone reports a half-written
 * archive as a good one.
 */
function settleOnce(parts: number, cleanup: () => void, resolve: () => void, reject: (error: Error) => void) {
  let settled = false;
  let pending = parts;
  return {
    fail(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    },
    finished(): void {
      pending -= 1;
      if (pending > 0 || settled) return;
      settled = true;
      resolve();
    },
  };
}

interface ArchivePipeline {
  tar: ChildProcess;
  compressor: ChildProcess;
  output: fs.WriteStream;
  hash: crypto.Hash;
  result: ArchiveResult;
  codec: ArchiveCodec;
}

type Settlement = ReturnType<typeof settleOnce>;

function wireArchive(parts: ArchivePipeline, settle: Settlement): void {
  const { tar, compressor, output, hash, result, codec } = parts;
  let tarErrors = "";
  let codecErrors = "";
  let archiveFullyRead = false;
  const truncated = (): Error =>
    new Error(`${codec.id} stopped reading before the archive was complete: ${codecErrors.trim() || "broken pipe"}`);

  tar.stderr!.on("data", (chunk: Buffer) => { tarErrors += chunk.toString(); });
  compressor.stderr!.on("data", (chunk: Buffer) => { codecErrors += chunk.toString(); });
  tar.stdout!.on("data", (chunk: Buffer) => { result.uncompressedBytes += chunk.length; });
  tar.stdout!.on("end", () => { archiveFullyRead = true; });
  compressor.stdout!.on("data", (chunk: Buffer) => {
    result.compressedBytes += chunk.length;
    hash.update(chunk);
  });

  for (const [name, child] of [["tar", tar], ["compressor", compressor]] as const) {
    child.on("error", (error) => settle.fail(new Error(`${name} could not be started: ${error.message}`)));
  }
  tar.on("close", (code) => { if (code === 0) settle.finished(); else settle.fail(failed("tar", code, tarErrors)); });
  compressor.on("close", (code) => {
    if (code !== 0) return settle.fail(failed(codec.id, code, codecErrors));
    // The compressor cannot finish before tar's output ends, because that end
    // is its own EOF. Reaching here first means it stopped reading early, so
    // the archive is short - and once Node unpipes a broken destination, tar
    // blocks on a stream nothing drains and its exit code never arrives.
    if (!archiveFullyRead) return settle.fail(truncated());
    settle.finished();
  });
  output.on("error", settle.fail);
  output.on("close", settle.finished);

  // An unhandled EPIPE on the pipe into a compressor that has already exited
  // takes the whole process down, turning one bad target into a dead run.
  const pipeError = (error: NodeJS.ErrnoException): void =>
    settle.fail(error.code === "EPIPE" ? truncated() : error);
  tar.stdout!.on("error", pipeError);
  compressor.stdin!.on("error", pipeError);
  tar.stdout!.pipe(compressor.stdin!);
  compressor.stdout!.pipe(output);
}

/**
 * Decodes the archive that was just written and counts what comes out.
 *
 * A codec that reads the whole stream and then writes only part of it leaves
 * tar exiting 0 behind a compressor exiting 0, over a file that is neither
 * empty nor corrupt on its face - nothing in the pipeline can tell that from a
 * good archive. Reading it back can: an archive that does not decode to the
 * bytes tar produced is not a backup, whatever the exit codes said.
 */
function readbackBytes(archive: string, codec: ArchiveCodec): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const decoder = spawn(codec.command, codec.decompressArgs, { stdio: ["pipe", "pipe", "pipe"] });
    let bytes = 0;
    let errors = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      decoder.kill();
      reject(error);
    };

    decoder.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    decoder.stdout!.on("data", (chunk: Buffer) => { bytes += chunk.length; });
    decoder.on("error", (error) => fail(new Error(`${codec.id} could not be started: ${error.message}`)));
    decoder.on("close", (code) => {
      if (code !== 0) return fail(failed(codec.id, code, errors));
      if (settled) return;
      settled = true;
      resolve(bytes);
    });

    // A decoder that gives up on a damaged stream is gone before the file has
    // finished feeding it. Its exit code is the honest report of what happened;
    // the EPIPE behind it would only mask that, so the close handler decides.
    decoder.stdin!.on("error", () => {});
    fs.createReadStream(archive).on("error", fail).pipe(decoder.stdin!);
  });
}

/**
 * Streams `tar` into the codec and straight to disk, so a multi-gigabyte home
 * never lands in memory, and counts both sides of the pipe on the way past -
 * uncompressed bytes are what tells the operator a home is growing, compressed
 * bytes are what fills the disk.
 */
function streamHomeArchive(home: string, destination: string, codec: ArchiveCodec): Promise<ArchiveResult> {
  const argv = archiveArgv(home);
  return new Promise<ArchiveResult>((resolve, reject) => {
    const tar = spawn(resolveBin("tar"), argv, { stdio: ["ignore", "pipe", "pipe"] });
    const compressor = spawn(codec.command, codec.compressArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const output = fs.createWriteStream(destination, { mode: 0o600 });
    const hash = crypto.createHash("sha256");
    const result: ArchiveResult = { uncompressedBytes: 0, compressedBytes: 0, sha256: "" };

    const settle = settleOnce(3, () => {
      tar.kill();
      compressor.kill();
      output.destroy();
    }, () => {
      result.sha256 = hash.digest("hex");
      resolve(result);
    }, reject);

    wireArchive({ tar, compressor, output, hash, result, codec }, settle);
  });
}

/** Writes one home's archive and refuses to hand back one that does not decode
 *  to everything tar put into it. */
export async function createHomeArchive(
  home: string,
  destination: string,
  codec: ArchiveCodec,
): Promise<ArchiveResult> {
  const result = await streamHomeArchive(home, destination, codec);
  const decoded = await readbackBytes(destination, codec);
  if (decoded !== result.uncompressedBytes) {
    throw new Error(
      `the archive ${codec.id} wrote reads back as ${decoded} of ${result.uncompressedBytes} bytes`,
    );
  }
  return result;
}

/** Extracts an archive written by {@link createHomeArchive} into `home`. */
export function extractHomeArchive(archive: string, home: string, codec: ArchiveCodec): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const decompressor = spawn(codec.command, codec.decompressArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const tar = spawn(resolveBin("tar"), ["-xf", "-", "-C", home], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      decompressor.kill();
      tar.kill();
      reject(error);
    };

    for (const child of [decompressor, tar]) child.stderr!.on("data", (chunk: Buffer) => { errors += chunk.toString(); });
    for (const [name, child] of [["decompressor", decompressor], ["tar", tar]] as const) {
      child.on("error", (error) => fail(new Error(`${name} could not be started: ${error.message}`)));
    }
    decompressor.on("close", (code) => { if (code !== 0) fail(failed(codec.id, code, errors)); });
    tar.on("close", (code) => {
      if (code !== 0) return fail(failed("tar", code, errors));
      if (settled) return;
      settled = true;
      resolve();
    });

    fs.createReadStream(archive).pipe(decompressor.stdin);
    decompressor.stdout.pipe(tar.stdin);
  });
}
