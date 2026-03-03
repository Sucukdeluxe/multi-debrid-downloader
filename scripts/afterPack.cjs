const path = require("path");
const { rcedit } = require("rcedit");

module.exports = async function afterPack(context) {
  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.resolve(__dirname, "..", "assets", "app_icon.ico");
  console.log(`  • rcedit: patching icon → ${exePath}`);
  await rcedit(exePath, { icon: iconPath });
};
