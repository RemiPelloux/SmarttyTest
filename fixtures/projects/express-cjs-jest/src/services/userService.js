const { formatName } = require("../utils/format");

function getUser(id) {
  return { id, name: formatName({ first: "Ada", last: "Lovelace" }) };
}

module.exports = { getUser };
