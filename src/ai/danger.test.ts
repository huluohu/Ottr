// danger.ts 单元测试（Task 8 骨架 + Task 13 分级完善）：
// 多行判定、危险规则命中、红黄绿分档、T10 挂账死分支（fork 炸弹错标
// disk-write）清理回归、fix 1/5 分离旗标（rm -r -f）漏报修复与词典键存在性。
import { describe, expect, it } from "vitest";
import zhCN from "../i18n/zh-CN.json";
import enUS from "../i18n/en-US.json";
import { DANGER_RULES, assessPaste, classify, isMultiline, scanDanger } from "./danger";

describe("isMultiline", () => {
  it("LF / CRLF / CR 均算多行", () => {
    expect(isMultiline("ls\npwd")).toBe(true);
    expect(isMultiline("ls\r\npwd")).toBe(true);
    expect(isMultiline("ls\rpwd")).toBe(true);
  });
  it("单行/空串不是多行", () => {
    expect(isMultiline("ls -la")).toBe(false);
    expect(isMultiline("")).toBe(false);
  });
});

describe("scanDanger（规则表面）", () => {
  it("递归强删命中 recursive-delete", () => {
    const f = scanDanger("rm -rf /tmp/x");
    expect(f.map((x) => x.kind)).toContain("recursive-delete");
  });
  it("磁盘直写命中 disk-write（dd of=/dev/…）", () => {
    const f = scanDanger("dd if=iso.img of=/dev/sda");
    expect(f.map((x) => x.kind)).toContain("disk-write");
  });
  it("fork 炸弹命中 fork-bomb", () => {
    const f = scanDanger(":(){ :|:& };:");
    expect(f.map((x) => x.kind)).toContain("fork-bomb");
  });
  it("git push --force 命中 force-push", () => {
    const f = scanDanger("git push --force origin main");
    expect(f.map((x) => x.kind)).toContain("force-push");
  });
  it("普通命令不误报", () => {
    expect(scanDanger("ls -la && tail -f app.log")).toEqual([]);
    expect(scanDanger("rm build/one-file.o")).toEqual([]);
  });
});

describe("recursive-delete 分离旗标（fix 1/5 I-2：token 序列判定）", () => {
  it("rm -r -f / rm --recursive --force / 混排 -fr 全 red", () => {
    expect(classify("rm -r -f /tmp/build").level).toBe("red");
    expect(classify("rm --recursive --force /tmp/build").level).toBe("red");
    expect(classify("rm -fr /tmp/build").level).toBe("red");
    expect(classify("rm -Rf /tmp/build").level).toBe("red");
    expect(scanDanger("rm -r -f /tmp/x").map((x) => x.kind)).toContain("recursive-delete");
  });
  it("sudo rm -r -f（提权叠加）仍 red 且双命中", () => {
    const v = classify("sudo rm -r -f /var/data");
    expect(v.level).toBe("red");
    expect(v.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["sudo", "recursive-delete"]));
  });
  it("非递归/单旗标不误报", () => {
    expect(classify("rm -r /tmp/build").level).not.toBe("red"); // 无 f
    expect(classify("rm -f one-file.o").level).not.toBe("red"); // 无 r
    expect(classify("rm build/one-file.o").level).toBe("green");
  });
  it("段边界隔离：rm 与他段旗标不串（rsync --recursive --force 不连坐）", () => {
    expect(classify("rm old.txt && rsync --recursive --force a/ b/").level).not.toBe("red");
  });
  it("管道/子 shell 里的 rm 分离旗标仍命中", () => {
    expect(classify("find . -empty | xargs rm -r -f").level).toBe("red");
    expect(classify("cat list | sudo xargs rm --recursive --force").level).toBe("red");
  });
});

describe("词典键存在性（fix 1/5 I-3：防裸 slug 进 UI）", () => {
  it("每个规则 kind 在 zh-CN / en-US 词典都有 ai.danger.<kind>", () => {
    const zh = (zhCN as { ai: { danger: Record<string, string> } }).ai.danger;
    const en = (enUS as { ai: { danger: Record<string, string> } }).ai.danger;
    for (const { kind } of DANGER_RULES) {
      expect(zh[kind], `zh-CN 缺 ai.danger.${kind}`).toBeTruthy();
      expect(en[kind], `en-US 缺 ai.danger.${kind}`).toBeTruthy();
    }
  });
  it("死键清零：词典不再含已删除的 privileged", () => {
    expect((zhCN as { ai: { danger: Record<string, unknown> } }).ai.danger).not.toHaveProperty("privileged");
    expect((enUS as { ai: { danger: Record<string, unknown> } }).ai.danger).not.toHaveProperty("privileged");
  });
});

describe("T13 死分支清理回归（T8 评审挂账）", () => {
  it("fork 炸弹只归 fork-bomb，不再错标 disk-write", () => {
    // 修复前：disk-write 正则内嵌 fork 炸弹备选分支，与独立规则重复且错标类目
    const kinds = scanDanger(":(){ :|:& };:").map((x) => x.kind);
    expect(kinds).toContain("fork-bomb");
    expect(kinds).not.toContain("disk-write");
  });
  it("dd / mkfs 仍归 disk-write（清理不伤正业）", () => {
    expect(scanDanger("dd if=a of=/dev/sdb").map((x) => x.kind)).toContain("disk-write");
    expect(scanDanger("mkfs.ext4 /dev/sdc").map((x) => x.kind)).toContain("disk-write");
  });
});

describe("classify 红黄绿分档（T13：AI 修复命令插终端判定）", () => {
  // --- red：每条至少覆盖一例，凑足 4+ ---
  it("red：rm -rf 根路径", () => {
    expect(classify("rm -rf /").level).toBe("red");
  });
  it("red：dd 直写块设备", () => {
    expect(classify("dd if=zero of=/dev/sda").level).toBe("red");
  });
  it("red：mkfs 格式化", () => {
    expect(classify("mkfs.ext4 /dev/sdb1").level).toBe("red");
  });
  it("red：fork 炸弹", () => {
    expect(classify(":(){ :|:& };:").level).toBe("red");
  });
  it("red：force push / hard reset / DROP TABLE / 递归 777 根 / kill -9 1", () => {
    expect(classify("git push -f origin main").level).toBe("red");
    expect(classify("git reset --hard HEAD~3").level).toBe("red");
    expect(classify("mysql -e 'DROP TABLE users'").level).toBe("red");
    expect(classify("chmod -R 777 /").level).toBe("red");
    expect(classify("kill -9 1").level).toBe("red");
    expect(classify("chown -R nobody /").level).toBe("red");
  });
  it("red：重定向直写块设备（> /dev/sdX 与 dd 同级）", () => {
    expect(classify("cat image.iso > /dev/sdb").level).toBe("red");
  });

  // --- yellow：每条至少覆盖一例，凑足 4+ ---
  it("yellow：sudo reboot（简报边界例）", () => {
    const v = classify("sudo reboot");
    expect(v.level).toBe("yellow");
    expect(v.findings.map((f) => f.kind)).toEqual(expect.arrayContaining(["sudo", "service-stop"]));
  });
  it("yellow：shutdown / kill -9 / chmod 777 / 重定向覆盖", () => {
    expect(classify("shutdown -h now").level).toBe("yellow");
    expect(classify("kill -9 12345").level).toBe("yellow");
    expect(classify("chmod 777 /var/www").level).toBe("yellow");
    expect(classify("echo config > /etc/hosts").level).toBe("yellow");
  });
  it("yellow：裸 sudo / 包管理卸载", () => {
    expect(classify("sudo apt install curl").level).toBe("yellow");
    expect(classify("apt remove nginx").level).toBe("yellow");
  });

  // --- green ---
  it("green：普通命令放行（简报边界例 ls）", () => {
    expect(classify("ls -la").level).toBe("green");
    expect(classify("tail -f app.log").level).toBe("green");
    expect(classify("git status && docker ps").level).toBe("green");
  });

  // --- 常见安全习语不误报 ---
  it("green：> /dev/null、>> 追加、2>&1 不算覆盖", () => {
    expect(classify("echo x > /dev/null").level).toBe("green");
    expect(classify("echo x >> /var/log/app.log").level).toBe("green");
    expect(classify("node server.js 2>&1 | tee run.log").level).toBe("green");
  });

  // --- 分档优先级：red > yellow ---
  it("red 压过 yellow（同一命令双命中取 red）", () => {
    const v = classify("sudo rm -rf /");
    expect(v.level).toBe("red");
    expect(v.findings.map((f) => f.kind)).toEqual(
      expect.arrayContaining(["sudo", "recursive-delete", "delete-root"]),
    );
  });
});

describe("assessPaste 分级（T8 语义回归：粘贴面对 red/yellow 同档确认）", () => {
  it("danger > warn：多行 + 危险规则 → danger 且带 findings", () => {
    const v = assessPaste("cd /tmp\nrm -rf build");
    expect(v.level).toBe("danger");
    expect(v.multiline).toBe(true);
    expect(v.findings.length).toBeGreaterThan(0);
  });
  it("纯多行无规则 → warn", () => {
    const v = assessPaste("export A=1\nexport B=2");
    expect(v.level).toBe("warn");
    expect(v.findings).toEqual([]);
    expect(v.multiline).toBe(true);
  });
  it("单行普通命令 → none（直接放行）", () => {
    expect(assessPaste("ls -la").level).toBe("none");
  });
  it("单行危险命令也要确认（danger 不依赖多行）", () => {
    expect(assessPaste("sudo rm -rf /var/data").level).toBe("danger");
  });
  it("yellow 级规则在粘贴面同样要确认（sudo reboot 弹层）", () => {
    expect(assessPaste("sudo reboot").level).toBe("danger");
  });
});
