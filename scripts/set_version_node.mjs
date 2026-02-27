import fs from "node:fs";
import path from "node:path";

const version = process.argv[2];
if (!version) {
  console.error("Usage: node scripts/set_version_node.mjs <version>");
  process.exit(1);
}

const root = process.cwd();

const packageJsonPath = path.join(root, "package.json");
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");

const constantsPath = path.join(root, "src", "main", "constants.ts");
const constants = fs.readFileSync(constantsPath, "utf8").replace(
  /APP_VERSION = "[^"]+"/,
  `APP_VERSION = "${version}"`
);
fs.writeFileSync(constantsPath, constants, "utf8");

console.log(`Set version to ${version}`);
