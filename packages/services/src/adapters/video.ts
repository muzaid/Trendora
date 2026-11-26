import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Video provider adapter (spec §9): signed direct upload, asynchronous transcode,
 * moderation hooks, playback tokens and deletion. Mux / Cloudflare Stream adapters
 * implement the same interface; the SANDBOX adapter stores files locally.
 */
export interface TranscodeResult {
  ok: boolean;
  failureReason?: string;
  durationMs?: number;
  contentHash?: string;
  sizeBytes?: number;
  playbackId?: string;
  contentType?: string;
}

export interface VideoProvider {
  readonly name: string;
  readonly isSandbox: boolean;
  /** Store raw upload bytes (sandbox) — real providers receive uploads directly. */
  acceptUpload(uploadId: string, data: Buffer, contentType: string): Promise<void>;
  transcode(uploadId: string, limits: { maxBytes: number; minDurationMs: number; maxDurationMs: number; allowedContentTypes: string[] }): Promise<TranscodeResult>;
  readPlayback(playbackId: string): Promise<{ data: Buffer; contentType: string } | null>;
  delete(uploadId: string): Promise<void>;
}

/** Magic-byte sniffing: never trust the declared content type. */
export function sniffVideoType(buf: Buffer): string | null {
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    return brand.startsWith('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

export class SandboxVideoProvider implements VideoProvider {
  readonly name = 'sandbox';
  readonly isSandbox = true;
  private readonly dir: string;
  constructor(mediaDir: string) {
    this.dir = resolve(mediaDir);
  }
  private path(kind: 'uploads' | 'playback', id: string) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error('invalid media id');
    return join(this.dir, kind, id);
  }
  async acceptUpload(uploadId: string, data: Buffer, contentType: string) {
    await mkdir(join(this.dir, 'uploads'), { recursive: true });
    await writeFile(this.path('uploads', uploadId), data);
    await writeFile(this.path('uploads', uploadId) + '.type', contentType);
  }
  async transcode(uploadId: string, limits: { maxBytes: number; minDurationMs: number; maxDurationMs: number; allowedContentTypes: string[] }): Promise<TranscodeResult> {
    const src = this.path('uploads', uploadId);
    let data: Buffer;
    try {
      const s = await stat(src);
      if (s.size > limits.maxBytes) return { ok: false, failureReason: 'FILE_TOO_LARGE' };
      data = await readFile(src);
    } catch {
      return { ok: false, failureReason: 'UPLOAD_MISSING' };
    }
    const type = sniffVideoType(data);
    if (!type || !limits.allowedContentTypes.includes(type)) return { ok: false, failureReason: 'UNSUPPORTED_OR_MALICIOUS_FILE' };
    const durationMs = await probeDurationMs(src);
    if (durationMs === null) return { ok: false, failureReason: 'UNREADABLE_MEDIA' };
    if (durationMs < limits.minDurationMs || durationMs > limits.maxDurationMs) return { ok: false, failureReason: 'DURATION_OUT_OF_RANGE' };
    // "Transcode": strip container metadata (location, device) by remuxing when ffmpeg exists.
    await mkdir(join(this.dir, 'playback'), { recursive: true });
    const playbackId = `pb_${uploadId}`;
    const out = this.path('playback', playbackId);
    const stripped = await stripMetadata(src, out, type);
    if (!stripped) await writeFile(out, data);
    await writeFile(out + '.type', type);
    return { ok: true, durationMs, contentHash: createHash('sha256').update(data).digest('hex'), sizeBytes: data.length, playbackId, contentType: type };
  }
  async readPlayback(playbackId: string) {
    try {
      const p = this.path('playback', playbackId);
      return { data: await readFile(p), contentType: (await readFile(p + '.type', 'utf8')).trim() };
    } catch {
      return null;
    }
  }
  async delete(uploadId: string) {
    for (const p of [this.path('uploads', uploadId), this.path('playback', `pb_${uploadId}`)]) {
      await rm(p, { force: true });
      await rm(p + '.type', { force: true });
    }
  }
}

async function probeDurationMs(file: string): Promise<number | null> {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { timeout: 15_000 });
    const s = Number.parseFloat(stdout.trim());
    return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null;
  } catch (e) {
    // ffprobe unavailable: accept with a nominal duration in sandbox only.
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 15_000;
    return null;
  }
}

async function stripMetadata(src: string, out: string, type: string): Promise<boolean> {
  const fmt = type === 'video/webm' ? 'webm' : 'mp4';
  try {
    await run('ffmpeg', ['-y', '-v', 'error', '-i', src, '-map_metadata', '-1', '-c', 'copy', '-f', fmt, out], { timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}
