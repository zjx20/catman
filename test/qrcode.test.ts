import { test } from "node:test";
import assert from "node:assert/strict";
import {
  encodeQr,
  rsEncode,
  rsGenerator,
  formatInfo,
  versionInfo,
  interleave,
  ecParams,
  renderQrSvg,
  qrDataUri,
  type QrMatrix,
} from "../src/dashboard/qrcode.js";

/**
 * 二维码编码器的验证分三层:
 *  1. 用规范里的固定真值校验组件(RS 测试向量、格式/版本信息表、码字总数)
 *  2. 用一个**独立写的解码器**做往返,覆盖排布/掩码/交错
 *  3. 校验功能图形的绝对位置 —— 往返测试对整体转置/镜像是盲的,这一层能抓住
 */

// --- 第 1 层:规范固定真值 ---

test("RS 编码匹配 ISO/IEC 18004 的标准测试向量", () => {
  // 规范附录中 version 1-M、内容 "01234567" 的例子。
  const data = [16, 32, 12, 86, 97, 128, 236, 17, 236, 17, 236, 17, 236, 17, 236, 17];
  const expected = [165, 36, 212, 193, 237, 54, 199, 135, 44, 85];
  assert.deepEqual(rsEncode(data, 10), expected);
});

test("RS 生成多项式首项为 1 且次数正确", () => {
  for (const n of [7, 10, 13, 16, 22, 26, 30]) {
    const gen = rsGenerator(n);
    assert.equal(gen.length, n + 1, `degree ${n}`);
    assert.equal(gen[0], 1, `degree ${n} 首项应为 1`);
  }
});

test("格式信息匹配规范中纠错等级 M 的固定表", () => {
  const M = 0b00;
  const expected = [0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0];
  for (let mask = 0; mask < 8; mask++) {
    assert.equal(formatInfo(M, mask), expected[mask], `mask ${mask}`);
  }
});

test("版本信息匹配规范中版本 7–20 的固定表", () => {
  const expected: Record<number, number> = {
    7: 0x07c94, 8: 0x085bc, 9: 0x09a99, 10: 0x0a4d3, 11: 0x0bbf6, 12: 0x0c762,
    13: 0x0d847, 14: 0x0e60d, 15: 0x0f928, 16: 0x10b78, 17: 0x1145d, 18: 0x12a17,
    19: 0x13532, 20: 0x149a6,
  };
  for (const [v, want] of Object.entries(expected)) {
    assert.equal(versionInfo(Number(v)), want, `version ${v}`);
  }
});

test("各版本的分块参数与规范的码字总数一致", () => {
  // 总码字数 = 各块(数据 + 纠错)之和,是规范给定的固定值。
  const totals = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346,
                  404, 466, 532, 581, 655, 733, 815, 901, 991, 1085];
  for (let v = 1; v <= 20; v++) {
    const { ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data } = ecParams(v);
    const total =
      g1Blocks * (g1Data + ecPerBlock) + g2Blocks * (g2Data + ecPerBlock);
    assert.equal(total, totals[v - 1], `version ${v}`);
  }
});

// --- 第 2 层:独立解码器往返 ---

/** 独立重建功能模块位置(不复用编码器的内部函数)。 */
function functionModules(size: number, version: number): boolean[][] {
  const res = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const mark = (r: number, c: number) => {
    if (r >= 0 && c >= 0 && r < size && c < size) res[r]![c] = true;
  };
  // 定位图形 + 分隔带
  for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(br + r, bc + c);
  }
  // 定时图形
  for (let i = 0; i < size; i++) {
    mark(6, i);
    mark(i, 6);
  }
  // 对齐图形
  const ALIGN: Record<number, number[]> = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
    7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
    11: [6, 30, 54], 12: [6, 32, 58], 13: [6, 34, 62], 14: [6, 26, 46, 66],
    15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78],
    18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
  };
  const coords = ALIGN[version]!;
  for (const r of coords) {
    for (const c of coords) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= size - 9) || (r >= size - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) mark(r + dr, c + dc);
    }
  }
  // 格式信息 + 固定深色模块
  for (let i = 0; i <= 8; i++) {
    mark(8, i);
    mark(i, 8);
  }
  for (let i = 0; i < 8; i++) {
    mark(size - 1 - i, 8);
    mark(8, size - 1 - i);
  }
  // 版本信息
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = size - 11 + (i % 3);
      mark(r, c);
      mark(c, r);
    }
  }
  return res;
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return ((((row * col) % 2) + ((row * col) % 3)) % 2) === 0;
    default: return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
  }
}

/** 从矩阵里读回原文。失败即说明排布/掩码/交错有问题。 */
function decodeQr(qr: QrMatrix): string {
  const { size, version, modules } = qr;

  // 1. 读格式信息,反推掩码编号(取左下/右上那份副本)。
  // 竖排 7 位(size-8 那格是固定深色模块,不是格式信息)+ 横排 8 位。
  const fmtBits: number[] = [];
  for (let i = 0; i <= 6; i++) fmtBits[i] = modules[size - 1 - i]![8] ? 1 : 0;
  for (let i = 7; i <= 14; i++) fmtBits[i] = modules[8]![size - 15 + i] ? 1 : 0;
  let fmt = 0;
  for (let i = 0; i < 15; i++) fmt |= fmtBits[i]! << i;
  const unmasked = fmt ^ 0x5412;
  const ecLevel = (unmasked >> 13) & 0b11;
  const mask = (unmasked >> 10) & 0b111;
  assert.equal(ecLevel, 0b00, "纠错等级应为 M");

  // 2. 去掩码并按蛇形顺序读位。
  const fn = functionModules(size, version);
  const bits: number[] = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const row = upward ? size - 1 - vert : vert;
      for (let c = 0; c < 2; c++) {
        const col = right - c;
        if (fn[row]![col]) continue;
        const v = modules[row]![col]! !== maskAt(mask, row, col);
        bits.push(v ? 1 : 0);
      }
    }
    upward = !upward;
  }

  // 3. 位 → 码字。
  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]!;
    codewords.push(b);
  }

  // 4. 反交错(只取数据部分,纠错码字用不上)。
  const { g1Blocks, g1Data, g2Blocks, g2Data } = ecParams(version);
  const blocks: number[][] = [];
  for (let i = 0; i < g1Blocks; i++) blocks.push(new Array<number>(g1Data));
  for (let i = 0; i < g2Blocks; i++) blocks.push(new Array<number>(g2Data));
  const maxData = Math.max(g1Data, g2Blocks > 0 ? g2Data : 0);
  let pos = 0;
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) {
      if (i < block.length) block[i] = codewords[pos++]!;
    }
  }
  const data = blocks.flat();

  // 5. 解析 byte 模式的头部与内容。
  let bitPos = 0;
  const readBits = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = data[Math.floor(bitPos / 8)]!;
      v = (v << 1) | ((byte >> (7 - (bitPos % 8))) & 1);
      bitPos++;
    }
    return v;
  };
  assert.equal(readBits(4), 0b0100, "应为 byte 模式");
  const len = readBits(version <= 9 ? 8 : 16);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push(readBits(8));
  return new TextDecoder().decode(new Uint8Array(out));
}

test("往返:iLink 真实登录 URL 能被解回原文", () => {
  // 真机 get_bot_qrcode 返回的 qrcode_img_content 形态。
  const url =
    "https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=ff223c79987554ab8949276a47a4ee5a&bot_type=3";
  const qr = encodeQr(url);
  assert.equal(decodeQr(qr), url);
});

test("往返:覆盖各种长度,跨越版本与字符计数位宽的边界", () => {
  // version ≤9 用 8 位字符计数,≥10 用 16 位 —— 边界必须都走到。
  for (const len of [1, 2, 10, 25, 50, 85, 100, 150, 200, 271, 300, 400, 523, 666]) {
    const text = "A".repeat(len);
    const qr = encodeQr(text);
    assert.equal(decodeQr(qr), text, `长度 ${len}(版本 ${qr.version})`);
  }
});

test("往返:非 ASCII 内容(UTF-8 多字节)", () => {
  for (const text of ["中文测试", "emoji 🎉 混排", "https://例え.jp/路径?a=1&b=2"]) {
    assert.equal(decodeQr(encodeQr(text)), text, text);
  }
});

test("往返:每个版本 1–20 都能正确编解码", () => {
  for (let v = 1; v <= 20; v++) {
    const { g1Blocks, g1Data, g2Blocks, g2Data } = ecParams(v);
    const totalData = g1Blocks * g1Data + g2Blocks * g2Data;
    const headerBytes = v <= 9 ? 2 : 3;
    const text = "x".repeat(totalData - headerBytes); // 恰好填满该版本
    const qr = encodeQr(text);
    assert.equal(qr.version, v, `期望版本 ${v},实际 ${qr.version}`);
    assert.equal(decodeQr(qr), text, `version ${v}`);
  }
});

// --- 第 3 层:功能图形的绝对位置(往返测试抓不到转置/镜像) ---

test("定位图形在左上、右上、左下三个角,右下角没有", () => {
  const qr = encodeQr("https://example.com/test");
  const { size, modules } = qr;

  // 完整校验 7×7 结构:外环深、内环浅、3×3 芯深。
  // 只抽查几个点是不够的 —— 对齐图形的中心也是深色,会被误判成定位图形。
  const isFinder = (r0: number, c0: number): boolean => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const onOuter = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        if (modules[r0 + r]![c0 + c] !== (onOuter || inCore)) return false;
      }
    }
    return true;
  };

  assert.ok(isFinder(0, 0), "左上");
  assert.ok(isFinder(0, size - 7), "右上");
  assert.ok(isFinder(size - 7, 0), "左下");
  // 右下角必须**没有**定位图形 —— 这条不对称性是解码时判断方向的依据。
  assert.ok(!isFinder(size - 7, size - 7), "右下不应有定位图形");
});

test("定时图形在第 6 行与第 6 列,且交替", () => {
  const qr = encodeQr("timing pattern check");
  const { size, modules } = qr;
  for (let i = 8; i < size - 8; i++) {
    assert.equal(modules[6]![i], i % 2 === 0, `第 6 行第 ${i} 列`);
    assert.equal(modules[i]![6], i % 2 === 0, `第 ${i} 行第 6 列`);
  }
});

test("固定深色模块在 (4×版本+9, 8)", () => {
  // 位置不对称(不是 (8, 4v+9)),整体转置会被这一条抓住。
  for (const text of ["short", "x".repeat(200)]) {
    const qr = encodeQr(text);
    assert.equal(qr.modules[4 * qr.version + 9]![8], true, `版本 ${qr.version}`);
  }
});

test("矩阵尺寸符合 4×版本+17", () => {
  for (const len of [10, 100, 300]) {
    const qr = encodeQr("y".repeat(len));
    assert.equal(qr.size, 4 * qr.version + 17);
    assert.equal(qr.modules.length, qr.size);
    for (const row of qr.modules) assert.equal(row.length, qr.size);
  }
});

test("交错后的码字总数等于该版本的规范总数", () => {
  for (let v = 1; v <= 20; v++) {
    const { ecPerBlock, g1Blocks, g1Data, g2Blocks, g2Data } = ecParams(v);
    const totalData = g1Blocks * g1Data + g2Blocks * g2Data;
    const out = interleave(new Array<number>(totalData).fill(0), v);
    assert.equal(out.length, totalData + (g1Blocks + g2Blocks) * ecPerBlock, `version ${v}`);
  }
});

// --- 渲染 ---

test("SVG 渲染包含静区且尺寸正确", () => {
  const qr = encodeQr("svg");
  const svg = renderQrSvg(qr, 4);
  assert.match(svg, new RegExp(`viewBox="0 0 ${qr.size + 8} ${qr.size + 8}"`));
  assert.match(svg, /<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
});

test("qrDataUri 产出可直接用于 img src 的 data URI", () => {
  const uri = qrDataUri("https://example.com");
  assert.match(uri, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(uri.split(",")[1]!, "base64").toString("utf8");
  assert.match(svg, /^<svg /);
});

test("内容超出支持范围时明确报错,而不是产出坏二维码", () => {
  // 版本 20 纠错等级 M 在 byte 模式下的上限是 666 字节。
  assert.doesNotThrow(() => encodeQr("z".repeat(666)));
  assert.throws(() => encodeQr("z".repeat(667)), /内容过长/);
});

test("两份格式信息副本内容一致", () => {
  // 规范要求格式信息写两份。上面的解码器只读第二份;这里独立读第一份并比对 ——
  // 任何一份放错位置都会在这里暴露。
  for (const text of ["short", "x".repeat(100), "y".repeat(400)]) {
    const { size, modules } = encodeQr(text);

    const first: number[] = [];
    for (let i = 0; i <= 5; i++) first[i] = modules[8]![i] ? 1 : 0;
    first[6] = modules[8]![7] ? 1 : 0;
    first[7] = modules[8]![8] ? 1 : 0;
    first[8] = modules[7]![8] ? 1 : 0;
    for (let i = 9; i <= 14; i++) first[i] = modules[14 - i]![8] ? 1 : 0;

    const second: number[] = [];
    for (let i = 0; i <= 6; i++) second[i] = modules[size - 1 - i]![8] ? 1 : 0;
    for (let i = 7; i <= 14; i++) second[i] = modules[8]![size - 15 + i] ? 1 : 0;

    assert.deepEqual(first, second, `内容长度 ${text.length}`);
  }
});

test("对齐图形结构正确(5×5:外环深、内环浅、中心深)", () => {
  const qr = encodeQr("x".repeat(89)); // 版本 6,右下有一个对齐图形
  assert.equal(qr.version, 6);
  const center = 34; // 版本 6 的对齐坐标为 [6, 34],仅 (34,34) 不与定位图形重叠
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.abs(dr) === 2 || Math.abs(dc) === 2;
      const isCenter = dr === 0 && dc === 0;
      assert.equal(
        qr.modules[center + dr]![center + dc],
        ring || isCenter,
        `(${center + dr},${center + dc})`,
      );
    }
  }
});
