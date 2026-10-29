export function displayName(user) {
  return `${user.first} ${user.last}`;
}

export function slug(text) {
  return text.toLowerCase().replace(/\s+/g, "-");
}
