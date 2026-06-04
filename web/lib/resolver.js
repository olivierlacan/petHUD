// Port of lib/pethud/patient_resolver.rb — maps a report's identity to a
// canonical patient via the rules in patients.json (e.g. merges "IRIS REED"
// and "IRIS PARK" into one Iris). Unmatched reports get an auto-created patient
// keyed by external id (or name+owner) so nothing is silently merged.
//
// One instance per aggregation run (it caches auto-created patients).

export class PatientResolver {
  // config: the parsed patients.json ({ patients: [...] })
  constructor(config) {
    this.rules = (config?.patients ?? []).map((p) => {
      const match = p.match ?? {};
      return {
        slug: p.slug,
        name: p.name,
        species: p.species,
        notes: p.notes,
        names: (match.names ?? []).map((s) => String(s).toUpperCase().trim()),
        owners: (match.owners ?? []).map((s) => String(s).toUpperCase().trim()),
        external_ids: (match.external_ids ?? []).map((s) => String(s).trim()),
      };
    });
    this.auto = new Map();
  }

  // A report matches a configured patient by external id, or by the pet's given
  // name (the leading word of pet_name, which reads "<NAME> <OWNER SURNAME>").
  // Owner is NOT a match key on its own — one household has multiple pets, so
  // owner-matching would merge different animals (Iris and P'tit Loup, both REED).
  resolve(meta) {
    const name = String(meta.pet_name ?? "").toUpperCase().trim();
    const ext = String(meta.patient_external_id ?? "").trim();

    const rule = this.rules.find((r) =>
      (ext !== "" && r.external_ids.includes(ext)) ||
      (name !== "" && r.names.some((n) => name === n || name.startsWith(n + " "))));

    if (rule) {
      return { slug: rule.slug, name: rule.name, species: rule.species ?? meta.species, notes: rule.notes };
    }
    return this.autoPatient(meta, name, ext);
  }

  autoPatient(meta, name, ext) {
    const owner = String(meta.pet_owner ?? "").toUpperCase().trim();
    const key = ext === "" ? `${name}-${owner}` : ext;
    if (this.auto.has(key)) return this.auto.get(key);

    const given = givenName(meta.pet_name, meta.pet_owner);
    let slug = slugify(given || meta.pet_owner || key);
    if ([...this.auto.values()].some((p) => p.slug === slug)) slug = `${slug}-${key}`;
    const patient = {
      slug,
      name: titleCase(given || meta.pet_owner || "Unknown"),
      species: meta.species,
      notes: "Auto-created (no alias rule matched). Edit config/patients.json to alias.",
    };
    this.auto.set(key, patient);
    return patient;
  }
}

// Given name = pet_name minus the trailing owner surname (the last word of the
// owner field): "P'TIT LOUP PARK" + owner "MAYA PARK" -> "P'TIT LOUP".
export function givenName(petName, owner) {
  const n = String(petName ?? "").trim();
  if (!n) return null;
  const parts = String(owner ?? "").trim().split(/\s+/);
  const surname = parts[parts.length - 1] || "";
  if (surname && n.toUpperCase().endsWith(" " + surname.toUpperCase())) {
    const stripped = n.slice(0, n.length - surname.length - 1).trim();
    return stripped || n;
  }
  return n;
}

function slugify(str) {
  return String(str ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function titleCase(str) {
  return String(str ?? "").split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}
