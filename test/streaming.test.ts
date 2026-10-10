import { expect, test } from "bun:test";
import { orderedMap } from "../src/concurrency.ts";
import { textLines } from "../src/io.ts";
import { main } from "../src/cli.ts";
import { fakeApi, fakeIo } from "./helpers.ts";

const tick = () => Bun.sleep(10);
const preset = JSON.stringify({ questions: { answer: { type: "noul", instructions: "Relevant?" } } });

test("line reader preserves split UTF-8, CRLF, blank lines, and the final unterminated line", async () => {
  const bytes = new TextEncoder().encode('café\r\n\n日本語\nlast');
  const chunks = async function* () { for (const byte of bytes) yield new Uint8Array([byte]); };
  const lines = [];
  for await (const line of textLines(chunks())) lines.push(line);
  expect(lines).toEqual(["café", "", "日本語", "last"]);
});

test("batch emits before input closes and preserves physical line numbers", async () => {
  let finish!: () => void;
  const eof = new Promise<void>((resolve) => { finish = resolve; });
  const { io, out } = fakeIo({ stdin: "", files: { "preset.json": preset }, fetch: fakeApi().fetch });
  io.readStdin = async () => { throw new Error("must not buffer stdin"); };
  io.readLines = async function* () { yield ""; yield "first"; await eof; yield "last"; };
  const running = main(["batch", "preset.json"], io);
  try {
    for (let i = 0; i < 30 && !out.length; i++) await tick();
    expect(out.map((s) => JSON.parse(s).line)).toEqual([2]);
  } finally { finish(); }
  expect(await running).toBe(0);
  expect(out.map((s) => JSON.parse(s).line)).toEqual([2, 3]);
});

test("a slow first result bounds input and buffered results, while preserving order", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let read = 0;
  const output: number[] = [];
  const input = async function* () { for (let i = 0; i < 20; i++) { read++; yield i; } };
  const running = (async () => {
    for await (const n of orderedMap(input(), 3, async (i) => { if (!i) await gate; return i; })) output.push(n);
  })();
  try {
    await tick();
    expect(read).toBe(3);
    expect(output).toEqual([]);
  } finally { release(); }
  await running;
  expect(output).toEqual(Array.from({ length: 20 }, (_, i) => i));
});

test("batch waits for output backpressure and bounds read-ahead", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let read = 0;
  let writing = 0;
  const { io, out } = fakeIo({ stdin: "", files: { "preset.json": preset } });
  io.readLines = async function* () { for (let i = 0; i < 20; i++) { read++; yield String(i); } };
  io.writeLine = async (line) => { writing++; await gate; out.push(line); };
  const running = main(["batch", "preset.json", "--concurrency", "2", "--dry-run"], io);
  try {
    await tick();
    expect(writing).toBe(1);
    expect(read).toBeLessThanOrEqual(3);
  } finally { release(); }
  expect(await running).toBe(0);
  expect(out).toHaveLength(20);
});

test("empty streams and interrupted input report errors", async () => {
  const { io, err } = fakeIo({ stdin: " \n\n", files: { "preset.json": preset } });
  expect(await main(["batch", "preset.json", "--dry-run"], io)).toBe(2);
  expect(err.join(" ")).toContain("batch input is empty");
  io.readLines = async function* () { throw new Error("input disconnected"); };
  expect(await main(["batch", "preset.json", "--dry-run"], io)).toBe(2);
  expect(err.join(" ")).toContain("input disconnected");
});
