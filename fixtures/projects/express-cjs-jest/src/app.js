const usersRoute = require("./routes/users");

function handle(path, req) {
  if (path.startsWith("/users")) return usersRoute(req);
  return null;
}

module.exports = { handle };
