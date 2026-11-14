// The Rust half of the shell is an Apple-platform target: the crate pulls
// `keyring` with the `apple-native` backend and a macOS-only dependency block,
// so `cargo test` cannot build on Linux or Windows no matter which system
// libraries are present. Run it where it is real, and say plainly that it was
// skipped everywhere else rather than reporting a pass nobody earned.
import { spawnSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src-tauri", "Cargo.toml")

if (process.platform !== "darwin") {
  console.log(`@hundredfold/shell: skipping cargo test on ${process.platform} (the crate targets Apple platforms)`)
  process.exit(0)
}

const result = spawnSync("cargo", ["test", "--manifest-path", manifest], { stdio: "inherit" })
if (result.error) {
  console.error(`@hundredfold/shell: could not run cargo (${result.error.message})`)
  process.exit(1)
}
process.exit(result.status ?? 1)
