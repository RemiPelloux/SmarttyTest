export const USERS = [
  { id: "1", first: "Ada", last: "Lovelace" },
  { id: "2", first: "Alan", last: "Turing" },
];

export const findUser = (id) => USERS.find((u) => u.id === id);
