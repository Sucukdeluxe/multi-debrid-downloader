import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const localPath = "release/Real-Debrid-Downloader Setup 1.4.61.exe";
const remoteUrl = "https://codeberg.org/Sucukdeluxe/real-debrid-downloader/releases/download/v1.4.61/Real-Debrid-Downloader%20Setup%201.4.61.exe";
const tmpPath = path.join(os.tmpdir(), "rd-verify-1.4.61.exe");

// Local file info
const localSize = fs.statSync(localPath).size;
const localHash = crypto.createHash("sha512");
localHash.update(fs.readFileSync(localPath));
const localSha = localHash.digest("hex");
console.log("Local file size:", localSize);
console.log("Local SHA512:", localSha.substring(0, 40) + "...");

// Download from Codeberg
console.log("\nDownloading from Codeberg...");
const resp = await fetch(remoteUrl, { redirect: "follow" });
console.log("Status:", resp.status);
console.log("Content-Length:", resp.headers.get("content-length"));

const source = Readable.fromWeb(resp.body);
const target = fs.createWriteStream(tmpPath);
await pipeline(source, target);

const remoteSize = fs.statSync(tmpPath).size;
const remoteHash = crypto.createHash("sha512");
remoteHash.update(fs.readFileSync(tmpPath));
const remoteSha = remoteHash.digest("hex");
console.log("\nRemote file size:", remoteSize);
console.log("Remote SHA512:", remoteSha.substring(0, 40) + "...");

console.log("\nSize match:", localSize === remoteSize);
console.log("SHA512 match:", localSha === remoteSha);

if (localSha !== remoteSha) {
  console.log("\n!!! FILE ON CODEBERG IS CORRUPTED !!!");
  console.log("The upload to Codeberg damaged the file.");

  // Find first difference
  const localBuf = fs.readFileSync(localPath);
  const remoteBuf = fs.readFileSync(tmpPath);
  for (let i = 0; i < Math.min(localBuf.length, remoteBuf.length); i++) {
    if (localBuf[i] !== remoteBuf[i]) {
      console.log(`First byte difference at offset ${i}: local=0x${localBuf[i].toString(16)} remote=0x${remoteBuf[i].toString(16)}`);
      break;
    }
  }
} else {
  console.log("\n>>> File on Codeberg is identical to local file <<<");
  console.log("The problem is on the user's server (network/proxy issue).");
}

fs.unlinkSync(tmpPath);
