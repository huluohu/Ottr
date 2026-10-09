// 主题文件统一解析入口（BL-512 清偿）：按字节嗅探分流——二进制 plist
// （bplist00 魔数，iTerm2 可选 binary 导出）走 bplist 解析器，不看扩展名；
// 其余解码文本按扩展名分派（.itermcolors → iTerm2 XML plist、.json →
// Windows Terminal scheme、其余先 JSON 后 plist 回落——SecuritySettings 既有
// 惯例原样上收为可测函数）。返回按序 scheme 列表（id 戳由调用方分配）。
import { isBplistMagic } from "./bplist";
import { parseItermColors, parseItermColorsBinary, type ParsedColorScheme } from "./iterm";
import { parseWintermSchemes } from "./winterm";

export function parseThemeFileBytes(fileName: string, bytes: Uint8Array): ParsedColorScheme[] {
  if (isBplistMagic(bytes)) {
    return [parseItermColorsBinary(bytes)];
  }
  const text = new TextDecoder().decode(bytes);
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".itermcolors")) {
    return [parseItermColors(text)];
  }
  if (lower.endsWith(".json")) {
    return parseWintermSchemes(text).schemes;
  }
  try {
    return parseWintermSchemes(text).schemes;
  } catch {
    return [parseItermColors(text)];
  }
}
