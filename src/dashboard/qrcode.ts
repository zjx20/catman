/**
 * 纯 TypeScript 的 QR 码编码器(ISO/IEC 18004),零依赖。
 *
 * 为什么自己实现:本仓库运行时除 Agent SDK 外不引任何依赖,而 iLink 的扫码接口
 * 只返回二维码的**内容**(一个 https://liteapp.weixin.qq.com/... 的 URL),
 * 不返回图片 —— 要在 dashboard 上扫码就必须自己把它编成二维码。
 *
 * 实现范围:byte 模式、纠错等级 M、版本 1–20(最多 666 字节)。
 * iLink 的登录 URL 约 85 字节,落在版本 6 附近,留了足够余量。
 * 不实现 numeric/alphanumeric 模式:byte 模式对任意内容都正确,只是密度略低。
 *
 * 正确性:GF 运算与 RS 编码用 ISO 标准测试向量校验,格式/版本信息用规范里的
 * 固定表校验,整体则用一个独立的解码器做往返验证(见 test/qrcode.test.ts)。
 */

// --- GF(256) 伽罗华域运算,本原多项式 0x11D ---

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** 生成 degree=n 的 RS 生成多项式,系数从高次到低次,首项为 1。 */
export function rsGenerator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j]! ^= poly[j]!;
      next[j + 1]! ^= gfMul(poly[j]!, GF_EXP[i]!);
    }
    poly = next;
  }
  return poly;
}

/** 对数据码字算出 ecLen 个纠错码字。 */
export function rsEncode(data: readonly number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(data.length + ecLen).fill(0);
  for (let i = 0; i < data.length; i++) res[i] = data[i]!;
  for (let i = 0; i < data.length; i++) {
    const coef = res[i]!;
    if (coef === 0) continue;
    // gen[0] 恒为 1,因此这一步必然把 res[i] 清零。
    for (let j = 0; j < gen.length; j++) res[i + j]! ^= gfMul(gen[j]!, coef);
  }
  return res.slice(data.length);
}

// --- 版本参数表(纠错等级 M) ---

/** [每块纠错码字数, 组1块数, 组1数据码字数, 组2块数, 组2数据码字数] */
const EC_TABLE_M: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [10, 1, 16, 0, 0], // v1
  [16, 1, 28, 0, 0],
  [26, 1, 44, 0, 0],
  [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0],
  [16, 4, 27, 0, 0],
  [18, 4, 31, 0, 0],
  [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37],
  [26, 4, 43, 1, 44], // v10
  [30, 1, 50, 4, 51],
  [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38],
  [24, 4, 40, 5, 41],
  [24, 5, 41, 5, 42],
  [28, 7, 45, 3, 46],
  [28, 10, 46, 1, 47],
  [26, 9, 43, 4, 44],
  [26, 3, 44, 11, 45],
  [26, 3, 41, 13, 42], // v20
];

/** 各版本对齐图形的中心坐标(版本 1 无对齐图形)。 */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [
  [], // v1
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50], // v10
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90], // v20
];

const MAX_VERSION = EC_TABLE_M.length;

/** 数据区末尾的剩余位(不足一个码字的部分)。 */
function remainderBits(version: number): number {
  if (version === 1) return 0;
  if (version <= 6) return 7;
  if (version <= 13) return 0;
  return 3; // v14–20
}

/** 某版本的纠错分块参数。导出供解码器(测试)与容量计算复用。 */
export function ecParams(version: number) {
  const row = EC_TABLE_M[version - 1]!;
  const [ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data] = row;
  return { ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data };
}

/** 该版本在 byte 模式下能装的字节数。 */
function capacityBytes(version: number): number {
  const { g1Blocks, g1Data, g2Blocks, g2Data } = ecParams(version);
  const dataCodewords = g1Blocks * g1Data + g2Blocks * g2Data;
  const headerBits = 4 + (version <= 9 ? 8 : 16); // 模式指示符 + 字符计数
  return dataCodewords - Math.ceil(headerBits / 8);
}

// --- 位流 ---

class BitBuffer {
  private readonly bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  /** 补终止符与填充,输出码字数组。 */
  toCodewords(totalDataCodewords: number): number[] {
    const capacity = totalDataCodewords * 8;
    // 终止符最多 4 个 0。
    for (let i = 0; i < 4 && this.bits.length < capacity; i++) this.bits.push(0);
    // 补齐到字节边界。
    while (this.bits.length % 8 !== 0) this.bits.push(0);

    const codewords: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | this.bits[i + j]!;
      codewords.push(byte);
    }
    // 交替填充字节,直到填满数据容量。
    const PAD = [0xec, 0x11];
    while (codewords.length < totalDataCodewords) {
      codewords.push(PAD[(codewords.length - this.bits.length / 8) % 2]!);
    }
    return codewords;
  }
}

// --- 格式信息 / 版本信息(BCH) ---

/** 格式信息:5 位(2 位纠错等级 + 3 位掩码)经 BCH(15,5) 编码后与掩码常量异或。 */
export function formatInfo(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i--) {
    if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

/** 版本信息(版本 ≥ 7):6 位版本号经 BCH(18,6) 编码。 */
export function versionInfo(version: number): number {
  let rem = version << 12;
  for (let i = 17; i >= 12; i--) {
    if ((rem >> i) & 1) rem ^= 0x1f25 << (i - 12);
  }
  return (version << 12) | rem;
}

/** 纠错等级 M 在格式信息里的编码。 */
const EC_LEVEL_M_BITS = 0b00;

// --- 矩阵构建 ---

export interface QrMatrix {
  size: number;
  version: number;
  /** true = 深色模块。 */
  modules: boolean[][];
}

function newGrid(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

/** 画定位图形(7×7)及其分隔带。 */
function placeFinder(m: boolean[][], reserved: boolean[][], row: number, col: number): void {
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const rr = row + r;
      const cc = col + c;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
      const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      m[rr]![cc] = inRing || inCore;
      reserved[rr]![cc] = true;
    }
  }
}

/** 画对齐图形(5×5)。 */
function placeAlignment(m: boolean[][], reserved: boolean[][], version: number): void {
  const coords = ALIGNMENT[version - 1]!;
  const size = m.length;
  for (const r of coords) {
    for (const c of coords) {
      // 与三个定位图形重叠的位置不画。
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const isRing = Math.abs(dr) === 2 || Math.abs(dc) === 2;
          const isCenter = dr === 0 && dc === 0;
          m[r + dr]![c + dc] = isRing || isCenter;
          reserved[r + dr]![c + dc] = true;
        }
      }
    }
  }
}

function placeTiming(m: boolean[][], reserved: boolean[][]): void {
  const size = m.length;
  for (let i = 8; i < size - 8; i++) {
    const dark = i % 2 === 0;
    m[6]![i] = dark;
    reserved[6]![i] = true;
    m[i]![6] = dark;
    reserved[i]![6] = true;
  }
}

/** 预留格式信息、版本信息与固定深色模块的位置。 */
function reserveInfoAreas(m: boolean[][], reserved: boolean[][], version: number): void {
  const size = m.length;
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      reserved[8]![i] = true;
      reserved[i]![8] = true;
    }
  }
  for (let i = 0; i < 8; i++) {
    reserved[size - 1 - i]![8] = true;
    reserved[8]![size - 1 - i] = true;
  }
  // 固定深色模块,位置恒为 (4×版本 + 9, 8)。
  m[size - 8]![8] = true;
  reserved[size - 8]![8] = true;

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      reserved[r]![c] = true;
      reserved[c]![r] = true;
    }
  }
}

function writeFormatInfo(m: boolean[][], mask: number): void {
  const size = m.length;
  const fmt = formatInfo(EC_LEVEL_M_BITS, mask);
  const bit = (i: number) => ((fmt >> i) & 1) === 1;

  // 第一副本:环绕左上角定位图形。
  for (let i = 0; i <= 5; i++) m[8]![i] = bit(i);
  m[8]![7] = bit(6);
  m[8]![8] = bit(7);
  m[7]![8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i]![8] = bit(i);

  // 第二副本:左下竖排 7 位 + 右上横排 8 位。
  // 竖排到 size-7 为止 —— size-8 那格是固定深色模块,不属于格式信息;
  // 写成 8 位会把它覆盖掉(解码器一并读错,往返测试发现不了)。
  for (let i = 0; i <= 6; i++) m[size - 1 - i]![8] = bit(i);
  for (let i = 7; i <= 14; i++) m[8]![size - 15 + i] = bit(i);
}

function writeVersionInfo(m: boolean[][], version: number): void {
  if (version < 7) return;
  const size = m.length;
  const info = versionInfo(version);
  for (let i = 0; i < 18; i++) {
    const b = ((info >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = size - 11 + (i % 3);
    m[r]![c] = b;
    m[c]![r] = b;
  }
}

/** 掩码函数:返回该坐标是否需要翻转。 */
function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0;
    default:
      return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
  }
}

/** 把码字位流按蛇形顺序填进非功能模块。 */
function placeData(m: boolean[][], reserved: boolean[][], bits: readonly boolean[]): void {
  const size = m.length;
  let idx = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过竖直的定时图形所在列
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (reserved[row]![col]) continue;
        m[row]![col] = idx < bits.length ? bits[idx]! : false;
        idx++;
      }
    }
    upward = !upward;
  }
}

/** 掩码惩罚评分(规则 1–4),分数越低越好。 */
export function penalty(m: readonly boolean[][]): number {
  const size = m.length;
  let score = 0;

  // 规则 1:同色连续 ≥5。
  for (let i = 0; i < size; i++) {
    for (const isRow of [true, false]) {
      let run = 1;
      for (let j = 1; j < size; j++) {
        const cur = isRow ? m[i]![j]! : m[j]![i]!;
        const prev = isRow ? m[i]![j - 1]! : m[j - 1]![i]!;
        if (cur === prev) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  }

  // 规则 2:2×2 同色块。
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r]![c]!;
      if (v === m[r]![c + 1] && v === m[r + 1]![c] && v === m[r + 1]![c + 1]) score += 3;
    }
  }

  // 规则 3:出现 1011101 + 四个浅色 的图样(易与定位图形混淆)。
  const P1 = [true, false, true, true, true, false, true, false, false, false, false];
  const P2 = [false, false, false, false, true, false, true, true, true, false, true];
  for (let i = 0; i < size; i++) {
    for (let j = 0; j + 11 <= size; j++) {
      let rowMatch1 = true;
      let rowMatch2 = true;
      let colMatch1 = true;
      let colMatch2 = true;
      for (let k = 0; k < 11; k++) {
        const rv = m[i]![j + k]!;
        const cv = m[j + k]![i]!;
        if (rv !== P1[k]) rowMatch1 = false;
        if (rv !== P2[k]) rowMatch2 = false;
        if (cv !== P1[k]) colMatch1 = false;
        if (cv !== P2[k]) colMatch2 = false;
      }
      if (rowMatch1) score += 40;
      if (rowMatch2) score += 40;
      if (colMatch1) score += 40;
      if (colMatch2) score += 40;
    }
  }

  // 规则 4:深色比例偏离 50%。
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r]![c]) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/** 把数据/纠错码字按块交错,得到最终的码字序列。 */
export function interleave(dataCodewords: readonly number[], version: number): number[] {
  const { ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data } = ecParams(version);

  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let pos = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const block = dataCodewords.slice(pos, pos + g1Data);
    pos += g1Data;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const block = dataCodewords.slice(pos, pos + g2Data);
    pos += g2Data;
    blocks.push(block);
    ecBlocks.push(rsEncode(block, ecPerBlock));
  }

  const out: number[] = [];
  const maxData = Math.max(g1Data, g2Blocks > 0 ? g2Data : 0);
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return out;
}

/** 选一个能装下 byteLen 字节的最小版本。 */
function pickVersion(byteLen: number): number {
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (byteLen <= capacityBytes(v)) return v;
  }
  throw new Error(
    `内容过长(${byteLen} 字节),超出本编码器支持的版本 ${MAX_VERSION}(上限 ${capacityBytes(MAX_VERSION)} 字节)`,
  );
}

/** 把文本编码成 QR 矩阵(byte 模式,纠错等级 M)。 */
export function encodeQr(text: string): QrMatrix {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  const { g1Blocks, g1Data, g2Blocks, g2Data } = ecParams(version);
  const totalData = g1Blocks * g1Data + g2Blocks * g2Data;

  const buf = new BitBuffer();
  buf.put(0b0100, 4); // byte 模式
  buf.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);
  const codewords = interleave(buf.toCodewords(totalData), version);

  const bits: boolean[] = [];
  for (const cw of codewords) {
    for (let i = 7; i >= 0; i--) bits.push(((cw >> i) & 1) === 1);
  }
  for (let i = 0; i < remainderBits(version); i++) bits.push(false);

  const size = version * 4 + 17;

  // 先造出功能图形与预留区,再逐个掩码试排,取惩罚分最低的。
  const base = newGrid(size);
  const reserved = newGrid(size);
  placeFinder(base, reserved, 0, 0);
  placeFinder(base, reserved, 0, size - 7);
  placeFinder(base, reserved, size - 7, 0);
  placeAlignment(base, reserved, version);
  placeTiming(base, reserved);
  reserveInfoAreas(base, reserved, version);

  let best: boolean[][] | undefined;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.map((row) => [...row]);
    placeData(m, reserved, bits);
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r]![c] && maskAt(mask, r, c)) m[r]![c] = !m[r]![c];
      }
    }
    writeFormatInfo(m, mask);
    writeVersionInfo(m, version);
    const score = penalty(m);
    if (score < bestScore) {
      bestScore = score;
      best = m;
    }
  }

  return { size, version, modules: best! };
}

/**
 * 渲染成 SVG。用 SVG 而非 PNG:不需要实现图片编码,矢量在任何缩放下都清晰,
 * 且能直接作为 data URI 放进 <img src>。
 */
export function renderQrSvg(matrix: QrMatrix, quietZone = 4): string {
  const { size, modules } = matrix;
  const total = size + quietZone * 2;
  const rects: string[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r]![c]) rects.push(`M${c + quietZone} ${r + quietZone}h1v1h-1z`);
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#fff"/>` +
    `<path d="${rects.join("")}" fill="#000"/>` +
    `</svg>`
  );
}

/** 直接产出可放进 <img src> 的 data URI。 */
export function qrDataUri(text: string): string {
  const svg = renderQrSvg(encodeQr(text));
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
