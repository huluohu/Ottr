// redact.ts 单元测试（T13 Step 1）：默认四规则 + 自定义规则 + 占位符往返。
import { describe, expect, it } from "vitest";
import { DEFAULT_REDACT_RULES, redact, type RedactRule } from "./redact";

describe("默认规则：IPv4/IPv6", () => {
  it("IPv4 → 占位符（同值同占位符）", () => {
    const r = redact("connect 10.1.2.3 failed, retry 10.1.2.3");
    expect(r.text).toBe("connect [REDACTED_IPV4_1] failed, retry [REDACTED_IPV4_1]");
    expect(r.findings).toEqual([{ name: "ipv4", count: 2 }]);
  });
  it("不同 IPv4 各给编号", () => {
    const r = redact("ping 8.8.8.8 → 192.168.0.1");
    expect(r.text).toBe("ping [REDACTED_IPV4_1] → [REDACTED_IPV4_2]");
  });
  it("IPv6 压缩式/全零式/完整式", () => {
    const r = redact("reach 2001:db8::1 and fe80::1 and ::1 at 12:34:56");
    expect(r.text).toContain("[REDACTED_IPV6_");
    expect(r.text).not.toContain("2001:db8::1");
    expect(r.text).not.toContain("fe80::1");
    expect(r.text).not.toContain("::1");
    // 时间戳（无 :: 且不足 4 组）不误伤
    expect(r.text).toContain("12:34:56");
  });
  it("IPv4 边界：版本号 v1.2.3.4 不误伤（\\b 挡住字母前缀）", () => {
    expect(redact("version v1.2.3.4").text).toBe("version v1.2.3.4");
    // 带端口的 IP 只吞 IP 段
    expect(redact("http://10.0.0.1:8080/x").text).toBe("http://[REDACTED_IPV4_1]:8080/x");
  });
});

describe("默认规则：密码赋值", () => {
  it("password=xxx / PASSWD:xxx / DB_PASSWORD=xxx → 占位符", () => {
    const r = redact("password=hunter2; PASSWD:s3cret export DB_PASSWORD=p@ss");
    expect(r.text).not.toContain("hunter2");
    expect(r.text).not.toContain("s3cret");
    expect(r.text).not.toContain("p@ss");
    expect(r.text).toContain("[REDACTED_PASSWORD_");
    expect(r.findings[0]?.name).toBe("password");
  });
  it("带引号的值整体替换", () => {
    const r = redact(`--password="my secret key"`);
    expect(r.text).not.toContain("my secret key");
    expect(r.text).toContain("[REDACTED_PASSWORD_1]");
  });
  it("token/api_key/secret 同类键面一并覆盖", () => {
    const r = redact("token=abc123 api_key=xyz secret:topsecret");
    expect(r.text).not.toContain("abc123");
    expect(r.text).not.toContain("xyz");
    expect(r.text).not.toContain("topsecret");
  });
});

describe("默认规则：email", () => {
  it("邮箱 → 占位符", () => {
    const r = redact("mail ops@example.com or a.b+c@sub.corp.io");
    expect(r.text).toBe("mail [REDACTED_EMAIL_1] or [REDACTED_EMAIL_2]");
  });
});

describe("默认规则：主机名（可配开关）", () => {
  it("FQDN → 占位符（默认开）", () => {
    const r = redact("cannot resolve db.internal.example.com");
    expect(r.text).toContain("[REDACTED_HOSTNAME_1]");
    expect(r.text).not.toContain("db.internal.example.com");
  });
  it("文件名 app.log / notes.txt 不误伤", () => {
    const r = redact("tail -f app.log > notes.txt");
    expect(r.text).toBe("tail -f app.log > notes.txt");
  });
  it("关掉主机名规则后 FQDN 原样保留", () => {
    const r = redact("cannot resolve db.internal.example.com", { hostname: false });
    expect(r.text).toContain("db.internal.example.com");
  });
});

describe("自定义规则", () => {
  const rule: RedactRule = {
    name: "order_id",
    pattern: "OTTR-\\d{6}",
    enabled: true,
  };
  it("自定义正则按自定义占位符前缀替换", () => {
    const r = redact("order OTTR-123456 shipped", { custom: [rule] });
    expect(r.text).toBe("order [REDACTED_ORDER_ID_1] shipped");
  });
  it("disabled 的自定义规则不生效", () => {
    const r = redact("order OTTR-123456 shipped", {
      custom: [{ ...rule, enabled: false }],
    });
    expect(r.text).toBe("order OTTR-123456 shipped");
  });
  it("非法正则被跳过，不抛错", () => {
    const r = redact("hello ((", {
      custom: [{ name: "bad", pattern: "([unclosed", enabled: true }],
    });
    expect(r.text).toBe("hello ((");
  });
  it("默认四规则齐备（ipv4/ipv6/password/email/hostname）", () => {
    expect(DEFAULT_REDACT_RULES.map((r) => r.name)).toEqual([
      "ipv4",
      "ipv6",
      "password",
      "email",
      "hostname",
    ]);
  });
});

describe("占位符往返（spec §6：模型看到的即占位符）", () => {
  it("幂等：redact(redact(x)) === redact(x)", () => {
    const src = "password=hunter2 at 10.0.0.1 mail me@example.com";
    const once = redact(src);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
  });
  it("占位符不被密码赋值规则二次吞掉", () => {
    const once = redact("password=hunter2");
    expect(once.text).toMatch(/^password=\[REDACTED_PASSWORD_1\]$/);
    const twice = redact(once.text);
    expect(twice.text).toBe(once.text);
    expect(twice.findings).toEqual([]);
  });
  it("占位符形态稳定（大写下划线，可被模型原样复述）", () => {
    const r = redact("ip 8.8.4.4");
    expect(r.text).toMatch(/\[REDACTED_[A-Z0-9_]+_\d+\]/);
  });
});
