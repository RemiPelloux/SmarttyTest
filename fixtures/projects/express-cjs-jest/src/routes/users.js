const userService = require("../services/userService");

module.exports = function usersRoute(req) {
  return userService.getUser(req.params.id);
};
