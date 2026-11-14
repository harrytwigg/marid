#!/usr/bin/env node
/**
 * Live proof that the RealtimeProvider seam reaches a real model over a real
 * transport: speech in, speech out, with the usage the provider reports.
 *
 * A headless run has no microphone, so the "mic" is a short spoken WAV
 * synthesized through the TTS API just before the round trip — real speech the
 * realtime model has to transcribe, rather than a tone it would ignore. The
 * audio then travels the adapter's own WebSocket, not a hand-rolled one.
 *
 * Usage: node scripts/realtime-echo.mjs [--key sk-...] [--model gpt-realtime]
 *
 * Reads the key from --key or OPENAI_API_KEY. Never reads ~/.hundredfold. Exits
 * non-zero with an explicit reason rather than skipping quietly, so a run that
 * proved nothing can never read as a pass.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROVIDER_MODULE = path.join(REPO_ROOT, "packages/hundredfold/dist/src/talk/realtime/index.js");
const OUT_DIR = path.join(REPO_ROOT, "tmp/realtime-echo");
const SAMPLE_RATE = 24000;
const PROMPT = "Hello! Can you hear me? Please say hello back and count to three.";
const RESPONSE_TIMEOUT_MS = 60000;
/** Observed roughly once in five runs: the socket dies with code 1006, no close
 *  frame, mid-turn. A transport drop, not a protocol refusal, so it is retried. */
const DROPPED = "the connection dropped mid-turn";
const MAX_ATTEMPTS = 2;

/** The only exit path for a run that could not prove anything. */
function unverified(reason) {
  console.error(`UNVERIFIED: ${reason}`);
  process.exit(1);
}

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

/** Wrap raw PCM16 mono so the written file is playable by anything. */
function toWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Synthesize the spoken turn this run sends in place of a microphone. */
async function synthesizePrompt(apiKey) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", input: PROMPT, response_format: "pcm" }),
  });
  if (!response.ok) {
    unverified(`could not synthesize the spoken prompt: ${response.status} ${await response.text()}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/** Feed the prompt audio in realistic-sized chunks, then close the turn. */
function speakInto(provider, pcm) {
  const chunkBytes = SAMPLE_RATE / 10 * 2; // 100 ms of PCM16
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    provider.sendAudio(pcm.subarray(offset, offset + chunkBytes));
  }
  provider.commitAudio();
}

/** Resolve on the first completed assistant turn, collecting its audio. */
function awaitReply(provider) {
  return new Promise((resolve, reject) => {
    const audio = [];
    const transcript = [];
    const timer = setTimeout(() => reject(new Error(`no assistant turn within ${RESPONSE_TIMEOUT_MS} ms`)), RESPONSE_TIMEOUT_MS);
    const fail = (message) => { clearTimeout(timer); reject(new Error(message)); };
    provider.on((event) => {
      if (event.type === "audio") audio.push(event.audio);
      if (event.type === "transcript" && event.final) transcript.push(`${event.role}: ${event.text}`);
      if (event.type === "error") fail(event.message);
      // Report the drop rather than waiting out the timeout on a dead socket.
      if (event.type === "closed") fail(`${DROPPED} (${event.reason})`);
      if (event.type === "turn_done") { clearTimeout(timer); resolve({ audio: Buffer.concat(audio), transcript }); }
    });
  });
}

/** Mint, connect, speak, and wait for one assistant turn. */
async function oneRoundTrip(createRealtimeProvider, apiKey, model) {
  const provider = createRealtimeProvider({ provider: "openai", apiKey, model, turnDetection: "none" });
  const token = await provider.mintEphemeralToken();
  console.log(`minted ephemeral token ${token.value.slice(0, 6)}… expiring at ${new Date(token.expiresAt * 1000).toISOString()}`);

  const prompt = await synthesizePrompt(apiKey);
  console.log(`speaking ${(prompt.length / 2 / SAMPLE_RATE).toFixed(2)}s of audio: "${PROMPT}"`);

  await provider.connect();
  const replying = awaitReply(provider);
  speakInto(provider, prompt);
  try {
    return { reply: await replying, usage: provider.usage() };
  } finally {
    provider.disconnect();
  }
}

function report(reply, usage, outPath) {
  const seconds = (reply.audio.length / 2 / SAMPLE_RATE).toFixed(2);
  console.log(`\nreceived ${reply.audio.length} bytes of audio (${seconds}s at ${SAMPLE_RATE} Hz mono PCM16)`);
  console.log(`wrote ${outPath}`);
  for (const line of reply.transcript) console.log(`  ${line}`);
  console.log("\nobserved usage (tokens):");
  for (const [name, count] of Object.entries(usage)) console.log(`  ${name.padEnd(20)} ${count}`);
}

/** One retry, and only for a dropped connection. A protocol or auth failure is
 *  a real answer and must not be masked by trying again. */
async function roundTripWithRetry(createRealtimeProvider, apiKey, model) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await oneRoundTrip(createRealtimeProvider, apiKey, model);
    } catch (error) {
      if (attempt >= MAX_ATTEMPTS || !error.message.startsWith(DROPPED)) throw error;
      console.log(`${error.message}; retrying once\n`);
    }
  }
}

async function main() {
  const apiKey = flag("key", process.env.OPENAI_API_KEY);
  if (!apiKey) unverified("no API key — pass --key or set OPENAI_API_KEY. This script never reads a Hundredfold home.");
  if (!fs.existsSync(PROVIDER_MODULE)) unverified(`${PROVIDER_MODULE} is missing — run "pnpm build" first.`);

  const { createRealtimeProvider } = await import(PROVIDER_MODULE);
  const { reply, usage } = await roundTripWithRetry(createRealtimeProvider, apiKey, flag("model", "gpt-realtime"));

  if (reply.audio.length === 0) unverified("the model answered but sent no audio");

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, "reply.wav");
  fs.writeFileSync(outPath, toWav(reply.audio));
  report(reply, usage, outPath);
}

main().catch((error) => unverified(error.message));
