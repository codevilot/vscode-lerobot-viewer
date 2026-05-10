import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { parseSshConfigText } from "./config";

test("parseSshConfigText extracts a single Host alias", () => {
  const out = parseSshConfigText(
    [
      "Host lerobot",
      "  HostName 10.0.0.106",
      "  User namheon",
      "  Port 2222",
      "  IdentityFile ~/.ssh/lerobot_key",
    ].join("\n"),
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    alias: "lerobot",
    hostName: "10.0.0.106",
    user: "namheon",
    port: 2222,
    identityFile: path.join(os.homedir(), ".ssh", "lerobot_key"),
  });
});

test("parseSshConfigText filters wildcard hosts", () => {
  const out = parseSshConfigText(
    [
      "Host *",
      "  IdentityFile ~/.ssh/global_key",
      "Host real-host",
      "  HostName real.example.com",
    ].join("\n"),
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].alias, "real-host");
});

test("parseSshConfigText skips comments and blank lines", () => {
  const out = parseSshConfigText(
    [
      "# top-level comment",
      "",
      "Host alpha",
      "  # inline comment",
      "  HostName a.example.com",
      "",
      "Host beta",
      "  HostName b.example.com  # trailing comment",
    ].join("\n"),
  );
  assert.equal(out.length, 2);
  assert.equal(out[0].hostName, "a.example.com");
  assert.equal(out[1].hostName, "b.example.com");
});

test("parseSshConfigText handles quoted values and missing hostname (skip)", () => {
  const out = parseSshConfigText(
    [
      'Host quoted',
      '  HostName "host.with spaces"',
      "Host no-hostname",
      "  User onlyuser",
    ].join("\n"),
  );
  // The "no-hostname" alias is dropped because hostName is required.
  assert.equal(out.length, 1);
  assert.equal(out[0].alias, "quoted");
  assert.equal(out[0].hostName, "host.with spaces");
});

test("parseSshConfigText preserves declaration order", () => {
  const out = parseSshConfigText(
    [
      "Host first",
      "  HostName 1.example.com",
      "Host second",
      "  HostName 2.example.com",
      "Host third",
      "  HostName 3.example.com",
    ].join("\n"),
  );
  assert.deepEqual(
    out.map((h) => h.alias),
    ["first", "second", "third"],
  );
});
