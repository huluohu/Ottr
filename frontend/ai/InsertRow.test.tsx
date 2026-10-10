import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import i18n from "../i18n";
import { CodeBlockRow, defaultInserter } from "./InsertRow";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
afterEach(cleanup);
beforeEach(async () => { vi.clearAllMocks(); await i18n.changeLanguage("en-US"); });

const unsafe = ["echo one\necho two", "echo one\r\necho two", "echo one\recho two",
  ...Array.from({ length: 32 }, (_, n) => `echo a${String.fromCharCode(n)}b`),
  ...Array.from({ length: 33 }, (_, n) => `echo a${String.fromCharCode(127 + n)}b`),
  "echo a\u2028b", "echo a\u2029b", "\x1b[200~echo one\n\x1b[201~"];

it.each(unsafe)("blocks unsafe text at UI and IPC boundary: %j", async (code) => {
  const inserter = vi.fn().mockResolvedValue(undefined);
  render(<CodeBlockRow code={code} rustId="pty-test" inserter={inserter} />);
  const button = screen.getByTestId("ai-insert") as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(screen.getByTestId("ai-insert-blocked").textContent).toContain("review");
  fireEvent.click(button);
  expect(inserter).not.toHaveBeenCalled();
  await expect(defaultInserter("pty-test", code)).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});

it("preserves printable single-line Unicode and shell syntax without appending Enter", async () => {
  const code = "printf '%s' '你好'; echo ok && pwd";
  await defaultInserter("pty-test", code);
  expect(invoke).toHaveBeenCalledWith("write_session", {
    id: "pty-test", bytes: Array.from(new TextEncoder().encode(code)),
  });
});

it("requires fresh confirmation when the code or destination changes", () => {
  const inserter = vi.fn().mockResolvedValue(undefined);
  const view = render(<CodeBlockRow code="sudo reboot" rustId="a" inserter={inserter} />);
  fireEvent.click(screen.getByTestId("ai-insert"));
  view.rerender(<CodeBlockRow code="sudo shutdown now" rustId="a" inserter={inserter} />);
  fireEvent.click(screen.getByTestId("ai-insert"));
  expect(inserter).not.toHaveBeenCalled();
  view.rerender(<CodeBlockRow code="sudo shutdown now" rustId="b" inserter={inserter} />);
  fireEvent.click(screen.getByTestId("ai-insert"));
  expect(inserter).not.toHaveBeenCalled();
});
