// A function of your own that happens to be called repairJson, not imported
// from a repair library: it cleans database text, not model output.
export function repairJson(s: string): string {
  return s.split("\u0000").join("");
}

export function save(db, row: string) {
  return db.insert(repairJson(row));
}
