// The identifier an entity's image object key is built from (#3350): its
// persisted slug, generated once and never rewritten (#2951), so renaming the
// entity — or translating its name — never moves its image. Pure.
//
// A row with no slug (none should exist once its #2951 stage backfilled every
// row) keeps the pre-#3350 name-based key rather than failing the upload, which
// is the same fallback the Exercise (`exerciseMediaKeyIdentifier()`) and
// Nutrition Library food keys take. An object stored before #3350 under
// `<id>-<name>` keeps rendering from its stored URL; replacing that image is
// what moves it (each store's sweep), and nothing moves it on a rename.

export function imageKeyIdentifier(row: { slug?: string | null; name: string }): string {
  const slug = typeof row.slug === 'string' ? row.slug.trim() : '';
  return slug || row.name;
}
