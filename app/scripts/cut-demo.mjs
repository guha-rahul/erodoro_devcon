/**
 * Turns record-demo.mjs output into one video: each segment comes from its page's recording at its own time,
 * waits (block confirmations, the CRE workflow) play faster, and the parts join in order.
 *
 *   node scripts/cut-demo.mjs <recording-dir> [<recording-dir> ...] <out.mp4>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const out = path.resolve(args.pop());
if (!args.length) throw new Error("Usage: cut-demo.mjs <recording-dir>... <out.mp4>");
const work = mkdtempSync(path.join(tmpdir(), "rips-cut-"));
const parts = [];

for (const dir of args) {
  const timeline = JSON.parse(readFileSync(path.join(dir, "timeline.json"), "utf8"));
  for (const [i, seg] of timeline.segments.entries()) {
    const page = timeline.pages[seg.page];
    const start = Math.max(0, (seg.from - page.createdAt) / 1000);
    const duration = (seg.to - seg.from) / 1000;
    if (duration < 0.2) continue;
    const part = path.join(work, `${parts.length.toString().padStart(3, "0")}.mp4`);
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", start.toFixed(3), "-t", duration.toFixed(3), "-i", page.video,
      "-vf", `setpts=PTS/${seg.speed},fps=30,scale=${timeline.size.width}:${timeline.size.height}`, "-an",
      "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", part]);
    parts.push(part);
    console.log(`${path.basename(dir)} #${i} ${seg.page} ${start.toFixed(1)}s +${duration.toFixed(1)}s x${seg.speed}`);
  }
}
const list = path.join(work, "list.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", out]);
const seconds = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]).toString().trim();
console.log(`Wrote ${out} (${Number(seconds).toFixed(1)}s)`);
