import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("projects API", () => {
  it("rejects project creation without a name", async () => {
    const response = await POST(
      new Request("http://localhost/api/projects", {
        method: "POST",
        body: JSON.stringify({ name: "" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "项目名称不能为空" });
  });
});
