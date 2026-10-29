import { expect, test } from "@playwright/test";

test("lists users", async ({ request }) => {
  expect(await (await request.get("/users")).text()).toContain("Ada Lovelace");
});

for (const id of ["1", "2"]) {
  test(`user ${id}`, async ({ request }) => {
    expect(await (await request.get(`/users/${id}`)).text()).toMatch(/<h1>\w+ \w+<\/h1>/);
  });
}
