import { describe, expect, it } from "vitest";
import { matchRequest, parseRouteResource, type RouteDefinition } from "./http-routes.js";

const def = (r: string, names: string[] = [], unit = r): RouteDefinition => ({
  file: "routes/api.php",
  unit,
  ...(parseRouteResource(r) as NonNullable<ReturnType<typeof parseRouteResource>>),
  names,
  namesOpen: r.startsWith("http-route~"),
});

describe("matchRequest", () => {
  const defs = [
    def("http-route:GET|HEAD /api/posts", ["posts.index"]),
    def("http-route:GET|HEAD /api/posts/{post}", ["posts.show"]),
    def("http-route:POST /api/posts/{post}/like"),
    def("http-route:GET|HEAD /og/invite/{code}.jpg"),
    def("http-route~:DELETE /notes/{note}", ["notes.destroy"]),
    def("http-route:GET|HEAD /api/search/{term?}"),
  ];
  const units = (r: string) => matchRequest(r, defs).map((d) => d.unit);

  it("matches literal paths, parameters and a parameter inside a segment", () => {
    expect(units("http-request:GET /api/posts?page=2")).toEqual(["http-route:GET|HEAD /api/posts"]);
    expect(units("http-request:GET /api/posts/12")).toEqual([
      "http-route:GET|HEAD /api/posts/{post}",
    ]);
    expect(units("http-request:HEAD /og/invite/OPCARD.jpg")).toEqual([
      "http-route:GET|HEAD /og/invite/{code}.jpg",
    ]);
    expect(units("http-request:GET /api/search")).toEqual([
      "http-route:GET|HEAD /api/search/{term?}",
    ]);
    expect(units("http-request:POST /api/posts")).toEqual([]);
  });

  it("a computed part matches every route it could be", () => {
    expect(units("http-request:POST /api/posts/*/like")).toEqual([
      "http-route:POST /api/posts/{post}/like",
    ]);
    expect(units("http-request:GET /api/*").sort()).toEqual(
      [
        "http-route:GET|HEAD /api/posts",
        "http-route:GET|HEAD /api/posts/{post}",
        "http-route:GET|HEAD /api/search/{term?}",
      ].sort(),
    );
  });

  it("a route of an included file (unknown prefix) serves a request ending with its path", () => {
    expect(units("http-request:DELETE /api/admin/notes/3")).toEqual([
      "http-route~:DELETE /notes/{note}",
    ]);
    expect(units("http-request-name:admin.notes.destroy")).toEqual([
      "http-route~:DELETE /notes/{note}",
    ]);
    expect(units("http-request-name:posts.show")).toEqual([
      "http-route:GET|HEAD /api/posts/{post}",
    ]);
  });
});
