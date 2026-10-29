import { expect, test } from "bun:test";
import { fromCitation, fromDiff, type RenderModel } from "../src/app.tsx";
import { unityCitationSchema, unityDiffSchema } from "../src/model.ts";

const player = { id: "1", name: "Player", hierarchy: "World" };
const transform = { id: "4", type: "Transform" };

test("a diff becomes a diff model: badges from status, rows kept as before/after", () => {
  const model = fromDiff(
    unityDiffSchema.parse({
      propertyCount: 2,
      groups: [
        {
          ...player,
          status: "modified",
          components: [
            {
              ...transform,
              status: "added",
              properties: [
                {
                  path: "m_LocalPosition",
                  before: "{x: 0, y: 1, z: 0}",
                  after: "{x: 0, y: 2, z: 0}",
                },
                { path: "target", target: "4", before: null, after: "{fileID: 4}" },
              ],
            },
          ],
        },
      ],
    }),
  );
  expect(model).toEqual({
    kind: "diff",
    propertyCount: 2,
    groups: [
      {
        ...player,
        badge: "modified",
        components: [
          {
            ...transform,
            badge: "added",
            rows: [
              {
                path: "m_LocalPosition",
                before: "{x: 0, y: 1, z: 0}",
                after: "{x: 0, y: 2, z: 0}",
              },
              { path: "target", target: "4", before: null, after: "{fileID: 4}" },
            ],
          },
        ],
      },
    ],
  });
});

test("a citation becomes a citation model: no badges, rows kept as value", () => {
  const model = fromCitation(
    unityCitationSchema.parse({
      propertyCount: 2,
      groups: [
        {
          ...player,
          components: [
            {
              ...transform,
              properties: [
                { path: "m_LocalPosition", value: "{x: 0, y: 1, z: 0}" },
                { path: "speed", label: "Speed", value: "5" },
              ],
            },
          ],
        },
      ],
    }),
  );
  expect(model).toEqual({
    kind: "citation",
    propertyCount: 2,
    groups: [
      {
        ...player,
        badge: null,
        components: [
          {
            ...transform,
            badge: null,
            rows: [
              { path: "m_LocalPosition", value: "{x: 0, y: 1, z: 0}" },
              { path: "speed", label: "Speed", value: "5" },
            ],
          },
        ],
      },
    ],
  });
});

test("a model's kind fixes its row shape (checked by `tsc`, not at runtime)", () => {
  const diff = fromDiff({ propertyCount: 0, groups: [] });
  const citation = fromCitation({ propertyCount: 0, groups: [] });
  const models: RenderModel[] = [
    // @ts-expect-error citation rows carry `value`; a diff model's rows carry `before` / `after`
    { ...diff, groups: citation.groups },
    // @ts-expect-error diff rows carry `before` / `after`; a citation model's rows carry `value`
    { ...citation, groups: diff.groups },
  ];
  expect(models.map((model) => model.kind)).toEqual(["diff", "citation"]);
});
