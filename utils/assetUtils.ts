const ASSET_PREFIX = '__LOCALSHIP_ASSET_V1__:';

export interface EncodedAssetMeta {
  mime: string;
  name?: string;
  size?: number;
}

export interface EncodedAssetPayload {
  meta: EncodedAssetMeta;
  base64: string;
}

const ASSET_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp',
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a',
  '.mp4', '.webm', '.mov',
  '.glb', '.gltf', '.bin',
  '.woff', '.woff2', '.ttf', '.otf',
  '.pdf'
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pdf': 'application/pdf'
};

const normalizeFilename = (name: string): string => name.trim().replace(/\\/g, '/');

export const getFileExtension = (filename: string): string => {
  const name = normalizeFilename(filename);
  const idx = name.lastIndexOf('.');
  if (idx < 0) return '';
  return name.slice(idx).toLowerCase();
};

export const isAssetFilename = (filename: string): boolean => {
  return ASSET_EXTENSIONS.has(getFileExtension(filename));
};

export const inferAssetMimeType = (filename: string): string => {
  const ext = getFileExtension(filename);
  return MIME_BY_EXTENSION[ext] || 'application/octet-stream';
};

export const encodeAssetPayload = (params: {
  base64: string;
  mime: string;
  name?: string;
  size?: number;
}): string => {
  const meta: EncodedAssetMeta = {
    mime: params.mime || 'application/octet-stream',
    name: params.name,
    size: params.size
  };
  return `${ASSET_PREFIX}${JSON.stringify(meta)}\n${params.base64}`;
};

export const decodeAssetPayload = (content: string): EncodedAssetPayload | null => {
  if (!content || !content.startsWith(ASSET_PREFIX)) return null;
  const firstLineBreak = content.indexOf('\n');
  if (firstLineBreak < 0) return null;

  const metaRaw = content.slice(ASSET_PREFIX.length, firstLineBreak).trim();
  const base64 = content.slice(firstLineBreak + 1).trim();
  if (!metaRaw || !base64) return null;

  try {
    const parsed = JSON.parse(metaRaw);
    return {
      meta: {
        mime: typeof parsed?.mime === 'string' && parsed.mime.trim() ? parsed.mime : 'application/octet-stream',
        name: typeof parsed?.name === 'string' ? parsed.name : undefined,
        size: typeof parsed?.size === 'number' ? parsed.size : undefined
      },
      base64
    };
  } catch {
    return null;
  }
};

export const isEncodedAssetContent = (content: string): boolean => {
  return typeof content === 'string' && content.startsWith(ASSET_PREFIX);
};

export const toAssetDataUrl = (payload: EncodedAssetPayload): string => {
  return `data:${payload.meta.mime || 'application/octet-stream'};base64,${payload.base64}`;
};

export const arrayBufferToBase64 = (buffer: ArrayBuffer): string => {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...Array.from(chunk));
  }
  return btoa(binary);
};

export const base64ToUint8Array = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
};

export const base64ToArrayBuffer = (base64: string): ArrayBuffer => {
  return base64ToUint8Array(base64).buffer as ArrayBuffer;
};

export const normalizeAssetPath = (filename: string): string => {
  return normalizeFilename(filename).replace(/^\.?\//, '');
};

export const toAssetContextPlaceholder = (filename: string, content: string): string => {
  const payload = decodeAssetPayload(content);
  if (!payload) return content;
  const mime = payload.meta.mime || inferAssetMimeType(filename);
  const bytes = payload.meta.size ?? Math.floor((payload.base64.length * 3) / 4);
  const kb = Math.max(1, Math.round(bytes / 1024));
  return `[binary asset omitted: ${filename} | ${mime} | ~${kb}KB]`;
};
