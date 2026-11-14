import { isInstalled, resolveBin } from "../shared/resolve-bin.js";

export type ArchiveCodecId = "zstd" | "gzip";

export interface ArchiveCodec {
  id: ArchiveCodecId;
  /** Appended to `home.tar`, so a snapshot names its own codec on disk. */
  extension: string;
  command: string;
  compressArgs: string[];
  decompressArgs: string[];
}

/**
 * zstd is worth a lot on a home full of Markdown, but it is not part of a base
 * macOS or Linux install and on this platform it tends to live in a Homebrew
 * directory that a cron PATH does not carry. gzip is always there, so the codec
 * is resolved per run and recorded in the manifest rather than assumed - restore
 * reads it back instead of guessing from the file name.
 *
 * `tar --zstd` is deliberately not used: that is a GNU tar flag and the bsdtar
 * shipped on macOS does not have it.
 */
export function resolveArchiveCodec(isAvailable: (name: string) => boolean = isInstalled): ArchiveCodec {
  if (isAvailable("zstd")) {
    return {
      id: "zstd",
      extension: "tar.zst",
      command: resolveBin("zstd"),
      compressArgs: ["-T0", "-3", "-c"],
      decompressArgs: ["-d", "-c"],
    };
  }
  return {
    id: "gzip",
    extension: "tar.gz",
    command: resolveBin("gzip"),
    compressArgs: ["-c"],
    decompressArgs: ["-d", "-c"],
  };
}

/** The codec a manifest recorded, for restoring a snapshot written elsewhere. */
export function codecForId(id: ArchiveCodecId): ArchiveCodec {
  if (!isInstalled(id)) throw new Error(`this snapshot was written with ${id}, which is not installed here`);
  return resolveArchiveCodec((name) => name === id);
}
