/**
 * A fake local transcriber for contract tests. Reads the audio file it is
 * given (last argument) and prints a deterministic transcript to stdout.
 * Modes via DELOS_FAKE_STT_MODE: ok (default), fail, hang, empty.
 * No network, reads only the file it was handed.
 */
import { readFileSync } from "node:fs";

const mode = process.env.DELOS_FAKE_STT_MODE ?? "ok";
const audioPath = process.argv[process.argv.length - 1];

if (mode === "hang") {
  setInterval(() => {}, 1000);
} else if (mode === "fail") {
  process.stderr.write("fake-stt: decode error\n");
  process.exit(1);
} else if (mode === "empty") {
  process.exit(0);
} else {
  const bytes = readFileSync(audioPath);
  process.stdout.write(`please water the plants tomorrow (${bytes.length} bytes)\n`);
  process.exit(0);
}
