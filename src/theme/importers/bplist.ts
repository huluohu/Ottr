// bplist.ts（BL-512 清偿，Phase 2 账本 G1）：Apple 二进制 plist（bplist00）最小
// 解析器。手写不引第三方依赖——iTerm2 主题文件用到的节点类型有限（dict/array/
// string/real/int/bool/date/data），约 180 行覆盖；npm 包（bplist-parser 等）
// 是通用全家桶，为一个已知的窄格式拖新依赖树不划算（选型论证见批次报告 §1）。
//
// 格式（binary property list v0.0，Apple Runtime 手册）：
//   * 头 8 字节 = "bplist00"；
//   * 尾 32 字节 trailer：[6 填充][offset_size][ref_size][num_objects u64]
//     [top_object u64][offset_table_offset u64]（多字节均大端）；
//   * offset 表 = num_objects × offset_size，给出每个对象在文件中的字节位；
//   * 对象首字节高半字节 = 类型、低半字节 = info：
//       0x0_ 简单值（0x08=false 0x09=true）；0x1n 整数 2^n 字节（8 字节为有符号）；
//       0x2n 实数 2^n 字节 IEEE754；0x3n 日期（f64，Apple 纪元 2001-01-01）；
//       0x4n data；0x5n ASCII 串；0x6n UTF-16BE 串（长度按码元）；0xAn 数组；
//       0xCn 集合（同数组处理）；0xDn 字典（key refs 后 value refs）。
//       data/串/数组/字典长度 n==0xF 时，后随一个整数对象即真实长度。
//
// 输出：dict→plain object、array→Array、string→string、int/real→number、
// bool→boolean、date→Date、data→Uint8Array。对象引用按 index 记忆化（Apple
// 写出端会去重共享字符串）；仅树形文档受支持（主题导出即此形态）。

/** bplist00 魔数嗅探（主题导入入口分流面；≥8 字节且头 8 字节逐字相等）。 */
export function isBplistMagic(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  const magic = "bplist00";
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== magic.charCodeAt(i)) return false;
  }
  return true;
}

/** 解析二进制 plist → 顶层 JS 值。魔数不符/截断/对象越界 → throw。 */
export function parseBplist(bytes: Uint8Array): unknown {
  if (!isBplistMagic(bytes)) {
    throw new Error("not a binary plist (bad magic)");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 + 32) {
    throw new Error("truncated binary plist (no trailer)");
  }

  // --- trailer（倒数 32 字节）---
  const t = bytes.length - 32;
  const offsetSize = bytes[t + 6];
  const refSize = bytes[t + 7];
  const numObjects = Number(view.getBigUint64(t + 8, false));
  const topObject = Number(view.getBigUint64(t + 16, false));
  const offsetTableOffset = Number(view.getBigUint64(t + 24, false));
  if (offsetSize === 0 || refSize === 0 || numObjects === 0) {
    throw new Error("corrupt binary plist (bad trailer)");
  }
  if (offsetTableOffset + numObjects * offsetSize > bytes.length) {
    throw new Error("truncated binary plist (offset table)");
  }

  // --- offset 表 ---
  const offsets: number[] = [];
  for (let i = 0; i < numObjects; i++) {
    let off = 0;
    const base = offsetTableOffset + i * offsetSize;
    for (let b = 0; b < offsetSize; b++) off = off * 256 + bytes[base + b];
    if (off >= bytes.length) {
      throw new Error("corrupt binary plist (object offset out of range)");
    }
    offsets.push(off);
  }

  const memo = new Map<number, unknown>();

  /** 对象下标 → 解析值（ref_size 宽度大端下标；完成后记忆化——Apple 写出端
   * 会去重共享字符串，重复引用不重复解析； plist 文档是树，环属坏输入）。 */
  function parseRef(index: number): unknown {
    if (index >= numObjects) {
      throw new Error("corrupt binary plist (object index out of range)");
    }
    if (memo.has(index)) return memo.get(index);
    const value = parseObject(offsets[index]);
    memo.set(index, value);
    return value;
  }

  /** 变长量（data/串/数组/字典）：info<0xF 时 info 即长度；info==0xF 时后随
   * 一个整数对象给出真实长度。入参 pos = 对象标记位；返回 [长度, 载荷起点]。 */
  function readCount(pos: number): [number, number] {
    const info = bytes[pos] & 0xf;
    if (info !== 0xf) return [info, pos + 1];
    const intMarker = bytes[pos + 1];
    if ((intMarker >> 4) !== 0x1) {
      throw new Error("corrupt binary plist (length int marker)");
    }
    return readIntBody(intMarker & 0xf, pos + 2);
  }

  /** 整数体（info 半字节定宽 2^n 大端；n=3 为有符号 8 字节）。 */
  function readIntBody(info: number, pos: number): [number, number] {
    const size = 2 ** info;
    if (pos + size > bytes.length) throw new Error("truncated binary plist (int)");
    let value: number;
    if (info === 3) {
      value = Number(view.getBigInt64(pos, false)); // 主题面数值远小于 2^53
    } else {
      value = 0;
      for (let b = 0; b < size; b++) value = value * 256 + bytes[pos + b];
    }
    return [value, pos + size];
  }

  function parseObject(pos: number): unknown {
    const marker = bytes[pos];
    const kind = marker >> 4;
    const info = marker & 0xf;
    switch (kind) {
      case 0x0: {
        if (info === 0x9) return true;
        if (info === 0x8) return false;
        if (info === 0x0) return null;
        throw new Error(`unsupported binary plist simple value: 0x${marker.toString(16)}`);
      }
      case 0x1: {
        const [value] = readIntBody(info, pos + 1);
        return value;
      }
      case 0x2: {
        const size = 2 ** info;
        if (pos + 1 + size > bytes.length) throw new Error("truncated binary plist (real)");
        return info === 2 ? view.getFloat32(pos + 1, false) : view.getFloat64(pos + 1, false);
      }
      case 0x3: {
        // 日期：f64 大端，Apple 纪元 = 2001-01-01T00:00:00Z
        if (pos + 1 + 8 > bytes.length) throw new Error("truncated binary plist (date)");
        const ms = view.getFloat64(pos + 1, false) * 1000 + 978_307_200_000;
        return new Date(ms);
      }
      case 0x4: {
        const [len, start] = readCount(pos);
        if (start + len > bytes.length) throw new Error("truncated binary plist (data)");
        return bytes.slice(start, start + len); // 复制（视图随源 buffer，防外部复用）
      }
      case 0x5: {
        // ASCII 串：逐字节（ASCII 子集，latin1 直转）
        const [len, start] = readCount(pos);
        if (start + len > bytes.length) throw new Error("truncated binary plist (ascii)");
        let s = "";
        for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
        return s;
      }
      case 0x6: {
        // UTF-16BE 串：长度按码元（2×len 字节）；复制后字节序翻转为 LE 再解码
        const [len, start] = readCount(pos);
        if (start + len * 2 > bytes.length) throw new Error("truncated binary plist (utf16)");
        const out = new Uint8Array(len * 2);
        for (let i = 0; i < out.length; i += 2) {
          out[i] = bytes[start + i + 1];
          out[i + 1] = bytes[start + i];
        }
        return new TextDecoder("utf-16le").decode(out);
      }
      case 0xa:
      case 0xc: {
        // 数组 / 集合（集合主题面不出现，按数组同构处理）
        const [count, start] = readCount(pos);
        if (start + count * refSize > bytes.length) {
          throw new Error("truncated binary plist (array)");
        }
        const arr: unknown[] = [];
        for (let i = 0; i < count; i++) {
          let ref = 0;
          for (let b = 0; b < refSize; b++) ref = ref * 256 + bytes[start + i * refSize + b];
          arr.push(parseRef(ref));
        }
        return arr;
      }
      case 0xd: {
        const [count, start] = readCount(pos);
        if (start + count * refSize * 2 > bytes.length) {
          throw new Error("truncated binary plist (dict)");
        }
        const keys: number[] = [];
        const values: number[] = [];
        for (let i = 0; i < count; i++) {
          let k = 0;
          for (let b = 0; b < refSize; b++) k = k * 256 + bytes[start + i * refSize + b];
          keys.push(k);
        }
        const vBase = start + count * refSize;
        for (let i = 0; i < count; i++) {
          let v = 0;
          for (let b = 0; b < refSize; b++) v = v * 256 + bytes[vBase + i * refSize + b];
          values.push(v);
        }
        const obj: Record<string, unknown> = {};
        for (let i = 0; i < count; i++) {
          const key = parseRef(keys[i]);
          if (typeof key !== "string") {
            throw new Error("corrupt binary plist (non-string dict key)");
          }
          obj[key] = parseRef(values[i]);
        }
        return obj;
      }
      default:
        throw new Error(`unsupported binary plist marker: 0x${marker.toString(16)}`);
    }
  }

  const top = parseRef(topObject);
  return top;
}
