#!/usr/bin/env node
import { encodeConnectionCode } from "./code.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf("--" + name);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return fallback;
}

const host = arg("host");
const port = arg("port");
const token = arg("token");
const name = arg("name");
const scheme = arg("scheme");
const fingerprint = arg("fp");

if (!host || !port || !token) {
  process.stderr.write("Usage: node src/gen-code.mjs --host <h> --port <p> --token <t> [--name <n>] [--scheme https] [--fp <sha256>]\n");
  process.exit(2);
}

process.stdout.write(encodeConnectionCode({ host, port, token, name, scheme, fingerprint }) + "\n");
