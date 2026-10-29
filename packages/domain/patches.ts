import { z } from "zod";

type WithoutDefault<T> = T extends z.ZodDefault<infer Inner> ? Inner : T;
type OptionalFields<S extends z.ZodRawShape> = {
  [K in keyof S]: z.ZodOptional<WithoutDefault<S[K]>>;
};

/**
 * The fields of an object shape, each optional and without its default, for
 * a command that changes only the fields it sends. In zod 4, `.partial()`
 * still fills defaults, so a partial update parsed with it resets every field
 * the caller left out.
 */
export function optionalFields<S extends z.ZodRawShape>(
  shape: S,
): OptionalFields<S> {
  const fields: Record<string, z.ZodType> = {};
  for (const [key, field] of Object.entries(shape) as Array<
    [string, z.ZodType]
  >)
    fields[key] = (
      field instanceof z.ZodDefault ? (field.unwrap() as z.ZodType) : field
    ).optional();
  return fields as unknown as OptionalFields<S>;
}
