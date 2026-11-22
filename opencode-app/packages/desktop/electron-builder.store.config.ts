import base from "./electron-builder.config"

// Local release builds only: skip maximum 7z compression so packaging does not
// pin every CPU core for minutes. The resulting installer is larger.
export default { ...base, compression: "store" as const }
