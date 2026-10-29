function formatName(user) {
  return `${user.first} ${user.last}`;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

module.exports = { formatName, slug };
