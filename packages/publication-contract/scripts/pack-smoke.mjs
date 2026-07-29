import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scratchDirectory = await mkdtemp(
  path.join(tmpdir(), "publication-contract-pack-"),
);
const consumerDirectory = path.join(scratchDirectory, "consumer");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const tscCommand = path.join(
  packageDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
    shell:
      process.platform === "win32" && command.toLowerCase().endsWith(".cmd"),
  });

  if (result.error || result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
        result.error?.message,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return result.stdout.trim();
}

try {
  const packOutput = run(
    npmCommand,
    ["pack", "--silent", "--pack-destination", scratchDirectory],
    packageDirectory,
  );
  const tarballName = packOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .findLast((line) => line.endsWith(".tgz"));

  if (!tarballName) {
    throw new Error(`npm pack did not report a tarball:\n${packOutput}`);
  }

  const tarballPath = path.join(scratchDirectory, tarballName);
  await mkdir(consumerDirectory);
  await writeFile(
    path.join(consumerDirectory, "package.json"),
    `${JSON.stringify({ name: "publication-contract-smoke", private: true }, null, 2)}\n`,
    "utf8",
  );

  run(
    npmCommand,
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-save",
      tarballPath,
    ],
    consumerDirectory,
  );

  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      [
        "import { PublicationInspectResultV3Schema } from '@wechatsync/publication-contract/v3'",
        "import { PublicationPlatformSchema } from '@wechatsync/publication-contract/v2'",
        "if (PublicationPlatformSchema.parse('zhihu') !== 'zhihu') throw new Error('v2 ESM export failed')",
        "if (typeof PublicationInspectResultV3Schema.safeParse !== 'function') throw new Error('v3 ESM export failed')",
      ].join(";"),
    ],
    consumerDirectory,
  );

  run(
    process.execPath,
    [
      "--eval",
      [
        "const { PublicationInspectResultV3Schema } = require('@wechatsync/publication-contract/v3')",
        "const { PublicationPlatformSchema } = require('@wechatsync/publication-contract/v2')",
        "const fixture = require('@wechatsync/publication-contract/fixtures/v3/zhihu-published.json')",
        "if (PublicationPlatformSchema.parse('sohu') !== 'sohu') throw new Error('v2 CJS export failed')",
        "if (typeof PublicationInspectResultV3Schema.safeParse !== 'function') throw new Error('v3 CJS export failed')",
        "if (fixture.contractVersion !== '3.0') throw new Error('fixture export failed')",
      ].join(";"),
    ],
    consumerDirectory,
  );

  await writeFile(
    path.join(consumerDirectory, "consumer.mts"),
    [
      "import { PublicationPlatformSchema } from '@wechatsync/publication-contract'",
      "import { PublicationInspectResultV3Schema } from '@wechatsync/publication-contract/v3'",
      "PublicationPlatformSchema.parse('zhihu')",
      "PublicationInspectResultV3Schema.safeParse({})",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(consumerDirectory, "consumer.cts"),
    [
      "import v2 = require('@wechatsync/publication-contract/v2')",
      "import v3 = require('@wechatsync/publication-contract/v3')",
      "v2.PublicationPlatformSchema.parse('sohu')",
      "v3.PublicationInspectResultV3Schema.safeParse({})",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(consumerDirectory, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "Node16",
          moduleResolution: "Node16",
          strict: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ["consumer.mts", "consumer.cts"],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  run(tscCommand, ["--project", "tsconfig.json"], consumerDirectory);

  console.log(
    `Packed ESM/CJS runtime, types, and fixtures verified: ${tarballName}`,
  );
} finally {
  await rm(scratchDirectory, { recursive: true, force: true });
}
