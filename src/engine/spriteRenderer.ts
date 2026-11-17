import * as THREE from 'three';
import { EntityType, getEntityTypeMeta, ResolvedNode } from '../types/graph';

const imageCache = new Map<string, HTMLImageElement | 'loading' | 'error'>();
const imageListeners = new Map<string, Set<() => void>>();

export function removeAvatarListener(url: string | undefined, cb: () => void) {
  if (!url) return;
  const set = imageListeners.get(url);
  if (set) {
    set.delete(cb);
    if (set.size === 0) {
      imageListeners.delete(url);
    }
  }
}

/**
 * Loads an external avatar URL with CORS enabled (`Access-Control-Allow-Origin: *`)
 * and notifies both 3D Sprite textures and 2D Canvas views when ready.
 */
export function requestAvatarImage(
  url: string | undefined,
  onReady?: () => void
): HTMLImageElement | null {
  if (!url || !/^(https?:\/\/|\/)/i.test(url.trim())) return null;
  const cached = imageCache.get(url);
  if (cached instanceof HTMLImageElement) {
    return cached;
  }
  if (cached === 'error') {
    return null;
  }
  if (onReady) {
    if (!imageListeners.has(url)) {
      imageListeners.set(url, new Set());
    }
    imageListeners.get(url)!.add(onReady);
  }
  if (cached === 'loading') {
    return null;
  }

  imageCache.set(url, 'loading');
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    imageCache.set(url, img);
    const callbacks = imageListeners.get(url);
    if (callbacks) {
      const cbs = [...callbacks];
      imageListeners.delete(url);
      cbs.forEach((cb) => cb());
    }
  };
  img.onerror = () => {
    imageCache.set(url, 'error');
    imageListeners.delete(url);
  };
  img.src = url;
  return null;
}

function drawPolygonPath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  radius: number,
  sides: number,
  rotation = -Math.PI / 2
) {
  ctx.beginPath();
  for (let i = 0; i < sides; i++) {
    const angle = rotation + (i * Math.PI * 2) / sides;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

export function drawNodeShapePath(
  ctx: CanvasRenderingContext2D,
  entityType: EntityType,
  cx: number,
  cy: number,
  r: number
) {
  switch (entityType) {
    case 'nation':
      // 8-sided regal octagon
      drawPolygonPath(ctx, cx, cy, r, 8, Math.PI / 8);
      break;
    case 'organization':
      // Tactical hexagon
      drawPolygonPath(ctx, cx, cy, r, 6, -Math.PI / 2);
      break;
    case 'family':
      // Heraldic rounded diamond / shield
      drawPolygonPath(ctx, cx, cy, r * 1.06, 4, -Math.PI / 2);
      break;
    case 'school':
      // 6-pointed martial crest / hexagram-octagon
      drawPolygonPath(ctx, cx, cy, r, 6, 0);
      break;
    case 'character':
    default:
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.closePath();
      break;
  }
}

function drawFallbackEmblem(
  ctx: CanvasRenderingContext2D,
  node: ResolvedNode,
  cx: number,
  cy: number,
  r: number,
  accent: string
) {
  // Subtle geometric glyph + bold Chinese character monogram
  ctx.save();
  ctx.strokeStyle = `${accent}55`;
  ctx.lineWidth = Math.max(1.5, r * 0.05);

  if (node.entityType === 'nation') {
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.72, 0, Math.PI * 2);
    ctx.stroke();
  } else if (node.entityType === 'school') {
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.52, cy - r * 0.52);
    ctx.lineTo(cx + r * 0.52, cy + r * 0.52);
    ctx.moveTo(cx + r * 0.52, cy - r * 0.52);
    ctx.lineTo(cx - r * 0.52, cy + r * 0.52);
    ctx.stroke();
  }

  const label = node.name.replace(/[《》()（）·\s]/g, '');
  const monogram = label.slice(0, node.entityType === 'character' ? 1 : 2);
  ctx.fillStyle = '#f8fafc';
  ctx.font = `700 ${Math.round(r * (monogram.length > 1 ? 0.68 : 0.88))}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.shadowColor = accent;
  ctx.shadowBlur = r * 0.25;
  ctx.fillText(monogram, cx, cy + r * 0.03);
  ctx.restore();
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
) {
  const r = Math.min(radius, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function renderCompositeSpriteCanvas(
  canvas: HTMLCanvasElement,
  node: ResolvedNode,
  img: HTMLImageElement | null
) {
  const W = 320;
  const H = 340;
  if (canvas.width !== W) canvas.width = W;
  if (canvas.height !== H) canvas.height = H;

  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, W, H);

  const meta = getEntityTypeMeta(node.entityType);
  const accent = meta.color;
  const cx = W / 2;
  const cy = 122;
  const r =
    node.entityType === 'nation'
      ? 92
      : node.entityType === 'organization'
        ? 82
        : node.entityType === 'school' || node.entityType === 'family'
          ? 76
          : 72;

  // Outer ambient glow
  const grad = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 1.3);
  grad.addColorStop(0, `${accent}55`);
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(cx, cy, r * 1.3, 0, Math.PI * 2);
  ctx.fill();

  // Clipped interior (portrait or dark gradient + monogram)
  ctx.save();
  drawNodeShapePath(ctx, node.entityType, cx, cy, r);
  ctx.clip();

  const bgGrad = ctx.createLinearGradient(cx, cy - r, cx, cy + r);
  bgGrad.addColorStop(0, '#16223b');
  bgGrad.addColorStop(1, '#090e1c');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(cx - r - 4, cy - r - 4, (r + 4) * 2, (r + 4) * 2);

  if (img) {
    // Cover-fit image cleanly inside shape
    const scale = Math.max((r * 2) / img.width, (r * 2) / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
  } else {
    drawFallbackEmblem(ctx, node, cx, cy, r, accent);
  }
  ctx.restore();

  // Crisp primary border ring
  ctx.save();
  drawNodeShapePath(ctx, node.entityType, cx, cy, r);
  ctx.strokeStyle = accent;
  ctx.lineWidth = node.entityType === 'nation' ? 7 : 5.5;
  ctx.stroke();

  if (node.entityType === 'nation' || node.isBridgeNode) {
    drawNodeShapePath(ctx, node.entityType, cx, cy, r + 9);
    ctx.strokeStyle = `${accent}77`;
    ctx.lineWidth = 2.2;
    if (node.isBridgeNode && node.entityType === 'character') {
      ctx.setLineDash([8, 6]);
    }
    ctx.stroke();
  }
  ctx.restore();

  // Cross-arc evolution badge on top-right of avatar
  if (node.hasEvolution) {
    const bx = cx + r * 0.72;
    const by = cy - r * 0.72;
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, 18, 0, Math.PI * 2);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#fbbf24';
    ctx.stroke();
    ctx.fillStyle = '#fbbf24';
    ctx.font = '700 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✦', bx, by + 1);
    ctx.restore();
  }

  // Nameplate pill underneath
  ctx.save();
  const fontSize = node.entityType === 'nation' ? 28 : 25;
  ctx.font = `700 ${fontSize}px "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif`;
  const displayName = node.name.length > 9 ? `${node.name.slice(0, 8)}…` : node.name;
  const textWidth = ctx.measureText(displayName).width;
  const pillW = Math.min(W - 14, Math.max(108, textWidth + 36));
  const pillH = node.title ? 68 : 44;
  const pillX = cx - pillW / 2;
  const pillY = cy + r + 14;

  drawRoundedRect(ctx, pillX, pillY, pillW, pillH, 14);
  ctx.fillStyle = 'rgba(7, 12, 26, 0.90)';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = `${accent}88`;
  ctx.stroke();

  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(displayName, cx, pillY + 23);

  if (node.title) {
    ctx.font = '500 17px "Noto Sans SC", "PingFang SC", sans-serif';
    ctx.fillStyle = '#94a3b8';
    const sub = node.title.length > 13 ? `${node.title.slice(0, 12)}…` : node.title;
    ctx.fillText(sub, cx, pillY + 50);
  }
  ctx.restore();
}

/**
 * Builds a single-draw-call Three.js Sprite combining portrait/crest + nameplate,
 * and auto-updates its CanvasTexture once the remote CDN portrait finishes loading.
 */
export function createNodeThreeSprite(node: ResolvedNode): THREE.Sprite {
  const canvas = document.createElement('canvas');
  let disposed = false;
  const onImgReady = () => {
    if (disposed) return;
    const loaded = requestAvatarImage(node.avatarUrl);
    renderCompositeSpriteCanvas(canvas, node, loaded);
    texture.needsUpdate = true;
  };
  const initialImg = requestAvatarImage(node.avatarUrl, onImgReady);

  renderCompositeSpriteCanvas(canvas, node, initialImg);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
  });

  const sprite = new THREE.Sprite(material);
  sprite.userData.dispose = () => {
    if (disposed) return;
    disposed = true;
    removeAvatarListener(node.avatarUrl, onImgReady);
    texture.dispose();
    material.dispose();
  };
  const scaleBase =
    node.entityType === 'nation'
      ? 34
      : node.entityType === 'organization'
        ? 27
        : node.entityType === 'school' || node.entityType === 'family'
          ? 24
          : 21;
  sprite.scale.set(scaleBase, scaleBase * (340 / 320), 1);
  return sprite;
}
