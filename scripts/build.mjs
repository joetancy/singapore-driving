import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = resolve(root, "dist");

rmSync(output, { force: true, recursive: true });
mkdirSync(output, { recursive: true });
cpSync(resolve(root, "public"), output, { recursive: true });
cpSync(resolve(root, "app"), output, { recursive: true });

for (const file of ["app.js", "geometry.js"]) {
  const target = resolve(output, "js", file);
  writeFileSync(
    target,
    readFileSync(target, "utf8").replaceAll("../../public/vendor/", "../vendor/"),
  );
}
