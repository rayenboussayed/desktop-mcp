/**
 * Screen recording: an open-source stand-in for nut.js' plugin-screenrecording. Captures PNG frames at a fixed
 * rate into a folder and, when `ffmpeg` is installed, encodes an MP4.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { execText } from "../exec.js";
import { grab, nut, sleep, type Rect } from "../nut/runtime.js";
import { which } from "../platform.js";

export const MAX_SECONDS = 60;
export const MAX_FPS = 10;

export interface Recording {
  dir: string;
  frames: number;
  video?: string;
  note?: string;
}

/**
 *
 * @param dir - Directory for recorded frames.
 * @param seconds - Recording duration in seconds.
 * @param fps - Frames per second.
 * @param region - Screen region.
 * @param makeVideo - Whether to encode a video.
 * @returns Metadata for the recording.
 */
export async function record(dir: string, seconds: number, fps: number, region?: Rect, makeVideo = true): Promise<Recording> {
  if (seconds <= 0 || seconds > MAX_SECONDS) throw new Error(`duration must be between 0 and ${MAX_SECONDS} seconds`);
  if (fps <= 0 || fps > MAX_FPS) throw new Error(`fps must be between 0 and ${MAX_FPS}`);
  const n = await nut();
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  await mkdir(dir, { recursive: true });
  const total = Math.max(1, Math.round(seconds * fps));
  const period = 1000 / fps;
  const started = Date.now();
  for (let i = 0; i < total; i++) {
    const due = started + i * period;
    if (due > Date.now()) await sleep(due - Date.now());
    const { jimp } = await grab(n, region);
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await writeFile(path.join(dir, `frame-${String(i + 1).padStart(4, "0")}.png`), await jimp.getBufferAsync("image/png"));
  }
  const rec: Recording = { dir, frames: total };
  if (!makeVideo) return rec;
  if (!which("ffmpeg")) return { ...rec, note: "ffmpeg not found: frames only (install ffmpeg to get an MP4)" };
  const video = path.join(dir, "recording.mp4");
  // even dimensions are required by yuv420p
  const r = await execText("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(fps), "-i", path.join(dir, "frame-%04d.png"), "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2", "-pix_fmt", "yuv420p", video], { timeoutMs: 120_000 });
  return r.code === 0 && !r.error ? { ...rec, video } : { ...rec, note: `ffmpeg failed: ${(r.error?.message ?? r.stderr).trim().slice(0, 200)}` };
}
