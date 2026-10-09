// template 纯函数测试（Phase 3 Task 4，B6）。
import { describe, expect, it } from "vitest";
import { extractVars, renderSnippet } from "./template";

describe("extractVars", () => {
  it("抽取变量名并按首现顺序去重", () => {
    expect(extractVars("systemctl restart {{svc}} && {{svc}} status {{env}}")).toEqual([
      "svc",
      "env",
    ]);
  });

  it("容忍花括号内空白", () => {
    expect(extractVars("{{  port  }}")).toEqual(["port"]);
  });

  it("无变量返回空数组；非 \\w 变量名不识别（与渲染面同一正则）", () => {
    expect(extractVars("echo hi")).toEqual([]);
    expect(extractVars("{{a-b}}")).toEqual([]);
  });
});

describe("renderSnippet", () => {
  it("替换变量表中存在的键（全部出现处）", () => {
    expect(renderSnippet("tail -n {{n}} /var/log/{{f}}", { n: "100", f: "syslog" })).toEqual(
      "tail -n 100 /var/log/syslog",
    );
  });

  it("显式空串也替换（留空是用户意图），未知键原样保留", () => {
    expect(renderSnippet("rm {{path}}", { path: "" })).toEqual("rm ");
    expect(renderSnippet("echo {{missing}}", {})).toEqual("echo {{missing}}");
  });

  it("容忍花括号内空白", () => {
    expect(renderSnippet("{{ port }}", { port: "22" })).toEqual("22");
  });

  it("42/43 差异场景：同一模板按每台变量渲染出不同命令", () => {
    const tpl = "echo $((41+{{n}}))";
    expect(renderSnippet(tpl, { n: "1" })).toEqual("echo $((41+1))");
    expect(renderSnippet(tpl, { n: "2" })).toEqual("echo $((41+2))");
  });
});
