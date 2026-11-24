// A plain type switch that is not a stream parser, in a file that mentions a
// stream and parses JSON somewhere else.
export function toZod(schema, stream) {
  const cfg = JSON.parse(stream.config);
  if (schema.type === "string") return z.string();
  else if (schema.type === "number") return z.number();
  return cfg;
}
