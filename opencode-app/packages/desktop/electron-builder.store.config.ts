import base from "./electron-builder.config"

// Local release builds only: skip maximum 7z compression so packaging does not
// pin every CPU core for minutes. The resulting installer is larger.
//
// OPENCODE_VERSION is required for the installer too, not only for the app build:
// electron-builder writes it into latest.yml, and without it the update feed keeps
// the stale version from package.json while the installer carries the new app.
if (!process.env.OPENCODE_VERSION) throw new Error("OPENCODE_VERSION is required to build the release installer")

export default { ...base, compression: "store" as const }
