import { tr } from '@/lib/i18n';
/**
 * 预设形状（名字与 OOXML / pptxgenjs ShapeType 相同，导出时原样写入），按实际宽高生成 SVG 路径，
 * 这样缩放时圆角、箭头头部不变形。导入时不认识的形状用 pptxtojson 给出的路径（path + vb）。
 */

export interface ShapePreset {
  id: string;
  label: string;
}

export const SHAPE_PRESETS: readonly ShapePreset[] = [
  { id: 'rect', label: tr('矩形') },
  { id: 'roundRect', label: tr('圆角矩形') },
  { id: 'ellipse', label: tr('椭圆') },
  { id: 'triangle', label: tr('三角形') },
  { id: 'rtTriangle', label: tr('直角三角形') },
  { id: 'diamond', label: tr('菱形') },
  { id: 'parallelogram', label: tr('平行四边形') },
  { id: 'trapezoid', label: tr('梯形') },
  { id: 'pentagon', label: tr('五边形') },
  { id: 'hexagon', label: tr('六边形') },
  { id: 'octagon', label: tr('八边形') },
  { id: 'star5', label: tr('五角星') },
  { id: 'rightArrow', label: tr('右箭头') },
  { id: 'leftArrow', label: tr('左箭头') },
  { id: 'upArrow', label: tr('上箭头') },
  { id: 'downArrow', label: tr('下箭头') },
  { id: 'chevron', label: tr('V 形箭头') },
  { id: 'homePlate', label: tr('五边形箭头') },
  { id: 'wedgeRectCallout', label: tr('矩形标注') },
  { id: 'plus', label: tr('十字') },
];

const KNOWN = new Set(SHAPE_PRESETS.map((s) => s.id));

export function isKnownShape(id: string): boolean {
  return KNOWN.has(id);
}

const f = (n: number) => Math.round(n * 100) / 100;

function poly(points: Array<[number, number]>): string {
  return `${points.map(([x, y], i) => `${i ? 'L' : 'M'}${f(x)} ${f(y)}`).join(' ')} Z`;
}

function regular(n: number, w: number, h: number, rot = -Math.PI / 2): string {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i += 1) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push([w / 2 + (w / 2) * Math.cos(a), h / 2 + (h / 2) * Math.sin(a)]);
  }
  return poly(pts);
}

export function shapePath(shape: string, w: number, h: number): string {
  const m = Math.min(w, h);
  switch (shape) {
    case 'roundRect': {
      const r = Math.min(m * 0.1667, w / 2, h / 2);
      return `M${f(r)} 0 H${f(w - r)} Q${f(w)} 0 ${f(w)} ${f(r)} V${f(h - r)} Q${f(w)} ${f(h)} ${f(w - r)} ${f(h)} H${f(r)} Q0 ${f(h)} 0 ${f(h - r)} V${f(r)} Q0 0 ${f(r)} 0 Z`;
    }
    case 'ellipse': {
      const rx = w / 2;
      const ry = h / 2;
      return `M0 ${f(ry)} A${f(rx)} ${f(ry)} 0 1 0 ${f(w)} ${f(ry)} A${f(rx)} ${f(ry)} 0 1 0 0 ${f(ry)} Z`;
    }
    case 'triangle':
      return poly([
        [w / 2, 0],
        [w, h],
        [0, h],
      ]);
    case 'rtTriangle':
      return poly([
        [0, 0],
        [w, h],
        [0, h],
      ]);
    case 'diamond':
      return poly([
        [w / 2, 0],
        [w, h / 2],
        [w / 2, h],
        [0, h / 2],
      ]);
    case 'parallelogram': {
      const d = m * 0.25;
      return poly([
        [d, 0],
        [w, 0],
        [w - d, h],
        [0, h],
      ]);
    }
    case 'trapezoid': {
      const d = m * 0.25;
      return poly([
        [d, 0],
        [w - d, 0],
        [w, h],
        [0, h],
      ]);
    }
    case 'pentagon':
      return regular(5, w, h);
    case 'hexagon': {
      const d = m * 0.25;
      return poly([
        [d, 0],
        [w - d, 0],
        [w, h / 2],
        [w - d, h],
        [d, h],
        [0, h / 2],
      ]);
    }
    case 'octagon': {
      const d = m * 0.29;
      return poly([
        [d, 0],
        [w - d, 0],
        [w, d],
        [w, h - d],
        [w - d, h],
        [d, h],
        [0, h - d],
        [0, d],
      ]);
    }
    case 'star5': {
      const pts: Array<[number, number]> = [];
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 1 : 0.382;
        pts.push([w / 2 + (w / 2) * r * Math.cos(a), h / 2 + (h / 2) * r * Math.sin(a)]);
      }
      return poly(pts);
    }
    case 'rightArrow': {
      const head = Math.min(w * 0.5, h * 0.5);
      return poly([
        [0, h * 0.25],
        [w - head, h * 0.25],
        [w - head, 0],
        [w, h / 2],
        [w - head, h],
        [w - head, h * 0.75],
        [0, h * 0.75],
      ]);
    }
    case 'leftArrow': {
      const head = Math.min(w * 0.5, h * 0.5);
      return poly([
        [w, h * 0.25],
        [head, h * 0.25],
        [head, 0],
        [0, h / 2],
        [head, h],
        [head, h * 0.75],
        [w, h * 0.75],
      ]);
    }
    case 'upArrow': {
      const head = Math.min(h * 0.5, w * 0.5);
      return poly([
        [w * 0.25, h],
        [w * 0.25, head],
        [0, head],
        [w / 2, 0],
        [w, head],
        [w * 0.75, head],
        [w * 0.75, h],
      ]);
    }
    case 'downArrow': {
      const head = Math.min(h * 0.5, w * 0.5);
      return poly([
        [w * 0.25, 0],
        [w * 0.75, 0],
        [w * 0.75, h - head],
        [w, h - head],
        [w / 2, h],
        [0, h - head],
        [w * 0.25, h - head],
      ]);
    }
    case 'chevron': {
      const d = Math.min(w * 0.5, h * 0.5);
      return poly([
        [0, 0],
        [w - d, 0],
        [w, h / 2],
        [w - d, h],
        [0, h],
        [d, h / 2],
      ]);
    }
    case 'homePlate': {
      const d = Math.min(w * 0.5, h * 0.5);
      return poly([
        [0, 0],
        [w - d, 0],
        [w, h / 2],
        [w - d, h],
        [0, h],
      ]);
    }
    case 'wedgeRectCallout':
      return poly([
        [0, 0],
        [w, 0],
        [w, h * 0.8],
        [w * 0.42, h * 0.8],
        [w * 0.2, h * 1.12],
        [w * 0.25, h * 0.8],
        [0, h * 0.8],
      ]);
    case 'plus': {
      const dx = w * 0.3;
      const dy = h * 0.3;
      return poly([
        [dx, 0],
        [w - dx, 0],
        [w - dx, dy],
        [w, dy],
        [w, h - dy],
        [w - dx, h - dy],
        [w - dx, h],
        [dx, h],
        [dx, h - dy],
        [0, h - dy],
        [0, dy],
        [dx, dy],
      ]);
    }
    default:
      return `M0 0 H${f(w)} V${f(h)} H0 Z`;
  }
}
