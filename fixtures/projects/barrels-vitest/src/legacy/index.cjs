// A CommonJS barrel: what it spreads is not a list of names SmartTest can read.
module.exports = { ...require("./one.cjs"), ...require("./two.cjs") };
