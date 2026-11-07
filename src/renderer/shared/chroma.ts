/** Downscale a photo to a max side and re-encode as JPEG (smaller, faster Gemini calls). */
export async function downscale(dataUrl: string, maxSide = 768): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const k = Math.min(1, maxSide / Math.max(img.width, img.height))
  const c = document.createElement('canvas')
  c.width = Math.round(img.width * k)
  c.height = Math.round(img.height * k)
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height)
  return c.toDataURL('image/jpeg', 0.85)
}

/** Put a transparent sprite back on a flat green background (used as a reference image for new poses). */
export async function onGreen(dataUrl: string): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const c = document.createElement('canvas')
  c.width = img.width
  c.height = img.height
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#00ff00'
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.drawImage(img, 0, 0)
  return c.toDataURL('image/jpeg', 0.9)
}

/**
 * Turn a character on a flat #00FF00 background into a transparent PNG, cropped to the pet.
 * Pixels are scored by how much greener than red/blue they are, with a soft edge and despill.
 */
export async function keyOutGreen(dataUrl: string, maxSide = 640): Promise<string> {
  const img = new Image()
  img.src = dataUrl
  await img.decode()
  const k = Math.min(1, maxSide / Math.max(img.width, img.height))
  const w = Math.round(img.width * k)
  const h = Math.round(img.height * k)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(img, 0, 0, w, h)
  const id = ctx.getImageData(0, 0, w, h)
  const px = id.data
  let minX = w, minY = h, maxX = 0, maxY = 0
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i], g = px[i + 1], b = px[i + 2]
    const d = g - Math.max(r, b) // how green-dominant this pixel is
    if (d > 70) {
      px[i + 3] = 0
    } else {
      if (d > 25) px[i + 3] = Math.round(255 * (1 - (d - 25) / 45))
      if (d > 0) px[i + 1] = g - d * 0.85 // despill the green halo on fur edges
      if (px[i + 3] > 40) {
        const p = i / 4
        const x = p % w
        const y = (p / w) | 0
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  ctx.putImageData(id, 0, 0)
  if (maxX <= minX || maxY <= minY) return c.toDataURL('image/png')
  const pad = 6
  const cw = maxX - minX + 1 + pad * 2
  const ch = maxY - minY + 1 + pad * 2
  const out = document.createElement('canvas')
  out.width = cw
  out.height = ch
  out.getContext('2d')!.drawImage(c, minX - pad, minY - pad, cw, ch, 0, 0, cw, ch)
  return out.toDataURL('image/png')
}
