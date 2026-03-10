const path = require("path");
const { rcedit } = require("rcedit");

module.exports = async function afterPack(context) {
  const productFilename = context.packager?.appInfo?.productFilename;
  if (!productFilename) {
    console.warn("  • rcedit: skipped — productFilename not available");
    return;
  }
  const exePath = path.join(context.appOutDir, `${productFilename}.exe`);
  const iconPath = path.resolve(__dirname, "..", "assets", "app_icon.ico");
  console.log(`  • rcedit: patching icon → ${exePath}`);
  try {
    await rcedit(exePath, { icon: iconPath });
  } catch (error) {
    console.warn(`  • rcedit: failed — ${String(error)}`);
  }
};
