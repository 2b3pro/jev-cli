import { mkdirSync } from "node:fs";

mkdirSync("dist", { recursive: true });
for (const [entrypoint, name] of [["src/cli.ts", "jev"], ["scripts/jev-sort.ts", "jev-sort"]] as const) {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: { outfile: `dist/${name}` },
    minify: true,
  });
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`);
  console.log(`Built dist/${name}`);
}
