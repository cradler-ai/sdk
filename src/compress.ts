import { CradlerError } from './errors'

export interface CompressOptions {
  /** Max width in CSS pixels. Default 2000. */
  maxWidth?: number
  /** Max height in CSS pixels. Default 2000. */
  maxHeight?: number
  /** Output quality, 0–1. Default 0.85. */
  quality?: number
  /** Output format. Default 'webp'. */
  format?: 'webp' | 'jpeg'
}

const DEFAULTS: Required<CompressOptions> = {
  maxWidth: 2000,
  maxHeight: 2000,
  quality: 0.85,
  format: 'webp',
}

/** Image MIME types we know how to compress in-browser. SVG is excluded — it's
 *  vector and re-encoding to a raster format would degrade it. */
const COMPRESSIBLE = /^image\/(jpeg|jpg|png|webp|avif|heic|heif|bmp|gif|tiff)$/i

export function isCompressibleImage(blob: Blob): boolean {
  return COMPRESSIBLE.test(blob.type)
}

/**
 * Re-encode and optionally downscale an image Blob in the browser.
 *
 * Browser-only: uses `createImageBitmap` and a canvas. In Node this throws.
 */
export async function compressImage(
  blob: Blob,
  options: CompressOptions = {},
): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') {
    throw new CradlerError(0, {
      code: 'compression_unsupported',
      message:
        'image compression requires a browser environment (createImageBitmap not available)',
    })
  }

  const opts = { ...DEFAULTS, ...options }
  const mime = `image/${opts.format}`

  const bitmap = await createImageBitmap(blob)
  const { width, height } = fitWithin(
    bitmap.width,
    bitmap.height,
    opts.maxWidth,
    opts.maxHeight,
  )

  const canvas = makeCanvas(width, height)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close?.()
    throw new CradlerError(0, {
      code: 'compression_unsupported',
      message: '2d canvas context unavailable in this browser',
    })
  }
  ctx.drawImage(bitmap, 0, 0, width, height)
  bitmap.close?.()

  const out = await canvasToBlob(canvas, mime, opts.quality)

  // If re-encoding made it bigger (rare, e.g. tiny PNGs of flat color), keep
  // the original. We never want to hurt the user's storage bill.
  return out.size < blob.size ? out : blob
}

function fitWithin(
  w: number,
  h: number,
  maxW: number,
  maxH: number,
): { width: number; height: number } {
  if (w <= maxW && h <= maxH) return { width: w, height: h }
  const scale = Math.min(maxW / w, maxH / h)
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement

function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas === 'function') {
    return new OffscreenCanvas(width, height)
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas')
    c.width = width
    c.height = height
    return c
  }
  throw new CradlerError(0, {
    code: 'compression_unsupported',
    message: 'no canvas implementation found in this environment',
  })
}

function canvasToBlob(
  canvas: AnyCanvas,
  type: string,
  quality: number,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) =>
        b
          ? resolve(b)
          : reject(
              new CradlerError(0, {
                code: 'compression_failed',
                message: 'canvas.toBlob returned null',
              }),
            ),
      type,
      quality,
    )
  })
}

/** Swap a path's extension to match the compressed output format. */
export function rewriteExtension(path: string, format: 'webp' | 'jpeg'): string {
  const ext = format === 'jpeg' ? 'jpg' : 'webp'
  const slash = path.lastIndexOf('/')
  const base = slash >= 0 ? path.slice(0, slash + 1) : ''
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${base}${stem}.${ext}`
}
