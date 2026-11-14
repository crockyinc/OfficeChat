// Image validation, client-side compression, and chunked transfer.
//
// Flow: validate -> (optionally) compress with canvas -> split into
// 16 KB chunks -> send over the DataChannel with backpressure handling
// -> reassemble on the receiving side.
//
// Pure helpers (chunking, base64) are exported for unit tests.

export const CHUNK_SIZE = 16 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_DIMENSION = 1600;
export const COMPRESS_QUALITY = 0.8;
export const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

export function validateImage(file) {
  if (!file) return { ok: false, error: 'No file selected.' };
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { ok: false, error: 'Only PNG, JPEG, WebP and GIF images are supported.' };
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Image is larger than 10 MB.' };
  }
  if (file.size === 0) return { ok: false, error: 'Image is empty.' };
  return { ok: true };
}

/** Split an ArrayBuffer into fixed-size chunks (last chunk may be short). */
export function chunkBuffer(buffer, chunkSize = CHUNK_SIZE) {
  const chunks = [];
  const view = new Uint8Array(buffer);
  for (let offset = 0; offset < view.length; offset += chunkSize) {
    chunks.push(view.slice(offset, offset + chunkSize));
  }
  return chunks;
}

/** Concatenate chunk byte arrays back into one Uint8Array. */
export function reassembleChunks(chunks, totalBytes) {
  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function bytesToBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Compress an image file with canvas: max 1600px on the long edge,
 * JPEG/WebP at quality 0.8. PNG/GIF with transparency keep PNG output
 * unless the image is very large. Returns { blob, width, height }.
 * If compression fails or the file is small, returns the original.
 */
export async function compressImage(file, { original = false } = {}) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_DIMENSION / Math.max(width, height));
  const outW = Math.round(width * scale);
  const outH = Math.round(height * scale);

  const needsShrink = scale < 1 || file.size > 1024 * 1024;
  if (original || !needsShrink) {
    bitmap.close?.();
    return { blob: file, width, height, compressed: false };
  }

  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, outW, outH);
  bitmap.close?.();

  const keepPng = file.type === 'image/png' || file.type === 'image/gif';
  const type = keepPng ? 'image/png' : 'image/webp';
  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, type, COMPRESS_QUALITY),
  );
  if (!blob || blob.size > MAX_IMAGE_BYTES || (scale === 1 && blob.size >= file.size)) {
    return { blob: file, width, height, compressed: false };
  }
  return { blob, width: outW, height: outH, compressed: true };
}

/** Small JPEG thumbnail data-URL for the img-start message. */
export async function makeThumbnail(blob, maxDim = 320) {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    return canvas.toDataURL('image/jpeg', 0.7);
  } catch {
    return null;
  }
}

/**
 * Send an image over a DataChannel with backpressure.
 * Calls onProgress(sentBytes, totalBytes). Respects `signal` for cancel.
 * Returns true if fully sent, false if cancelled.
 */
export async function sendImageChunks(dc, { id, blob, onProgress, signal, sealFn }) {
  const buffer = await blob.arrayBuffer();
  const chunks = chunkBuffer(buffer);
  const total = buffer.byteLength;

  for (let seq = 0; seq < chunks.length; seq++) {
    if (signal?.aborted) return false;
    // Backpressure: pause while the channel buffer is above the low
    // watermark, resume when it drains.
    while (dc.bufferedAmount > (dc.bufferedAmountLowThreshold || 1 << 20)) {
      if (signal?.aborted) return false;
      if (dc.readyState !== 'open') throw new Error('DataChannel closed');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const payload = { t: 'img-chunk', id, seq, data: bytesToBase64(chunks[seq]) };
    dc.send(JSON.stringify(await sealFn(payload)));
    onProgress?.(Math.min(total, (seq + 1) * CHUNK_SIZE), total);
  }
  return true;
}

/** Reassembles incoming image chunks. */
export class ImageReceiver {
  constructor() {
    this.transfers = new Map(); // id -> { chunks: Map<seq, bytes>, total, received }
  }

  start(id, totalBytes) {
    this.transfers.set(id, { chunks: new Map(), total: totalBytes, received: 0 });
  }

  addChunk(id, seq, bytes) {
    const transfer = this.transfers.get(id);
    if (!transfer) return;
    if (!transfer.chunks.has(seq)) {
      transfer.chunks.set(seq, bytes);
      transfer.received += bytes.length;
    }
  }

  progress(id) {
    const transfer = this.transfers.get(id);
    if (!transfer) return { received: 0, total: 0 };
    return { received: transfer.received, total: transfer.total };
  }

  finish(id) {
    const transfer = this.transfers.get(id);
    if (!transfer) return null;
    this.transfers.delete(id);
    const ordered = [...transfer.chunks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, bytes]) => bytes);
    return reassembleChunks(ordered, transfer.total);
  }

  cancel(id) {
    this.transfers.delete(id);
  }
}
